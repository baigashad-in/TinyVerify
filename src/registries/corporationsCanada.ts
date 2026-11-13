import type { ComplianceFlag, FetchedPage, NormalizedStatus } from "../types.js";
import { toIsoDate } from "../util/dates.js";
import { cleanLines, findLabel, headings } from "../util/text.js";
import { emptyRecord, looksBlocked, type ParseOutcome, type RegistryAdapter, type SearchCandidate, type SearchParse } from "./types.js";

const BASE = "https://ised-isde.canada.ca/cc/lgcy";

/** The search form submits as a GET, so the result list has its own URL (live dump, 12 Nov 2026). */
export function canadaSearchUrl(name: string): string {
  return `${BASE}/fdrlCrpSrch.html?p=0&crpNm=${encodeURIComponent(name)}&crpNmbr=&bsNmbr=&cProv=&cStatus=&cAct=`;
}

const RESULTS_FOUND = /(\d[\d,]*)\s+results?\s+(?:were|was)\s+found/i;

/**
 * Two live layouts of the same list (12 Nov 2026):
 *   main content:  "1.Canadian National Railway Company" / French name /
 *                  "Status: Active" / "Corporation number: 010533-3"
 *   whole page:    "1." / name / French name / "Status:" / "Active" /
 *                  "Corporation number: 010533-3"
 * Items are split on the "N." marker and read with the label finder, so
 * both shapes give the same candidates.
 */
export function parseCanadaSearch(page: FetchedPage): SearchParse {
  const text = page.text ?? "";
  const lines = cleanLines(text);
  const foundIdx = lines.findIndex((l) => RESULTS_FOUND.test(l));
  const total = foundIdx >= 0 ? Number((RESULTS_FOUND.exec(lines[foundIdx] ?? "")?.[1] ?? "").replace(/,/g, "")) : null;
  // "No results" is only believed when no result item could be read.
  const noneText = /no (corporations?|results?|records?) (were |was )?found/i.exec(text.slice(0, 6000));
  if (foundIdx < 0) {
    if (noneText) return { kind: "no_results", evidence: noneText[0] };
    const blocked = looksBlocked(text);
    return { kind: "unparsed", reason: blocked ? `blocked: ${blocked}` : 'no "results were found" line on the search page' };
  }
  let end = lines.findIndex((l, i) => i > foundIdx && /^(Date Modified|About government|Report a problem)/i.test(l));
  if (end < 0) end = lines.length;
  const starts: { idx: number; rest: string }[] = [];
  for (let i = foundIdx + 1; i < end; i++) {
    const m = /^(\d{1,4})\.\s*(.*)$/.exec(lines[i] ?? "");
    if (m) starts.push({ idx: i, rest: (m[2] ?? "").trim() });
  }
  const candidates: SearchCandidate[] = [];
  starts.forEach((st, k) => {
    const to = starts[k + 1]?.idx ?? end;
    const nameIdx = st.rest ? st.idx : st.idx + 1;
    const name = st.rest || (lines[nameIdx] ?? "");
    const corp = findLabel(lines, ["Corporation number"], { from: st.idx, to });
    if (!corp || !name || /^(Status|Corporation number|Business Number)\b/i.test(name)) return;
    const status = findLabel(lines, ["Status"], { from: st.idx, to });
    const other = lines[nameIdx + 1];
    const digits = corp.value.replace(/\D/g, "");
    candidates.push({
      name,
      identifier: corp.value.trim(),
      status_raw: status?.value ?? null,
      record_url: /^\d{6,8}$/.test(digits) ? `${BASE}/fdrlCrpDtls.html?corpId=${digits}` : null,
      location: null,
      matched_previous_name: false,
      snippet: other && !/:/.test(other) && !/^Status\b/i.test(other) ? `Also: ${other}` : null,
    });
  });
  if (candidates.length > 0) return { kind: "results", candidates, total };
  if (total === 0 || noneText) return { kind: "no_results", evidence: total === 0 ? (lines[foundIdx] ?? "0 results") : (noneText?.[0] ?? "no results") };
  return { kind: "unparsed", reason: "result list found but no item had a corporation number" };
}

/**
 * "Status of annual filings" is followed by a link ("File an annual return")
 * and then one row per year: "2025 - Overdue" or "2025 -" / "Filed".
 */
function annualFilingRows(lines: string[]): { year: string; state: string; evidence: string }[] {
  const at = lines.findIndex((l) => /^Status of annual filings\s*:?/i.test(l));
  if (at < 0) return [];
  const rows: { year: string; state: string; evidence: string }[] = [];
  for (let i = at + 1; i < Math.min(lines.length, at + 40); i++) {
    const line = lines[i] ?? "";
    const m = /^((?:19|20)\d{2})\s*-\s*(.*)$/.exec(line);
    if (!m) {
      if (rows.length > 0) break;
      continue;
    }
    let state = (m[2] ?? "").trim();
    let evidence = line;
    if (!state && lines[i + 1] && !/^(?:19|20)\d{2}\s*-/.test(lines[i + 1] ?? "")) {
      state = (lines[i + 1] ?? "").trim();
      evidence = `${line} ${state}`;
      i++;
    }
    rows.push({ year: m[1] ?? "", state, evidence });
  }
  return rows;
}

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

