import type {
  ComplianceFlag,
  DisciplinaryAction,
  EntityKind,
  FetchedPage,
  NormalizedStatus,
  VerifiedRecord,
} from "../types.js";
import type { DateOrder } from "../util/dates.js";

export type CanonicalRecordType = "business_registration" | "medical_licence" | "contractor_licence";

/** Jurisdiction keys: ISO country code, or country-subdivision (US-CA). */
export type JurisdictionKey = string;

export interface ParsedRecord {
  name: string | null;
  identifier: string | null;
  identifiers: Record<string, string>;
  status_raw: string;
  status: NormalizedStatus;
  status_effective_date: string | null;
  issue_date: string | null;
  expiry_date: string | null;
  renewal_due_date: string | null;
  expiry_note: string | null;
  disciplinary_actions: DisciplinaryAction[];
  disciplinary_note: string | null;
  compliance_flags: ComplianceFlag[];
  details: Record<string, string | string[] | null>;
  evidence: string[];
  registry_timestamp: string | null;
}

export type ParseOutcome =
  | { ok: true; record: ParsedRecord }
  | { ok: false; reason: string; notFound?: boolean; blocked?: boolean };

export interface SearchCandidate {
  name: string;
  identifier: string | null;
  status_raw: string | null;
  record_url: string | null;
  location: string | null;
  matched_previous_name: boolean;
  snippet: string | null;
}

export type SearchParse =
  | { kind: "results"; candidates: SearchCandidate[]; total: number | null }
  | { kind: "no_results"; evidence: string }
  | { kind: "unparsed"; reason: string };

export interface FetchSearchSpec {
  mode: "fetch";
  url(query: string, kind: EntityKind | null): string;
  parse(page: FetchedPage): SearchParse;
  /**
   * False when the fetch view can hide records (for example ABN Lookup's
   * active-only list). Then "no results" is confirmed with TinyFish Agent
   * before the tool reports no match.
   */
  noResultsIsConclusive: boolean;
  /**
   * Which Fetch versions to try, in order. "default" is Fetch's main-content
   * Markdown, "full" the whole page. Leave out a version that a live dump
   * showed never parses, to save the call. Default: ["default", "full"].
   */
  fetchModes?: ("default" | "full")[];
  /** Search form used when the fetch view cannot be read. */
  agentFallbackUrl: string;
  agentInstructions(query: string, kind: EntityKind | null): string;
}

export interface AgentSearchSpec {
  mode: "agent";
  url: string;
  agentInstructions(query: string, kind: EntityKind | null): string;
}

export interface RegistryAdapter {
  id: string;
  name: string;
  authority: string;
  country: string;
  region: string | null;
  jurisdictions: JurisdictionKey[];
  recordTypes: CanonicalRecordType[];
  entityKinds: EntityKind[];
  officialDomains: string[];
  identifierLabel: string;
  identifierExample: string;
  dateOrder: DateOrder;
  /** Coverage notes shown to users, for example "federal corporations only". */
  notes: string[];
  /** Agent browser settings for this site. */
  agent: { stealth: boolean; proxyCountry: string };
  /** Person names are listed "Last First" on this register's search. */
  lastFirstNames?: boolean;
  /** false for registries found at run time: no parser, so records are read with TinyFish Agent only. */
  curated?: boolean;
  /** Fetch versions to try for record pages, in order (see FetchSearchSpec.fetchModes). Default: ["default", "full"]. */
  recordFetchModes?: ("default" | "full")[];

  /** Return the canonical identifier, or null when the input is not a valid format. */
  normalizeIdentifier(raw: string): string | null;
  /** Stable public URL for one record, used by Fetch and by Monitor. Null when the site has none. */
  recordUrl(id: string): string | null;
  /** Where TinyFish Agent starts a lookup by number when recordUrl is null. */
  identifierSearchUrl?: string;
  search: FetchSearchSpec | AgentSearchSpec;
  parseRecord(page: FetchedPage): ParseOutcome;
  normalizeStatus(raw: string): NormalizedStatus;
  /**
   * Optional status mapping for Agent reads that can use other fields the
   * agent returned (Sunbiz needs "Last Event" to tell dissolved from inactive),
   * so Fetch and Agent reads of the same page give the same normalized status.
   */
  normalizeAgentStatus?(raw: string, details: Record<string, string>): NormalizedStatus;
  /** Extra instruction for Agent record reads, for fields normalizeAgentStatus needs. */
  agentRecordInstructions?: string;
  /** Plain-English description of the change that matters, sent to TinyFish Monitor. */
  monitorPurpose(record: VerifiedRecord): string;
}

export function emptyRecord(partial: Partial<ParsedRecord> & Pick<ParsedRecord, "status_raw" | "status">): ParsedRecord {
  return {
    name: null,
    identifier: null,
    identifiers: {},
    status_effective_date: null,
    issue_date: null,
    expiry_date: null,
    renewal_due_date: null,
    expiry_note: null,
    disciplinary_actions: [],
    disciplinary_note: null,
    compliance_flags: [],
    details: {},
    evidence: [],
    registry_timestamp: null,
    ...partial,
  };
}

/** Text that means the page is a bot wall or error page, not the registry. */
export const BLOCKED_PATTERNS = [
  /verify you are (a )?human/i,
  /checking (if the site connection is secure|your browser)/i,
  /attention required.*cloudflare/i,
  /access denied/i,
  /are you a robot/i,
  /captcha/i,
  /request (was )?blocked/i,
  /temporarily unavailable/i,
  /undergoing scheduled maintenance/i,
];

export function looksBlocked(text: string): string | null {
  for (const re of BLOCKED_PATTERNS) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}
