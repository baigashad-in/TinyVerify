import { randomUUID, timingSafeEqual } from "node:crypto";
import { TracedGateway, toMonitorPayload, type Gateway, type MonitorRunPayload } from "../tinyfish/gateway.js";
import { looksBlocked, type ParsedRecord, type RegistryAdapter } from "../registries/types.js";
import type { TinyFishCall, VerifiedRecord, VerifyResult } from "../types.js";
import { sha256, stableHash, truncate } from "../util/text.js";
import { adapterForRecord, readRecord, verify } from "../verify/pipeline.js";
import { diffRecords, type ChangeEvent } from "./diff.js";
import type { Store, Watch } from "./store.js";

export interface MonitorServiceOptions {
  gateway: Gateway;
  store: Store;
  /** Public https base URL of this server, used for the TinyFish Monitor webhook. */
  publicBaseUrl: string | null;
  webhookSecret: string;
  defaultCron: string;
  /** Re-read with TinyFish Agent when Monitor's Fetch content cannot be parsed. */
  agentEscalation: boolean;
  now?: () => Date;
  /** POSTs change events to a watch's callback_url. Swappable for tests. */
  forward?: (url: string, body: unknown) => Promise<void>;
  log?: (msg: string) => void;
}

/** For registries found by Search: force an Agent re-read at least every (MAX_AGENT_SKIPS + 1) runs. */
export const MAX_AGENT_SKIPS = 6;
/** Pages shorter than this are treated as a shell or error page, not a record. */
const MIN_USABLE_PAGE_CHARS = 400;

export class WatchError extends Error {
  constructor(
    readonly code: "not_verified" | "no_stable_url" | "bad_callback" | "not_found",
    message: string,
    readonly verification?: VerifyResult,
  ) {
    super(message);
  }
}

export interface ProcessResult {
  watch_id: string | null;
  ignored: null | "unknown_monitor" | "baseline" | "duplicate" | "deleted";
  events: ChangeEvent[];
  record: VerifiedRecord | null;
  read_via: "tinyfish_monitor" | "tinyfish_monitor+fetch" | "tinyfish_monitor+agent" | null;
  tinyfish_calls: TinyFishCall[];
}

