import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { diffIssues, snapshotOf, signPayload, StatusWatcher } from "../src/watch";
import { loadConfig } from "../src/config";
import { StatusIssue } from "../src/types";

function issue(over: Partial<StatusIssue> = {}): StatusIssue {
  return {
    id: "i-1",
    category: "global",
    status: "active",
    title: "Storage degraded in East US 2",
    impactedServices: ["Storage"],
    impactedRegions: ["East US 2"],
    trackingId: "ABC1-DEF",
    lastUpdateTime: "2026-08-03T12:00:00Z",
    source: "statusFeed",
    ...over,
  };
}

test("first snapshot vs an empty baseline reports every issue as new", () => {
  const changes = diffIssues(new Map(), [issue(), issue({ id: "i-2" })]);
  assert.equal(changes.length, 2);
  assert.ok(changes.every((c) => c.kind === "new"));
});

test("an unchanged issue produces no change at all", () => {
  const before = snapshotOf([issue()]);
  assert.deepEqual(diffIssues(before, [issue()]), []);
});

test("a moved lastUpdateTime is an update, and carries the previous timestamp", () => {
  const before = snapshotOf([issue()]);
  const changes = diffIssues(before, [
    issue({ lastUpdateTime: "2026-08-03T12:30:00Z" }),
  ]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "updated");
  assert.equal(changes[0].previousUpdateTime, "2026-08-03T12:00:00Z");
});

test("a changed title or summary is an update even when the timestamp is static", () => {
  const before = snapshotOf([issue()]);
  const changes = diffIssues(before, [
    issue({ summary: "Mitigation applied, monitoring recovery." }),
  ]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "updated");
});

test("a status flip to resolved is classified as resolved, not updated", () => {
  const before = snapshotOf([issue()]);
  const changes = diffIssues(before, [
    issue({ status: "resolved", lastUpdateTime: "2026-08-03T13:00:00Z" }),
  ]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "resolved");
});

test("an issue that drops out of the feed is treated as resolved", () => {
  const before = snapshotOf([issue(), issue({ id: "i-2" })]);
  const changes = diffIssues(before, [issue()]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "resolved");
  assert.equal(changes[0].issue.id, "i-2");
  assert.equal(changes[0].issue.status, "resolved");
});

test("an already-resolved issue dropping out does not re-fire", () => {
  const before = snapshotOf([issue({ status: "resolved" })]);
  assert.deepEqual(diffIssues(before, []), []);
});

test("new, updated and resolved are detected together in one pass", () => {
  const before = snapshotOf([
    issue({ id: "keep" }),
    issue({ id: "move" }),
    issue({ id: "gone" }),
  ]);
  const changes = diffIssues(before, [
    issue({ id: "keep" }),
    issue({ id: "move", lastUpdateTime: "2026-08-03T14:00:00Z" }),
    issue({ id: "fresh" }),
  ]);
  const byKind = Object.fromEntries(
    ["new", "updated", "resolved"].map((k) => [
      k,
      changes.filter((c) => c.kind === k).map((c) => c.issue.id),
    ])
  );
  assert.deepEqual(byKind.new, ["fresh"]);
  assert.deepEqual(byKind.updated, ["move"]);
  assert.deepEqual(byKind.resolved, ["gone"]);
});

test("the webhook signature is a verifiable HMAC-SHA256 over the exact body", () => {
  const body = JSON.stringify({ hello: "world" });
  const secret = "s3cr3t";
  const sig = signPayload(body, secret);
  const expected = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  assert.equal(sig, expected);
  // A single byte of tampering must break verification.
  assert.notEqual(signPayload(body + " ", secret), expected);
});

test("the watcher suppresses changes on its very first poll", async () => {
  const watcher = new StatusWatcher({ ...loadConfig(), mock: true }, "tenant");

  const first = await watcher.poll();
  assert.equal(first.previousPollAt, null);
  assert.equal(first.changes.length, 0, "a restart must not replay known incidents");
  assert.equal(watcher.state.pollCount, 1);

  // Mock data is stable, so a second poll against it must also be quiet.
  const second = await watcher.poll();
  assert.ok(second.previousPollAt);
  assert.equal(second.changes.length, 0);
  assert.equal(second.counts.new, 0);
});

test("the watcher records a delta when the feed moves under it", async () => {
  const watcher = new StatusWatcher({ ...loadConfig(), mock: true }, "tenant");
  await watcher.poll();

  // Reach into the private baseline to simulate an incident closing and a new
  // one opening between polls, without needing a live outage.
  const priv = watcher as unknown as { previous: Map<string, unknown> };
  priv.previous.set("synthetic-outage", {
    issue: issue({ id: "synthetic-outage" }),
    fingerprint: "stale",
  });

  const set = await watcher.poll();
  assert.equal(set.counts.resolved, 1);
  assert.equal(set.changes[0].issue.id, "synthetic-outage");
  assert.ok(watcher.state.lastChangeAt);
});
