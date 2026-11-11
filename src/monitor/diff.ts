import { z } from "zod";
import { VerifiedRecordSchema, type DisciplinaryAction, type VerifiedRecord } from "../types.js";
import { baseNormalize } from "../util/match.js";

export const ChangeTypeSchema = z.enum([
  "status_changed",
  "status_wording_changed",
  "expiry_changed",
  "renewal_due_changed",
  "identifier_changed",
  "name_changed",
  "disciplinary_added",
  "disciplinary_removed",
  "flag_added",
  "flag_removed",
  "record_unreadable",
  "record_recovered",
]);
export type ChangeType = z.infer<typeof ChangeTypeSchema>;

export const ChangeEventSchema = z.object({
  id: z.string(),
  watch_id: z.string(),
  monitor_id: z.string(),
  monitor_run_id: z.string(),
  detected_at: z.string(),
  type: ChangeTypeSchema,
  severity: z.enum(["critical", "warning", "info"]),
  field: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  message: z.string(),
  source_url: z.string(),
  read_via: z.enum(["tinyfish_monitor", "tinyfish_monitor+agent"]),
  record: VerifiedRecordSchema.nullable(),
});
export type ChangeEvent = z.infer<typeof ChangeEventSchema>;

export type Change = Pick<ChangeEvent, "type" | "severity" | "field" | "before" | "after" | "message">;

/**
 * Key for matching an action between two reads. Agent descriptions are model
 * output and can be worded differently each run, so for Agent reads only the
 * kind and dates are used. Parser descriptions are copied text and stable.
 */
function actionKey(a: DisciplinaryAction, extraction: VerifiedRecord["source"]["extraction"]): string {
  const base = `${a.kind}|${a.start_date ?? ""}|${a.end_date ?? ""}`;
  return extraction === "agent_structured_output" ? base : `${base}|${baseNormalize(a.description).slice(0, 80)}`;
}

/** Count actions per key, so two undated actions of the same kind are not merged into one. */
function countActions(rec: VerifiedRecord): Map<string, { n: number; sample: DisciplinaryAction[] }> {
  const m = new Map<string, { n: number; sample: DisciplinaryAction[] }>();
  for (const a of rec.disciplinary_actions) {
    const k = actionKey(a, rec.source.extraction);
    const e = m.get(k) ?? { n: 0, sample: [] };
    e.n += 1;
    e.sample.push(a);
    m.set(k, e);
  }
  return m;
}

/** Statuses that all mean "no longer exists or operates". Parser and Agent can map the same page to different ones. */
const ENDED = new Set(["inactive", "dissolved", "cancelled"]);

export interface DiffOptions {
  /**
   * The last record read the same way as `next` (parser or Agent). Actions,
   * compliance flags and exact status wording are compared only against it,
   * because the parser and the Agent describe the same page differently.
   * Null means there is no earlier read of that kind, so those fields are not
   * compared on this run.
   */
  sameMethodPrev?: VerifiedRecord | null;
}

/**
 * Compare two structured records field by field. Only fields that matter for
 * compliance are compared; page timestamps and layout changes are ignored,
 * which is why a Monitor "changed" run does not always produce an alert.
 */
