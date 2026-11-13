/**
 * Tests for the fourth live run and dump (12 Nov 2026). Sunbiz and
 * Corporations Canada searches move from TinyFish Agent to TinyFish Fetch,
 * the Canada record parser stops reading page-wide alert text as flags, and
 * discovery skips directory pages. Page fixtures copy the layout of real
 * `npm run dump` output with invented entities; see test/fixtures/README.md.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canadaSearchUrl, corporationsCanada, parseCanadaRecord, parseCanadaSearch } from "../src/registries/corporationsCanada.js";
import { pickOfficial } from "../src/registries/discovery.js";
import { parseSunbizRecord, parseSunbizSearch, sunbiz, sunbizNameKey, sunbizSearchUrl } from "../src/registries/sunbiz.js";
import type { SearchHit } from "../src/tinyfish/gateway.js";
import type { FetchedPage } from "../src/types.js";
import { verify } from "../src/verify/pipeline.js";
import { FakeGateway, fixture } from "./helpers.js";

const p = (text: string, url = "https://x", links?: string[]): FetchedPage => ({ url, final_url: url, title: null, text, links });
const agents = (gw: FakeGateway) => gw.log.filter((l) => l.startsWith("agent")).length;

const SB = "https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResultDetail?inquirytype=EntityName&directionType=Initial";
const detail = (key: string, aggregate: string) => `${SB}&searchNameOrder=${key}&aggregateId=${aggregate}&searchTerm=x&listNameOrder=x`;
const SUNBIZ_LINKS = [
  "https://search.sunbiz.org/Inquiry/CorporationSearch/ByName",
  detail("PUBLIXSUPERMARKETS%201122521", "domp-112252-9281a312-b924-4aa8-b259-e4e9dc29322d"),
  detail("PUBLIXEXAMPLESLOGANLOGOASHOPP%20T999990", "trade-t99999-00000000-0000-0000-0000-000000000001"),
  detail("PUBLIZEXAMPLEMEDIA%20L269999999980", "flal-l26999999998-00000000-0000-0000-0000-000000000002"),
  detail("PUBLOWEXAMPLEINVESTMENTS%20L269999999970", "flal-l26999999997-00000000-0000-0000-0000-000000000003"),
];

describe("Sunbiz sort key", () => {
  it("follows the rule seen on a live list", () => {
    assert.equal(sunbizNameKey("PUBLIX SUPER MARKETS, INC."), "PUBLIXSUPERMARKETS");
    assert.equal(sunbizNameKey("Publix Super Markets"), "PUBLIXSUPERMARKETS", "same key with or without the ending");
    assert.equal(sunbizNameKey("THE PUB EXAMPLE MAKER LLC"), "PUBEXAMPLEMAKER", "leading THE and LLC dropped");
    assert.equal(sunbizNameKey("EXAMPLE TELLER & LOGO OF A HAND INSERTING A CARD"), "EXAMPLETELLERLOGOAHANDINSERTIN", "& and OF dropped, A kept, 30 characters");
    assert.equal(sunbizNameKey("O'EXAMPLE'S DRYWALL SERVICE, LLC"), "OEXAMPLESDRYWALLSERVICE", "apostrophes removed without a gap");
    assert.equal(sunbizNameKey("EXAMPLE TENANTS ASSOCIATION, CORP."), "EXAMPLETENANTSASSOCIATION");
  });

  it("builds a search URL ASP.NET accepts (no & or trailing dot in the path)", () => {
    assert.equal(
      sunbizSearchUrl("Smith & Example Co., Inc."),
      "https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResults/EntityName/Smith%20Example%20Co%20Inc/Page1?searchNameOrder=SMITHEXAMPLE",
    );
  });
});

describe("Sunbiz search list, real layouts", () => {
  it("reads rows, links each to its detail page and drops trademarks", () => {
    const s = parseSunbizSearch(p(fixture("sunbiz-search-live-layout.md"), "https://x", SUNBIZ_LINKS));
    assert.equal(s.kind, "results");
    if (s.kind !== "results") return;
    assert.deepEqual(
      s.candidates.map((c) => c.identifier),
      ["112252", "L26999999998", "L26999999997", "P26999999996", "L26999999995"],
      "the T99999 trademark row is left out",
    );
    assert.equal(s.candidates[0]?.name, "PUBLIX SUPER MARKETS, INC.");
    assert.match(s.candidates[0]?.record_url ?? "", /aggregateId=domp-112252-/);
    assert.equal(s.candidates[3]?.record_url, null, "no link, no URL");
    assert.equal(s.candidates[4]?.status_raw, "NAME HS");
  });

  it("main-content Fetch drops the header row; the rows still parse", () => {
    const text = fixture("sunbiz-search-live-layout.md").replace("| Corporate Name | Document Number | Status |", "|  |  |  |");
    const s = parseSunbizSearch(p(text));
    assert.equal(s.kind, "results");
    if (s.kind === "results") assert.equal(s.candidates.length, 6, "without links the trademark cannot be told apart");
  });
});

describe("Sunbiz record, real whole-page layout", () => {
  it("splits labels glued to their values", () => {
    const r = parseSunbizRecord(p(fixture("sunbiz-record-live-layout.md")));
    assert.ok(r.ok, r.ok ? "" : r.reason);
    if (!r.ok) return;
    assert.equal(r.record.name, "EXAMPLE MARINE SUPPLY, INC.");
    assert.equal(r.record.identifier, "P26999999999");
    assert.equal(r.record.status_raw, "INACTIVE");
    assert.equal(r.record.status, "dissolved");
    assert.equal(r.record.issue_date, "2006-11-16");
    assert.equal(r.record.details.state_of_formation, "FL");
    assert.equal(r.record.details.last_annual_report_year, "2023");
    assert.equal(r.record.identifiers.fei_ein, undefined, "NONE is not an EIN");
    assert.ok(r.record.compliance_flags.some((f) => f.code === "administrative_dissolution"));
    assert.ok(!JSON.stringify(r.record).includes("PAT"), "officer and agent names are not extracted");
  });

  it("leaves ordinary words alone and only reads the Filing Information block", () => {
    const text = fixture("sunbiz-record-live-layout.md").replace("Principal Address", "Principal Address\nStatement of change filed");
    const r = parseSunbizRecord(p(text));
    assert.ok(r.ok && r.record.status_raw === "INACTIVE");
  });

  it("only the whole page is read for records", () => {
    assert.deepEqual(sunbiz.recordFetchModes, ["full"]);
  });
});

const SUNBIZ_REC = detail("EXAMPLEMARINESUPPLY%20P269999999990", "domp-p26999999999-00000000-0000-0000-0000-000000000009");
const SUNBIZ_LIST = [
  "## Entity Name List",
  "",
  "| Corporate Name | Document Number | Status |",
  "| :-- | :-- | :-- |",
  "| EXAMPLE MARINE SUPPLY, INC. | P26999999999 | INACT |",
  "| EXAMPLE MARINE SURVEYS LLC | L26999999993 | Active |",
].join("\n");

describe("Sunbiz verify with Fetch", () => {
  it("verifies by name with Fetch only, no Agent run", async () => {
    const gw = new FakeGateway();
    const req = "Example Marine Supply, Inc.";
    gw.pages.set(sunbizSearchUrl(req), p(SUNBIZ_LIST, sunbizSearchUrl(req), [SUNBIZ_REC]));
    gw.fullPages.set(SUNBIZ_REC, p(fixture("sunbiz-record-live-layout.md"), SUNBIZ_REC));
    const r = await verify({ name: req, record_type: "corporation", jurisdiction: "Florida" }, { gateway: gw });
    assert.equal(r.outcome, "verified", r.message);
    assert.equal(r.records[0]?.status.normalized, "dissolved");
    assert.equal(r.records[0]?.source.url, SUNBIZ_REC);
    assert.equal(r.records[0]?.source.retrieved_via, "tinyfish_fetch");
    assert.equal(agents(gw), 0);
  });

  it("a list with no close name is confirmed once with the Agent, not reported from the list", async () => {
    const gw = new FakeGateway();
    const req = "Zqxv Example Holdings, LLC";
    gw.pages.set(sunbizSearchUrl(req), p(fixture("sunbiz-search-live-layout.md"), sunbizSearchUrl(req), SUNBIZ_LINKS));
    gw.agentHandler = () => ({ status: "COMPLETED", run_id: "r1", error: null, result: { page_state: "no_results", candidates: [] } });
    const r = await verify({ name: req, record_type: "corporation", jurisdiction: "Florida" }, { gateway: gw });
    assert.equal(r.outcome, "no_match", r.message);
    assert.equal(agents(gw), 1, "one Agent confirmation, not one per name form");
    assert.equal(gw.log.filter((l) => l.includes("/SearchResults/EntityName/")).length, 1, "both name forms share one sort key, so one list read");
    assert.ok(r.sources_checked.some((s) => s.method === "tinyfish_fetch" && /no close name/.test(s.detail ?? "")));
  });

  it("if the Agent confirmation cannot run, the answer is source_unavailable, not no_match", async () => {
    const gw = new FakeGateway();
    const req = "Zqxv Example Holdings, LLC";
    gw.pages.set(sunbizSearchUrl(req), p(fixture("sunbiz-search-live-layout.md"), sunbizSearchUrl(req), SUNBIZ_LINKS));
    gw.agentHandler = () => ({ status: "FAILED", run_id: null, result: null, error: "site error" });
    const r = await verify({ name: req, record_type: "corporation", jurisdiction: "Florida" }, { gateway: gw });
    assert.equal(r.outcome, "source_unavailable", r.message);
    assert.match(r.message, /does not report no_match from the list alone/);
  });
});

const CANADA_DEFAULT = [
  "# Search for a Federal Corporation",
  "",
  "## Search Results",
  "",
  "Searched for:",
  "Corporate name: Northwind Example Trading",
  "",
  "1 result was found, 1 returned.",
  "",
  "Results 1-1",
  "",
  "* 1.Northwind Example Trading Inc.  ",
  "  Commerce Exemple Northwind Inc.  ",
  "  Status: Active  ",
  "  Corporation number: 000000-0  ",
  "  Business Number: 000000000RC0001",
  "",
  "* Date Modified:",
].join("\n");

describe("Corporations Canada search, real layouts", () => {
  it("reads the whole-page layout (labels and values on separate lines)", () => {
    const s = parseCanadaSearch(p(fixture("canada-search-live-layout.md")));
    assert.equal(s.kind, "results");
    if (s.kind !== "results") return;
    assert.equal(s.total, 2);
    assert.deepEqual(
      s.candidates.map((c) => [c.name, c.identifier, c.status_raw]),
      [
        ["Canadian National Railway Company", "010533-3", "Active"],
        ["CANADIAN NATIONAL EXAMPLE RAILWAY HOLDINGS INC.", "000000-0", "Dissolved for non-compliance (s. 212) on 2025-12-08"],
      ],
    );
    assert.equal(s.candidates[0]?.record_url, "https://ised-isde.canada.ca/cc/lgcy/fdrlCrpDtls.html?corpId=0105333");
    assert.equal(s.candidates[0]?.snippet, "Also: Compagnie des chemins de fer nationaux du Canada");
  });

  it("reads the main-content layout (number glued to the name)", () => {
    const s = parseCanadaSearch(p(CANADA_DEFAULT));
    assert.equal(s.kind, "results");
    if (s.kind !== "results") return;
    assert.equal(s.total, 1);
    assert.equal(s.candidates[0]?.name, "Northwind Example Trading Inc.");
    assert.equal(s.candidates[0]?.identifier, "000000-0");
  });

  it("an empty list is a conclusive no result", () => {
    const s = parseCanadaSearch(p("## Search Results\n\n0 results were found, 0 returned."));
    assert.equal(s.kind, "no_results");
  });

  it("uses the GET search URL", () => {
    assert.equal(
      canadaSearchUrl("Northwind Example"),
      "https://ised-isde.canada.ca/cc/lgcy/fdrlCrpSrch.html?p=0&crpNm=Northwind%20Example&crpNmbr=&bsNmbr=&cProv=&cStatus=&cAct=",
    );
  });
});

describe("Corporations Canada record, real layout", () => {
  it("flags overdue filings from the year rows, not from the alert text every page carries", () => {
    const r = parseCanadaRecord(p(fixture("canada-record-live-layout.md")));
    assert.ok(r.ok, r.ok ? "" : r.reason);
    if (!r.ok) return;
    assert.equal(r.record.name, "Northwind Example Trading Inc.");
    assert.equal(r.record.identifier, "0000000");
    assert.equal(r.record.status, "active");
    assert.deepEqual(r.record.compliance_flags.map((f) => f.code), ["annual_filings_overdue"]);
    assert.match(r.record.compliance_flags[0]?.description ?? "", /2026, 2025/);
    assert.equal(r.record.details.status_of_annual_filings, "2026 Overdue; 2025 Overdue; 2024 Filed");
    assert.equal(r.record.details.registered_office_address, "1 Example Street, Exampletown PE A0A 0A0, Canada");
  });

  it("a compliant corporation gets no flag even though the alert text is on the page (v6 false alert)", () => {
    const text = fixture("canada-record-live-layout.md").replace(/\*\*Overdue\*\*/g, "**Filed**");
    assert.match(text, /notice of its intent to dissolve/, "the template text is still there");
    const r = parseCanadaRecord(p(text));
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.record.compliance_flags, []);
  });

  it("a dissolved status gets its date", () => {
    const text = fixture("canada-record-live-layout.md").replace("**Status:**\n\nActive", "**Status:**\n\nDissolved for non-compliance (s. 212) on 2025-12-08");
    const r = parseCanadaRecord(p(text));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.record.status, "dissolved");
    assert.equal(r.record.status_effective_date, "2025-12-08");
  });

  it("a search result list is not read as a record", () => {
    const r = parseCanadaRecord(p(fixture("canada-search-live-layout.md")));
    assert.ok(!r.ok);
  });
});

