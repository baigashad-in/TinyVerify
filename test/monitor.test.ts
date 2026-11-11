import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { ChangeEventSchema } from "../src/monitor/diff.js";
import { MonitorService, WatchError } from "../src/monitor/service.js";
import { MemoryStore } from "../src/monitor/store.js";
import { FakeGateway, fixture } from "./helpers.js";

const CH = "https://find-and-update.company-information.service.gov.uk";
const CO_URL = `${CH}/company/99579246`;
const SECRET = "test-secret-123";

function setup(opts: { agentEscalation?: boolean } = {}) {
  const gw = new FakeGateway();
  gw.setPage(CO_URL, "ch-example-active.md");
  const store = new MemoryStore();
  const forwarded: unknown[] = [];
  let clock = Date.parse("2026-11-04T10:00:00Z");
  const svc = new MonitorService({
    gateway: gw,
    store,
    publicBaseUrl: "https://tinyverify.example.org",
    webhookSecret: SECRET,
    defaultCron: "CRON_TZ=UTC 41 6 * * *",
    agentEscalation: opts.agentEscalation ?? true,
    now: () => new Date((clock += 60_000)),
    forward: async (_url, body) => {
      forwarded.push(body);
    },
    log: () => {},
  });
  const request = { name: "Northwind Example Trading Ltd", record_type: "company", jurisdiction: "UK", licence_number: "99579246" };
  return { gw, store, svc, forwarded, request };
}

function setCompanyText(gw: FakeGateway, text: string) {
  gw.pages.set(CO_URL, { url: CO_URL, final_url: CO_URL, title: null, text });
}

describe("watch", () => {
  it("verifies, then creates a TinyFish Monitor on the stable record URL", async () => {
    const { gw, svc, store, request } = setup();
    const out = await svc.watch({ request, callback_url: "https://hooks.example.org/tv" });
    const m = gw.monitors.get(out.watch.monitor_id);
    assert.equal(m?.url, CO_URL);
    assert.equal(m?.webhook_url, `https://tinyverify.example.org/webhooks/tinyfish?token=${SECRET}`);
    assert.match(m?.purpose ?? "", /Dissolved/);
    assert.equal(out.watch.monitor_baseline_readable, true);
    assert.equal(out.warnings.length, 0);
    assert.equal((await store.listWatches()).length, 1);
    assert.deepEqual(out.tinyfish_calls.map((c) => `${c.endpoint}:${c.action}`), ["monitor:create"]);
  });

  it("refuses to watch an ambiguous result", async () => {
    const { gw, svc } = setup();
    gw.pages.set(`${CH}/search/companies?q=Example%20Ltd`, {
      url: "s",
      final_url: null,
      title: null,
      text: `[EXAMPLE LTD](${CH}/company/99111111)\n\n[EXAMPLE LIMITED](${CH}/company/99222222)`,
    });
    await assert.rejects(
      svc.watch({ request: { name: "Example Ltd", record_type: "company", jurisdiction: "UK" } }),
      (e: unknown) => e instanceof WatchError && e.code === "not_verified",
    );
    assert.equal(gw.monitors.size, 0);
  });
});

