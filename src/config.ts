import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface Config {
  apiKey: string | undefined;
  port: number;
  publicBaseUrl: string | null;
  webhookSecret: string;
  webhookSecretGenerated: boolean;
  dataFile: string;
  defaultCron: string;
  agentEscalation: boolean;
  apiToken: string | null;
}

/** Load ./.env into process.env when present (Node 20.12+). Existing variables win. */
export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path) || typeof process.loadEnvFile !== "function") return;
  try {
    process.loadEnvFile(path);
  } catch {
    // A malformed .env should not stop the server; real env vars still apply.
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env) loadDotEnv();
  const secret = env.WEBHOOK_SECRET?.trim();
  const base = env.PUBLIC_BASE_URL?.trim();
  return {
    apiKey: env.TINYFISH_API_KEY?.trim() || undefined,
    port: Number(env.PORT ?? 8787),
    publicBaseUrl: base && /^https:\/\//i.test(base) ? base : null,
    webhookSecret: secret || randomBytes(24).toString("hex"),
    webhookSecretGenerated: !secret,
    dataFile: resolve(env.DATA_FILE ?? "data/tinyverify-store.json"),
    // Daily at 06:41 UTC. Off the hour on purpose, since most schedules fire at :00.
    defaultCron: env.DEFAULT_SCHEDULE_CRON?.trim() || "CRON_TZ=UTC 41 6 * * *",
    agentEscalation: (env.AGENT_ESCALATION ?? "on").toLowerCase() !== "off",
    apiToken: env.TINYVERIFY_API_TOKEN?.trim() || null,
  };
}
