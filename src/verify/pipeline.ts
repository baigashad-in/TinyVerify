import { CANDIDATES_SCHEMA, RECORD_SCHEMA, recordGoal, searchGoal } from "../tinyfish/agentSchemas.js";
import { TinyVerifyError, TracedGateway, type Gateway } from "../tinyfish/gateway.js";
import { discoveryQuery, genericNormalizeStatus, pickOfficial, usesMonthFirstDates } from "../registries/discovery.js";
import { getAdapter, jurisdictionLabel, route, type Route } from "../registries/index.js";
import {
  emptyRecord,
  type ParseOutcome,
  type ParsedRecord,
  type RegistryAdapter,
  type SearchCandidate,
} from "../registries/types.js";
import {
  DisciplinaryKindSchema,
  SCHEMA_VERSION,
  VerifyRequestSchema,
  type Candidate,
  type DisciplinaryAction,
  type EntityKind,
  type FetchedPage,
  type NormalizedStatus,
  type Outcome,
  type SourceCheck,
  type VerifiedRecord,
  type VerifyRequest,
  type VerifyResult,
} from "../types.js";
import { toIsoDate, type DateOrder } from "../util/dates.js";
import { decide, identifierNameCheck, MATCH_THRESHOLDS, nameScore, nameVariants, type Scored } from "../util/match.js";
import { hostOf, isOnDomains, sha256, truncate } from "../util/text.js";

export interface PipelineDeps {
  gateway: Gateway;
  now?: () => Date;
}

interface Ctx {
  gw: TracedGateway;
  req: VerifyRequest;
  kind: EntityKind | null;
  recordType: string;
  checks: SourceCheck[];
  warnings: string[];
  now: () => Date;
}

interface AdapterResult {
  outcome: Outcome;
  records: VerifiedRecord[];
  candidates: Candidate[];
  message: string;
}

type ReadResult =
  | {
      ok: true;
      parsed: ParsedRecord;
      via: "tinyfish_fetch" | "tinyfish_agent";
      url: string;
      recordSpecific: boolean;
      page: FetchedPage | null;
      runId: string | null;
    }
  | { ok: false; notFound: boolean; blocked: boolean; reason: string };

const BUSINESS_WORDS =
  /\b(ltd|limited|inc|incorporated|llc|l\.l\.c|llp|plc|corp|corporation|company|co|pty|group|holdings|services|construction|builders|building|contracting|contractors|plumbing|electric|roofing|enterprises|trust|partners|association|foundation|society|clinic|hospital|consulting|solutions|industries|international|gmbh|sas)\b/i;

function inferKind(req: VerifyRequest, adapter: RegistryAdapter | null): EntityKind | null {
  if (req.entity_kind) return req.entity_kind;
  if (adapter && adapter.entityKinds.length === 1) return adapter.entityKinds[0] ?? null;
  if (BUSINESS_WORDS.test(req.name)) return "business";
  return null;
}

function check(ctx: Ctx, adapter: RegistryAdapter, c: Omit<SourceCheck, "registry_id" | "registry_name" | "checked_at">): void {
  ctx.checks.push({ registry_id: adapter.id, registry_name: adapter.name, checked_at: ctx.now().toISOString(), ...c });
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/** Array entries that are objects. Agent output can contain nulls; they are dropped, not crashed on. */
function objects(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)) : [];
}

