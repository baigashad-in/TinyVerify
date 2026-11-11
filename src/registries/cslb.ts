import type { ComplianceFlag, DisciplinaryAction, DisciplinaryKind, FetchedPage, NormalizedStatus } from "../types.js";
import { allIsoDates, toIsoDate } from "../util/dates.js";
import { cleanLines, findLabel, indexOfLine } from "../util/text.js";
import { emptyRecord, looksBlocked, type ParseOutcome, type RegistryAdapter } from "./types.js";

const BASE = "https://www.cslb.ca.gov";

function normalizeStatus(raw: string): NormalizedStatus {
  const s = raw.toLowerCase();
  if (/revoked/.test(s)) return "revoked";
  if (/suspend/.test(s)) return "suspended";
  if (/expired/.test(s)) return "expired";
  if (/cancel/.test(s)) return "cancelled";
  if (/inactive/.test(s)) return "inactive";
  if (/current and active|is active/.test(s)) return "active";
  return "unknown";
}

const ACTION_PATTERNS: [RegExp, DisciplinaryKind][] = [
  [/\brevok(ed|ation)\b/i, "revocation"],
  [/\bsuspen(ded|sion)\b/i, "suspension"],
  [/\bprobation\b/i, "probation"],
  [/\baccusation\b/i, "accusation"],
  [/\bcitation\b/i, "citation"],
  [/\blegal action\b/i, "legal_action"],
  [/\bdisciplinary\b/i, "other"],
];

/** CSLB page boilerplate that mentions complaints or actions without reporting one. */
const BOILERPLATE =
  /(disclaimer|restricted by law|b&p\s*\d|definition of disclosable|are not listed unless|only construction related civil judgments|before relying on this information|you should be aware|click here for|limitations|this license is current and active|all information below should be reviewed)/i;

/** Drop boilerplate sentences from a line and return what is left. */
function withoutBoilerplate(line: string): string {
  return line
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !BOILERPLATE.test(s))
    .join(" ")
    .trim();
}

function findActions(lines: string[], from: number, to: number): DisciplinaryAction[] {
  const out: DisciplinaryAction[] = [];
  for (let i = from; i < to; i++) {
    const line = lines[i] ?? "";
    const text = withoutBoilerplate(line);
    if (!text) continue;
    const kind = ACTION_PATTERNS.find(([re]) => re.test(text))?.[1];
    if (!kind) continue;
    const dates = allIsoDates(text, "MDY");
    out.push({ kind, description: text, start_date: dates[0] ?? null, end_date: dates[1] ?? null, evidence: line });
  }
  return out;
}

