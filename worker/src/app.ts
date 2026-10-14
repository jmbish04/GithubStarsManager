/**
 * The HTTP API. Every /api route is declared with @hono/zod-openapi, so
 * /openapi.json, /scalar and /swagger are generated from the same definitions
 * that validate requests.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { Scalar } from "@scalar/hono-api-reference";
import { and, count, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import type { Context } from "hono";

import { createDb, type Db } from "./db/client";
import { discoveryRuns, interestProfiles, maestroProjectScans, repositories, researchAgents, researchFindings, researchRuns, settings } from "./db/schema";
import { createSessionToken, isAuthenticated, safeEqual, sessionCookieHeader } from "./lib/auth";
import { octokit } from "./lib/github";
import { GuardianError, type GuardianRpcSurface } from "./lib/guardian";
import * as maestro from "./lib/maestro";
import { getSecret } from "./lib/secrets";
import { listInbox, markRead, runDiscovery, starInboxItem } from "./services/discovery";
import { embedPending, listStarredRepos, searchRepositories } from "./services/repos";
import { createRun, criterionHash, exportToMaestro, findingsForReport, pickMaestroProjects, type ResearchRequest } from "./services/research";
import { starRepository, syncStars, unstarRepository } from "./services/stars";
import { landingPage, loginPage } from "./pages";

type AppEnv = { Bindings: Env; Variables: { db: Db } };

export const app = new OpenAPIHono<AppEnv>({
  defaultHook: (result, c) => {
    if (!result.success) return c.json({ error: "Invalid request", issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
  },
});

// ── Errors ───────────────────────────────────────────────────────────────────
app.onError((error, c) => {
  const status = error instanceof GuardianError ? (error.status === 429 || error.status === 422 ? error.status : 502) : error instanceof maestro.MaestroError ? 502 : 500;
  const message = publicErrorMessage(error);
  console.error(JSON.stringify({ event: "request_error", path: c.req.path, status, message }));
  return c.json({ error: message }, status as 500);
});

/**
 * Drizzle wraps driver errors as "Failed query: <sql> params: <values>", which can
 * be megabytes and carries row data. Report the database's own reason instead.
 */
export function publicErrorMessage(error: Error): string {
  const cause = (error as { cause?: unknown }).cause;
  if (error.message.startsWith("Failed query:") && cause instanceof Error) return `Database error: ${cause.message}`.slice(0, 500);
  return error.message.slice(0, 500);
}

// ── Public pages and docs ────────────────────────────────────────────────────
app.get("/", (c) => c.html(landingPage()));
app.get("/login", (c) => c.html(loginPage(c.req.query("error") === "1")));
app.post("/auth/login", async (c) => {
  const form = await c.req.parseBody();
  const passcode = typeof form.passcode === "string" ? form.passcode : "";
  const apiKey = await getSecret(c.env, "WORKER_API_KEY");
  if (!apiKey || !passcode || !safeEqual(passcode, apiKey)) return c.redirect("/login?error=1", 303);
  c.header("set-cookie", sessionCookieHeader(await createSessionToken(apiKey)));
  return c.redirect("/scalar", 303);
});

app.doc31("/openapi.json", (c) => ({
  openapi: "3.1.0",
  info: {
    title: "GitHub Stars Manager API",
    version: "0.1.0",
    description:
      "Stars, semantic search (Postgres pgvector + pg_textsearch), daily discovery, and research consultations. " +
      "Authenticate with `Authorization: Bearer <passcode>` or the browser session from /login.",
  },
  servers: [{ url: new URL(c.req.url).origin }],
  security: [{ bearer: [] }],
}));
app.openAPIRegistry.registerComponent("securitySchemes", "bearer", { type: "http", scheme: "bearer" });
app.get("/scalar", Scalar({ url: "/openapi.json", pageTitle: "GitHub Stars Manager API" }));
app.get("/swagger", swaggerUI({ url: "/openapi.json" }));

