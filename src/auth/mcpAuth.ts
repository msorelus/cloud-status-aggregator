/**
 * OAuth 2.0 Resource Server wiring for the MCP endpoint.
 *
 * Produces the two things the MCP authorization spec requires of a resource
 * server, and nothing more:
 *
 *   1. **Protected Resource Metadata** (RFC 9728) so a client that gets a 401
 *      can discover *where* to authenticate without being told out of band.
 *   2. **Bearer middleware** that answers 401 with a `WWW-Authenticate` header
 *      carrying `resource_metadata="..."`, pointing back at (1).
 *
 * Token issuance stays entirely with Entra ID. This service is never an
 * authorization server.
 *
 * ---------------------------------------------------------------------------
 * Two deliberate deviations from a naive implementation
 * ---------------------------------------------------------------------------
 * **`scopes_supported` is fully qualified.** It advertises
 * `api://<guid>/status.read`, not the bare `status.read`. A client echoes these
 * values straight into its authorization request, and Entra only binds a token
 * to this API when the scope names the API. A bare scope name yields a token
 * for Microsoft Graph instead, which then fails audience validation here — with
 * a sign-in flow that looked completely successful.
 *
 * **The metadata document is served at two paths.** RFC 9728 specifies the
 * path-suffixed form (`/.well-known/oauth-protected-resource/mcp`), which is
 * what the `WWW-Authenticate` header advertises. Some clients still probe the
 * host-root form first. Serving both costs one route and removes an entire
 * category of "client silently fails to discover auth" bug reports.
 */

import express, { type RequestHandler, type Router } from "express";
import {
  mcpAuthMetadataRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createEntraVerifier, jwksUriFor } from "./entraVerifier";
import type { McpAuthConfig } from "../config";

export interface McpAuth {
  /** Mount before the MCP routes: serves the discovery documents. */
  metadataRouter: Router;
  /** Apply to every MCP route. */
  middleware: RequestHandler;
  /** The canonical resource identifier advertised to clients. */
  resourceUrl: string;
  /** Absolute URL of the protected-resource metadata document. */
  metadataUrl: string;
  /** Fully-qualified scopes a client must request. */
  scopes: string[];
}

/** Build Entra's authorization-server metadata without a startup network call. */
export function entraOAuthMetadata(tenantId: string, authorityHost: string): OAuthMetadata {
  const base = `${authorityHost.replace(/\/+$/, "")}/${tenantId}`;
  return {
    issuer: `${base}/v2.0`,
    authorization_endpoint: `${base}/oauth2/v2.0/authorize`,
    token_endpoint: `${base}/oauth2/v2.0/token`,
    jwks_uri: jwksUriFor(tenantId, authorityHost),
    response_types_supported: ["code"],
    response_modes_supported: ["query", "fragment", "form_post"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
  } as OAuthMetadata;
}

/**
 * Qualify each scope against the resource it belongs to, unless it is already
 * qualified (anything containing `://` is passed through untouched).
 *
 * The prefix should normally be the MCP endpoint's own URL, so a scope reads
 * `https://<host>/mcp/status.read`. That is deliberate and load-bearing:
 * MCP clients that implement RFC 8707 Resource Indicators — VS Code among them —
 * send `resource=<the PRM resource value>` alongside the scope on the token
 * request. Microsoft Entra ID derives the resource from the *scope* and rejects
 * the request with `invalid_target` / **AADSTS9010010** ("the resource parameter
 * provided in the request doesn't match with the requested scopes") when the two
 * disagree. Qualifying with `api://<guid>/` while the client sends the endpoint
 * URL as the resource is exactly that mismatch.
 *
 * The corollary is an app-registration requirement: the MCP endpoint URL has to
 * be registered as an Application ID URI on the API app, or Entra will not
 * recognise it as a resource at all. See the handoff guide.
 *
 * A bare GUID prefix still yields the `api://<guid>/` form, and setting
 * MCP_AUTH_SCOPES to fully qualified values overrides all of this.
 */
export function qualifyScopes(resourceIdentifier: string, scopes: string[]): string[] {
  const prefix = resourceIdentifier.includes("://")
    ? resourceIdentifier.replace(/\/+$/, "")
    : `api://${resourceIdentifier}`;
  return scopes.map((s) => (s.includes("://") ? s : `${prefix}/${s}`));
}

export function createMcpAuth(cfg: McpAuthConfig, mcpPath: string): McpAuth {
  if (!cfg.tenantId) {
    throw new Error("MCP auth is enabled but MCP_AUTH_TENANT_ID is not set.");
  }
  if (!cfg.audience) {
    throw new Error("MCP auth is enabled but MCP_AUTH_AUDIENCE is not set.");
  }
  if (!cfg.publicBaseUrl) {
    throw new Error(
      "MCP auth is enabled but PUBLIC_BASE_URL is not set. It must be the " +
        "externally reachable https origin of this service — it becomes the " +
        "`resource` identifier clients bind their token to, so a guess will not do."
    );
  }

  const baseUrl = cfg.publicBaseUrl.replace(/\/+$/, "");
  const resourceServerUrl = new URL(`${baseUrl}${mcpPath}`);
  const metadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);
  const scopes = qualifyScopes(resourceServerUrl.href, cfg.scopes);
  const oauthMetadata = entraOAuthMetadata(cfg.tenantId, cfg.authorityHost);

  const verifier = createEntraVerifier({
    tenantId: cfg.tenantId,
    audiences: [cfg.audience, resourceServerUrl.href],
    authorityHost: cfg.authorityHost,
  });

  const router = express.Router();
  router.use(
    mcpAuthMetadataRouter({
      oauthMetadata,
      resourceServerUrl,
      scopesSupported: scopes,
      resourceName: cfg.resourceName,
    })
  );

  // Host-root alias of the same document (see the header note).
  const rootMetadata = {
    resource: resourceServerUrl.href,
    authorization_servers: [oauthMetadata.issuer],
    scopes_supported: scopes,
    resource_name: cfg.resourceName,
    bearer_methods_supported: ["header"],
  };
  router.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.status(200).json(rootMetadata);
  });

  return {
    metadataRouter: router,
    middleware: requireBearerAuth({
      verifier,
      // Scope enforcement is intentionally left to Entra's consent model. The
      // token is already audience-bound to this API; requiring a specific scope
      // string here as well would reject app-only callers, whose permissions
      // arrive in `roles` rather than `scp`, for no additional security.
      requiredScopes: [],
      resourceMetadataUrl: metadataUrl,
    }),
    resourceUrl: resourceServerUrl.href,
    metadataUrl,
    scopes,
  };
}
