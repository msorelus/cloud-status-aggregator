export interface AppConfig {
  port: number;
  /** When true, serve bundled sample data instead of calling Azure. Great for offline demos. */
  mock: boolean;
  /** ARM cloud base, override for sovereign clouds (e.g. Azure US Gov). */
  armBaseUrl: string;
  /** Scope used to request the ARM access token. */
  armScope: string;
  /** API version for Microsoft.ResourceHealth/emergingIssues. */
  emergingIssuesApiVersion: string;
  /** API version for Microsoft.ResourceHealth/availabilityStatuses (Layer 3). */
  resourceHealthApiVersion: string;
  /** Public Azure Status RSS feed (no auth). */
  statusFeedUrl: string;
  /**
   * Optional: subscription ids to enrich with subscription-scoped Service Health
   * events via Azure Resource Graph. Empty = skip that source entirely.
   */
  subscriptionIds: string[];
  /** Per-source network timeout (ms). */
  fetchTimeoutMs: number;
  /**
   * Change watcher. Microsoft publishes no push mechanism for the public status
   * feed, so the aggregator polls and republishes the deltas itself.
   */
  watchEnabled: boolean;
  watchIntervalMs: number;
  /** Subscriber endpoint that receives the change payload. Empty = record only. */
  webhookUrl: string;
  /** Shared secret for the HMAC-SHA256 request signature. Empty = unsigned. */
  webhookSecret: string;
  /** Entra ID protection for the MCP endpoint. Disabled unless explicitly configured. */
  mcpAuth: McpAuthConfig;
}

/**
 * Entra ID resource-server settings for `/mcp`.
 *
 * Auth is opt-in. An unconfigured deployment keeps the endpoint open, which is
 * what makes the offline demo and the test suite work without a tenant — but it
 * is not a safe default to ship to real users, so `enabled` is surfaced on
 * `/healthz` and in the startup log rather than left silent.
 */
export interface McpAuthConfig {
  enabled: boolean;
  /** Directory (tenant) GUID expected in `iss`. */
  tenantId: string;
  /** API app registration client ID; becomes the accepted `aud`. */
  audience: string;
  /** Unqualified scope names, e.g. ["status.read"]. Qualified at advertise time. */
  scopes: string[];
  /**
   * Externally reachable https origin. Becomes the RFC 8707 `resource`
   * identifier, so it must match what clients actually dial — not the container's
   * internal address.
   */
  publicBaseUrl: string;
  /** Login authority host. Override for sovereign clouds. */
  authorityHost: string;
  /** Human-readable name shown in client consent and account UI. */
  resourceName: string;
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(): AppConfig {
  const armBaseUrl = process.env.ARM_BASE_URL || "https://management.azure.com";
  return {
    port: parseInt(process.env.PORT || "8080", 10),
    mock: /^(1|true|yes)$/i.test(process.env.MOCK || ""),
    armBaseUrl,
    armScope: process.env.ARM_SCOPE || `${armBaseUrl}/.default`,
    emergingIssuesApiVersion:
      process.env.EMERGING_ISSUES_API_VERSION || "2022-10-01",
    resourceHealthApiVersion:
      process.env.RESOURCE_HEALTH_API_VERSION || "2022-10-01",
    statusFeedUrl:
      process.env.STATUS_FEED_URL ||
      "https://azure.status.microsoft/en-us/status/feed/",
    subscriptionIds: parseList(process.env.SUBSCRIPTION_IDS),
    fetchTimeoutMs: parseInt(process.env.FETCH_TIMEOUT_MS || "15000", 10),
    watchEnabled: /^(1|true|yes)$/i.test(process.env.WATCH_ENABLED || ""),
    watchIntervalMs: Math.max(
      15000,
      parseInt(process.env.WATCH_INTERVAL_MS || "60000", 10)
    ),
    webhookUrl: process.env.WEBHOOK_URL || "",
    webhookSecret: process.env.WEBHOOK_SECRET || "",
    mcpAuth: {
      enabled: /^(1|true|yes)$/i.test(process.env.MCP_AUTH_ENABLED || ""),
      tenantId: process.env.MCP_AUTH_TENANT_ID || "",
      audience: process.env.MCP_AUTH_AUDIENCE || "",
      scopes: parseList(process.env.MCP_AUTH_SCOPES).length
        ? parseList(process.env.MCP_AUTH_SCOPES)
        : ["status.read"],
      publicBaseUrl: (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, ""),
      authorityHost:
        process.env.MCP_AUTH_AUTHORITY_HOST || "https://login.microsoftonline.com",
      resourceName: process.env.MCP_AUTH_RESOURCE_NAME || "Cloud Status Aggregator",
    },
  };
}
