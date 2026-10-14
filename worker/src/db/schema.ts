/**
 * Drizzle schema for the github_stars Postgres database (LXC 109, through Hyperdrive).
 *
 * One `repositories` table holds every GitHub repository the app has seen: a
 * star, a daily-discovery candidate, or a research finding. The GitHub numeric id
 * is the primary key, so a repository is stored once no matter how many runs
 * find it. That is what makes research deduplication a join, not a copy.
 *
 * Vectors live in `repositories.embedding` (pgvector, 384 dims, bge-small via
 * core-guardian). Keyword search uses a pg_textsearch BM25 index on
 * `search_text`, which the app fills on write. Both indexes are created in the SQL migration
 * (drizzle/0000_init.sql), because drizzle-kit cannot express the bm25 options.
 */
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

export const EMBEDDING_DIMENSIONS = 384;

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () => ts("updated_at").notNull().defaultNow();

export const repoSource = pgEnum("repo_source", ["star_sync", "discovery", "research", "manual"]);
export const runStatus = pgEnum("run_status", ["queued", "running", "succeeded", "failed"]);
export const runTrigger = pgEnum("run_trigger", ["cron", "manual", "api", "mcp"]);
export const researchKind = pgEnum("research_kind", ["consultation", "leverage", "maestro_auto"]);
export const leverageMode = pgEnum("leverage_mode", ["idea", "service", "dependency", "fork", "none"]);

// ── Categories ────────────────────────────────────────────────────────────────
export const categories = pgTable("categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  icon: text("icon").notNull().default("folder"),
  keywords: text("keywords").array().notNull().default(sql`'{}'::text[]`),
  color: text("color"),
  sortOrder: integer("sort_order").notNull().default(0),
  isCustom: boolean("is_custom").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ── Repositories (every repo seen) ───────────────────────────────────────────
export const repositories = pgTable(
  "repositories",
  {
    id: bigint("id", { mode: "number" }).primaryKey(), // GitHub repository id
    fullName: text("full_name").notNull(),
    name: text("name").notNull(),
    ownerLogin: text("owner_login").notNull(),
    ownerAvatarUrl: text("owner_avatar_url"),
    description: text("description"),
    htmlUrl: text("html_url").notNull(),
    homepage: text("homepage"),
    language: text("language"),
    topics: text("topics").array().notNull().default(sql`'{}'::text[]`),
    license: text("license"),
    stargazersCount: integer("stargazers_count").notNull().default(0),
    forksCount: integer("forks_count").notNull().default(0),
    archived: boolean("archived").notNull().default(false),
    ghCreatedAt: ts("gh_created_at"),
    ghPushedAt: ts("gh_pushed_at"),
    readmeExcerpt: text("readme_excerpt"),
    // sha256 of the text that was embedded; unchanged text is never re-embedded.
    contentHash: text("content_hash"),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    embeddedAt: ts("embedded_at"),
    // Filled by repoSearchText() on every write; BM25-indexed (pg_textsearch).
    searchText: text("search_text").notNull().default(""),
    isStarred: boolean("is_starred").notNull().default(false),
    starredAt: ts("starred_at"),
    unstarredAt: ts("unstarred_at"),
    aiSummary: text("ai_summary"),
    aiTags: text("ai_tags").array().notNull().default(sql`'{}'::text[]`),
    customDescription: text("custom_description"),
    customTags: text("custom_tags").array().notNull().default(sql`'{}'::text[]`),
    categoryId: text("category_id").references(() => categories.id, { onDelete: "set null" }),
    firstSeenSource: repoSource("first_seen_source").notNull(),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    lastSyncedAt: ts("last_synced_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("repositories_full_name_uq").on(t.fullName),
    index("repositories_starred_idx").on(t.starredAt).where(sql`${t.isStarred}`),
    index("repositories_stars_idx").on(t.stargazersCount),
    index("repositories_category_idx").on(t.categoryId),
  ],
);

// ── Releases (starred repositories only) ─────────────────────────────────────
export const releases = pgTable(
  "releases",
  {
    id: bigint("id", { mode: "number" }).primaryKey(), // GitHub release id
    repoId: bigint("repo_id", { mode: "number" })
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    tagName: text("tag_name").notNull(),
    name: text("name"),
    body: text("body"),
    htmlUrl: text("html_url"),
    publishedAt: ts("published_at"),
    prerelease: boolean("prerelease").notNull().default(false),
    draft: boolean("draft").notNull().default(false),
    assets: jsonb("assets").notNull().default(sql`'[]'::jsonb`),
    readAt: ts("read_at"),
    createdAt: createdAt(),
  },
  (t) => [index("releases_repo_published_idx").on(t.repoId, t.publishedAt)],
);

// ── Settings (key/value) ─────────────────────────────────────────────────────
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updatedAt(),
});

