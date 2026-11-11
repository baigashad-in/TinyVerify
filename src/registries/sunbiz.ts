import type { ComplianceFlag, FetchedPage, NormalizedStatus } from "../types.js";
import { toIsoDate } from "../util/dates.js";
import { cleanLines, findLabel, indexOfLine } from "../util/text.js";
import { emptyRecord, looksBlocked, type ParseOutcome, type RegistryAdapter } from "./types.js";

const BASE = "https://search.sunbiz.org/Inquiry/CorporationSearch";

function normalizeStatusWithEvent(raw: string, lastEvent: string | null): NormalizedStatus {
  const s = raw.toLowerCase().trim();
  const e = (lastEvent ?? "").toLowerCase();
  if (/^active/.test(s)) return "active";
  if (/revoked/.test(s) || /revocation/.test(e)) return "revoked";
  if (/dissolution|dissolved/.test(e) || /dissolved/.test(s)) return "dissolved";
  if (/inact/.test(s)) return "inactive";
  if (/withdrawn|merged|converted|cancel/.test(s) || /withdrawal|merger|conversion/.test(e)) return "inactive";
  return "unknown";
}

export function parseSunbizRecord(page: FetchedPage): ParseOutcome {
  const text = page.text ?? "";
  const lines = cleanLines(text);
  const docNo = findLabel(lines, ["Document Number"]);
  const status = findLabel(lines, ["Status"]);
  if (!docNo || !status) {
    if (/no (records|matching records) (were )?found|entity name not found/i.test(text.slice(0, 3000))) {
      return { ok: false, reason: "Sunbiz record not found", notFound: true };
    }
    const blocked = looksBlocked(text);
    return { ok: false, reason: blocked ? `blocked: ${blocked}` : "Document Number or Status label not found", blocked: !!blocked };
  }
  const detailIdx = indexOfLine(lines, /^Detail by /i);
  const entityType = detailIdx >= 0 ? (lines[detailIdx + 1] ?? null) : null;
  const nameLine = detailIdx >= 0 ? (lines[detailIdx + 2] ?? null) : null;
  const name = nameLine && !/filing information/i.test(nameLine) ? nameLine : (page.title?.replace(/^Detail by .*?-\s*/i, "") ?? null);
  const fei = findLabel(lines, ["FEI/EIN Number"]);
  const filed = findLabel(lines, ["Date Filed"]);
  const state = findLabel(lines, ["State"]);
  const lastEvent = findLabel(lines, ["Last Event"]);
  const eventDate = findLabel(lines, ["Event Date Filed"]);

  // Annual report rows look like "2024 | 03/12/2024".
  const reportYears = lines
    .map((l) => /^(\d{4}) \| (\d{1,2}\/\d{1,2}\/\d{4})$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => Number(m[1]));
  const lastReport = reportYears.length ? Math.max(...reportYears) : null;

  const flags: ComplianceFlag[] = [];
  if (lastEvent && /admin(istrative)? dissolution/i.test(lastEvent.value)) {
    flags.push({ code: "administrative_dissolution", description: "Administratively dissolved (often for a missed annual report).", evidence: lastEvent.evidence });
  }

  const record = emptyRecord({
    name,
    identifier: docNo.value.trim(),
    identifiers: { document_number: docNo.value.trim(), ...(fei && /\d/.test(fei.value) ? { fei_ein: fei.value.trim() } : {}) },
    status_raw: status.value,
    status: normalizeStatusWithEvent(status.value, lastEvent?.value ?? null),
    status_effective_date: lastEvent && !/^active/i.test(status.value) ? toIsoDate(eventDate?.value ?? null, "MDY") : null,
    issue_date: toIsoDate(filed?.value ?? null, "MDY"),
    expiry_note: "Florida entities do not expire; they must file an annual report each year to stay active.",
    disciplinary_note: "The Florida Division of Corporations does not publish disciplinary actions.",
    compliance_flags: flags,
    details: {
      entity_type: entityType,
      state_of_formation: state?.value ?? null,
      last_event: lastEvent?.value ?? null,
      last_event_date: toIsoDate(eventDate?.value ?? null, "MDY"),
      last_annual_report_year: lastReport ? String(lastReport) : null,
    },
    evidence: [status.evidence, docNo.evidence, lastEvent?.evidence].filter((e): e is string => !!e),
  });
  return { ok: true, record };
}

export const sunbiz: RegistryAdapter = {
  id: "us-fl-sunbiz",
  name: "Sunbiz (Florida Division of Corporations)",
  authority: "Florida Department of State, Division of Corporations",
  country: "US",
  region: "FL",
  jurisdictions: ["US-FL"],
  recordTypes: ["business_registration"],
  entityKinds: ["business"],
  officialDomains: ["sunbiz.org"],
  identifierLabel: "Document number",
  identifierExample: "P06000011111",
  dateOrder: "MDY",
  notes: ["Sunbiz sits behind bot protection, so searches and reads use TinyFish Agent with a stealth browser."],
  agent: { stealth: true, proxyCountry: "US" },
  normalizeIdentifier(raw) {
    const s = raw.toUpperCase().replace(/[\s-]/g, "");
    return /^[A-Z0-9]{5,12}$/.test(s) && /\d/.test(s) ? s : null;
  },
  // Sunbiz detail URLs carry an aggregateId that cannot be built from the
  // document number, so there is no URL template. The agent returns the link.
  // Whether that link stays valid for months is not confirmed; if it stops
  // parsing, Monitor checks fall back to an Agent read by document number.
  recordUrl: () => null,
  identifierSearchUrl: `${BASE}/ByDocumentNumber`,
  search: {
    mode: "agent",
    url: `${BASE}/ByName`,
    agentInstructions: () =>
      "Use the Entity Name search. Return the document number as the identifier and the status column as status. record_url must be the detail page link for each result.",
  },
  parseRecord: parseSunbizRecord,
  normalizeStatus: (raw) => normalizeStatusWithEvent(raw, null),
  // Agent reads pass other_fields; "Last Event" turns INACTIVE into dissolved, as the parser does.
  normalizeAgentStatus: (raw, details) => normalizeStatusWithEvent(raw, details.last_event ?? null),
  agentRecordInstructions: "other_fields must include 'Last Event' and 'Event Date Filed' exactly as shown in Filing Information.",
  monitorPurpose: (r) =>
    `Alert when the Sunbiz status of ${r.subject.name ?? "this entity"} (document ${r.licence_number ?? ""}) changes from "${r.status.raw}", for example to INACTIVE after administrative dissolution or revocation, or when a new last event is recorded.`,
};
