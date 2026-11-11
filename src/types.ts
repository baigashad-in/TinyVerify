import { z } from "zod";

/** Version tag on every result so downstream tools can pin to a contract. */
export const SCHEMA_VERSION = "tinyverify.v1" as const;

export const EntityKindSchema = z.enum(["person", "business"]);
export type EntityKind = z.infer<typeof EntityKindSchema>;

/**
 * Normalized status. The raw registry wording is always kept next to it,
 * because registries use different words for the same idea.
 */
export const NormalizedStatusSchema = z.enum([
  "active",
  "inactive",
  "expired",
  "suspended",
  "revoked",
  "cancelled",
  "dissolved",
  "insolvency",
  "not_registered",
  "unknown",
]);
export type NormalizedStatus = z.infer<typeof NormalizedStatusSchema>;

export const VerifyRequestSchema = z
  .object({
    name: z.string().trim().min(2).max(200),
    record_type: z.string().trim().min(2).max(100),
    jurisdiction: z.string().trim().min(2).max(100),
    licence_number: z.string().trim().min(1).max(50).optional(),
    /** US spelling accepted as an alias of licence_number. */
    license_number: z.string().trim().min(1).max(50).optional(),
    entity_kind: EntityKindSchema.optional(),
    /** Force one registry adapter by id (see GET /registries). */
    registry: z.string().trim().min(2).max(80).optional(),
    /** When no curated registry fits, find the official one with TinyFish Search. */
    allow_discovery: z.boolean().default(true),
  })
  .transform(({ license_number, ...rest }) => ({
    ...rest,
    licence_number: rest.licence_number ?? license_number,
  }));
export type VerifyRequestInput = z.input<typeof VerifyRequestSchema>;
export type VerifyRequest = z.output<typeof VerifyRequestSchema>;

export const DisciplinaryKindSchema = z.enum([
  "suspension",
  "revocation",
  "erasure",
  "conditions",
  "undertakings",
  "warning",
  "interim_order",
  "probation",
  "citation",
  "accusation",
  "legal_action",
  "complaint",
  "other",
]);
export type DisciplinaryKind = z.infer<typeof DisciplinaryKindSchema>;

export const DisciplinaryActionSchema = z.object({
  kind: DisciplinaryKindSchema,
  description: z.string(),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
  /** The registry text this item was read from. */
  evidence: z.string(),
});
export type DisciplinaryAction = z.infer<typeof DisciplinaryActionSchema>;

export const ComplianceFlagSchema = z.object({
  code: z.string(),
  description: z.string(),
  evidence: z.string(),
});
export type ComplianceFlag = z.infer<typeof ComplianceFlagSchema>;

export const RegistryRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  authority: z.string(),
  country: z.string(),
  region: z.string().nullable(),
  /** false when the registry was found at run time by TinyFish Search. */
  curated: z.boolean(),
});
export type RegistryRef = z.infer<typeof RegistryRefSchema>;

export const RetrievedViaSchema = z.enum(["tinyfish_fetch", "tinyfish_agent", "tinyfish_monitor"]);
export type RetrievedVia = z.infer<typeof RetrievedViaSchema>;

export const SourceSchema = z.object({
  /** Official page for this exact record. Open it to check the result by hand. */
  url: z.string(),
  /** true when url opens this exact record (safe to monitor); false for a search page. */
  record_specific_url: z.boolean(),
  final_url: z.string().nullable(),
  title: z.string().nullable(),
  official_domain: z.string(),
  retrieved_via: RetrievedViaSchema,
  extraction: z.enum(["deterministic_parser", "agent_structured_output"]),
  /** Verbatim lines from the page that support status, dates and actions. */
  evidence: z.array(z.string()),
  /** sha256 of the page text TinyFish returned (fetch path only). */
  content_sha256: z.string().nullable(),
  /** The registry's own "data current as of" style timestamp, when shown. */
  registry_timestamp: z.string().nullable(),
  agent_run_id: z.string().nullable(),
});
export type Source = z.infer<typeof SourceSchema>;

