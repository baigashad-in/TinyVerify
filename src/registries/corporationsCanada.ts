import type { ComplianceFlag, FetchedPage, NormalizedStatus } from "../types.js";
import { toIsoDate } from "../util/dates.js";
import { cleanLines, findLabel, headings } from "../util/text.js";
import { emptyRecord, looksBlocked, type ParseOutcome, type RegistryAdapter } from "./types.js";

const BASE = "https://ised-isde.canada.ca/cc/lgcy";

function normalizeStatus(raw: string): NormalizedStatus {
  const s = raw.toLowerCase();
  // "Active - Intent to Dissolve Filed" is still active; the pending dissolution is a flag.
  if (/^\s*active/.test(s)) return "active";
  if (/dissolv/.test(s)) return "dissolved";
  if (/revoked|cancel/.test(s)) return "cancelled";
  if (/inactive|amalgamated|discontinued|continued out/.test(s)) return "inactive";
  if (/^\s*active/.test(s)) return "active";
  return "unknown";
}

const GENERIC_HEADINGS = /federal corporation information|corporations canada|innovation, science|search for a federal|language selection|you are here|menu|registered office|directors|annual filings|corporate history|certificates/i;

export function parseCanadaRecord(page: FetchedPage): ParseOutcome {
  const text = page.text ?? "";
  const lines = cleanLines(text);
  const corpNo = findLabel(lines, ["Corporation number"]);
  const status = findLabel(lines, ["Status"]);
  if (!corpNo || !status) {
    if (/no (corporation|record)s? (was |were )?found|corporation not found|invalid corporation number/i.test(text.slice(0, 4000))) {
      return { ok: false, reason: "Federal corporation not found", notFound: true };
    }
    const blocked = looksBlocked(text);
    return { ok: false, reason: blocked ? `blocked: ${blocked}` : "Corporation number or Status label not found", blocked: !!blocked };
  }
  const named = findLabel(lines, ["Corporate name", "Corporation name"]);
  const heading = headings(text).find((h) => !GENERIC_HEADINGS.test(h) && h.length > 2) ?? null;
  const name = named?.value ?? heading;
  const bn = findLabel(lines, ["Business number (BN)", "Business number"]);
  const law = findLabel(lines, ["Governing legislation"]);
  const office = findLabel(lines, ["Registered office address"]);
  const anniversary = findLabel(lines, ["Anniversary date (MM-DD)", "Anniversary date"]);
  const lastMeeting = findLabel(lines, ["Date of last annual meeting"]);
  const filings = findLabel(lines, ["Status of annual filings"]);

  const flags: ComplianceFlag[] = [];
  const intent = lines.find((l) => /notice of intent to dissolve|subject to (administrative )?dissolution/i.test(l));
  if (intent) flags.push({ code: "notice_of_intent_to_dissolve", description: "Corporations Canada has sent a notice of intent to dissolve.", evidence: intent });
  if (/^\s*active\b.*(intent to dissolve|dissolution)/i.test(status.value)) {
    flags.push({ code: "dissolution_pending", description: "The status shows a pending dissolution.", evidence: status.evidence });
  }
  const overdue = lines.find((l) => /not been filed within|annual filings? (are|is) overdue|overdue annual/i.test(l));
  if (overdue) flags.push({ code: "annual_filings_overdue", description: "At least one annual filing is overdue.", evidence: overdue });
  const noCompliance = lines.find((l) => /certificate of compliance cannot be (obtained|issued)/i.test(l));
  if (noCompliance && !overdue) flags.push({ code: "no_certificate_of_compliance", description: "A Certificate of Compliance cannot be issued.", evidence: noCompliance });

  const digits = corpNo.value.replace(/\D/g, "");
  const identifiers: Record<string, string> = { corporation_number: corpNo.value.trim() };
  if (bn) identifiers.business_number = bn.value.trim();

  const record = emptyRecord({
    name,
    identifier: digits || corpNo.value,
    identifiers,
    status_raw: status.value,
    status: normalizeStatus(status.value),
    status_effective_date: toIsoDate(status.value, "DMY"),
    issue_date: toIsoDate(law?.value ?? null, "DMY"),
    expiry_note: "Federal corporations do not expire; they must file annual returns to stay in good standing.",
    disciplinary_note: "Corporations Canada does not publish disciplinary actions. Compliance alerts are reported in compliance_flags.",
    compliance_flags: flags,
    details: {
      governing_legislation: law?.value ?? null,
      registered_office_address: office?.value ?? null,
      anniversary_date: anniversary?.value ?? null,
      date_of_last_annual_meeting: toIsoDate(lastMeeting?.value ?? null, "DMY"),
      status_of_annual_filings: filings?.value ?? null,
    },
    evidence: [status.evidence, corpNo.evidence, ...flags.map((f) => f.evidence)],
  });
  return { ok: true, record };
}

export const corporationsCanada: RegistryAdapter = {
  id: "ca-corporations-canada",
  name: "Federal Corporation Information (Corporations Canada)",
  authority: "Corporations Canada, Innovation, Science and Economic Development Canada",
  country: "CA",
  region: null,
  jurisdictions: ["CA"],
  recordTypes: ["business_registration"],
  entityKinds: ["business"],
  officialDomains: ["ised-isde.canada.ca"],
  identifierLabel: "Corporation number",
  identifierExample: "123456-7 (7 or 8 digits)",
  dateOrder: "DMY",
  notes: [
    "Federal corporations only (CBCA, Not-for-profit Act, cooperatives, boards of trade).",
    "Companies incorporated only in a province are in that province's registry and will not be found here.",
  ],
  agent: { stealth: false, proxyCountry: "CA" },
  normalizeIdentifier(raw) {
    const s = raw.replace(/\D/g, "");
    return /^\d{6,8}$/.test(s) ? s : null;
  },
  recordUrl: (id) => `${BASE}/fdrlCrpDtls.html?corpId=${id}`,
  search: {
    mode: "agent",
    url: `${BASE}/fdrlCrpSrch.html`,
    agentInstructions: () =>
      "Search by corporation name. Include active and inactive corporations if the form offers a status filter. Return the corporation number (format 123456-7) as the identifier.",
  },
  parseRecord: parseCanadaRecord,
  normalizeStatus,
  monitorPurpose: (r) =>
    `Alert when the status of federal corporation ${r.subject.name ?? ""} (${r.licence_number ?? ""}) changes from "${r.status.raw}", for example to Dissolved or Inactive, or when a notice of intent to dissolve or an overdue annual filing alert appears.`,
};
