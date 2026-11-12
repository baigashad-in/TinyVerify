import type { ComplianceFlag, FetchedPage, NormalizedStatus } from "../types.js";
import { toIsoDate } from "../util/dates.js";
import { cleanLines, findLabel, headings } from "../util/text.js";
import { emptyRecord, looksBlocked, type ParseOutcome, type RegistryAdapter, type SearchCandidate, type SearchParse } from "./types.js";

const BASE = "https://find-and-update.company-information.service.gov.uk";
const COMPANY_NUMBER = /^(?:\d{8}|[A-Z]{2}\d{6}|[A-Z]{2}\d{5}[A-Z])$/;

function normalizeStatus(raw: string): NormalizedStatus {
  const s = raw.toLowerCase();
  if (/dissolved|removed|struck off/.test(s)) return "dissolved";
  if (/liquidation|administration|receiver|insolvency|voluntary arrangement/.test(s)) return "insolvency";
  if (/converted|closed/.test(s)) return "inactive";
  if (/^active|^registered|^open/.test(s.trim())) return "active";
  return "unknown";
}

export function parseCompaniesHouseSearch(page: FetchedPage): SearchParse {
  const text = page.text ?? "";
  if (/no results found|\b0 matches found|did not match any/i.test(text)) {
    return { kind: "no_results", evidence: (/no results found[^\n]*/i.exec(text) ?? ["No results found"])[0] };
  }
  const itemRe = /\[([^\]]+)\]\((?:https?:\/\/find-and-update\.company-information\.service\.gov\.uk(?::443)?)?\/company\/([A-Z0-9]{8})(?:\s+"[^"]*")?\)/g;
  const matches = [...text.matchAll(itemRe)];
  if (matches.length === 0) {
    const plain = parsePlainSearchResults(text, page.links);
    if (plain.length > 0) {
      const totalMatch = /([\d,]+)\s+match(?:es)?\s+found/i.exec(text);
      return { kind: "results", candidates: plain, total: totalMatch ? Number((totalMatch[1] ?? "").replace(/,/g, "")) : null };
    }
    return { kind: "unparsed", reason: "no company links or result lines found on the search page" };
  }

  const candidates: SearchCandidate[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (!m) continue;
    const number = m[2] ?? "";
    if (seen.has(number)) continue;
    seen.add(number);
    const start = (m.index ?? 0) + m[0].length;
    const end = matches[i + 1]?.index ?? Math.min(text.length, start + 600);
    const block = text.slice(start, end);
    const lines = cleanLines(block);
    const statusLine = lines.find((l) => /\b(incorporated on|dissolved on|registered on|removed on)\b/i.test(l)) ?? null;
    const dissolved = statusLine ? /dissolved on|removed on/i.test(statusLine) : false;
    const prevIdx = lines.findIndex((l) => /matching previous names/i.test(l));
    const address = lines.filter((l) => l !== statusLine && !/matching previous names/i.test(l) && l !== lines[prevIdx + 1]).pop() ?? null;
    candidates.push({
      name: (m[1] ?? "").trim(),
      identifier: number,
      status_raw: statusLine ? (dissolved ? "Dissolved" : "Not dissolved (status shown on record page)") : null,
      record_url: `${BASE}/company/${number}`,
      location: address,
      matched_previous_name: prevIdx >= 0,
      snippet: [prevIdx >= 0 ? `Previous name: ${lines[prevIdx + 1] ?? ""}` : null, statusLine].filter(Boolean).join(" ; ") || null,
    });
  }
  const totalMatch = /([\d,]+)\s+match(?:es)?\s+found/i.exec(text);
  return { kind: "results", candidates, total: totalMatch ? Number((totalMatch[1] ?? "").replace(/,/g, "")) : null };
}

/** A result line such as "00445790 - Incorporated on 27 November 1947" or "SC123456 - Dissolved on 1 May 2020". */
const RESULT_META = /^([A-Z]{2}\d{6}|\d{8})\s+-\s+(Incorporated|Dissolved|Registered|Removed|Converted|Closed)\b/i;

