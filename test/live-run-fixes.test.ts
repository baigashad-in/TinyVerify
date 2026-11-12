/**
 * Tests for problems seen in the first live run (11 Nov 2026):
 * Fetch's default Markdown did not parse on Companies House search pages and
 * ABN Lookup record pages, the Agent returned a page heading as the name,
 * a made-up company name came back as multiple_matches, discovery picked a
 * tax-letter page, and an empty TinyFish wallet was retried on every step.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MonitorService } from "../src/monitor/service.js";
import { MemoryStore } from "../src/monitor/store.js";
import { parseCompaniesHouseSearch } from "../src/registries/companiesHouse.js";
import { pickOfficial } from "../src/registries/discovery.js";
import { BILLING_MESSAGE, isBillingError, TinyVerifyError } from "../src/tinyfish/gateway.js";
import { verify } from "../src/verify/pipeline.js";
import { FakeGateway, fixture } from "./helpers.js";

const CH = "https://find-and-update.company-information.service.gov.uk";
const chSearch = (q: string) => `${CH}/search/companies?q=${encodeURIComponent(q)}`;
const ABR_REC = "https://abr.business.gov.au/ABN/View?abn=88000014675";
const p = (text: string, url = "https://x", links?: string[]) => ({ url, final_url: url, title: null, text, links });

/**
 * A search page as whole-page Markdown, in the shape the live dump showed:
 * each result is a list item with a heading, then the number line. No links.
 */
const PLAIN_SEARCH = [
  "## Company results",
  "78 matches found",
  "- ### EXAMPLEWORKS LIMITED",
  "Matching previous names:",
  "EXAMPLEWORKS SUPPORT SERVICES LTD.",
  "99153983 - Incorporated on 1 February 1996",
  "1 Example Road, Exampletown, EX1 1AA",
  "- ### EXAMPLEWORKS CREATIONS LTD",
  "99522306 - Incorporated on 1 April 2015",
  "2 Example Road, Exampletown, EX1 1AB",
  "- ### EXAMPLEWORKS FIVE LTD",
  "NI995706 - Dissolved on 18 November 2025",
  "Unit 4, 5 Example Road, Exampletown, BT0 0AA",
].join("\n\n");

/** The default main-content Markdown: the result names are gone, only numbers and addresses remain. */
const NAMELESS_SEARCH = [
  "## Company results",
  "99153983 - Incorporated on 1 February 1996",
  "1 Example Road, Exampletown, EX1 1AA",
  "99522306 - Incorporated on 1 April 2015",
  "2 Example Road, Exampletown, EX1 1AB",
].join("\n\n");

describe("Companies House search without links", () => {
  it("reads names and numbers from plain result lines", () => {
    const s = parseCompaniesHouseSearch(p(PLAIN_SEARCH));
    assert.equal(s.kind, "results");
    if (s.kind !== "results") return;
    assert.deepEqual(
      s.candidates.map((c) => [c.name, c.identifier]),
      [
        ["EXAMPLEWORKS LIMITED", "99153983"],
        ["EXAMPLEWORKS CREATIONS LTD", "99522306"],
        ["EXAMPLEWORKS FIVE LTD", "NI995706"],
      ],
    );
    assert.equal(s.candidates[0]?.matched_previous_name, true);
    assert.equal(s.candidates[2]?.status_raw, "Dissolved");
    assert.equal(s.total, 78);
  });

  it("does not take section titles or addresses as names when the names are missing", () => {
    const s = parseCompaniesHouseSearch(p(NAMELESS_SEARCH));
    assert.equal(s.kind, "unparsed", "unparsed, so the whole page is fetched next");
  });

  it("when Fetch returned the page links, keeps only numbers that are linked", () => {
    const s = parseCompaniesHouseSearch(p(PLAIN_SEARCH, "https://x", [`${CH}/company/99153983`, `${CH}/help`]));
    assert.equal(s.kind, "results");
    if (s.kind === "results") assert.deepEqual(s.candidates.map((c) => c.identifier), ["99153983"]);
  });
});