// ── Health: reads and writes every dependency; any critical failure fails the verdict ──
app.get("/health", async (c) => {
  const checks: Record<string, { ok: boolean; severity: "critical" | "degraded"; detail: string; ms: number }> = {};
  const probe = async (name: string, severity: "critical" | "degraded", fn: () => Promise<string>) => {
    const start = Date.now();
    try {
      checks[name] = { ok: true, severity, detail: await fn(), ms: Date.now() - start };
    } catch (error) {
      checks[name] = { ok: false, severity, detail: String((error as Error).message).slice(0, 300), ms: Date.now() - start };
    }
  };
  const { db, close } = createDb(c.env);
  try {
    await Promise.all([
      probe("postgres", "critical", async () => {
        const now = new Date().toISOString();
        await db.insert(settings).values({ key: "health_probe", value: { at: now } }).onConflictDoUpdate({ target: settings.key, set: { value: { at: now }, updatedAt: new Date() } });
        const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "health_probe"));
        if ((row?.value as { at?: string })?.at !== now) throw new Error("wrote a health probe row but read back a different value");
        return "read and write ok";
      }),
      probe("github", "critical", async () => {
        const { data } = await (await octokit(c.env)).rest.rateLimit.get();
        return `core ${data.resources.core.remaining}/${data.resources.core.limit}, search ${data.resources.search?.remaining ?? "?"}/${data.resources.search?.limit ?? "?"}`;
      }),
      probe("core-guardian", "critical", async () => {
        const useCases = (await (c.env.GUARDIAN as unknown as GuardianRpcSurface & { useCases(): Promise<{ useCases?: unknown[] }> }).useCases()) ?? {};
        return `${useCases.useCases?.length ?? 0} use cases routable`;
      }),
      probe("colby-maestro", "degraded", async () => {
        const status = await maestro.ping(c.env);
        if (status !== 200) throw new Error(`/api/ping answered ${status}`);
        return "reachable";
      }),
    ]);
  } finally {
    c.executionCtx.waitUntil(close());
  }
  const failed = Object.entries(checks).filter(([, check]) => !check.ok);
  const status = failed.some(([, check]) => check.severity === "critical") ? "unhealthy" : failed.length ? "degraded" : "ok";
  return c.json({ status, checks }, status === "unhealthy" ? 503 : 200);
});

// ── Auth gate and per-request database for /api ──────────────────────────────
app.use("/api/*", async (c, next) => {
  if (!(await isAuthenticated(c.env, c.req.raw))) return c.json({ error: "Unauthorized" }, 401);
  const { db, close } = createDb(c.env);
  c.set("db", db);
  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");
const json = <T extends z.ZodType>(schema: T, description: string) => ({ content: { "application/json": { schema } }, description });
const errors = { 400: json(ErrorSchema, "Invalid request"), 401: json(ErrorSchema, "Unauthorized") };
const IdParam = z.object({ id: z.coerce.number().int().positive().openapi({ param: { name: "id", in: "path" } }) });
const UuidParam = z.object({ id: z.uuid().openapi({ param: { name: "id", in: "path" } }) });

const RepoHit = z
  .object({
    id: z.number(),
    fullName: z.string(),
    description: z.string().nullable(),
    htmlUrl: z.string(),
    language: z.string().nullable(),
    topics: z.array(z.string()),
    stargazersCount: z.number(),
    isStarred: z.boolean(),
    score: z.number(),
    similarity: z.number().nullable(),
  })
  .openapi("RepoHit");

// ── Stars ────────────────────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "post",
    path: "/api/stars/sync",
    tags: ["Stars"],
    summary: "Mirror your GitHub stars, fetch missing READMEs and embed what changed",
    request: { body: { content: { "application/json": { schema: z.object({ readmeLimit: z.number().int().min(0).max(200).default(50), embedLimit: z.number().int().min(0).max(500).default(200) }) } } } },
    responses: { 200: json(z.object({ starred: z.number(), complete: z.boolean(), newlyUnstarred: z.number(), readmesFetched: z.number(), embedded: z.number() }), "Sync result"), ...errors },
  }),
  async (c) => c.json(await syncStars(c.env, c.var.db, c.req.valid("json")), 200),
);

