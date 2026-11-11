import type { EntityKind } from "../types.js";

/** Legal-form words mapped to one spelling, so "Ltd" equals "Limited". */
const SUFFIX_CANON: Record<string, string> = {
  ltd: "limited",
  limited: "limited",
  plc: "plc",
  llp: "llp",
  lp: "lp",
  llc: "llc",
  inc: "incorporated",
  incorporated: "incorporated",
  corp: "corporation",
  corporation: "corporation",
  co: "company",
  company: "company",
  pty: "proprietary",
  proprietary: "proprietary",
  pllc: "pllc",
  pc: "pc",
  pa: "pa",
  ltee: "limitee",
  limitee: "limitee",
  ulc: "ulc",
  cic: "cic",
  gmbh: "gmbh",
  ag: "ag",
  sa: "sa",
  sas: "sas",
  bv: "bv",
  nv: "nv",
  holdings: "holdings",
  group: "group",
};

/** Words dropped when comparing the core of a business name. */
const BUSINESS_NOISE = new Set([
  "limited", "plc", "llp", "lp", "llc", "incorporated", "corporation", "company", "proprietary",
  "pllc", "pc", "pa", "limitee", "ulc", "cic", "gmbh", "ag", "sa", "sas", "bv", "nv", "the",
]);

const PERSON_NOISE = new Set([
  "dr", "doctor", "mr", "mrs", "ms", "miss", "mx", "prof", "professor", "sir", "dame", "md", "mbbs",
  "mbchb", "frcs", "frcp", "mrcp", "phd", "do", "rn", "np", "jr", "sr", "ii", "iii", "iv", "esq",
]);

/** Lowercase, strip accents and punctuation, unify "&" and "and". */
export function baseNormalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/\bl\.l\.c\b\.?/g, "llc")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tokens with legal suffixes made uniform (kept). Used for literal comparison. */
export function literalTokens(s: string): string[] {
  return baseNormalize(s)
    .split(" ")
    .filter(Boolean)
    .map((t) => SUFFIX_CANON[t] ?? t);
}

/** Tokens with suffixes, titles and noise removed. Used for core comparison. */
export function coreTokens(s: string, kind: EntityKind | null): string[] {
  const toks = literalTokens(s);
  const noise = kind === "person" ? PERSON_NOISE : kind === "business" ? BUSINESS_NOISE : new Set<string>();
  const kept = toks.filter((t) => !noise.has(t) && !(kind === null && (BUSINESS_NOISE.has(t) || PERSON_NOISE.has(t))));
  return kept.length > 0 ? kept : toks;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[b.length] ?? Math.max(a.length, b.length);
}

function tokenSim(a: string, b: string, kind: EntityKind | null): number {
  if (a === b) return 1;
  // "j" matches "john" for people (initials are common on registers).
  if (kind === "person" && (a.length === 1 || b.length === 1) && a[0] === b[0]) return 0.8;
  const d = levenshtein(a, b);
  const sim = 1 - d / Math.max(a.length, b.length);
  // Short tokens with typos are risky; require high similarity.
  return Math.min(a.length, b.length) <= 3 ? (sim >= 0.99 ? sim : 0) : sim >= 0.75 ? sim : 0;
}

function directional(q: string[], c: string[], kind: EntityKind | null): number {
  if (q.length === 0) return 0;
  let total = 0;
  for (const qt of q) {
    let best = 0;
    for (const ct of c) best = Math.max(best, tokenSim(qt, ct, kind));
    total += best;
  }
  return total / q.length;
}

/**
 * Similarity in [0, 1]. 1 means the names are the same once case, punctuation
 * and legal-form spelling are ignored. Word order is ignored at a small cost,
 * so "SMITH, John" scores 0.97 against "John Smith".
 */