export function diffRecords(prev: VerifiedRecord, next: VerifiedRecord, opts: DiffOptions = {}): Change[] {
  const out: Change[] = [];
  const who = next.subject.name ?? prev.subject.name ?? "record";
  const sameMethod = prev.source.extraction === next.source.extraction;
  const peer = sameMethod ? prev : (opts.sameMethodPrev ?? null);
  const crossEnded = !sameMethod && ENDED.has(prev.status.normalized) && ENDED.has(next.status.normalized);

  if (prev.status.normalized !== next.status.normalized && !crossEnded) {
    out.push({
      type: "status_changed",
      severity: next.status.normalized === "active" ? "warning" : "critical",
      field: "status",
      before: prev.status,
      after: next.status,
      message: `${who}: status changed from "${prev.status.raw}" (${prev.status.normalized}) to "${next.status.raw}" (${next.status.normalized}).`,
    });
  } else if (peer && peer.status.normalized === next.status.normalized && baseNormalize(peer.status.raw) !== baseNormalize(next.status.raw)) {
    out.push({
      type: "status_wording_changed",
      severity: "info",
      field: "status.raw",
      before: peer.status.raw,
      after: next.status.raw,
      message: `${who}: status wording changed from "${peer.status.raw}" to "${next.status.raw}" (still ${next.status.normalized}).`,
    });
  }

  // Across read methods a missing date usually means one method did not see
  // it, not that the registry removed it, so only date-to-date changes count.
  const datesComparable = (a: string | null, b: string | null) => sameMethod || (a !== null && b !== null);

  if (prev.expiry_date !== next.expiry_date && datesComparable(prev.expiry_date, next.expiry_date)) {
    const extended = prev.expiry_date && next.expiry_date && next.expiry_date > prev.expiry_date;
    out.push({
      type: "expiry_changed",
      severity: extended ? "info" : "warning",
      field: "expiry_date",
      before: prev.expiry_date,
      after: next.expiry_date,
      message: `${who}: expiry date changed from ${prev.expiry_date ?? "none"} to ${next.expiry_date ?? "none"}${extended ? " (renewed)" : ""}.`,
    });
  }

  if (prev.renewal_due_date !== next.renewal_due_date && datesComparable(prev.renewal_due_date, next.renewal_due_date)) {
    out.push({
      type: "renewal_due_changed",
      severity: "info",
      field: "renewal_due_date",
      before: prev.renewal_due_date,
      after: next.renewal_due_date,
      message: `${who}: renewal due date changed from ${prev.renewal_due_date ?? "none"} to ${next.renewal_due_date ?? "none"}.`,
    });
  }

  if ((prev.licence_number ?? "") !== (next.licence_number ?? "") && next.licence_number) {
    out.push({
      type: "identifier_changed",
      severity: "critical",
      field: "licence_number",
      before: prev.licence_number,
      after: next.licence_number,
      message: `${who}: the record now shows number ${next.licence_number} instead of ${prev.licence_number ?? "none"}.`,
    });
  }

  if (prev.subject.name && next.subject.name && baseNormalize(prev.subject.name) !== baseNormalize(next.subject.name)) {
    out.push({
      type: "name_changed",
      severity: "warning",
      field: "subject.name",
      before: prev.subject.name,
      after: next.subject.name,
      message: `Registered name changed from "${prev.subject.name}" to "${next.subject.name}".`,
    });
  }

  if (!peer) return out;

  const before = countActions(peer);
  const after = countActions(next);
  for (const [k, a] of after) {
    const had = before.get(k)?.n ?? 0;
    for (const x of a.sample.slice(had)) {
      out.push({
        type: "disciplinary_added",
        severity: "critical",
        field: "disciplinary_actions",
        before: null,
        after: x,
        message: `${who}: new ${x.kind.replace(/_/g, " ")} on the record: "${x.description}".`,
      });
    }
  }
  for (const [k, b] of before) {
    const has = after.get(k)?.n ?? 0;
    for (const x of b.sample.slice(has)) {
      out.push({
        type: "disciplinary_removed",
        severity: "info",
        field: "disciplinary_actions",
        before: x,
        after: null,
        message: `${who}: ${x.kind.replace(/_/g, " ")} no longer shown: "${x.description}".`,
      });
    }
  }

  const fBefore = new Map(peer.compliance_flags.map((f) => [f.code, f]));
  const fAfter = new Map(next.compliance_flags.map((f) => [f.code, f]));
  for (const [code, f] of fAfter) {
    if (!fBefore.has(code)) {
      out.push({ type: "flag_added", severity: "warning", field: "compliance_flags", before: null, after: f, message: `${who}: ${f.description}` });
    }
  }
  for (const [code, f] of fBefore) {
    if (!fAfter.has(code)) {
      out.push({ type: "flag_removed", severity: "info", field: "compliance_flags", before: f, after: null, message: `${who}: no longer flagged: ${f.description}` });
    }
  }
  return out;
}