app.openapi(
  createRoute({
    method: "get",
    path: "/api/repositories",
    tags: ["Stars"],
    summary: "List starred repositories, newest star first",
    request: { query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }) },
    responses: { 200: json(z.object({ items: z.array(z.record(z.string(), z.unknown())) }), "Starred repositories"), ...errors },
  }),
  async (c) => {
    const { limit, offset } = c.req.valid("query");
    return c.json({ items: await listStarredRepos(c.var.db, limit, offset) }, 200);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/api/repositories/{id}/star",
    tags: ["Stars"],
    summary: "Star a stored repository on GitHub",
    request: { params: IdParam },
    responses: { 200: json(z.object({ starred: z.string() }), "Starred"), ...errors },
  }),
  async (c) => c.json({ starred: (await starRepository(c.env, c.var.db, c.req.valid("param").id)).fullName }, 200),
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/api/repositories/{id}/star",
    tags: ["Stars"],
    summary: "Unstar a repository on GitHub",
    request: { params: IdParam },
    responses: { 200: json(z.object({ unstarred: z.string() }), "Unstarred"), ...errors },
  }),
  async (c) => c.json({ unstarred: (await unstarRepository(c.env, c.var.db, c.req.valid("param").id)).fullName }, 200),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/api/embeddings/backfill",
    tags: ["Search"],
    summary: "Embed stored repositories that have no vector or whose text changed (bge-small through core-guardian)",
    request: { body: { content: { "application/json": { schema: z.object({ limit: z.number().int().min(1).max(1_000).default(500) }) } } } },
    responses: { 200: json(z.object({ embedded: z.number(), remaining: z.number() }), "Backfill result"), ...errors },
  }),
  async (c) => {
    const embedded = await embedPending(c.env, c.var.db, { limit: c.req.valid("json").limit });
    const [{ remaining }] = await c.var.db.select({ remaining: count() }).from(repositories).where(isNull(repositories.embedding));
    return c.json({ embedded, remaining }, 200);
  },
);

// ── Search ───────────────────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/api/search",
    tags: ["Search"],
    summary: "Semantic (pgvector), keyword (BM25) or hybrid search over stored repositories",
    request: {
      query: z.object({
        q: z.string().min(1).max(500),
        mode: z.enum(["semantic", "keyword", "hybrid"]).default("hybrid"),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        starred: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
      }),
    },
    responses: { 200: json(z.object({ items: z.array(RepoHit) }), "Ranked repositories"), ...errors },
  }),
  async (c) => {
    const { q, mode, limit, starred } = c.req.valid("query");
    return c.json({ items: await searchRepositories(c.env, c.var.db, { query: q, mode, limit, starredOnly: starred }) }, 200);
  },
);

// ── Discovery ────────────────────────────────────────────────────────────────
const InboxItem = z
  .object({
    itemId: z.string(),
    repoId: z.number(),
    fullName: z.string(),
    description: z.string().nullable(),
    htmlUrl: z.string(),
    language: z.string().nullable(),
    topics: z.array(z.string()),
    stargazersCount: z.number(),
    isStarred: z.boolean(),
    score: z.number(),
    reason: z.string().nullable(),
    discoveredAt: z.string(),
    readAt: z.string().nullable(),
  })
  .openapi("InboxItem");

app.openapi(
  createRoute({
    method: "get",
    path: "/api/discovery/inbox",
    tags: ["Discovery"],
    summary: "Unread discoveries, best match first. Read items disappear unless includeRead=true",
    request: { query: z.object({ includeRead: z.enum(["true", "false"]).default("false").transform((v) => v === "true"), limit: z.coerce.number().int().min(1).max(200).default(50) }) },
    responses: { 200: json(z.object({ items: z.array(InboxItem) }), "Inbox"), ...errors },
  }),
  async (c) => {
    const rows = await listInbox(c.var.db, c.req.valid("query"));
    return c.json({ items: rows.map((r) => ({ ...r, discoveredAt: r.discoveredAt.toISOString(), readAt: r.readAt?.toISOString() ?? null })) }, 200);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/api/discovery/run",
    tags: ["Discovery"],
    summary: "Run the discovery scan now (it also runs daily at 13:00 UTC)",
    responses: { 200: json(z.object({ runId: z.string(), candidatesSeen: z.number(), itemsAdded: z.number() }), "Scan result"), ...errors },
  }),
  async (c) => c.json(await runDiscovery(c.env, c.var.db, "api"), 200),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/api/discovery/read",
    tags: ["Discovery"],
    summary: "Mark inbox items as reviewed; they leave the inbox for good",
    request: { body: { content: { "application/json": { schema: z.object({ itemIds: z.array(z.uuid()).min(1).max(500) }) } } } },
    responses: { 200: json(z.object({ marked: z.number() }), "Marked"), ...errors },
  }),
  async (c) => c.json({ marked: await markRead(c.var.db, c.req.valid("json").itemIds) }, 200),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/api/discovery/items/{id}/star",
    tags: ["Discovery"],
    summary: "Star a discovered repository on GitHub and mark it reviewed",
    request: { params: UuidParam },
    responses: { 200: json(z.object({ starred: z.string() }), "Starred"), ...errors },
  }),
  async (c) => c.json({ starred: (await starInboxItem(c.env, c.var.db, c.req.valid("param").id)).fullName }, 200),
);