describe("Monitor webhook processing", () => {
  it("ignores page changes that do not change the structured record", async () => {
    const { gw, svc, forwarded, request } = setup();
    const { watch } = await svc.watch({ request });
    setCompanyText(gw, `${fixture("ch-example-active.md")}\n\nLast updated 04 Nov 2026 09:00:01`);
    const res = await svc.handleWebhook(gw.scheduledWebhookBody(watch.monitor_id), SECRET);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.events, []);
    assert.equal(forwarded.length, 0);
  });

  it("flags a status change as critical, stores it and forwards it", async () => {
    const { gw, svc, store, forwarded, request } = setup();
    const { watch } = await svc.watch({ request, callback_url: "https://hooks.example.org/tv" });
    setCompanyText(gw, fixture("ch-example-active.md").replace("- Active", "- Liquidation"));
    const res = await svc.handleWebhook(gw.scheduledWebhookBody(watch.monitor_id), SECRET);
    const events = res.body.events as { type: string; severity: string; message: string }[];
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "status_changed");
    assert.equal(events[0]?.severity, "critical");
    assert.match(events[0]?.message ?? "", /Active.*Liquidation/);
    for (const e of await store.listEvents()) ChangeEventSchema.parse(e);
    assert.equal(forwarded.length, 1);
    const w = await store.getWatch(watch.id);
    assert.equal(w?.latest.status.normalized, "insolvency");
    assert.equal(w?.baseline.status.normalized, "active", "baseline is kept for audit");
  });

  it("flags new compliance notices", async () => {
    const { gw, svc, request } = setup();
    const { watch } = await svc.watch({ request });
    setCompanyText(gw, `${fixture("ch-example-active.md")}\n\nGazette notice for compulsory strike-off published 01 Dec 2026`);
    const res = await svc.handleWebhook(gw.scheduledWebhookBody(watch.monitor_id), SECRET);
    const types = (res.body.events as { type: string }[]).map((e) => e.type);
    assert.deepEqual(types, ["flag_added"]);
  });

  it("escalates to TinyFish Agent when the Monitor page is a bot wall", async () => {
    const { gw, svc, request } = setup();
    const { watch } = await svc.watch({ request });
    gw.setPage(CO_URL, "bot-wall.md");
    gw.agentHandler = (p) => {
      assert.equal(p.url, CO_URL);
      return {
        status: "COMPLETED",
        run_id: "agent-run-9",
        error: null,
        result: { page_state: "record", name: "NORTHWIND EXAMPLE TRADING LIMITED", identifier: "99579246", status_text: "Dissolved", status_effective_date: "1 December 2026", disciplinary_actions: [] },
      };
    };
    const res = await svc.handleWebhook(gw.scheduledWebhookBody(watch.monitor_id), SECRET);
    assert.equal(res.body.read_via, "tinyfish_monitor+agent");
    const ev = (res.body.events as { type: string; read_via: string }[])[0];
    assert.equal(ev?.type, "status_changed");
    assert.equal(ev?.read_via, "tinyfish_monitor+agent");
    assert.equal(gw.log.filter((l) => l.startsWith("fetch")).length, 1, "the Monitor's page is not fetched a second time");
  });

  it("reports an unreadable record once, then recovery", async () => {
    const { gw, svc, request } = setup();
    const { watch } = await svc.watch({ request });
    gw.setPage(CO_URL, "bot-wall.md");
    gw.agentHandler = () => ({ status: "FAILED", run_id: null, result: null, error: "SITE_BLOCKED: blocked" });
    const first = await svc.handleWebhook(gw.scheduledWebhookBody(watch.monitor_id), SECRET);
    assert.deepEqual((first.body.events as { type: string }[]).map((e) => e.type), ["record_unreadable"]);
    const second = await svc.handleWebhook(gw.scheduledWebhookBody(watch.monitor_id), SECRET);
    assert.deepEqual(second.body.events, [], "no repeated alert while still unreadable");
    gw.setPage(CO_URL, "ch-example-active.md");
    const third = await svc.handleWebhook(gw.scheduledWebhookBody(watch.monitor_id), SECRET);
    assert.deepEqual((third.body.events as { type: string }[]).map((e) => e.type), ["record_recovered"]);
  });

  it("ignores duplicates, baselines and unknown monitors, and checks the token", async () => {
    const { gw, svc, request } = setup();
    const { watch } = await svc.watch({ request });
    const body = gw.scheduledWebhookBody(watch.monitor_id);
    assert.equal((await svc.handleWebhook(body, "wrong")).status, 401);
    assert.equal((await svc.handleWebhook(body, null)).status, 401);
    await svc.handleWebhook(body, SECRET);
    assert.equal((await svc.handleWebhook(body, SECRET)).body.ignored, "duplicate");
    assert.equal((await svc.handleWebhook({ ...body, id: "x", is_baseline: true }, SECRET)).body.ignored, "baseline");
    assert.equal((await svc.handleWebhook({ ...body, fetch_monitor_id: "nope" }, SECRET)).body.ignored, "unknown_monitor");
  });

  it("recheck runs the Monitor now and diffs the result", async () => {
    const { gw, svc, request } = setup();
    const { watch } = await svc.watch({ request });
    setCompanyText(gw, fixture("ch-example-active.md").replace("- Active", "- Dissolved"));
    const res = await svc.recheck(watch.id);
    assert.equal(res.events[0]?.type, "status_changed");
    assert.ok(res.tinyfish_calls.some((c) => c.endpoint === "monitor" && c.action === "run_now"));
  });

  it("unwatch deletes the TinyFish Monitor", async () => {
    const { gw, svc, request } = setup();
    const { watch } = await svc.watch({ request });
    await svc.unwatch(watch.id);
    assert.equal(gw.monitors.size, 0);
    await assert.rejects(svc.recheck(watch.id), WatchError);
  });
});

describe("HTTP API", () => {
  it("serves verify, schema, registries and the webhook", async () => {
    const { gw, svc, store } = setup();
    const app = createApp({ gateway: gw, monitors: svc, store, apiToken: null });
    const v = await app.request("/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Northwind Example Trading Ltd", record_type: "company", jurisdiction: "UK", license_number: "99579246" }),
    });
    assert.equal(v.status, 200);
    const vj = (await v.json()) as { outcome: string };
    assert.equal(vj.outcome, "verified", "license_number (US spelling) is accepted");

    const s = await app.request("/schema");
    const sj = (await s.json()) as { verify_result: { type: string } };
    assert.equal(sj.verify_result.type, "object");

    const reg = (await (await app.request("/registries")).json()) as { registries: unknown[] };
    assert.equal(reg.registries.length, 6);

    const bad = await app.request("/webhooks/tinyfish?token=nope", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    assert.equal(bad.status, 401);
  });

  it("requires the API token when one is set", async () => {
    const { gw, svc, store } = setup();
    const app = createApp({ gateway: gw, monitors: svc, store, apiToken: "tok" });
    assert.equal((await app.request("/registries")).status, 401);
    assert.equal((await app.request("/registries", { headers: { authorization: "Bearer tok" } })).status, 200);
    assert.equal((await app.request("/health")).status, 200);
  });
});
