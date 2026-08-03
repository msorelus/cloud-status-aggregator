import { DefaultAzureCredential } from "@azure/identity";
import { AppConfig } from "../config";
import { SourceResult, StatusIssue, IssueStatus } from "../types";
import { fetchWithTimeout, stableId, stripHtml } from "../util";

/**
 * Microsoft.ResourceHealth/emergingIssues
 * ---------------------------------------
 * This is the closest thing to a programmatic "Azure Status page" feed. It is
 * exposed at the *provider* level (no subscription in the path), so the content
 * is the same global/regional banner everyone sees on azure.status.microsoft.
 *
 *   GET {arm}/providers/Microsoft.ResourceHealth/emergingIssues?api-version=2022-10-01
 *
 * Auth: an ARM bearer token (Reader is sufficient). In a deployed tenant this is
 * obtained via the hosting app's Managed Identity (DefaultAzureCredential).
 */

let cachedCredential: DefaultAzureCredential | null = null;
function getCredential(): DefaultAzureCredential {
  if (!cachedCredential) cachedCredential = new DefaultAzureCredential();
  return cachedCredential;
}

function mapBannerStatus(): IssueStatus {
  return "information";
}

/** Pull service names + region names from the real `impacts[]` schema. */
function extractFromImpacts(impacts: any): { services: string[]; regions: string[] } {
  const services = new Set<string>();
  const regions = new Set<string>();
  if (Array.isArray(impacts)) {
    for (const imp of impacts) {
      if (imp?.name) services.add(String(imp.name));
      for (const r of imp?.regions || []) {
        if (r?.name) regions.add(String(r.name));
      }
    }
  }
  return { services: [...services], regions: [...regions] };
}

export async function getEmergingIssues(config: AppConfig): Promise<SourceResult> {
  const source = "emergingIssues" as const;
  let token: string;
  try {
    const accessToken = await getCredential().getToken(config.armScope);
    if (!accessToken?.token) throw new Error("empty token");
    token = accessToken.token;
  } catch (err: any) {
    return {
      source,
      ok: false,
      message:
        "No Azure credential available. Deploy with a Managed Identity (Reader) " +
        "or set AZURE_* env vars. Detail: " +
        (err?.message || String(err)),
      issues: [],
    };
  }

  const url =
    `${config.armBaseUrl}/providers/Microsoft.ResourceHealth/emergingIssues` +
    `?api-version=${config.emergingIssuesApiVersion}`;

  try {
    const res = await fetchWithTimeout(
      url,
      { headers: { Authorization: `Bearer ${token}` } },
      config.fetchTimeoutMs
    );
    if (!res.ok) {
      const body = await res.text();
      return {
        source,
        ok: false,
        message: `emergingIssues returned HTTP ${res.status}: ${body.slice(0, 300)}`,
        issues: [],
      };
    }
    const data = await res.json();
    return { source, ok: true, issues: parseEmergingIssues(data) };
  } catch (err: any) {
    return {
      source,
      ok: false,
      message: `emergingIssues request failed: ${err?.message || String(err)}`,
      issues: [],
    };
  }
}

/**
 * Parse the ARM emergingIssues payload into our unified issue list.
 *
 * Wire shape (confirmed against the live 2022-10-01 API):
 *   value[].properties.{ refreshTimestamp, statusActiveEvents[], statusBanners[] }
 *   StatusActiveEvent: { title, description, trackingId, startTime, cloud,
 *                        severity, stage, lastModifiedTime, impacts[] }
 *   impacts[]:         { id, name, regions[] }   regions[]: { id, name }
 *   StatusBanner:      { title, message, cloud, lastModifiedTime }
 */
export function parseEmergingIssues(data: any): StatusIssue[] {
  const issues: StatusIssue[] = [];
  const records: any[] = Array.isArray(data?.value) ? data.value : [];

  for (const rec of records) {
    const props = rec?.properties || {};
    const refreshTime: string | undefined = props.refreshTimestamp;

    // Active events => the global outage banner shown atop the status page.
    for (const ev of props.statusActiveEvents || []) {
      const { services, regions } = extractFromImpacts(ev.impacts);
      issues.push({
        id: stableId("ei-active", ev.title || "", ev.trackingId || ""),
        category: regions.length > 0 && services.length === 0 ? "regional" : "global",
        status: "active",
        title: ev.title || "Azure service issue",
        summary: stripHtml(ev.description),
        impactedServices: services,
        impactedRegions: regions,
        trackingId: ev.trackingId,
        startTime: ev.startTime,
        lastUpdateTime: ev.lastModifiedTime || refreshTime,
        link: "https://azure.status.microsoft/status",
        source: "emergingIssues",
      });
    }

    // Banners => informational notices (e.g. region advisories). `cloud` is the
    // cloud (Public / USGov), NOT a region, so we don't treat it as one.
    for (const banner of props.statusBanners || []) {
      issues.push({
        id: stableId("ei-banner", banner.title || "", banner.cloud || ""),
        category: classifyBannerCategory(banner.title || ""),
        status: mapBannerStatus(),
        title: banner.title || "Azure status banner",
        summary: stripHtml(banner.message),
        impactedServices: [],
        impactedRegions: [],
        lastUpdateTime: banner.lastModifiedTime || refreshTime,
        link: "https://azure.status.microsoft/status",
        source: "emergingIssues",
      });
    }
  }

  return issues;
}

const REGION_KEYWORDS = [
  "east us", "west us", "central us", "south central", "north central",
  "west europe", "north europe", "southeast asia", "east asia",
  "australia", "japan", "uk south", "uk west", "brazil", "canada",
  "france", "germany", "india", "korea", "norway", "switzerland",
  "uae", "south africa", "region",
];

function classifyBannerCategory(title: string): "global" | "regional" | "maintenance" {
  const hay = title.toLowerCase();
  if (/mainten|upgrade|patch/.test(hay)) return "maintenance";
  if (REGION_KEYWORDS.some((k) => hay.includes(k))) return "regional";
  return "global";
}