/**
 * The address runs over several lines and ends at the "Update registered
 * office address" link. Main-content Fetch drops the "Registered office
 * address" label (live dump, 12 Nov 2026), so then the lines just before the
 * link are read, stopping at the certificate links above them.
 */
function officeAddress(lines: string[]): { value: string } | null {
  const hit = findLabel(lines, ["Registered office address"]);
  if (!hit) {
    const link = lines.findIndex((l) => /^Update registered office address$/i.test(l));
    if (link < 0) return null;
    const parts: string[] = [];
    for (let i = link - 1; i >= Math.max(0, link - 5); i--) {
      const l = lines[i] ?? "";
      if (/^(Get a Certificate|Certificate of|There is a|Note:|Order |Corporate profile|Copies of)/i.test(l) || l.length > 80) break;
      parts.unshift(l);
    }
    return parts.length ? { value: parts.join(", ") } : null;
  }
  const parts: string[] = [];
  for (let i = hit.index + 1; i < Math.min(lines.length, hit.index + 6); i++) {
    const l = lines[i] ?? "";
    if (/^(Update registered office address|Registered office address|Directors|The registered office is)/i.test(l)) break;
    parts.push(l);
  }
  return parts.length ? { value: parts.join(", ") } : { value: hit.value };
}

export function parseCanadaRecord(page: FetchedPage): ParseOutcome {
  const text = page.text ?? "";
  const lines = cleanLines(text);
  // A result list also shows "Status:" and "Corporation number:" (for its
  // first item), so it must not be read as one corporation's record.
  if (lines.some((l) => RESULTS_FOUND.test(l)) || /^#{1,3}\s*Search Results\s*$/im.test(text)) {
    return { ok: false, reason: "page is a search result list, not a corporation record" };
  }
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
  const office = officeAddress(lines);
  const anniversary = findLabel(lines, ["Anniversary date (MM-DD)", "Anniversary date"]);
  const lastMeeting = findLabel(lines, ["Date of last annual meeting"]);

  // Flags come from this record's own fields only. Every record page also
  // carries the text of the "Annual filings overdue" alerts ("At least one
  // annual filings has not been filed ...", "... notice of its intent to
  // dissolve ..."), compliant or not: a live dump of Canadian National Railway,
  // whose 2024-2026 filings are all "Filed", has both. v6 read that text as a
  // flag, which was a false alert.
  const flags: ComplianceFlag[] = [];
  // "Active - Intent to Dissolve Filed" is the corporation's own filing;
  // "dissolution pending" is Corporations Canada acting on non-compliance.
  if (/^\s*active\b.*intent to dissolve/i.test(status.value)) {
    flags.push({ code: "intent_to_dissolve_filed", description: "The corporation has filed a statement of intent to dissolve.", evidence: status.evidence });
  } else if (/^\s*active\b.*dissolution/i.test(status.value)) {
    flags.push({ code: "dissolution_pending", description: "The status shows a pending dissolution.", evidence: status.evidence });
  }
  const yearRows = annualFilingRows(lines);
  const overdueRows = yearRows.filter((r) => /overdue|not filed/i.test(r.state));
  if (overdueRows.length > 0) {
    const years = overdueRows.map((r) => r.year).join(", ");
    flags.push({
      code: "annual_filings_overdue",
      description:
        overdueRows.length >= 2
          ? `Annual filings overdue for ${years}. Corporations Canada says two consecutive overdue filings lead to a notice of intent to dissolve.`
          : `Annual filing overdue for ${years}.`,
      evidence: overdueRows.map((r) => r.evidence).join("; "),
    });
  }

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
      // The value right after the label is a link ("File an annual return"), so the year rows are reported instead.
      status_of_annual_filings: yearRows.length ? yearRows.map((r) => `${r.year} ${r.state || "?"}`).join("; ") : null,
    },
    evidence: [...new Set([status.evidence, corpNo.evidence, ...flags.map((f) => f.evidence)])],
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
    mode: "fetch",
    url: (q) => canadaSearchUrl(q),
    parse: parseCanadaSearch,
    // The GET search covers every status (cStatus is empty), so an empty list is an answer.
    noResultsIsConclusive: true,
    agentFallbackUrl: `${BASE}/fdrlCrpSrch.html`,
    agentInstructions: () =>
      "Search by corporation name. Include active and inactive corporations if the form offers a status filter. Return the corporation number (format 123456-7) as the identifier.",
  },
  parseRecord: parseCanadaRecord,
  normalizeStatus,
  monitorPurpose: (r) =>
    `Alert when the status of federal corporation ${r.subject.name ?? ""} (${r.licence_number ?? ""}) changes from "${r.status.raw}", for example to Dissolved or Inactive, or when a notice of intent to dissolve or an overdue annual filing alert appears.`,
};