describe("Corporations Canada verify with Fetch", () => {
  it("verifies by name with Fetch only, no Agent run", async () => {
    const gw = new FakeGateway();
    const req = "Northwind Example Trading Inc.";
    gw.pages.set(canadaSearchUrl(req), p(CANADA_DEFAULT, canadaSearchUrl(req)));
    const rec = corporationsCanada.recordUrl("0000000") as string;
    gw.pages.set(rec, p(fixture("canada-record-live-layout.md"), rec));
    const r = await verify({ name: req, record_type: "corporation", jurisdiction: "Canada" }, { gateway: gw });
    assert.equal(r.outcome, "verified", r.message);
    assert.equal(r.records[0]?.licence_number, "0000000");
    assert.equal(agents(gw), 0);
  });
});

describe("discovery skips directory pages", () => {
  const hit = (position: number, title: string, url: string): SearchHit => ({ position, title, url, snippet: "", site_name: "" });

  it("a state portal's agency card is not a register search (live run: ca.gov/departments/275)", () => {
    const picked = pickOfficial([hit(1, "Secretary of State (SOS)", "https://www.ca.gov/departments/275/")], "business");
    assert.equal(picked.chosen, null);
    assert.deepEqual(picked.skippedOfficial, ["ca.gov"]);
  });

  it("the search page itself is still chosen", () => {
    const hits = [
      hit(1, "Secretary of State (SOS)", "https://www.ca.gov/departments/275/"),
      hit(2, "bizfile Online - Business Search", "https://bizfileonline.sos.ca.gov/search/business"),
    ];
    assert.equal(pickOfficial(hits, "business").chosen?.host, "bizfileonline.sos.ca.gov");
    const ny = [hit(1, "Corporation and Business Entity Search Database", "https://dos.ny.gov/corporation-and-business-entity-search-database")];
    assert.equal(pickOfficial(ny, "business").chosen?.host, "dos.ny.gov");
  });
});

