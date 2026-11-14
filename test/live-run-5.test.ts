/**
 * Tests for the first live Monitor run on Sunbiz (v8, 13 Nov 2026). Monitor
 * reads the main-content page, which Sunbiz does not label, so every check
 * escalates to a whole-page Fetch. That worked, but the record was labelled
 * as an Agent read, and the watch warning blamed bot protection.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MonitorService } from "../src/monitor/service.js";
import { MemoryStore } from "../src/monitor/store.js";
import { sunbizSearchUrl } from "../src/registries/sunbiz.js";
import type { FetchedPage } from "../src/types.js";
import { sha256 } from "../src/util/text.js";
import { FakeGateway, fixture } from "./helpers.js";

const p = (text: string, url: string, links?: string[]): FetchedPage => ({ url, final_url: url, title: null, text, links });

const NAME = "Example Marine Supply, Inc.";
const REC =
  "https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResultDetail?inquirytype=EntityName&directionType=Initial&searchNameOrder=EXAMPLEMARINESUPPLY%20P269999999990&aggregateId=domp-p26999999999-00000000-0000-0000-0000-000000000009&searchTerm=x&listNameOrder=x";
const LIST = [
  "| Corporate Name | Document Number | Status |",
  "| :-- | :-- | :-- |",
  "| EXAMPLE MARINE SUPPLY, INC. | P26999999999 | Active |",
].join("\n");
// Whole page, active, with no dissolution event (the fixture itself is the dissolved version).
const ACTIVE_FULL = fixture("sunbiz-record-live-layout.md")
  .replace("StatusINACTIVE", "StatusACTIVE")
  .replace("Last EventADMIN DISSOLUTION FOR ANNUAL REPORT", "Last EventREINSTATEMENT");
// Main-content page: values without labels, as in the live dump.
const MAIN_CONTENT = "## Detail by Entity Name\n\nFlorida Profit Corporation\n\nEXAMPLE MARINE SUPPLY, INC.\n\nFiling Information\n\nP26999999999\nNONE\n11/16/2006\nFL\nACTIVE";

function setup() {
  const gw = new FakeGateway();
  gw.pages.set(sunbizSearchUrl(NAME), p(LIST, sunbizSearchUrl(NAME), [REC]));
  gw.pages.set(REC, p(MAIN_CONTENT, REC));
  gw.fullPages.set(REC, p(ACTIVE_FULL, REC));
  let clock = Date.parse("2026-11-13T00:00:00Z");
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
  return { gw, svc };
}

describe("Sunbiz Monitor checks read the whole page with Fetch", () => {
  it("the watch warning gives the real reason and the real next step", async () => {
    const { svc } = setup();
    const out = await svc.watch({ request: { name: NAME, record_type: "corporation", jurisdiction: "Florida" } });
    assert.equal(out.watch.monitor_baseline_readable, false);
    const w = out.warnings.find((x) => /Monitor reads the main-content page/.test(x)) ?? "";
    assert.match(w, /only parses from the whole page/);
    assert.match(w, /whole-page TinyFish Fetch first, and TinyFish Agent only if that fails/);
    assert.ok(!out.warnings.some((x) => /bot protection/.test(x)), "v8 blamed bot protection");
  });

  it("an escalated read is labelled as a Fetch parse, hashed from the page it parsed", async () => {
    const { gw, svc } = setup();
    const { watch } = await svc.watch({ request: { name: NAME, record_type: "corporation", jurisdiction: "Florida" } });
    const res = await svc.handleWebhook(gw.scheduledWebhookBody(watch.monitor_id), "s");
    assert.equal(res.body.read_via, "tinyfish_monitor+fetch");
    const rec = res.body.record as { source: { retrieved_via: string; extraction: string; content_sha256: string | null } };
    assert.equal(rec.source.retrieved_via, "tinyfish_fetch", "v8 said tinyfish_agent");
    assert.equal(rec.source.extraction, "deterministic_parser", "v8 said agent_structured_output");
    assert.equal(rec.source.content_sha256, sha256(ACTIVE_FULL));
    assert.equal(gw.log.filter((l) => l.startsWith("agent")).length, 0);
  });

  it("a new flag is reported on the first escalated check, because the method matches the baseline", async () => {
    const { gw, svc } = setup();
    const { watch } = await svc.watch({ request: { name: NAME, record_type: "corporation", jurisdiction: "Florida" } });
    gw.fullPages.set(REC, p(fixture("sunbiz-record-live-layout.md"), REC));
    const res = await svc.handleWebhook(gw.scheduledWebhookBody(watch.monitor_id), "s");
    const types = (res.body.events as { type: string }[]).map((e) => e.type);
    assert.ok(types.includes("status_changed"), types.join(","));
    assert.ok(types.includes("flag_added"), `v8 labelled this read as an Agent read, so flags were not compared: ${types.join(",")}`);
  });
});
