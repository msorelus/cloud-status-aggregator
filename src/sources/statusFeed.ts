import { XMLParser } from "fast-xml-parser";
import { AppConfig } from "../config";
import { SourceResult, StatusIssue, IssueCategory, IssueStatus } from "../types";
import { fetchWithTimeout, stableId, stripHtml } from "../util";

/**
 * Azure Status public RSS feed
 * ----------------------------
 * https://azure.status.microsoft/en-us/status/feed/
 *
 * Fully public (no auth) and subscription-independent. It carries the incidents
 * and planned-maintenance notices published to the Azure Status page, which is
 * exactly the "global / regional / planned maintenance" view operators ask for.
 *
 * We classify each <item> into our categories using simple keyword heuristics on
 * the title/category fields. The POC keeps this transparent and tunable.
 */

const REGION_HINTS = [
  "east us", "west us", "central us", "south central", "north central",
  "west europe", "north europe", "southeast asia", "east asia",
  "australia", "japan", "uk south", "uk west", "brazil", "canada",
  "france", "germany", "india", "korea", "norway", "switzerland",
  "uae", "south africa", "region", "zone",
];

function classify(title: string, category: string): IssueCategory {
  const hay = `${title} ${category}`.toLowerCase();
  if (/(planned|scheduled)?\s*mainten|upgrade|patch/.test(hay)) return "maintenance";
  if (REGION_HINTS.some((h) => hay.includes(h))) return "regional";
  return "global";
}

function classifyStatus(title: string, category: string): IssueStatus {
  const hay = `${title} ${category}`.toLowerCase();
  if (/resolved|mitigated|closed/.test(hay)) return "resolved";
  if (/maintenance|scheduled/.test(hay)) return "scheduled";
  if (/investigating|active|impact|degraded|outage/.test(hay)) return "active";
  return "information";
}

export async function getStatusFeed(config: AppConfig): Promise<SourceResult> {
  const source = "statusFeed" as const;
  try {
    const res = await fetchWithTimeout(
      config.statusFeedUrl,
      { headers: { Accept: "application/rss+xml, application/xml, text/xml" } },
      config.fetchTimeoutMs
    );
    if (!res.ok) {
      return {
        source,
        ok: false,
        message: `status feed returned HTTP ${res.status}`,
        issues: [],
      };
    }
    const xml = await res.text();
    return { source, ok: true, issues: parseStatusFeed(xml) };
  } catch (err: any) {
    return {
      source,
      ok: false,
      message: `status feed request failed: ${err?.message || String(err)}`,
      issues: [],
    };
  }
}

export function parseStatusFeed(xml: string): StatusIssue[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });
  const doc = parser.parse(xml);

  const channel = doc?.rss?.channel;
  if (!channel) return [];

  let items = channel.item;
  if (!items) return []; // empty feed = no current incidents (a healthy signal)
  if (!Array.isArray(items)) items = [items];

  const issues: StatusIssue[] = [];
  for (const item of items) {
    const title: string = (item.title || "").toString();
    const rawCategory = item.category;
    const category: string = Array.isArray(rawCategory)
      ? rawCategory.join(" ")
      : (rawCategory || "").toString();
    const cat = classify(title, category);

    issues.push({
      id: stableId("feed", title, (item.pubDate || "").toString()),
      category: cat,
      status: classifyStatus(title, category),
      title: title || "Azure status update",
      summary: stripHtml((item.description || "").toString()),
      impactedServices: [],
      impactedRegions: [],
      startTime: item.pubDate ? new Date(item.pubDate).toISOString() : undefined,
      lastUpdateTime: item.pubDate ? new Date(item.pubDate).toISOString() : undefined,
      link: (item.link || "https://azure.status.microsoft/status").toString(),
      source: "statusFeed",
    });
  }
  return issues;
}
