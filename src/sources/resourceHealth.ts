import { DefaultAzureCredential } from "@azure/identity";
import { AppConfig } from "../config";
import { REGION_VOCAB } from "../match";
import { fetchWithTimeout, stripHtml } from "../util";

/**
 * Azure Resource Health  (LAYER 3 — subscription-scoped, per-resource)
 * --------------------------------------------------------------------
 * The public Azure Status page (Layer 1) only reports widespread incidents, and
 * Service Health (Layer 2) reports service issues/advisories for the services you
 * use. Resource Health is the deepest layer: the live, minute-by-minute
 * availability of each INDIVIDUAL resource (VM, storage account, app, …).
 *
 * Microsoft.ResourceHealth/availabilityStatuses returns a "current" status per
 * resource. We list them per subscription:
 *   GET {arm}/subscriptions/{sub}/providers/Microsoft.ResourceHealth/availabilityStatuses
 *
 * This is OFF unless SUBSCRIPTION_IDS is set (it is subscription-scoped), and it
 * requires the Microsoft.ResourceHealth resource provider to be registered on the
 * subscription. It demonstrates exactly what a partner unlocks with tenant access
 * (and, across many customers, via Azure Lighthouse).
 */

export type AvailabilityState =
  | "Available"
  | "Unavailable"
  | "Degraded"
  | "Unknown";

export interface ResourceAvailability {
  resourceId: string;
  name: string;
  resourceType: string;
  service: string;
  region: string;
  state: AvailabilityState;
  summary?: string;
  occurredTime?: string;
}

export interface ResourceHealthSummary {
  total: number;
  available: number;
  degraded: number;
  unavailable: number;
  unknown: number;
}

export interface ServiceRollup {
  service: string;
  total: number;
  available: number;
  /** No active health signal from the platform (e.g. config-only resource types). */
  unknown: number;
  /** Genuinely impacted: Degraded + Unavailable. */
  issues: number;
}

export interface ResourceHealthResult {
  source: "resourceHealth";
  ok: boolean;
  message?: string;
  resources: ResourceAvailability[];
  summary: ResourceHealthSummary;
  byService: ServiceRollup[];
}

// ARM region code (e.g. "eastus2") -> display name (e.g. "East US 2").
const REGION_DISPLAY: Record<string, string> = Object.fromEntries(
  REGION_VOCAB.map((r: string) => [r.toLowerCase().replace(/\s+/g, ""), r])
);

// Friendly product names for the resource types Resource Health tracks.
const SERVICE_NAMES: Record<string, string> = {
  "microsoft.compute/virtualmachines": "Virtual Machines",
  "microsoft.compute/virtualmachinescalesets": "Virtual Machine Scale Sets",
  "microsoft.compute/disks": "Managed Disks",
  "microsoft.storage/storageaccounts": "Storage",
  "microsoft.sql/servers/databases": "Azure SQL Database",
  "microsoft.dbforpostgresql/flexibleservers": "Azure DB for PostgreSQL",
  "microsoft.documentdb/databaseaccounts": "Azure Cosmos DB",
  "microsoft.web/sites": "Azure App Service",
  "microsoft.web/serverfarms": "App Service Plan",
  "microsoft.app/containerapps": "Container Apps",
  "microsoft.app/managedenvironments": "Container Apps Environment",
  "microsoft.containerservice/managedclusters": "Azure Kubernetes Service",
  "microsoft.containerregistry/registries": "Container Registry",
  "microsoft.cognitiveservices/accounts": "Azure AI Services",
  "microsoft.cognitiveservices/accounts/projects": "Azure AI Foundry Projects",
  "microsoft.search/searchservices": "Azure AI Search",
  "microsoft.operationalinsights/workspaces": "Log Analytics",
  "microsoft.insights/components": "Application Insights",
  "microsoft.insights/metricalerts": "Azure Monitor Alerts",
  "microsoft.eventgrid/systemtopics": "Event Grid",
  "microsoft.eventgrid/topics": "Event Grid",
  "microsoft.eventhub/namespaces": "Event Hubs",
  "microsoft.keyvault/vaults": "Key Vault",
  "microsoft.apimanagement/service": "API Management",
  "microsoft.network/virtualnetworks": "Virtual Network",
  "microsoft.network/dnszones": "Azure DNS",
  "microsoft.network/loadbalancers": "Load Balancer",
  "microsoft.network/publicipaddresses": "Public IP Address",
  "microsoft.network/applicationgateways": "Application Gateway",
  "microsoft.cache/redis": "Azure Cache for Redis",
  "microsoft.servicebus/namespaces": "Service Bus",
};

