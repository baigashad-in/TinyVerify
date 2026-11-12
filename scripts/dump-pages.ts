/**
 * Save what TinyFish Fetch returns for registry pages, and whether the
 * parsers can read it. Use this when a live run shows "unparsed" so the
 * parser can be fixed against the real Fetch output.
 *
 *   npm run dump                      the default pages (large public companies)
 *   npm run dump -- <url> [<url>...]  your own pages
 *
 * For each URL it saves two versions to samples/raw/<date>/:
 *   *.default.md  Fetch's normal main-content Markdown (what Monitor sees)
 *   *.full.md     the whole <body> (include_selectors: ["body"])
 *   *.links.txt   the links Fetch found on the page
 *
 * Only TinyFish Fetch is used (no Agent runs). TinyFish documents Fetch as
 * free up to 1,000 URLs a day. samples/raw/ is git-ignored: these files hold
 * whole registry pages, so check them before sharing.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadDotEnv } from "../src/config.js";
import { ADAPTERS } from "../src/registries/index.js";
import { SdkGateway, type FetchOutcome } from "../src/tinyfish/gateway.js";
import { isOnDomains } from "../src/util/text.js";

const DEFAULT_URLS = [
  "https://find-and-update.company-information.service.gov.uk/search/companies?q=Tesco%20PLC",
  "https://find-and-update.company-information.service.gov.uk/company/00445790",
  "https://abr.business.gov.au/ABN/View?abn=88000014675",
  "https://abr.business.gov.au/Search/ResultsActive?SearchText=Woolworths%20Group%20Limited",
  // Probes for the next parsers. These URL patterns were read from links in
  // live results (12 Nov 2026); whether they return results through Fetch is
  // exactly what this dump checks.
  "https://abr.business.gov.au/Search/ResultsAll?SearchText=Woolworths%20Group%20Limited",
  "https://ised-isde.canada.ca/cc/lgcy/fdrlCrpSrch.html?p=0&crpNm=Canadian%20National%20Railway&crpNmbr=&bsNmbr=&cProv=&cStatus=&cAct=",
  "https://ised-isde.canada.ca/cc/lgcy/fdrlCrpDtls.html?corpId=0105333",
  "https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResults/EntityName/Publix%20Super%20Markets/Page1?searchNameOrder=PUBLIXSUPERMARKETS",
  "https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResultDetail?inquirytype=EntityName&directionType=Initial&searchNameOrder=PUBLIXSUPERMARKETS%201122521&aggregateId=domp-112252-9281a312-b924-4aa8-b259-e4e9dc29322d&searchTerm=Publix%20Super%20Markets%2C%20Inc.&listNameOrder=PUBLIXSUPERMARKETS%201122521",
];

loadDotEnv();
const gw = new SdkGateway(process.env.TINYFISH_API_KEY);
const urls = process.argv.slice(2).filter((a) => /^https?:\/\//.test(a));
const dir = join("samples", "raw", new Date().toISOString().slice(0, 10));
await mkdir(dir, { recursive: true });

function slug(url: string): string {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90);
}

function tryParsers(url: string, f: FetchOutcome): string {
  if (!f.page?.text) return `no text (${f.error ?? "unknown error"})`;
  const adapter = ADAPTERS.find((a) => isOnDomains(url, a.officialDomains));
  if (!adapter) return "no curated parser for this domain";
  const rec = adapter.parseRecord(f.page);
  if (rec.ok) return `record parser OK: name=${JSON.stringify(rec.record.name)} number=${rec.record.identifier} status=${JSON.stringify(rec.record.status_raw)}`;
  let out = `record parser: ${rec.reason}`;
  if (adapter.search.mode === "fetch") {
    const s = adapter.search.parse(f.page);
    out += s.kind === "results" ? ` | search parser OK: ${s.candidates.length} results, first ${JSON.stringify(s.candidates[0]?.name)}` : ` | search parser: ${s.kind === "unparsed" ? s.reason : "no results"}`;
  }
  return out;
}

for (const url of urls.length ? urls : DEFAULT_URLS) {
  const base = join(dir, slug(url));
  for (const mode of ["default", "full"] as const) {
    let f: FetchOutcome;
    try {
      f = await gw.fetchPage(url, mode === "full" ? { fullPage: true } : { links: true });
    } catch (err) {
      console.log(JSON.stringify({ url, mode, error: err instanceof Error ? err.message : String(err) }));
      continue;
    }
    await writeFile(`${base}.${mode}.md`, f.page?.text ?? `(no text: ${f.error ?? "unknown"})`);
    if (f.page?.links?.length) await writeFile(`${base}.${mode}.links.txt`, f.page.links.join("\n"));
    console.log(JSON.stringify({ url, mode, chars: f.page?.text?.length ?? 0, links: f.page?.links?.length ?? 0, parse: tryParsers(url, f) }));
  }
}
console.log(`\nSaved to ${dir}. If a parser failed, send the matching .md file so the parser can be fixed.`);
