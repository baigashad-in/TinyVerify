/**
 * Live smoke test against real registries through TinyFish.
 * Needs TINYFISH_API_KEY. Writes every result to samples/live-<date>/.
 *
 *   npm run smoke                      company registries only (no personal data)
 *   SMOKE_GMC_NUMBER=<7 digits> npm run smoke    add a GMC check you are allowed to run
 *   SMOKE_CSLB_NUMBER=<number> npm run smoke     add a CSLB check
 *   SMOKE_CANADA_NUMBER=<corp no> npm run smoke  read a federal corporation by number too
 *   SMOKE_MONITOR=1 npm run smoke      also create a Monitor, run it once, then delete it
 *
 * Person registers are opt-in on purpose: the bounty rules forbid putting other
 * people's personal data in the build or demo, so pick subjects you may share.
 * The default cases are large listed companies, whose register entries are
 * public business records. samples/live-* is git-ignored; review it before sharing.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadDotEnv } from "../src/config.js";
import { MonitorService } from "../src/monitor/service.js";
import { MemoryStore } from "../src/monitor/store.js";
import { BILLING_MESSAGE, SdkGateway } from "../src/tinyfish/gateway.js";
import type { VerifyRequestInput } from "../src/types.js";
import { verify } from "../src/verify/pipeline.js";

const cases: { label: string; request: VerifyRequestInput; expect?: string }[] = [
  { label: "uk-company-by-number", request: { name: "Tesco PLC", record_type: "company", jurisdiction: "UK", licence_number: "00445790" }, expect: "verified" },
  { label: "uk-company-by-name", request: { name: "Rolls-Royce Holdings plc", record_type: "company", jurisdiction: "England" }, expect: "verified" },
  { label: "uk-company-no-match", request: { name: "Zqxv Imaginary Widget Works Ltd", record_type: "company", jurisdiction: "UK" }, expect: "no_match" },
  { label: "au-abn-by-number", request: { name: "Woolworths Group Limited", record_type: "abn", jurisdiction: "Australia", licence_number: "88 000 014 675" }, expect: "verified" },
  { label: "au-abn-by-name", request: { name: "Woolworths Group Limited", record_type: "business registration", jurisdiction: "NSW" }, expect: "verified" },
  { label: "ca-federal-corp-by-name", request: { name: "Canadian National Railway Company", record_type: "corporation", jurisdiction: "Canada" }, expect: "verified" },
  { label: "ca-ambiguous-code", request: { name: "Canadian National Railway Company", record_type: "corporation", jurisdiction: "CA" }, expect: "verified (Canada) or multiple_matches (if California also lists it)" },
  { label: "fl-sunbiz-by-name", request: { name: "Publix Super Markets, Inc.", record_type: "corporation", jurisdiction: "Florida" }, expect: "verified" },
  { label: "discovery-us-state-business", request: { name: "Pfizer Inc.", record_type: "business entity", jurisdiction: "New York" }, expect: "verified or multiple_matches" },
];

if (process.env.SMOKE_GMC_NUMBER) {
  cases.push({
    label: "uk-gmc-by-number",
    request: { name: process.env.SMOKE_GMC_NAME ?? "unknown", record_type: "doctor", jurisdiction: "UK", licence_number: process.env.SMOKE_GMC_NUMBER },
  });
}
if (process.env.SMOKE_CANADA_NUMBER) {
  cases.push({
    label: "ca-federal-corp-by-number",
    request: { name: process.env.SMOKE_CANADA_NAME ?? "unknown", record_type: "corporation", jurisdiction: "Canada", licence_number: process.env.SMOKE_CANADA_NUMBER },
  });
}
if (process.env.SMOKE_CSLB_NUMBER) {
  cases.push({
    label: "ca-cslb-by-number",
    request: { name: process.env.SMOKE_CSLB_NAME ?? "unknown", record_type: "contractor", jurisdiction: "California", licence_number: process.env.SMOKE_CSLB_NUMBER },
  });
}

// Read TINYFISH_API_KEY (and PUBLIC_BASE_URL, WEBHOOK_SECRET) from .env, as the server and CLI do.
loadDotEnv();
const gateway = new SdkGateway(process.env.TINYFISH_API_KEY);
const dir = join("samples", `live-${new Date().toISOString().slice(0, 10)}`);
await mkdir(dir, { recursive: true });

const summary: Record<string, unknown>[] = [];
for (const c of cases) {
  const started = Date.now();
  const result = await verify(c.request, { gateway });
  await writeFile(join(dir, `${c.label}.json`), JSON.stringify(result, null, 2));
  const rec = result.records[0];
  const line = {
    case: c.label,
    outcome: result.outcome,
    status: rec ? `${rec.status.raw} (${rec.status.normalized})` : null,
    number: rec?.licence_number ?? null,
    via: rec?.source.retrieved_via ?? null,
    source: rec?.source.url ?? null,
    calls: result.tinyfish_calls.map((x) => (x.action === "get_contents_full_page" ? "fetch-full" : x.endpoint)).join(","),
    expected: c.expect ?? null,
    seconds: Math.round((Date.now() - started) / 1000),
  };
  summary.push(line);
  console.log(JSON.stringify(line));
  if (result.message.includes(BILLING_MESSAGE)) {
    console.log("\nStopped: the TinyFish account has no credit, so every later case would fail the same way.");
    break;
  }
}

if (process.env.SMOKE_MONITOR === "1") {
  const svc = new MonitorService({
    gateway,
    store: new MemoryStore(),
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? null,
    webhookSecret: process.env.WEBHOOK_SECRET ?? "smoke",
    defaultCron: "CRON_TZ=UTC 41 6 * * *",
    agentEscalation: true,
  });
  const out = await svc.watch({ request: cases[0]?.request });
  const re = await svc.recheck(out.watch.id);
  await writeFile(join(dir, "monitor-watch.json"), JSON.stringify(out, null, 2));
  await writeFile(join(dir, "monitor-recheck.json"), JSON.stringify(re, null, 2));
  console.log(JSON.stringify({ case: "monitor", monitor_id: out.watch.monitor_id, baseline_readable: out.watch.monitor_baseline_readable, recheck_events: re.events.length }));
  if (process.env.SMOKE_KEEP_MONITOR !== "1") await svc.unwatch(out.watch.id);
}

await writeFile(join(dir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`\nSaved results to ${dir}`);
