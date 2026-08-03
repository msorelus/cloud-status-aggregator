/**
 * Microsoft Entra ID access-token verification for the MCP endpoint.
 *
 * The MCP server is an OAuth 2.0 **Resource Server** (RFC 9728 / MCP
 * authorization spec 2025-06-18). It never issues tokens — it validates tokens
 * minted by Entra ID and rejects everything else.
 *
 * Validation performed, in order:
 *   1. RS256 signature against the tenant JWKS (keys are fetched and cached by
 *      `jose`, which handles Entra's key rollover automatically).
 *   2. `iss` — both the v2.0 and v1.0 issuer forms are accepted, because which
 *      one you get depends on the app registration's `requestedAccessTokenVersion`
 *      and a tenant can legitimately hold apps of both vintages.
 *   3. `aud` — see the note below; this is the single most common misconfiguration.
 *   4. `exp` / `nbf` — enforced by `jose`, with a small clock-skew allowance.
 *
 * ---------------------------------------------------------------------------
 * The audience trap
 * ---------------------------------------------------------------------------
 * Entra issues a **v2.0** token whose `aud` is the resource app's *client ID
 * GUID*, even though the client requested the scope as
 * `api://<guid>/status.read`. It is natural to assume `aud` will be the
 * Application ID URI (`api://<guid>`) — it is not. v1.0 tokens *do* use the URI
 * form. Verified empirically against a live tenant:
 *
 *     scope requested : api://11111111-2222-3333-4444-555555555555/status.read
 *     aud received    : 11111111-2222-3333-4444-555555555555
 *                       ^-- bare GUID, no api:// prefix
 *
 * Accepting only one form produces a 401 on every request while the sign-in
 * flow itself appears to succeed, which is a miserable thing to debug. Both
 * forms are therefore accepted.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

export interface EntraVerifierOptions {
  /** Directory (tenant) GUID that must have issued the token. */
  tenantId: string;
  /**
   * Accepted `aud` values. Callers should pass the resource app's client ID;
   * `api://<clientId>` is added automatically so both token versions work.
   */
  audiences: string[];
  /** Login authority host. Override for sovereign clouds. */
  authorityHost?: string;
  /** Tolerance for clock drift between Entra and this host. */
  clockToleranceSeconds?: number;
}

/** The shape `requireBearerAuth` expects from its `verifier`. */
export interface TokenVerifier {
  verifyAccessToken(token: string): Promise<AuthInfo>;
}

const DEFAULT_AUTHORITY = "https://login.microsoftonline.com";

/**
 * Delegated permissions arrive in `scp` as a space-delimited string; application
 * permissions (client credentials, no user) arrive in `roles` as an array. An
 * agent calling on behalf of a signed-in user hits the first case; a daemon hits
 * the second. Both are legitimate callers, so both are flattened into `scopes`.
 */
function extractScopes(payload: JWTPayload): string[] {
  const scopes: string[] = [];
  const scp = payload["scp"];
  if (typeof scp === "string") {
    scopes.push(...scp.split(" ").filter(Boolean));
  } else if (Array.isArray(scp)) {
    scopes.push(...scp.filter((s): s is string => typeof s === "string"));
  }
  const roles = payload["roles"];
  if (Array.isArray(roles)) {
    scopes.push(...roles.filter((r): r is string => typeof r === "string"));
  }
  return [...new Set(scopes)];
}

/** Normalize to the set of audience strings Entra might actually emit. */
export function expandAudiences(audiences: string[]): string[] {
  const out = new Set<string>();
  for (const a of audiences) {
    const trimmed = a.trim();
    if (!trimmed) continue;
    out.add(trimmed);
    if (trimmed.startsWith("api://")) {
      out.add(trimmed.slice("api://".length));
    } else {
      out.add(`api://${trimmed}`);
    }
  }
  return [...out];
}

export function issuersFor(tenantId: string, authorityHost = DEFAULT_AUTHORITY): string[] {
  return [
    `${authorityHost}/${tenantId}/v2.0`,
    // v1.0 issuer. Always sts.windows.net, regardless of the login host.
    `https://sts.windows.net/${tenantId}/`,
  ];
}

export function jwksUriFor(tenantId: string, authorityHost = DEFAULT_AUTHORITY): string {
  return `${authorityHost}/${tenantId}/discovery/v2.0/keys`;
}

export function createEntraVerifier(options: EntraVerifierOptions): TokenVerifier {
  const authorityHost = (options.authorityHost || DEFAULT_AUTHORITY).replace(/\/+$/, "");
  const audiences = expandAudiences(options.audiences);
  const issuers = issuersFor(options.tenantId, authorityHost);

  if (audiences.length === 0) {
    throw new Error(
      "MCP auth is enabled but no audience was configured. Set MCP_AUTH_AUDIENCE " +
        "to the API app registration's client ID."
    );
  }

  // Created once: `jose` caches the key set and refetches only on an unknown
  // `kid`, so this does not add a network round-trip per request.
  const jwks = createRemoteJWKSet(new URL(jwksUriFor(options.tenantId, authorityHost)));

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, jwks, {
          issuer: issuers,
          audience: audiences,
          algorithms: ["RS256"],
          clockTolerance: options.clockToleranceSeconds ?? 60,
        }));
      } catch (err: any) {
        // Translate every jose failure into InvalidTokenError so the SDK's
        // bearer middleware answers 401 + WWW-Authenticate. Anything else would
        // surface as a 500 and the client would never learn how to authenticate.
        const code = err?.code ? ` (${err.code})` : "";
        throw new InvalidTokenError(`${err?.message || "Token validation failed"}${code}`);
      }

      if (typeof payload.exp !== "number") {
        throw new InvalidTokenError("Token has no 'exp' claim");
      }

      const clientId =
        (typeof payload["azp"] === "string" && payload["azp"]) ||
        (typeof payload["appid"] === "string" && payload["appid"]) ||
        "unknown";

      return {
        token,
        clientId,
        scopes: extractScopes(payload),
        expiresAt: payload.exp,
        extra: {
          tenantId: typeof payload["tid"] === "string" ? payload["tid"] : undefined,
          subject: payload.sub,
          // Useful in audit logs: who is actually asking.
          username:
            (typeof payload["preferred_username"] === "string" &&
              payload["preferred_username"]) ||
            (typeof payload["upn"] === "string" && payload["upn"]) ||
            undefined,
        },
      };
    },
  };
}
