/**
 * MCP server definition for the cloud status aggregator.
 *
 * Exposes the live aggregator as four read-only Model Context Protocol tools so
 * heterogeneous MCP clients (a Teams custom-engine bot now, GCP-hosted agents
 * later) can ground answers in the same data the REST API serves. All tools read
 * live data through `src/collect.ts` — the identical code path behind
 * `GET /api/status*` — so there is no logic duplication and no HTTP self-calls.
 *
 * Every tool answers from incidents Microsoft actually published. Nothing is
 * synthesized. When no incident matches, the tool says so explicitly rather
 * than reporting a healthy cell it never measured.
 *
 * Tools:
 *   - get_active_incidents    -> everything live right now, all categories
 *   - get_regional_health     -> incidents touching one region
 *   - get_planned_maintenance -> upcoming planned-maintenance events
 *   - lookup_service_region   -> incidents touching one (service, region) pair
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AppConfig } from "../config";
import { collectLive, collectStatus } from "../collect";
import {
  impactsRegion,
  impactsService,
  regionsInPlay,
  servicesInPlay,
  uniqueTrackingIds,
} from "../match";
import { StatusIssue } from "../types";

export const SERVER_INFO = {
  name: "cloud-status-aggregator-mcp",
  version: "0.2.0",
} as const;

/** Tool names, exported so callers/tests can assert the surface. */
export const TOOL_NAMES = [
  "get_active_incidents",
  "get_regional_health",
  "get_planned_maintenance",
  "lookup_service_region",
] as const;

