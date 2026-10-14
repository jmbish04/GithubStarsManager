/**
 * Worker entry: OAuth 2.1 for MCP clients, a direct bearer door for scripts,
 * the Hono app for everything else, and the daily cron.
 */
import OAuthProvider, { type AuthRequest, getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { createLegacyMcpHandler } from "agents/mcp";

import { app, runMaestroAutoResearch } from "./app";
import { createDb } from "./db/client";
import { presentedKey, safeEqual } from "./lib/auth";
import { getSecret } from "./lib/secrets";
import { buildMcpServer } from "./mcp";
import { consentPage } from "./pages";
import { runDiscovery } from "./services/discovery";
import { syncStars } from "./services/stars";

export { ResearchWorkflow } from "./workflows/research";

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;
// The provider validates this at module load, before any env is available.
const PUBLIC_ORIGIN = "https://github-stars-manager.hacolby.workers.dev";
const OPERATOR_USER_ID = "operator";
const encoder = new TextEncoder();

function mcpHandler(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const origin = new URL(request.url).origin;
  // SDK v1 server, built per request. Move to the SDK v2 factory form of
  // createMcpHandler when @modelcontextprotocol/sdk v2 is adopted.
  return createLegacyMcpHandler(buildMcpServer(env, ctx, origin), { route: "/mcp" })(request, env, ctx);
}

const oauthOptions = {
  apiRoute: "/mcp",
  apiHandler: { fetch: (request: Request, env: Env, ctx: ExecutionContext) => mcpHandler(request, env, ctx) },
  defaultHandler: { fetch: (request: Request, env: Env, ctx: ExecutionContext) => defaultFetch(request, env, ctx) },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["mcp"],
  requiredScopes: ["mcp"],
  // RFC 9728: the canonical identifier of the protected resource (the MCP endpoint).
  resourceMetadata: { resource: `${PUBLIC_ORIGIN}/mcp`, resource_name: "GitHub Stars Manager" },
  // A year, everywhere: the library defaults (1 hour / 30 days / 90 days) would
  // silently break connectors long before anyone notices.
  accessTokenTTL: ONE_YEAR_SECONDS,
  refreshTokenTTL: ONE_YEAR_SECONDS,
  clientRegistrationTTL: ONE_YEAR_SECONDS,
};

const provider = new OAuthProvider<Env>(oauthOptions as ConstructorParameters<typeof OAuthProvider<Env>>[0]);

async function hmac(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message)));
  return btoa(String.fromCharCode(...signature)).replace(/=+$/, "");
}

/** The parsed OAuth request travels through the consent form signed, so it cannot be altered. */
async function sealState(apiKey: string, authRequest: AuthRequest): Promise<string> {
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify(authRequest))));
  return `${payload}.${await hmac(apiKey, payload)}`;
}

async function openState(apiKey: string, state: string): Promise<AuthRequest | null> {
  const [payload, signature] = state.split(".");
  if (!payload || !signature || !safeEqual(signature, await hmac(apiKey, payload))) return null;
  return JSON.parse(decodeURIComponent(escape(atob(payload)))) as AuthRequest;
}

async function authorize(request: Request, env: Env): Promise<Response> {
  const oauth = getOAuthApi(oauthOptions as never, env);
  const apiKey = await getSecret(env, "WORKER_API_KEY");
  if (!apiKey) return new Response("Server is missing its passcode binding.", { status: 500 });
  const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

  if (request.method === "GET") {
    const authRequest = await oauth.parseAuthRequest(request);
    const client = await oauth.lookupClient(authRequest.clientId);
    if (!client) return new Response("Unknown OAuth client.", { status: 400 });
    return html(consentPage({ clientName: client.clientName ?? authRequest.clientId, redirectHost: new URL(authRequest.redirectUri).host, state: await sealState(apiKey, authRequest), failed: false }));
  }

  const form = await request.formData();
  const authRequest = await openState(apiKey, String(form.get("state") ?? ""));
  if (!authRequest) return new Response("The authorization request was altered or expired.", { status: 400 });
  const passcode = String(form.get("passcode") ?? "");
  if (!safeEqual(passcode, apiKey)) {
    const client = await oauth.lookupClient(authRequest.clientId);
    return html(consentPage({ clientName: client?.clientName ?? authRequest.clientId, redirectHost: new URL(authRequest.redirectUri).host, state: String(form.get("state")), failed: true }), 401);
  }
  const { redirectTo } = await oauth.completeAuthorization({
    request: authRequest,
    userId: OPERATOR_USER_ID,
    metadata: { grantedAt: new Date().toISOString() },
    scope: authRequest.scope?.length ? authRequest.scope : ["mcp"],
    props: { user: OPERATOR_USER_ID },
  });
  return Response.redirect(redirectTo, 302);
}

function defaultFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
  const path = new URL(request.url).pathname;
  if (path === "/authorize") return authorize(request, env);
  return app.fetch(request, env, ctx);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    // Scripts and sibling Workers: a bare WORKER_API_KEY bearer skips OAuth on /mcp.
    if (path === "/mcp" || path.startsWith("/mcp/")) {
      const key = presentedKey(request);
      const apiKey = await getSecret(env, "WORKER_API_KEY");
      if (key && apiKey && safeEqual(key, apiKey)) return mcpHandler(request, env, ctx);
    }
    return provider.fetch(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const { db, close } = createDb(env);
    const log = (event: string, data: Record<string, unknown>) => console.log(JSON.stringify({ event, cron: controller.cron, ...data }));
    try {
      // Each job is independent: one failing must not stop the others.
      for (const [name, job] of [
        ["star_sync", () => syncStars(env, db, { readmeLimit: 200, embedLimit: 500 })],
        ["discovery", () => runDiscovery(env, db, "cron")],
        ["maestro_auto_research", () => runMaestroAutoResearch(env, db, "cron")],
      ] as const) {
        try {
          log(`${name}_done`, { result: await job() });
        } catch (error) {
          log(`${name}_failed`, { error: String((error as Error).message) });
        }
      }
    } finally {
      ctx.waitUntil(close());
    }
  },
} satisfies ExportedHandler<Env>;
