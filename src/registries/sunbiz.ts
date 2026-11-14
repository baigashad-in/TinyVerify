import type { ComplianceFlag, FetchedPage, NormalizedStatus } from "../types.js";
import { toIsoDate } from "../util/dates.js";
import { cleanLines, findLabel, indexOfLine } from "../util/text.js";
import { emptyRecord, looksBlocked, type ParseOutcome, type RegistryAdapter, type SearchCandidate, type SearchParse } from "./types.js";

const BASE = "https://search.sunbiz.org/Inquiry/CorporationSearch";

/*
 * Sunbiz search by name is an alphabetical list that starts where the name
 * sorts. The sort key ("searchNameOrder") is the name in capitals with spaces
 * and punctuation removed, a leading THE removed, the word OF removed and the
 * legal ending (INC, LLC, CORP...) removed, cut to 30 characters. That rule is
 * inferred from the 20 keys on one live page (12 Nov 2026), for example
 * "THE PUB MAKER LLC" -> PUBMAKER and "PUBLIX TELLER & LOGO OF A HAND
 * INSERTING ..." -> PUBLIXTELLERLOGOAHANDINSERTING. It is not documented, so a
 * list with no close name is confirmed with TinyFish Agent (see browseKey).
 */
const KEY_SUFFIXES = new Set([
  "INC", "INCORPORATED", "CORP", "CORPORATION", "LLC", "CO", "COMPANY", "LTD", "LIMITED",
  "LP", "LLP", "LLLP", "PA", "PL", "PLLC",
]);

export function sunbizNameKey(name: string): string {
  const words = name
    .toUpperCase()
    .replace(/&/g, " ")
    .replace(/[^A-Z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 0 && w !== "OF");
  if (words[0] === "THE" && words.length > 1) words.shift();
  // Dropping an ending keeps the key a prefix of the full name, so a wrong
  // guess here starts the list a little early, not after the entity.
  while (words.length > 1 && KEY_SUFFIXES.has(words[words.length - 1] ?? "")) words.pop();
  return words.join("").slice(0, 30);
}

/** Path part of the search URL. ASP.NET refuses some characters in a path (& : * % ? and a trailing dot). */
function pathTerm(name: string): string {
  return name.replace(/[^A-Za-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

export function sunbizSearchUrl(name: string): string {
  return `${BASE}/SearchResults/EntityName/${encodeURIComponent(pathTerm(name) || name)}/Page1?searchNameOrder=${encodeURIComponent(sunbizNameKey(name))}`;
}

const DOC_NO = /^(?=[A-Z0-9]*\d)[A-Z0-9]{5,12}$/;

/**
 * Rows look like "| PUBLIX SUPER MARKETS, INC. | 112252 | Active |". Main-content
 * Fetch drops the header row; the whole page keeps it. Detail links carry
 * "aggregateId=<kind>-<document number>-<uuid>"; kind "trade" is a trademark,
 * not a business, so those rows are left out.
 */
export function parseSunbizSearch(page: FetchedPage): SearchParse {
  const text = page.text ?? "";
  const byDoc = new Map<string, { url: string; kind: string }>();
  for (const l of page.links ?? []) {
    const m = /[?&]aggregateId=([a-z]+)-([a-z0-9]+)-/i.exec(l);
    if (m && /\/SearchResultDetail\?/i.test(l) && m[2]) byDoc.set(m[2].toUpperCase(), { url: l, kind: (m[1] ?? "").toLowerCase() });
  }
  const candidates: SearchCandidate[] = [];
  for (const line of cleanLines(text)) {
    const cells = line.split(" | ");
    if (cells.length !== 3) continue;
    const [name, doc, status] = cells.map((c) => c.trim()) as [string, string, string];
    if (!DOC_NO.test(doc) || status.length > 24 || name.length < 2) continue;
    const link = byDoc.get(doc);
    if (link?.kind === "trade") continue;
    candidates.push({
      name,
      identifier: doc,
      status_raw: status,
      record_url: link?.url ?? null,
      location: null,
      matched_previous_name: false,
      snippet: `${doc} ${status}`,
    });
  }
  if (candidates.length > 0) return { kind: "results", candidates, total: null };
  const none = /no (matching )?(records|entities) (were )?found|no results/i.exec(text.slice(0, 4000));
  if (none) return { kind: "no_results", evidence: none[0] };
  const blocked = looksBlocked(text);
  return { kind: "unparsed", reason: blocked ? `blocked: ${blocked}` : "no Sunbiz result rows (name | document number | status) found" };
}

/*
 * Whole-page Fetch of a detail page glues each label to its value:
 * "Document Number112252", "StatusACTIVE", "Last EventCORPORATE MERGER"
 * (live dump, 12 Nov 2026). Longer labels come first so "Event Date Filed"
 * is not read as "Date Filed". A value must start with a capital or a digit,
 * so ordinary words such as "Statement" are left alone.
 */
const GLUED_LABELS = [
  "Event Effective Date",
  "Event Date Filed",
  "Document Number",
  "FEI/EIN Number",
  "Effective Date",
  "Date Filed",
  "Last Event",
  "Status",
  "State",
];
const GLUED_RE = new RegExp(`^(${GLUED_LABELS.map((l) => l.replace(/[/]/g, "\\/")).join("|")})(?=[A-Z0-9])(.+)$`);

function unglue(lines: string[]): string[] {
  const start = indexOfLine(lines, /^Filing Information$/i);
  if (start < 0) return lines;
  const out = lines.slice();
  for (let i = start + 1; i < Math.min(out.length, start + 16); i++) {
    const line = out[i] ?? "";
    if (/^(Principal Address|Mailing Address|Registered Agent)/i.test(line)) break;
    const m = GLUED_RE.exec(line);
    if (m) out[i] = `${m[1]}: ${m[2]}`;
  }
  return out;
}

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
  const lines = unglue(cleanLines(text));
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
  notes: [
    "Name searches and record pages are read with TinyFish Fetch; TinyFish Agent (stealth browser) is the fallback and is used for lookups by document number.",
  ],
  agent: { stealth: true, proxyCountry: "US" },
  // Main-content Fetch of a detail page keeps the values but drops the labels
  // (live dump, 12 Nov 2026), so only the whole page is parsed.
  recordFetchModes: ["full"],
  normalizeIdentifier(raw) {
    const s = raw.toUpperCase().replace(/[\s-]/g, "");
    return /^[A-Z0-9]{5,12}$/.test(s) && /\d/.test(s) ? s : null;
  },
  // Sunbiz detail URLs carry an aggregateId that cannot be built from the
  // document number, so there is no URL template. The search list links each
  // row to its detail page, and that link is used. Whether a link stays valid
  // for months is not confirmed; if it stops parsing, Monitor checks fall back
  // to a whole-page Fetch and then an Agent read.
  recordUrl: () => null,
  identifierSearchUrl: `${BASE}/ByDocumentNumber`,
  search: {
    mode: "fetch",
    url: (q) => sunbizSearchUrl(q),
    parse: parseSunbizSearch,
    // An alphabetical list never says "no results", so absence is confirmed with the Agent.
    noResultsIsConclusive: false,
    browseKey: sunbizNameKey,
    agentFallbackUrl: `${BASE}/ByName`,
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
