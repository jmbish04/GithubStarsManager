/**
 * MCP in code mode: two tools instead of one per route.
 *
 *   search  - find API operations in the OpenAPI document (cheap, read-only)
 *   execute - call one /api operation; it runs through the same Hono app,
 *             validation and auth as an HTTP request
 *
 * No user code runs here: `execute` takes a structured request, not a script,
 * so there is no sandbox and no per-request Worker identity.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { app } from "./app";
import { requireSecret } from "./lib/secrets";

const MAX_RESULT_CHARS = 60_000;

type OpenApiDoc = { paths: Record<string, Record<string, { summary?: string; tags?: string[]; parameters?: unknown[]; requestBody?: { content?: Record<string, { schema?: unknown }> } }>> };

function openApiDocument(origin: string): OpenApiDoc {
  return app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "GitHub Stars Manager API", version: "0.1.0" }, servers: [{ url: origin }] }) as unknown as OpenApiDoc;
}

/** Rank operations by how many query words appear in path, summary and tags. Pure, so it is unit-tested. */
export function searchOperations(doc: OpenApiDoc, query: string, limit = 8) {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 1);
  const ops: Array<{ method: string; path: string; summary: string; score: number; parameters: unknown; body: unknown }> = [];
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const haystack = `${path} ${op.summary ?? ""} ${(op.tags ?? []).join(" ")}`.toLowerCase();
      const score = words.length ? words.filter((w) => haystack.includes(w)).length : 1;
      if (score > 0) ops.push({ method: method.toUpperCase(), path, summary: op.summary ?? "", score, parameters: op.parameters ?? [], body: op.requestBody?.content?.["application/json"]?.schema ?? null });
    }
  }
  return ops.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function buildMcpServer(env: Env, ctx: ExecutionContext, origin: string): McpServer {
  const server = new McpServer(
    {
      name: "github-stars-manager",
      version: "0.1.0",
      icons: [
        { src: `${origin}/icon-128.png`, mimeType: "image/png", sizes: ["128x128"] },
        { src: `${origin}/favicon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
      ],
    },
    {
      instructions:
        "GitHub stars, semantic search, a daily discovery inbox, and research consultations. " +
        "Call `search` with what you want to do to find the API operation, then `execute` it. " +
        "Research runs are asynchronous: POST /api/research returns a runId; poll GET /api/research/{id}.",
    },
  );

  server.registerTool(
    "search",
    {
      description: "Find API operations by keyword. Returns method, path, summary, parameters and body schema.",
      inputSchema: { query: z.string().min(1).describe("What you want to do, e.g. 'unread discoveries' or 'start research'") },
    },
    async ({ query }) => {
      const results = searchOperations(openApiDocument(origin), query);
      return { content: [{ type: "text", text: JSON.stringify(results, null, 1) }], structuredContent: { results } };
    },
  );

  server.registerTool(
    "execute",
    {
      description: "Call one /api operation found with `search`. Example: {method:'GET', path:'/api/discovery/inbox', query:{limit:'10'}}.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "DELETE"]),
        path: z.string().regex(/^\/api\//, "path must start with /api/"),
        query: z.record(z.string(), z.string()).optional(),
        body: z.unknown().optional(),
      },
    },
    async ({ method, path, query, body }) => {
      const url = new URL(path, origin);
      for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
      const response = await app.fetch(
        new Request(url, {
          method,
          headers: { authorization: `Bearer ${await requireSecret(env, "WORKER_API_KEY")}`, "content-type": "application/json" },
          body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(body ?? {}),
        }),
        env,
        ctx,
      );
      const text = await response.text();
      const truncated = text.length > MAX_RESULT_CHARS;
      return {
        isError: !response.ok,
        content: [{ type: "text", text: `HTTP ${response.status}${truncated ? ` (truncated from ${text.length.toLocaleString("en-US")} characters)` : ""}\n${text.slice(0, MAX_RESULT_CHARS)}` }],
      };
    },
  );

  return server;
}
