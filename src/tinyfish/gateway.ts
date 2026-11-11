import { PermissionDeniedError, TinyFish, APIStatusError } from "@tiny-fish/sdk";
import type { FetchedPage, TinyFishCall } from "../types.js";

export interface SearchHit {
  position: number;
  title: string;
  url: string;
  snippet: string;
  site_name: string;
}

export interface AgentParams {
  url: string;
  goal: string;
  output_schema: Record<string, unknown>;
  stealth?: boolean;
  proxy_country?: string;
  max_duration_seconds?: number;
}

export interface AgentOutcome {
  status: string;
  run_id: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
}

export interface MonitorCreateParams {
  name: string;
  url: string;
  schedule_cron: string;
  purpose: string;
  webhook_url?: string;
}

export interface MonitorRunPayload {
  monitor_id: string;
  run_id: string;
  is_baseline: boolean;
  pages: FetchedPage[];
  errors: { url: string; error: string }[];
}

export interface FetchOutcome {
  page: FetchedPage | null;
  error: string | null;
}

export interface FetchOptions {
  /** Return every link on the page (absolute URLs) in page.links. */
  links?: boolean;
  purpose?: string;
  /**
   * Skip TinyFish's automatic main-content extraction and convert the whole
   * <body> (include_selectors: ["body"]). Registry search results and record
   * tables can be dropped as "boilerplate" by the default extraction.
   */
  fullPage?: boolean;
}

/** Message shown when the TinyFish wallet is empty. Kept short and free of payment prompts. */
export const BILLING_MESSAGE =
  "TinyFish rejected the call because the account has no credit (wallet balance $0). Agent runs need credit; add it at https://agent.tinyfish.ai/wallet and run again.";

export function isBillingError(text: string): boolean {
  return /insufficient[_ ](credits|funds)|wallet balance is too low|balance is too low|payment required/i.test(text);
}

/**
 * Everything TinyVerify needs from TinyFish. The SDK implementation is below;
 * tests swap in a fake so they never touch the network.
 */
export interface Gateway {
  fetchPage(url: string, opts?: FetchOptions): Promise<FetchOutcome>;
  search(params: { query: string; include_domains?: string[]; location?: string; purpose?: string }): Promise<SearchHit[]>;
  runAgent(params: AgentParams): Promise<AgentOutcome>;
  createMonitor(params: MonitorCreateParams): Promise<{ monitor_id: string; status: string; baseline: MonitorRunPayload | null }>;
  runMonitor(monitorId: string): Promise<MonitorRunPayload>;
  deleteMonitor(monitorId: string): Promise<void>;
}

export class TinyVerifyError extends Error {
  constructor(
    readonly code: "monitor_not_enabled" | "tinyfish_auth" | "tinyfish_billing" | "tinyfish_error" | "config",
    message: string,
  ) {
    super(message);
  }
}

function pageFromResult(r: {
  url: string;
  final_url: string | null;
  title: string | null;
  text: unknown;
  links?: string[] | undefined;
}): FetchedPage {
  const text = typeof r.text === "string" ? r.text : r.text == null ? null : JSON.stringify(r.text);
  return { url: r.url, final_url: r.final_url, title: r.title, text, links: r.links };
}

function mapError(err: unknown, what: string): never {
  if (err instanceof TinyVerifyError) throw err;
  if (err instanceof PermissionDeniedError && what.startsWith("monitor")) {
    throw new TinyVerifyError(
      "monitor_not_enabled",
      "TinyFish Monitor is in beta and enabled per account. Ask TinyFish support to enable Monitor for this API key.",
    );
  }
  if (err instanceof APIStatusError && err.statusCode === 401) {
    throw new TinyVerifyError("tinyfish_auth", "TinyFish rejected the API key (401). Check TINYFISH_API_KEY.");
  }
  const msg = err instanceof Error ? err.message : String(err);
  // Stop the whole request: every later call would fail the same way.
  if ((err instanceof APIStatusError && err.statusCode === 402) || isBillingError(msg)) {
    throw new TinyVerifyError("tinyfish_billing", BILLING_MESSAGE);
  }
  throw new TinyVerifyError("tinyfish_error", `TinyFish ${what} failed: ${msg}`);
}

/** Real TinyFish calls through the official TypeScript SDK. */
/** Agent runs may last up to this long (agent_config.max_duration_seconds). */
const AGENT_MAX_SECONDS = 240;