/** Pretty-printed JSON text result (the universally host-compatible shape). */
function jsonResult(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

/** Actionable error result (`permission denied`, not `error: 500`). */
function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/** Trim an issue to the fields a language model actually needs to answer. */
function brief(issue: StatusIssue) {
  return {
    id: issue.id,
    category: issue.category,
    status: issue.status,
    title: issue.title,
    summary: issue.summary,
    impactedServices: issue.impactedServices,
    impactedRegions: issue.impactedRegions,
    trackingId: issue.trackingId,
    startTime: issue.startTime,
    lastUpdateTime: issue.lastUpdateTime,
    link: issue.link,
    source: issue.source,
  };
}

const NOTHING_REPORTED =
  "No incident matching this scope is currently reported by any configured " +
  "source. This means nothing has been published — it is not a positive " +
  "health measurement of the service.";

export function createMcpServer(config: AppConfig): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "Live Azure status, aggregated from Microsoft's public status " +
      "feed, the provider-level emergingIssues API and (when a subscription is " +
      "configured) Service Health. Use get_active_incidents for the overall " +
      "picture, get_regional_health for one region, get_planned_maintenance for " +
      "upcoming maintenance, and lookup_service_region for a specific service in " +
      "a specific region. Always cite Microsoft tracking IDs when present. When a " +
      "tool returns no incidents, say that nothing is reported — never claim a " +
      "service is verified healthy.",
  });

  // 1) get_active_incidents -- the whole live picture. No input.
  server.registerTool(
    "get_active_incidents",
    {
      title: "Get active incidents",
      description:
        "Returns every incident currently reported across all sources: an " +
        "overall rollup (healthy | advisory | degraded), per-category counts, and " +
        "the full lists of global incidents, regional incidents and planned " +
        "maintenance, each with Microsoft tracking IDs where available. Also " +
        "returns which regions and services are currently named in those " +
        "incidents. No input required. Example: call with {}.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const { data, issues, activeSources } = await collectLive(config);
        return jsonResult({
          generatedAt: data.generatedAt,
          overall: data.overall,
          counts: data.counts,
          sources: data.sources,
          activeSources,
          global: data.global.map(brief),
          regional: data.regional.map(brief),
          maintenance: data.maintenance.map(brief),
          regionsAffected: regionsInPlay(issues),
          servicesAffected: servicesInPlay(issues),
          activeTrackingIds: uniqueTrackingIds(issues),
          ...(issues.length === 0 ? { note: NOTHING_REPORTED } : {}),
        });
      } catch (err: any) {
        return errorResult(
          `Failed to read active incidents: ${err?.message || err}`
        );
      }
    }
  );

  // 2) get_regional_health -- incidents touching one region.
  server.registerTool(
    "get_regional_health",
    {
      title: "Get regional health",
      description:
        "Returns the incidents currently reported for one Azure region: the " +
        "matching incidents, the services they name, and the Microsoft tracking " +
        "IDs for that region. Input: region (string, case-insensitive) — use " +
        "'Global' for non-regional events. Example: { \"region\": \"East US 2\" }.",
      inputSchema: {
        region: z
          .string()
          .describe(
            "Azure region name, e.g. 'East US 2'. Use 'Global' for non-regional " +
              "events. Case-insensitive."
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ region }) => {
      try {
        const { data, issues } = await collectLive(config);
        const matching = issues.filter((i) => impactsRegion(i, region));
        return jsonResult({
          region,
          generatedAt: data.generatedAt,
          incidentCount: matching.length,
          incidents: matching.map(brief),
          servicesAffected: servicesInPlay(matching),
          activeTrackingIds: uniqueTrackingIds(matching),
          regionsCurrentlyReported: regionsInPlay(issues),
          ...(matching.length === 0 ? { note: NOTHING_REPORTED } : {}),
        });
      } catch (err: any) {
        return errorResult(
          `Failed to read regional health: ${err?.message || err}`
        );
      }
    }
  );

  // 3) get_planned_maintenance -- upcoming maintenance (aggregated category).
  server.registerTool(
    "get_planned_maintenance",
    {
      title: "Get planned maintenance",
      description:
        "Returns upcoming/known planned-maintenance events as a list, optionally " +
        "narrowed to a region and/or service. Sourced now from the aggregated " +
        "'maintenance' category; the contract is stable so a later Azure Resource " +
        "Graph PlannedMaintenance query (impactMitigationTime > now()) can replace " +
        "the source internally. Inputs are optional — omit both for everything. " +
        "Examples: {} or { \"region\": \"East US 2\" }.",
      inputSchema: {
        region: z
          .string()
          .optional()
          .describe(
            "Optional Azure region name, e.g. 'East US 2'. Matching also reads the " +
              "event text, because Microsoft often names the region only in the " +
              "title. Case-insensitive."
          ),
        service: z
          .string()
          .optional()
          .describe(
            "Optional Azure service/product name, e.g. 'App Service'. " +
              "Case-insensitive; a partial name is accepted."
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ region, service }) => {
      try {
        const data = await collectStatus(config);
        const matching = data.maintenance.filter(
          (m) =>
            (region === undefined || region === "" || impactsRegion(m, region)) &&
            (service === undefined || service === "" || impactsService(m, service))
        );
        const scoped = Boolean(region || service);
        return jsonResult({
          generatedAt: data.generatedAt,
          region: region ?? null,
          service: service ?? null,
          count: matching.length,
          events: matching.map(brief),
          note:
            "Sourced from the aggregated 'maintenance' category. A later seam " +
            "swaps in a dedicated Azure Resource Graph PlannedMaintenance query; " +
            "this tool's name and contract stay stable." +
            (scoped && matching.length === 0
              ? " No maintenance is published for this scope — that is not a " +
                "guarantee none will be scheduled."
              : ""),
        });
      } catch (err: any) {
        return errorResult(
          `Failed to read planned maintenance: ${err?.message || err}`
        );
      }
    }
  );

  // 4) lookup_service_region -- incidents touching a service, optionally scoped
  //    to one region. Region is optional because "is Front Door having problems?"
  //    is a question agents ask constantly, and forcing a region would make them
  //    either invent one or fall back to dumping every unrelated incident.
  server.registerTool(
    "lookup_service_region",
    {
      title: "Look up service (optionally in a region)",
      description:
        "Returns whether any incident is currently reported for a service, " +
        "optionally narrowed to one region, with the matching incidents and their " +
        "Microsoft tracking IDs. Inputs: service (required) and region (optional; " +
        "omit it to check the service everywhere). Both are case-insensitive and " +
        "service may be a partial name. An empty result means nothing is published " +
        "for that scope, not that the service is verified healthy. Examples: " +
        "{ \"service\": \"Azure SQL Database\", \"region\": \"East US 2\" } or " +
        "{ \"service\": \"Azure Front Door\" }.",
      inputSchema: {
        service: z
          .string()
          .describe(
            "Azure service/product name, e.g. 'Azure SQL Database'. " +
              "Case-insensitive; a partial name is accepted."
          ),
        region: z
          .string()
          .optional()
          .describe(
            "Optional Azure region name, e.g. 'East US 2'. Use 'Global' for " +
              "non-regional. Omit to check the service across all regions. " +
              "Case-insensitive."
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ service, region }) => {
      try {
        const { data, issues } = await collectLive(config);
        const matching = issues.filter(
          (i) =>
            impactsService(i, service) &&
            (region === undefined || region === "" || impactsRegion(i, region))
        );
        return jsonResult({
          service,
          region: region ?? null,
          scope: region ? "service-in-region" : "service-anywhere",
          generatedAt: data.generatedAt,
          impacted: matching.length > 0,
          incidentCount: matching.length,
          incidents: matching.map(brief),
          regionsAffected: regionsInPlay(matching),
          activeTrackingIds: uniqueTrackingIds(matching),
          ...(matching.length === 0 ? { note: NOTHING_REPORTED } : {}),
        });
      } catch (err: any) {
        return errorResult(
          `Failed to look up service/region: ${err?.message || err}`
        );
      }
    }
  );

  return server;
}
