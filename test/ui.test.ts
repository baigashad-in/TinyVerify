/**
 * The web page (v11). Behaviour in a real browser was checked with Playwright
 * against fixtures; these tests pin what the server promises about the page.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Script } from "node:vm";
import { createApp } from "../src/app.js";
import { MonitorService } from "../src/monitor/service.js";
import { MemoryStore } from "../src/monitor/store.js";
import { buildCsp } from "../src/ui.js";
import { FakeGateway } from "./helpers.js";

const HTML = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const inline = (tag: string) => [...HTML.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1] ?? "");
const hash = (s: string) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;

function app(apiToken: string | null) {
  const gw = new FakeGateway();
  const store = new MemoryStore();
  const monitors = new MonitorService({
    gateway: gw,
    store,
    publicBaseUrl: null,
    webhookSecret: "s",
    defaultCron: "CRON_TZ=UTC 41 6 * * *",
    agentEscalation: true,
    log: () => {},
  });
  return createApp({ gateway: gw, monitors, store, apiToken });
}

describe("web page", () => {
  it("browsers get the page at /, API clients still get the JSON index", async () => {
    const a = app(null);
    const html = await a.request("/", { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" } });
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await html.text(), /<title>TinyVerify<\/title>/);
    assert.equal(html.headers.get("vary"), "Accept");

    for (const accept of ["application/json", "*/*", ""]) {
      const res = await a.request("/", accept ? { headers: { accept } } : {});
      const body = (await res.json()) as { endpoints: Record<string, string> };
      assert.ok(body.endpoints["POST /verify"], `accept "${accept}" should get JSON`);
    }
    const ui = await a.request("/ui");
    assert.match(await ui.text(), /<h1 id="lookup-title">Look up a record<\/h1>/);
  });

  it("the page loads without the API token, but the API behind it still needs it", async () => {
    const a = app("tok");
    assert.equal((await a.request("/ui")).status, 200);
    assert.equal((await a.request("/", { headers: { accept: "text/html" } })).status, 200);
    const v = await a.request("/verify", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(v.status, 401);
    assert.equal((await a.request("/registries")).status, 401);
    assert.equal((await a.request("/watches")).status, 401);
    assert.equal((await a.request("/registries", { headers: { authorization: "Bearer tok" } })).status, 200);
  });

  it("the CSP allows only the page's own inline script and style, by hash", async () => {
    const res = await app(null).request("/ui");
    const csp = res.headers.get("content-security-policy") ?? "";
    const [script] = inline("script");
    const [style] = inline("style");
    assert.ok(script && style);
    assert.ok(csp.includes(`script-src ${hash(script)}`), csp);
    assert.ok(csp.includes(hash(style)), csp);
    assert.ok(!csp.includes("unsafe-inline") && !csp.includes("unsafe-eval"), csp);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(csp, buildCsp(HTML));
  });

  it("the page has one inline script that parses, and never builds HTML from strings", () => {
    const scripts = inline("script");
    assert.equal(scripts.length, 1);
    assert.doesNotThrow(() => new Script(scripts[0] ?? ""), "inline script has a syntax error");
    assert.ok(!/<script[^>]*\bsrc=/.test(HTML), "no external scripts");
    for (const risky of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval("]) {
      assert.ok(!HTML.includes(risky), `page uses ${risky}`);
    }
    assert.ok(!/\sstyle="/.test(HTML), "inline style attributes would need 'unsafe-inline'");
    assert.ok(!/\son[a-z]+="/.test(HTML), "inline event handlers would need 'unsafe-inline'");
  });

  it("links from registry data open only http(s) URLs", () => {
    assert.match(HTML, /u\.protocol === "https:" \|\| u\.protocol === "http:"/);
    assert.match(HTML, /rel: "noopener noreferrer"/);
  });
});
