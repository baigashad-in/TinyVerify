/**
 * Company checks for any country without a built-in register.
 *
 * 1. Find the company on the global LEI register (GLEIF), which names its
 *    national register and its number there.
 * 2. Pick the national register from GLEIF's Registration Authorities List:
 *    the one in the company's LEI record, or else the register that most LEI
 *    records from that place are filed with.
 * 3. Find that register's search page with TinyFish Search, limited to the
 *    register's own website.
 * 4. Read the record there with TinyFish Agent, by number when one is known.
 *
 * Only step 4 can make the answer "verified". LEI records are returned in
 * `lei_records` for reference, and the message says so.
 */
import { GLEIF_RECORD_PAGE, NO_REGISTER, type Gleif, type LeiEntity, type RegistrationAuthority } from "../gleif/client.js";
import { BAD_SIGNS, GOOD_SIGNS, SEARCH_ACTION } from "../registries/discovery.js";
import type { Place } from "../registries/places.js";
import type { RegistryAdapter } from "../registries/types.js";
import { TinyVerifyError } from "../tinyfish/gateway.js";
import type { LeiRecord, Outcome } from "../types.js";
import { MATCH_THRESHOLDS, nameScore } from "../util/match.js";
import { baseDomain, hostOf, truncate } from "../util/text.js";
import type { AdapterResult, Ctx } from "./pipeline.js";

export interface WorldwideHelpers {
  verifyWithAdapter(adapter: RegistryAdapter, ctx: Ctx): Promise<AdapterResult>;
  discoveredAdapter(host: string, startUrl: string, title: string, jurisdiction: string, opts?: WorldAdapterOptions): RegistryAdapter;
  /** The older path: TinyFish Search finds a register, used when GLEIF cannot help. */
  searchDiscovery(ctx: Ctx, place: string): Promise<AdapterResult & { adapter: RegistryAdapter | null }>;
}

export interface WorldAdapterOptions {
  proxyCountry?: string;
  identifierLabel?: string;
  officialDomains?: string[];
  authority?: string;
  agentInstructions?: string;
}

export type WorldResult = AdapterResult & { adapter: RegistryAdapter | null; lei: LeiRecord[] };

const LEI_REGISTRY = { id: "gleif-lei", name: "GLEIF global LEI register" } as RegistryAdapter;

function bestName(req: string, e: LeiEntity): number {
  return Math.max(...[e.legal_name, ...e.other_names].map((n) => nameScore(req, n, "business")));
}

function samePlace(e: LeiEntity, place: Place): boolean {
  const j = (e.jurisdiction ?? "").toUpperCase();
  const c = (e.country ?? "").toUpperCase();
  return j === place.country || j.startsWith(`${place.country}-`) || (!j && c === place.country);
}

