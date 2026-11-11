/**
 * Writes example outputs to samples/fixture-examples/ using the test fixtures
 * and a fake TinyFish gateway. They show the exact JSON shape only. The
 * companies are fictional and these are NOT live registry results.
 * Run `npm run smoke` for live results.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MonitorService } from "../src/monitor/service.js";
import { MemoryStore } from "../src/monitor/store.js";
import { verify } from "../src/verify/pipeline.js";
import { FakeGateway, fixture } from "../test/helpers.js";

const CH = "https://find-and-update.company-information.service.gov.uk";
const CO_URL = `${CH}/company/99579246`;
const dir = join("samples", "fixture-examples");
await mkdir(dir, { recursive: true });
let t = Date.parse("2026-11-04T10:00:00Z");
const now = () => new Date((t += 1000));

const gw = new FakeGateway();
gw.setPage(CO_URL, "ch-example-active.md", "NORTHWIND EXAMPLE TRADING LIMITED overview - Find and update company information - GOV.UK");
gw.pages.set(`${CH}/search/companies?q=Example%20Ltd`, {
  url: `${CH}/search/companies?q=Example%20Ltd`,
  final_url: null,
  title: null,
  text: `2 matches found\n\n[EXAMPLE LTD](${CH}/company/99111111)\n\n99111111 - Incorporated on 1 May 2020\n\n[EXAMPLE LIMITED](${CH}/company/99222222)\n\n99222222 - Dissolved on 9 June 2019`,
});

const request = { name: "Northwind Example Trading Ltd", record_type: "company", jurisdiction: "UK", licence_number: "99579246" };

const verified = await verify(request, { gateway: gw, now });
await writeFile(join(dir, "verified.json"), JSON.stringify(verified, null, 2));

const multiple = await verify({ name: "Example Ltd", record_type: "company", jurisdiction: "UK" }, { gateway: gw, now });
await writeFile(join(dir, "multiple-matches.json"), JSON.stringify(multiple, null, 2));

const svc = new MonitorService({
  gateway: gw,
  store: new MemoryStore(),
  publicBaseUrl: "https://tinyverify.example.org",
  webhookSecret: "example-secret",
  defaultCron: "CRON_TZ=UTC 41 6 * * *",
  agentEscalation: true,
  now,
});
const { watch } = await svc.watch({ request });
gw.pages.set(CO_URL, { url: CO_URL, final_url: null, title: null, text: fixture("ch-example-active.md").replace("- Active", "- Liquidation") });
const change = await svc.handleWebhook(gw.scheduledWebhookBody(watch.monitor_id), "example-secret");
await writeFile(join(dir, "change-event.json"), JSON.stringify(change.body, null, 2));

console.log(`Wrote ${dir}/verified.json, multiple-matches.json, change-event.json (fictional fixture data, not live).`);
