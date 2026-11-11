import type { NormalizedStatus } from "../types.js";
import type { SearchHit } from "../tinyfish/gateway.js";
import { hostOf } from "../util/text.js";

/**
 * Government domain suffixes accepted as official sources. A registry found
 * by search is only used when its host ends in one of these, or is a
 * statutory regulator in the allowlist below.
 */
const GOV_SUFFIXES = [
  ".gov", ".mil", ".gov.uk", ".gov.scot", ".gov.wales", ".nhs.uk", ".gov.au", ".gc.ca", ".canada.ca", ".gov.on.ca",
  ".gov.bc.ca", ".alberta.ca", ".quebec.ca", ".govt.nz", ".gov.ie", ".gov.sg", ".gov.in", ".nic.in", ".gov.za",
  ".gov.ph", ".gov.my", ".go.jp", ".go.kr", ".gov.hk", ".gob.mx", ".gouv.fr", ".gov.br", ".europa.eu", ".admin.ch",
  ".gv.at", ".bund.de", ".gob.es", ".gov.it", ".gov.pl", ".gov.ng", ".go.ke", ".gov.ae", ".gov.sa",
];

/** US state government hosts such as "dca.ca.gov" are covered by ".gov"; older "state.xx.us" hosts too. */
const US_STATE_HOST = /(^|\.)(state|dos|sos|dor|dol)\.[a-z]{2}\.us$|\.[a-z]{2}\.us$/;

/** Statutory regulators that publish official registers outside government domains. */
const REGULATOR_ALLOWLIST = [
  "gmc-uk.org", "nmc.org.uk", "hcpc-uk.org", "gdc-uk.org", "pharmacyregulation.org", "sra.org.uk", "fca.org.uk",
  "register.fca.org.uk", "rics.org", "ahpra.gov.au", "cpso.on.ca", "cmq.org", "cpsbc.ca", "cpsa.ca", "mcnz.org.nz",
  "medicalcouncil.ie", "finra.org", "brokercheck.finra.org", "nmls.consumeraccess.org", "nursys.com",
];

const AGGREGATOR_BLOCKLIST = [
  "opencorporates.com", "bizapedia.com", "buzzfile.com", "dnb.com", "zoominfo.com", "yelp.com", "bbb.org", "healthgrades.com",
  "vitals.com", "webmd.com", "npiprofile.com", "npidb.org", "apify.com", "linkedin.com", "facebook.com", "wikipedia.org",
];

export function isOfficialHost(host: string | null): boolean {
  if (!host) return false;
  const h = host.toLowerCase().replace(/^www\./, "");
  if (AGGREGATOR_BLOCKLIST.some((d) => h === d || h.endsWith(`.${d}`))) return false;
  if (REGULATOR_ALLOWLIST.some((d) => h === d || h.endsWith(`.${d}`))) return true;
  if (GOV_SUFFIXES.some((s) => h.endsWith(s) || h === s.slice(1))) return true;
  return US_STATE_HOST.test(h);
}

const US_STATES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida", "georgia",
  "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland",
  "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire",
  "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania",
  "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont", "virginia", "washington",
  "west virginia", "wisconsin", "wyoming", "district of columbia", "puerto rico",
];

/**
 * US registries write dates month first (03/04/2027 is 4 March). Hosts ending
 * in ".gov" or ".us" are US government; "US-OH"-style codes and state names
 * count too. Everything else is read day first.
 */
export function usesMonthFirstDates(host: string | null, jurisdiction: string): boolean {
  const h = (host ?? "").toLowerCase();
  if (h.endsWith(".gov") || h.endsWith(".us") || h === "nursys.com" || h.endsWith("finra.org") || h === "nmls.consumeraccess.org") return true;
  const j = ` ${jurisdiction.toLowerCase().replace(/[^a-z]+/g, " ").trim()} `;
  if (/ (us|usa|united states|united states of america) /.test(j)) return true;
  return US_STATES.some((s) => j.includes(` ${s} `));
}

export function discoveryQuery(recordType: string, jurisdiction: string): string {
  const t = recordType.toLowerCase();
  const licenceish = /licen[cs]e|licensing|board|doctor|nurse|physician|contractor|lawyer|attorney|pharmac|dentist|engineer|architect|realtor|real estate|electrician|plumber/.test(t);
  if (licenceish) return `${jurisdiction} ${recordType} license verification lookup official board`;
  return /business|entity|company|corporation/.test(t)
    ? `${jurisdiction} official ${recordType} search registry`
    : `${jurisdiction} official ${recordType} business entity search registry`;
}

export interface DiscoveredRegistry {
  host: string;
  url: string;
  title: string;
  snippet: string;
}

/** First official result; null when search found only unofficial sites. */
/** Signs that an official page is a register search rather than a form, letter or tax service. */
const GOOD_SIGNS: Record<"business" | "licence", RegExp> = {
  business: /\b(sos|secretary of state|bizfile|business (entity |name )?search|entity search|corporations?( division)?|company search|business search|registry)\b/i,
  licence: /\b(licen[cs]e (lookup|search|verification)|verify a licen[cs]e|verification|lookup|registry|register)\b/i,
};
const BAD_SIGNS = /\b(tax|franchise tax|e-?letter|status letter|forms?|pdf|faq|news|press release|jobs?|careers?)\b/i;

/**
 * Choose the best official result, not just the first one. Results are
 * official-domain first (unofficial sites are never chosen), then ranked by
 * whether the title, URL and snippet look like a register search for this
 * kind of record. Search order breaks ties. A live run picked California's
 * Franchise Tax Board "Entity Status Letter" page for a corporation search;
 * that page now ranks below a Secretary of State business search.
 */
export function pickOfficial(
  hits: SearchHit[],
  kind: "business" | "licence" = "licence",
): { chosen: DiscoveredRegistry | null; rejected: string[] } {
  const rejected: string[] = [];
  const official: { h: SearchHit; host: string; score: number }[] = [];
  for (const h of [...hits].sort((a, b) => a.position - b.position)) {
    const host = hostOf(h.url);
    if (isOfficialHost(host)) {
      const text = `${host} ${h.url} ${h.title} ${h.snippet ?? ""}`;
      official.push({ h, host: (host ?? "").replace(/^www\./, ""), score: (GOOD_SIGNS[kind].test(text) ? 2 : 0) - (BAD_SIGNS.test(text) ? 1 : 0) });
    } else if (host) {
      rejected.push(host);
    }
  }
  const best = official.reduce<(typeof official)[number] | null>((a, b) => (!a || b.score > a.score ? b : a), null);
  if (!best) return { chosen: null, rejected };
  return { chosen: { host: best.host, url: best.h.url, title: best.h.title, snippet: best.h.snippet }, rejected };
}

/** Keyword mapping used for registries without a curated parser. */
export function genericNormalizeStatus(raw: string): NormalizedStatus {
  const s = raw.toLowerCase();
  if (/revok|erased|erasure/.test(s)) return "revoked";
  if (/suspend/.test(s)) return "suspended";
  if (/expir|lapsed/.test(s)) return "expired";
  if (/dissolv|struck off/.test(s)) return "dissolved";
  if (/cancel|surrender|retired|withdrawn/.test(s)) return "cancelled";
  if (/liquidation|receivership|administration|bankrupt/.test(s)) return "insolvency";
  if (/not registered|no record/.test(s)) return "not_registered";
  if (/inactive|delinquent|not in good standing|forfeit/.test(s)) return "inactive";
  if (/\b(active|current|clear|in good standing|good standing|valid|registered|licensed)\b/.test(s)) return "active";
  return "unknown";
}