function normNumber(s: string | null | undefined): string {
  return (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function toLeiRecord(e: LeiEntity, score: number, ras: Map<string, RegistrationAuthority>, note: string): LeiRecord {
  const ra = e.registered_at ? ras.get(e.registered_at) : undefined;
  return {
    lei: e.lei,
    legal_name: e.legal_name,
    other_names: e.other_names.slice(0, 6),
    jurisdiction: e.jurisdiction,
    country: e.country,
    city: e.city,
    category: e.category,
    entity_status: e.entity_status,
    registration_status: e.registration_status,
    registered_at: e.registered_at,
    register_name: ra?.name ?? null,
    register_website: ra?.website ?? null,
    registered_as: e.registered_as,
    last_update: e.last_update,
    next_renewal: e.next_renewal,
    source_url: GLEIF_RECORD_PAGE(e.lei),
    match_score: Math.round(score * 1000) / 1000,
    counts_as_verified: false,
    note,
  };
}

function leiSummary(e: LeiEntity, ras: Map<string, RegistrationAuthority>): string {
  const ra = e.registered_at ? ras.get(e.registered_at) : undefined;
  const reg = e.registered_as ? `, number ${e.registered_as}${ra ? ` at ${ra.name}` : ""}` : "";
  return `${e.legal_name} (LEI ${e.lei}, entity status ${e.entity_status ?? "not stated"}, LEI registration ${e.registration_status ?? "not stated"}${reg})`;
}

function isFatal(err: unknown): boolean {
  return err instanceof TinyVerifyError && (err.code === "tinyfish_auth" || err.code === "tinyfish_billing");
}

export async function verifyWorldwide(ctx: Ctx, place: Place, gleif: Gleif, h: WorldwideHelpers): Promise<WorldResult> {
  const { req } = ctx;
  const check = (c: Parameters<typeof ctx.checks.push>[0]) => ctx.checks.push(c);
  const now = () => ctx.now().toISOString();
  const leiCheck = (c: { url: string | null; query: string | null; outcome: "ok" | "no_results" | "error"; result_count: number | null; detail: string | null }) =>
    check({ registry_id: LEI_REGISTRY.id, registry_name: LEI_REGISTRY.name, checked_at: now(), step: "lei", method: "gleif_api", ...c });
  if (place.assumption) ctx.warnings.push(place.assumption);

  // 1. The register list (cached) and the LEI register
  let ras = new Map<string, RegistrationAuthority>();
  let gleifError: string | null = null;
  try {
    ras = new Map((await gleif.authorities()).map((r) => [r.code, r]));
  } catch (err) {
    gleifError = err instanceof Error ? err.message : String(err);
  }

  let matches: { e: LeiEntity; score: number }[] = [];
  let chosen: LeiEntity | null = null;
  if (!gleifError) {
    const before = gleif.calls.length;
    try {
      const { entities, method } = await gleif.searchByName(req.name, (e) => samePlace(e, place) && bestName(req.name, e) >= MATCH_THRESHOLDS.strong);
      const scored = entities.map((e) => ({ e, score: bestName(req.name, e) }));
      const here = scored.filter((x) => samePlace(x.e, place));
      const strong = here.filter((x) => x.score >= MATCH_THRESHOLDS.strong).sort((a, b) => b.score - a.score);
      // Funds and branches share their parent's name; the company itself is the GENERAL entry.
      const general = strong.filter((x) => !/^(FUND|BRANCH)$/i.test(x.e.category ?? ""));
      matches = (general.length ? general : strong).slice(0, 5);
      const wanted = normNumber(req.licence_number);
      if (wanted) {
        const byNumber = matches.filter((x) => normNumber(x.e.registered_as) === wanted);
        if (byNumber.length) matches = byNumber;
      }
      const top = matches[0];
      if (top && (matches.length === 1 || (matches[1] && top.score - matches[1].score >= MATCH_THRESHOLDS.gap))) chosen = top.e;
      const call = gleif.calls[before];
      leiCheck({
        url: call?.url ?? null,
        query: req.name,
        outcome: matches.length ? "ok" : "no_results",
        result_count: entities.length,
        detail:
          `${method === "legal_name" ? "found by exact legal name" : method === "fulltext" ? "found by full-text search (includes other names)" : method === "fuzzy" ? "found by fuzzy name search" : "exact, full-text and fuzzy searches found no close match here"}; ` +
          `${here.length} in ${place.label}, ${matches.length} close match${matches.length === 1 ? "" : "es"}` +
          (scored.length > here.length ? `; ${scored.length - here.length} elsewhere ignored` : ""),
      });
    } catch (err) {
      gleifError = err instanceof Error ? err.message : String(err);
      leiCheck({ url: gleif.calls[before]?.url ?? null, query: req.name, outcome: "error", result_count: null, detail: gleifError });
    }
  }

  if (gleifError) {
    ctx.warnings.push(`The GLEIF API could not be used (${truncate(gleifError, 120)}), so TinyFish Search was used to find the register instead.`);
    const d = await h.searchDiscovery(ctx, place.label);
    return { ...d, lei: [] };
  }

  const leiNote = "From the global LEI register, not the national register. Shown for reference; it does not count as verified.";
  const lei = matches.map((m) => toLeiRecord(m.e, m.score, ras, leiNote));
  if (matches.length > 1 && !chosen) {
    ctx.warnings.push(`The LEI register has ${matches.length} entities named like "${req.name}" in ${place.label}; none was chosen from it. Give the company number to pick one.`);
  }

  // The LEI record's own register and number apply only if the company is filed in the place asked about.
  const leiFitsPlace = !!chosen && (place.subdivision ? (chosen.jurisdiction ?? "").toUpperCase() === place.subdivision : samePlace(chosen, place));
  if (chosen && !leiFitsPlace) {
    ctx.warnings.push(
      `The LEI register says ${chosen.legal_name} is incorporated in ${chosen.jurisdiction ?? "another jurisdiction"}, not ${place.label}. TinyVerify checks the register for ${place.label}, which may list it as a company from elsewhere.`,
    );
  }

  // 2. Which national register
  let ra: RegistrationAuthority | null = null;
  let why = "";
  if (chosen && leiFitsPlace && chosen.registered_at && !NO_REGISTER.has(chosen.registered_at)) {
    ra = ras.get(chosen.registered_at) ?? null;
    why = "named in this company's LEI record";
  }
  if ((!ra || !ra.website) && !place.subdivision && (place.country === "US" || place.country === "CA") && !chosen) {
    return {
      adapter: null,
      outcome: "unsupported",
      records: [],
      candidates: [],
      message: `Companies in ${place.label} are registered by ${place.country === "US" ? "state" : "province"} (or federally), and the LEI register did not identify this one, so TinyVerify does not know which register to check. Add the ${place.country === "US" ? "state, for example \"Delaware\"" : "province, for example \"Ontario\""} to the place.`,
      lei,
    };
  }
  if (!ra || !ra.website) {
    const before = gleif.calls.length;
    try {
      const sample = await gleif.sampleJurisdiction(place.gleifJurisdiction);
      // Group by website, since one register can have many codes (each German
      // local court that keeps the Handelsregister has its own code).
      const byHost = new Map<string, { count: number; codes: Map<string, number> }>();
      for (const e of sample) {
        const code = e.registered_at;
        const r = code && !NO_REGISTER.has(code) ? ras.get(code) : undefined;
        const host = r?.website ? hostOf(r.website) : null;
        if (!code || !host) continue;
        const g = byHost.get(host) ?? { count: 0, codes: new Map() };
        g.count++;
        g.codes.set(code, (g.codes.get(code) ?? 0) + 1);
        byHost.set(host, g);
      }
      const top = [...byHost.entries()].sort((a, b) => b[1].count - a[1].count)[0];
      const topCode = top ? [...top[1].codes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] : undefined;
      if (topCode) {
        ra = ras.get(topCode) ?? null;
        why = `the register that ${top?.[1].count} of ${sample.length} sampled LEI records from ${place.label} are filed with`;
      }
      leiCheck({
        url: gleif.calls[before]?.url ?? null,
        query: place.gleifJurisdiction,
        outcome: ra ? "ok" : "no_results",
        result_count: sample.length,
        detail: ra ? `register for ${place.label}: ${ra.name} (${ra.code})` : `no register with a website among ${sample.length} sampled LEI records`,
      });
    } catch (err) {
      leiCheck({ url: gleif.calls[before]?.url ?? null, query: place.gleifJurisdiction, outcome: "error", result_count: null, detail: err instanceof Error ? err.message : String(err) });
    }
  }

  const withLei = (r: AdapterResult & { adapter: RegistryAdapter | null }): WorldResult => {
    let message = r.message.trim().replace(/([^.!?])$/, "$1.");
    if (chosen && r.outcome !== "verified") {
      message += ` The global LEI register lists ${leiSummary(chosen, ras)}. That is shown in lei_records, but it is not the national register, so it does not count as verified.`;
    } else if (!chosen && lei.length && r.outcome !== "verified") {
      message += ` The global LEI register has ${lei.length} similar entr${lei.length === 1 ? "y" : "ies"} (in lei_records, for reference only).`;
    }
    return { ...r, message, lei };
  };

  if (!ra || !ra.website) {
    ctx.warnings.push(`GLEIF's list of registers has no website for ${place.label}, so TinyFish Search was used to find the register instead.`);
    return withLei(await h.searchDiscovery(ctx, place.label));
  }

  // 3. The register's search page, found with TinyFish Search on its own site
  const raHost = (hostOf(ra.website) ?? "").replace(/^www\./, "");
  const domain = baseDomain(raHost);
  let startUrl = ra.website;
  const query = `${ra.name} ${place.label} company search`;
  try {
    const hits = await ctx.gw.search({ query, include_domains: [domain], purpose: `Find the public company search page of ${ra.name}` });
    const onSite = hits.filter((x) => {
      const hh = hostOf(x.url);
      return !!hh && (hh === domain || hh.endsWith(`.${domain}`));
    });
    const scored = onSite
      .map((x) => {
        const text = `${hostOf(x.url)} ${x.url.replace(/[-_/.?=&]+/g, " ")} ${x.title}`;
        return { x, score: (SEARCH_ACTION.test(text) ? 2 : 0) + (GOOD_SIGNS.business.test(text) ? 1 : 0) - (BAD_SIGNS.test(text) ? 2 : 0) };
      })
      .sort((a, b) => b.score - a.score || a.x.position - b.x.position);
    const best = scored[0];
    if (best && best.score >= 2) startUrl = best.x.url;
    check({
      registry_id: `discovered:${raHost}`,
      registry_name: ra.name,
      checked_at: now(),
      step: "discover",
      method: "tinyfish_search",
      url: startUrl,
      query,
      outcome: "ok",
      result_count: hits.length,
      detail: best && best.score >= 2 ? `search page on ${domain}: "${truncate(best.x.title, 60)}"` : `no search page found on ${domain}; starting at the register's website`,
    });
  } catch (err) {
    if (isFatal(err)) throw err;
    check({
      registry_id: `discovered:${raHost}`,
      registry_name: ra.name,
      checked_at: now(),
      step: "discover",
      method: "tinyfish_search",
      url: ra.website,
      query,
      outcome: "error",
      result_count: null,
      detail: `${err instanceof Error ? err.message : String(err)}; starting at the register's website`,
    });
  }

  ctx.warnings.push(
    `Register chosen from GLEIF's Registration Authorities List: ${ra.name}${ra.organisation && !ra.name.includes(ra.organisation) ? ` (${ra.organisation})` : ""}, ${raHost}, code ${ra.code}; ${why}. It has no built-in parser, so TinyFish Agent reads it.`,
  );

  const adapter = h.discoveredAdapter(raHost, startUrl, ra.name, place.country, {
    proxyCountry: place.country,
    identifierLabel: "company number",
    officialDomains: [domain],
    authority: ra.organisation ?? ra.name,
    agentInstructions:
      "This is the official register's website. If this page is not the company search itself, find the public company or business search on this site (or the register's own search application linked from it) and use it. The site may not be in English: use it in its own language and copy values exactly, without translating.",
  });

  // 4. Read the national register
  const leiNumber = chosen && leiFitsPlace ? chosen.registered_as : null;
  const number = req.licence_number ?? leiNumber ?? undefined;
  const subCtx: Ctx = { ...ctx, kind: "business", req: { ...req, ...(number ? { licence_number: number } : {}) } };
  if (!req.licence_number && leiNumber) {
    ctx.warnings.push(`The company number ${leiNumber} comes from the LEI record; the national register is searched by that number.`);
  }
  let r = await h.verifyWithAdapter(adapter, subCtx);

  // A register may show the name in its own language or legal form. The LEI
  // record links the requested name to this number, so a record whose name
  // matches one of the LEI record's names is the same company.
  if (r.outcome === "name_mismatch" && chosen && leiNumber && !req.licence_number) {
    const rec = r.records[0];
    const onRecord = rec?.subject.name ?? null;
    const viaLei = onRecord ? bestName(onRecord, chosen) : 0;
    if (rec && viaLei >= MATCH_THRESHOLDS.strong) {
      rec.match = { ...rec.match, name_matches_request: true };
      ctx.warnings.push(
        `The register shows the name as "${onRecord}". It matches the LEI record's name for number ${leiNumber} (score ${viaLei}), which links it to "${req.name}".`,
      );
      r = {
        ...r,
        outcome: "verified" as Outcome,
        message: `${onRecord} is "${rec.status.raw}" (${rec.status.normalized}) on ${ra.name}; company number ${rec.licence_number ?? leiNumber}. The register writes the name differently from the request, but it matches the LEI record for this number.`,
      };
    }
  }

  // A number from the LEI record may be written differently on the register.
  // One name search is tried before saying there is no such record.
  if (r.outcome === "no_match" && leiNumber && !req.licence_number) {
    ctx.warnings.push(`${ra.name} found nothing for number ${leiNumber} from the LEI record, so it was searched by name too.`);
    r = await h.verifyWithAdapter(adapter, { ...ctx, kind: "business" });
  }

  // Cross-check a verified record against the LEI record.
  if (r.outcome === "verified" && chosen) {
    const rec = r.records[0];
    if (rec && leiNumber && normNumber(rec.licence_number) && normNumber(rec.licence_number) !== normNumber(leiNumber)) {
      ctx.warnings.push(`The register shows number ${rec.licence_number}, but the LEI record gives ${leiNumber}. Check which is current.`);
    }
    if (rec && /^INACTIVE$/i.test(chosen.entity_status ?? "") && rec.status.normalized === "active") {
      ctx.warnings.push(`The national register shows the company as active, but its LEI record says INACTIVE (last updated ${chosen.last_update ?? "unknown"}).`);
    }
  }
  return withLei({ ...r, adapter });
}
