import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { abr } from "../src/registries/abr.js";
import { companiesHouse } from "../src/registries/companiesHouse.js";
import { gmc } from "../src/registries/gmc.js";
import { VerifyResultSchema } from "../src/types.js";
import { verify } from "../src/verify/pipeline.js";
import { FakeGateway, FIXED_NOW, fixture } from "./helpers.js";

const CH = "https://find-and-update.company-information.service.gov.uk";

function chSearchUrl(q: string) {
  return companiesHouse.search.mode === "fetch" ? companiesHouse.search.url(q, "business") : "";
}

function exampleworksRecordText() {
  return fixture("ch-tesco.md").replaceAll("TESCO PLC", "EXAMPLEWORKS LIMITED").replaceAll("00445790", "99153983");
}

describe("verify: identifier path", () => {
  it("verifies a UK company by number with TinyFish Fetch and the parser", async () => {
    const gw = new FakeGateway();
    gw.setPage(`${CH}/company/00445790`, "ch-tesco.md", "TESCO PLC overview - Find and update company information - GOV.UK");
    const r = await verify({ name: "Tesco PLC", record_type: "company", jurisdiction: "UK", licence_number: "445790" }, { gateway: gw, now: FIXED_NOW });
    assert.equal(r.outcome, "verified");
    VerifyResultSchema.parse(r); // output always matches the published schema
    const rec = r.records[0];
    assert.equal(rec?.status.normalized, "active");
    assert.equal(rec?.licence_number, "00445790");
    assert.equal(rec?.source.url, `${CH}/company/00445790`);
    assert.equal(rec?.source.retrieved_via, "tinyfish_fetch");
    assert.equal(rec?.source.extraction, "deterministic_parser");
    assert.ok(rec?.source.content_sha256);
    assert.equal(rec?.match.method, "identifier");
    assert.equal(rec?.checked_at, "2026-11-04T10:00:00.000Z");
    assert.deepEqual(r.tinyfish_calls.map((c) => c.endpoint), ["fetch"]);
  });

  it("reports a name mismatch instead of verifying the wrong entity", async () => {
    const gw = new FakeGateway();
    gw.setPage(`${CH}/company/00445790`, "ch-tesco.md");
    const r = await verify({ name: "Sainsbury's Supermarkets Ltd", record_type: "company", jurisdiction: "UK", licence_number: "00445790" }, { gateway: gw });
    assert.equal(r.outcome, "name_mismatch");
    assert.equal(r.records.length, 1);
    assert.equal(r.records[0]?.match.name_matches_request, false);
  });

  it("rejects an identifier in the wrong format", async () => {
    const gw = new FakeGateway();
    const r = await verify({ name: "Woolworths", record_type: "abn", jurisdiction: "Australia", licence_number: "88 000 014 676" }, { gateway: gw });
    assert.equal(r.outcome, "invalid_input");
    assert.match(r.message, /not a valid ABN/);
    assert.equal(gw.log.length, 0, "no TinyFish call for an invalid number");
  });

  it("falls back to TinyFish Agent when Fetch hits a bot wall", async () => {
    const gw = new FakeGateway();
    gw.setPage(gmc.recordUrl("9912345") as string, "bot-wall.md");
    gw.agentHandler = (p) => {
      assert.equal(p.url, gmc.recordUrl("9912345"));
      assert.ok(p.stealth, "GMC agent runs use the stealth browser");
      return {
        status: "COMPLETED",
        run_id: "run_abc",
        error: null,
        result: {
          page_state: "record",
          name: "Jane EXAMPLE",
          identifier: "9912345",
          status_text: "Registered with a licence to practise",
          renewal_due_date: "23 Apr 2027",
          disciplinary_actions: [],
          record_url: "https://www.gmc-uk.org/registrants/9912345",
          evidence_quote: "Registered with a licence to practise",
        },
      };
    };
    const r = await verify({ name: "Dr Jane Example", record_type: "doctor", jurisdiction: "England", licence_number: "9912345" }, { gateway: gw });
    assert.equal(r.outcome, "verified");
    const rec = r.records[0];
    assert.equal(rec?.source.retrieved_via, "tinyfish_agent");
    assert.equal(rec?.source.extraction, "agent_structured_output");
    assert.equal(rec?.source.agent_run_id, "run_abc");
    assert.equal(rec?.source.record_specific_url, true);
    assert.equal(rec?.renewal_due_date, "2027-04-23");
    assert.deepEqual(r.tinyfish_calls.map((c) => c.endpoint), ["fetch", "agent"]);
    assert.ok(r.sources_checked.some((s) => s.method === "tinyfish_fetch" && s.outcome === "blocked"));
  });

  it("refuses an agent result for a different record", async () => {
    const gw = new FakeGateway();
    gw.setPage(gmc.recordUrl("9912345") as string, "bot-wall.md");
    gw.agentHandler = () => ({
      status: "COMPLETED",
      run_id: "r",
      error: null,
      result: { page_state: "record", name: "Someone Else", identifier: "7777777", status_text: "Registered with a licence to practise", disciplinary_actions: [] },
    });
    const r = await verify({ name: "Jane Example", record_type: "doctor", jurisdiction: "UK", licence_number: "9912345" }, { gateway: gw });
    assert.equal(r.outcome, "source_unavailable");
    assert.equal(r.records.length, 0);
  });

  it("returns no_match when the registry says the number does not exist", async () => {
    const gw = new FakeGateway();
    gw.pages.set(`${CH}/company/99999999`, { url: `${CH}/company/99999999`, final_url: null, title: "Page not found - GOV.UK", text: "# Page not found" });
    const r = await verify({ name: "Ghost Ltd", record_type: "company", jurisdiction: "UK", licence_number: "99999999" }, { gateway: gw });
    assert.equal(r.outcome, "no_match");
    assert.equal(gw.log.filter((l) => l.startsWith("agent")).length, 0);
  });
});