describe("discovered registries stop after one failed Agent search", () => {
  const bizfile: SearchHit = { position: 1, title: "bizfile Online - Business Search", url: "https://bizfileonline.sos.ca.gov/search/business", snippet: "", site_name: "" };

  it("a timeout at a discovered page is not repeated for the next name form (live run: two 5-minute timeouts)", async () => {
    const gw = new FakeGateway();
    gw.searchHits = [bizfile];
    gw.agentHandler = () => {
      throw new Error("Request timed out after 300000ms");
    };
    const r = await verify({ name: "Northwind Example Ltd", record_type: "corporation", jurisdiction: "California" }, { gateway: gw });
    assert.equal(r.outcome, "source_unavailable", r.message);
    assert.equal(agents(gw), 1);
  });

  it("a page the Agent reports as an error is not retried with another name form (live run: New York)", async () => {
    const gw = new FakeGateway();
    gw.searchHits = [bizfile];
    gw.agentHandler = () => ({ status: "COMPLETED", run_id: "r", error: null, result: { page_state: "error", candidates: [] } });
    const r = await verify({ name: "Northwind Example Ltd", record_type: "corporation", jurisdiction: "California" }, { gateway: gw });
    assert.equal(r.outcome, "source_unavailable", r.message);
    assert.equal(agents(gw), 1);
  });
});

describe("curated registries keep trying after a failed search", () => {
  it("Sunbiz: if the list cannot be read and the Agent times out, the next name form is still tried (v6 live run)", async () => {
    const gw = new FakeGateway();
    let n = 0;
    gw.agentHandler = () => {
      n += 1;
      if (n === 1) throw new Error("Request timed out after 300000ms");
      return { status: "COMPLETED", run_id: "r2", error: null, result: { page_state: "no_results", candidates: [] } };
    };
    const r = await verify({ name: "Example Marine Supply, Inc.", record_type: "corporation", jurisdiction: "Florida" }, { gateway: gw });
    assert.equal(agents(gw), 2, "second name form searched after the timeout");
    assert.equal(r.outcome, "source_unavailable", "one form unread, so no no_match");
  });
});
