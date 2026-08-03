/**
 * Unified, subscription-independent status model.
 *
 * This normalizes three Microsoft sources into one shape so downstream consumers
 * get a single, stable contract regardless of where the data came from:
 *   - Microsoft.ResourceHealth/emergingIssues  (global / regional banner)
 *   - Azure Status public RSS feed             (incidents + planned maintenance)
 *   - ServiceHealthResources (Resource Graph)  (optional, subscription-scoped)
 */

export type IssueCategory = "global" | "regional" | "maintenance";

export type IssueStatus =
  | "active"
  | "resolved"
  | "scheduled"
  | "in-progress"
  | "information"
  | "unknown";

export type IssueSource = "emergingIssues" | "statusFeed" | "serviceHealth";

export interface StatusIssue {
  /** Stable-ish id for dedupe (tracking id when available, else hashed title). */
  id: string;
  category: IssueCategory;
  status: IssueStatus;
  title: string;
  summary?: string;
  /** Impacted Azure services, when the source exposes them. */
  impactedServices: string[];
  /** Impacted regions, when the source exposes them. */
  impactedRegions: string[];
  /** Microsoft tracking id (e.g. service health event), when present. */
  trackingId?: string;
  startTime?: string;
  lastUpdateTime?: string;
  link?: string;
  source: IssueSource;
}

export interface SourceResult {
  source: IssueSource;
  ok: boolean;
  /** Why a source is unavailable (e.g. no credential, network). Keeps the POC transparent. */
  message?: string;
  issues: StatusIssue[];
}

export interface AggregatedStatus {
  generatedAt: string;
  /** Worst-case rollup: "healthy" | "advisory" | "degraded". */
  overall: "healthy" | "advisory" | "degraded";
  counts: {
    global: number;
    regional: number;
    maintenance: number;
  };
  sources: Array<{
    source: IssueSource;
    ok: boolean;
    message?: string;
    count: number;
  }>;
  global: StatusIssue[];
  regional: StatusIssue[];
  maintenance: StatusIssue[];
}

/**
 * A single detected change between two polls, emitted by the watcher and
 * published to subscribers over webhook.
 */
export type ChangeKind = "new" | "updated" | "resolved";

export interface StatusChange {
  kind: ChangeKind;
  issue: StatusIssue;
  /** Previous lastUpdateTime, present on "updated". */
  previousUpdateTime?: string;
}

export interface ChangeSet {
  generatedAt: string;
  /** Null on the very first poll — there is no baseline to diff against yet. */
  previousPollAt: string | null;
  overall: AggregatedStatus["overall"];
  counts: {
    new: number;
    updated: number;
    resolved: number;
  };
  changes: StatusChange[];
}