/** Convert an Agent structured-output record into the same shape the parsers produce. */
export function agentRecordToParsed(
  result: Record<string, unknown> | null,
  opts: {
    normalizeStatus: (raw: string) => NormalizedStatus;
    normalizeAgentStatus?: (raw: string, details: Record<string, string>) => NormalizedStatus;
    dateOrder: DateOrder;
    expectId?: string | null;
    normalizeId: (raw: string) => string | null;
  },
): ParseOutcome {
  if (!result) return { ok: false, reason: "agent returned no result" };
  const state = str(result.page_state);
  if (state === "no_results") return { ok: false, reason: "agent: register returned no record", notFound: true };
  if (state === "blocked" || state === "error") return { ok: false, reason: `agent: page_state=${state}`, blocked: true };
  if (state !== "record") return { ok: false, reason: `agent did not open a single record (page_state=${state ?? "missing"})` };
  const statusText = str(result.status_text);
  if (!statusText) return { ok: false, reason: "agent: no status text on record" };
  const identifier = str(result.identifier);
  if (opts.expectId && !identifier) {
    // Without the number on the page there is no proof this is the requested record.
    return { ok: false, reason: `agent did not report the record number (expected ${opts.expectId})` };
  }
  if (opts.expectId && identifier && opts.normalizeId(identifier) !== opts.expectId) {
    return { ok: false, reason: `agent opened a different record (${identifier}, expected ${opts.expectId})` };
  }
  const rawActions = objects(result.disciplinary_actions);
  const actions: DisciplinaryAction[] = rawActions
    .map((a) => {
      const kind = DisciplinaryKindSchema.safeParse(a.kind);
      const description = str(a.description) ?? "";
      return {
        kind: kind.success ? kind.data : "other",
        description,
        start_date: toIsoDate(str(a.start_date), opts.dateOrder),
        end_date: toIsoDate(str(a.end_date), opts.dateOrder),
        evidence: description,
      } satisfies DisciplinaryAction;
    })
    .filter((a) => a.description.length > 0);
  const details: Record<string, string> = {};
  for (const f of objects(result.other_fields)) {
    const label = str(f.label);
    const value = str(f.value);
    if (label && value) details[label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")] = value;
  }
  // The quote is the agent's copy of the page text. The second line is labelled
  // as the agent's report so it is not mistaken for text read from the page.
  const evidence = [str(result.evidence_quote), `Agent reported status: "${statusText}"`].filter((e): e is string => !!e);
  return {
    ok: true,
    record: emptyRecord({
      name: str(result.name),
      identifier: identifier ? (opts.normalizeId(identifier) ?? identifier) : null,
      identifiers: identifier ? { identifier } : {},
      status_raw: statusText,
      status: opts.normalizeAgentStatus ? opts.normalizeAgentStatus(statusText, details) : opts.normalizeStatus(statusText),
      status_effective_date: toIsoDate(str(result.status_effective_date), opts.dateOrder),
      issue_date: toIsoDate(str(result.issue_date), opts.dateOrder),
      expiry_date: toIsoDate(str(result.expiry_date), opts.dateOrder),
      renewal_due_date: toIsoDate(str(result.renewal_due_date), opts.dateOrder),
      disciplinary_actions: actions,
      disciplinary_note: actions.length === 0 ? "The agent found no disciplinary entries on the record page." : null,
      details,
      evidence,
      registry_timestamp: str(result.registry_timestamp),
    }),
  };
}

/** Read one record: TinyFish Fetch plus a deterministic parser first, TinyFish Agent if that fails. */
export async function readRecord(
  adapter: RegistryAdapter,
  ctx: Pick<Ctx, "gw" | "checks" | "now" | "warnings">,
  ref: { id: string | null; url: string | null; nameHint?: string | null },
  opts: { skipFetch?: boolean } = {},
): Promise<ReadResult> {
  const canonical = ref.id ? adapter.recordUrl(ref.id) : null;
  const candidateUrl = ref.url && isOnDomains(ref.url, adapter.officialDomains) ? ref.url : null;
  const url = canonical ?? candidateUrl;
  const c = (x: Omit<SourceCheck, "registry_id" | "registry_name" | "checked_at">) =>
    ctx.checks.push({ registry_id: adapter.id, registry_name: adapter.name, checked_at: ctx.now().toISOString(), ...x });

  if (url && adapter.curated !== false && !opts.skipFetch) {
    try {
      const f = await ctx.gw.fetchPage(url);
      if (f.page?.text) {
        const p = adapter.parseRecord(f.page);
        if (p.ok) {
          const pid = p.record.identifier ? adapter.normalizeIdentifier(p.record.identifier) : null;
          if (ref.id && pid && pid !== ref.id) {
            c({ step: "record", method: "tinyfish_fetch", url, query: ref.id, outcome: "unparsed", result_count: null, detail: `page shows ${pid}, expected ${ref.id}` });
          } else {
            c({ step: "record", method: "tinyfish_fetch", url, query: ref.id, outcome: "ok", result_count: 1, detail: null });
            return { ok: true, parsed: p.record, via: "tinyfish_fetch", url, recordSpecific: true, page: f.page, runId: null };
          }
        } else {
          c({
            step: "record",
            method: "tinyfish_fetch",
            url,
            query: ref.id,
            outcome: p.notFound ? "not_found" : p.blocked ? "blocked" : "unparsed",
            result_count: p.notFound ? 0 : null,
            detail: p.reason,
          });
          if (p.notFound) return { ok: false, notFound: true, blocked: false, reason: p.reason };
        }
      } else {
        c({ step: "record", method: "tinyfish_fetch", url, query: ref.id, outcome: "error", result_count: null, detail: f.error });
      }
    } catch (err) {
      if (err instanceof TinyVerifyError && err.code === "tinyfish_auth") throw err;
      c({ step: "record", method: "tinyfish_fetch", url, query: ref.id, outcome: "error", result_count: null, detail: err instanceof Error ? err.message : String(err) });
    }
  }

  // Agent fallback: real browser, structured output, verbatim evidence.
  const searchUrl = adapter.search.mode === "agent" ? adapter.search.url : adapter.search.agentFallbackUrl;
  // A number lookup starts at the register's number search; a name lookup at its name search.
  const agentUrl = url ?? (ref.id ? adapter.identifierSearchUrl : undefined) ?? searchUrl;
  let a;
  try {
    a = await ctx.gw.runAgent({
      url: agentUrl,
      goal: recordGoal({
        registryName: adapter.name,
        authority: adapter.authority,
        identifierLabel: adapter.identifierLabel,
        identifier: ref.id,
        nameHint: ref.nameHint ?? null,
        extra: adapter.agentRecordInstructions ?? null,
      }),
      output_schema: RECORD_SCHEMA as unknown as Record<string, unknown>,
      stealth: adapter.agent.stealth,
      proxy_country: adapter.agent.proxyCountry,
    });
  } catch (err) {
    if (err instanceof TinyVerifyError && err.code === "tinyfish_auth") throw err;
    const reason = err instanceof Error ? err.message : String(err);
    c({ step: "record", method: "tinyfish_agent", url: agentUrl, query: ref.id, outcome: "error", result_count: null, detail: reason });
    return { ok: false, notFound: false, blocked: false, reason };
  }
  if (a.status !== "COMPLETED") {
    c({ step: "record", method: "tinyfish_agent", url: agentUrl, query: ref.id, outcome: "error", result_count: null, detail: a.error ?? a.status });
    return { ok: false, notFound: false, blocked: /blocked|captcha/i.test(a.error ?? ""), reason: a.error ?? a.status };
  }
  const p = agentRecordToParsed(a.result, {
    normalizeStatus: adapter.normalizeStatus,
    ...(adapter.normalizeAgentStatus ? { normalizeAgentStatus: adapter.normalizeAgentStatus } : {}),
    dateOrder: adapter.dateOrder,
    expectId: ref.id,
    normalizeId: adapter.normalizeIdentifier,
  });
  if (!p.ok) {
    c({
      step: "record",
      method: "tinyfish_agent",
      url: agentUrl,
      query: ref.id,
      outcome: p.notFound ? "not_found" : p.blocked ? "blocked" : "unparsed",
      result_count: p.notFound ? 0 : null,
      detail: p.reason,
    });
    return { ok: false, notFound: !!p.notFound, blocked: !!p.blocked, reason: p.reason };
  }
  const agentRecordUrl = str(a.result?.record_url);
  const officialAgentUrl = agentRecordUrl && isOnDomains(agentRecordUrl, adapter.officialDomains) ? agentRecordUrl : null;
  if (agentRecordUrl && !officialAgentUrl) {
    ctx.warnings.push(`Agent reported a record URL outside ${adapter.officialDomains.join(", ")} (${truncate(agentRecordUrl, 80)}); it was ignored.`);
  }
  const finalUrl = url ?? officialAgentUrl ?? agentUrl;
  c({ step: "record", method: "tinyfish_agent", url: finalUrl, query: ref.id, outcome: "ok", result_count: 1, detail: a.run_id ? `run ${a.run_id}` : null });
  return {
    ok: true,
    parsed: p.record,
    via: "tinyfish_agent",
    url: finalUrl,
    recordSpecific: !!(url ?? officialAgentUrl),
    page: null,
    runId: a.run_id,
  };
}

type SearchOutcome =
  | { kind: "results"; candidates: SearchCandidate[]; total: number | null }
  | { kind: "no_results" }
  | { kind: "unavailable"; reason: string };

async function agentSearch(adapter: RegistryAdapter, ctx: Ctx, query: string, url: string, instructions: string): Promise<SearchOutcome> {
  let a;
  try {
    a = await ctx.gw.runAgent({
      url,
      goal: searchGoal({
        registryName: adapter.name,
        authority: adapter.authority,
        query,
        subject: ctx.kind === "person" ? "person" : ctx.kind === "business" ? "business" : "person or business",
        instructions,
      }),
      output_schema: CANDIDATES_SCHEMA as unknown as Record<string, unknown>,
      stealth: adapter.agent.stealth,
      proxy_country: adapter.agent.proxyCountry,
    });
  } catch (err) {
    if (err instanceof TinyVerifyError && err.code === "tinyfish_auth") throw err;
    const reason = err instanceof Error ? err.message : String(err);
    check(ctx, adapter, { step: "search", method: "tinyfish_agent", url, query, outcome: "error", result_count: null, detail: reason });
    return { kind: "unavailable", reason };
  }
  const state = str(a.result?.page_state);
  if (a.status !== "COMPLETED" || !a.result || state === "blocked" || state === "error") {
    const reason = a.error ?? `page_state=${state ?? "missing"}`;
    check(ctx, adapter, { step: "search", method: "tinyfish_agent", url, query, outcome: state === "blocked" ? "blocked" : "error", result_count: null, detail: reason });
    return { kind: "unavailable", reason };
  }
  if (state === "no_results") {
    check(ctx, adapter, { step: "search", method: "tinyfish_agent", url, query, outcome: "no_results", result_count: 0, detail: str(a.result.no_results_message) });
    return { kind: "no_results" };
  }
  const raw = objects(a.result.candidates);
  const candidates: SearchCandidate[] = raw
    .map((c) => {
      const idRaw = str(c.identifier);
      const recUrl = str(c.record_url);
      return {
        name: str(c.name) ?? "",
        identifier: idRaw ? (adapter.normalizeIdentifier(idRaw) ?? idRaw) : null,
        status_raw: str(c.status),
        record_url: recUrl && isOnDomains(recUrl, adapter.officialDomains) ? recUrl : null,
        location: str(c.location),
        matched_previous_name: false,
        snippet: null,
      };
    })
    .filter((c) => c.name.length > 0);
  if (candidates.length === 0) {
    check(ctx, adapter, { step: "search", method: "tinyfish_agent", url, query, outcome: "unparsed", result_count: null, detail: "agent reported results but returned none" });
    return { kind: "unavailable", reason: "agent returned no candidates" };
  }
  check(ctx, adapter, { step: "search", method: "tinyfish_agent", url, query, outcome: "ok", result_count: candidates.length, detail: a.run_id ? `run ${a.run_id}` : null });
  return { kind: "results", candidates, total: null };
}

async function searchCandidates(adapter: RegistryAdapter, ctx: Ctx, query: string): Promise<SearchOutcome> {
  if (adapter.search.mode === "fetch") {
    const spec = adapter.search;
    const url = spec.url(query, ctx.kind);
    try {
      const f = await ctx.gw.fetchPage(url);
      if (f.page?.text) {
        const sp = spec.parse(f.page);
        if (sp.kind === "results") {
          check(ctx, adapter, { step: "search", method: "tinyfish_fetch", url, query, outcome: "ok", result_count: sp.candidates.length, detail: sp.total ? `registry reports ${sp.total} matches` : null });
          return { kind: "results", candidates: sp.candidates, total: sp.total };
        }
        if (sp.kind === "no_results" && spec.noResultsIsConclusive) {
          check(ctx, adapter, { step: "search", method: "tinyfish_fetch", url, query, outcome: "no_results", result_count: 0, detail: sp.evidence });
          return { kind: "no_results" };
        }
        check(ctx, adapter, {
          step: "search",
          method: "tinyfish_fetch",
          url,
          query,
          outcome: sp.kind === "no_results" ? "no_results" : "unparsed",
          result_count: sp.kind === "no_results" ? 0 : null,
          detail: sp.kind === "no_results" ? "not conclusive on this registry; confirming with TinyFish Agent" : sp.reason,
        });
      } else {
        check(ctx, adapter, { step: "search", method: "tinyfish_fetch", url, query, outcome: "error", result_count: null, detail: f.error });
      }
    } catch (err) {
      if (err instanceof TinyVerifyError && err.code === "tinyfish_auth") throw err;
      check(ctx, adapter, { step: "search", method: "tinyfish_fetch", url, query, outcome: "error", result_count: null, detail: err instanceof Error ? err.message : String(err) });
    }
    return agentSearch(adapter, ctx, query, spec.agentFallbackUrl, spec.agentInstructions(query, ctx.kind));
  }
  return agentSearch(adapter, ctx, query, adapter.search.url, adapter.search.agentInstructions(query, ctx.kind));
}

function toCandidate(adapterId: string, s: Scored<SearchCandidate>): Candidate {
  return {
    registry_id: adapterId,
    name: s.item.name,
    identifier: s.item.identifier,
    status_raw: s.item.status_raw,
    record_url: s.item.record_url,
    location: s.item.location,
    score: s.score,
    matched_previous_name: s.item.matched_previous_name,
    snippet: s.item.snippet,
  };
}

function buildRecord(
  adapter: RegistryAdapter,
  ctx: Ctx,
  r: Extract<ReadResult, { ok: true }>,
  match: VerifiedRecord["match"],
): VerifiedRecord {
  const p = r.parsed;
  return {
    registry: {
      id: adapter.id,
      name: adapter.name,
      authority: adapter.authority,
      country: adapter.country,
      region: adapter.region,
      curated: adapter.curated !== false,
    },
    record_type: ctx.recordType,
    subject: { name: p.name, entity_kind: ctx.kind },
    status: { normalized: p.status, raw: p.status_raw, effective_date: p.status_effective_date },
    licence_number: p.identifier,
    identifiers: p.identifiers,
    issue_date: p.issue_date,
    expiry_date: p.expiry_date,
    renewal_due_date: p.renewal_due_date,
    expiry_note: p.expiry_note,
    disciplinary_actions: p.disciplinary_actions,
    disciplinary_note: p.disciplinary_note,
    compliance_flags: p.compliance_flags,
    details: p.details,
    match,
    source: {
      url: r.url,
      record_specific_url: r.recordSpecific,
      final_url: r.page?.final_url ?? null,
      title: r.page?.title ?? null,
      official_domain: hostOf(r.url) ?? adapter.officialDomains[0] ?? "",
      retrieved_via: r.via,
      extraction: r.via === "tinyfish_fetch" ? "deterministic_parser" : "agent_structured_output",
      evidence: [...new Set(p.evidence)].slice(0, 12).map((e) => truncate(e, 300)),
      content_sha256: r.page?.text ? sha256(r.page.text) : null,
      registry_timestamp: p.registry_timestamp,
      agent_run_id: r.runId,
    },
    checked_at: ctx.now().toISOString(),
  };
}

function describe(rec: VerifiedRecord, adapter: RegistryAdapter): string {
  const bits = [
    `${rec.subject.name ?? "Record"} is "${rec.status.raw}" (${rec.status.normalized}) on ${adapter.name}`,
    rec.licence_number ? `${adapter.identifierLabel} ${rec.licence_number}` : null,
    rec.expiry_date ? `expires ${rec.expiry_date}` : null,
    rec.disciplinary_actions.length ? `${rec.disciplinary_actions.length} disciplinary item(s)` : null,
    rec.compliance_flags.length ? `flags: ${rec.compliance_flags.map((f) => f.code).join(", ")}` : null,
  ].filter(Boolean);
  return `${bits.join("; ")}.`;
}

async function verifyWithAdapter(adapter: RegistryAdapter, ctx: Ctx): Promise<AdapterResult> {
  const { req } = ctx;
  const notes = adapter.notes.length ? ` Coverage: ${adapter.notes.join(" ")}` : "";

  if (req.licence_number) {
    const id = adapter.normalizeIdentifier(req.licence_number);
    if (!id) {
      return {
        outcome: "invalid_input",
        records: [],
        candidates: [],
        message: `"${req.licence_number}" is not a valid ${adapter.identifierLabel} for ${adapter.name} (example: ${adapter.identifierExample}).`,
      };
    }
    const r = await readRecord(adapter, ctx, { id, url: null, nameHint: req.name });
    if (!r.ok) {
      return r.notFound
        ? { outcome: "no_match", records: [], candidates: [], message: `${adapter.name} has no record for ${adapter.identifierLabel} ${id}.${notes}` }
        : { outcome: "source_unavailable", records: [], candidates: [], message: `Could not read ${adapter.name} for ${adapter.identifierLabel} ${id}: ${r.reason}` };
    }
    const nc = identifierNameCheck(req.name, r.parsed.name, ctx.kind);
    const rec = buildRecord(adapter, ctx, r, { method: "identifier", score: nc.score, query: id, name_matches_request: nc.ok });
    if (!nc.ok) {
      return {
        outcome: "name_mismatch",
        records: [rec],
        candidates: [],
        message: `${adapter.identifierLabel} ${id} exists but is registered to "${r.parsed.name ?? "an unreadable name"}", which does not match "${req.name}": ${nc.reason} (score ${nc.score}). Check the number before relying on it.`,
      };
    }
    if (nc.partial) {
      ctx.warnings.push(`"${req.name}" is a shorter or longer form of the registered name "${r.parsed.name}". The record was chosen by its number; confirm the name if it matters.`);
    }
    return { outcome: "verified", records: [rec], candidates: [], message: describe(rec, adapter) };
  }

  const variants = nameVariants(req.name, ctx.kind, {
    lastFirst: !!adapter.lastFirstNames && ctx.kind === "person",
    max: adapter.search.mode === "agent" ? 2 : 3,
  });
  let nearMisses: Scored<SearchCandidate>[] = [];
  let answered = false;
  const unread: { variant: string; reason: string }[] = [];

  for (const variant of variants) {
    const sr = await searchCandidates(adapter, ctx, variant);
    if (sr.kind === "unavailable") {
      unread.push({ variant, reason: sr.reason });
      continue;
    }
    answered = true;
    if (sr.kind === "no_results") continue;

    const scored = sr.candidates.map((c) => ({ item: c, score: nameScore(req.name, c.name, ctx.kind) }));
    if (sr.total && sr.total > sr.candidates.length) {
      ctx.warnings.push(`${adapter.name} reported ${sr.total} matches for "${variant}"; only the first ${sr.candidates.length} were compared. Use the identifier for certainty.`);
    }
    const d = decide(scored);
    if (d.kind === "single") {
      const c = d.best.item;
      const id = c.identifier ? adapter.normalizeIdentifier(c.identifier) : null;
      const r = await readRecord(adapter, ctx, { id, url: c.record_url, nameHint: c.name });
      if (!r.ok) {
        return {
          outcome: "source_unavailable",
          records: [],
          candidates: [toCandidate(adapter.id, d.best)],
          message: `Found "${c.name}" in the ${adapter.name} search but could not read its record: ${r.reason}`,
        };
      }
      // The record that was opened must be the search result that was chosen,
      // and its own name must match the request. A search result is not proof.
      const recordName = r.parsed.name;
      const parsedId = r.parsed.identifier ? adapter.normalizeIdentifier(r.parsed.identifier) : null;
      const sameId = !!id && parsedId === id;
      const sameRecord = sameId || (!!recordName && nameScore(c.name, recordName, ctx.kind) >= MATCH_THRESHOLDS.strong);
      const reqScore = recordName ? nameScore(req.name, recordName, ctx.kind) : null;
      const nameOk = reqScore === null ? sameId : reqScore >= MATCH_THRESHOLDS.weak;
      const score = reqScore ?? d.best.score;
      // The register's own search tied this name to this number (CSLB, for
      // example, lists a person under the licence of the business they work for).
      const linkedById = sameId && d.best.score >= MATCH_THRESHOLDS.strong;
      const rec = buildRecord(adapter, ctx, r, { method: d.method, score, query: variant, name_matches_request: nameOk });
      if (!sameRecord || (!nameOk && !linkedById && !c.matched_previous_name)) {
        return {
          outcome: "name_mismatch",
          records: [rec],
          candidates: [toCandidate(adapter.id, d.best)],
          message: `The search matched "${c.name}", but the record that was opened shows "${recordName ?? "no name"}"${
            parsedId ? ` (${adapter.identifierLabel} ${parsedId})` : ""
          }, which does not match "${req.name}". Nothing was verified. Re-run with licence_number set to the identifier you expect.`,
        };
      }
      if (!nameOk && linkedById && !c.matched_previous_name) {
        ctx.warnings.push(
          `The ${adapter.name} search linked "${c.name}" to ${adapter.identifierLabel} ${id}, but the record is held under the name "${recordName}". Check that this is the person or business you mean.`,
        );
      }
      if (reqScore === null) ctx.warnings.push(`The ${adapter.name} record page did not show a name; the match relies on the search result and the ${adapter.identifierLabel}.`);
      const alternates = scored
        .filter((s) => s.item !== c && s.score >= MATCH_THRESHOLDS.weak)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((s) => toCandidate(adapter.id, s));
      if (c.matched_previous_name) ctx.warnings.push(`"${c.name}" matched on a previous name of the company; the record now shows "${recordName ?? c.name}".`);
      return { outcome: "verified", records: [rec], candidates: alternates, message: describe(rec, adapter) };
    }
    if (d.kind === "multiple") {
      return {
        outcome: "multiple_matches",
        records: [],
        candidates: d.options.slice(0, 15).map((o) => toCandidate(adapter.id, o)),
        message: `${d.options.length} records on ${adapter.name} match "${req.name}"${d.exact ? " exactly" : " closely but not exactly"}. No record was chosen. Re-run with licence_number set to one of the identifiers in candidates.`,
      };
    }
    if (d.nearMisses.length > nearMisses.length) nearMisses = d.nearMisses;
  }

  if (!answered) {
    return {
      outcome: "source_unavailable",
      records: [],
      candidates: [],
      message: `Could not search ${adapter.name}: ${unread[0]?.reason ?? "unknown error"}`,
    };
  }
  if (unread.length > 0) {
    // Some name forms got "no results" but others could not be read. The unread
    // form may be the one the register needs (CSLB lists people last name first),
    // so "no match" would be a guess.
    return {
      outcome: "source_unavailable",
      records: [],
      candidates: nearMisses.map((s) => toCandidate(adapter.id, s)),
      message: `No match for ${variants.filter((v) => !unread.some((u) => u.variant === v)).map((v) => `"${v}"`).join(", ")} on ${adapter.name}, but the search for ${unread
        .map((u) => `"${u.variant}"`)
        .join(", ")} could not be read (${unread[0]?.reason ?? "unknown error"}). TinyVerify does not report no_match until every name form has been checked.`,
    };
  }
  return {
    outcome: "no_match",
    records: [],
    candidates: nearMisses.map((s) => toCandidate(adapter.id, s)),
    message: `No record on ${adapter.name} matches "${req.name}" (tried: ${variants.map((v) => `"${v}"`).join(", ")}).${
      nearMisses.length ? " Similar names are listed in candidates for review; none is close enough to report as a match." : ""
    }${notes}`,
  };
}

/** The adapter that produced a record: the curated one, or a rebuilt discovered one. */
export function adapterForRecord(rec: VerifiedRecord): RegistryAdapter | null {
  if (rec.registry.curated) return getAdapter(rec.registry.id) ?? null;
  const host = rec.registry.id.replace(/^discovered:/, "");
  return discoveredAdapter(host, rec.source.url, rec.registry.name, rec.registry.country);
}

export function discoveredAdapter(host: string, startUrl: string, title: string, jurisdiction: string): RegistryAdapter {
  const parts = host.split(".");
  const domains = [host];
  if (parts.length >= 4) domains.push(parts.slice(1).join("."));
  return {
    id: `discovered:${host}`,
    name: title || host,
    authority: host,
    country: jurisdiction,
    region: null,
    jurisdictions: [],
    recordTypes: [],
    entityKinds: ["business", "person"],
    officialDomains: domains,
    identifierLabel: "licence or registration number",
    identifierExample: "as shown by the registry",
    dateOrder: usesMonthFirstDates(host, jurisdiction) ? "MDY" : "DMY",
    notes: [],
    agent: { stealth: true, proxyCountry: "US" },
    curated: false,
    normalizeIdentifier: (raw) => {
      const s = raw.trim().toUpperCase().replace(/\s+/g, "");
      return /^[A-Z0-9][A-Z0-9.\-/]{0,29}$/.test(s) ? s : null;
    },
    recordUrl: () => null,
    identifierSearchUrl: startUrl,
    search: { mode: "agent", url: startUrl, agentInstructions: () => "Use this site's licence or registry lookup form. If this page is not the lookup form, follow the link to it on the same site." },
    parseRecord: () => ({ ok: false, reason: "no curated parser for a discovered registry" }),
    normalizeStatus: genericNormalizeStatus,
    monitorPurpose: (r) =>
      `Alert when the status of ${r.subject.name ?? "this record"} (${r.licence_number ?? ""}) changes from "${r.status.raw}", or a disciplinary action, expiry or restriction is added or changed.`,
  };
}

async function verifyWithDiscovery(ctx: Ctx, rt: Route, place: string = ctx.req.jurisdiction): Promise<AdapterResult & { adapter: RegistryAdapter | null }> {
  const query = discoveryQuery(ctx.req.record_type, place);
  const pseudo = { id: "discovery", name: "TinyFish Search registry discovery" } as RegistryAdapter;
  let hits;
  try {
    hits = await ctx.gw.search({ query, purpose: `Find the official government registry or licensing board for ${ctx.req.record_type} in ${place}` });
  } catch (err) {
    if (err instanceof TinyVerifyError && err.code === "tinyfish_auth") throw err;
    check(ctx, pseudo, { step: "discover", method: "tinyfish_search", url: null, query, outcome: "error", result_count: null, detail: err instanceof Error ? err.message : String(err) });
    return { adapter: null, outcome: "source_unavailable", records: [], candidates: [], message: "Registry discovery search failed." };
  }
  const { chosen, rejected } = pickOfficial(hits);
  check(ctx, pseudo, {
    step: "discover",
    method: "tinyfish_search",
    url: chosen?.url ?? null,
    query,
    outcome: chosen ? "ok" : "no_results",
    result_count: hits.length,
    detail: chosen ? `chose official host ${chosen.host}` : `no official host among: ${[...new Set(rejected)].slice(0, 6).join(", ") || "no results"}`,
  });
  if (!chosen) {
    return {
      adapter: null,
      outcome: "unsupported",
      records: [],
      candidates: [],
      message: `No curated registry covers ${ctx.req.record_type} in ${place} (${rt.reason}), and search found no official government source to use. TinyVerify does not fall back to unofficial sites.`,
    };
  }
  const adapter = discoveredAdapter(chosen.host, chosen.url, chosen.title, place);
  ctx.warnings.push(
    `Registry found at run time with TinyFish Search: ${chosen.host} ("${truncate(chosen.title, 80)}"). It passed the official-domain check, but confirm it is the right authority before relying on the result.`,
  );
  const r = await verifyWithAdapter(adapter, ctx);
  return { ...r, adapter };
}

// source_unavailable ranks above no_match: when one registry could not be read,
// "no match anywhere" has not been shown.
const OUTCOME_RANK: Outcome[] = ["verified", "name_mismatch", "multiple_matches", "source_unavailable", "no_match", "invalid_input", "unsupported"];

function baseResult(req: Record<string, unknown>, now: Date): Omit<VerifyResult, "outcome" | "message"> {
  return {
    schema_version: SCHEMA_VERSION,
    request: req,
    records: [],
    candidates: [],
    sources_checked: [],
    warnings: [],
    tinyfish_calls: [],
    checked_at: now.toISOString(),
  };
}

/**
 * Verify a person or business against official registries.
 * Always resolves (never throws for expected failures) so callers get a
 * structured answer for no match, several matches and unreadable sources.
 */
export async function verify(input: unknown, deps: PipelineDeps): Promise<VerifyResult> {
  const now = deps.now ?? (() => new Date());
  const parsed = VerifyRequestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ...baseResult((input ?? {}) as Record<string, unknown>, now()),
      outcome: "invalid_input",
      message: parsed.error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; "),
    };
  }
  const req = parsed.data;
  const gw = new TracedGateway(deps.gateway);
  const rt = route(req);
  const checks: SourceCheck[] = [];
  const warnings: string[] = [];
  if (rt.jurisdiction.ambiguous) warnings.push(...rt.jurisdiction.notes);
  if (rt.jurisdiction.assumption) warnings.push(rt.jurisdiction.assumption);

  const results: { adapter: RegistryAdapter | null; r: AdapterResult }[] = [];
  const baseCtx = (adapter: RegistryAdapter | null): Ctx => ({
    gw,
    req,
    kind: inferKind(req, adapter),
    recordType: rt.recordType ?? req.record_type,
    checks,
    warnings,
    now,
  });

  try {
    if (req.registry && rt.adapters.length === 0) {
      results.push({
        adapter: null,
        r: { outcome: "invalid_input", records: [], candidates: [], message: `Unknown registry "${req.registry}". See GET /registries for ids.` },
      });
    } else if (rt.adapters.length > 0 || rt.jurisdiction.ambiguous) {
      // Sequential on purpose: TinyFish Agent allows a small number of concurrent runs.
      for (const adapter of rt.adapters) results.push({ adapter, r: await verifyWithAdapter(adapter, baseCtx(adapter)) });
      // "CA" for a business: Corporations Canada is curated, California is not, so
      // the California side is found with TinyFish Search instead of being skipped.
      const uncovered = req.registry ? [] : rt.jurisdiction.keys.filter((k) => !rt.adapters.some((a) => a.jurisdictions.includes(k)));
      for (const key of uncovered) {
        if (!req.allow_discovery) {
          warnings.push(`${jurisdictionLabel(key)} was not checked: no curated registry for this record type there, and discovery is off.`);
          continue;
        }
        const d = await verifyWithDiscovery(baseCtx(null), rt, jurisdictionLabel(key).replace(/\s*\(.*?\)/, ""));
        results.push({ adapter: d.adapter, r: d });
      }
    } else if (req.allow_discovery) {
      const d = await verifyWithDiscovery(baseCtx(null), rt);
      results.push({ adapter: d.adapter, r: d });
    } else {
      results.push({
        adapter: null,
        r: {
          outcome: "unsupported",
          records: [],
          candidates: [],
          message: `No curated registry for this request (${rt.reason}) and discovery is off. See GET /registries.`,
        },
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ adapter: null, r: { outcome: "source_unavailable", records: [], candidates: [], message: msg } });
  }

  results.sort((a, b) => OUTCOME_RANK.indexOf(a.r.outcome) - OUTCOME_RANK.indexOf(b.r.outcome));
  const top = results[0]?.r ?? { outcome: "unsupported" as Outcome, records: [], candidates: [], message: "No result." };
  if (top.outcome === "no_match") {
    for (const n of rt.jurisdiction.notes) if (!warnings.includes(n)) warnings.push(n);
  }
  let message =
    results.length > 1
      ? results.map((x) => `[${x.adapter?.id ?? "tinyverify"}] ${x.r.message}`).join(" ")
      : top.message;
  // Two registries each verified a record (for example "CA" matched in both
  // Canada and California). That is two different entities, so do not pick one.
  const verifiedCount = results.filter((x) => x.r.outcome === "verified").length;
  let outcome = top.outcome;
  if (verifiedCount > 1) {
    outcome = "multiple_matches";
    message = `Records were found on ${verifiedCount} registries, so no single record was chosen. Set jurisdiction or registry to pick one. ${message}`;
  }

  return {
    ...baseResult(req as unknown as Record<string, unknown>, now()),
    outcome,
    message,
    records: results.flatMap((x) => x.r.records),
    candidates: results.flatMap((x) => x.r.candidates),
    sources_checked: checks,
    warnings,
    tinyfish_calls: gw.calls,
  };
}
