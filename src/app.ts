import express, { Request, Response, Express } from "express";
import { AppConfig } from "./config";
import { collectStatus, collectResourceHealth, Fork } from "./collect";
import { applySince } from "./filter";
import { mountMcp, MCP_PATH } from "./mcp";
import { createMcpAuth, type McpAuth } from "./auth/mcpAuth";
import { renderStatusView } from "./view/statusView";
import { StatusWatcher } from "./watch";

function parseFork(value: unknown): Fork {
  return value === "public" ? "public" : "tenant";
}

/**
 * Builds the Express app from a config. Exported (separate from listen) so e2e
 * tests can drive it in-process with supertest — no port binding required.
 *
 * An optional watcher is injected rather than constructed here so tests can
 * drive the app without starting a timer.
 */
export function createApp(config: AppConfig, watcher?: StatusWatcher): Express {
  const app = express();

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      mock: config.mock,
      // Surfaced deliberately: an unauthenticated MCP endpoint is a deployment
      // decision, and it should be visible without reading the container's env.
      mcpAuth: config.mcpAuth.enabled ? "entra" : "none",
    });
  });

  app.get("/api/status", async (req: Request, res: Response) => {
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    try {
      const data = applySince(
        await collectStatus(config, parseFork(req.query.fork)),
        since
      );
      res.json(since ? { ...data, query: { since } } : data);
    } catch (err: any) {
      const status = /Invalid 'since'/.test(err?.message) ? 400 : 500;
      res.status(status).json({ error: err?.message || String(err) });
    }
  });

  // Rendered status view. Registered before the :category route so "view"
  // isn't treated as a category.
  app.get("/api/status/view", (_req: Request, res: Response) => {
    res.type("html").send(renderStatusView(config));
  });

  // The view used to live under /grid/view. Keep the old path working so
  // bookmarks and the demo script don't break.
  app.get("/api/status/grid/view", (_req: Request, res: Response) => {
    res.redirect(301, "/api/status/view");
  });

  // Change feed — what the watcher saw on its most recent poll. This is the
  // pull-side twin of the webhook: subscribers that cannot accept an inbound
  // POST can poll this instead.
  app.get("/api/status/changes", (_req: Request, res: Response) => {
    if (!watcher) {
      return res.status(503).json({
        error:
          "The change watcher is not running. Start the service with WATCH_ENABLED=true to enable change detection and webhook delivery.",
      });
    }
    res.json({
      watcher: {
        running: watcher.state.running,
        intervalMs: config.watchIntervalMs,
        pollCount: watcher.state.pollCount,
        lastPollAt: watcher.state.lastPollAt,
        lastChangeAt: watcher.state.lastChangeAt,
        lastError: watcher.state.lastError,
        webhookConfigured: Boolean(config.webhookUrl),
        webhookSigned: Boolean(config.webhookSecret),
        lastDelivery: watcher.state.lastDelivery,
      },
      latest: watcher.state.latest,
    });
  });

  // Layer 3 — live per-resource availability (Resource Health). Tenant-only by
  // nature; the public fork returns an explanatory empty result. Registered
  // before the :category route so "resources" isn't treated as a category.
  app.get("/api/status/resources", async (req: Request, res: Response) => {
    try {
      res.json(await collectResourceHealth(config, parseFork(req.query.fork)));
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.get("/api/status/:category", async (req: Request, res: Response) => {
    const category = req.params.category;
    const valid = ["global", "regional", "maintenance"];
    if (!valid.includes(category)) {
      return res.status(404).json({
        error: `Unknown category '${category}'. Use one of: ${valid.join(", ")}.`,
      });
    }
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    try {
      const data = applySince(await collectStatus(config), since);
      res.json({
        generatedAt: data.generatedAt,
        overall: data.overall,
        category,
        ...(since ? { query: { since } } : {}),
        count: (data as any).counts[category],
        issues: (data as any)[category],
      });
    } catch (err: any) {
      const status = /Invalid 'since'/.test(err?.message) ? 400 : 500;
      res.status(status).json({ error: err?.message || String(err) });
    }
  });

  app.get("/", (_req: Request, res: Response) => {
    res.json({
      name: "Cloud Status Aggregator (POC)",
      description:
        "Subscription-independent Azure status aggregation over emergingIssues, the public Azure Status feed and (optionally) Service Health.",
      mode: config.mock ? "mock" : "live",
      endpoints: [
        "GET /api/status",
        "GET /api/status/view",
        "GET /api/status/changes",
        "GET /api/status/resources",
        "GET /api/status/global",
        "GET /api/status/regional",
        "GET /api/status/maintenance",
        "GET /healthz",
        "POST /mcp (MCP Streamable HTTP)",
      ],
    });
  });

  // ─── MCP seam (testplan T8) ────────────────────────────────────────────────
  // Model Context Protocol server over Streamable HTTP at POST/GET/DELETE /mcp.
  // Self-contained in ./mcp; remote MCP clients (Teams bot now, GCP agents
  // later) connect here. Keep this block intact when extending the routes above.
  //
  // When Entra auth is configured the discovery documents must be reachable
  // *without* a token — a client that cannot read them can never learn how to
  // get one — so the metadata router is mounted outside the guarded routes.
  let mcpAuth: McpAuth | undefined;
  if (config.mcpAuth.enabled) {
    mcpAuth = createMcpAuth(config.mcpAuth, MCP_PATH);
    app.use(mcpAuth.metadataRouter);
  }
  mountMcp(app, config, mcpAuth?.middleware);
  // ───────────────────────────────────────────────────────────────────────────

  return app;
}