/**
 * Fallback for search pages whose Markdown has no links. Seen live on
 * 12 Nov 2026 (npm run dump): the whole-page Markdown shows each result as a
 * heading ("- ### TESCO PLC") followed by "00445790 - Incorporated on ...",
 * while the default main-content Markdown drops the names completely. So a
 * result is accepted only when its name line is a Markdown heading; without
 * one the page is "unparsed" and the caller fetches the whole page or uses
 * the Agent. Taking the line above the number instead gave section titles and
 * addresses as names, which turned a real company into no_match.
 */
const GENERIC_HEADING = /^(company|companies|officer|officers|disqualified officers?|search) results?$|matches found|^search for/i;
const UK_POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/;

function parsePlainSearchResults(text: string, links: string[] | undefined): SearchCandidate[] {
  const raw = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const isHeading = (l: string) => /^(?:(?:[-*+]|\d+[.)])\s+)?#{1,6}\s+\S/.test(l);
  const plain = (l: string) => cleanLines(l)[0] ?? "";
  const linked = links?.length
    ? new Set(links.map((l) => /\/company\/([A-Z0-9]{8})(?:[/?#]|$)/i.exec(l)?.[1]?.toUpperCase()).filter((x): x is string => !!x))
    : null;
  const out: SearchCandidate[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const meta = plain(raw[i] ?? "");
    const m = RESULT_META.exec(meta);
    if (!m) continue;
    const number = (m[1] ?? "").toUpperCase();
    if (seen.has(number) || (linked && linked.size > 0 && !linked.has(number))) continue;
    // Walk back over an optional "Matching previous names:" block to the heading.
    let j = i - 1;
    let previous: string | null = null;
    for (let k = i - 1; k >= Math.max(0, i - 4); k--) {
      if (/^matching previous names:?$/i.test(plain(raw[k] ?? ""))) {
        previous = plain(raw[k + 1] ?? "") || null;
        j = k - 1;
        break;
      }
    }
    const nameLine = raw[j] ?? "";
    if (!isHeading(nameLine)) continue;
    const name = plain(nameLine);
    if (!name || GENERIC_HEADING.test(name) || UK_POSTCODE.test(name) || name.length > 160) continue;
    seen.add(number);
    const dissolved = /dissolved on|removed on/i.test(meta);
    const next = plain(raw[i + 1] ?? "");
    out.push({
      name,
      identifier: number,
      status_raw: dissolved ? "Dissolved" : "Not dissolved (status shown on record page)",
      record_url: `${BASE}/company/${number}`,
      location: next && !RESULT_META.test(next) && !isHeading(raw[i + 1] ?? "") && !/^matching previous names/i.test(next) ? next : null,
      matched_previous_name: previous !== null,
      snippet: [previous ? `Previous name: ${previous}` : null, meta].filter(Boolean).join(" ; ") || null,
    });
  }
  return out;
}

export function parseCompaniesHouseRecord(page: FetchedPage): ParseOutcome {
  const text = page.text ?? "";
  const lines = cleanLines(text);
  const status = findLabel(lines, ["Company status"], { sameLineNoColon: true });
  if (!status) {
    // "Not found" is only trusted when the record labels are missing, so stray
    // wording elsewhere on a real record page cannot turn it into no_match.
    if (/page not found|company not found|cannot find the page/i.test(`${page.title ?? ""}\n${text.slice(0, 2000)}`)) {
      return { ok: false, reason: "Companies House page not found", notFound: true };
    }
    const blocked = looksBlocked(text);
    return { ok: false, reason: blocked ? `blocked: ${blocked}` : "Company status label not found", blocked: !!blocked };
  }

  // Regexes run on cleaned lines so markdown emphasis and links do not get in the way.
  const flat = lines.join("\n");
  const overview = /Company Overview for (.+?) \(([A-Z0-9]{8})\)/.exec(flat);
  const numberMatch = /Company number\s*:?\s*([A-Z0-9]{8})\b/i.exec(flat);
  const number = overview?.[2] ?? numberMatch?.[1] ?? null;
  const titleName = page.title?.replace(/\s+overview\b.*$/i, "").trim() || null;
  const heading = headings(text).find((h) => !/cookies|search|companies house|find and update/i.test(h)) ?? null;
  const name = overview?.[1]?.trim() ?? titleName ?? heading;

  const type = findLabel(lines, ["Company type"], { sameLineNoColon: true });
  const incorporated = findLabel(lines, ["Incorporated on"], { sameLineNoColon: true });
  const dissolved = findLabel(lines, ["Dissolved on"], { sameLineNoColon: true });
  const office = findLabel(lines, ["Registered office address"]);

  const flags: ComplianceFlag[] = [];
  const strikeOff = lines.find((l) => /proposal to strike off|gazette notice for compulsory strike-off|compulsory strike-off/i.test(l));
  if (strikeOff) flags.push({ code: "proposal_to_strike_off", description: "A proposal to strike the company off the register is recorded.", evidence: strikeOff });
  const overdue = lines.find((l) => /\boverdue\b/i.test(l));
  if (overdue) flags.push({ code: "filing_overdue", description: "Accounts or confirmation statement shown as overdue.", evidence: overdue });
  const insolvency = lines.find((l) => /insolvency proceedings|in liquidation|in administration/i.test(l));
  if (insolvency && normalizeStatus(status.value) !== "insolvency") {
    flags.push({ code: "insolvency_notice", description: "Insolvency information is shown for this company.", evidence: insolvency });
  }

  const statusRaw = status.value;
  const record = emptyRecord({
    name,
    identifier: number,
    identifiers: number ? { company_number: number } : {},
    status_raw: statusRaw,
    status: normalizeStatus(statusRaw),
    status_effective_date: dissolved ? toIsoDate(dissolved.value, "DMY") : null,
    issue_date: incorporated ? toIsoDate(incorporated.value, "DMY") : null,
    expiry_note: "UK company registrations do not expire.",
    disciplinary_note:
      "Companies House does not publish disciplinary actions. Strike-off, insolvency and overdue filings are reported in compliance_flags.",
    compliance_flags: flags,
    details: {
      company_type: type?.value ?? null,
      registered_office_address: office?.value ?? null,
      dissolved_on: dissolved ? toIsoDate(dissolved.value, "DMY") : null,
    },
    evidence: [status.evidence, incorporated?.evidence, dissolved?.evidence, numberMatch?.[0]].filter((e): e is string => !!e),
  });
  return { ok: true, record };
}

export const companiesHouse: RegistryAdapter = {
  id: "uk-companies-house",
  name: "Companies House register (Find and update company information)",
  authority: "Companies House, UK Government",
  country: "GB",
  region: null,
  jurisdictions: ["GB"],
  recordTypes: ["business_registration"],
  entityKinds: ["business"],
  officialDomains: ["company-information.service.gov.uk"],
  identifierLabel: "Company number",
  identifierExample: "00445790",
  dateOrder: "DMY",
  notes: ["Covers companies and LLPs registered in England, Wales, Scotland and Northern Ireland."],
  agent: { stealth: false, proxyCountry: "GB" },
  normalizeIdentifier(raw) {
    const s = raw.toUpperCase().replace(/\s+/g, "");
    const padded = /^\d{1,8}$/.test(s) ? s.padStart(8, "0") : s;
    return COMPANY_NUMBER.test(padded) ? padded : null;
  },
  recordUrl: (id) => `${BASE}/company/${id}`,
  search: {
    mode: "fetch",
    url: (q) => `${BASE}/search/companies?q=${encodeURIComponent(q)}`,
    parse: parseCompaniesHouseSearch,
    noResultsIsConclusive: true,
    agentFallbackUrl: `${BASE}/search/companies`,
    agentInstructions: () => "Use the 'Search for a company' box and the Companies tab of the results.",
  },
  parseRecord: parseCompaniesHouseRecord,
  normalizeStatus,
  monitorPurpose: (r) =>
    `Alert when the Companies House status of ${r.subject.name ?? "this company"} (${r.licence_number ?? ""}) changes from "${r.status.raw}", for example to Dissolved, Liquidation, Administration, or Proposal to strike off, or when accounts become overdue. Ignore changes to timestamps and filing lists.`,
};
