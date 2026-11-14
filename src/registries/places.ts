/**
 * Any place name to an ISO code that GLEIF uses for a legal jurisdiction:
 * a country ("DE") or, where companies are registered per state or
 * province, a subdivision ("US-NY", "CA-ON").
 *
 * Country names come from the runtime's own list (Intl.DisplayNames), so
 * every country is covered without a hand-made table; common other names
 * ("Holland", "UAE", "Deutschland") are added below.
 */

export interface Place {
  /** ISO 3166-1 alpha-2, e.g. "DE". */
  country: string;
  /** ISO 3166-2 for US states and Canadian provinces, e.g. "US-NY". */
  subdivision: string | null;
  /** The code GLEIF uses for entity.jurisdiction. */
  gleifJurisdiction: string;
  label: string;
  /** Set when the input could mean two places; shown as a warning. */
  assumption: string | null;
}

function norm(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const NOT_COUNTRIES = /^(EU|EZ|UN|QO|ZZ|AA|Q[M-Z]|X[A-JL-Z])$/;

const US_STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT",
  delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI",
  minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH",
  "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY", "district of columbia": "DC", "washington dc": "DC", "puerto rico": "PR",
};
const CA_PROVINCES: Record<string, string> = {
  ontario: "ON", quebec: "QC", "british columbia": "BC", alberta: "AB", manitoba: "MB", saskatchewan: "SK",
  "nova scotia": "NS", "new brunswick": "NB", "newfoundland and labrador": "NL", newfoundland: "NL",
  "prince edward island": "PE", "northwest territories": "NT", nunavut: "NU", yukon: "YT",
};
const CITY_TO_SUB: Record<string, string> = { "new york city": "US-NY", nyc: "US-NY", "los angeles": "US-CA", "san francisco": "US-CA", toronto: "CA-ON", montreal: "CA-QC", vancouver: "CA-BC" };

const COUNTRY_ALIASES: Record<string, string> = {
  uk: "GB", "u k": "GB", britain: "GB", "great britain": "GB", england: "GB", scotland: "GB", wales: "GB", "northern ireland": "GB",
  usa: "US", us: "US", "u s": "US", "u s a": "US", "united states of america": "US", america: "US",
  uae: "AE", emirates: "AE", korea: "KR", "republic of korea": "KR", holland: "NL", "the netherlands": "NL",
  "czech republic": "CZ", "ivory coast": "CI", "cote d ivoire": "CI", turkey: "TR", turkiye: "TR", "russian federation": "RU",
  "viet nam": "VN", "hong kong": "HK", macau: "MO", macao: "MO", china: "CN", prc: "CN", "mainland china": "CN",
  deutschland: "DE", espana: "ES", brasil: "BR", "the philippines": "PH", burma: "MM", swaziland: "SZ", eswatini: "SZ",
  "cape verde": "CV", "republic of the congo": "CG", "congo brazzaville": "CG", "democratic republic of the congo": "CD",
  drc: "CD", "congo kinshasa": "CD", macedonia: "MK", "bosnia": "BA", "the bahamas": "BS", "the gambia": "GM",
  "georgia country": "GE", "georgia (country)": "GE", "saudi": "SA", "ksa": "SA", "south africa": "ZA", "new zealand": "NZ",
  "aotearoa": "NZ", "suisse": "CH", "schweiz": "CH", "osterreich": "AT", "nederland": "NL", "belgie": "BE", "belgique": "BE",
  "italia": "IT", "polska": "PL", "sverige": "SE", "norge": "NO", "danmark": "DK", "suomi": "FI", "nippon": "JP", "nihon": "JP",
};

let countryIndex: Map<string, string> | null = null;
let countryNames: Map<string, string> | null = null;

function countries(): { index: Map<string, string>; names: Map<string, string> } {
  if (countryIndex && countryNames) return { index: countryIndex, names: countryNames };
  const index = new Map<string, string>();
  const names = new Map<string, string>();
  const dn = new Intl.DisplayNames(["en"], { type: "region" });
  for (let a = 65; a < 91; a++) {
    for (let b = 65; b < 91; b++) {
      const code = String.fromCharCode(a, b);
      if (NOT_COUNTRIES.test(code)) continue;
      let name: string | undefined;
      try {
        name = dn.of(code);
      } catch {
        continue;
      }
      if (!name || name === code) continue;
      names.set(code, name);
      const n = norm(name);
      index.set(n, code);
      // "Hong Kong SAR China", "Congo - Kinshasa", "St. Lucia"
      index.set(n.replace(/ sar china$/, ""), code);
      if (n.startsWith("st ")) index.set(`saint ${n.slice(3)}`, code);
    }
  }
  for (const [alias, code] of Object.entries(COUNTRY_ALIASES)) index.set(norm(alias), code);
  countryIndex = index;
  countryNames = names;
  return { index, names };
}