export function nameScore(query: string, candidate: string, kind: EntityKind | null): number {
  const ql = literalTokens(query);
  const cl = literalTokens(candidate);
  if (ql.length === 0 || cl.length === 0) return 0;
  if (ql.join(" ") === cl.join(" ")) return 1;

  const q = coreTokens(query, kind);
  const c = coreTokens(candidate, kind);
  if (q.join(" ") === c.join(" ")) return 0.98; // differs only by legal suffix or title
  if ([...q].sort().join(" ") === [...c].sort().join(" ")) return 0.96; // word order only

  const forward = directional(q, c, kind);
  const backward = directional(c, q, kind);
  const score = (forward + backward) / 2;
  return Math.round(score * 1000) / 1000;
}

/** Legal-form words that name a different kind of entity when they differ. */
const LEGAL_FORMS = new Set(["limited", "plc", "llp", "lp", "llc", "incorporated", "corporation", "proprietary", "pllc", "pc", "pa", "limitee", "ulc", "cic", "gmbh", "ag", "sa", "sas", "bv", "nv"]);

/** True when both names carry a legal form and the forms differ ("PLC" vs "Limited"). */
export function legalFormConflict(a: string, b: string): boolean {
  const fa = new Set(literalTokens(a).filter((t) => LEGAL_FORMS.has(t)));
  const fb = new Set(literalTokens(b).filter((t) => LEGAL_FORMS.has(t)));
  if (fa.size === 0 || fb.size === 0) return false;
  for (const f of fa) if (fb.has(f)) return false;
  return true;
}

export interface IdentifierNameCheck {
  ok: boolean;
  score: number;
  /** One name is a shorter form of the other ("Woolworths" for "WOOLWORTHS GROUP LIMITED"). */
  partial: boolean;
  reason: string;
}

/**
 * Name check when the caller gave a record number. The number picks the
 * record, so the name only has to show it is the same entity: every word of
 * the shorter name must appear in the longer one, and the legal forms must
 * not conflict. "Tesco PLC" does not pass for TESCO STORES LIMITED.
 */
export function identifierNameCheck(requested: string, onRecord: string | null, kind: EntityKind | null): IdentifierNameCheck {
  if (!onRecord) return { ok: false, score: 0, partial: false, reason: "the record page did not show a name" };
  const score = nameScore(requested, onRecord, kind);
  if (score >= MATCH_THRESHOLDS.strong) return { ok: true, score, partial: false, reason: "names match" };
  const q = coreTokens(requested, kind);
  const c = coreTokens(onRecord, kind);
  const coverage = Math.max(directional(q, c, kind), directional(c, q, kind));
  const conflict = kind !== "person" && legalFormConflict(requested, onRecord);
  if (coverage >= MATCH_THRESHOLDS.strong && !conflict) {
    return { ok: true, score, partial: true, reason: "one name is a shorter form of the other" };
  }
  return {
    ok: false,
    score,
    partial: false,
    reason: conflict ? "the legal forms differ (for example PLC and Limited)" : "the names share too few words",
  };
}

/**
 * Name forms to try in order. Registries differ: CSLB wants "Last First",
 * some registers drop legal suffixes, people are listed "SURNAME, Given".
 */
