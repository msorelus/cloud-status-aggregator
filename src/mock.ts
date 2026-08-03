import * as fs from "fs";
import * as path from "path";
import { SourceResult } from "./types";
import { parseEmergingIssues } from "./sources/emergingIssues";
import { parseStatusFeed } from "./sources/statusFeed";
import { parseServiceHealth } from "./sources/serviceHealth";
import {
  mapResources,
  rollupByService,
  summarize,
  ResourceHealthResult,
} from "./sources/resourceHealth";

/**
 * Offline demo data. Lets anyone run and explore the API contract with no Azure
 * credentials and no network — `npm run demo` (MOCK=true).
 */
export function getMockResults(): SourceResult[] {
  const sample = JSON.parse(
    fs.readFileSync(path.join(__dirname, "mock", "sample.json"), "utf-8")
  );
  const feedXml = fs.readFileSync(
    path.join(__dirname, "mock", "sample-feed.xml"),
    "utf-8"
  );

  return [
    {
      source: "emergingIssues",
      ok: true,
      message: "MOCK data",
      issues: parseEmergingIssues(sample.emergingIssues),
    },
    {
      source: "statusFeed",
      ok: true,
      message: "MOCK data",
      issues: parseStatusFeed(feedXml),
    },
    {
      source: "serviceHealth",
      ok: true,
      message: "MOCK data (subscription-scoped sample)",
      issues: parseServiceHealth(sample.serviceHealth),
    },
  ];
}

/**
 * Offline Layer 3 sample (Resource Health). Shaped like real
 * availabilityStatuses rows so it flows through the same mappers. Includes one
 * Degraded resource so the offline demo shows a non-trivial rollup.
 */
export function getMockResourceHealth(): ResourceHealthResult {
  const sub = "00000000-0000-0000-0000-000000000000";
  const mk = (
    rg: string,
    provider: string,
    type: string,
    name: string,
    location: string,
    availabilityState: string,
    summary?: string
  ) => ({
    id:
      `/subscriptions/${sub}/resourceGroups/${rg}/providers/${provider}/${type}/${name}` +
      `/providers/Microsoft.ResourceHealth/availabilityStatuses/current`,
    location,
    properties: { availabilityState, summary, occurredTime: "2026-06-25T12:00:00Z" },
  });

  const rows = [
    mk("rg-core", "Microsoft.Storage", "storageAccounts", "contosocoredata", "eastus2", "Available"),
    mk("rg-core", "Microsoft.Storage", "storageAccounts", "contosologs", "westus", "Available"),
    mk("rg-app", "Microsoft.Web", "sites", "contoso-portal", "eastus2", "Available"),
    mk("rg-app", "Microsoft.Web", "sites", "contoso-api", "eastus2", "Available"),
    mk("rg-data", "Microsoft.DocumentDB", "databaseAccounts", "contoso-cosmos", "eastus2", "Available"),
    mk("rg-ai", "Microsoft.CognitiveServices", "accounts", "contoso-openai", "swedencentral", "Available"),
    mk("rg-ai", "Microsoft.Search", "searchServices", "contoso-search", "eastus2", "Available"),
    mk("rg-obs", "Microsoft.OperationalInsights", "workspaces", "contoso-law", "eastus2", "Available"),
    mk("rg-data", "Microsoft.Cache", "redis", "contoso-cache", "centralus", "Degraded",
      "We are investigating degraded performance affecting this resource."),
    mk("rg-obs", "Microsoft.Insights", "metricAlerts", "cpu-alert", "global", "Unknown"),
    mk("rg-net", "Microsoft.Network", "dnszones", "contoso.example", "global", "Unknown"),
  ];

  const resources = mapResources(rows);
  return {
    source: "resourceHealth",
    ok: true,
    message: "MOCK data (subscription-scoped sample)",
    resources,
    summary: summarize(resources),
    byService: rollupByService(resources),
  };
}
