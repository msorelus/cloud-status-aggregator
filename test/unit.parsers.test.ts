import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEmergingIssues } from "../src/sources/emergingIssues";
import { parseStatusFeed } from "../src/sources/statusFeed";
import { parseServiceHealth } from "../src/sources/serviceHealth";

// ---- emergingIssues ---------------------------------------------------------

test("parseEmergingIssues: active event -> active global issue with impacts", () => {
  const data = {
    value: [
      {
        properties: {
          refreshTimestamp: "2026-06-02T12:55:00Z",
          statusActiveEvents: [
            {
              title: "Azure Front Door - connectivity errors",
              description: "<p>Intermittent failures.</p>",
              trackingId: "VL12-3B8",
              startTime: "2026-06-02T11:20:00Z",
              cloud: "Public",
              severity: "Warning",
              lastModifiedTime: "2026-06-02T12:50:00Z",
              impacts: [
                { name: "Azure Front Door", regions: [{ name: "Global" }] },
              ],
            },
          ],
          statusBanners: [],
        },
      },
    ],
  };
  const issues = parseEmergingIssues(data);
  assert.equal(issues.length, 1);
  const i = issues[0];
  assert.equal(i.status, "active");
  assert.equal(i.source, "emergingIssues");
  assert.equal(i.trackingId, "VL12-3B8");
  assert.deepEqual(i.impactedServices, ["Azure Front Door"]);
  assert.deepEqual(i.impactedRegions, ["Global"]);
  // strips HTML
  assert.ok(!/[<>]/.test(i.summary || ""));
});

test("parseEmergingIssues: banner with region in title -> regional information", () => {
  const data = {
    value: [
      {
        properties: {
          statusActiveEvents: [],
          statusBanners: [
            {
              title: "Service management delayed - West Europe",
              message: "Delays in West Europe.",
              cloud: "Public",
              lastModifiedTime: "2026-06-02T12:40:00Z",
            },
          ],
        },
      },
    ],
  };
  const issues = parseEmergingIssues(data);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].category, "regional");
  assert.equal(issues[0].status, "information");
  // cloud must NOT be treated as a region
  assert.deepEqual(issues[0].impactedRegions, []);
});

test("parseEmergingIssues: empty/healthy payload -> no issues", () => {
  const data = {
    value: [{ properties: { statusActiveEvents: [], statusBanners: [] } }],
  };
  assert.deepEqual(parseEmergingIssues(data), []);
  assert.deepEqual(parseEmergingIssues({}), []);
});

// ---- statusFeed -------------------------------------------------------------

const FEED = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel>
  <title>Azure Status</title>
  <item>
    <title>Planned maintenance - Virtual Machines (North Europe)</title>
    <description>Scheduled platform maintenance.</description>
    <category>Planned Maintenance</category>
    <link>https://azure.status.microsoft/status</link>
    <pubDate>Sun, 07 Jun 2026 02:00:00 Z</pubDate>
  </item>
  <item>
    <title>Storage - Latency in Southeast Asia region</title>
    <description>Elevated latency.</description>
    <category>Storage</category>
    <link>https://azure.status.microsoft/status</link>
    <pubDate>Tue, 02 Jun 2026 12:30:00 Z</pubDate>
  </item>
  <item>
    <title>Azure Front Door - connectivity errors</title>
    <description>Investigating networking issue.</description>
    <category>Networking</category>
    <link>https://azure.status.microsoft/status</link>
    <pubDate>Tue, 02 Jun 2026 11:20:00 Z</pubDate>
  </item>
</channel></rss>`;

test("parseStatusFeed: classifies maintenance / regional / global", () => {
  const issues = parseStatusFeed(FEED);
  assert.equal(issues.length, 3);
  const byTitle = (s: string) => issues.find((i) => i.title.includes(s))!;
  assert.equal(byTitle("Planned maintenance").category, "maintenance");
  assert.equal(byTitle("Southeast Asia").category, "regional");
  assert.equal(byTitle("Front Door").category, "global");
  for (const i of issues) assert.equal(i.source, "statusFeed");
});

test("parseStatusFeed: empty feed -> no issues (healthy)", () => {
  const empty = `<?xml version="1.0"?><rss version="2.0"><channel><title>Azure Status</title></channel></rss>`;
  assert.deepEqual(parseStatusFeed(empty), []);
});

test("parseStatusFeed: single item (non-array) is handled", () => {
  const single = `<?xml version="1.0"?><rss version="2.0"><channel>
    <item><title>Outage</title><description>x</description><category>Compute</category>
    <pubDate>Tue, 02 Jun 2026 11:20:00 Z</pubDate></item></channel></rss>`;
  const issues = parseStatusFeed(single);
  assert.equal(issues.length, 1);
});

// ---- serviceHealth ----------------------------------------------------------

test("parseServiceHealth: maps Resource Graph rows with services + regions", () => {
  const data = {
    data: [
      {
        eventType: "PlannedMaintenance",
        status: "Active",
        title: "Planned maintenance - SQL Database",
        trackingId: "PMNT-9921",
        summary: "Maintenance.",
        impactStartTime: "2026-06-07T06:00:00Z",
        impact: [
          { ImpactedService: "SQL Database", ImpactedRegions: [{ RegionName: "East US 2" }] },
        ],
      },
    ],
  };
  const issues = parseServiceHealth(data);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].category, "maintenance");
  assert.equal(issues[0].source, "serviceHealth");
  assert.deepEqual(issues[0].impactedServices, ["SQL Database"]);
  assert.deepEqual(issues[0].impactedRegions, ["East US 2"]);
});

test("parseServiceHealth: future PlannedMaintenance from ARG ticks becomes maintenance with ISO startTime", () => {
  const data = {
    data: [
      {
        eventType: "PlannedMaintenance",
        status: "Upcoming",
        title: "Planned maintenance - SQL Database",
        trackingId: "PMNT-FUTURE",
        summary: "<p>Maintenance.</p>",
        impactStartTime: "639164088000000000",
        impactMitigationTime: "639164160000000000",
        impact: [
          { ImpactedService: "SQL Database", ImpactedRegions: [{ RegionName: "East US 2" }] },
        ],
      },
    ],
  };

  const issues = parseServiceHealth(data);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].category, "maintenance");
  assert.equal(issues[0].trackingId, "PMNT-FUTURE");
  assert.equal(issues[0].status, "scheduled");
  assert.equal(issues[0].startTime, "2026-06-07T06:00:00.000Z");
  assert.ok(!/^[0-9]+$/.test(issues[0].startTime || ""));
});
