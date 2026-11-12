/**
 * Tests for the second and third live runs (12 Nov 2026). The page fixtures
 * copy the layout of real `npm run dump` output; see test/fixtures/README.md.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { abr, parseAbrSearch } from "../src/registries/abr.js";
import { companiesHouse, parseCompaniesHouseSearch } from "../src/registries/companiesHouse.js";
import { discoveryQuery, pickOfficial } from "../src/registries/discovery.js";
import type { FetchOptions, FetchOutcome } from "../src/tinyfish/gateway.js";
import { verify } from "../src/verify/pipeline.js";
import { FakeGateway, fixture } from "./helpers.js";

const p = (text: string, url = "https://x") => ({ url, final_url: url, title: null, text });
const ABR_REC = "https://abr.business.gov.au/ABN/View?abn=88000014675";

describe("Companies House search, real whole-page layout", () => {
  it("reads every result, including branches, overseas companies and liquidation", () => {
    const s = parseCompaniesHouseSearch(p(fixture("ch-search-live-layout.md")));
    assert.equal(s.kind, "results");
    if (s.kind !== "results") return;
    assert.deepEqual(
      s.candidates.map((c) => c.identifier),
      ["00445790", "99384423", "99888957", "BR990975", "99701640", "FC990640", "BR991709"],
    );
    assert.equal(s.candidates[0]?.name, "TESCO PLC");
    assert.equal(s.candidates[0]?.matched_previous_name, true);
    assert.equal(s.candidates[2]?.status_raw, "Dissolved");
    assert.equal(s.candidates[3]?.status_raw, "Closed");
    assert.equal(s.candidates[4]?.status_raw, "Incorporated on 31 March 2017 - Liquidation", "liquidation is kept");
    assert.equal(s.total, 356);
  });

  it("only the whole page is fetched for searches", async () => {
    assert.deepEqual(companiesHouse.search.mode === "fetch" ? companiesHouse.search.fetchModes : null, ["full"]);
    const gw = new FakeGateway();
    const url = `https://find-and-update.company-information.service.gov.uk/search/companies?q=${encodeURIComponent("Tesco PLC")}`;
    gw.fullPages.set(url, p(fixture("ch-search-live-layout.md")));
    gw.setPage("https://find-and-update.company-information.service.gov.uk/company/00445790", "ch-tesco.md");
    const r = await verify({ name: "Tesco PLC", record_type: "company", jurisdiction: "UK" }, { gateway: gw });
    assert.equal(r.outcome, "verified", r.message);
    assert.equal(gw.log.filter((l) => l.startsWith(`fetch ${url}`)).length, 0, "no default read of the search page");
    assert.equal(gw.log.filter((l) => l.startsWith("agent")).length, 0);
  });
});

describe("ABN Lookup search, real whole-page layout", () => {
  it("reads the result table without links and keeps the entity name for an ABN", () => {
    const s = parseAbrSearch(p(fixture("abr-search-live-layout.md")));
    assert.equal(s.kind, "results");
    if (s.kind !== "results") return;
    const byAbn = new Map(s.candidates.map((c) => [c.identifier, c]));
    assert.equal(byAbn.get("88000014675")?.name, "WOOLWORTHS GROUP LIMITED", "entity name wins over the business name row");
    assert.equal(byAbn.get("88000014675")?.location, "2153 NSW");
    assert.equal(byAbn.get("59990000003")?.name, "BIG X", "a short name is not replaced by the postcode cell");
    assert.equal(s.candidates.length, 4);
  });

  it("verifies by name with Fetch only, no Agent run", async () => {
    const gw = new FakeGateway();
    if (abr.search.mode !== "fetch") throw new Error("expected fetch search");
    gw.fullPages.set(abr.search.url("Woolworths Group Limited", "business"), p(fixture("abr-search-live-layout.md")));
    gw.fullPages.set(ABR_REC, p(fixture("abr-woolworths.md"), ABR_REC));
    const r = await verify({ name: "Woolworths Group Limited", record_type: "business registration", jurisdiction: "NSW" }, { gateway: gw });
    assert.equal(r.outcome, "verified", r.message);
    assert.equal(r.records[0]?.licence_number, "88000014675");
    assert.equal(gw.log.filter((l) => l.startsWith("agent")).length, 0);
    assert.equal(gw.log.filter((l) => l.startsWith("fetch ")).length, 0, "ABN pages are only read as the whole page");
  });

  it("record evidence has no stray line breaks", async () => {
    const gw = new FakeGateway();
    gw.fullPages.set(ABR_REC, p(fixture("abr-woolworths.md"), ABR_REC));
    const r = await verify({ name: "Woolworths Group Limited", record_type: "abn", jurisdiction: "Australia", licence_number: "88 000 014 675" }, { gateway: gw });
    assert.ok(r.records[0]?.source.evidence.every((e) => !/\n/.test(e)));
  });
});

describe("transient Fetch errors", () => {
  it("retries a whole-page read once after proxy_error instead of paying for an Agent run", async () => {
    class FlakyGateway extends FakeGateway {
      failedOnce = false;
      override async fetchPage(url: string, opts: FetchOptions = {}): Promise<FetchOutcome> {
        if (opts.fullPage && !this.failedOnce) {
          this.failedOnce = true;
          this.log.push(`fetch-full ${url}`);
          return { page: null, error: "proxy_error" };
        }
        return super.fetchPage(url, opts);
      }
    }
    const gw = new FlakyGateway();
    gw.fullPages.set(ABR_REC, p(fixture("abr-woolworths.md"), ABR_REC));
    const r = await verify({ name: "Woolworths Group Limited", record_type: "abn", jurisdiction: "Australia", licence_number: "88 000 014 675" }, { gateway: gw });
    assert.equal(r.outcome, "verified", r.message);
    assert.equal(r.records[0]?.source.retrieved_via, "tinyfish_fetch");
    assert.equal(gw.log.filter((l) => l.startsWith("agent")).length, 0);
  });
});

describe("Agent 'no results' that is really a failed search", () => {
  it("is source_unavailable, not no_match (New York, live run)", async () => {
    const gw = new FakeGateway();
    gw.searchHits = [{ position: 1, title: "Public Inquiry - New York State Department of State", url: "https://apps.dos.ny.gov/publicInquiry/", snippet: "", site_name: "ny.gov" }];
    gw.agentHandler = () => ({
      status: "COMPLETED",
      run_id: "r",
      error: null,
      result: {
        page_state: "no_results",
        no_results_message:
          "The search could not be completed. The page displayed a loading spinner but no results or error messages were returned. This may indicate a technical issue.",
        candidates: [],
      },
    });
    const r = await verify({ name: "Example Corp Inc.", record_type: "business entity", jurisdiction: "New York" }, { gateway: gw });
    assert.equal(r.outcome, "source_unavailable", r.message);
    assert.ok(r.sources_checked.some((c) => /agent said no results, but/.test(c.detail ?? "")));
  });

  it("a real registry no-results message is still a no_match", async () => {
    const gw = new FakeGateway();
    gw.searchHits = [{ position: 1, title: "Public Inquiry - New York State Department of State", url: "https://apps.dos.ny.gov/publicInquiry/", snippet: "", site_name: "ny.gov" }];
    gw.agentHandler = () => ({ status: "COMPLETED", run_id: "r", error: null, result: { page_state: "no_results", no_results_message: "No business entities were found.", candidates: [] } });
    const r = await verify({ name: "Example Corp Inc.", record_type: "business entity", jurisdiction: "New York" }, { gateway: gw });
    assert.equal(r.outcome, "no_match", r.message);
  });
});

describe("discovery picks register searches, not information pages", () => {
  it("asks for the Secretary of State search for US companies", () => {
    assert.equal(discoveryQuery("corporation", "California, United States"), "California Secretary of State business entity search");
    assert.match(discoveryQuery("nurse licence", "Texas"), /license verification/);
  });

  it("skips a city information page and starts no Agent run when nothing looks like a register", async () => {
    const info = { position: 1, title: "California state business registration", url: "https://www.sf.gov/information--california-state-business-registration", snippet: "Register with the California Secretary of State.", site_name: "sf.gov" };
    const picked = pickOfficial([info], "business");
    assert.equal(picked.chosen, null);
    assert.deepEqual(picked.skippedOfficial, ["sf.gov"]);

    const gw = new FakeGateway();
    gw.searchHits = [info];
    const r = await verify({ name: "Example Corp Inc.", record_type: "corporation", jurisdiction: "California" }, { gateway: gw });
    assert.equal(r.outcome, "unsupported");
    assert.match(r.message, /none looked like a register search/);
    assert.equal(gw.log.filter((l) => l.startsWith("agent")).length, 0);
  });

  it("chooses the Secretary of State search when it is in the results", () => {
    const hits = [
      { position: 1, title: "California state business registration", url: "https://www.sf.gov/information--california-state-business-registration", snippet: "", site_name: "sf.gov" },
      { position: 2, title: "bizfile Online", url: "https://bizfileonline.sos.ca.gov/search/business", snippet: "", site_name: "ca.gov" },
    ];
    assert.equal(pickOfficial(hits, "business").chosen?.host, "bizfileonline.sos.ca.gov");
  });
});
