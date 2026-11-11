import type { ComplianceFlag, DisciplinaryAction, DisciplinaryKind, FetchedPage, NormalizedStatus } from "../types.js";
import { allIsoDates, toIsoDate } from "../util/dates.js";
import { cleanLines, findLabel, headings, indexOfLine } from "../util/text.js";
import { emptyRecord, looksBlocked, type ParseOutcome, type RegistryAdapter } from "./types.js";

const BASE = "https://www.gmc-uk.org";

/** GMC status phrases, longest first so the most specific one wins. */
const STATUS_PHRASES = [
  "Provisionally registered with a licence to practise",
  "Provisionally registered without a licence to practise",
  "Registered with a licence to practise",
  "Registered without a licence to practise",
  "Not registered - Erased after Fitness to Practise panel hearing",
  "Not registered - Administrative reason",
  "Not registered - Relinquished",
  "Not registered - Deceased",
  "Suspended",
  "Erased",
  "Not registered",
  "Relinquished",
];

function normalizeStatus(raw: string): NormalizedStatus {
  const s = raw.toLowerCase();
  if (/erased|erasure/.test(s)) return "revoked";
  if (/suspend/.test(s)) return "suspended";
  if (/registered with a licence to practise/.test(s) && !/not registered/.test(s)) return "active";
  if (/registered without a licence|relinquish/.test(s) && !/not registered/.test(s)) return "inactive";
  if (/not registered|deceased/.test(s)) return "not_registered";
  return "unknown";
}

const FTP_KINDS: [RegExp, DisciplinaryKind][] = [
  [/\berasure\b|\berased\b/i, "erasure"],
  [/\bsuspension\b|\bsuspended\b/i, "suspension"],
  [/\binterim order\b|\binterim (conditions|suspension)\b/i, "interim_order"],
  [/\bconditions?\b/i, "conditions"],
  [/\bundertakings?\b/i, "undertakings"],
  [/\bwarnings?\b/i, "warning"],
];

/** Lines that mention sanctions but are GMC boilerplate, not a sanction. */
const FTP_BOILERPLATE = /(no (current )?(conditions|undertakings|warnings)|has no|there (are|is) no|not subject to|find out more|what (this|these) means?|guidance|view details|employment check|designated body|revalidation)/i;

function parseFitnessToPractise(lines: string[], from: number, to: number): DisciplinaryAction[] {
  const out: DisciplinaryAction[] = [];
  for (let i = from; i < to; i++) {
    const line = lines[i] ?? "";
    if (FTP_BOILERPLATE.test(line)) continue;
    if (/^(fitness to practise|restriction|sanction|start|end|from|to|type)\b/i.test(line) && !line.includes(" | ")) continue;
    const kind = FTP_KINDS.find(([re]) => re.test(line))?.[1];
    if (!kind) continue;
    // A table row holds its own dates. Outside a table the dates may sit on the
    // next line, but only if that line is not another entry or a hearing note.
    const next = lines[i + 1] ?? "";
    const nextIsDatesOnly =
      !line.includes(" | ") && !next.includes(" | ") && !FTP_KINDS.some(([re]) => re.test(next)) && !/tribunal|hearing|panel|concluded/i.test(next);
    const dates = allIsoDates(nextIsDatesOnly ? `${line} ${next}` : line, "DMY");
    const start = dates[0] ?? null;
    const endRaw = dates[1] ?? null;
    out.push({
      kind,
      description: line,
      start_date: start,
      end_date: endRaw && start && endRaw < start ? null : endRaw,
      evidence: line,
    });
  }
  return out;
}