describe("whole-page Fetch before Agent", () => {
  it("a search page that does not parse is fetched again as the whole page, not sent to the Agent", async () => {
    const gw = new FakeGateway();
    gw.pages.set(chSearch("Exampleworks Ltd"), p("Search for a company\n\nSome navigation text only."));
    gw.fullPages.set(chSearch("Exampleworks Ltd"), p(fixture("ch-search-example.md")));
    gw.setPage(`${CH}/company/99153983`, "ch-tesco.md");
    gw.pages.set(`${CH}/company/99153983`, p(fixture("ch-tesco.md").replaceAll("TESCO PLC", "EXAMPLEWORKS LIMITED").replaceAll("00445790", "99153983")));
    const r = await verify({ name: "Exampleworks Ltd", record_type: "company", jurisdiction: "UK" }, { gateway: gw });
    assert.equal(r.outcome, "verified", r.message);
    assert.equal(gw.log.filter((l) => l.startsWith("agent")).length, 0, "no Agent run");
    assert.ok(gw.log.includes(`fetch-full ${chSearch("Exampleworks Ltd")}`));
    assert.ok(r.sources_checked.some((c) => c.step === "search" && c.outcome === "ok" && /whole page/.test(c.detail ?? "")));
  });

  it("a record page that does not parse is fetched again as the whole page", async () => {
    const gw = new FakeGateway();
    gw.pages.set(ABR_REC, p("ABN Lookup\n\nCurrent details for ABN 88 000 014 675"));
    gw.fullPages.set(ABR_REC, p(fixture("abr-woolworths.md"), ABR_REC));
    const r = await verify({ name: "Woolworths Group Limited", record_type: "abn", jurisdiction: "Australia", licence_number: "88 000 014 675" }, { gateway: gw });
    assert.equal(r.outcome, "verified", r.message);
    assert.equal(r.records[0]?.source.retrieved_via, "tinyfish_fetch");
    assert.equal(gw.log.filter((l) => l.startsWith("agent")).length, 0);
  });

  it("a bot wall is not fetched again; it goes straight to the Agent", async () => {
    const gw = new FakeGateway();
    gw.setPage(`${CH}/company/00445790`, "bot-wall.md");
    gw.agentHandler = () => ({ status: "FAILED", run_id: null, result: null, error: "SITE_BLOCKED" });
    await verify({ name: "Tesco PLC", record_type: "company", jurisdiction: "UK", licence_number: "00445790" }, { gateway: gw });
    assert.equal(gw.log.filter((l) => l.startsWith("fetch-full")).length, 0);
    assert.equal(gw.log.filter((l) => l.startsWith("agent")).length, 1);
  });

  it("Monitor escalation tries a whole-page Fetch before the Agent", async () => {
    const gw = new FakeGateway();
    gw.setPage(ABR_REC, "abr-woolworths.md");
    let clock = Date.parse("2026-11-11T10:00:00Z");
    const svc = new MonitorService({
      gateway: gw,
      store: new MemoryStore(),
      publicBaseUrl: "https://tinyverify.example.org",
      webhookSecret: "s",
      defaultCron: "CRON_TZ=UTC 41 6 * * *",
      agentEscalation: true,
      now: () => new Date((clock += 60_000)),
      log: () => {},
    });
    const { watch } = await svc.watch({ request: { name: "Woolworths Group Limited", record_type: "abn", jurisdiction: "Australia", licence_number: "88 000 014 675" } });
    // The Monitor's default Markdown loses the table; the whole page still has it.
    gw.pages.set(ABR_REC, p("ABN Lookup\n\nCurrent details for ABN 88 000 014 675", ABR_REC));
    gw.fullPages.set(ABR_REC, p(fixture("abr-woolworths.md"), ABR_REC));
    const res = await svc.handleWebhook(gw.scheduledWebhookBody(watch.monitor_id), "s");
    assert.equal(res.body.read_via, "tinyfish_monitor+fetch");
    assert.deepEqual(res.body.events, []);
    assert.equal(gw.log.filter((l) => l.startsWith("agent")).length, 0);
  });
});

describe("misread search pages", () => {
  it("results that share no word with the query are not trusted; the Agent searches instead", async () => {
    const gw = new FakeGateway();
    const q = "Exampleworks Ltd";
    // A misread page whose "names" are unrelated text.
    gw.fullPages.set(chSearch(q), p(`[GENERAL NOTICE](${CH}/company/99000201)\n\n99000201 - Incorporated on 1 May 2020`));
    gw.agentHandler = () => ({
      status: "COMPLETED",
      run_id: "s",
      error: null,
      result: { page_state: "results_list", candidates: [{ name: "EXAMPLEWORKS LIMITED", identifier: "99153983", status: "Active", record_url: `${CH}/company/99153983` }] },
    });
    gw.pages.set(`${CH}/company/99153983`, p(fixture("ch-tesco.md").replaceAll("TESCO PLC", "EXAMPLEWORKS LIMITED").replaceAll("00445790", "99153983")));
    const r = await verify({ name: q, record_type: "company", jurisdiction: "UK" }, { gateway: gw });
    assert.equal(r.outcome, "verified", r.message);
    assert.ok(r.sources_checked.some((c) => /none shares a word/.test(c.detail ?? "")));
    assert.equal(gw.log.filter((l) => l.startsWith("agent")).length, 1);
  });
});

