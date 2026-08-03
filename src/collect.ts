/**
 * Reusable status-collection layer.
 *
 * This is the single source of truth for "go talk to the sources and
 * normalize". It sits behind BOTH the REST routes (`GET /api/status*`) and the
 * MCP tools (`src/mcp`) so they call the exact same code path — no logic
 * duplication and no HTTP self-calls.
 *
 * Everything returned here is a live signal from Microsoft. Nothing is
 * synthesized: if no source reports an incident, the answer is "nothing
 * reported", not a green matrix.
 */

import { AppConfig } from "./config";
import { getEmergingIssues } from "./sources/emergingIssues";
import { getStatusFeed } from "./sources/statusFeed";
import { getServiceHealth } from "./sources/serviceHealth";
import { getResourceHealth, ResourceHealthResult } from "./sources/resourceHealth";
import { aggregate } from "./normalize";
import { getMockResults, getMockResourceHealth } from "./mock";
import {
  AggregatedStatus,
  SourceResult,
  IssueSource,
  StatusIssue,
} from "./types";

export type Fork = "public" | "tenant";

const PUBLIC_SOURCES: IssueSource[] = ["emergingIssues", "statusFeed"];

function sourceAllowedForFork(source: IssueSource, fork: Fork): boolean {
  return fork === "tenant" || PUBLIC_SOURCES.includes(source);
}

/**
 * Call the Microsoft sources in parallel (or serve bundled mock data) and
 * normalize them into the single unified Azure-Status-style payload.
 */
export async function collectStatus(
  config: AppConfig,
  fork: Fork = "tenant"
): Promise<AggregatedStatus> {
  let results: SourceResult[];
  if (config.mock) {
    results = getMockResults();
    results = results.filter((r) => sourceAllowedForFork(r.source, fork));
  } else {
    const sourcePromises: Promise<SourceResult>[] = [
      getEmergingIssues(config),
      getStatusFeed(config),
    ];
    if (fork === "tenant") sourcePromises.push(getServiceHealth(config));
    results = await Promise.all(sourcePromises);
  }
  return aggregate(results);
}

/**
 * One live snapshot: the aggregated payload plus the flattened issue list, all
 * derived from a SINGLE collection pass so timestamps stay consistent and the
 * live sources are hit only once.
 */
export interface LiveStatus {
  data: AggregatedStatus;
  /** All issues across categories, flattened. */
  issues: StatusIssue[];
  /** Sources that answered successfully on this pass. */
  activeSources: IssueSource[];
}

export async function collectLive(
  config: AppConfig,
  fork: Fork = "tenant"
): Promise<LiveStatus> {
  const data = await collectStatus(config, fork);
  const issues: StatusIssue[] = [
    ...data.global,
    ...data.regional,
    ...data.maintenance,
  ];
  const activeSources: IssueSource[] = data.sources
    .filter((s) => s.ok)
    .map((s) => s.source);
  return { data, issues, activeSources };
}

/**
 * LAYER 3 — live per-resource availability (Resource Health).
 *
 * This is intentionally a SEPARATE collection path from the incident model:
 * it answers "is each individual resource up right now", not "is there an
 * incident". It is tenant-only by nature (authenticated, subscription-scoped),
 * so the public fork returns an explanatory empty result instead of data.
 */
export async function collectResourceHealth(
  config: AppConfig,
  fork: Fork = "tenant"
): Promise<ResourceHealthResult> {
  if (fork === "public") {
    return {
      source: "resourceHealth",
      ok: true,
      message:
        "Resource Health (Layer 3) is not available in the public view — it requires authenticated, subscription-scoped access. Switch to the Tenant view.",
      resources: [],
      summary: { total: 0, available: 0, degraded: 0, unavailable: 0, unknown: 0 },
      byService: [],
    };
  }
  if (config.mock) return getMockResourceHealth();
  return getResourceHealth(config);
}
