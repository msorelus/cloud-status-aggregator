/**
 * MCP authorization tests.
 *
 * Deliberately offline. Everything here exercises the parts of the resource
 * server that must behave correctly *before* a token is ever validated: the
 * discovery documents, the 401 contract, and the scope/audience string handling
 * that decides whether a client can obtain a usable token at all.
 *
 * Signature validation itself is not unit-tested against a live JWKS — that
 * would make the suite depend on network and on a tenant. It is covered by the
 * live checks in the handoff guide instead.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import {
  expandAudiences,
  issuersFor,
  jwksUriFor,
} from "../src/auth/entraVerifier";
import { qualifyScopes, entraOAuthMetadata } from "../src/auth/mcpAuth";

const TENANT = "11111111-2222-3333-4444-555555555555";
const AUDIENCE = "66666666-7777-8888-9999-000000000000";
const BASE = "https://status.example.com";

function authedApp() {
  return createApp({
    ...loadConfig(),
    mock: true,
    mcpAuth: {
      enabled: true,
      tenantId: TENANT,
      audience: AUDIENCE,
      scopes: ["status.read"],
      publicBaseUrl: BASE,
      authorityHost: "https://login.microsoftonline.com",
      resourceName: "Cloud Status Aggregator",
    },
  });
}

const openApp = createApp({ ...loadConfig(), mock: true });

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
};

// ─── audience handling ───────────────────────────────────────────────────────

test("expandAudiences accepts both the bare GUID and the api:// URI form", () => {
  // Entra emits the bare GUID in v2.0 tokens and the api:// URI in v1.0 tokens.
  // Accepting only the configured spelling would 401 every request from one of
  // the two token versions.
  const out = expandAudiences([AUDIENCE]);
  assert.ok(out.includes(AUDIENCE));
  assert.ok(out.includes(`api://${AUDIENCE}`));

  const fromUri = expandAudiences([`api://${AUDIENCE}`]);
  assert.ok(fromUri.includes(AUDIENCE));
  assert.ok(fromUri.includes(`api://${AUDIENCE}`));
});

test("expandAudiences drops blanks and de-duplicates", () => {
  const out = expandAudiences([AUDIENCE, `api://${AUDIENCE}`, "", "   "]);
  assert.equal(out.length, 2);
});

test("issuersFor accepts both the v2.0 and v1.0 issuer spellings", () => {
  const out = issuersFor(TENANT);
  assert.ok(out.includes(`https://login.microsoftonline.com/${TENANT}/v2.0`));
  // v1.0 issuer keeps its trailing slash and is always sts.windows.net.
  assert.ok(out.includes(`https://sts.windows.net/${TENANT}/`));
});

test("jwksUriFor points at the tenant key set", () => {
  assert.equal(
    jwksUriFor(TENANT),
    `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`
  );
});

// ─── scope qualification ─────────────────────────────────────────────────────

test("qualifyScopes prefixes bare scopes with the resource identifier", () => {
  // A bare "status.read" sent to Entra yields a Graph token, not a token for
  // this API — which then fails audience validation despite a clean sign-in.
  assert.deepEqual(qualifyScopes(`${BASE}/mcp`, ["status.read"]), [
    `${BASE}/mcp/status.read`,
  ]);
});

test("qualifyScopes still produces the api:// form when given a bare GUID", () => {
  // The escape hatch for deployments that have not registered the endpoint URL
  // as an Application ID URI.
  assert.deepEqual(qualifyScopes(AUDIENCE, ["status.read"]), [
    `api://${AUDIENCE}/status.read`,
  ]);
});

test("qualifyScopes leaves already-qualified scopes untouched", () => {
  // This is how an operator overrides the default via MCP_AUTH_SCOPES.
  const already = `api://${AUDIENCE}/status.read`;
  assert.deepEqual(qualifyScopes(`${BASE}/mcp`, [already]), [already]);
});

test("qualifyScopes does not double up a slash on a trailing-slash resource", () => {
  assert.deepEqual(qualifyScopes(`${BASE}/mcp/`, ["status.read"]), [
    `${BASE}/mcp/status.read`,
  ]);
});

test("entraOAuthMetadata exposes the endpoints a client needs for PKCE", () => {
  const md = entraOAuthMetadata(TENANT, "https://login.microsoftonline.com");
  assert.equal(md.issuer, `https://login.microsoftonline.com/${TENANT}/v2.0`);
  assert.ok(md.authorization_endpoint.includes("/oauth2/v2.0/authorize"));
  assert.ok(md.token_endpoint.includes("/oauth2/v2.0/token"));
  assert.deepEqual(md.response_types_supported, ["code"]);
  assert.ok(md.code_challenge_methods_supported?.includes("S256"));
});

// ─── the 401 contract ────────────────────────────────────────────────────────

test("auth enabled: unauthenticated /mcp returns 401 with a resource_metadata pointer", async () => {
  const res = await request(authedApp())
    .post("/mcp")
    .set("Accept", "application/json, text/event-stream")
    .send(INIT);

  assert.equal(res.status, 401);
  const header = res.headers["www-authenticate"];
  assert.ok(header, "WWW-Authenticate header must be present");
  assert.match(header, /^Bearer /);
  // Without this pointer a client has no way to discover where to authenticate.
  assert.ok(
    header.includes(
      `resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`
    ),
    `resource_metadata missing or wrong: ${header}`
  );
});

test("auth enabled: a non-Bearer scheme is rejected", async () => {
  const res = await request(authedApp())
    .post("/mcp")
    .set("Authorization", "Basic Zm9vOmJhcg==")
    .set("Accept", "application/json, text/event-stream")
    .send(INIT);
  assert.equal(res.status, 401);
  assert.equal(res.body.error, "invalid_token");
});

test("auth enabled: a malformed bearer token is rejected without a network call", async () => {
  const res = await request(authedApp())
    .post("/mcp")
    .set("Authorization", "Bearer not-a-jwt")
    .set("Accept", "application/json, text/event-stream")
    .send(INIT);
  assert.equal(res.status, 401);
  assert.equal(res.body.error, "invalid_token");
});

test("auth enabled: GET and DELETE on /mcp are guarded too", async () => {
  const app = authedApp();
  for (const method of ["get", "delete"] as const) {
    const res = await request(app)[method]("/mcp");
    assert.equal(res.status, 401, `${method.toUpperCase()} /mcp should be 401`);
  }
});

// ─── discovery documents must be readable without a token ────────────────────

test("auth enabled: protected resource metadata is public and correctly shaped", async () => {
  const res = await request(authedApp()).get(
    "/.well-known/oauth-protected-resource/mcp"
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.resource, `${BASE}/mcp`);
  assert.deepEqual(res.body.authorization_servers, [
    `https://login.microsoftonline.com/${TENANT}/v2.0`,
  ]);
  // Qualified with the resource identifier, NOT `api://<guid>/`. Clients that
  // implement RFC 8707 send `resource` alongside the scope on the token
  // request; Entra derives the resource from the scope and rejects the pair
  // with AADSTS9010010 when they disagree. Observed as a hard connection
  // failure in VS Code, so this assertion is a regression guard.
  assert.deepEqual(res.body.scopes_supported, [`${BASE}/mcp/status.read`]);
  for (const s of res.body.scopes_supported as string[]) {
    assert.ok(
      s.startsWith(res.body.resource as string),
      `scope ${s} must be prefixed by the advertised resource ${res.body.resource}`
    );
  }
});

test("auth enabled: the host-root metadata alias is served as well", async () => {
  // RFC 9728 specifies the path-suffixed URL, but clients that probe the root
  // form should not silently fail to discover authentication.
  const res = await request(authedApp()).get(
    "/.well-known/oauth-protected-resource"
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.resource, `${BASE}/mcp`);
  assert.deepEqual(res.body.bearer_methods_supported, ["header"]);
});

test("auth enabled: authorization server metadata is served for clients that ask", async () => {
  const res = await request(authedApp()).get(
    "/.well-known/oauth-authorization-server"
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.issuer, `https://login.microsoftonline.com/${TENANT}/v2.0`);
});

test("auth enabled: /healthz reports the auth mode and stays public", async () => {
  const res = await request(authedApp()).get("/healthz");
  assert.equal(res.status, 200);
  assert.equal(res.body.mcpAuth, "entra");
});

// ─── the disabled path must remain exactly as it was ─────────────────────────

test("auth disabled: /mcp still completes an unauthenticated handshake", async () => {
  const res = await request(openApp)
    .post("/mcp")
    .set("Accept", "application/json, text/event-stream")
    .send(INIT);
  assert.equal(res.status, 200);
  assert.ok(res.headers["mcp-session-id"], "session id header expected");
});

test("auth disabled: no discovery documents are advertised", async () => {
  // Serving an empty PRM while the endpoint is open would tell a client that
  // auth exists when it does not.
  const res = await request(openApp).get(
    "/.well-known/oauth-protected-resource/mcp"
  );
  assert.equal(res.status, 404);
});

test("auth disabled: /healthz reports 'none' so an open endpoint is never a surprise", async () => {
  const res = await request(openApp).get("/healthz");
  assert.equal(res.body.mcpAuth, "none");
});
