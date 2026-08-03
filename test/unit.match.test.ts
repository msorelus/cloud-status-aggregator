import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectRegions,
  impactsRegion,
  impactsService,
  isGlobalRegion,
  regionsInPlay,
  servicesInPlay,
  uniqueTrackingIds,
} from "../src/match";
import { StatusIssue } from "../src/types";

function issue(over: Partial<StatusIssue> = {}): StatusIssue {
  return {
    id: "i-1",
    category: "regional",
    status: "active",
    title: "Storage - Latency in Southeast Asia region",
    impactedServices: [],
    impactedRegions: [],
    source: "statusFeed",
    ...over,
  };
}

test("region detection is longest-match-first so East US 2 beats East US", () => {
  assert.deepEqual(detectRegions("Networking issues in East US 2"), ["East US 2"]);
  assert.deepEqual(detectRegions("Networking issues in East US"), ["East US"]);
});

test("region detection finds multiple regions and ignores unknown ones", () => {
  const found = detectRegions("Impact in West Europe and Japan East, not in Atlantis");
  assert.deepEqual(found.sort(), ["Japan East", "West Europe"]);
});

test("region detection does not match a region inside a larger word", () => {
  assert.deepEqual(detectRegions("EastUSSRlike naming"), []);
});

test("Global, Non-Regional and Worldwide are the same scope", () => {
  for (const alias of ["Global", "global", "Non-Regional", "non regional", "Worldwide"]) {
    assert.equal(isGlobalRegion(alias), true, `${alias} should be global`);
  }
  assert.equal(isGlobalRegion("East US 2"), false);
});

test("structured regions win over the title when both are present", () => {
  const i = issue({
    title: "Storage - Latency in Southeast Asia region",
    impactedRegions: ["West Europe"],
  });
  assert.equal(impactsRegion(i, "West Europe"), true);
  assert.equal(impactsRegion(i, "Southeast Asia"), false);
});

test("with no structured regions the title decides", () => {
  const i = issue();
  assert.equal(impactsRegion(i, "Southeast Asia"), true);
  assert.equal(impactsRegion(i, "East US 2"), false);
});

test("an issue naming no region at all is treated as global", () => {
  const i = issue({ title: "Azure Front Door - Intermittent connectivity errors" });
  assert.equal(impactsRegion(i, "Global"), true);
  assert.equal(impactsRegion(i, "Non-Regional"), true);
  assert.equal(impactsRegion(i, "East US 2"), false);
});

test("a structured Global region matches the global scope", () => {
  const i = issue({ impactedRegions: ["Global"] });
  assert.equal(impactsRegion(i, "Global"), true);
  assert.equal(impactsRegion(i, "West US 2"), false);
});

test("service matching is case-insensitive and works both directions", () => {
  const i = issue({ impactedServices: ["Azure SQL Database"] });
  assert.equal(impactsService(i, "azure sql database"), true);
  assert.equal(impactsService(i, "SQL Database"), true);
  assert.equal(impactsService(i, "Azure SQL Database (Managed Instance)"), true);
  assert.equal(impactsService(i, "Virtual Machines"), false);
});

test("service matching falls back to the title when nothing is structured", () => {
  const i = issue({ title: "Storage - Latency in Southeast Asia region" });
  assert.equal(impactsService(i, "Storage"), true);
  assert.equal(impactsService(i, "Virtual Machines"), false);
});

test("an empty service string never matches", () => {
  assert.equal(impactsService(issue(), "   "), false);
});

test("regionsInPlay summarizes structured, inferred and global issues", () => {
  const regions = regionsInPlay([
    issue({ id: "a", impactedRegions: ["East US 2"] }),
    issue({ id: "b", title: "Latency in West Europe" }),
    issue({ id: "c", title: "Front Door connectivity errors" }),
    issue({ id: "d", impactedRegions: ["Non-Regional"] }),
  ]);
  assert.deepEqual(regions, ["East US 2", "Global", "West Europe"]);
});

test("servicesInPlay dedupes and trims structured service names", () => {
  const services = servicesInPlay([
    issue({ id: "a", impactedServices: ["Storage", " Storage "] }),
    issue({ id: "b", impactedServices: ["Azure SQL Database"] }),
    issue({ id: "c", impactedServices: [] }),
  ]);
  assert.deepEqual(services, ["Azure SQL Database", "Storage"]);
});

test("uniqueTrackingIds dedupes and honours the predicate", () => {
  const issues = [
    issue({ id: "a", trackingId: "AAA1-BBB", impactedRegions: ["East US 2"] }),
    issue({ id: "b", trackingId: "AAA1-BBB", impactedRegions: ["East US 2"] }),
    issue({ id: "c", trackingId: "CCC2-DDD", impactedRegions: ["West Europe"] }),
    issue({ id: "d" }),
  ];
  assert.deepEqual(uniqueTrackingIds(issues), ["AAA1-BBB", "CCC2-DDD"]);
  assert.deepEqual(
    uniqueTrackingIds(issues, (i) => impactsRegion(i, "West Europe")),
    ["CCC2-DDD"]
  );
});
