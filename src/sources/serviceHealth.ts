import { DefaultAzureCredential } from "@azure/identity";
import { AppConfig } from "../config";
import { SourceResult, StatusIssue, IssueCategory, IssueStatus } from "../types";
import { fetchWithTimeout, stableId, stripHtml } from "../util";

/**
 * ServiceHealthResources via Azure Resource Graph  (OPTIONAL / subscription-scoped)
 * --------------------------------------------------------------------------------
 * This is the one source that IS tied to subscriptions. Operators explicitly want
 * subscription-independent data, so this is OFF by default (only runs when
 * SUBSCRIPTION_IDS is set). It's included so the same API can ALSO answer
 * "what is impacting MY subscriptions right now" — a natural follow-on ask.
 *
 *   POST {arm}/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01
 *   body: { subscriptions: [...], query: "ServiceHealthResources | ..." }
 */

export const ACTIVE_EVENTS_KQL = `
ServiceHealthResources
| where type =~ 'microsoft.resourcehealth/events'
| where properties.Status == 'Active'
| project eventType = tostring(properties.EventType),
          status = tostring(properties.Status),
          title = tostring(properties.Title),
          trackingId = tostring(properties.TrackingId),
          summary = tostring(properties.Summary),
          impactStartTime = todatetime(properties.ImpactStartTime),
          lastUpdateTime = todatetime(properties.LastUpdateTime),
          impact = properties.Impact
`;

export const PLANNED_MAINTENANCE_KQL = `
ServiceHealthResources
| where type =~ 'microsoft.resourcehealth/events'
| where properties.EventType == 'PlannedMaintenance'
| extend impactMitigationTime = todatetime(properties.ImpactMitigationTime)
| where impactMitigationTime > now()
| project eventType = tostring(properties.EventType), status = tostring(properties.Status),
          title = tostring(properties.Title), trackingId = tostring(properties.TrackingId),
          summary = tostring(properties.Summary),
          impactStartTime = todatetime(properties.ImpactStartTime),
          impactMitigationTime, impact = properties.Impact
`;

let cachedCredential: DefaultAzureCredential | null = null;
function getCredential(): DefaultAzureCredential {
  if (!cachedCredential) cachedCredential = new DefaultAzureCredential();
  return cachedCredential;
}

function categoryFor(eventType: string): IssueCategory {
  const t = (eventType || "").toLowerCase();
  if (t.includes("maintenance")) return "maintenance";
  if (t.includes("incident") || t.includes("issue")) return "global";
  return "regional";
}

export async function getServiceHealth(config: AppConfig): Promise<SourceResult> {
  const source = "serviceHealth" as const;

  if (config.subscriptionIds.length === 0) {
    return {
      source,
      ok: true,
      message:
        "Skipped: no SUBSCRIPTION_IDS configured (this source is subscription-scoped and optional).",
      issues: [],
    };
  }

  let token: string;
  try {
    const accessToken = await getCredential().getToken(config.armScope);
    if (!accessToken?.token) throw new Error("empty token");
    token = accessToken.token;
  } catch (err: any) {
    return {
      source,
      ok: false,
      message: `No Azure credential for Resource Graph: ${err?.message || String(err)}`,
      issues: [],
    };
  }

  const url = `${config.armBaseUrl}/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01`;
  try {
    const [active, plannedMaintenance] = await Promise.all([
      queryResourceGraph(url, token, config, ACTIVE_EVENTS_KQL),
      queryResourceGraph(url, token, config, PLANNED_MAINTENANCE_KQL),
    ]);
    return {
      source,
      ok: true,
      issues: parseServiceHealth({
        data: dedupeRowsByTrackingId([
          ...rowsFrom(active),
          ...rowsFrom(plannedMaintenance),
        ]),
      }),
    };
  } catch (err: any) {
    return {
      source,
      ok: false,
      message: `Resource Graph request failed: ${err?.message || String(err)}`,
      issues: [],
    };
  }
}

async function queryResourceGraph(
  url: string,
  token: string,
  config: AppConfig,
  query: string
): Promise<any> {
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        subscriptions: config.subscriptionIds,
        query,
      }),
    },
    config.fetchTimeoutMs
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resource Graph HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

function rowsFrom(data: any): any[] {
  return Array.isArray(data?.data) ? data.data : [];
}

function dedupeRowsByTrackingId(rows: any[]): any[] {
  const seen = new Set<string>();
  const deduped: any[] = [];
  for (const row of rows) {
    const key = row?.trackingId || stableId("sh-row", row?.title || "", row?.impactStartTime || "");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

export function parseServiceHealth(data: any): StatusIssue[] {
  const rows: any[] = Array.isArray(data?.data) ? data.data : [];
  return rows.map((r) => {
    const category = categoryFor(r.eventType);
    const startTime = normalizeTime(r.impactStartTime);
    const lastUpdateTime = normalizeTime(r.lastUpdateTime || r.impactMitigationTime);
    return {
      id: r.trackingId || stableId("sh", r.title || "", startTime || ""),
      category,
      status: statusFor(category, r.status),
      title: r.title || "Service Health event",
      summary: stripHtml(r.summary),
      impactedServices: extractServices(r.impact),
      impactedRegions: extractRegions(r.impact),
      trackingId: r.trackingId,
      startTime,
      lastUpdateTime,
      link: "https://portal.azure.com/#blade/Microsoft_Azure_Health/AzureHealthBrowseBlade/serviceIssues",
      source: "serviceHealth",
    };
  });
}

function statusFor(category: IssueCategory, status: string): IssueStatus {
  if (category === "maintenance" && !/^active$/i.test(status || "")) {
    return "scheduled";
  }
  return "active";
}

function normalizeTime(value: any): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "number" || /^[0-9]+$/.test(String(value))) {
    const ticks = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(ticks)) {
      const unixMs = (ticks - 621355968000000000) / 10000;
      const date = new Date(unixMs);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function extractServices(impact: any): string[] {
  if (!Array.isArray(impact)) return [];
  return impact.map((i) => i?.ImpactedService).filter(Boolean);
}

function extractRegions(impact: any): string[] {
  if (!Array.isArray(impact)) return [];
  const regions = new Set<string>();
  for (const i of impact) {
    for (const r of i?.ImpactedRegions || []) {
      if (r?.RegionName) regions.add(r.RegionName);
    }
  }
  return [...regions];
}
