/**
 * Change watcher + webhook publisher.
 *
 * WHY THIS EXISTS
 * ---------------
 * Microsoft publishes no push mechanism for the *public* Azure Status feed. The
 * documented way to subscribe is the RSS feed, which is poll-only. Service
 * Health alerts do fan out to Action Groups and webhooks, but they fire from
 * Activity Log events and therefore require a subscription (or tenant/Directory
 * scope). Neither gives a distributor a push signal off the public feed.
 *
 * So we build it: poll the aggregator on an interval, diff each incident
 * against the last-seen snapshot, and POST only the deltas to a subscriber.
 * That turns a pull-only Microsoft feed into a push feed for your own systems, and it
 * generalizes — any vendor feed normalized into `StatusIssue` rides the same
 * publisher.
 *
 * The watcher holds its baseline in memory. A restart re-primes from the first
 * poll and suppresses that poll's "new" events, so a redeploy never floods
 * subscribers with incidents they were already told about.
 */

import { createHmac } from "crypto";
import { AppConfig } from "./config";
import { collectStatus, Fork } from "./collect";
import { ChangeSet, StatusChange, StatusIssue } from "./types";
import { fetchWithTimeout } from "./util";

/** A fingerprint of the parts of an issue whose change is worth publishing. */
function fingerprint(issue: StatusIssue): string {
  return [
    issue.status,
    issue.lastUpdateTime || "",
    issue.title,
    issue.summary || "",
  ].join("\u0000");
}

interface Seen {
  issue: StatusIssue;
  fingerprint: string;
}

/**
 * Diff a fresh issue list against the previous snapshot.
 *
 * - `new`      — an id we have never seen
 * - `updated`  — a known id whose status/timestamp/text moved
 * - `resolved` — a known id that has dropped out of the feed, or whose status
 *                flipped to "resolved"
 */
export function diffIssues(
  previous: Map<string, Seen>,
  current: StatusIssue[]
): StatusChange[] {
  const changes: StatusChange[] = [];
  const currentIds = new Set<string>();

  for (const issue of current) {
    currentIds.add(issue.id);
    const before = previous.get(issue.id);
    const fp = fingerprint(issue);

    if (!before) {
      changes.push({ kind: "new", issue });
      continue;
    }
    if (before.fingerprint === fp) continue;

    const becameResolved =
      before.issue.status !== "resolved" && issue.status === "resolved";
    changes.push({
      kind: becameResolved ? "resolved" : "updated",
      issue,
      previousUpdateTime: before.issue.lastUpdateTime,
    });
  }

  // An id that vanished from the feed is treated as resolved — Microsoft drops
  // items off the status feed once an incident closes.
  for (const [id, before] of previous) {
    if (currentIds.has(id)) continue;
    if (before.issue.status === "resolved") continue;
    changes.push({
      kind: "resolved",
      issue: { ...before.issue, status: "resolved" },
      previousUpdateTime: before.issue.lastUpdateTime,
    });
  }

  return changes;
}

export function snapshotOf(issues: StatusIssue[]): Map<string, Seen> {
  const map = new Map<string, Seen>();
  for (const issue of issues) {
    map.set(issue.id, { issue, fingerprint: fingerprint(issue) });
  }
  return map;
}

function countKinds(changes: StatusChange[]): ChangeSet["counts"] {
  return {
    new: changes.filter((c) => c.kind === "new").length,
    updated: changes.filter((c) => c.kind === "updated").length,
    resolved: changes.filter((c) => c.kind === "resolved").length,
  };
}

/**
 * HMAC-SHA256 over the exact request body, hex encoded. Subscribers recompute
 * this with the shared secret to prove the POST came from the aggregator and
 * was not tampered with in transit.
 */
export function signPayload(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

export interface WatcherState {
  running: boolean;
  lastPollAt: string | null;
  lastChangeAt: string | null;
  pollCount: number;
  lastError: string | null;
  lastDelivery: {
    at: string;
    status: number | null;
    ok: boolean;
    error?: string;
  } | null;
  latest: ChangeSet | null;
}

export class StatusWatcher {
  private readonly config: AppConfig;
  private readonly fork: Fork;
  private timer: NodeJS.Timeout | null = null;
  private previous: Map<string, Seen> | null = null;
  private previousPollAt: string | null = null;

  readonly state: WatcherState = {
    running: false,
    lastPollAt: null,
    lastChangeAt: null,
    pollCount: 0,
    lastError: null,
    lastDelivery: null,
    latest: null,
  };

  constructor(config: AppConfig, fork: Fork = "tenant") {
    this.config = config;
    this.fork = fork;
  }

  start(): void {
    if (this.timer) return;
    this.state.running = true;
    // Prime immediately so /api/status/changes is useful straight away, then
    // settle into the configured interval.
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.config.watchIntervalMs);
    // Never hold the process open on the watcher alone.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state.running = false;
  }

  /** One poll: collect, diff, record, publish. Safe to call directly in tests. */
  async poll(): Promise<ChangeSet> {
    const now = new Date().toISOString();
    try {
      const data = await collectStatus(this.config, this.fork);
      const issues = [...data.global, ...data.regional, ...data.maintenance];
      const isFirstPoll = this.previous === null;
      const changes = isFirstPoll ? [] : diffIssues(this.previous!, issues);

      const set: ChangeSet = {
        generatedAt: now,
        previousPollAt: this.previousPollAt,
        overall: data.overall,
        counts: countKinds(changes),
        changes,
      };

      this.previous = snapshotOf(issues);
      this.previousPollAt = now;
      this.state.lastPollAt = now;
      this.state.pollCount++;
      this.state.lastError = null;
      this.state.latest = set;
      if (changes.length > 0) this.state.lastChangeAt = now;

      if (changes.length > 0) await this.publish(set);
      return set;
    } catch (err: any) {
      this.state.lastError = err?.message || String(err);
      this.state.lastPollAt = now;
      this.state.pollCount++;
      const empty: ChangeSet = {
        generatedAt: now,
        previousPollAt: this.previousPollAt,
        overall: "healthy",
        counts: { new: 0, updated: 0, resolved: 0 },
        changes: [],
      };
      return empty;
    }
  }

  /** POST the delta to the configured subscriber, signed when a secret is set. */
  private async publish(set: ChangeSet): Promise<void> {
    const url = this.config.webhookUrl;
    if (!url) return;

    const body = JSON.stringify({
      specVersion: "1.0",
      vendor: "microsoft-azure",
      source: "cloud-status-aggregator",
      ...set,
    });

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "cloud-status-aggregator/0.1",
    };
    if (this.config.webhookSecret) {
      headers["x-aggregator-signature"] =
        "sha256=" + signPayload(body, this.config.webhookSecret);
    }

    try {
      const res = await fetchWithTimeout(
        url,
        { method: "POST", headers, body },
        this.config.fetchTimeoutMs
      );
      this.state.lastDelivery = {
        at: new Date().toISOString(),
        status: res.status,
        ok: res.ok,
        ...(res.ok ? {} : { error: `Subscriber returned HTTP ${res.status}` }),
      };
    } catch (err: any) {
      this.state.lastDelivery = {
        at: new Date().toISOString(),
        status: null,
        ok: false,
        error: err?.message || String(err),
      };
    }
  }
}