app.openapi(
  createRoute({
    method: "get",
    path: "/api/discovery/runs",
    tags: ["Discovery"],
    summary: "Recent discovery runs",
    responses: { 200: json(z.object({ items: z.array(z.record(z.string(), z.unknown())) }), "Runs"), ...errors },
  }),
  async (c) => c.json({ items: await c.var.db.select().from(discoveryRuns).orderBy(desc(discoveryRuns.startedAt)).limit(30) }, 200),
);

// ── Interest profiles ────────────────────────────────────────────────────────
const ProfileInput = z
  .object({
    name: z.string().min(1).max(100),
    keywords: z.array(z.string().min(1).max(80)).max(20).default([]),
    topics: z.array(z.string().min(1).max(50)).max(20).default([]),
    languages: z.array(z.string().min(1).max(40)).max(5).default([]),
    minStars: z.number().int().min(0).max(1_000_000).default(100),
    freshnessDays: z.number().int().min(1).max(365).default(30),
    enabled: z.boolean().default(true),
  })
  .openapi("InterestProfileInput");

app.openapi(
  createRoute({ method: "get", path: "/api/interests", tags: ["Discovery"], summary: "List interest profiles (none means: derive from your stars)", responses: { 200: json(z.object({ items: z.array(z.record(z.string(), z.unknown())) }), "Profiles"), ...errors } }),
  async (c) => c.json({ items: await c.var.db.select().from(interestProfiles).orderBy(interestProfiles.name) }, 200),
);
app.openapi(
  createRoute({ method: "post", path: "/api/interests", tags: ["Discovery"], summary: "Create an interest profile", request: { body: { content: { "application/json": { schema: ProfileInput } } } }, responses: { 200: json(z.record(z.string(), z.unknown()), "Created"), ...errors } }),
  async (c) => {
    const [row] = await c.var.db.insert(interestProfiles).values(c.req.valid("json")).returning();
    return c.json(row, 200);
  },
);
app.openapi(
  createRoute({ method: "put", path: "/api/interests/{id}", tags: ["Discovery"], summary: "Replace an interest profile", request: { params: UuidParam, body: { content: { "application/json": { schema: ProfileInput } } } }, responses: { 200: json(z.record(z.string(), z.unknown()), "Updated"), 404: json(ErrorSchema, "Not found"), ...errors } }),
  async (c) => {
    const [row] = await c.var.db.update(interestProfiles).set({ ...c.req.valid("json"), updatedAt: new Date() }).where(eq(interestProfiles.id, c.req.valid("param").id)).returning();
    return row ? c.json(row, 200) : c.json({ error: "Interest profile not found" }, 404);
  },
);
app.openapi(
  createRoute({ method: "delete", path: "/api/interests/{id}", tags: ["Discovery"], summary: "Delete an interest profile", request: { params: UuidParam }, responses: { 200: json(z.object({ deleted: z.boolean() }), "Deleted"), ...errors } }),
  async (c) => {
    const rows = await c.var.db.delete(interestProfiles).where(eq(interestProfiles.id, c.req.valid("param").id)).returning({ id: interestProfiles.id });
    return c.json({ deleted: rows.length > 0 }, 200);
  },
);

// ── Research ─────────────────────────────────────────────────────────────────
const RunStarted = z.object({ runId: z.string(), status: z.string(), reused: z.boolean() }).openapi("RunStarted");

/** Start a research workflow, or return a matching run from the last 24 hours unless `force`. */
export async function startResearch(env: Env, db: Db, req: ResearchRequest, force = false): Promise<z.infer<typeof RunStarted>> {
  if (!force && !req.seedRepos?.length && !req.parentRunId) {
    const hash = await criterionHash(req);
    const [recent] = await db
      .select({ id: researchRuns.id, status: researchRuns.status })
      .from(researchRuns)
      .where(and(eq(researchRuns.criterionHash, hash), eq(researchRuns.kind, req.kind), inArray(researchRuns.status, ["queued", "running", "succeeded"]), gte(researchRuns.createdAt, new Date(Date.now() - 86_400_000))))
      .orderBy(desc(researchRuns.createdAt))
      .limit(1);
    if (recent) return { runId: recent.id, status: recent.status, reused: true };
  }
  const runId = await createRun(db, req);
  const instance = await env.RESEARCH_WORKFLOW.create({ id: runId, params: { runId } });
  await db.update(researchRuns).set({ workflowInstanceId: instance.id }).where(eq(researchRuns.id, runId));
  return { runId, status: "queued", reused: false };
}

