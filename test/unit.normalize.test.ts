import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate } from "../src/normalize";
import { SourceResult, StatusIssue } from "../src/types";

function issue(p: Partial<StatusIssue>): StatusIssue {
  return {
    id: p.id || "id",
    category: p.category || "global",
    status: p.status || "information",
    title: p.title || "Untitled",
    summary: p.summary,
    impactedServices: p.impactedServices || [],
    impactedRegions: p.impactedRegions || [],
    trackingId: p.trackingId,
    startTime: p.startTime,
    lastUpdateTime: p.lastUpdateTime,
    link: p.link,
    source: p.source || "statusFeed",
  };
}

function result(source: SourceResult["source"], issues: StatusIssue[]): SourceResult {
  return { source, ok: true, issues };
}

test("aggregate: counts and overall rollup", () => {
  const out = aggregate([
    result("emergingIssues", [
      issue({ title: "Global outage", category: "global", status: "active", source: "emergingIssues" }),
    ]),
    result("statusFeed", [
      issue({ title: "Maint NE", category: "maintenance", status: "scheduled" }),
    ]),
  ]);
  assert.equal(out.counts.global, 1);
  assert.equal(out.counts.maintenance, 1);
  assert.equal(out.overall, "degraded"); // active global present
  assert.equal(out.sources.length, 2);
});

test("aggregate: advisory when issues exist but none active", () => {
  const out = aggregate([
    result("statusFeed", [issue({ title: "Notice", category: "regional", status: "information" })]),
  ]);
  assert.equal(out.overall, "advisory");
});

test("aggregate: healthy when no global/regional issues", () => {
  const out = aggregate([
    result("statusFeed", [issue({ title: "Maint", category: "maintenance", status: "scheduled" })]),
  ]);
  assert.equal(out.overall, "healthy");
});

test("aggregate: cross-source dedup merges same incident (one has trackingId)", () => {
  const fromEi = issue({
    title: "Azure Front Door - connectivity errors",
    category: "global",
    status: "active",
    trackingId: "VL12-3B8",
    impactedServices: ["Azure Front Door"],
    source: "emergingIssues",
  });
  const fromFeed = issue({
    title: "Azure Front Door - Connectivity Errors", // different case/punctuation
    category: "global",
    status: "information",
    source: "statusFeed",
  });
  const out = aggregate([result("emergingIssues", [fromEi]), result("statusFeed", [fromFeed])]);
  // Must appear exactly once, keeping the richer (active, with trackingId) record.
  assert.equal(out.global.length, 1);
  assert.equal(out.global[0].trackingId, "VL12-3B8");
  assert.equal(out.global[0].status, "active");
});

test("aggregate: active issues sort before scheduled/informational", () => {
  const out = aggregate([
    result("statusFeed", [
      issue({ title: "Info", category: "global", status: "information" }),
      issue({ title: "Active", category: "global", status: "active" }),
    ]),
  ]);
  assert.equal(out.global[0].title, "Active");
});
