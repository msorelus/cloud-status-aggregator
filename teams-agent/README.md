# Cloud Status Aggregator Teams Agent

## Purpose

This isolated subproject hosts a Microsoft 365 Agents SDK custom-engine bot for the Cloud Status Aggregator POC. It answers Teams messages by calling the existing MCP Streamable HTTP server at `MCP_URL` and cites Microsoft tracking IDs from tool output.

## Local Run

```bash
cd teams-agent
npm install
npm run build
npm start
```

Environment variables:

- `MCP_URL` defaults to `http://localhost:8080/mcp`.
- `PORT` defaults to `3978`.
- `clientId`, `tenantId`, and `clientSecret` are read by `@microsoft/agents-hosting` for Azure Bot channel authentication.

## Provisioned resources (replace placeholders)

Use values from your Microsoft Entra tenant and Azure Bot resource:

| Resource | Value |
|---|---|
| Microsoft Entra ID app (client) ID — **BOT_ID** | `<your-bot-app-id>` |
| Tenant ID | `<your-tenant-id>` |
| Azure Bot | `<your-bot-name>` (resource group `<your-resource-group>`, SKU F0, SingleTenant) |
| Teams channel | Enabled |
| Messaging endpoint | `https://<your-tunnel-host>.devtunnels.ms/api/messages` |
| Persistent devtunnel | `csa-azstatus` → host `<your-tunnel-host>.devtunnels.ms` |
| Client secret | Stored in `teams-agent/.env` (git-ignored — **never commit**) |
| Teams app package | `appPackage/cloud-status-agent.zip` (build after resolving placeholders) |

After you set `.env` and build the app-package zip, verify that the bot authenticates,
the tunnel forwards to `/api/messages` (a `401` to an unsigned POST confirms auth is
active and reachable), and answers are grounded against the live MCP server.

## Teams sideload (your one remaining step)

1. Run `./start-poc.sh` from the repo root (starts the live API+MCP, the bot with
   `.env`, hosts the persistent tunnel, and the keepalive).
2. In Microsoft Teams: **Apps → Manage your apps → Upload an app → Upload a custom app**,
   then choose `teams-agent/appPackage/cloud-status-agent.zip`.
   *(Requires custom-app upload to be enabled by your Teams admin.)*
3. Open the agent and ask: "Any of our regions degraded right now?"

If the persistent tunnel URL ever changes, update the Azure Bot endpoint
(`az bot update -g <your-resource-group> -n <your-bot-name> --endpoint https://<your-tunnel-host>.devtunnels.ms/api/messages`)
and rebuild the zip:

```bash
cd teams-agent/appPackage
BOT_ID=<your-bot-app-id> TUNNEL_HOST=<your-tunnel-host>.devtunnels.ms node -e '
const fs=require("fs");const m=JSON.parse(fs.readFileSync("manifest.json","utf8")
 .replace(/\$\{\{BOT_ID\}\}/g,process.env.BOT_ID).replace(/\$\{\{TUNNEL_HOST\}\}/g,process.env.TUNNEL_HOST));
delete m.webApplicationInfo;fs.mkdirSync("build",{recursive:true});
fs.writeFileSync("build/manifest.json",JSON.stringify(m,null,2));'
cp color.png outline.png build/ && (cd build && zip -j -q ../cloud-status-agent.zip manifest.json color.png outline.png)
```

## Devtunnel Caveat

The devtunnel relay can drop after idle periods. Keep the `start-poc.sh` keepalive loop running; it pings `/api/messages` about every 30 seconds to avoid Teams “failed to send” reconnect failures.

## Next Steps

- For offline rehearsals, run the root server in mock mode (`MOCK=1 ./start-poc.sh`).
- Live is the default: `./start-poc.sh` runs the API against Azure (set
  `SUBSCRIPTION_IDS` first so the tenant fork includes Service Health).
