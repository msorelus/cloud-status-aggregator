import { test } from "node:test";
import assert from "node:assert/strict";
import { applySince, filterIssuesSince } from "../src/filter";
import { AggregatedStatus, StatusIssue } from "../src/types";

function issue(p: Partial<StatusIssue>): StatusIssue {
  return {
    id: p.id ?? "x",
    category: p.category ?? "global",
    status: p.status ?? "active",
    title: p.title ?? "t",
    impactedServices: p.impactedServices ?? [],
    impactedRegions: p.impactedRegions ?? [],
    startTime: p.startTime,
    lastUpdateTime: p.lastUpdateTime,
    source: p.source ?? "emergingIssues",
  } as StatusIssue;
}

function agg(over: Partial<AggregatedStatus>): AggregatedStatus {
  const base: AggregatedStatus = {
    generatedAt: "2026-06-02T12:00:00Z",
    overall: "degraded",
    counts: { global: 0, regional: 0, maintenance: 0 },
    sources: [],
    global: [],
    regional: [],
    maintenance: [],
  };
  return { ...base, ...over };
}

test("filterIssuesSince keeps only issues at/after the cutoff", () => {
  const sinceMs = Date.parse("2026-06-02T12:00:00Z");
  const issues = [
    issue({ id: "old", lastUpdateTime: "2026-06-02T11:00:00Z" }),
    issue({ id: "new", lastUpdateTime: "2026-06-02T12:30:00Z" }),
    issue({ id: "exact", lastUpdateTime: "2026-06-02T12:00:00Z" }),
  ];
  const kept = filterIssuesSince(issues, sinceMs).map((i) => i.id);
  assert.deepEqual(kept.sort(), ["exact", "new"]);
});

test("filterIssuesSince retains issues without a timestamp (fail-safe)", () => {
  const sinceMs = Date.parse("2026-06-02T12:00:00Z");
  const kept = filterIssuesSince([issue({ id: "no-ts" })], sinceMs);
  assert.equal(kept.length, 1);
});

test("filterIssuesSince falls back to startTime when no lastUpdateTime", () => {
  const sinceMs = Date.parse("2026-06-02T12:00:00Z");
  const kept = filterIssuesSince(
    [
      issue({ id: "started-after", startTime: "2026-06-02T13:00:00Z" }),
      issue({ id: "started-before", startTime: "2026-06-02T09:00:00Z" }),
    ],
    sinceMs
  );
  assert.deepEqual(kept.map((i) => i.id), ["started-after"]);
});

test("applySince recomputes counts and overall over the filtered set", () => {
  const data = agg({
    global: [issue({ id: "g-old", lastUpdateTime: "2026-06-01T00:00:00Z" })],
    maintenance: [issue({ id: "m-new", category: "maintenance", lastUpdateTime: "2026-06-02T14:00:00Z" })],
    counts: { global: 1, regional: 0, maintenance: 1 },
  });
  const out = applySince(data, "2026-06-02T12:00:00Z");
  assert.equal(out.counts.global, 0);
  assert.equal(out.counts.maintenance, 1);
  // Only maintenance remains -> advisory, not degraded.
  assert.equal(out.overall, "advisory");
});

test("applySince with no 'since' returns the payload unchanged", () => {
  const data = agg({ global: [issue({ id: "g" })], counts: { global: 1, regional: 0, maintenance: 0 } });
  assert.equal(applySince(data, undefined), data);
});

test("applySince throws on an unparseable timestamp", () => {
  assert.throws(() => applySince(agg({}), "not-a-date"), /Invalid 'since'/);
});