/** Street words that mark where an address starts when name and address share one line. */
const STREET = /\s+\d{1,6}\s+[A-Z0-9 .'-]*?\b(ST|STREET|AVE|AVENUE|RD|ROAD|BLVD|BOULEVARD|DR|DRIVE|WAY|LN|LANE|CT|COURT|PL|PLACE|HWY|HIGHWAY|PKWY|PARKWAY|CIR|CIRCLE|SUITE|STE|UNIT)\b.*$/i;

/**
 * The business name from the "Business Information" cell. Cells with <br>
 * come as "NAME / 123 MAIN ST / CITY, CA 90000"; the name is the first part.
 * Only when there is no separator is the address cut off, and only at a
 * street word, so names like "A 1 PLUMBING" stay whole.
 */
function businessName(value: string): string {
  const first = (value.split(" / ")[0] ?? value).trim();
  if (value.includes(" / ")) return first;
  return first.replace(STREET, "").replace(/\s+[A-Z .'-]+,\s*CA\s+\d{5}(-\d{4})?.*$/i, "").trim() || first;
}

export function parseCslbRecord(page: FetchedPage): ParseOutcome {
  const text = page.text ?? "";
  const lines = cleanLines(text);
  const numMatch = /License Detail for License\s*#?\s*(\d{1,8})|License Number\s*:?\s*(\d{1,8})/i.exec(text);
  const status = findLabel(lines, ["License Status"]);
  if (!status || !numMatch) {
    if (/no (records|license) (were )?found|not a valid license number|no data returned/i.test(text)) {
      return { ok: false, reason: "CSLB license not found", notFound: true };
    }
    // CSLB redirects plain requests to its search form; treat that as unreadable, not as no match.
    const blocked = looksBlocked(text);
    return {
      ok: false,
      reason: blocked ? `blocked: ${blocked}` : "CSLB license detail labels not found (the site may have shown its search form instead)",
      blocked: !!blocked,
    };
  }
  const licNum = numMatch[1] ?? numMatch[2] ?? null;
  const business = findLabel(lines, ["Business Information"]);
  const name = business ? businessName(business.value) : null;
  const entity = findLabel(lines, ["Entity"]);
  const issue = findLabel(lines, ["Issue Date"]);
  const reissue = findLabel(lines, ["Reissue Date"]);
  const expire = findLabel(lines, ["Expire Date", "Expiration Date"]);
  const classes = findLabel(lines, ["Classifications", "Classification"]);
  const asOf = /Data current as of\s*:?\s*([0-9/]+\s+[0-9:]+\s*(?:AM|PM)?)/i.exec(text);
  const wcIdx = indexOfLine(lines, /^Workers'? Compensation/i);
  const wcLine = wcIdx >= 0 ? (lines.slice(wcIdx, wcIdx + 4).find((l) => /workers'? comp|exempt|policy/i.test(l) && !/^Workers'? Compensation$/i.test(l)) ?? null) : null;
  const bondIdx = indexOfLine(lines, /^Bonding Information/i);

  // Scan the record body only: from the status label to the page footer.
  const footer = indexOfLine(lines, /back to top|conditions of use|online services quick hits|copyright ©/i, status.index);
  const end = footer > status.index ? footer : lines.length;
  // The first sentence is the current status. Later sentences are history or
  // extra notices ("was suspended on ...") and must not override it.
  // The status cell itself can hold several sentences ("current and active. / was
  // suspended on ..."). Only the first is the current status.
  const statusParts = status.value
    .split(/\s+\/\s+|(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const statusRaw = statusParts[0] ?? status.value;
  const additionalStatus = [
    ...statusParts.slice(1),
    ...lines
      .slice(status.index + (status.evidence.includes(" | ") ? 1 : 2), Math.min(end, status.index + 6))
      .filter((l) => /this license|license (is|was|has)/i.test(l)),
  ].filter((l) => !BOILERPLATE.test(l));
  const actions = findActions(lines, status.index, end);

  const flags: ComplianceFlag[] = [];
  if (wcLine && /exempt/i.test(wcLine)) {
    flags.push({ code: "workers_comp_exempt", description: "Licensee declared no employees (exempt from workers' compensation).", evidence: wcLine });
  }
  const bondLapse = lines.slice(status.index, end).find((l) => /bond (has been )?(cancel|suspend|expired)|no bond/i.test(l));
  if (bondLapse) flags.push({ code: "bond_problem", description: "Contractor bond shown as cancelled, expired or missing.", evidence: bondLapse });

  const record = emptyRecord({
    name,
    identifier: licNum,
    identifiers: licNum ? { cslb_license_number: licNum } : {},
    status_raw: statusRaw,
    status: normalizeStatus(statusRaw),
    issue_date: toIsoDate(issue?.value ?? null, "MDY"),
    expiry_date: toIsoDate(expire?.value ?? null, "MDY"),
    disciplinary_actions: actions,
    disciplinary_note:
      actions.length === 0
        ? "No suspension, revocation, citation or legal action is shown on the CSLB record. CSLB discloses complaints only as allowed by B&P 7124.6."
        : null,
    compliance_flags: flags,
    details: {
      additional_status: additionalStatus.length ? additionalStatus : null,
      entity: entity?.value ?? null,
      reissue_date: toIsoDate(reissue?.value ?? null, "MDY"),
      classifications: classes ? classes.value.split(/\s+\/\s+|;\s*/).filter(Boolean) : null,
      workers_compensation: wcLine,
      bonding_information: bondIdx >= 0 ? (lines[bondIdx + 1] ?? null) : null,
    },
    evidence: [status.evidence, issue?.evidence, expire?.evidence, ...actions.map((a) => a.evidence)].filter((e): e is string => !!e),
    registry_timestamp: asOf?.[1]?.trim() ?? null,
  });
  return { ok: true, record };
}

export const cslb: RegistryAdapter = {
  id: "us-ca-cslb",
  name: "CSLB Check a License",
  authority: "Contractors State License Board, State of California",
  country: "US",
  region: "CA",
  jurisdictions: ["US-CA"],
  recordTypes: ["contractor_licence"],
  entityKinds: ["business", "person"],
  officialDomains: ["cslb.ca.gov"],
  identifierLabel: "CSLB license number",
  identifierExample: "up to 8 digits",
  dateOrder: "MDY",
  notes: ["California contractor licences. CSLB's database is offline Sundays 8 p.m. to Mondays 6 a.m. Pacific."],
  agent: { stealth: true, proxyCountry: "US" },
  lastFirstNames: true,
  normalizeIdentifier(raw) {
    const s = raw.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
    return /^\d{1,8}$/.test(s) ? s : null;
  },
  // Short link CSLB itself publishes for each licence; it renders the licence detail page.
  recordUrl: (id) => `${BASE}/${id}`,
  search: {
    mode: "agent",
    url: `${BASE}/OnlineServices/CheckLicenseII/CheckLicense.aspx`,
    agentInstructions: (_q, kind) =>
      kind === "person"
        ? "Use 'Check by Personnel Name' (Last Name and First Name fields). Return the contractor license number as the identifier."
        : "Use 'Check by Business Name'. Type the first 10 to 15 letters of the name without commas or periods. If the name starts with a person's name, CSLB lists it last name first. Return the contractor license number as the identifier.",
  },
  parseRecord: parseCslbRecord,
  normalizeStatus,
  monitorPurpose: (r) =>
    `Alert when CSLB licence ${r.licence_number ?? ""} for ${r.subject.name ?? "this contractor"} is no longer "current and active" (expired, suspended, revoked, inactive), when the expire date changes, when a legal action, citation or suspension is added, or when the bond or workers' compensation lapses. Ignore the 'Data current as of' timestamp.`,
};