describe("verify: name path", () => {
  it("picks the single exact match and reads its record", async () => {
    const gw = new FakeGateway();
    gw.setPage(chSearchUrl("Exampleworks Ltd"), "ch-search-example.md");
    gw.pages.set(`${CH}/company/99153983`, { url: `${CH}/company/99153983`, final_url: null, title: null, text: exampleworksRecordText() });
    const r = await verify({ name: "Exampleworks Ltd", record_type: "company", jurisdiction: "UK" }, { gateway: gw });
    assert.equal(r.outcome, "verified", r.message);
    assert.equal(r.records[0]?.licence_number, "99153983");
    assert.equal(r.records[0]?.match.method, "exact_name");
    assert.ok(r.warnings.some((w) => /78 matches/.test(w)), "partial result page is disclosed");
    assert.ok(r.warnings.some((w) => /previous name/.test(w)));
  });

  it("returns multiple_matches when two records share the name", async () => {
    const gw = new FakeGateway();
    const text = [
      "2 matches found",
      `- [EXAMPLE LTD](${CH}/company/99111111 "View company")`,
      "  99111111 - Incorporated on 1 May 2020",
      `- [EXAMPLE LIMITED](${CH}/company/99222222 "View company")`,
      "  99222222 - Dissolved on 9 June 2019",
    ].join("\n\n");
    gw.pages.set(chSearchUrl("Example Ltd"), { url: "s", final_url: null, title: null, text });
    const r = await verify({ name: "Example Ltd", record_type: "company", jurisdiction: "UK" }, { gateway: gw });
    assert.equal(r.outcome, "multiple_matches");
    assert.equal(r.records.length, 0, "no record is guessed");
    assert.deepEqual(r.candidates.map((c) => c.identifier).sort(), ["99111111", "99222222"]);
    assert.match(r.message, /licence_number/);
  });

  it("tries name variants, then reports no_match with the sources it checked", async () => {
    const gw = new FakeGateway();
    for (const q of ["Imaginary Widget Works Ltd", "Imaginary Widget Works"]) {
      gw.pages.set(chSearchUrl(q), { url: q, final_url: null, title: null, text: "No results found for your search" });
    }
    const r = await verify({ name: "Imaginary Widget Works Ltd", record_type: "company", jurisdiction: "UK" }, { gateway: gw });
    assert.equal(r.outcome, "no_match");
    assert.equal(r.sources_checked.filter((s) => s.outcome === "no_results").length, 2);
    assert.equal(gw.log.filter((l) => l.startsWith("agent")).length, 0, "Companies House no-results is conclusive");
  });

  it("confirms an ABN Lookup no-results page with TinyFish Agent before saying no match", async () => {
    // ABN Lookup's fetchable search lists active ABNs only, so "no results" there is not conclusive.
    const gw = new FakeGateway();
    const q = "Nonexistent Pty Ltd";
    if (abr.search.mode !== "fetch") throw new Error("expected fetch search");
    assert.deepEqual(abr.search.fetchModes, ["full"]);
    gw.fullPages.set(abr.search.url(q, "business"), { url: "a", final_url: null, title: null, text: "No records found" });
    gw.fullPages.set(abr.search.url("Nonexistent", "business"), { url: "b", final_url: null, title: null, text: "No records found" });
    gw.agentHandler = () => ({ status: "COMPLETED", run_id: "r", error: null, result: { page_state: "no_results", no_results_message: "No matching names", candidates: [] } });
    const r = await verify({ name: q, record_type: "business registration", jurisdiction: "NSW" }, { gateway: gw });
    assert.equal(r.outcome, "no_match");
    assert.ok(gw.log.filter((l) => l.startsWith("agent")).length >= 1);
    assert.equal(gw.log.filter((l) => l.startsWith("fetch ")).length, 0, "the default Markdown is not fetched; it never has the table");
  });

  it("uses TinyFish Agent for form-only registries and refuses to guess between people", async () => {
    const gw = new FakeGateway();
    gw.agentHandler = (p) => {
      assert.match(p.url, /cslb\.ca\.gov/);
      return {
        status: "COMPLETED",
        run_id: "r1",
        error: null,
        result: {
          page_state: "results_list",
          candidates: [
            { name: "SMITH JOHN", identifier: "99000011", status: "Active", location: "FRESNO", record_url: "https://www.cslb.ca.gov/99000011" },
            { name: "SMITH JOHN", identifier: "99000012", status: "Expired", location: "OAKLAND", record_url: "https://evil.example.com/99000012" },
          ],
        },
      };
    };
    const r = await verify({ name: "John Smith", record_type: "contractor", jurisdiction: "California", entity_kind: "person" }, { gateway: gw });
    assert.equal(r.outcome, "multiple_matches");
    assert.equal(r.candidates.length, 2);
    assert.equal(r.candidates.find((c) => c.identifier === "99000012")?.record_url, null, "off-domain URLs are dropped");
  });
});

