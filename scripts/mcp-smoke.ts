/**
 * MCP smoke client (throwaway verification).
 *
 * Connects to a RUNNING aggregator's `/mcp` endpoint with the official SDK
 * client over Streamable HTTP, completes the `initialize` handshake, lists the
 * tools, and calls all four — printing the live results. Proves a real remote
 * MCP client can reach the server exactly as the Teams agent will.
 *
 * The four tools are incident-first: they report what Microsoft has published,
 * and an empty result is reported as "nothing published" — never as "verified
 * healthy". This script asserts that honesty note is present when a result set
 * comes back empty.
 *
 * Usage (start the server first, e.g. `MOCK=true node dist/server.js`):
 *   MCP_URL=http://localhost:8080/mcp \
 *     TS_NODE_TRANSPILE_ONLY=1 npx ts-node scripts/mcp-smoke.ts
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.env.MCP_URL || "http://localhost:8080/mcp";

const EXPECTED_TOOLS = [
  "get_active_incidents",
  "get_regional_health",
  "get_planned_maintenance",
  "lookup_service_region",
];

/** Parse the JSON text content of a tools/call result. */
function parseToolJson(result: any): any {
  const text = result?.content?.find((c: any) => c.type === "text")?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * An empty result must carry the honesty note. Absence of an incident is
 * "nothing published", not a health measurement.
 */
function assertHonesty(label: string, count: number, payload: any) {
  if (count > 0) return;
  const note = String(payload?.note ?? "");
  if (!/not a positive health measurement/i.test(note)) {
    throw new Error(
      `${label} returned an empty result without the honesty note (got: ${
        note || "<none>"
      })`
    );
  }
  console.log(`      honesty note present on empty result -> OK`);
}

function line(issue: any): string {
  const where = [issue.services?.join(", "), issue.regions?.join(", ")]
    .filter(Boolean)
    .join(" @ ");
  return `${issue.title}${where ? `  [${where}]` : ""}  (trackingId: ${
    issue.trackingId ?? "n/a"
  })`;
}

async function main() {
  console.log(`\n[mcp-smoke] connecting to ${MCP_URL}\n`);

  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  const client = new Client(
    { name: "csa-mcp-smoke", version: "0.1.0" },
    { capabilities: {} }
  );

  // initialize handshake happens inside connect().
  await client.connect(transport);
  const sessionId = (transport as any).sessionId;
  console.log(`[1] initialize -> OK  (mcp-session-id: ${sessionId})\n`);

  // tools/list
  const { tools } = await client.listTools();
  console.log(`[2] tools/list -> ${tools.length} tools`);
  for (const t of tools) {
    const props = Object.keys(t.inputSchema?.properties ?? {});
    console.log(
      `      - ${t.name}(${props.join(", ")})  ::  ${(t.title || "").trim()}`
    );
  }
  const names = tools.map((t) => t.name).sort();
  const expected = [...EXPECTED_TOOLS].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(
      `Tool surface mismatch.\n  expected: ${expected.join(", ")}\n  got:      ${names.join(", ")}`
    );
  }
  console.log("");

  // tools/call #1: get_active_incidents
  const incRes = await client.callTool({
    name: "get_active_incidents",
    arguments: {},
  });
  const inc = parseToolJson(incRes);
  const total =
    (inc.global?.length ?? 0) +
    (inc.regional?.length ?? 0) +
    (inc.maintenance?.length ?? 0);
  if (!inc.counts || typeof inc.overall !== "string") {
    throw new Error("get_active_incidents did not return the expected shape");
  }
  console.log(`[3] tools/call get_active_incidents -> overall: ${inc.overall}`);
  console.log(
    `      counts: ${JSON.stringify(inc.counts)}  activeSources: ${JSON.stringify(
      inc.activeSources
    )}`
  );
  console.log(
    `      regionsAffected: ${JSON.stringify(
      inc.regionsAffected
    )}  activeTrackingIds: ${JSON.stringify(inc.activeTrackingIds)}`
  );
  for (const i of [...(inc.global ?? []), ...(inc.regional ?? [])]) {
    console.log(`      - ${line(i)}`);
  }
  assertHonesty("get_active_incidents", total, inc);
  console.log("");

  // Pick a real (service, region) pair off the live data when one exists, so
  // the lookup below exercises the matching path rather than the empty path.
  const sample = [...(inc.global ?? []), ...(inc.regional ?? [])][0];
  const sampleService = sample?.services?.[0] || "Azure Front Door";
  const sampleRegion = sample?.regions?.[0] || "Global";

  // tools/call #2: get_regional_health
  const probeRegion = inc.regionsAffected?.[0] || "Global";
  const regRes = await client.callTool({
    name: "get_regional_health",
    arguments: { region: probeRegion },
  });
  const reg = parseToolJson(regRes);
  console.log(
    `[4] tools/call get_regional_health { region: ${JSON.stringify(probeRegion)} }`
  );
  console.log(
    `      incidentCount: ${reg.incidentCount}  servicesAffected: ${JSON.stringify(
      reg.servicesAffected
    )}  activeTrackingIds: ${JSON.stringify(reg.activeTrackingIds)}`
  );
  for (const i of reg.incidents ?? []) console.log(`      - ${line(i)}`);
  assertHonesty("get_regional_health", reg.incidentCount ?? 0, reg);
  console.log("");

  // tools/call #3: get_planned_maintenance
  const pmRes = await client.callTool({
    name: "get_planned_maintenance",
    arguments: {},
  });
  const pm = parseToolJson(pmRes);
  console.log(`[5] tools/call get_planned_maintenance -> ${pm.count} event(s)`);
  for (const e of pm.events ?? []) console.log(`      - ${line(e)}`);
  console.log("");

  // tools/call #4: lookup_service_region
  const lookupArgs = { service: sampleService, region: sampleRegion };
  const lkRes = await client.callTool({
    name: "lookup_service_region",
    arguments: lookupArgs,
  });
  const lk = parseToolJson(lkRes);
  console.log(
    `[6] tools/call lookup_service_region ${JSON.stringify(lookupArgs)}`
  );
  console.log(
    `      impacted: ${lk.impacted}  incidentCount: ${
      lk.incidentCount
    }  activeTrackingIds: ${JSON.stringify(lk.activeTrackingIds)}`
  );
  for (const i of lk.incidents ?? []) console.log(`      - ${line(i)}`);
  assertHonesty("lookup_service_region", lk.incidentCount ?? 0, lk);
  console.log("");

  // The negative case must always be honest, regardless of live data.
  const missRes = await client.callTool({
    name: "lookup_service_region",
    arguments: { service: "Nonexistent Service", region: "Nowhere" },
  });
  const miss = parseToolJson(missRes);
  console.log(`[7] tools/call lookup_service_region (deliberate miss)`);
  console.log(`      impacted: ${miss.impacted}  note: ${miss.note}`);
  if (miss.impacted !== false) {
    throw new Error("A nonexistent service/region pair reported as impacted");
  }
  assertHonesty("lookup_service_region (miss)", 0, miss);
  console.log("");

  await client.close();
  console.log(
    "[mcp-smoke] PASS — initialize -> tools/list(4) -> tools/call x5 (honesty contract held)\n"
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("\n[mcp-smoke] FAIL:", err?.message || err);
  process.exit(1);
});
