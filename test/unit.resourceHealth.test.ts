import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapResources,
  summarize,
  rollupByService,
} from "../src/sources/resourceHealth";

const ROWS = [
  {
    id: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/acct1/providers/Microsoft.ResourceHealth/availabilityStatuses/current",
    location: "eastus2",
    properties: { availabilityState: "Available", summary: "<p>OK</p>", occurredTime: "2026-06-25T12:00:00Z" },
  },
  {
    id: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Cache/redis/cache1/providers/Microsoft.ResourceHealth/availabilityStatuses/current",
    location: "centralus",
    properties: { availabilityState: "Degraded", summary: "Investigating latency." },
  },
  {
    id: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Insights/metricAlerts/cpu/providers/Microsoft.ResourceHealth/availabilityStatuses/current",
    location: "global",
    properties: { availabilityState: "Unknown" },
  },
  {
    id: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/acct2/providers/Microsoft.ResourceHealth/availabilityStatuses/current",
    location: "swedencentral",
    properties: { availabilityState: "Unavailable", summary: "Down." },
  },
];

test("mapResources: parses id, friendly service, region display, state, stripped summary", () => {
  const out = mapResources(ROWS);
  assert.equal(out.length, 4);

  const storage = out[0];
  assert.equal(
    storage.resourceId,
    "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/acct1"
  );
  assert.equal(storage.name, "acct1");
  assert.equal(storage.resourceType, "Microsoft.Storage/storageAccounts");
  assert.equal(storage.service, "Storage");
  assert.equal(storage.region, "East US 2");
  assert.equal(storage.state, "Available");
  assert.equal(storage.summary, "OK"); // HTML stripped

  // ARM region code that is a catalog region maps to its display name.
  assert.equal(out[3].region, "Sweden Central");
  // Unknown-state row keeps Unknown (not coerced to an issue).
  assert.equal(out[2].state, "Unknown");
});

test("mapResources: unmapped resource type falls back to a prettified name", () => {
  const out = mapResources([
    {
      id: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Widget/superWidgets/w1/providers/Microsoft.ResourceHealth/availabilityStatuses/current",
      location: "eastus",
      properties: { availabilityState: "Available" },
    },
  ]);
  assert.equal(out[0].service, "Super Widgets");
});

test("summarize: tallies each availability state", () => {
  const s = summarize(mapResources(ROWS));
  assert.deepEqual(s, {
    total: 4,
    available: 1,
    degraded: 1,
    unavailable: 1,
    unknown: 1,
  });
});

test("rollupByService: separates Unknown from genuine issues and sorts issues first", () => {
  const rollup = rollupByService(mapResources(ROWS));
  const byName = Object.fromEntries(rollup.map((r) => [r.service, r]));

  // Unknown must NOT be counted as an issue.
  assert.deepEqual(byName["Azure Monitor Alerts"], {
    service: "Azure Monitor Alerts",
    total: 1,
    available: 0,
    unknown: 1,
    issues: 0,
  });

  // Storage has one Available + one Unavailable (an issue).
  assert.equal(byName["Storage"].issues, 1);
  assert.equal(byName["Storage"].available, 1);

  // Services with issues sort before issue-free ones.
  assert.ok(rollup[0].issues > 0);
});