export class SdkGateway implements Gateway {
  /** Reads (Fetch, Search, Monitor delete): safe to retry. */
  private readonly client: TinyFish;
  /**
   * Agent runs and Monitor create/run-now are billed and not safe to repeat:
   * a retry after a lost response could start a second run or a duplicate
   * monitor. So this client never retries, and its timeout is longer than the
   * longest Agent run so a slow run is not cut off client side.
   */
  private readonly once: TinyFish;

  constructor(apiKey: string | undefined) {
    if (!apiKey) throw new TinyVerifyError("config", "TINYFISH_API_KEY is not set.");
    // Fetch can take up to 110s per URL server side.
    this.client = new TinyFish({ apiKey, timeout: 150_000, maxRetries: 2 });
    this.once = new TinyFish({ apiKey, timeout: (AGENT_MAX_SECONDS + 60) * 1000, maxRetries: 0 });
  }

  async fetchPage(url: string, opts: FetchOptions = {}): Promise<FetchOutcome> {
    const purpose = opts.purpose ?? "Verify a licence or registration record on an official registry for a compliance check";
    if (opts.fullPage) return this.fetchFullPage(url, purpose);
    try {
      const res = await this.client.fetch.getContents({
        urls: [url],
        format: "markdown",
        ttl: 0, // always a live read of the registry, never a cached copy
        links: opts.links ?? false,
        purpose,
      });
      const first = res.results[0];
      if (first) return { page: pageFromResult(first), error: null };
      const e = res.errors[0];
      if (e && isBillingError(e.error)) throw new TinyVerifyError("tinyfish_billing", BILLING_MESSAGE);
      return { page: null, error: e ? e.error : "Fetch returned no result" };
    } catch (err) {
      mapError(err, "fetch");
    }
  }

  /**
   * Fetch with include_selectors. SDK 0.11 validates Fetch parameters strictly
   * and does not list include_selectors yet, although the Fetch API accepts
   * it, so this posts through the SDK client's own post() (same auth, retries
   * and error mapping) with the extra field.
   */
  private async fetchFullPage(url: string, purpose: string): Promise<FetchOutcome> {
    try {
      const res = await this.client.post<{ results?: unknown[]; errors?: unknown[] }>(this.client.productUrl("fetch"), {
        json: { urls: [url], format: "markdown", ttl: 0, links: true, include_selectors: ["body"], purpose },
      });
      const first = (res.results ?? [])[0] as Record<string, unknown> | undefined;
      if (first) {
        return {
          page: pageFromResult({
            url: String(first.url ?? url),
            final_url: typeof first.final_url === "string" ? first.final_url : null,
            title: typeof first.title === "string" ? first.title : null,
            text: first.text,
            links: Array.isArray(first.links) ? first.links.filter((l): l is string => typeof l === "string") : undefined,
          }),
          error: null,
        };
      }
      const e = (res.errors ?? [])[0] as Record<string, unknown> | undefined;
      const msg = e ? String(e.error ?? e.message ?? e.code ?? "unknown error") : "Fetch returned no result";
      if (isBillingError(msg)) throw new TinyVerifyError("tinyfish_billing", BILLING_MESSAGE);
      return { page: null, error: msg };
    } catch (err) {
      if (err instanceof TinyVerifyError) throw err;
      mapError(err, "fetch");
    }
  }

  async search(params: { query: string; include_domains?: string[]; location?: string; purpose?: string }): Promise<SearchHit[]> {
    try {
      const res = await this.client.search.query({
        query: params.query,
        ...(params.include_domains?.length ? { include_domains: params.include_domains.join(",") } : {}),
        ...(params.location ? { location: params.location } : {}),
        purpose: params.purpose ?? "Find the official government registry or licensing board search page",
      });
      return res.results.map((r) => ({
        position: r.position,
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        site_name: r.site_name,
      }));
    } catch (err) {
      mapError(err, "search");
    }
  }

  async runAgent(params: AgentParams): Promise<AgentOutcome> {
    try {
      const res = await this.once.agent.run({
        url: params.url,
        goal: params.goal,
        output_schema: params.output_schema,
        browser_profile: params.stealth ? "stealth" : "lite",
        proxy_config: { enabled: true, ...(params.proxy_country ? { country_code: params.proxy_country } : {}) },
        agent_config: { max_duration_seconds: params.max_duration_seconds ?? AGENT_MAX_SECONDS },
      });
      const error = res.error ? `${res.error.code ?? res.error.category}: ${res.error.message}` : null;
      if (error && isBillingError(error)) throw new TinyVerifyError("tinyfish_billing", BILLING_MESSAGE);
      return {
        status: res.status,
        run_id: res.run_id ?? null,
        result: (res.result as Record<string, unknown> | null) ?? null,
        error,
      };
    } catch (err) {
      mapError(err, "agent");
    }
  }

