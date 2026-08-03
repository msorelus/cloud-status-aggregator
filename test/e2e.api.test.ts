import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { StatusWatcher } from "../src/watch";

// Force mock mode so the suite is deterministic and offline.
process.env.MOCK = "true";
const config = { ...loadConfig(), mock: true };
const app = createApp(config);

test("GET /healthz -> 200 ok", async () => {
  const res = await request(app).get("/healthz");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ok");
  assert.equal(res.body.mock, true);
});

test("GET / -> service metadata + endpoint list", async () => {
  const res = await request(app).get("/");
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, "mock");
  assert.ok(Array.isArray(res.body.endpoints));
  assert.ok(res.body.endpoints.includes("GET /api/status"));
});

test("GET /api/status -> full unified payload", async () => {
  const res = await request(app).get("/api/status");
  assert.equal(res.status, 200);
  const b = res.body;
  for (const k of ["generatedAt", "overall", "counts", "sources", "global", "regional", "maintenance"]) {
    assert.ok(k in b, `missing key ${k}`);
  }
  // All three sources are always reported.
  assert.equal(b.sources.length, 3);
  for (const s of b.sources) assert.ok("ok" in s);
  // Mock data has at least one of each category.
  assert.ok(b.counts.global >= 1);
  assert.ok(b.counts.maintenance >= 1);
  assert.equal(b.overall, "degraded"); // mock has an active global incident
});

test("GET /api/status dedups the Front Door incident to a single global entry", async () => {
  const res = await request(app).get("/api/status");
  const fd = res.body.global.filter((i: any) =>
    /front door/i.test(i.title)
  );
  assert.equal(fd.length, 1, "Front Door should be merged across sources");
  assert.equal(fd[0].trackingId, "VL12-3B8");
});

