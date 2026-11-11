import type { EntityKind } from "../types.js";
import { abr } from "./abr.js";
import { companiesHouse } from "./companiesHouse.js";
import { corporationsCanada } from "./corporationsCanada.js";
import { cslb } from "./cslb.js";
import { gmc } from "./gmc.js";
import { sunbiz } from "./sunbiz.js";
import type { CanonicalRecordType, RegistryAdapter } from "./types.js";

export const ADAPTERS: RegistryAdapter[] = [companiesHouse, gmc, abr, cslb, corporationsCanada, sunbiz];

export function getAdapter(id: string): RegistryAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}

const RECORD_TYPE_ALIASES: Record<CanonicalRecordType, string[]> = {
  business_registration: [
    "business registration", "company", "company registration", "registered company", "business", "corporation",
    "corp", "incorporation", "llc", "limited company", "ltd", "plc", "llp", "partnership", "entity", "abn",
    // A bare "registration" is not here on purpose: "nurse registration" is not a company record.
    "sole trader", "not for profit", "nonprofit", "non profit", "charity company", "business entity",
    "good standing", "company status", "entity registration", "corporate registration",
  ],
  medical_licence: [
    "medical licence", "medical license", "medical registration", "doctor", "physician", "medical", "gmc",
    "licence to practise", "license to practice", "physician associate", "anaesthesia associate", "surgeon", "gp",
    "medical practitioner",
  ],
  contractor_licence: [
    "contractor licence", "contractor license", "contractor", "general contractor", "builder", "construction",
    "construction licence", "construction license", "home improvement", "cslb", "roofer", "plumber", "electrician",
    "hvac", "landscaper", "painter",
  ],
};

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Map free text like "Contractor license" to a canonical record type, or null. */
export function resolveRecordType(input: string): CanonicalRecordType | null {
  const n = norm(input).replace(/\blicen[cs]e\b/g, "licence");
  if ((Object.keys(RECORD_TYPE_ALIASES) as CanonicalRecordType[]).includes(n.replace(/ /g, "_") as CanonicalRecordType)) {
    return n.replace(/ /g, "_") as CanonicalRecordType;
  }
  let best: { type: CanonicalRecordType; len: number } | null = null;
  for (const [type, aliases] of Object.entries(RECORD_TYPE_ALIASES) as [CanonicalRecordType, string[]][]) {
    for (const alias of aliases) {
      const a = norm(alias).replace(/\blicen[cs]e\b/g, "licence");
      const hit = n === a || new RegExp(`(^| )${a.replace(/ /g, " ")}( |$)`).test(n);
      if (hit && (!best || a.length > best.len)) best = { type, len: a.length };
    }
  }
  return best?.type ?? null;
}

interface JurisdictionDef {
  key: string;
  label: string;
  /** Country names and codes. Strongest signal. */
  country: string[];
  /** States, provinces and constituent countries. */
  regions: string[];
  /** Cities. Weakest signal: London is also in Ontario. */
  cities: string[];
  note?: string;
}

const JURISDICTIONS: JurisdictionDef[] = [
  {
    key: "GB",
    label: "United Kingdom",
    country: ["uk", "u k", "united kingdom", "gb", "great britain", "britain"],
    regions: ["england", "wales", "scotland", "northern ireland", "england and wales"],
    cities: ["london"],
  },
  {
    key: "AU",
    label: "Australia",
    country: ["australia", "au", "aus", "commonwealth of australia"],
    regions: [
      "nsw", "new south wales", "vic", "victoria", "qld", "queensland", "western australia", "south australia", "tas",
      "tasmania", "act", "australian capital territory", "nt", "northern territory",
    ],
    cities: [],
  },
  {
    key: "CA",
    label: "Canada (federal)",
    country: ["canada", "can", "federal canada", "canada federal"],
    regions: [
      "ontario", "quebec", "british columbia", "alberta", "manitoba", "saskatchewan", "nova scotia", "new brunswick",
      "newfoundland", "newfoundland and labrador", "prince edward island", "pei",
    ],
    cities: [],
    note: "Corporations Canada holds federal corporations only. A company incorporated in a province is in that province's registry.",
  },
  {
    key: "US-CA",
    label: "California, United States",
    country: [],
    regions: ["california", "us ca", "ca usa", "california usa", "calif", "state of california", "california us"],
    cities: [],
  },
  {
    key: "US-FL",
    label: "Florida, United States",
    country: [],
    regions: ["florida", "fl", "us fl", "florida usa", "state of florida", "fl usa"],
    cities: [],
  },
];

/** Labels for places that have no curated registry but appear in ambiguous codes. */
const EXTRA_LABELS: Record<string, string> = { "US-WA": "Washington, United States" };

export function jurisdictionLabel(key: string): string {
  return JURISDICTIONS.find((j) => j.key === key)?.label ?? EXTRA_LABELS[key] ?? key;
}

/** Short codes that mean more than one place. */
const AMBIGUOUS: Record<string, string[]> = {
  ca: ["CA", "US-CA"],
  wa: ["AU", "US-WA"],
  sa: ["AU"],
};

/** Short aliases that are safe to find inside a longer place name ("Miami, FL"). Others ("act", "can") are common words. */
const SHORT_OK_IN_PHRASE = new Set(["uk", "u k", "gb", "nsw", "qld", "fl", "pei"]);

export interface ResolvedJurisdiction {
  keys: string[];
  label: string;
  ambiguous: boolean;
  notes: string[];
  /** Set when a longer place name was read as one jurisdiction; shown as a warning. */
  assumption: string | null;
}