function prettifyType(resourceType: string): string {
  const tail = resourceType.split("/").pop() || resourceType;
  return tail
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function serviceFor(resourceType: string): string {
  const key = (resourceType || "").toLowerCase();
  return SERVICE_NAMES[key] || prettifyType(resourceType);
}

function regionFor(code: string | undefined): string {
  if (!code) return "Global";
  return REGION_DISPLAY[code.toLowerCase().replace(/\s+/g, "")] || code;
}

function normalizeState(value: any): AvailabilityState {
  const s = String(value || "").toLowerCase();
  if (s === "available") return "Available";
  if (s === "unavailable") return "Unavailable";
  if (s === "degraded") return "Degraded";
  return "Unknown";
}

/**
 * Parse the owning resource id, name and type out of an availabilityStatus id:
 *   /subscriptions/.../providers/Microsoft.ResourceHealth/availabilityStatuses/current
 *   ^ resourceId ^                ^ strip this suffix ^
 */
function parseResource(id: string): { resourceId: string; name: string; resourceType: string } {
  const cut = id.split("/providers/Microsoft.ResourceHealth/")[0] || id;
  const segs = cut.split("/").filter(Boolean);
  const name = segs[segs.length - 1] || cut;
  // resourceType = provider namespace + the type segments between it and the name pairs.
  const provIdx = segs.findIndex((s, i) => i > 0 && segs[i - 1] === "providers");
  let resourceType = "";
  if (provIdx >= 0) {
    const ns = segs[provIdx];
    const typeParts: string[] = [];
    for (let i = provIdx + 1; i < segs.length; i += 2) typeParts.push(segs[i]);
    resourceType = `${ns}/${typeParts.join("/")}`;
  }
  return { resourceId: cut, name, resourceType };
}

let cachedCredential: DefaultAzureCredential | null = null;
function getCredential(): DefaultAzureCredential {
  if (!cachedCredential) cachedCredential = new DefaultAzureCredential();
  return cachedCredential;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch one availabilityStatuses page, retrying transient failures.
 *
 * Right after Microsoft.ResourceHealth is registered on a subscription the data
 * plane is eventually-consistent and intermittently answers HTTP 409 AuthError
 * ("Make sure the resource provider has been registered"), and it can throttle
 * with 429/503. Those are transient, so we retry them with linear backoff rather
 * than surfacing a flaky failure to the demo.
 */
async function fetchPageWithRetry(
  url: string,
  token: string,
  config: AppConfig,
  maxAttempts = 5
): Promise<any> {
  let last = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetchWithTimeout(
      url,
      { method: "GET", headers: { Authorization: `Bearer ${token}` } },
      config.fetchTimeoutMs
    );
    if (res.ok) return res.json();
    const body = await res.text();
    last = `HTTP ${res.status}: ${body.slice(0, 200)}`;
    const transient = res.status === 409 || res.status === 429 || res.status === 503;
    if (transient && attempt < maxAttempts) {
      await delay(700 * attempt);
      continue;
    }
    throw new Error(`Resource Health ${last}`);
  }
  throw new Error(`Resource Health unavailable after ${maxAttempts} attempts: ${last}`);
}

const EMPTY_SUMMARY: ResourceHealthSummary = {
  total: 0,
  available: 0,
  degraded: 0,
  unavailable: 0,
  unknown: 0,
};

export async function getResourceHealth(
  config: AppConfig
): Promise<ResourceHealthResult> {
  const source = "resourceHealth" as const;

  if (config.subscriptionIds.length === 0) {
    return {
      source,
      ok: true,
      message:
        "Skipped: no SUBSCRIPTION_IDS configured (Resource Health is subscription-scoped and optional).",
      resources: [],
      summary: { ...EMPTY_SUMMARY },
      byService: [],
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
      message: `No Azure credential for Resource Health: ${err?.message || String(err)}`,
      resources: [],
      summary: { ...EMPTY_SUMMARY },
      byService: [],
    };
  }

  try {
    const rows: any[] = [];
    for (const sub of config.subscriptionIds) {
      let url:
        | string
        | undefined = `${config.armBaseUrl}/subscriptions/${sub}/providers/Microsoft.ResourceHealth/availabilityStatuses?api-version=${config.resourceHealthApiVersion}&$top=200`;
      let guard = 0;
      while (url && guard++ < 50) {
        const page = await fetchPageWithRetry(url, token, config);
        if (Array.isArray(page?.value)) rows.push(...page.value);
        url = page?.nextLink;
      }
    }

    const resources = mapResources(rows);
    return {
      source,
      ok: true,
      resources,
      summary: summarize(resources),
      byService: rollupByService(resources),
    };
  } catch (err: any) {
    return {
      source,
      ok: false,
      message: `Resource Health request failed: ${err?.message || String(err)}`,
      resources: [],
      summary: { ...EMPTY_SUMMARY },
      byService: [],
    };
  }
}

export function mapResources(rows: any[]): ResourceAvailability[] {
  return rows.map((r) => {
    const { resourceId, name, resourceType } = parseResource(String(r?.id || ""));
    const p = r?.properties || {};
    return {
      resourceId,
      name,
      resourceType,
      service: serviceFor(resourceType),
      region: regionFor(r?.location || p.location),
      state: normalizeState(p.availabilityState),
      summary: stripHtml(p.summary) || undefined,
      occurredTime: p.occurredTime || undefined,
    };
  });
}

export function summarize(resources: ResourceAvailability[]): ResourceHealthSummary {
  const s: ResourceHealthSummary = { ...EMPTY_SUMMARY };
  for (const r of resources) {
    s.total++;
    if (r.state === "Available") s.available++;
    else if (r.state === "Degraded") s.degraded++;
    else if (r.state === "Unavailable") s.unavailable++;
    else s.unknown++;
  }
  return s;
}

export function rollupByService(resources: ResourceAvailability[]): ServiceRollup[] {
  const map = new Map<string, ServiceRollup>();
  for (const r of resources) {
    const row = map.get(r.service) || {
      service: r.service,
      total: 0,
      available: 0,
      unknown: 0,
      issues: 0,
    };
    row.total++;
    if (r.state === "Available") row.available++;
    else if (r.state === "Unknown") row.unknown++;
    else row.issues++;
    map.set(r.service, row);
  }
  return [...map.values()].sort(
    (a, b) =>
      b.issues - a.issues ||
      b.total - a.total ||
      a.service.localeCompare(b.service)
  );
}
