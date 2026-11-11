#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { MonitorService } from "./monitor/service.js";
import { FileStore } from "./monitor/store.js";
import { catalog } from "./registries/index.js";
import { SdkGateway } from "./tinyfish/gateway.js";
import { verify } from "./verify/pipeline.js";

const HELP = `TinyVerify: check a licence or registration on the official registry.

Usage:
  tinyverify verify --name <name> --type <record type> --jurisdiction <place> [--number <id>] [--registry <id>] [--kind person|business]
  tinyverify watch  (same flags as verify) [--cron "<cron>"] [--callback <url>]
  tinyverify recheck <watch id>
  tinyverify unwatch <watch id>     stop watching and delete the TinyFish Monitor
  tinyverify watches
  tinyverify registries

Examples:
  tinyverify verify --name "Tesco PLC" --type company --jurisdiction UK
  tinyverify verify --name "Woolworths Group Limited" --type "business registration" --jurisdiction Australia --number "88 000 014 675"
  tinyverify verify --name "Jane Doe" --type contractor --jurisdiction California --kind person

Output is JSON (schema tinyverify.v1). Needs TINYFISH_API_KEY.`;

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: "string" },
      type: { type: "string" },
      jurisdiction: { type: "string" },
      number: { type: "string" },
      registry: { type: "string" },
      kind: { type: "string" },
      cron: { type: "string" },
      callback: { type: "string" },
      "no-discovery": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const cmd = positionals[0];
  if (!cmd || values.help) {
    console.log(HELP);
    return 0;
  }
  if (cmd === "registries") {
    console.log(JSON.stringify(catalog(), null, 2));
    return 0;
  }

  const config = loadConfig();
  const gateway = new SdkGateway(config.apiKey);
  const request = {
    name: values.name,
    record_type: values.type,
    jurisdiction: values.jurisdiction,
    ...(values.number ? { licence_number: values.number } : {}),
    ...(values.registry ? { registry: values.registry } : {}),
    ...(values.kind ? { entity_kind: values.kind } : {}),
    ...(values["no-discovery"] ? { allow_discovery: false } : {}),
  };

  if (cmd === "verify") {
    const result = await verify(request, { gateway });
    console.log(JSON.stringify(result, null, 2));
    return result.outcome === "verified" ? 0 : result.outcome === "invalid_input" ? 2 : 1;
  }

  const store = await new FileStore(config.dataFile).load();
  const monitors = new MonitorService({
    gateway,
    store,
    publicBaseUrl: config.publicBaseUrl,
    webhookSecret: config.webhookSecret,
    defaultCron: config.defaultCron,
    agentEscalation: config.agentEscalation,
  });
  if (cmd === "watch") {
    const out = await monitors.watch({
      request,
      ...(values.cron ? { schedule_cron: values.cron } : {}),
      callback_url: values.callback ?? null,
    });
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }
  if (cmd === "recheck") {
    const id = positionals[1];
    if (!id) throw new Error("recheck needs a watch id");
    console.log(JSON.stringify(await monitors.recheck(id), null, 2));
    return 0;
  }
  if (cmd === "unwatch") {
    const id = positionals[1];
    if (!id) throw new Error("unwatch needs a watch id");
    const w = await monitors.unwatch(id);
    console.log(JSON.stringify({ watch_id: w.id, state: w.state, deleted_monitor_id: w.monitor_id, subject: w.subject_name }, null, 2));
    return 0;
  }
  if (cmd === "watches") {
    console.log(JSON.stringify(await store.listWatches(), null, 2));
    return 0;
  }
  console.error(`Unknown command "${cmd}".\n\n${HELP}`);
  return 2;
}

// Set the exit code and let Node end on its own instead of calling
// process.exit(). On Windows, process.exit() while the TinyFish SDK's network
// connections are still closing can crash Node at shutdown with
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)", after the output
// has already printed. The smoke script ends this way and did not crash.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