function resolved(key: string, assumption: string | null = null): ResolvedJurisdiction {
  const j = JURISDICTIONS.find((d) => d.key === key);
  return { keys: [key], label: j?.label ?? key, ambiguous: false, notes: j?.note ? [j.note] : [], assumption };
}

interface AliasHit {
  key: string;
  tier: number; // 0 country, 1 region, 2 city
  start: number;
  end: number;
}

export function resolveJurisdiction(input: string): ResolvedJurisdiction {
  const n = norm(input);
  const amb = AMBIGUOUS[n];
  if (amb && amb.length > 1) {
    const labels = amb.map(jurisdictionLabel);
    return {
      keys: amb,
      label: input,
      ambiguous: true,
      notes: [`"${input}" can mean ${labels.join(" or ")}. TinyVerify checked each one; set jurisdiction to the full name to check only one.`],
      assumption: null,
    };
  }
  if (amb && amb.length === 1) return resolved(amb[0] as string);
  for (const j of JURISDICTIONS) {
    if ([...j.country, ...j.regions, ...j.cities].includes(n) || n === j.key.toLowerCase().replace("-", " ")) return resolved(j.key);
  }

  // A longer place name such as "Sydney, New South Wales" or "London, Ontario".
  const hits: AliasHit[] = [];
  for (const j of JURISDICTIONS) {
    const tiers: [string[], number][] = [[j.country, 0], [j.regions, 1], [j.cities, 2]];
    for (const [aliases, tier] of tiers) {
      for (const a of aliases) {
        if (a.length <= 3 && !SHORT_OK_IN_PHRASE.has(a)) continue;
        const re = new RegExp(`(?:^| )(${a})(?= |$)`, "g");
        for (const m of n.matchAll(re)) {
          const start = (m.index ?? 0) + (m[0].length - a.length);
          hits.push({ key: j.key, tier, start, end: start + a.length });
        }
      }
    }
  }
  // "wales" inside "new south wales" is not a separate place.
  const kept = hits.filter((h) => !hits.some((o) => o !== h && o.start <= h.start && o.end >= h.end && o.end - o.start > h.end - h.start));
  if (kept.length === 0) {
    // "Los Angeles, CA": an ambiguous code at the end of a place name.
    const last = n.split(" ").pop() ?? "";
    const tail = AMBIGUOUS[last];
    if (tail && tail.length > 1 && n.includes(" ")) {
      const r = resolveJurisdiction(last);
      return { ...r, label: input };
    }
    return { keys: [], label: input, ambiguous: false, notes: [], assumption: null };
  }
  const topTier = Math.min(...kept.map((h) => h.tier));
  const top = kept.filter((h) => h.tier === topTier);
  // Addresses run from small to large ("City, State, Country"), so the last match is the broadest.
  const chosen = top.reduce((a, b) => (b.end > a.end ? b : a));
  const others = [...new Set(kept.map((h) => h.key))].filter((k) => k !== chosen.key);
  const assumption = others.length
    ? `Read "${input}" as ${jurisdictionLabel(chosen.key)} (it also contains a place name from ${others.map(jurisdictionLabel).join(", ")}). Set jurisdiction to a country or state name if that is wrong.`
    : null;
  return resolved(chosen.key, assumption);
}

export interface Route {
  adapters: RegistryAdapter[];
  recordType: CanonicalRecordType | null;
  jurisdiction: ResolvedJurisdiction;
  reason: string;
}

export function route(args: { record_type: string; jurisdiction: string; entity_kind?: EntityKind; registry?: string }): Route {
  const recordType = resolveRecordType(args.record_type);
  const jurisdiction = resolveJurisdiction(args.jurisdiction);
  if (args.registry) {
    const forced = getAdapter(args.registry);
    return {
      adapters: forced ? [forced] : [],
      recordType,
      jurisdiction,
      reason: forced ? `registry forced to ${forced.id}` : `unknown registry id "${args.registry}"`,
    };
  }
  const adapters = ADAPTERS.filter(
    (a) =>
      a.jurisdictions.some((k) => jurisdiction.keys.includes(k)) &&
      recordType !== null &&
      a.recordTypes.includes(recordType) &&
      (!args.entity_kind || a.entityKinds.includes(args.entity_kind)),
  );
  const reason = adapters.length
    ? `matched ${adapters.map((a) => a.id).join(", ")}`
    : recordType === null
      ? `record type "${args.record_type}" is not one of the curated types`
      : jurisdiction.keys.length === 0
        ? `jurisdiction "${args.jurisdiction}" has no curated registry`
        : `no curated registry for ${recordType} in ${jurisdiction.label}`;
  return { adapters, recordType, jurisdiction, reason };
}

export function catalog() {
  return ADAPTERS.map((a) => ({
    id: a.id,
    name: a.name,
    authority: a.authority,
    country: a.country,
    region: a.region,
    record_types: a.recordTypes,
    entity_kinds: a.entityKinds,
    official_domains: a.officialDomains,
    identifier: { label: a.identifierLabel, example: a.identifierExample },
    search_method: a.search.mode === "fetch" ? "tinyfish_fetch (agent fallback)" : "tinyfish_agent",
    record_method: a.recordUrl("0") ? "tinyfish_fetch (agent fallback)" : "tinyfish_agent",
    monitorable: a.recordUrl("0") !== null ? "stable record URL" : "record URL returned by agent",
    notes: a.notes,
  }));
}

export type { RegistryAdapter, CanonicalRecordType } from "./types.js";