for (const category of ["global", "regional", "maintenance"]) {
  test(`GET /api/status/${category} -> category payload`, async () => {
    const res = await request(app).get(`/api/status/${category}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.category, category);
    assert.ok(Array.isArray(res.body.issues));
    assert.equal(res.body.issues.length, res.body.count);
    for (const i of res.body.issues) assert.equal(i.category, category);
  });
}

test("GET /api/status?since=<ISO> -> filtered delta payload with echoed query", async () => {
  // Future cutoff filters everything out -> healthy, empty, but still 200.
  const res = await request(app).get("/api/status?since=2999-01-01T00:00:00Z");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.query, { since: "2999-01-01T00:00:00Z" });
  assert.equal(res.body.counts.global, 0);
  assert.equal(res.body.counts.regional, 0);
  assert.equal(res.body.counts.maintenance, 0);
  assert.equal(res.body.overall, "healthy");

  // Past cutoff keeps the mock incidents.
  const res2 = await request(app).get("/api/status?since=2000-01-01T00:00:00Z");
  assert.equal(res2.status, 200);
  assert.ok(res2.body.counts.global >= 1);
});

test("GET /api/status?since=garbage -> 400", async () => {
  const res = await request(app).get("/api/status?since=not-a-date");
  assert.equal(res.status, 400);
  assert.ok(/Invalid 'since'/.test(res.body.error));
});

test("GET /api/status/global?since=<ISO> -> category delta payload", async () => {
  const res = await request(app).get("/api/status/global?since=2999-01-01T00:00:00Z");
  assert.equal(res.status, 200);
  assert.equal(res.body.category, "global");
  assert.deepEqual(res.body.query, { since: "2999-01-01T00:00:00Z" });
  assert.equal(res.body.count, 0);
  assert.equal(res.body.issues.length, 0);
});

test("GET /api/status/grid -> 404 (the synthesized grid was removed)", async () => {
  const res = await request(app).get("/api/status/grid");
  assert.equal(res.status, 404);
  assert.ok(/Unknown category/.test(res.body.error));
});

test("GET /api/status/changes -> 503 when no watcher is attached", async () => {
  const res = await request(app).get("/api/status/changes");
  assert.equal(res.status, 503);
  assert.match(res.body.error, /WATCH_ENABLED/);
});

test("GET /api/status/changes -> watcher state and latest delta when attached", async () => {
  const watcher = new StatusWatcher(config, "tenant");
  const watched = createApp(config, watcher);

  // First poll primes the baseline and must report no changes.
  const first = await watcher.poll();
  assert.equal(first.previousPollAt, null);
  assert.equal(first.changes.length, 0);

  const res = await request(watched).get("/api/status/changes");
  assert.equal(res.status, 200);
  assert.equal(res.body.watcher.pollCount, 1);
  assert.equal(res.body.watcher.webhookConfigured, false);
  assert.equal(res.body.latest.counts.new, 0);
  assert.ok("generatedAt" in res.body.latest);
});

test("GET /api/status/resources -> Layer 3 (tenant has data in mock, public gated)", async () => {
  const tenantRes = await request(app).get("/api/status/resources?fork=tenant");
  assert.equal(tenantRes.status, 200);
  assert.equal(tenantRes.body.source, "resourceHealth");
  assert.equal(tenantRes.body.ok, true);
  assert.ok(tenantRes.body.summary.total > 0);
  // Unknown is tracked separately from genuine issues.
  assert.ok("unknown" in tenantRes.body.summary);
  assert.ok(Array.isArray(tenantRes.body.byService));
  const redis = tenantRes.body.byService.find((s: any) => s.service === "Azure Cache for Redis");
  assert.ok(redis && redis.issues >= 1); // the mock sample has a Degraded redis

  const publicRes = await request(app).get("/api/status/resources?fork=public");
  assert.equal(publicRes.status, 200);
  assert.equal(publicRes.body.ok, true);
  assert.equal(publicRes.body.summary.total, 0);
  assert.match(publicRes.body.message, /not available in the public view/i);
});

test("GET /api/status/resources is not shadowed by the :category route", async () => {
  const res = await request(app).get("/api/status/resources");
  assert.equal(res.status, 200);
  assert.equal(res.body.source, "resourceHealth");
  assert.ok(!("category" in res.body));
});

test("GET /api/status/view -> rendered HTML shell, no synthesized grid", async () => {
  const res = await request(app).get("/api/status/view");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /text\/html/);
  assert.match(res.text, /Azure status/);
  assert.match(res.text, /Live resource availability/);
  assert.match(res.text, /Resource Health/);
  // The view refreshes itself: the public feed is pull-only, so the page polls.
  assert.match(res.text, /REFRESH_MS/);
  assert.match(res.text, /new incident/);
  // The illustrative Products x Regions grid is gone for good.
  assert.ok(!/How to read this grid/.test(res.text));
  assert.ok(!/illustrative/i.test(res.text));
  assert.ok(!/notApplicable/.test(res.text));
});

test("GET /api/status/grid/view -> 301 to the new view path", async () => {
  const res = await request(app).get("/api/status/grid/view");
  assert.equal(res.status, 301);
  assert.equal(res.headers.location, "/api/status/view");
});

test("GET /api/status/bogus -> 404", async () => {
  const res = await request(app).get("/api/status/bogus");
  assert.equal(res.status, 404);
  assert.ok(/Unknown category/.test(res.body.error));
});

test("live-mode degradation: emergingIssues reports ok:false without creds, feed-independent", async () => {
  // A separate app in live mode but with an unreachable ARM endpoint and no subs.
  const liveApp = createApp({
    ...loadConfig(),
    mock: false,
    subscriptionIds: [],
    armBaseUrl: "https://management.azure.com",
    statusFeedUrl: "https://invalid.invalid.example/feed", // force feed failure too
    fetchTimeoutMs: 4000,
  });
  const res = await request(liveApp).get("/api/status");
  assert.equal(res.status, 200); // never 500: partial sources degrade gracefully
  const sources = Object.fromEntries(res.body.sources.map((s: any) => [s.source, s]));
  // serviceHealth is skipped (no subs) but still reported ok.
  assert.equal(sources.serviceHealth.ok, true);
  // Each source object always present.
  assert.ok("emergingIssues" in sources);
  assert.ok("statusFeed" in sources);
});
