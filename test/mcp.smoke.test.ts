import { test } from "node:test";
import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Offline + deterministic: drive the real /mcp Streamable-HTTP endpoint with the
// official SDK client over an ephemeral port.
process.env.MOCK = "true";

test("MCP /mcp: initialize -> tools/list (4) -> tools/call live incidents", async () => {
  const app = createApp({ ...loadConfig(), mock: true });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const url = new URL(`http://127.0.0.1:${port}/mcp`);

  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client(
    { name: "mcp-smoke-test", version: "0.0.0" },
    { capabilities: {} }
  );

  try {
    // initialize handshake completes inside connect().
    await client.connect(transport);

    // tools/list -> exactly the 4 incident-first tools. No grid tool remains.
    const { tools } = await client.listTools();
    assert.equal(tools.length, 4, "expected exactly 4 tools");
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [
        "get_active_incidents",
        "get_planned_maintenance",
        "get_regional_health",
        "lookup_service_region",
      ]
    );

    // tools/call get_active_incidents -> the whole live picture, no matrix.
    const actRes: any = await client.callTool({
      name: "get_active_incidents",
      arguments: {},
    });
    const active = JSON.parse(actRes.content[0].text);
    for (const k of [
      "generatedAt",
      "overall",
      "counts",
      "global",
      "regional",
      "maintenance",
      "regionsAffected",
      "servicesAffected",
      "activeTrackingIds",
    ]) {
      assert.ok(k in active, `payload missing ${k}`);
    }
    // Nothing synthesized: no legend, no cells, no notApplicable.
    assert.ok(!("legend" in active));
    assert.ok(!("services" in active));
    assert.ok(active.activeTrackingIds.includes("VL12-3B8"));

    // The mock's active Front Door incident is global.
    const fd = active.global.find((i: any) => /front door/i.test(i.title));
    assert.ok(fd, "Front Door incident present");
    assert.equal(fd.status, "active");
    assert.equal(fd.trackingId, "VL12-3B8");

    // tools/call get_regional_health -> incidents touching Global.
    const regRes: any = await client.callTool({
      name: "get_regional_health",
      arguments: { region: "Global" },
    });
    const col = JSON.parse(regRes.content[0].text);
    assert.equal(col.region, "Global");
    assert.ok(col.incidentCount > 0);
    assert.ok(col.activeTrackingIds.includes("VL12-3B8"));

    // tools/call lookup_service_region -> the matching incidents for a pair.
    const lkRes: any = await client.callTool({
      name: "lookup_service_region",
      arguments: { service: "Azure Front Door", region: "Global" },
    });
    const lk = JSON.parse(lkRes.content[0].text);
    assert.equal(lk.impacted, true);
    assert.ok(lk.activeTrackingIds.includes("VL12-3B8"));

    // A region with nothing published returns an explicit "nothing reported"
    // note rather than a fabricated healthy answer.
    const quietRes: any = await client.callTool({
      name: "get_regional_health",
      arguments: { region: "Nowhere" },
    });
    const quiet = JSON.parse(quietRes.content[0].text);
    assert.equal(quiet.incidentCount, 0);
    assert.match(quiet.note, /not a positive health measurement/i);

    // Same honesty contract on the pair lookup.
    const missRes: any = await client.callTool({
      name: "lookup_service_region",
      arguments: { service: "Azure Kubernetes Service", region: "Nowhere" },
    });
    const miss = JSON.parse(missRes.content[0].text);
    assert.equal(miss.impacted, false);
    assert.match(miss.note, /not a positive health measurement/i);

    // REGRESSION (found in live tenant testing): region must be OPTIONAL.
    // "Is Front Door having problems?" is a question agents ask constantly. When
    // region was mandatory the agent could not express it and fell back to
    // dumping every unrelated incident, which reads as a hallucination.
    const svcOnlyRes: any = await client.callTool({
      name: "lookup_service_region",
      arguments: { service: "Azure Front Door" },
    });
    const svcOnly = JSON.parse(svcOnlyRes.content[0].text);
    assert.equal(svcOnly.impacted, true, "service-only lookup should match");
    assert.equal(svcOnly.region, null);
    assert.equal(svcOnly.scope, "service-anywhere");
    assert.ok(svcOnly.activeTrackingIds.includes("VL12-3B8"));

    // A service-only lookup that matches nothing still tells the truth.
    const svcQuietRes: any = await client.callTool({
      name: "lookup_service_region",
      arguments: { service: "Azure Kubernetes Service" },
    });
    const svcQuiet = JSON.parse(svcQuietRes.content[0].text);
    assert.equal(svcQuiet.impacted, false);
    assert.match(svcQuiet.note, /not a positive health measurement/i);

    // REGRESSION (found in live tenant testing): planned maintenance must be
    // filterable server-side. Real Service Health rows frequently carry an EMPTY
    // impactedRegions and name the region only in the title, so any client-side
    // filter on the structured field silently misses live events.
    const pmAll: any = await client.callTool({
      name: "get_planned_maintenance",
      arguments: {},
    });
    const allEvents = JSON.parse(pmAll.content[0].text);
    assert.ok(allEvents.count > 0, "mock has maintenance events");

    const pmScoped: any = await client.callTool({
      name: "get_planned_maintenance",
      arguments: { region: "East US 2" },
    });
    const scoped = JSON.parse(pmScoped.content[0].text);
    assert.equal(scoped.region, "East US 2");
    assert.ok(scoped.count > 0, "East US 2 maintenance must be found");
    assert.ok(scoped.count < allEvents.count, "scoping must actually narrow");
    assert.ok(
      scoped.events.every((e: any) => /east us 2/i.test(JSON.stringify(e))),
      "every scoped event should relate to East US 2"
    );

    // Scoping to something with no maintenance is honest, not silent.
    const pmNone: any = await client.callTool({
      name: "get_planned_maintenance",
      arguments: { region: "Nowhere" },
    });
    const none = JSON.parse(pmNone.content[0].text);
    assert.equal(none.count, 0);
    assert.match(none.note, /not a guarantee|no maintenance is published/i);
  } finally {
    await client.close().catch(() => {});
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