describe("Agent name answers", () => {
  it("uses the labelled 'Entity name' field when the agent answers with the page heading", async () => {
    const gw = new FakeGateway();
    gw.agentHandler = () => ({
      status: "COMPLETED",
      run_id: "r",
      error: null,
      result: {
        page_state: "record",
        name: "ABN Lookup Record",
        identifier: "88 000 014 675",
        status_text: "Active from 01 Nov 1999",
        disciplinary_actions: [],
        other_fields: [
          { label: "Entity name", value: "WOOLWORTHS GROUP LIMITED" },
          { label: "Entity type", value: "Australian Public Company" },
        ],
      },
    });
    const r = await verify({ name: "Woolworths Group Limited", record_type: "abn", jurisdiction: "Australia", licence_number: "88 000 014 675" }, { gateway: gw });
    assert.equal(r.outcome, "verified", r.message);
    assert.equal(r.records[0]?.subject.name, "WOOLWORTHS GROUP LIMITED");
    assert.equal(r.records[0]?.details.agent_name_answer, "ABN Lookup Record", "the agent's answer is kept for audit");
  });
});

describe("made-up names", () => {
  it("candidates that share only part of the name are near misses, not multiple_matches", async () => {
    const gw = new FakeGateway();
    const results = p(`[WIDGET WORKS LIMITED](${CH}/company/99000101)\n\n99000101 - Dissolved on 25 October 2022\n\n[IMAGINARY WORKS LIMITED](${CH}/company/99000102)\n\n99000102 - Dissolved on 12 April 2016`);
    // Both name forms are searched: with and without "Ltd".
    gw.pages.set(chSearch("Zqxv Imaginary Widget Works Ltd"), results);
    gw.pages.set(chSearch("Zqxv Imaginary Widget Works"), results);
    const r = await verify({ name: "Zqxv Imaginary Widget Works Ltd", record_type: "company", jurisdiction: "UK" }, { gateway: gw });
    assert.equal(r.outcome, "no_match", r.message);
    assert.equal(r.candidates.length, 2, "shown as near misses");
  });
});

describe("discovery", () => {
  it("prefers a business search page over a tax status-letter page", () => {
    const hits = [
      { position: 1, title: "Self Serve Entity Status Letter - Franchise Tax Board - CA.gov", url: "https://webapp.ftb.ca.gov/eletter/", snippet: "", site_name: "ftb.ca.gov" },
      { position: 2, title: "bizfile Online - Business Search", url: "https://bizfileonline.sos.ca.gov/search/business", snippet: "", site_name: "sos.ca.gov" },
      { position: 3, title: "Some business directory", url: "https://www.example-directory.com/ca", snippet: "", site_name: "example" },
    ];
    assert.equal(pickOfficial(hits, "business").chosen?.host, "bizfileonline.sos.ca.gov");
  });
});

describe("empty TinyFish wallet", () => {
  it("recognises the live error text", () => {
    assert.ok(isBillingError("Run not started: the user's TinyFish wallet balance is too low ($0.00)."));
    assert.ok(isBillingError("INSUFFICIENT_CREDITS"));
    assert.equal(isBillingError("SITE_BLOCKED: captcha"), false);
  });

  it("stops the whole request after the first billing error", async () => {
    const gw = new FakeGateway();
    gw.searchHits = [{ position: 1, title: "bizfile Online", url: "https://bizfileonline.sos.ca.gov/search/business", snippet: "", site_name: "sos.ca.gov" }];
    gw.agentHandler = () => {
      throw new TinyVerifyError("tinyfish_billing", BILLING_MESSAGE);
    };
    const r = await verify({ name: "Northwind Example Ltd", record_type: "corporation", jurisdiction: "CA" }, { gateway: gw });
    assert.equal(r.outcome, "source_unavailable");
    assert.match(r.message, /no credit/);
    assert.equal(gw.log.filter((l) => l.startsWith("agent")).length, 1, "no second Agent call");
    assert.equal(gw.log.filter((l) => l.startsWith("search")).length, 0, "California discovery was not started");
  });
});