export const DetailValueSchema = z.union([z.string(), z.array(z.string()), z.null()]);

export const MatchInfoSchema = z.object({
  method: z.enum(["identifier", "exact_name", "fuzzy_name"]),
  score: z.number(),
  query: z.string(),
  name_matches_request: z.boolean(),
});

export const VerifiedRecordSchema = z.object({
  registry: RegistryRefSchema,
  record_type: z.string(),
  subject: z.object({
    name: z.string().nullable(),
    entity_kind: EntityKindSchema.nullable(),
  }),
  status: z.object({
    normalized: NormalizedStatusSchema,
    raw: z.string(),
    effective_date: z.string().nullable(),
  }),
  /** Licence or registration number as the registry shows it. */
  licence_number: z.string().nullable(),
  identifiers: z.record(z.string(), z.string()),
  issue_date: z.string().nullable(),
  expiry_date: z.string().nullable(),
  renewal_due_date: z.string().nullable(),
  expiry_note: z.string().nullable(),
  disciplinary_actions: z.array(DisciplinaryActionSchema),
  /** Explains an empty list, for example when a registry never publishes actions. */
  disciplinary_note: z.string().nullable(),
  compliance_flags: z.array(ComplianceFlagSchema),
  details: z.record(z.string(), DetailValueSchema),
  match: MatchInfoSchema,
  source: SourceSchema,
  checked_at: z.string(),
});
export type VerifiedRecord = z.infer<typeof VerifiedRecordSchema>;

export const CandidateSchema = z.object({
  registry_id: z.string(),
  name: z.string(),
  identifier: z.string().nullable(),
  status_raw: z.string().nullable(),
  record_url: z.string().nullable(),
  location: z.string().nullable(),
  score: z.number(),
  matched_previous_name: z.boolean(),
  snippet: z.string().nullable(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const SourceCheckSchema = z.object({
  registry_id: z.string(),
  registry_name: z.string(),
  step: z.enum(["discover", "search", "record"]),
  method: z.enum(["tinyfish_fetch", "tinyfish_agent", "tinyfish_search"]),
  url: z.string().nullable(),
  query: z.string().nullable(),
  outcome: z.enum(["ok", "no_results", "unparsed", "blocked", "not_found", "error"]),
  result_count: z.number().nullable(),
  detail: z.string().nullable(),
  checked_at: z.string(),
});
export type SourceCheck = z.infer<typeof SourceCheckSchema>;

export const TinyFishCallSchema = z.object({
  endpoint: z.enum(["agent", "fetch", "search", "monitor"]),
  action: z.string(),
  target: z.string(),
  ok: z.boolean(),
  ms: z.number(),
  at: z.string(),
  run_id: z.string().nullable(),
});
export type TinyFishCall = z.infer<typeof TinyFishCallSchema>;

export const OutcomeSchema = z.enum([
  "verified",
  "name_mismatch",
  "multiple_matches",
  "no_match",
  "source_unavailable",
  "unsupported",
  "invalid_input",
]);
export type Outcome = z.infer<typeof OutcomeSchema>;

export const VerifyResultSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  outcome: OutcomeSchema,
  message: z.string(),
  request: z.record(z.string(), z.unknown()),
  records: z.array(VerifiedRecordSchema),
  candidates: z.array(CandidateSchema),
  sources_checked: z.array(SourceCheckSchema),
  warnings: z.array(z.string()),
  tinyfish_calls: z.array(TinyFishCallSchema),
  checked_at: z.string(),
});
export type VerifyResult = z.infer<typeof VerifyResultSchema>;

/** Page content as TinyFish Fetch (or a Monitor run) returns it. */
export interface FetchedPage {
  url: string;
  final_url: string | null;
  title: string | null;
  text: string | null;
  links?: string[] | undefined;
}
