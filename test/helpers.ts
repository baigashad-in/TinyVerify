import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentOutcome,
  FetchOptions,
  AgentParams,
  FetchOutcome,
  Gateway,
  MonitorCreateParams,
  MonitorRunPayload,
  SearchHit,
} from "../src/tinyfish/gateway.js";
import type { FetchedPage } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): string {
  return readFileSync(join(here, "fixtures", name), "utf8");
}

export function page(url: string, fixtureName: string, title: string | null = null): FetchedPage {
  return { url, final_url: url, title, text: fixture(fixtureName) };
}

/**
 * In-memory stand-in for TinyFish. Pages are keyed by URL; agent runs are
 * answered by a handler; Monitor runs re-read the current page for the URL,
 * so a test can change a page and see the Monitor pick it up.
 */
export class FakeGateway implements Gateway {
  pages = new Map<string, FetchedPage | { error: string }>();
  agentHandler: (p: AgentParams) => AgentOutcome = () => ({ status: "FAILED", run_id: null, result: null, error: "no agent handler" });
  searchHits: SearchHit[] = [];
  monitors = new Map<string, MonitorCreateParams>();
  log: string[] = [];
  private seq = 0;

  setPage(url: string, fixtureName: string, title: string | null = null): void {
    this.pages.set(url, page(url, fixtureName, title));
  }

  /** Pages returned for whole-page Fetch (include_selectors: ["body"]). Falls back to `pages`. */
  fullPages = new Map<string, FetchedPage | { error: string }>();

  async fetchPage(url: string, opts: FetchOptions = {}): Promise<FetchOutcome> {
    this.log.push(`${opts.fullPage ? "fetch-full" : "fetch"} ${url}`);
    // A whole-page read contains everything the default read has, so tests
    // that only set `pages` also work for registries that fetch the whole page.
    const p = opts.fullPage ? (this.fullPages.get(url) ?? this.pages.get(url)) : this.pages.get(url);
    if (!p) return { page: null, error: `404 for ${url}` };
    if ("error" in p) return { page: null, error: p.error };
    return { page: p, error: null };
  }

  async search(params: { query: string }): Promise<SearchHit[]> {
    this.log.push(`search ${params.query}`);
    return this.searchHits;
  }

  async runAgent(params: AgentParams): Promise<AgentOutcome> {
    this.log.push(`agent ${params.url}`);
    return this.agentHandler(params);
  }

  private runFor(monitorId: string, isBaseline: boolean): MonitorRunPayload {
    const m = this.monitors.get(monitorId);
    if (!m) throw new Error(`unknown monitor ${monitorId}`);
    const p = this.pages.get(m.url);
    this.seq += 1;
    return {
      monitor_id: monitorId,
      run_id: `run-${this.seq}`,
      is_baseline: isBaseline,
      pages: p && !("error" in p) ? [p] : [],
      errors: p && "error" in p ? [{ url: m.url, error: p.error }] : [],
    };
  }

  async createMonitor(params: MonitorCreateParams) {
    this.log.push(`monitor.create ${params.url}`);
    const id = `mon-${this.monitors.size + 1}`;
    this.monitors.set(id, params);
    return { monitor_id: id, status: "active", baseline: this.runFor(id, true) };
  }

  async runMonitor(monitorId: string): Promise<MonitorRunPayload> {
    this.log.push(`monitor.run ${monitorId}`);
    return this.runFor(monitorId, false);
  }

  /** Simulates the body TinyFish POSTs to the webhook for a scheduled run. */
  scheduledWebhookBody(monitorId: string): Record<string, unknown> {
    const run = this.runFor(monitorId, false);
    return {
      fetch_monitor_id: monitorId,
      id: run.run_id,
      is_baseline: false,
      results: run.pages.map((p) => ({ ...p, format: "markdown", description: null, language: "en", author: null, published_date: null })),
      errors: run.errors,
    };
  }

  async deleteMonitor(monitorId: string): Promise<void> {
    this.log.push(`monitor.delete ${monitorId}`);
    this.monitors.delete(monitorId);
  }
}

export const FIXED_NOW = () => new Date("2026-11-04T10:00:00.000Z");
