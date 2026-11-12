/**
 * output_schema definitions for TinyFish Agent runs. They follow the
 * structured-output subset TinyFish accepts: top-level object, nullable
 * instead of type arrays, string enums only, no additionalProperties.
 */

const nullableString = { type: "string", nullable: true } as const;

export const CANDIDATES_SCHEMA = {
  type: "object",
  properties: {
    page_state: {
      type: "string",
      enum: ["results_list", "single_record", "no_results", "blocked", "error"],
    },
    no_results_message: nullableString,
    candidates: {
      type: "array",
      maxItems: 25,
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          identifier: nullableString,
          status: nullableString,
          location: nullableString,
          record_url: nullableString,
        },
        required: ["name"],
      },
    },
  },
  required: ["page_state", "candidates"],
} as const;

export const RECORD_SCHEMA = {
  type: "object",
  properties: {
    page_state: {
      type: "string",
      enum: ["record", "no_results", "results_list", "blocked", "error"],
    },
    name: nullableString,
    identifier: nullableString,
    status_text: nullableString,
    status_effective_date: nullableString,
    issue_date: nullableString,
    expiry_date: nullableString,
    renewal_due_date: nullableString,
    disciplinary_actions: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [
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
            ],
          },
          description: { type: "string" },
          start_date: nullableString,
          end_date: nullableString,
        },
        required: ["kind", "description"],
      },
    },
    other_fields: {
      type: "array",
      maxItems: 25,
      items: {
        type: "object",
        properties: { label: { type: "string" }, value: { type: "string" } },
        required: ["label", "value"],
      },
    },
    registry_timestamp: nullableString,
    record_url: nullableString,
    evidence_quote: nullableString,
  },
  required: ["page_state", "disciplinary_actions"],
} as const;

const COMMON_RULES = [
  "Copy every value exactly as the page displays it. Do not infer, translate, reformat or fill gaps.",
  "Only use this official register. Do not visit other websites.",
  "Do not log in, create accounts, pay, or submit any form other than the register's own public search.",
  "If you see a CAPTCHA, an access-denied page, a maintenance notice or an error page, stop and set page_state to 'blocked' (or 'error').",
];

export function searchGoal(args: {
  registryName: string;
  authority: string;
  query: string;
  subject: "person" | "business" | "person or business";
  instructions: string;
}): string {
  return [
    `You are on the public search of ${args.registryName} (${args.authority}).`,
    `Search the register for the ${args.subject} named "${args.query}".`,
    args.instructions,
    "Return every result on the first results page (up to 25): name, identifier (the licence, registration or company number), status, location, and record_url (the full URL of that result's detail page).",
    "Set page_state to 'no_results' only when the registry shows its own message that nothing matched, and copy that message exactly into no_results_message.",
    "If the page did not load, the search did not run, results never appeared, or you are unsure, set page_state to 'error' instead and say what happened in no_results_message.",
    "If the search opens a single record directly, set page_state to 'single_record' and return it as the only candidate with record_url set to the current page URL.",
    ...COMMON_RULES,
  ].join("\n");
}

export function recordGoal(args: {
  registryName: string;
  authority: string;
  identifierLabel?: string;
  identifier?: string | null;
  nameHint?: string | null;
  /** Registry-specific fields the agent must include in other_fields. */
  extra?: string | null;
}): string {
  const target = args.identifier
    ? `Open the record for ${args.identifierLabel ?? "number"} ${args.identifier}. If this page is a search form, search by that number and open the matching record.`
    : args.nameHint
      ? `Open the record for "${args.nameHint}". If this page is a search form, search for that name and open the exact match only.`
      : "Read the record shown on this page.";
  return [
    `You are on ${args.registryName} (${args.authority}).`,
    target,
    "Set page_state to 'record' only when a single record's detail page is open.",
    "name: the registered name of the person or organisation, copied from the record's name field (for example 'Entity name', 'Company name', 'Licensee', 'Name'). Never the page title, heading or site name.",
    "status_text: the registration or licence status wording exactly as shown.",
    "identifier: the licence, registration or company number exactly as shown.",
    "issue_date, expiry_date, renewal_due_date, status_effective_date: copy the dates exactly as shown, or null if the page has none.",
    "disciplinary_actions: one item per disciplinary, enforcement or restriction entry on this record (suspension, revocation, erasure, conditions, undertakings, warning, interim order, probation, citation, accusation, legal action, public complaint). Use an empty list when none are shown. Never list the site's generic disclaimers.",
    "other_fields: up to 25 other labelled fields from the record, such as entity type, classifications, address, bond or insurance.",
    "registry_timestamp: the page's own 'data current as of' or 'results of search on' text, if shown.",
    "record_url: the full URL of the record page.",
    "evidence_quote: copy the one line of the page that states the status.",
    ...(args.extra ? [args.extra] : []),
    ...COMMON_RULES,
  ].join("\n");
}