const RepoName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "use owner/name");

app.openapi(
  createRoute({
    method: "post",
    path: "/api/research",
    tags: ["Research"],
    summary: "Consultation: an orchestrator and sub-agents search GitHub for well-starred projects matching a criterion",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              criterion: z.string().min(5).max(2000),
              minStars: z.number().int().min(0).max(1_000_000).default(500),
              targetRepo: RepoName.optional(),
              targetInfrastructure: z.string().max(300).optional(),
              force: z.boolean().default(false),
            }),
          },
        },
      },
    },
    responses: { 202: json(RunStarted, "Run started or reused"), ...errors },
  }),
  async (c) => {
    const body = c.req.valid("json");
    return c.json(await startResearch(c.env, c.var.db, { kind: "consultation", trigger: "api", ...body }, body.force), 202);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/api/leverage",
    tags: ["Research"],
    summary: "On demand: would these repositories improve what I plan to build on a new or existing repo and infrastructure?",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              repos: z.array(RepoName).min(1).max(20),
              goal: z.string().min(5).max(2000),
              targetRepo: RepoName.optional(),
              targetInfrastructure: z.string().max(300).optional(),
            }),
          },
        },
      },
    },
    responses: { 202: json(RunStarted, "Run started"), ...errors },
  }),
  async (c) => {
    const body = c.req.valid("json");
    return c.json(
      await startResearch(c.env, c.var.db, { kind: "leverage", trigger: "api", criterion: body.goal, seedRepos: body.repos, targetRepo: body.targetRepo, targetInfrastructure: body.targetInfrastructure, minStars: 0 }),
      202,
    );
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/api/research",
    tags: ["Research"],
    summary: "Recent research runs",
    request: { query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }) },
    responses: { 200: json(z.object({ items: z.array(z.record(z.string(), z.unknown())) }), "Runs"), ...errors },
  }),
  async (c) => {
    const rows = await c.var.db
      .select({ id: researchRuns.id, kind: researchRuns.kind, status: researchRuns.status, criterion: researchRuns.criterion, targetRepo: researchRuns.targetRepo, maestroProjectKey: researchRuns.maestroProjectKey, llmCalls: researchRuns.llmCalls, costUsd: researchRuns.costUsd, createdAt: researchRuns.createdAt, completedAt: researchRuns.completedAt })
      .from(researchRuns)
      .orderBy(desc(researchRuns.createdAt))
      .limit(c.req.valid("query").limit);
    return c.json({ items: rows }, 200);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/api/research/{id}",
    tags: ["Research"],
    summary: "One research run: status, sub-agents, findings and the report",
    request: { params: UuidParam },
    responses: { 200: json(z.record(z.string(), z.unknown()), "Run"), 404: json(ErrorSchema, "Not found"), ...errors },
  }),
  async (c) => {
    const id = c.req.valid("param").id;
    const [run] = await c.var.db.select().from(researchRuns).where(eq(researchRuns.id, id));
    if (!run) return c.json({ error: "Research run not found" }, 404);
    const agents = await c.var.db.select().from(researchAgents).where(eq(researchAgents.runId, id));
    const findings = await findingsForReport(c.var.db, id, 60);
    return c.json({ run, agents, findings }, 200);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/api/research/{id}/select",
    tags: ["Research"],
    summary: "Narrow a run: mark which findings to carry forward",
    request: { params: UuidParam, body: { content: { "application/json": { schema: z.object({ findingIds: z.array(z.uuid()).min(1).max(100), selected: z.boolean().default(true) }) } } } },
    responses: { 200: json(z.object({ updated: z.number() }), "Updated"), ...errors },
  }),
  async (c) => {
    const { findingIds, selected } = c.req.valid("json");
    const rows = await c.var.db
      .update(researchFindings)
      .set({ selected })
      .where(and(eq(researchFindings.runId, c.req.valid("param").id), inArray(researchFindings.id, findingIds)))
      .returning({ id: researchFindings.id });
    return c.json({ updated: rows.length }, 200);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/api/research/{id}/leverage",
    tags: ["Research"],
    summary: "From a finished run, analyze what the selected findings could contribute to a new or existing repo on given infrastructure",
    request: { params: UuidParam, body: { content: { "application/json": { schema: z.object({ goal: z.string().min(5).max(2000).optional(), targetRepo: RepoName.optional(), targetInfrastructure: z.string().max(300).optional() }) } } } },
    responses: { 202: json(RunStarted, "Run started"), 404: json(ErrorSchema, "Not found"), ...errors },
  }),
  async (c) => {
    const parentId = c.req.valid("param").id;
    const body = c.req.valid("json");
    const [parent] = await c.var.db.select().from(researchRuns).where(eq(researchRuns.id, parentId));
    if (!parent) return c.json({ error: "Research run not found" }, 404);
    return c.json(
      await startResearch(c.env, c.var.db, {
        kind: "leverage",
        trigger: "api",
        criterion: body.goal ?? parent.criterion,
        parentRunId: parentId,
        targetRepo: body.targetRepo ?? parent.targetRepo,
        targetInfrastructure: body.targetInfrastructure ?? parent.targetInfrastructure,
        maestroProjectKey: parent.maestroProjectKey,
        minStars: 0,
      }),
      202,
    );
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/api/research/{id}/maestro-export",
    tags: ["Research"],
    summary: "Create a Colby Maestro plan, an epic and one task per qualifying finding",
    request: {
      params: UuidParam,
      body: { content: { "application/json": { schema: z.object({ projectKey: z.string().min(1).optional(), repoPath: z.string().min(1).optional(), findingIds: z.array(z.uuid()).max(25).optional(), minRelevance: z.number().min(0).max(1).default(0.7) }) } } },
    },
    responses: { 200: json(z.object({ planId: z.string(), epicTaskId: z.string(), taskIds: z.array(z.string()) }), "Exported"), ...errors },
  }),
  async (c) => c.json(await exportToMaestro(c.env, c.var.db, c.req.valid("param").id, c.req.valid("json")), 200),
);