export function nameVariants(name: string, kind: EntityKind | null, opts: { lastFirst?: boolean; max?: number } = {}): string[] {
  const max = opts.max ?? 3;
  const trimmed = name.replace(/\s+/g, " ").trim();
  const out: string[] = [trimmed];

  if (kind === "person") {
    let given = trimmed;
    const comma = /^([^,]+),\s*(.+)$/.exec(trimmed);
    if (comma) given = `${comma[2]} ${comma[1]}`.trim();
    const parts = given
      .split(" ")
      .filter((p) => !PERSON_NOISE.has(p.toLowerCase().replace(/\./g, "")));
    const plain = parts.join(" ");
    if (opts.lastFirst && parts.length >= 2) {
      out.unshift(`${parts[parts.length - 1]} ${parts.slice(0, -1).join(" ")}`);
    }
    out.push(plain);
    if (parts.length >= 3) out.push(`${parts[0]} ${parts[parts.length - 1]}`); // drop middle names
  } else {
    const core = trimmed
      .replace(/[,.]/g, " ")
      .split(/\s+/)
      .filter((t) => !BUSINESS_NOISE.has(SUFFIX_CANON[t.toLowerCase()] ?? t.toLowerCase()))
      .join(" ");
    out.push(core);
    if (/&/.test(trimmed)) out.push(trimmed.replace(/&/g, "and"));
    if (/\band\b/i.test(trimmed)) out.push(trimmed.replace(/\band\b/gi, "&"));
  }

  const seen = new Set<string>();
  return out
    .map((v) => v.replace(/\s+/g, " ").trim())
    .filter((v) => v.length >= 2 && !seen.has(v.toLowerCase()) && seen.add(v.toLowerCase()))
    .slice(0, max);
}

export interface Scored<T> {
  item: T;
  score: number;
  /** Share of the requested name's words found in the candidate (see requestCoverage). */
  coverage?: number;
}

/**
 * Share of the requested name's core words that appear in the candidate,
 * with the same typo tolerance as nameScore. nameScore averages both
 * directions, so "WIDGET WORKS LIMITED" scored 0.75 for "Zqxv Imaginary
 * Widget Works Ltd" even though half the requested words are missing.
 */
export function requestCoverage(requested: string, candidate: string, kind: EntityKind | null): number {
  return Math.round(directional(coreTokens(requested, kind), coreTokens(candidate, kind), kind) * 1000) / 1000;
}

export type MatchDecision<T> =
  | { kind: "single"; best: Scored<T>; method: "exact_name" | "fuzzy_name" }
  | { kind: "multiple"; options: Scored<T>[]; exact: boolean }
  | { kind: "none"; nearMisses: Scored<T>[] };

export const MATCH_THRESHOLDS = {
  /** At or above this a candidate is a strong match. */
  strong: 0.92,
  /** A weak match must still contain at least this share of the requested words. */
  minCoverage: 0.75,
  /** The best strong match must beat the runner-up by this much to be chosen. */
  gap: 0.06,
  /** Below this a candidate is not offered as a possible match. */
  weak: 0.75,
} as const;

/**
 * Pick one candidate only when the evidence is clear. Otherwise return the
 * options and let the caller ask the user. This never guesses between two
 * equally good names.
 */
export function decide<T>(scored: Scored<T>[]): MatchDecision<T> {
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const exact = sorted.filter((s) => s.score >= 0.999);
  if (exact.length === 1) return { kind: "single", best: exact[0] as Scored<T>, method: "exact_name" };
  if (exact.length > 1) return { kind: "multiple", options: exact, exact: true };

  const strong = sorted.filter((s) => s.score >= MATCH_THRESHOLDS.strong);
  if (strong.length >= 1) {
    const first = strong[0] as Scored<T>;
    const second = sorted[1];
    if (!second || first.score - second.score >= MATCH_THRESHOLDS.gap) {
      return { kind: "single", best: first, method: "fuzzy_name" };
    }
    const close = sorted.filter((s) => first.score - s.score < MATCH_THRESHOLDS.gap && s.score >= MATCH_THRESHOLDS.weak);
    return { kind: "multiple", options: close, exact: false };
  }

  // A "possible" match must contain most of the requested words; a candidate
  // that only shares a generic part ("Widget Works") is a near miss, not a match.
  const possible = sorted.filter((s) => s.score >= MATCH_THRESHOLDS.weak && (s.coverage ?? 1) >= MATCH_THRESHOLDS.minCoverage).slice(0, 10);
  if (possible.length > 0) return { kind: "multiple", options: possible, exact: false };
  return { kind: "none", nearMisses: sorted.filter((s) => s.score >= 0.5).slice(0, 5) };
}