export function parseGmcRecord(page: FetchedPage): ParseOutcome {
  const text = page.text ?? "";
  const lines = cleanLines(text);
  const refMatch = /(\d{7})\s*GMC reference number|GMC reference number\s*:?\s*(\d{7})/i.exec(text);
  const historyIdx = indexOfLine(lines, /registration and licensing history|registrant history/i);
  const topEnd = historyIdx >= 0 ? historyIdx : lines.length;
  // The section heading only ("Fitness to practise", "Fitness to practise history"),
  // not sentences that mention it, such as the status line of an erased doctor.
  const ftpIdx = indexOfLine(lines, /^fitness to practise(\s+(history|information|sanctions|restrictions|details))?\s*:?$/i);

  // Status: an explicit label first, then the first status phrase in the top part of the page.
  let statusRaw: string | null = null;
  let statusEvidence: string | null = null;
  const labelled = findLabel(lines, ["Registration status", "Status"], { to: topEnd });
  if (labelled && STATUS_PHRASES.some((p) => labelled.value.toLowerCase().includes(p.toLowerCase()))) {
    statusRaw = labelled.value;
    statusEvidence = labelled.evidence;
  }
  if (!statusRaw) {
    // Start near the reference number so site navigation text is skipped.
    const refLine = indexOfLine(lines, /GMC reference number/i);
    for (let i = Math.max(0, refLine - 3); i < topEnd && !statusRaw; i++) {
      const line = lines[i] ?? "";
      if (/history|from .* to/i.test(line)) continue;
      const phrase = STATUS_PHRASES.find((p) => line.toLowerCase().includes(p.toLowerCase()));
      if (phrase) {
        statusRaw = line.length <= 140 ? line : phrase;
        statusEvidence = line;
      }
    }
  }
  if (!statusRaw || !refMatch) {
    if (/no (results|registrants?) (found|match)|we could not find/i.test(text)) {
      return { ok: false, reason: "GMC record not found", notFound: true };
    }
    const blocked = looksBlocked(text);
    return {
      ok: false,
      reason: blocked ? `blocked: ${blocked}` : !refMatch ? "GMC reference number not found on page" : "GMC status not found on page",
      blocked: !!blocked,
    };
  }

  const ref = refMatch[1] ?? refMatch[2] ?? null;
  const heading = headings(text).find((h) => !/gmc|register|search|general medical council/i.test(h)) ?? null;
  const nameLine = lines.find((l) => /\b(Doctor|Physician associate|Anaesthesia associate)\s*$/.test(l) && l.length < 120);
  const name = heading ?? (nameLine ? nameLine.replace(/\s*(Doctor|Physician associate|Anaesthesia associate)\s*$/, "").trim() : null) ?? page.title;

  const fee = findLabel(lines, ["Annual retention fee due date"]);
  const searchedOn = /Results of search on\s*:?\s*([^\n]+)/i.exec(text);
  const fullReg = findLabel(lines, ["Full registration date"]);
  const provReg = findLabel(lines, ["Provisional registration date"]);
  const gp = lines.find((l) => /this doctor is (not )?on the gp register/i.test(l)) ?? null;
  const specialist = lines.find((l) => /this doctor is (not )?on the specialist register/i.test(l)) ?? null;

  const ftpFrom = ftpIdx >= 0 ? ftpIdx + 1 : topEnd;
  const ftpTo = ftpIdx >= 0 && historyIdx > ftpIdx ? historyIdx : ftpIdx >= 0 ? Math.min(lines.length, ftpIdx + 40) : topEnd;
  const actions = ftpIdx >= 0 ? parseFitnessToPractise(lines, ftpFrom, ftpTo) : [];
  // Current restrictions are sometimes stated in the summary instead of a table.
  for (const line of lines.slice(0, topEnd)) {
    if (/this (doctor|registrant) has (conditions|undertakings|a warning)/i.test(line) && !actions.some((a) => a.evidence === line)) {
      const kind: DisciplinaryKind = /undertaking/i.test(line) ? "undertakings" : /warning/i.test(line) ? "warning" : "conditions";
      actions.push({ kind, description: line, start_date: null, end_date: null, evidence: line });
    }
  }

  const flags: ComplianceFlag[] = [];
  if (/provisionally/i.test(statusRaw)) {
    flags.push({ code: "provisional_registration", description: "Provisional registration (training posts only).", evidence: statusEvidence ?? statusRaw });
  }

  const record = emptyRecord({
    name,
    identifier: ref,
    identifiers: ref ? { gmc_reference_number: ref } : {},
    status_raw: statusRaw,
    status: normalizeStatus(statusRaw),
    issue_date: toIsoDate(fullReg?.value ?? provReg?.value ?? null, "DMY"),
    renewal_due_date: toIsoDate(fee?.value ?? null, "DMY"),
    expiry_note: "GMC registration has no expiry date. renewal_due_date is the annual retention fee due date.",
    disciplinary_actions: actions,
    disciplinary_note: actions.length === 0 ? "No fitness to practise sanctions or restrictions shown on the GMC record." : null,
    compliance_flags: flags,
    details: {
      gp_register: gp,
      specialist_register: specialist,
      full_registration_date: toIsoDate(fullReg?.value ?? null, "DMY"),
      provisional_registration_date: toIsoDate(provReg?.value ?? null, "DMY"),
    },
    evidence: [statusEvidence, refMatch[0], fee?.evidence, ...actions.map((a) => a.evidence)].filter((e): e is string => !!e),
    registry_timestamp: searchedOn?.[1]?.trim() ?? null,
  });
  return { ok: true, record };
}

export const gmc: RegistryAdapter = {
  id: "uk-gmc",
  name: "GMC medical register (doctors, PAs and AAs)",
  authority: "General Medical Council, UK statutory regulator",
  country: "GB",
  region: null,
  jurisdictions: ["GB"],
  recordTypes: ["medical_licence"],
  entityKinds: ["person"],
  officialDomains: ["gmc-uk.org"],
  identifierLabel: "GMC reference number",
  identifierExample: "7 digits",
  dateOrder: "DMY",
  notes: ["Doctors, physician associates and anaesthesia associates registered to work in the UK."],
  agent: { stealth: true, proxyCountry: "GB" },
  normalizeIdentifier(raw) {
    const s = raw.replace(/\D/g, "");
    return /^\d{7}$/.test(s) ? s : null;
  },
  recordUrl: (id) => `${BASE}/registrants/${id}`,
  search: {
    mode: "agent",
    url: `${BASE}/registration-and-licensing/our-registers`,
    agentInstructions: () =>
      "Use the register search box ('Please enter a name or GMC reference number'). Search all professions. Return the GMC reference number as the identifier.",
  },
  parseRecord: parseGmcRecord,
  normalizeStatus,
  monitorPurpose: (r) =>
    `Alert when the GMC registration status of ${r.subject.name ?? "this registrant"} (GMC ${r.licence_number ?? ""}) changes from "${r.status.raw}", or when a fitness to practise sanction, condition, undertaking, warning, suspension or erasure is added or removed. Ignore the 'Results of search on' timestamp.`,
};