export function countryName(code: string): string {
  return countries().names.get(code.toUpperCase()) ?? code;
}

function subdivisionLabel(sub: string): string {
  const [c, s] = sub.split("-");
  const table = c === "US" ? US_STATES : CA_PROVINCES;
  const name = Object.entries(table).find(([, v]) => v === s)?.[0] ?? s ?? sub;
  return `${name.replace(/\b[a-z]/g, (m) => m.toUpperCase())}, ${countryName(c ?? "")}`;
}

function make(country: string, subdivision: string | null, assumption: string | null = null): Place {
  return {
    country,
    subdivision,
    gleifJurisdiction: subdivision ?? country,
    label: subdivision ? subdivisionLabel(subdivision) : countryName(country),
    assumption,
  };
}

function lookupPart(part: string): { country?: string; sub?: string } {
  const n = norm(part).replace(/^(state|province) of /, "").replace(/ (state|province)$/, "");
  if (!n) return {};
  if (CITY_TO_SUB[n]) return { sub: CITY_TO_SUB[n] };
  const iso = part.trim().match(/^([A-Za-z]{2})-([A-Za-z0-9]{1,3})$/);
  if (iso) {
    const c = (iso[1] as string).toUpperCase();
    return { country: c, sub: c === "US" || c === "CA" ? `${c}-${(iso[2] as string).toUpperCase()}` : undefined };
  }
  if (US_STATES[n]) return { sub: `US-${US_STATES[n]}` };
  if (CA_PROVINCES[n]) return { sub: `CA-${CA_PROVINCES[n]}` };
  const { index, names } = countries();
  const byName = index.get(n);
  if (byName) return { country: byName };
  if (/^[a-z]{2}$/.test(n) && names.has(n.toUpperCase())) return { country: n.toUpperCase() };
  // A two-letter US state code that is not also a country code ("NY", "TX").
  const st = Object.values(US_STATES).find((v) => v.toLowerCase() === n);
  if (st) return { sub: `US-${st}` };
  return {};
}

/** Resolve any place text. Returns null when no country can be found. */
export function resolvePlace(input: string): Place | null {
  const raw = input.trim();
  if (!raw) return null;
  // "Georgia" alone is both a US state and a country.
  if (norm(raw) === "georgia") return make("US", "US-GA", `Read "Georgia" as the US state. Write "Georgia (country)" or "GE" for the country.`);

  const whole = lookupPart(raw);
  if (whole.sub || whole.country) {
    const sub = whole.sub ?? null;
    const country = whole.country ?? (sub ? (sub.split("-")[0] as string) : "");
    const twoLetter = /^[A-Za-z]{2}$/.test(raw) && Object.values(US_STATES).includes(raw.toUpperCase()) && !sub;
    return make(country, sub, twoLetter ? `Read "${raw}" as the country ${countryName(country)}. For the US state, write "US-${raw.toUpperCase()}" or the state's name.` : null);
  }

  // "Munich, Germany", "Austin, Texas", "Toronto, Ontario, Canada", "Ontario Canada"
  const parts = raw.split(/[,/;|]+/).map((p) => p.trim()).filter(Boolean);
  let country: string | null = null;
  let sub: string | null = null;
  for (const p of [...parts].reverse()) {
    const r = lookupPart(p);
    if (r.country && !country) country = r.country;
    if (r.sub && !sub) sub = r.sub;
  }
  if (!country && !sub) {
    // No commas: try the longest ending words ("ontario canada", "bavaria germany").
    const words = norm(raw).split(" ");
    for (let k = Math.min(4, words.length); k >= 1 && !country && !sub; k--) {
      const r = lookupPart(words.slice(-k).join(" "));
      if (r.country) country = r.country;
      if (r.sub) sub = r.sub;
      if (country && words.length > k) {
        for (let j = Math.min(3, words.length - k); j >= 1 && !sub; j--) {
          const s2 = lookupPart(words.slice(-k - j, -k).join(" "));
          if (s2.sub) sub = s2.sub;
        }
      }
    }
  }
  if (sub && country && !sub.startsWith(`${country}-`)) sub = null; // "Georgia, ..." with another country
  if (!country && sub) country = sub.split("-")[0] as string;
  return country ? make(country, sub) : null;
}