// ── Maestro-driven research ──────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "post",
    path: "/api/maestro/auto-research",
    tags: ["Maestro"],
    summary: "Run the daily job now: research Colby Maestro projects whose plans are new, changed, or due for a new-repositories-only rescan",
    request: { body: { content: { "application/json": { schema: z.object({ dryRun: z.boolean().default(false) }) } } } },
    responses: { 200: json(z.object({ items: z.array(z.record(z.string(), z.unknown())) }), "Decisions and runs"), ...errors },
  }),
  async (c) => c.json({ items: await runMaestroAutoResearch(c.env, c.var.db, "api", c.req.valid("json").dryRun) }, 200),
);

app.openapi(
  createRoute({ method: "get", path: "/api/maestro/scans", tags: ["Maestro"], summary: "When each Colby Maestro project was last researched", responses: { 200: json(z.object({ items: z.array(z.record(z.string(), z.unknown())) }), "Scans"), ...errors } }),
  async (c) => c.json({ items: await c.var.db.select().from(maestroProjectScans).orderBy(desc(maestroProjectScans.lastScannedAt)) }, 200),
);

export async function runMaestroAutoResearch(env: Env, db: Db, trigger: "cron" | "api" | "mcp", dryRun = false) {
  const picked = await pickMaestroProjects(env, db);
  const out: Array<Record<string, unknown>> = [];
  for (const candidate of picked) {
    if (dryRun) {
      out.push({ projectKey: candidate.projectKey, planId: candidate.planId, ...candidate.decision });
      continue;
    }
    const runId = await createRun(db, {
      kind: "maestro_auto",
      trigger,
      criterion: candidate.criterion,
      maestroProjectKey: candidate.projectKey,
      maestroPlanId: candidate.planId,
      minStars: 500,
      incremental: candidate.decision.action === "incremental",
    });
    const instance = await env.RESEARCH_WORKFLOW.create({ id: runId, params: { runId, maestroPlanHash: candidate.planHash } });
    await db.update(researchRuns).set({ workflowInstanceId: instance.id }).where(eq(researchRuns.id, runId));
    out.push({ projectKey: candidate.projectKey, planId: candidate.planId, runId, ...candidate.decision });
  }
  return out;
}

export type App = typeof app;
export type AppContext = Context<AppEnv>;
