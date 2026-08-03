# Cloud Status Aggregator — Subscription-Independent Azure Status API (Proof of Concept)

A self-hosted REST API that reproduces the **Azure Status** page experience —
**global outages, regional outages, and planned maintenance** — in a single,
**subscription-independent** JSON contract that your organization owns and operates
inside its own Azure tenant.

## Executive Summary

The operator needs a programmatic equivalent of the public
[Azure Status](https://azure.status.microsoft/status) page: a feed of global and
regional outages and planned maintenance that is **not tied to a specific Azure
subscription**. The subscription-scoped surfaces shared earlier — Azure Service
Health, Azure Resource Health, and the `ServiceHealthResources` Azure Resource
Graph table — only report issues affecting *your* resources, so none of them
satisfies the requirement on their own.

There is **no single, off-the-shelf Microsoft REST API** that returns the exact
Azure Status page payload. However, two **subscription-independent** Microsoft
sources can be combined to deliver it, plus an optional third for tenant-specific
enrichment. This proof of concept (POC) is a lightweight aggregator that merges
those sources into one normalized API. It is designed to run in your tenant
and to be **owned and maintained by your organization** — a small, dependency-light service
with no Microsoft-side custom work required.

This document explains the approach, the data sources, how to run and deploy it,
and the known limitations to validate during the POC.

## The Requirement vs. Available Microsoft Surfaces

| What the operator needs | Microsoft surface | Subscription-independent? | Notes |
|---|---|---|---|
| Azure Status page content (global / regional banner) | `Microsoft.ResourceHealth/emergingIssues` REST API | **Yes** — provider-level, tenant-wide | Returns the same active-event banner shown on the status page. Requires an Azure Resource Manager token (Reader is enough). |
| Status incidents + planned maintenance | Public **Azure Status RSS feed** (`/status/feed/`) | **Yes** — fully public, no auth | Carries published incidents and maintenance notices. |
| Issues impacting *your organization's* resources | `ServiceHealthResources` (Azure Resource Graph) | No — subscription-scoped | Optional enrichment for "what is hitting my subscriptions". |

**Key insight:** The `emergingIssues` API is exposed at the resource-provider
level (`/providers/Microsoft.ResourceHealth/emergingIssues`) — there is **no
subscription in the path** — so its content is the same global/regional view
everyone sees on the Azure Status page. Combined with the public RSS feed, it
covers the global, regional, and planned-maintenance categories requested for this scenario.

## Solution Architecture

```
                  Your Azure tenant  (your organization owns + maintains)
   +-------------------------------------------------------------------+
   |  Azure Container Apps  (User-assigned Managed Identity = Reader)   |
   |                                                                   |
   |   GET /api/status             +-----------------------------+     |
   |   GET /api/status/global  --> |  Aggregator + Normalizer     |     |
   |   GET /api/status/regional    |  (dedupe, classify, rollup)  |     |
   |   GET /api/status/maintenance +--------------+--------------+      |
   +----------------------------------------------|--------------------+
                                                  |
              +-----------------------------------+-----------------------------+
              v                                   v                             v
   emergingIssues REST API            Azure Status RSS feed         (optional) Resource Graph
   (global/regional, ARM auth)        (public, no auth)             ServiceHealthResources
```

The service calls all configured sources in parallel, normalizes each into a
common schema, de-duplicates overlapping incidents (by Microsoft tracking ID or
title), classifies them into **global / regional / maintenance**, and returns a
single payload with an overall health rollup.

## API Contract

| Method & Path | Description |
|---|---|
| `GET /api/status` | Full payload: all categories, counts, per-source status, overall rollup. |
| `GET /api/status/changes` | **Change watcher state + the most recent delta set** (`new` / `updated` / `resolved`). `503` when `WATCH_ENABLED` is off. |
| `GET /api/status/view` | Self-contained, auto-refreshing HTML status view (see below). |
| `GET /api/status/resources` | **Layer 3 — live per-resource availability (Azure Resource Health).** Tenant-only (`?fork=tenant`); the public fork returns an explanatory empty result. |
| `GET /api/status/global` | Global outages only. |
| `GET /api/status/regional` | Regional outages only. |
| `GET /api/status/maintenance` | Planned maintenance only. |
| `GET /healthz` | Liveness probe. |
| `GET /` | Service metadata and endpoint list. |

> `GET /api/status/grid/view` now returns a **301 redirect** to
> `/api/status/view`. The illustrative Products × Regions grid was removed at
> the operator's request — see [Why the grid was removed](#why-the-grid-was-removed).

**Early-warning delta:** `GET /api/status` and the category routes accept an
optional `?since=<ISO-8601>` query (e.g. `?since=2026-06-02T00:00:00Z`). It
returns only incidents created or updated at/after that timestamp and recomputes
`counts`/`overall` over the filtered set — so a poller (or a scheduled job across
your environment) can ask "what's new since my last check?" without
diffing the full payload. Issues without a timestamp are retained (fail-safe), and
an unparseable value returns `400`.

Example `GET /api/status` response (abridged):

```json
{
  "generatedAt": "2026-06-02T13:05:36.254Z",
  "overall": "degraded",
  "counts": { "global": 2, "regional": 2, "maintenance": 2 },
  "sources": [
    { "source": "emergingIssues", "ok": true, "count": 2 },
    { "source": "statusFeed", "ok": true, "count": 3 },
    { "source": "serviceHealth", "ok": true, "count": 1 }
  ],
  "global": [
    {
      "id": "ei-global-cc39074a2fbb",
      "category": "global",
      "status": "active",
      "title": "Azure Front Door - Intermittent connectivity errors",
      "summary": "Customers may experience intermittent connectivity failures...",
      "trackingId": "VL12-3B8",
      "source": "emergingIssues"
    }
  ],
  "regional": [ /* ... */ ],
  "maintenance": [ /* ... */ ]
}
```

Each source reports its own `ok` flag and a `message`, so a partial outage in one
upstream source never takes the whole API down — consumers always see which data
is fresh.

## Why the grid was removed

Earlier revisions of this POC rendered a **Products × Regions grid** imitating the
matrix of green check-marks on the public Azure Status page. It was always
labelled *illustrative*, because no Microsoft API returns that grid — it is
server-rendered HTML on `azure.status.microsoft`, and the only
subscription-independent live signal behind it is `emergingIssues` (the same
source this POC already aggregates). The `availabilityStatuses` API exists but is
**resource/subscription-scoped**: it reports the health of *your* resources, not a
global product-by-region matrix.

That meant the grid was mostly a configured catalog with a few live cells overlaid
on top. The operator reviewed it and asked for it to go — the live incident feed is the
product, and a wall of green check-marks that were never actually probed is a
liability in a customer-facing tool. **The grid has been removed from the API, the
MCP tools and the UI.**

What was kept is the genuinely useful part: the service and region matching logic
now lives in `src/match.ts` and powers the incident-first MCP tools.

> **The rule this enforces:** absence of a published incident is reported as
> *"nothing published"* — never as *"verified healthy."* Nothing in this service
> synthesizes a health state it did not observe.

## Change detection and webhooks (`GET /api/status/changes`)

Microsoft publishes **no push mechanism for the public Azure Status feed**. The
documented way to subscribe is the [RSS
feed](https://learn.microsoft.com/azure/service-health/azure-status-overview#rss-feed),
which is poll-only. Service Health alerts *do* fan out to Action Groups and
webhooks, but they fire from Activity Log events and therefore need a subscription
scope (tenant-wide Service Health alerts at Directory scope are still preview).
Neither gives a distributor a push signal off the public feed.

So the POC builds it. `src/watch.ts` polls the aggregator on an interval, diffs
each incident against the last-seen snapshot, and POSTs **only the deltas** to a
subscriber:

| Change kind | Fires when |
|---|---|
| `new` | A tracking ID the watcher has never seen appears in the feed. |
| `updated` | A known ID's status, `lastUpdateTime`, title or summary changed. |
| `resolved` | A known ID flipped to resolved, **or dropped out of the feed** — Microsoft removes closed incidents, so disappearance is the resolution signal. |

Enable it with:

```bash
WATCH_ENABLED=true
WATCH_INTERVAL_MS=60000                                # floor of 15000
WEBHOOK_URL=https://tickets.example.com/hooks/status  # optional
WEBHOOK_SECRET=$(openssl rand -hex 32)                 # optional but recommended
```

The POST body wraps the change set with a `vendor` discriminator, so a second
provider (GCP, AWS) rides the same publisher and subscribers can fan out per
vendor from day one:

```json
{
  "specVersion": "1.0",
  "vendor": "microsoft-azure",
  "source": "cloud-status-aggregator",
  "generatedAt": "2026-08-03T17:26:12.384Z",
  "previousPollAt": "2026-08-03T17:25:57.383Z",
  "overall": "degraded",
  "counts": { "new": 0, "updated": 1, "resolved": 1 },
  "changes": [
    {
      "kind": "updated",
      "issue": {
        "id": "ei-active-cc39074a2fbb",
        "category": "global",
        "status": "active",
        "title": "Azure Front Door - Intermittent connectivity errors",
        "summary": "Mitigation applied.",
        "impactedServices": ["Azure Front Door"],
        "impactedRegions": ["Global"],
        "trackingId": "VL12-3B8",
        "startTime": "2026-06-02T11:20:00Z",
        "lastUpdateTime": "2026-08-03T19:30:00Z",
        "link": "https://azure.status.microsoft/status",
        "source": "emergingIssues"
      },
      "previousUpdateTime": "2026-08-03T18:00:00Z"
    }
  ]
}
```

Each entry in `changes` is `{ kind, issue, previousUpdateTime? }` — the full
normalized `StatusIssue` is nested under **`issue`**, not flattened. Correlate on
`issue.trackingId` (the Microsoft ID your existing tooling understands) or on
`issue.id` (stable across polls, and present even when Microsoft publishes no
tracking ID). On a `resolved` change, `issue.status` is `"resolved"`.

When `WEBHOOK_SECRET` is set, the request carries
`x-aggregator-signature: sha256=<hex>` — an HMAC-SHA256 over the **exact raw
body**. Verify it with a constant-time compare against the raw bytes, not a
re-serialized object. Worked examples in Node, C# and Python are in
[`handoff/index.html`](handoff/index.html).

Two behaviours worth knowing:

- **The first poll after start-up publishes nothing.** It primes the baseline, so
  a restart or redeploy never replays incidents subscribers already processed.
- **The baseline is in memory**, so each replica diffs independently. Keep
  `minReplicas: 1` unless you move the baseline to shared state or make the
  subscriber idempotent on `issue.id` + `kind`.

Subscribers that cannot accept an inbound POST can poll `GET /api/status/changes`
instead. That endpoint returns `{ watcher, latest }` — `latest` is the same
`ChangeSet` the webhook carries (minus the `specVersion` / `vendor` / `source`
envelope), and `watcher` reports poll count, last poll time, last change time,
last delivery result, and last error.

### Public vs. tenant fork (`?fork=`)

`GET /api/status` and `GET /api/status/resources` accept a `fork` query parameter
that selects how much signal to include:

| `?fork=` | Sources (`activeSources`) | Use |
|---|---|---|
| `public` | `emergingIssues`, `statusFeed` | The free, subscription-independent baseline — broad "is Azure having a widespread issue?" with no subscription wiring. |
| `tenant` *(default)* | `emergingIssues`, `statusFeed`, `serviceHealth` (+ Resource Health on `/api/status/resources`) | The rich route — adds subscription-scoped Service Health (per-region issues, upcoming planned maintenance, Microsoft tracking IDs) and live per-resource availability. |

`tenant` is the default, so existing callers and the MCP tools are unaffected. The
public fork never reads `ServiceHealthResources` or Resource Health, so it works with
no subscription configured at all.

### Rendered status view (`GET /api/status/view`)

For demos and at-a-glance use, `GET /api/status/view` serves a self-contained HTML
page built entirely around the live signals: the normalized incident feed (active
global / regional / maintenance items, or a "No widespread Azure issues reported"
banner when clear), a tenant-only **Service Health events** panel, and a
tenant-only **Resource Health** panel (live per-resource `Available` / `Degraded` /
`Unavailable`). A **Public ⟷ Tenant** toggle (no reload) and a "View JSON" drawer
over the live `/api/status` payload are always available, plus a **Sample data /
MOCK mode** badge when running offline.

**The view auto-refreshes.** It polls on the same cadence as the watcher
(`WATCH_INTERVAL_MS`, floor 15 s), pauses while the browser tab is hidden,
highlights rows that arrived since the last render and raises a toast when a new
incident appears. **Pause** and **Refresh now** controls are provided for demos
where the screen needs to hold still.

## MCP Server (`/mcp`)

The same Express app also exposes a **Model Context Protocol (MCP)** server at
`POST/GET/DELETE /mcp` using the official
[`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)
over the **Streamable HTTP** transport. This lets remote, heterogeneous MCP
clients — a Microsoft Teams custom-engine agent now, GCP-hosted agents later —
ground answers in the same live data the REST API serves. All tools read through
`src/collect.ts`, the identical code path behind `GET /api/status*` (no logic
duplication, no HTTP self-calls). It works in both live and `MOCK=true` modes.

### Tools (4)

| Tool | Input schema | Returns |
|---|---|---|
| `get_active_incidents` | _(none)_ | Everything currently published, grouped `global` / `regional`, with counts, tracking IDs and per-source health. |
| `get_regional_health` | `{ region: string }` | Incidents affecting that region, plus `activeTrackingIds`. An empty list carries an explicit `note` that it is **not a positive health measurement**. |
| `get_planned_maintenance` | `{ region?: string, service?: string }` | Maintenance windows, optionally scoped. Both inputs optional — omit for everything. |
| `lookup_service_region` | `{ service: string, region?: string }` | `{ impacted, incidentCount, incidents[], regionsAffected }` for that service, narrowed to a region only if you pass one. |

`region` is matched case-insensitively against the vocabulary in `src/match.ts`
(`Global` = Non-Regional); `service` accepts a case-insensitive exact or partial
name. All tools are read-only and return pretty-printed JSON text content.

**Region matching reads the incident text, not just the structured field.** Real
Service Health rows routinely arrive with an **empty** `impactedRegions` and name
the region only in the title — "End of Unplanned Maintenance for App Service in
East US 2" is a live example. Every region filter therefore matches against the
title and summary as well. Any client that re-implements filtering on
`impactedRegions` alone **will silently miss real events**; scope server-side by
passing `region` to the tool instead.

**`region` is optional on purpose.** "Is Front Door having problems?" is one of
the most common questions an agent gets, and it names no region. When `region`
was mandatory, agents could not express that query and fell back to returning
every unrelated incident — which reads to a user as a hallucination. Omitting
`region` asks "anywhere," and the response echoes `scope: "service-anywhere"`.

**The honesty contract holds at the tool boundary.** When nothing is published,
the response says so explicitly rather than returning a green status — so agents
built on these tools inherit the right wording instead of telling a user a service
is fine when it was never measured.

### Run + connect

```bash
npm run build
MOCK=true node dist/server.js          # server with /mcp on :8080

# Throwaway SDK client proof (initialize -> tools/list -> tools/call x4):
MCP_URL=http://localhost:8080/mcp \
  TS_NODE_TRANSPILE_ONLY=1 npx ts-node scripts/mcp-smoke.ts
```

A remote client connects to `http://<host>:8080/mcp`. The transport is
**stateful**: the `initialize` handshake must complete first; the server returns
a session id in the `mcp-session-id` response header, which the client then
includes on every subsequent request. Raw wire sequence:

```bash
# 1) initialize  -> 200, header: mcp-session-id: <uuid>, body: SSE result
curl -i -X POST http://localhost:8080/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}'

# 2) notifications/initialized  (reuse the session id) -> 202 Accepted
# 3) tools/list                 (reuse the session id) -> 4 tools
# 4) tools/call                 (reuse the session id) -> tool result
# 5) DELETE /mcp                (reuse the session id) -> 200 (session teardown)
```

> **Teams-bot / GCP-agent seam:** point the MCP client at the `/mcp` URL (via
> devtunnel for local Teams sideloading). Send `Accept: application/json,
> text/event-stream` and carry the `mcp-session-id` header after `initialize`.
> The SDK client (`StreamableHTTPClientTransport`) handles all of this
> automatically. Sessions are held in memory, so a multi-replica deployment
> needs sticky sessions (or switch the transport to stateless mode —
> `sessionIdGenerator: undefined` in `src/mcp/index.ts` — for stateless scale).

### Connecting an editor

Because the transport is remote Streamable HTTP, an editor needs a URL and
nothing else — no bridge process, no SDK. Copy `.vscode/mcp.json.example` to
`.vscode/mcp.json` (the latter is gitignored, since it names a tenant-specific
host) and replace the URL:

```jsonc
// .vscode/mcp.json
{
  "servers": {
    "cloud-status-aggregator": {
      "type": "http",
      "url": "https://<your-app>.azurecontainerapps.io/mcp"
    }
  }
}
```

VS Code shows a **Start** code lens above the server block; the tools then appear
in Chat → **Agent** mode → Tools. Cursor uses the same shape under `.cursor/mcp.json`
with the top-level key `mcpServers` instead of `servers`. Hosts that only launch
local stdio servers need a bridge (`npx -y mcp-remote <url>`); hosts with native
remote support should not use one.

Prompts that exercise all four tools, plus the boundary case that catches a bad
integration ("is my VM down?" must answer *nothing published*, not *healthy*), are
in [`handoff/index.html` §9](handoff/index.html).

### Authenticating the MCP endpoint

Entra ID bearer-token validation is built in and **off by default**, so mock mode
and the test suite run without a tenant. `GET /healthz` always reports which mode
is live (`"mcpAuth":"entra"` or `"mcpAuth":"none"`), so an open endpoint is never
silent. Only `/mcp` is protected — the REST API and dashboard stay open so the
demo still works.

Container Apps built-in auth is not a usable shortcut: it relies on a browser
redirect and does not serve the OAuth protected-resource metadata MCP clients
discover, so enabling it breaks the client instead of securing it. The app
therefore validates tokens itself and serves its own
`/.well-known/oauth-protected-resource`.

Turning it on needs two app registrations — one identifying the API (the token
audience), one letting the editor sign a user in. Both are required because Entra
ID does not implement OAuth Dynamic Client Registration, so the client cannot
create its own identity the way the MCP spec assumes; you supply the client ID in
the editor config instead. The full command sequence is in
[`handoff/index.html` §9](handoff/index.html). Once the app registrations exist:

```bash
# The MCP endpoint URL must be registered as an Application ID URI on the API
# app, alongside api://<api-app-id>. Clients that implement RFC 8707 Resource
# Indicators send that URL as the `resource` parameter, and Entra will not mint
# a token for a resource it does not recognise. This comes after the first
# deploy because the URL does not exist until then.
az ad app update --id "<api-app-id>" \
  --identifier-uris "api://<api-app-id>" "$(azd env get-value SERVICE_API_URI)/mcp"

azd env set MCP_AUTH_ENABLED true
azd env set MCP_AUTH_AUDIENCE "<api-app-id>"        # bare GUID, not api://<guid>
azd env set MCP_AUTH_TENANT_ID "$(az account show --query tenantId -o tsv)"
azd up
```

> **`AADSTS9010010: the resource parameter provided in the request doesn't match
> with the requested scopes`** means that registration is missing. Entra derives
> the resource from the *scope*, so `api://<guid>/status.read` cannot be paired
> with an endpoint URL as the `resource`. The server advertises scopes qualified
> with its own endpoint URL (`https://<host>/mcp/status.read`) precisely so the
> two agree. In VS Code the symptom is `Connection state: Error 401` right after
> a *successful* metadata discovery, with no sign-in window ever appearing. If
> your tenant forbids adding the identifier URI, pin the old form with
> `azd env set MCP_AUTH_SCOPES "api://<api-app-id>/status.read"` — fully
> qualified values are passed through untouched — but VS Code will not connect.

and add the client ID to the editor config:

```jsonc
"oauth": { "clientId": "<public-client-app-id>" }
```

Verify from the shell before involving an editor — it separates a server problem
from a client problem, which is most of the work in diagnosing MCP auth:

```bash
APP_URL=$(azd env get-value SERVICE_API_URI)

curl -si -X POST "$APP_URL/mcp" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -d '{}' | head -1
#   → HTTP/2 401   (with a www-authenticate header naming the metadata URL)

curl -s "$APP_URL/.well-known/oauth-protected-resource/mcp"
#   → authorization_servers + fully-qualified scopes_supported

TOKEN=$(az account get-access-token --scope "api://<api-app-id>/status.read" \
  --query accessToken -o tsv)
curl -si -X POST "$APP_URL/mcp" -H "Authorization: Bearer $TOKEN" ... | head -1
#   → HTTP/2 200
```

> **The audience is the bare application ID, not the `api://` URI.** A v2.0
> access token carries `aud` as the raw GUID even though the client requested the
> scope as `api://<guid>/status.read`; only v1.0 tokens use the URI form. Setting
> `MCP_AUTH_AUDIENCE` to the URI rejects every request with a 401 *after* a
> sign-in that looked entirely successful. For the same reason the metadata
> advertises fully qualified scopes — a client echoing back a bare `status.read`
> receives a Microsoft Graph token, which fails audience validation the same
> silent way. The verifier accepts both `aud` forms defensively.

### Copilot Studio compatibility

Compatible: the transport is streamable HTTP and the tool input schemas use only
flat `string` properties (no `oneOf`/`anyOf`), with examples in each description
(≤1024 chars). For Copilot Studio, expose the `/mcp` URL behind Entra ID auth
(add a token-validation middleware on the `/mcp` route before production).

## Running Locally

Prerequisites: Node.js 18+.

```bash
npm install
npm run build

# Offline demo with bundled sample data (no Azure auth, no network):
npm run demo
# or: MOCK=true npm start

# Live mode (uses the public RSS feed immediately; emergingIssues needs auth):
npm start
```

Then:

```bash
curl http://localhost:8080/api/status
curl http://localhost:8080/api/status/maintenance
curl http://localhost:8080/api/status/changes
curl "http://localhost:8080/api/status?since=2026-06-02T00:00:00Z"
open http://localhost:8080/api/status/view
```

In live mode without Azure credentials, the public RSS feed still works and the
`emergingIssues` source returns a clear "no credential" message rather than
failing — useful for first-run validation.

## Testing

The POC ships unit and end-to-end tests (Node's built-in `node:test` runner +
`supertest`, no heavy test framework):

```bash
npm test
```

| Layer | What it covers |
|---|---|
| Unit — parsers | `emergingIssues` (active events, banners, `impacts[]` → services/regions, empty/healthy payload), `statusFeed` (global/regional/maintenance classification, empty + single-item feeds), `serviceHealth` (Resource Graph row mapping). |
| Unit — normalize | Counts, overall rollup (`healthy`/`advisory`/`degraded`), cross-source de-duplication, active-first sorting. |
| Unit — match | Region vocabulary and normalization, global-region detection, service/region impact matching, tracking-ID extraction. |
| Unit — watch | Diff engine (`new` / `updated` / `resolved`), drop-out-means-resolved, first-poll suppression, HMAC signing. |
| Unit — filter | `?since=` parsing, filtering and rollup recomputation. |
| E2E — API | `supertest` drives `createApp()` in mock mode: `/healthz`, `/`, `/api/status`, all three category routes, `/api/status/view`, `/api/status/changes` (503 without a watcher, 200 with one), the `301` legacy grid redirect, `404` handling, single-entry de-dup, and graceful per-source degradation (never returns `500`). |
| MCP smoke | Handshake, tool listing, and all four tools via the official SDK client — including the "nothing reported" honesty contract on empty results. |

### Live validation of the ARM source

To confirm the subscription-independent `emergingIssues` call works against real
Azure (authentication + HTTP 200 + parsing):

```bash
az login
npm run live:check
```

This prints the live source status and normalized rollup. When Azure is healthy
it reports `ok: true` with `count: 0` — that is a **pass** (it proves the call
authenticated and parsed), not a failure.

### End-to-end validation against a live tenant

Three commands exercise the full stack against real Azure. Run them before any
customer demo — the automated suite runs offline against fixtures, so only these
catch tenant-shaped data problems.

```bash
export SUBSCRIPTION_IDS=<your-subscription-id>

# 1. MCP surface — handshake, tool listing, all four tools, honesty contract.
#    Requires the server running: point MCP_URL at it.
MCP_URL=http://localhost:8080/mcp npm run mcp:smoke

# 2. Webhook — terminal A: a listener that independently recomputes the HMAC
#    and returns 401 on any mismatch, exactly as a production subscriber must.
WEBHOOK_SECRET=$(openssl rand -hex 32) npm run webhook:listen

# 3. Webhook — terminal B: drive one real publish using live tenant data.
WATCH_ENABLED=true WEBHOOK_URL=http://localhost:9100 \
  WEBHOOK_SECRET=<same secret> npm run webhook:drill
```

The drill primes the baseline with a genuine first poll (which publishes nothing,
by design), then seeds an empty baseline so live incidents diff as `new` and the
real sign → POST → record-delivery path runs. Nothing is synthesized: every issue
in the payload is one Microsoft published to your tenant at that moment. A pass
prints `status: 200, ok: true` and the listener prints `SIGNATURE: VALID`.

> **Why this matters.** Live testing against a real tenant found two defects the
> offline suite could not: Service Health rows arrive with an **empty**
> `impactedRegions` (the region appears only in the title), and agents commonly
> ask about a service without naming a region. Both are now covered by
> regression tests in `test/mcp.smoke.test.ts`, but the lesson holds — run
> against a live tenant before you demo.

### Local authentication for the ARM source

`emergingIssues` and the optional Resource Graph source require an Azure Resource
Manager token. The service uses `DefaultAzureCredential`, so locally you can
simply run `az login` (Azure CLI) and re-run `npm start`. **Do not** put secrets
in code or config — see Security below.

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port. |
| `MOCK` | `false` | `true` serves bundled sample data. |
| `STATUS_FEED_URL` | Azure Status feed | Public RSS feed URL. |
| `EMERGING_ISSUES_API_VERSION` | `2022-10-01` | ARM API version. |
| `SUBSCRIPTION_IDS` | *(empty)* | Comma-separated subscription IDs to enable the optional Service Health source. Empty keeps the API fully subscription-independent. |
| `ARM_BASE_URL` / `ARM_SCOPE` | Public cloud | Override for sovereign clouds. |
| `FETCH_TIMEOUT_MS` | `15000` | Per-source network timeout. |
| `WATCH_ENABLED` | `false` | `true` starts the poll/diff change watcher. |
| `WATCH_INTERVAL_MS` | `60000` | Watcher poll cadence; clamped to a `15000` floor. |
| `WEBHOOK_URL` | *(empty)* | Subscriber endpoint for change notifications. Empty still records changes at `/api/status/changes`. |
| `WEBHOOK_SECRET` | *(empty)* | HMAC-SHA256 signing key. Injected from Key Vault by the Bicep template; empty sends unsigned payloads. |

## Deploying to Azure

Deployment is driven by **Azure Developer CLI (`azd`)**. `infra/main.bicep` is
subscription-scoped and creates its own resource group, a container registry, a
Log Analytics workspace, a **user-assigned Managed Identity** granted the
built-in **Reader** role, an Azure Container Apps environment, and — when you
supply a signing secret — a **Key Vault** holding it. Key Vault is the system of
record for that secret: read it back, rotate it and audit access there. It
reaches the container as a platform-managed Container Apps secret, and
`WEBHOOK_SECRET` is a `secretRef`, never a literal value in the container
configuration.

**A full, customer-facing install guide with copy-ready commands, webhook
signature-verification samples in three languages, a production hardening
checklist and a troubleshooting table lives at
[`handoff/index.html`](handoff/index.html).** It is self-contained — open it
offline or mail it as a single file.

### One command

```bash
azd auth login

# Optional: sign the webhook and tell the aggregator where to POST changes.
azd env set WEBHOOK_SECRET "$(openssl rand -hex 32)"
azd env set WEBHOOK_URL    "https://tickets.example.com/hooks/cloud-status"

# Optional: read subscription-scoped Service Health as well as the public feed.
azd env set SUBSCRIPTION_IDS "<sub-id-1>,<sub-id-2>"

azd up
```

`azd up` provisions the infrastructure, builds the image **inside Azure
Container Registry** (`remoteBuild: true` in `azure.yaml`, so no local Docker
daemon is needed), pushes it, rolls it into the Container App, and prints the
endpoint.

Useful follow-ups:

```bash
azd provision --preview   # what-if, changes nothing
azd deploy                # rebuild and roll out code only
azd env get-values        # the endpoint and resource names
azd monitor --logs        # stream container logs
azd down --purge          # tear the environment down, Key Vault included
```

### Tunable settings

Every knob is an `azd env set` away; `infra/main.parameters.json` maps them onto
the template.

| `azd env set` key | Default | Effect |
| --- | --- | --- |
| `SUBSCRIPTION_IDS` | *(empty)* | Comma-separated subscriptions for Service Health and Resource Health. Empty = public sources only. |
| `WEBHOOK_URL` | *(empty)* | Where change notifications are POSTed. Empty still records them at `/api/status/changes`. |
| `WEBHOOK_SECRET` | *(empty)* | HMAC-SHA256 signing key. Setting it creates the Key Vault. |
| `WATCH_ENABLED` | `true` | Turns the change watcher on or off. |
| `WATCH_INTERVAL_SECONDS` | `60` | Poll cadence, 15–3600. |
| `WORKLOAD_NAME` / `DEPLOY_TIER` / `REGION_SHORT` / `INSTANCE` | `azstatus` / `dev` / `eus2` / `001` | CAF name parts. |
| `OWNER_TAG` / `COST_CENTER` | `platform-team` / `TBD` | Governance tags. |
| `MIN_REPLICAS` / `MAX_REPLICAS` | `1` / `3` | Scale bounds. Read the warning below before raising the minimum. |
| `AZURE_RESOURCE_GROUP` | *(empty)* | Deploy into an existing group instead of `rg-<env-name>`. |

### Without azd

Some tenants cannot install `azd`. `infra/deploy.sh` drives the same templates
with plain Azure CLI, in the same two passes azd uses — provision, `az acr
build`, then roll out the real image:

```bash
export WEBHOOK_SECRET="$(openssl rand -hex 32)"
export WEBHOOK_URL="https://tickets.example.com/hooks/cloud-status"   # optional
./infra/deploy.sh csa-dev eastus2
```

Or drive ARM directly:

```bash
az deployment sub create \
  --location eastus2 \
  --template-file infra/main.bicep \
  --parameters environmentName=csa-dev location=eastus2 \
               containerImage=<acr>.azurecr.io/cloud-status-aggregator:1.0.0 \
               webhookUrl="https://tickets.example.com/hooks/cloud-status" \
               webhookSecret="$WEBHOOK_SECRET"
```

Secrets are only ever passed as `@secure()` parameters or read from the
environment, so nothing sensitive is committed or echoed in deployment output.

The Reader role lets the Managed Identity read `emergingIssues` (and, if
`SUBSCRIPTION_IDS` is set, `ServiceHealthResources`) with **no stored
credentials**.

> **Keep `minReplicas` at 1.** The watcher's last-seen baseline is in memory, so a
> second replica delivers every change twice. Scale out only after moving the
> baseline to shared state or making the subscriber idempotent on `id` + `kind`.

**Productionizing the full demo surface.** The MCP server adds no new hosting — it
rides on the same Express app behind the same Container Apps ingress (port `8080`,
path `/mcp`), so the Bicep above already covers it. The Microsoft Teams agent
(`teams-agent/`) is the one additional surface: it runs as its own small container
and needs an **Azure Bot** resource plus a **Microsoft Entra ID** app registration
(supplying its `clientId` / `tenantId` / `clientSecret`). Identity, Reader scope, and
networking follow the same pattern as the API.

## Security

- **Identity:** Service-to-service auth uses a Managed Identity; no credentials
  live in code, config, or environment variables.
- **Least privilege:** The identity is granted only the built-in **Reader** role,
  plus **Key Vault Secrets User** on the single vault holding the signing secret.
- **Secrets:** The webhook signing key lives in Key Vault (soft-delete and purge
  protection on) and reaches the container as a secret *reference* resolved at
  runtime by the managed identity. It never appears in the ARM payload or in
  deployment output.
- **Webhook integrity:** Outbound change notifications are signed with
  HMAC-SHA256 over the raw body (`x-aggregator-signature: sha256=<hex>`).
  Subscribers must verify with a constant-time compare before acting.
- **Transport:** Container Apps ingress terminates TLS and rejects insecure
  connections; all upstream calls use HTTPS.
- **Diagnostics:** Container and Key Vault audit logs flow to a Log Analytics
  workspace provisioned by the template.
- **Hardening for production:** Add VNet integration / private endpoints, a
  custom domain with a Web Application Firewall, secret rotation, and resource
  locks before any production use — see the checklist in
  [`handoff/index.html`](handoff/index.html).

## Known Limitations (to validate during the POC)

1. **`emergingIssues` is not a contractually documented "status page API."** It is
   a real, supported Azure Resource Manager operation that backs the status
   experience, but its payload shape can evolve. The parser is isolated in
   `src/sources/emergingIssues.ts` so it is easy to adjust.
2. **RSS classification uses heuristics.** Region/maintenance categorization is
   keyword-based and tunable in `src/sources/statusFeed.ts`. Validate against a
   period of real incidents and adjust the hints.
3. **History/retention.** The POC returns the *current* status snapshot and the
   most recent delta set; the watcher's baseline is in memory. If your organization needs
   historical querying, replay, or delivery retries, add persistence (a table or
   Service Bus between the watcher and the subscriber). Inside a subscription
   your organization owns, native
   [Service Health alert webhooks](https://learn.microsoft.com/azure/service-health/service-health-alert-webhook-guide)
   remain the richer, lower-latency option — the watcher fills the gap *outside*
   those boundaries, where no Microsoft push mechanism exists.
4. **Maintenance detail depth.** The richest planned-maintenance metadata (exact
   resources, windows) comes from the subscription-scoped Service Health source;
   the subscription-independent sources provide summaries.

## Project Structure

```
cloud-status-aggregator/
├── src/
│   ├── server.ts                  Express API + watcher lifecycle + graceful shutdown
│   ├── app.ts                     createApp(config, watcher?) — REST routes + MCP mount
│   ├── collect.ts                 Reusable collection + normalization (REST + MCP)
│   ├── config.ts                  Environment configuration
│   ├── types.ts                   Unified status + change model
│   ├── normalize.ts               Dedupe, classify, rollup
│   ├── match.ts                   Region vocabulary + service/region impact matching
│   ├── watch.ts                   Poll → diff → signed webhook publisher
│   ├── filter.ts                  ?since= filtering and rollup recomputation
│   ├── util.ts                    Fetch-with-timeout, helpers
│   ├── mock.ts                    Offline demo wiring
│   ├── view/statusView.ts         Self-contained auto-refreshing HTML status view
│   ├── mcp/
│   │   ├── index.ts               Streamable-HTTP mount at /mcp (sessions)
│   │   └── server.ts              McpServer + the 4 incident-first tools
│   ├── sources/
│   │   ├── emergingIssues.ts      Microsoft.ResourceHealth/emergingIssues
│   │   ├── statusFeed.ts          Public Azure Status RSS feed
│   │   ├── serviceHealth.ts       ServiceHealthResources (Layer 2, optional)
│   │   └── resourceHealth.ts      availabilityStatuses (Layer 3, tenant-only)
│   └── mock/                      Sample data for MOCK mode
├── test/
│   ├── unit.parsers.test.ts       Parser unit tests
│   ├── unit.normalize.test.ts     Dedupe / rollup unit tests
│   ├── unit.match.test.ts         Region + service matching unit tests
│   ├── unit.watch.test.ts         Diff engine + HMAC signing unit tests
│   ├── unit.filter.test.ts        ?since= filtering unit tests
│   ├── unit.resourceHealth.test.ts  Resource Health mapper unit tests
│   ├── e2e.api.test.ts            supertest end-to-end API tests
│   └── mcp.smoke.test.ts          MCP /mcp handshake + tools (SDK client)
├── scripts/live-check.ts          Live emergingIssues validation (npm run live:check)
├── scripts/mcp-smoke.ts           MCP client proof: handshake -> tools -> honesty contract
├── scripts/live-webhook-listener.js  HMAC-verifying subscriber for drills (401 on mismatch)
├── scripts/live-webhook-drill.js  Forces one real publish from live tenant data
├── azure.yaml                     Azure Developer CLI project (host: containerapp, remoteBuild)
├── infra/
│   ├── main.bicep                 Subscription-scoped entry point; creates the resource group
│   ├── resources.bicep            ACR + UAMI + Key Vault + Log Analytics + Container Apps
│   ├── main.parameters.json       azd parameter mapping (${AZURE_ENV_NAME} and friends)
│   └── deploy.sh                  Same templates via plain Azure CLI, for tenants without azd
├── docs/diagrams/                 DiagramForge sources + rendered SVGs for the handoff guide
├── handoff/index.html             Customer install & integration guide (self-contained)
├── .vscode/mcp.json.example       MCP client config template (copy to .vscode/mcp.json)
├── teams-agent/                   Microsoft Teams custom-engine agent (MCP client)
├── Dockerfile
└── .env.example
```

## Next Steps

1. **Deploy to a non-production subscription** with `azd up`, following
   [`handoff/index.html`](handoff/index.html), and validate over a window that
   includes real Azure incidents.
2. **Stand up the webhook subscriber** in your ITSM system and verify the HMAC signature
   against the raw body — sample receivers for Node, C# and Python are in the
   handoff guide. Test with a deliberately bad signature and confirm a `401`.
3. **Decide on enrichment:** set `SUBSCRIPTION_IDS` if your organization also wants
   "what's impacting my subscriptions," and decide whether change history and
   delivery retry are required for the pilot.
4. **Add the second vendor.** The normalized `StatusIssue` model, the watcher and
   the webhook contract are vendor-neutral, and the payload already carries a
   `vendor` discriminator. A GCP or AWS source implements one module in
   `src/sources/` and rides the existing pipeline.
5. **Plan productionization:** private networking, custom domain + Web
   Application Firewall, shared watcher state before scaling out, alerting on
   watcher staleness, and an ownership/runbook hand-off to the operations
   team. The full checklist is in the handoff guide.

---

> *This proof of concept represents a recommended approach based on the
> requirements discussed. Final design should be validated through this POC and
> may be adjusted based on detailed testing and operational requirements. The
> `Microsoft.ResourceHealth/emergingIssues` operation and the public Azure Status
> feed are used as documented Azure capabilities; payload shapes may change over
> time.*
