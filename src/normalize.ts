import { AggregatedStatus, SourceResult, StatusIssue } from "./types";

/** Merge all source results into the single unified Azure-Status-style payload. */
export function aggregate(results: SourceResult[]): AggregatedStatus {
  const all: StatusIssue[] = [];
  for (const r of results) all.push(...r.issues);

  const deduped = dedupe(all);

  const global = deduped.filter((i) => i.category === "global");
  const regional = deduped.filter((i) => i.category === "regional");
  const maintenance = deduped.filter((i) => i.category === "maintenance");

  const activeGlobal = global.some((i) => i.status === "active");
  const activeRegional = regional.some((i) => i.status === "active");

  let overall: AggregatedStatus["overall"] = "healthy";
  if (activeGlobal || activeRegional) overall = "degraded";
  else if (global.length + regional.length > 0) overall = "advisory";

  return {
    generatedAt: new Date().toISOString(),
    overall,
    counts: {
      global: global.length,
      regional: regional.length,
      maintenance: maintenance.length,
    },
    sources: results.map((r) => ({
      source: r.source,
      ok: r.ok,
      message: r.message,
      count: r.issues.length,
    })),
    global: sortIssues(global),
    regional: sortIssues(regional),
    maintenance: sortIssues(maintenance),
  };
}

/**
 * Prefer a tracking id, but ALSO fold in records that share a normalized title.
 * This is what merges the same incident arriving from emergingIssues (with a
 * tracking id) and the public RSS feed (without one).
 */
function dedupe(issues: StatusIssue[]): StatusIssue[] {
  const score = (i: StatusIssue) =>
    i.impactedServices.length +
    i.impactedRegions.length +
    (i.status === "active" ? 2 : 0) +
    (i.trackingId ? 1 : 0);

  const byTitle = new Map<string, StatusIssue>();
  const byTracking = new Map<string, string>(); // trackingId -> titleKey

  for (const issue of issues) {
    const titleKey = normalizeTitle(issue.title);
    const tid = issue.trackingId?.toLowerCase().trim();

    // Resolve which title-bucket this belongs to (via tracking id alias).
    let key = titleKey;
    if (tid && byTracking.has(tid)) {
      key = byTracking.get(tid)!;
    }

    const existing = byTitle.get(key);
    if (!existing) {
      byTitle.set(key, issue);
    } else if (score(issue) > score(existing)) {
      byTitle.set(key, issue);
    }
    if (tid) byTracking.set(tid, key);
  }

  return [...byTitle.values()];
}

/** Lowercase, strip punctuation/extra whitespace so near-identical titles match. */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function sortIssues(issues: StatusIssue[]): StatusIssue[] {
  const rank: Record<string, number> = { active: 0, "in-progress": 1, scheduled: 2 };
  return [...issues].sort((a, b) => {
    const ra = rank[a.status] ?? 9;
    const rb = rank[b.status] ?? 9;
    if (ra !== rb) return ra - rb;
    const ta = a.lastUpdateTime || a.startTime || "";
    const tb = b.lastUpdateTime || b.startTime || "";
    return tb.localeCompare(ta);
  });
}
