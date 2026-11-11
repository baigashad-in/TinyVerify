import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { MonitorService } from "./monitor/service.js";
import { FileStore } from "./monitor/store.js";
import { SdkGateway } from "./tinyfish/gateway.js";

const config = loadConfig();
const gateway = new SdkGateway(config.apiKey);
const store = await new FileStore(config.dataFile).load();
const monitors = new MonitorService({
  gateway,
  store,
  publicBaseUrl: config.publicBaseUrl,
  webhookSecret: config.webhookSecret,
  defaultCron: config.defaultCron,
  agentEscalation: config.agentEscalation,
});

const app = createApp({ gateway, monitors, store, apiToken: config.apiToken });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`TinyVerify listening on http://localhost:${info.port}`);
  if (!config.publicBaseUrl) console.log("PUBLIC_BASE_URL not set: Monitor webhooks are off. Use POST /watches/:id/recheck.");
  if (config.webhookSecretGenerated) console.log("WEBHOOK_SECRET not set: generated one for this process. Set it so webhooks survive restarts.");
});