// ── Daily discovery ──────────────────────────────────────────────────────────
export const interestProfiles = pgTable("interest_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  keywords: text("keywords").array().notNull().default(sql`'{}'::text[]`),
  topics: text("topics").array().notNull().default(sql`'{}'::text[]`),
  languages: text("languages").array().notNull().default(sql`'{}'::text[]`),
  minStars: integer("min_stars").notNull().default(100),
  // Only repositories created or pushed within this many days count as "new".
  freshnessDays: integer("freshness_days").notNull().default(30),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const discoveryRuns = pgTable(
  "discovery_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    trigger: runTrigger("trigger").notNull(),
    status: runStatus("status").notNull().default("running"),
    queries: jsonb("queries").notNull().default(sql`'[]'::jsonb`),
    candidatesSeen: integer("candidates_seen").notNull().default(0),
    itemsAdded: integer("items_added").notNull().default(0),
    error: text("error"),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("discovery_runs_started_idx").on(t.startedAt)],
);

export const discoveryItems = pgTable(
  "discovery_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // One inbox row per repository, ever: a repo you have reviewed does not return.
    repoId: bigint("repo_id", { mode: "number" })
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => discoveryRuns.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id").references(() => interestProfiles.id, { onDelete: "set null" }),
    score: real("score").notNull().default(0),
    reason: text("reason"),
    matchedQuery: text("matched_query"),
    discoveredAt: ts("discovered_at").notNull().defaultNow(),
    readAt: ts("read_at"),
    starredViaAppAt: ts("starred_via_app_at"),
  },
  (t) => [
    uniqueIndex("discovery_items_repo_uq").on(t.repoId),
    index("discovery_items_unread_idx").on(t.score).where(sql`${t.readAt} is null`),
    index("discovery_items_run_idx").on(t.runId),
  ],
);

// ── Research (consultation, leverage analysis, Maestro auto-research) ────────
export const researchRuns = pgTable(
  "research_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: researchKind("kind").notNull(),
    trigger: runTrigger("trigger").notNull(),
    status: runStatus("status").notNull().default("queued"),
    criterion: text("criterion").notNull(),
    // sha256 of the normalized criterion + target, used to find earlier runs.
    criterionHash: text("criterion_hash").notNull(),
    // "owner/name" of the repository being planned, or null for a new repo.
    targetRepo: text("target_repo"),
    targetInfrastructure: text("target_infrastructure"),
    minStars: integer("min_stars").notNull().default(500),
    // A narrowing or leverage run points at the run whose findings it reuses.
    parentRunId: uuid("parent_run_id").references((): AnyPgColumn => researchRuns.id, {
      onDelete: "set null",
    }),
    // Colby Maestro identifiers (strings: Maestro owns them).
    maestroProjectKey: text("maestro_project_key"),
    maestroPlanId: text("maestro_plan_id"),
    maestroTaskId: text("maestro_task_id"),
    workflowInstanceId: text("workflow_instance_id"),
    plan: jsonb("plan"),
    reportMarkdown: text("report_markdown"),
    llmCalls: integer("llm_calls").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    error: text("error"),
    createdAt: createdAt(),
    startedAt: ts("started_at"),
    completedAt: ts("completed_at"),
  },
  (t) => [
    index("research_runs_hash_idx").on(t.criterionHash, t.createdAt),
    index("research_runs_maestro_idx").on(t.maestroProjectKey, t.createdAt),
    index("research_runs_status_idx").on(t.status, t.createdAt),
  ],
);

export const researchAgents = pgTable(
  "research_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    angle: text("angle").notNull(),
    queries: text("queries").array().notNull().default(sql`'{}'::text[]`),
    status: runStatus("status").notNull().default("queued"),
    candidatesFound: integer("candidates_found").notNull().default(0),
    error: text("error"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("research_agents_run_idx").on(t.runId)],
);

export const researchFindings = pgTable(
  "research_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    repoId: bigint("repo_id", { mode: "number" })
      .notNull()
      .references(() => repositories.id, { onDelete: "restrict" }),
    agentId: uuid("agent_id").references(() => researchAgents.id, { onDelete: "set null" }),
    similarity: real("similarity"),
    relevance: real("relevance"),
    rationale: text("rationale"),
    leverageMode: leverageMode("leverage_mode"),
    leverage: jsonb("leverage"),
    selected: boolean("selected").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("research_findings_run_repo_uq").on(t.runId, t.repoId),
    index("research_findings_repo_idx").on(t.repoId),
  ],
);

/** One row per Colby Maestro project the daily job has researched. */
export const maestroProjectScans = pgTable("maestro_project_scans", {
  projectKey: text("project_key").primaryKey(),
  lastRunId: uuid("last_run_id").references(() => researchRuns.id, { onDelete: "set null" }),
  // sha256 of the project's plan text; a changed plan earns a full re-run.
  planHash: text("plan_hash"),
  lastScannedAt: ts("last_scanned_at").notNull().defaultNow(),
});

/** What a research run pushed into Colby Maestro (plan, epic, tasks). */
export const maestroExports = pgTable(
  "maestro_exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    projectKey: text("project_key").notNull(),
    planId: text("plan_id"),
    epicTaskId: text("epic_task_id"),
    taskIds: text("task_ids").array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
  },
  (t) => [index("maestro_exports_run_idx").on(t.runId)],
);
