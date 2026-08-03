import { AggregatedStatus, StatusIssue } from "./types";

/** Most recent timestamp we can attribute to an issue (update beats start). */
export function issueTimestamp(issue: StatusIssue): string | undefined {
  return issue.lastUpdateTime || issue.startTime;
}

/**
 * Keep only issues new or updated at/after `sinceIso`. Issues with no timestamp
 * are retained (we can't prove they're stale, and dropping a live incident is
 * the unsafe failure mode for an early-warning feed).
 */
export function filterIssuesSince(
  issues: StatusIssue[],
  sinceMs: number
): StatusIssue[] {
  return issues.filter((i) => {
    const ts = issueTimestamp(i);
    if (!ts) return true;
    const t = Date.parse(ts);
    return Number.isNaN(t) ? true : t >= sinceMs;
  });
}

/**
 * Apply a `?since=<ISO>` delta filter to an aggregated payload, recomputing
 * counts/overall over the filtered set. Returns the payload unchanged when
 * `since` is absent. Throws on an unparseable timestamp so the route can 400.
 */
export function applySince(
  data: AggregatedStatus,
  since?: string
): AggregatedStatus {
  if (!since) return data;
  const sinceMs = Date.parse(since);
  if (Number.isNaN(sinceMs)) {
    throw new Error(
      `Invalid 'since' value '${since}'. Expected an ISO 8601 timestamp (e.g. 2026-06-02T00:00:00Z).`
    );
  }

  const global = filterIssuesSince(data.global, sinceMs);
  const regional = filterIssuesSince(data.regional, sinceMs);
  const maintenance = filterIssuesSince(data.maintenance, sinceMs);

  const overall: AggregatedStatus["overall"] =
    global.length > 0 || regional.length > 0
      ? "degraded"
      : maintenance.length > 0
      ? "advisory"
      : "healthy";

  return {
    ...data,
    overall,
    counts: {
      global: global.length,
      regional: regional.length,
      maintenance: maintenance.length,
    },
    global,
    regional,
    maintenance,
  };
}
