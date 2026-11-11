import type { ComplianceFlag, FetchedPage, NormalizedStatus } from "../types.js";
import { toIsoDate } from "../util/dates.js";
import { cleanLines, findLabel } from "../util/text.js";
import { emptyRecord, looksBlocked, type ParseOutcome, type RegistryAdapter, type SearchCandidate, type SearchParse } from "./types.js";

const BASE = "https://abr.business.gov.au";
const WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];

/** ABN check digit test published by the ATO: weighted sum mod 89 must be 0. */
export function isValidAbn(abn: string): boolean {
  if (!/^\d{11}$/.test(abn)) return false;
  const digits = abn.split("").map(Number);
  digits[0] = (digits[0] ?? 0) - 1;
  const sum = digits.reduce((acc, d, i) => acc + d * (WEIGHTS[i] ?? 0), 0);
  return sum % 89 === 0;
}

function normalizeStatus(raw: string): NormalizedStatus {
  const s = raw.toLowerCase();
  if (/^\s*active/.test(s)) return "active";
  if (/cancel/.test(s)) return "cancelled";
  return "unknown";
}

const STATUS_WORDS = /^(active|cancelled|current|historical)$/i;
const NAME_TYPES = /^(entity name|business name|trading name|legal name|other name)$/i;

export function parseAbrSearch(page: FetchedPage): SearchParse {
  const text = page.text ?? "";
  if (/no records? (were )?found|no matching (names|records)|0 records? found|did not return any results/i.test(text)) {
    return { kind: "no_results", evidence: (/no (records?|matching)[^\n]*/i.exec(text) ?? ["No records found"])[0] };
  }
  const rawLines = text.replace(/\r\n?/g, "\n").split("\n");
  const byAbn = new Map<string, SearchCandidate>();
  for (const raw of rawLines) {
    const m = /ABN\/View(?:\?abn=|\/)(\d[\d\s%20]{9,20}\d)/i.exec(raw);
    if (!m) continue;
    const abn = (m[1] ?? "").replace(/\D/g, "");
    if (!isValidAbn(abn)) continue;
    const cells = cleanLines(raw.trim().startsWith("|") ? raw : `| ${raw} |`)[0]?.split(" | ") ?? [];
    // Status may sit in its own cell or next to the ABN link ("88 000 014 675 Active").
    const status = cells.find((c) => STATUS_WORDS.test(c)) ?? /\b(Active|Cancelled)\b/.exec(cells.join(" "))?.[1] ?? null;
    const nameType = cells.find((c) => NAME_TYPES.test(c)) ?? null;
    // The longest remaining cell is the name. Cells that start with an ABN-like
    // digit run ("51 824 753 556 Active") are the ABN column, never the name.
    const name =
      cells
        .filter(
          (c) =>
            /[a-z]/i.test(c) &&
            !STATUS_WORDS.test(c) &&
            !NAME_TYPES.test(c) &&
            !/^\d[\d\s]{8,}/.test(c) &&
            !/^\d[\d\s]*$/.test(c) &&
            !/^[A-Z]{2,3}\s*\d{4}$/.test(c),
        )
        .sort((a, b) => b.length - a.length)[0] ?? null;
    if (!name) continue;
    const location = cells.find((c) => /^(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b/.test(c)) ?? null;
    const prev = byAbn.get(abn);
    if (!prev || (nameType && /entity name/i.test(nameType))) {
      byAbn.set(abn, {
        name,
        identifier: abn,
        status_raw: status,
        record_url: `${BASE}/ABN/View?abn=${abn}`,
        location,
        matched_previous_name: false,
        snippet: nameType ? `Matched on ${nameType}` : null,
      });
    }
  }
  if (byAbn.size === 0) return { kind: "unparsed", reason: "no ABN result rows found" };
  return { kind: "results", candidates: [...byAbn.values()], total: byAbn.size };
}

export function parseAbrRecord(page: FetchedPage): ParseOutcome {
  const text = page.text ?? "";
  const lines = cleanLines(text);
  const status = findLabel(lines, ["ABN status"]);
  const entityName = findLabel(lines, ["Entity name"]);
  if (!status || !entityName) {
    if (/(abn|record) (was )?not found|is not a valid abn|no record found/i.test(text.slice(0, 3000))) {
      return { ok: false, reason: "ABN not found", notFound: true };
    }
    const blocked = looksBlocked(text);
    return { ok: false, reason: blocked ? `blocked: ${blocked}` : "ABN status or entity name not found", blocked: !!blocked };
  }
  const header = /details for ABN\s*:?\s*([\d\s]{11,16})/i.exec(text);
  const abn = header ? (header[1] ?? "").replace(/\D/g, "") : null;
  const entityType = findLabel(lines, ["Entity type"]);
  const gst = findLabel(lines, ["Goods & Services Tax (GST)", "Goods and Services Tax (GST)", "GST"]);
  const location = findLabel(lines, ["Main business location"]);
  const acn = findLabel(lines, ["ASIC registration - ACN or ARBN", "ASIC registration - ACN", "ACN"]);
  const updated = findLabel(lines, ["ABN last updated"]);
  const extracted = findLabel(lines, ["Record extracted"]);

  const flags: ComplianceFlag[] = [];
  if (gst && /not currently registered/i.test(gst.value)) {
    flags.push({ code: "gst_not_registered", description: "Not currently registered for GST.", evidence: gst.evidence });
  }
  const acnDigits = acn ? acn.value.replace(/\D/g, "") : "";
  const identifiers: Record<string, string> = {};
  if (abn) identifiers.abn = abn;
  if (/^\d{9}$/.test(acnDigits)) identifiers.acn = acnDigits;

  const record = emptyRecord({
    name: entityName.value,
    identifier: abn,
    identifiers,
    status_raw: status.value,
    status: normalizeStatus(status.value),
    status_effective_date: toIsoDate(status.value, "DMY"),
    expiry_note: "ABNs do not expire. A cancelled ABN shows the cancellation date as status_effective_date.",
    disciplinary_note: "The Australian Business Register does not publish disciplinary actions.",
    compliance_flags: flags,
    details: {
      entity_type: entityType?.value ?? null,
      gst: gst?.value ?? null,
      main_business_location: location?.value ?? null,
      abn_last_updated: toIsoDate(updated?.value ?? null, "DMY"),
    },
    evidence: [status.evidence, entityName.evidence, header?.[0], gst?.evidence].filter((e): e is string => !!e),
    registry_timestamp: extracted?.value ?? null,
  });
  return { ok: true, record };
}

export const abr: RegistryAdapter = {
  id: "au-abr",
  name: "ABN Lookup (Australian Business Register)",
  authority: "Australian Business Register, Australian Taxation Office",
  country: "AU",
  region: null,
  jurisdictions: ["AU"],
  recordTypes: ["business_registration"],
  entityKinds: ["business", "person"],
  officialDomains: ["abr.business.gov.au"],
  identifierLabel: "ABN",
  identifierExample: "33 051 775 556",
  dateOrder: "DMY",
  notes: [
    "National register: covers companies, trusts, partnerships and sole traders in every state.",
    "Name search may list only active ABNs; search by ABN to check a cancelled one.",
  ],
  agent: { stealth: false, proxyCountry: "AU" },
  // A live run returned the page heading "ABN Lookup Record" as the name.
  agentRecordInstructions: "name is the value of the 'Entity name' field. other_fields must include 'Entity name' and 'ABN status'.",
  normalizeIdentifier(raw) {
    const s = raw.replace(/\D/g, "");
    return isValidAbn(s) ? s : null;
  },
  recordUrl: (id) => `${BASE}/ABN/View?abn=${id}`,
  search: {
    mode: "fetch",
    url: (q) => `${BASE}/Search/ResultsActive?SearchText=${encodeURIComponent(q)}`,
    parse: parseAbrSearch,
    noResultsIsConclusive: false,
    agentFallbackUrl: `${BASE}/Search/Index`,
    agentInstructions: () =>
      "Search by name. If there is an option to include cancelled or historical ABNs, include them. Return the 11-digit ABN as the identifier.",
  },
  parseRecord: parseAbrRecord,
  normalizeStatus,
  monitorPurpose: (r) =>
    `Alert when the ABN status of ${r.subject.name ?? "this entity"} (ABN ${r.licence_number ?? ""}) changes from "${r.status.raw}", for example to Cancelled, or when the entity name or GST registration changes. Ignore the 'Record extracted' timestamp.`,
};
