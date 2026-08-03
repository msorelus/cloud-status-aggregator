/**
 * Streamable-HTTP mount for the MCP server (testplan T8).
 *
 * Mounts the Model Context Protocol endpoint at `/mcp` on the EXISTING Express
 * app using the official SDK's `StreamableHTTPServerTransport`. Remote,
 * heterogeneous MCP clients (a Teams custom-engine bot now, GCP-hosted agents
 * later) connect over HTTP; the MCP `initialize` handshake must complete before
 * any `tools/*` call.
 *
 * Session model (stateful):
 *   POST /mcp  (initialize)      -> server creates a session, returns the id in
 *                                   the `mcp-session-id` response header.
 *   POST /mcp  (other requests)  -> must carry that `mcp-session-id` header.
 *   GET  /mcp                    -> opens the SSE stream for server->client msgs.
 *   DELETE /mcp                  -> tears the session down.
 *
 * `express.json()` is attached ONLY to the POST `/mcp` route so the other
 * (GET-only) API routes are completely unaffected.
 */

import { randomUUID } from "node:crypto";
import express, { Express, Request, RequestHandler, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { AppConfig } from "../config";
import { createMcpServer } from "./server";

export { createMcpServer, SERVER_INFO, TOOL_NAMES } from "./server";

/** Path the MCP server is reachable on. Kept here so callers can reference it. */
export const MCP_PATH = "/mcp";

/**
 * Mount the MCP Streamable-HTTP endpoint on `app`. Self-contained: adds only the
 * `/mcp` POST/GET/DELETE routes and an in-memory session map. Safe to preserve
 * verbatim while other seams extend the REST routes elsewhere in `app.ts`.
 *
 * `authMiddleware`, when supplied, runs ahead of every MCP route — including
 * `initialize`. Guarding only the tool calls would leak the tool catalogue and
 * let an anonymous caller open sessions, and the MCP spec expects the 401 to
 * arrive on the very first request so the client can start its discovery chain.
 */
export function mountMcp(
  app: Express,
  config: AppConfig,
  authMiddleware?: RequestHandler
): void {
  // sessionId -> transport. In-memory is fine for the single-instance demo; a
  // multi-replica deployment would use sticky sessions or a shared store (or
  // switch the transport to stateless mode -- see README).
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // Body parsing scoped to the MCP POST route only (does not touch other routes).
  const mcpBody = express.json({ limit: "2mb" });

  // A no-op keeps the route definitions below identical in both modes.
  const guard: RequestHandler = authMiddleware ?? ((_req, _res, next) => next());

  app.post(MCP_PATH, guard, mcpBody, async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport && !sessionId && isInitializeRequest(req.body)) {
        // New session: stand up a transport + a dedicated McpServer instance.
        const newTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, newTransport);
          },
        });
        newTransport.onclose = () => {
          const sid = newTransport.sessionId;
          if (sid) transports.delete(sid);
        };
        await createMcpServer(config).connect(newTransport);
        transport = newTransport;
      } else if (!transport) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message:
              "Bad Request: send an MCP 'initialize' request first, then include " +
              "the returned 'mcp-session-id' header on subsequent requests.",
          },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: `Internal error handling MCP request: ${err?.message || err}`,
          },
          id: null,
        });
      }
    }
  });

  // GET (SSE stream) and DELETE (teardown) both replay to the session transport.
  const replayToSession = async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).send("Invalid or missing 'mcp-session-id' header.");
      return;
    }
    await transport.handleRequest(req, res);
  };

  app.get(MCP_PATH, guard, replayToSession);
  app.delete(MCP_PATH, guard, replayToSession);
}