  async createMonitor(params: MonitorCreateParams) {
    try {
      const res = await this.once.monitors.create({
        type: "fetch",
        name: params.name.slice(0, 100),
        config: { url: params.url, format: "markdown" },
        schedule_cron: params.schedule_cron,
        purpose: params.purpose.slice(0, 2000),
        ...(params.webhook_url ? { webhook_url: params.webhook_url } : {}),
      });
      const run = res.run as unknown as Record<string, unknown> | null;
      return {
        monitor_id: res.monitor.id,
        status: res.monitor.status,
        baseline: run ? toMonitorPayload(res.monitor.id, run) : null,
      };
    } catch (err) {
      mapError(err, "monitor create");
    }
  }

  async runMonitor(monitorId: string): Promise<MonitorRunPayload> {
    try {
      const res = await this.once.monitors.run(monitorId);
      return toMonitorPayload(monitorId, res.run as unknown as Record<string, unknown>);
    } catch (err) {
      mapError(err, "monitor run");
    }
  }

  async deleteMonitor(monitorId: string): Promise<void> {
    try {
      await this.client.monitors.cancel(monitorId);
    } catch (err) {
      mapError(err, "monitor delete");
    }
  }
}

/** Normalize a Monitor run (from create, run-now, or a scheduled webhook). */
export function toMonitorPayload(monitorId: string, run: Record<string, unknown>): MonitorRunPayload {
  const list = Array.isArray(run.results) ? run.results : Array.isArray(run.pages) ? run.pages : [];
  const results = list.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
  const errors = (Array.isArray(run.errors) ? run.errors : [])
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    .map((e) => ({ url: String(e.url ?? ""), error: String(e.error ?? e.message ?? "unknown error") }));
  return {
    monitor_id: monitorId,
    run_id: String(run.id ?? run.run_id ?? ""),
    is_baseline: run.is_baseline === true,
    pages: results
      .filter((r) => typeof r.url === "string")
      .map((r) =>
        pageFromResult({
          url: String(r.url),
          final_url: typeof r.final_url === "string" ? r.final_url : null,
          title: typeof r.title === "string" ? r.title : null,
          text: r.text,
          links: Array.isArray(r.links) ? (r.links as string[]) : undefined,
        }),
      ),
    errors,
  };
}

/**
 * Wraps a gateway and records each call, so every result can show exactly
 * which TinyFish endpoints did the work.
 */
export class TracedGateway implements Gateway {
  readonly calls: TinyFishCall[] = [];

  constructor(private readonly inner: Gateway) {}

  private async trace<T>(
    endpoint: TinyFishCall["endpoint"],
    action: string,
    target: string,
    fn: () => Promise<T>,
    runId?: (r: T) => string | null,
  ): Promise<T> {
    const started = Date.now();
    const at = new Date(started).toISOString();
    try {
      const r = await fn();
      this.calls.push({ endpoint, action, target, ok: true, ms: Date.now() - started, at, run_id: runId ? runId(r) : null });
      return r;
    } catch (err) {
      this.calls.push({ endpoint, action, target, ok: false, ms: Date.now() - started, at, run_id: null });
      throw err;
    }
  }

  fetchPage(url: string, opts?: FetchOptions) {
    return this.trace("fetch", opts?.fullPage ? "get_contents_full_page" : "get_contents", url, () => this.inner.fetchPage(url, opts));
  }
  search(params: { query: string; include_domains?: string[]; location?: string; purpose?: string }) {
    return this.trace("search", "query", params.query, () => this.inner.search(params));
  }
  runAgent(params: AgentParams) {
    return this.trace("agent", "run", params.url, () => this.inner.runAgent(params), (r) => r.run_id);
  }
  createMonitor(params: MonitorCreateParams) {
    return this.trace("monitor", "create", params.url, () => this.inner.createMonitor(params), (r) => r.monitor_id);
  }
  runMonitor(monitorId: string) {
    return this.trace("monitor", "run_now", monitorId, () => this.inner.runMonitor(monitorId), (r) => r.run_id);
  }
  deleteMonitor(monitorId: string) {
    return this.trace("monitor", "delete", monitorId, () => this.inner.deleteMonitor(monitorId));
  }
}
