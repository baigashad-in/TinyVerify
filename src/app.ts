import { Hono } from "hono";
import { z } from "zod";
import { catalog } from "./registries/index.js";
import { WatchError, type MonitorService } from "./monitor/service.js";
import type { Store } from "./monitor/store.js";
import { ChangeEventSchema } from "./monitor/diff.js";
import type { Gateway } from "./tinyfish/gateway.js";
import { SCHEMA_VERSION, VerifyRequestSchema, VerifyResultSchema } from "./types.js";
import { verify } from "./verify/pipeline.js";

export interface AppDeps {
  gateway: Gateway;
  monitors: MonitorService;
  store: Store;
  /** When set, every route except the TinyFish webhook needs "Authorization: Bearer <token>". */
  apiToken: string | null;
}

const WatchBodySchema = z.object({
  request: z.unknown(),
  schedule_cron: z.string().min(9).max(200).optional(),
  callback_url: z.string().url().nullable().optional(),
});

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (!deps.apiToken || c.req.path === "/webhooks/tinyfish" || c.req.path === "/health") return next();
    const auth = c.req.header("authorization") ?? "";
    if (auth !== `Bearer ${deps.apiToken}`) return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  app.get("/", (c) =>
    c.json({
      name: "TinyVerify",
      schema_version: SCHEMA_VERSION,
      endpoints: {
        "GET /registries": "curated registries and what they cover",
        "POST /verify": "verify a person or business (body: VerifyRequest)",
        "POST /watch": "verify, then watch the record with TinyFish Monitor",
        "GET /watches": "list watches",
        "GET /watches/:id": "one watch with its events",
        "POST /watches/:id/recheck": "run the Monitor now and diff the result",
        "DELETE /watches/:id": "stop watching and delete the Monitor",
        "GET /events": "change events (optional ?since=ISO&watch_id=)",
        "POST /webhooks/tinyfish?token=": "TinyFish Monitor webhook receiver",
        "GET /schema": "JSON Schema of requests, results and events",
      },
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/registries", (c) => c.json({ registries: catalog(), discovery: "Other places: TinyFish Search finds an official government registry, TinyFish Agent reads it." }));

  app.get("/schema", (c) =>
    c.json({
      schema_version: SCHEMA_VERSION,
      verify_request: z.toJSONSchema(VerifyRequestSchema, { io: "input" }),
      verify_result: z.toJSONSchema(VerifyResultSchema),
      change_event: z.toJSONSchema(ChangeEventSchema),
    }),
  );

  app.post("/verify", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "expected a JSON body" }, 400);
    const result = await verify(body, { gateway: deps.gateway });
    return c.json(result, result.outcome === "invalid_input" ? 400 : 200);
  });

  app.post("/watch", async (c) => {
    const parsed = WatchBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
    try {
      const out = await deps.monitors.watch({
        request: parsed.data.request,
        ...(parsed.data.schedule_cron ? { schedule_cron: parsed.data.schedule_cron } : {}),
        callback_url: parsed.data.callback_url ?? null,
      });
      return c.json(out, 201);
    } catch (err) {
      if (err instanceof WatchError) {
        return c.json({ error: err.code, message: err.message, verification: err.verification ?? null }, err.code === "not_found" ? 404 : 422);
      }
      return c.json({ error: "watch_failed", message: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  app.get("/watches", async (c) => c.json({ watches: (await deps.store.listWatches()).map(({ baseline, ...w }) => w) }));

  app.get("/watches/:id", async (c) => {
    const w = await deps.store.getWatch(c.req.param("id"));
    if (!w) return c.json({ error: "not_found" }, 404);
    return c.json({ watch: w, events: await deps.store.listEvents({ watchId: w.id }) });
  });

  app.post("/watches/:id/recheck", async (c) => {
    try {
      return c.json(await deps.monitors.recheck(c.req.param("id")));
    } catch (err) {
      if (err instanceof WatchError) return c.json({ error: err.code, message: err.message }, 404);
      return c.json({ error: "recheck_failed", message: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  app.delete("/watches/:id", async (c) => {
    try {
      return c.json({ watch: await deps.monitors.unwatch(c.req.param("id")) });
    } catch (err) {
      if (err instanceof WatchError) return c.json({ error: err.code, message: err.message }, 404);
      return c.json({ error: "unwatch_failed", message: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  app.get("/events", async (c) =>
    c.json({
      events: await deps.store.listEvents({
        ...(c.req.query("watch_id") ? { watchId: c.req.query("watch_id") as string } : {}),
        ...(c.req.query("since") ? { since: c.req.query("since") as string } : {}),
      }),
    }),
  );

  app.post("/webhooks/tinyfish", async (c) => {
    const body = await c.req.json().catch(() => null);
    const out = await deps.monitors.handleWebhook(body, c.req.query("token") ?? null);
    return c.json(out.body, out.status as 200);
  });

  return app;
}