describe("verify: discovery for places without a curated registry", () => {
  it("finds an official board with TinyFish Search and reads it with Agent", async () => {
    const gw = new FakeGateway();
    gw.searchHits = [
      { position: 1, title: "Nurse lookup - OpenCorp", url: "https://opencorporates.com/x", snippet: "", site_name: "opencorporates.com" },
      { position: 2, title: "Texas Board of Nursing - Verification", url: "https://www.bon.texas.gov/verification.asp", snippet: "", site_name: "bon.texas.gov" },
    ];
    let calls = 0;
    gw.agentHandler = (p) => {
      calls += 1;
      if (calls === 1) {
        return {
          status: "COMPLETED",
          run_id: "s1",
          error: null,
          result: { page_state: "results_list", candidates: [{ name: "EXAMPLE, MARY", identifier: "RN 990001", status: "Current", record_url: "https://www.bon.texas.gov/lic/990001" }] },
        };
      }
      assert.equal(p.url, "https://www.bon.texas.gov/lic/990001");
      return {
        status: "COMPLETED",
        run_id: "s2",
        error: null,
        result: {
          page_state: "record",
          name: "EXAMPLE, MARY",
          identifier: "RN 990001",
          status_text: "Current",
          expiry_date: "05/31/2027",
          disciplinary_actions: [{ kind: "probation", description: "Agreed order: probation 2 years", start_date: "01/10/2025" }],
          record_url: "https://www.bon.texas.gov/lic/990001",
          evidence_quote: "License Status: Current",
        },
      };
    };
    const r = await verify({ name: "Mary Example", record_type: "nurse licence", jurisdiction: "Texas", entity_kind: "person" }, { gateway: gw });
    assert.equal(r.outcome, "verified", r.message);
    const rec = r.records[0];
    assert.equal(rec?.registry.curated, false);
    assert.equal(rec?.registry.id, "discovered:bon.texas.gov");
    assert.equal(rec?.status.normalized, "active");
    assert.equal(rec?.expiry_date, "2027-05-31", "US dates read month first");
    assert.equal(rec?.disciplinary_actions[0]?.kind, "probation");
    assert.ok(r.warnings.some((w) => /found at run time/.test(w)));
    assert.deepEqual(r.tinyfish_calls.map((c) => c.endpoint), ["search", "agent", "agent"]);
  });

  it("does not fall back to unofficial sites", async () => {
    const gw = new FakeGateway();
    gw.searchHits = [{ position: 1, title: "Lookup", url: "https://www.npidb.org/x", snippet: "", site_name: "npidb.org" }];
    const r = await verify({ name: "Mary Example", record_type: "nurse licence", jurisdiction: "Texas" }, { gateway: gw });
    assert.equal(r.outcome, "unsupported");
    assert.equal(gw.log.filter((l) => l.startsWith("agent")).length, 0);
  });

  it("validates the request", async () => {
    const r = await verify({ name: "x" }, { gateway: new FakeGateway() });
    assert.equal(r.outcome, "invalid_input");
  });
});
