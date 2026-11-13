/**
 * Regression tests for problems found in an independent review before the
 * first release. Each test names the problem it guards against.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffRecords } from "../src/monitor/diff.js";
import { MAX_AGENT_SKIPS, MonitorService } from "../src/monitor/service.js";
import { MemoryStore } from "../src/monitor/store.js";
import { abr, parseAbrSearch } from "../src/registries/abr.js";
import { parseCompaniesHouseRecord } from "../src/registries/companiesHouse.js";
import { parseCanadaRecord } from "../src/registries/corporationsCanada.js";
import { parseCslbRecord } from "../src/registries/cslb.js";
import { usesMonthFirstDates } from "../src/registries/discovery.js";
import { parseGmcRecord } from "../src/registries/gmc.js";
import { resolveJurisdiction, resolveRecordType, route } from "../src/registries/index.js";
import { sunbiz } from "../src/registries/sunbiz.js";
import type { AgentParams } from "../src/tinyfish/gateway.js";
import type { VerifiedRecord } from "../src/types.js";
import { identifierNameCheck } from "../src/util/match.js";
import { verify } from "../src/verify/pipeline.js";
import { FakeGateway, fixture, page } from "./helpers.js";

const CH = "https://find-and-update.company-information.service.gov.uk";
const p = (text: string, url = "https://x") => ({ url, final_url: url, title: null, text });

describe("matching and outcomes", () => {
  it("ABN search: the ABN cell is never taken as the business name", () => {
    const s = parseAbrSearch(
      p(
        [
          "| ABN | Name | Type | Location |",
          "| :-- | :-- | :-- | :-- |",
          "| [10 000 000 000](https://abr.business.gov.au/ABN/View?abn=10000000000) Active | ACME CAFE | Entity Name | VIC 3000 |",
        ].join("\n"),
      ),
    );
    assert.equal(s.kind, "results");
    if (s.kind === "results") assert.equal(s.candidates[0]?.name, "ACME CAFE");
  });

  it("name search: a record whose name does not match is not verified", async () => {
    const gw = new FakeGateway();
    let n = 0;
    gw.agentHandler = () => {
      n += 1;
      if (n === 1) {
        return { status: "COMPLETED", run_id: "s", error: null, result: { page_state: "results_list", candidates: [{ name: "EXAMPLE MARINE SUPPLY, INC.", identifier: null, status: "INACTIVE", record_url: null }] } };
      }
      return {
        status: "COMPLETED",
        run_id: "r",
        error: null,
        result: { page_state: "record", name: "TOTALLY DIFFERENT HOLDINGS LLC", identifier: "L26999999999", status_text: "ACTIVE", disciplinary_actions: [] },
      };
    };
    const r = await verify({ name: "Example Marine Supply, Inc.", record_type: "corporation", jurisdiction: "Florida" }, { gateway: gw });
    assert.equal(r.outcome, "name_mismatch", r.message);
    assert.equal(r.records[0]?.match.name_matches_request, false);
  });

  it("name search: an unreadable name form means source_unavailable, not no_match", async () => {
    const gw = new FakeGateway();
    gw.agentHandler = (a: AgentParams) =>
      /"Example John"/.test(a.goal)
        ? { status: "FAILED", run_id: null, result: null, error: "SITE_BLOCKED: captcha" }
        : { status: "COMPLETED", run_id: "r", error: null, result: { page_state: "no_results", candidates: [] } };
    const r = await verify({ name: "John Example", record_type: "contractor", jurisdiction: "California", entity_kind: "person" }, { gateway: gw });
    assert.equal(r.outcome, "source_unavailable", r.message);
    assert.match(r.message, /could not be read/);
  });

  it("number lookup: a different legal form is a name mismatch, a short form is accepted with a warning", () => {
    assert.equal(identifierNameCheck("Tesco PLC", "TESCO STORES LIMITED", "business").ok, false);
    const short = identifierNameCheck("Woolworths", "WOOLWORTHS GROUP LIMITED", "business");
    assert.ok(short.ok && short.partial);
    const middle = identifierNameCheck("Jane Example", "Jane Mary EXAMPLE", "person");
    assert.ok(middle.ok && middle.partial, "a middle name on the register is fine");
    assert.equal(identifierNameCheck("Smith Construction", "SMITH ELECTRIC", "business").ok, false);
  });

  it("number lookup: an Agent result without the number is not accepted", async () => {
    const gw = new FakeGateway();
    gw.setPage("https://www.gmc-uk.org/registrants/9912345", "bot-wall.md");
    gw.agentHandler = () => ({
      status: "COMPLETED",
      run_id: "r",
      error: null,
      result: { page_state: "record", name: "Jane EXAMPLE", identifier: null, status_text: "Registered with a licence to practise", disciplinary_actions: [] },
    });
    const r = await verify({ name: "Jane Example", record_type: "doctor", jurisdiction: "UK", licence_number: "9912345" }, { gateway: gw });
    assert.equal(r.outcome, "source_unavailable");
  });

  it("Agent output with null entries does not crash", async () => {
    const gw = new FakeGateway();
    gw.setPage("https://www.gmc-uk.org/registrants/9912345", "bot-wall.md");
    gw.agentHandler = () => ({
      status: "COMPLETED",
      run_id: "r",
      error: null,
      result: {
        page_state: "record",
        name: "Jane EXAMPLE",
        identifier: "9912345",
        status_text: "Registered with a licence to practise",
        disciplinary_actions: [null, { kind: "warning", description: "Warning issued", start_date: "1 Jan 2026" }],
        other_fields: [null],
      },
    });
    const r = await verify({ name: "Jane Example", record_type: "doctor", jurisdiction: "UK", licence_number: "9912345" }, { gateway: gw });
    assert.equal(r.outcome, "verified", r.message);
    assert.equal(r.records[0]?.disciplinary_actions.length, 1);
  });
});

describe("routing", () => {
  it("reads longer place names by their most specific match", () => {
    assert.deepEqual(resolveJurisdiction("Sydney, New South Wales").keys, ["AU"]);
    assert.deepEqual(resolveJurisdiction("New South Wales, Australia").keys, ["AU"]);
    assert.deepEqual(resolveJurisdiction("London, UK").keys, ["GB"]);
    const ontario = resolveJurisdiction("London, Ontario");
    assert.deepEqual(ontario.keys, ["CA"]);
    assert.match(ontario.assumption ?? "", /United Kingdom/, "the other reading is disclosed");
    assert.deepEqual(resolveJurisdiction("Victoria, British Columbia").keys, ["CA"]);
    assert.ok(resolveJurisdiction("Los Angeles, CA").ambiguous);
  });

  it("a bare 'registration' is not a company record", () => {
    assert.equal(resolveRecordType("nurse registration"), null);
    assert.equal(route({ record_type: "solicitor registration", jurisdiction: "UK" }).adapters.length, 0);
    assert.equal(resolveRecordType("company registration"), "business_registration");
  });

  it("'CA' for a business checks Canada and looks for a California registry", async () => {
    const gw = new FakeGateway();
    gw.searchHits = [{ position: 1, title: "bizfile Online", url: "https://bizfileonline.sos.ca.gov/search/business", snippet: "", site_name: "sos.ca.gov" }];
    gw.agentHandler = () => ({ status: "COMPLETED", run_id: "r", error: null, result: { page_state: "no_results", candidates: [] } });
    const r = await verify({ name: "Northwind Example Ltd", record_type: "corporation", jurisdiction: "CA" }, { gateway: gw });
    assert.equal(r.outcome, "no_match", r.message);
    assert.ok(gw.log.some((l) => l.startsWith("search ")), "California was searched for with TinyFish Search");
    assert.ok(r.sources_checked.some((s) => s.registry_id === "ca-corporations-canada"));
    assert.ok(r.sources_checked.some((s) => s.registry_id === "discovered:bizfileonline.sos.ca.gov"));
  });

  it("US registries found by Search read dates month first", () => {
    assert.ok(usesMonthFirstDates("www.med.ohio.gov", "Ohio"));
    assert.ok(usesMonthFirstDates(null, "Illinois"));
    assert.ok(usesMonthFirstDates("idfpr.illinois.gov", "somewhere"));
    assert.equal(usesMonthFirstDates("www.example.gov.uk", "Scotland"), false);
  });
});

describe("parsers", () => {
  it("a real record with 'page not found' text elsewhere is still parsed", () => {
    const text = `Skip to main content. Report a page not found error.\n\n${fixture("ch-tesco.md")}`;
    const r = parseCompaniesHouseRecord(p(text));
    assert.ok(r.ok);
  });

  it("CSLB: only the first status sentence decides the status; short names are kept whole", () => {
    const text = [
      "# Contractor's License Detail for License # 99000021",
      "| Business Information | A 1 PLUMBING<br>9 EXAMPLE ST<br>EXAMPLETOWN, CA 90000 |",
      "| :-- | :-- |",
      "| License Status | This license is current and active.<br>This license was suspended on 01/02/2020 and reinstated on 03/04/2020. |",
      "| Expire Date | 04/30/2027 |",
    ].join("\n");
    const r = parseCslbRecord(p(text));
    assert.ok(r.ok, r.ok ? "" : r.reason);
    if (!r.ok) return;
    assert.equal(r.record.status, "active");
    assert.equal(r.record.name, "A 1 PLUMBING");
    assert.ok(Array.isArray(r.record.details.additional_status));
  });

  it("Canada: 'Active - Intent to Dissolve Filed' is active with a flag", () => {
    const text = fixture("canada-alerts.md").replace("Status\n\nActive", "Status\n\nActive - Intent to Dissolve Filed");
    const r = parseCanadaRecord(p(text));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.record.status, "active");
    assert.ok(r.record.compliance_flags.some((f) => f.code === "intent_to_dissolve_filed"));
  });

  it("GMC: a plain 'Fitness to practise' heading is found, and dates stay on their own row", () => {
    const text = [
      "# Jane EXAMPLE",
      "GMC reference number: 9912345",
      "Registered with a licence to practise",
      "## Fitness to practise",
      "| Restriction | Start date | End date |",
      "| :-- | :-- | :-- |",
      "| Conditions | 1 Feb 2026 | |",
      "| Warning | 3 Mar 2025 | 3 Mar 2030 |",
      "## Registration and licensing history",
    ].join("\n");
    const r = parseGmcRecord(p(text));
    assert.ok(r.ok);
    if (!r.ok) return;
    const kinds = r.record.disciplinary_actions.map((a) => a.kind).sort();
    assert.deepEqual(kinds, ["conditions", "warning"]);
    assert.equal(r.record.disciplinary_actions.find((a) => a.kind === "conditions")?.end_date, null, "end date not taken from the next row");

    const erased = parseGmcRecord(page("https://www.gmc-uk.org/registrants/9954321", "gmc-erased.md"));
    assert.ok(erased.ok);
    if (erased.ok) assert.equal(erased.record.disciplinary_actions[0]?.end_date, null, "tribunal date is not the end date");
  });

  it("Sunbiz: Agent reads use Last Event, so they agree with the parser", () => {
    assert.equal(sunbiz.normalizeAgentStatus?.("INACTIVE", { last_event: "ADMIN DISSOLUTION FOR ANNUAL REPORT" }), "dissolved");
    assert.equal(sunbiz.normalizeAgentStatus?.("INACTIVE", {}), "inactive");
  });

  it("ABN check digits are still enforced", () => {
    assert.equal(abr.normalizeIdentifier("10 000 000 001"), null);
  });
});

describe("Monitor", () => {
  const CO_URL = `${CH}/company/99579246`;
  const request = { name: "Northwind Example Trading Ltd", record_type: "company", jurisdiction: "UK", licence_number: "99579246" };
  const flagged = `${fixture("ch-example-active.md")}\n\nGazette notice for compulsory strike-off published 01 Dec 2026`;

  function service(gw: FakeGateway) {
    let clock = Date.parse("2026-11-04T10:00:00Z");
    return new MonitorService({
      gateway: gw,
      store: new MemoryStore(),
      publicBaseUrl: "https://tinyverify.example.org",
      webhookSecret: "s",
      defaultCron: "CRON_TZ=UTC 41 6 * * *",
      agentEscalation: true,
      now: () => new Date((clock += 60_000)),
      log: () => {},
    });
  }

  it("switching between Fetch and Agent reads does not raise flag or action alerts", async () => {
    const gw = new FakeGateway();
    gw.pages.set(CO_URL, p(flagged, CO_URL));
    const svc = service(gw);
    const { watch } = await svc.watch({ request });
    assert.equal(watch.baseline.compliance_flags.length, 1);

    gw.setPage(CO_URL, "bot-wall.md");
    gw.agentHandler = () => ({
      status: "COMPLETED",
      run_id: "a1",
      error: null,
      result: { page_state: "record", name: "NORTHWIND EXAMPLE TRADING LIMITED", identifier: "99579246", status_text: "Active", disciplinary_actions: [] },
    });
    const viaAgent = await svc.handleWebhook(gw.scheduledWebhookBody(watch.monitor_id), "s");
    assert.deepEqual(viaAgent.body.events, [], "the Agent read has no flags, but that is not a removal");

    gw.pages.set(CO_URL, p(flagged, CO_URL));
    const back = await svc.handleWebhook(gw.scheduledWebhookBody(watch.monitor_id), "s");
    assert.deepEqual(back.body.events, [], "the flag was there all along");
  });

  it("dissolved (parser) and inactive (Agent) for the same page is not a status change", () => {
    const base = {
      status: { normalized: "dissolved", raw: "INACTIVE", effective_date: null },
      source: { extraction: "deterministic_parser" },
      subject: { name: "X", entity_kind: "business" },
      disciplinary_actions: [],
      compliance_flags: [],
      expiry_date: null,
      renewal_due_date: null,
      licence_number: "P1",
    } as unknown as VerifiedRecord;
    const next = { ...base, status: { normalized: "inactive", raw: "INACTIVE", effective_date: null }, source: { extraction: "agent_structured_output" } } as unknown as VerifiedRecord;
    assert.deepEqual(diffRecords(base, next).map((c) => c.type), []);
  });

  it("accepts a webhook with a nested run and monitor_id", async () => {
    const gw = new FakeGateway();
    gw.pages.set(CO_URL, p(fixture("ch-example-active.md"), CO_URL));
    const svc = service(gw);
    const { watch } = await svc.watch({ request });
    gw.pages.set(CO_URL, p(fixture("ch-example-active.md").replace("- Active", "- Dissolved"), CO_URL));
    const flat = gw.scheduledWebhookBody(watch.monitor_id);
    const nested = { monitor_id: watch.monitor_id, run: { id: flat.id, is_baseline: false, results: flat.results, errors: [] } };
    const res = await svc.handleWebhook(nested, "s");
    assert.equal(res.status, 200);
    assert.equal((res.body.events as { type: string }[])[0]?.type, "status_changed");
  });

  async function discoveredWatch() {
    const gw = new FakeGateway();
    const recUrl = "https://www.bon.texas.gov/lic/990001";
    gw.searchHits = [{ position: 1, title: "Texas Board of Nursing", url: "https://www.bon.texas.gov/verification.asp", snippet: "", site_name: "bon.texas.gov" }];
    let status = "Current";
    let agentCalls = 0;
    gw.agentHandler = (a) => {
      agentCalls += 1;
      if (/Search the register|search/i.test(a.goal) && a.url.endsWith("verification.asp")) {
        return { status: "COMPLETED", run_id: "s", error: null, result: { page_state: "results_list", candidates: [{ name: "EXAMPLE, MARY", identifier: "RN 990001", status, record_url: recUrl }] } };
      }
      return { status: "COMPLETED", run_id: `r${agentCalls}`, error: null, result: { page_state: "record", name: "EXAMPLE, MARY", identifier: "RN 990001", status_text: status, disciplinary_actions: [], record_url: recUrl } };
    };
    const svc = service(gw);
    gw.pages.set(recUrl, p("x".repeat(500), recUrl));
    const { watch } = await svc.watch({ request: { name: "Mary Example", record_type: "nurse licence", jurisdiction: "Texas", entity_kind: "person" } });
    return { gw, svc, watch, recUrl, setStatus: (s: string) => (status = s), calls: () => agentCalls };
  }

  it("a Search-found registry behind a constant bot wall is still read by the Agent", async () => {
    const { gw, svc, watch, recUrl, setStatus, calls } = await discoveredWatch();
    gw.setPage(recUrl, "bot-wall.md");
    await svc.handleWebhook(gw.scheduledWebhookBody(watch.monitor_id), "s"); // first bot-wall run
    setStatus("Suspended");
    const before = calls();
    const res = await svc.handleWebhook(gw.scheduledWebhookBody(watch.monitor_id), "s"); // same bot wall, unchanged
    assert.equal(calls(), before + 1, "the Agent ran although the page hash did not change");
    assert.equal((res.body.events as { type: string }[])[0]?.type, "status_changed");
  });

  it("a Search-found registry with an unchanged page is re-read at least every few runs", async () => {
    const { gw, svc, watch, calls } = await discoveredWatch();
    const start = calls();
    for (let i = 0; i < MAX_AGENT_SKIPS + 1; i++) await svc.handleWebhook(gw.scheduledWebhookBody(watch.monitor_id), "s");
    assert.equal(calls() - start, 1, `one forced Agent read in ${MAX_AGENT_SKIPS + 1} unchanged runs`);
  });
});

describe("name search linked by number", () => {
  it("accepts a record held under another name when the register's search tied it to the number, with a warning", async () => {
    const gw = new FakeGateway();
    gw.setPage("https://www.cslb.ca.gov/99123456", "cslb-active.md");
    gw.agentHandler = () => ({
      status: "COMPLETED",
      run_id: "s",
      error: null,
      result: { page_state: "results_list", candidates: [{ name: "EXAMPLE JANE", identifier: "99123456", status: "Active", record_url: "https://www.cslb.ca.gov/99123456" }] },
    });
    const r = await verify({ name: "Jane Example", record_type: "contractor", jurisdiction: "California", entity_kind: "person" }, { gateway: gw });
    assert.equal(r.outcome, "verified", r.message);
    assert.equal(r.records[0]?.match.name_matches_request, false);
    assert.ok(r.warnings.some((w) => /held under the name "EXAMPLE BUILDERS INC"/.test(w)));
  });
});