async function defaultForward(url: string, body: unknown): Promise<void> {
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "TinyVerify/1.0" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Rebuild a record from a fresh parse, keeping identity fields from the previous record. */
function refreshRecord(prev: VerifiedRecord, p: ParsedRecord, url: string, via: "tinyfish_monitor" | "tinyfish_agent", text: string | null, runId: string | null, now: Date): VerifiedRecord {
  return {
    ...prev,
    subject: { ...prev.subject, name: p.name ?? prev.subject.name },
    status: { normalized: p.status, raw: p.status_raw, effective_date: p.status_effective_date },
    licence_number: p.identifier ?? prev.licence_number,
    identifiers: Object.keys(p.identifiers).length ? p.identifiers : prev.identifiers,
    issue_date: p.issue_date,
    expiry_date: p.expiry_date,
    renewal_due_date: p.renewal_due_date,
    expiry_note: p.expiry_note ?? prev.expiry_note,
    disciplinary_actions: p.disciplinary_actions,
    disciplinary_note: p.disciplinary_note,
    compliance_flags: p.compliance_flags,
    details: Object.keys(p.details).length ? p.details : prev.details,
    source: {
      ...prev.source,
      url,
      record_specific_url: true,
      retrieved_via: via,
      extraction: via === "tinyfish_agent" ? "agent_structured_output" : "deterministic_parser",
      evidence: [...new Set(p.evidence)].slice(0, 12).map((e) => truncate(e, 300)),
      content_sha256: text ? sha256(text) : null,
      registry_timestamp: p.registry_timestamp,
      agent_run_id: runId,
    },
    checked_at: now.toISOString(),
  };
}

export class MonitorService {
  private readonly now: () => Date;
  private readonly forward: (url: string, body: unknown) => Promise<void>;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: MonitorServiceOptions) {
    this.now = opts.now ?? (() => new Date());
    this.forward = opts.forward ?? defaultForward;
    this.log = opts.log ?? ((m) => console.error(m));
  }

  webhookUrl(): string | null {
    if (!this.opts.publicBaseUrl) return null;
    const base = this.opts.publicBaseUrl.replace(/\/+$/, "");
    return `${base}/webhooks/tinyfish?token=${encodeURIComponent(this.opts.webhookSecret)}`;
  }

  /** URL TinyFish Monitor should watch: the registry's stable record URL when it has one. */
  monitorUrl(rec: VerifiedRecord, adapter: RegistryAdapter | null): string | null {
    if (adapter && rec.licence_number) {
      const id = adapter.normalizeIdentifier(rec.licence_number);
      const stable = id ? adapter.recordUrl(id) : null;
      if (stable) return stable;
    }
    return rec.source.record_specific_url ? rec.source.url : null;
  }

  /**
   * Verify first, then create a TinyFish Monitor on the record's official page.
   * Only a single verified record can be watched; ambiguous results are refused.
   */
  async watch(input: { request: unknown; schedule_cron?: string; callback_url?: string | null }) {
    if (input.callback_url && !/^https?:\/\//i.test(input.callback_url)) {
      throw new WatchError("bad_callback", "callback_url must be an http(s) URL.");
    }
    const verification = await verify(input.request, { gateway: this.opts.gateway, now: this.now });
    if (verification.outcome !== "verified" || verification.records.length !== 1) {
      throw new WatchError(
        "not_verified",
        `Only a single verified record can be watched. Verification outcome: ${verification.outcome}. ${verification.message}`,
        verification,
      );
    }
    const rec = verification.records[0] as VerifiedRecord;
    const adapter = adapterForRecord(rec);
    const url = this.monitorUrl(rec, adapter);
    if (!url || !adapter) {
      throw new WatchError("no_stable_url", "The registry did not give a URL for this exact record, so it cannot be monitored.", verification);
    }

    const gw = new TracedGateway(this.opts.gateway);
    const schedule = input.schedule_cron ?? this.opts.defaultCron;
    const webhook = this.webhookUrl();
    const name = `TinyVerify ${rec.registry.id} ${rec.licence_number ?? ""} ${rec.subject.name ?? ""}`.replace(/\s+/g, " ").trim();
    const created = await gw.createMonitor({
      name,
      url,
      schedule_cron: schedule,
      purpose: adapter.monitorPurpose(rec),
      ...(webhook ? { webhook_url: webhook } : {}),
    });

    // Check that Monitor's own Fetch sees the same record we verified.
    const warnings: string[] = [];
    let readable = false;
    const basePage = created.baseline?.pages[0];
    if (basePage?.text && adapter.curated !== false) {
      const p = adapter.parseRecord(basePage);
      readable = p.ok && (!p.record.identifier || !rec.licence_number || adapter.normalizeIdentifier(p.record.identifier) === adapter.normalizeIdentifier(rec.licence_number));
    }
    if (!readable) {
      warnings.push(
        this.opts.agentEscalation
          ? "Monitor's baseline page could not be parsed (likely bot protection or a layout change). Each scheduled check will re-read the record with TinyFish Agent."
          : "Monitor's baseline page could not be parsed and agent escalation is off, so scheduled checks will report the record as unreadable.",
      );
    }
    if (!webhook) {
      warnings.push("PUBLIC_BASE_URL is not set, so TinyFish cannot deliver scheduled results here. Use POST /watches/:id/recheck to run checks on demand.");
    }

    const watch: Watch = {
      id: randomUUID(),
      created_at: this.now().toISOString(),
      state: "active",
      monitor_id: created.monitor_id,
      registry_id: rec.registry.id,
      identifier: rec.licence_number,
      subject_name: rec.subject.name,
      record_url: url,
      schedule_cron: schedule,
      webhook_enabled: !!webhook,
      callback_url: input.callback_url ?? null,
      monitor_baseline_readable: readable,
      baseline: rec,
      latest: rec,
      last_checked_at: rec.checked_at,
      last_unreadable_at: null,
      last_stable_hash: basePage?.text ? stableHash(basePage.text) : null,
      processed_run_ids: created.baseline?.run_id ? [created.baseline.run_id] : [],
      latest_by_extraction: { [rec.source.extraction]: rec },
      agent_skips: 0,
    };
    await this.opts.store.saveWatch(watch);
    return { watch, verification, warnings, tinyfish_calls: gw.calls };
  }

  /** Handle a scheduled-run webhook from TinyFish Monitor. */
  async handleWebhook(body: unknown, token: string | null): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!token || !safeEqual(token, this.opts.webhookSecret)) {
      return { status: 401, body: { error: "invalid webhook token" } };
    }
    if (!body || typeof body !== "object") return { status: 400, body: { error: "expected a JSON object" } };
    const b = body as Record<string, unknown>;
    // The documented shape is { fetch_monitor_id, id, is_baseline, results, errors }.
    // The SDK types do not pin it down, so a nested run and other id names are accepted too.
    const run = b.run && typeof b.run === "object" ? (b.run as Record<string, unknown>) : b;
    const s = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
    const monitor = b.monitor && typeof b.monitor === "object" ? (b.monitor as Record<string, unknown>) : null;
    const monitorId = s(b.fetch_monitor_id) ?? s(run.fetch_monitor_id) ?? s(b.monitor_id) ?? s(run.monitor_id) ?? s(monitor?.id);
    if (!monitorId) {
      // Logged so an unexpected payload shape is visible instead of silently dropped.
      this.log(`TinyFish webhook ignored: no monitor id. Top-level keys: ${Object.keys(b).join(", ") || "(none)"}`);
      return { status: 202, body: { ignored: "not a page monitor payload" } };
    }
    const payload = toMonitorPayload(monitorId, run);
    const result = await this.process(payload);
    return { status: 200, body: { received: true, ...result } };
  }

  /** Run the Monitor now (TinyFish run-now) and process the result like a webhook. */
  async recheck(watchId: string): Promise<ProcessResult> {
    const watch = await this.opts.store.getWatch(watchId);
    if (!watch || watch.state !== "active") throw new WatchError("not_found", `No active watch ${watchId}.`);
    const gw = new TracedGateway(this.opts.gateway);
    const payload = await gw.runMonitor(watch.monitor_id);
    const result = await this.process(payload, gw);
    return { ...result, tinyfish_calls: [...gw.calls, ...result.tinyfish_calls.filter((c) => !gw.calls.includes(c))] };
  }

  async unwatch(watchId: string): Promise<Watch> {
    const watch = await this.opts.store.getWatch(watchId);
    if (!watch || watch.state !== "active") throw new WatchError("not_found", `No active watch ${watchId}.`);
    await this.opts.gateway.deleteMonitor(watch.monitor_id);
    const updated: Watch = { ...watch, state: "deleted" };
    await this.opts.store.saveWatch(updated);
    return updated;
  }

  /** Parse a Monitor run, diff it against the last known record, store and forward changes. */
  async process(payload: MonitorRunPayload, traced?: TracedGateway): Promise<ProcessResult> {
    const gw = traced ?? new TracedGateway(this.opts.gateway);
    const empty = (ignored: ProcessResult["ignored"], watchId: string | null = null): ProcessResult => ({
      watch_id: watchId,
      ignored,
      events: [],
      record: null,
      read_via: null,
      tinyfish_calls: gw.calls,
    });
    const watch = await this.opts.store.findByMonitor(payload.monitor_id);
    if (!watch) return empty("unknown_monitor");
    if (payload.is_baseline) return empty("baseline", watch.id);
    if (payload.run_id && watch.processed_run_ids.includes(payload.run_id)) return empty("duplicate", watch.id);

    const adapter = adapterForRecord(watch.latest);
    if (!adapter) return empty("unknown_monitor", watch.id);
    const now = this.now();
    const page = payload.pages[0] ?? null;
    const hash = page?.text ? stableHash(page.text) : null;

    let parsed: ParsedRecord | null = null;
    let via: ProcessResult["read_via"] = "tinyfish_monitor";
    let agentRunId: string | null = null;
    if (page?.text && adapter.curated !== false) {
      const p = adapter.parseRecord(page);
      if (p.ok) parsed = p.record;
    }

    // A registry found by Search has no parser, so every check needs an Agent
    // read. To save cost the Agent is skipped while the Monitor page is
    // unchanged, but never when the page is a bot wall or a near-empty shell
    // (those stay "unchanged" while the real record changes behind them), and
    // never more than MAX_AGENT_SKIPS runs in a row.
    const skips = watch.agent_skips ?? 0;
    const pageUsable = !!page?.text && page.text.length >= MIN_USABLE_PAGE_CHARS && !looksBlocked(page.text);
    const unchangedUnreadable =
      !parsed &&
      adapter.curated === false &&
      pageUsable &&
      hash !== null &&
      hash === watch.last_stable_hash &&
      watch.last_unreadable_at === null &&
      skips < MAX_AGENT_SKIPS;
    // Escalation when the Monitor page did not parse: a whole-page Fetch first
    // (free; the default extraction can drop record tables), then the Agent.
    // A bot wall skips the Fetch step, since it would show the same wall.
    const blockedPage = !!page?.text && !!looksBlocked(page.text);
    if (!parsed && !unchangedUnreadable && (!blockedPage || this.opts.agentEscalation)) {
      const id = watch.identifier ? adapter.normalizeIdentifier(watch.identifier) : null;
      const r = await readRecord(
        adapter,
        { gw, checks: [], warnings: [], now: this.now },
        { id, url: watch.record_url, nameHint: watch.subject_name },
        { skipFetch: blockedPage, skipDefaultFetch: !blockedPage, noAgent: !this.opts.agentEscalation },
      );
      if (r.ok) {
        parsed = r.parsed;
        via = r.via === "tinyfish_agent" ? "tinyfish_monitor+agent" : "tinyfish_monitor+fetch";
        agentRunId = r.runId;
      }
    }

    const processed = [...watch.processed_run_ids, payload.run_id].filter(Boolean).slice(-200);
    const events: ChangeEvent[] = [];
    const mk = (c: Omit<ChangeEvent, "id" | "watch_id" | "monitor_id" | "monitor_run_id" | "detected_at" | "source_url" | "read_via" | "record">, record: VerifiedRecord | null): ChangeEvent => ({
      id: randomUUID(),
      watch_id: watch.id,
      monitor_id: watch.monitor_id,
      monitor_run_id: payload.run_id,
      detected_at: now.toISOString(),
      source_url: watch.record_url,
      read_via: via ?? "tinyfish_monitor",
      record,
      ...c,
    });

    if (unchangedUnreadable) {
      await this.opts.store.saveWatch({ ...watch, processed_run_ids: processed, last_checked_at: now.toISOString(), agent_skips: skips + 1 });
      return { watch_id: watch.id, ignored: null, events: [], record: watch.latest, read_via: "tinyfish_monitor", tinyfish_calls: gw.calls };
    }

    if (!parsed) {
      if (!watch.last_unreadable_at) {
        events.push(
          mk(
            {
              type: "record_unreadable",
              severity: "warning",
              field: "source",
              before: null,
              after: payload.errors[0]?.error ?? null,
              message: `Could not read the ${adapter.name} record for ${watch.subject_name ?? watch.identifier ?? "this watch"}. The last known status is unchanged until a check succeeds.`,
            },
            null,
          ),
        );
      }
      await this.opts.store.saveWatch({
        ...watch,
        processed_run_ids: processed,
        last_checked_at: now.toISOString(),
        last_unreadable_at: watch.last_unreadable_at ?? now.toISOString(),
      });
      await this.opts.store.addEvents(events);
      await this.deliver(watch, events);
      return { watch_id: watch.id, ignored: null, events, record: null, read_via: via, tinyfish_calls: gw.calls };
    }

    const next = refreshRecord(
      watch.latest,
      parsed,
      watch.record_url,
      via === "tinyfish_monitor" ? "tinyfish_monitor" : "tinyfish_agent",
      page?.text ?? null,
      agentRunId,
      now,
    );
    const byMethod = watch.latest_by_extraction ?? { [watch.latest.source.extraction]: watch.latest };
    const sameMethodPrev = byMethod[next.source.extraction] ?? null;
    for (const c of diffRecords(watch.latest, next, { sameMethodPrev })) events.push(mk(c, next));
    if (watch.last_unreadable_at) {
      events.push(
        mk(
          { type: "record_recovered", severity: "info", field: "source", before: watch.last_unreadable_at, after: now.toISOString(), message: `The ${adapter.name} record is readable again.` },
          next,
        ),
      );
    }

    await this.opts.store.saveWatch({
      ...watch,
      latest: next,
      last_checked_at: now.toISOString(),
      last_unreadable_at: null,
      last_stable_hash: hash ?? watch.last_stable_hash,
      processed_run_ids: processed,
      latest_by_extraction: { ...byMethod, [next.source.extraction]: next },
      agent_skips: via === "tinyfish_monitor+agent" ? 0 : skips,
    });
    await this.opts.store.addEvents(events);
    await this.deliver(watch, events);
    return { watch_id: watch.id, ignored: null, events, record: next, read_via: via, tinyfish_calls: gw.calls };
  }

  private async deliver(watch: Watch, events: ChangeEvent[]): Promise<void> {
    if (!watch.callback_url || events.length === 0) return;
    try {
      await this.forward(watch.callback_url, { schema_version: "tinyverify.v1", watch_id: watch.id, events });
    } catch (err) {
      this.log(`callback to ${watch.callback_url} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
