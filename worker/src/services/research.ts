/**
 * Research: an orchestrator model plans the search, sub-agents each search
 * GitHub from one angle, and the results are ranked, judged, analyzed for
 * leverage, and written up. ResearchWorkflow (workflows/research.ts) runs these
 * functions as durable steps; each step opens its own database connection.
 *
 * Every model call goes through core-guardian (lib/guardian.ts). The number of
 * model calls per run is capped by RESEARCH_MAX_LLM_CALLS.
 */
import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";

import { type Db, withVectorScan } from "../db/client";
import { maestroExports, maestroProjectScans, repositories, researchAgents, researchFindings, researchRuns } from "../db/schema";
import { sha256Hex } from "../lib/auth";
import { type GitHubRepo, getReadme, getRepo, getTopLevelTree, octokit, searchRepos } from "../lib/github";
import { chatJson, embed } from "../lib/guardian";
import * as maestro from "../lib/maestro";
import { embedPending, setReadme, stripMarkdown, upsertGitHubRepos } from "./repos";

export type ResearchKind = "consultation" | "leverage" | "maestro_auto";
export type Trigger = "cron" | "manual" | "api" | "mcp";

export interface ResearchRequest {
  kind: ResearchKind;
  trigger: Trigger;
  criterion: string;
  targetRepo?: string | null;
  targetInfrastructure?: string | null;
  minStars?: number;
  parentRunId?: string | null;
  /** Explicit repositories to analyze ("owner/name"); skips the search phase. */
  seedRepos?: string[];
  maestroProjectKey?: string | null;
  maestroPlanId?: string | null;
  /** Exclude repositories already found by earlier runs for the same Maestro project or criterion. */
  incremental?: boolean;
}

export interface AgentPlan {
  name: string;
  angle: string;
  queries: string[];
}

export function normalizeCriterion(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export async function criterionHash(req: Pick<ResearchRequest, "criterion" | "targetRepo" | "targetInfrastructure">): Promise<string> {
  return sha256Hex([normalizeCriterion(req.criterion), req.targetRepo ?? "", normalizeCriterion(req.targetInfrastructure ?? "")].join("|"));
}

/** Insert a queued run row. The workflow instance id is set by the caller. */
export async function createRun(db: Db, req: ResearchRequest): Promise<string> {
  const [row] = await db
    .insert(researchRuns)
    .values({
      kind: req.kind,
      trigger: req.trigger,
      criterion: req.criterion.trim(),
      criterionHash: await criterionHash(req),
      targetRepo: req.targetRepo ?? null,
      targetInfrastructure: req.targetInfrastructure ?? null,
      minStars: req.minStars ?? 500,
      parentRunId: req.parentRunId ?? null,
      maestroProjectKey: req.maestroProjectKey ?? null,
      maestroPlanId: req.maestroPlanId ?? null,
      plan: { seedRepos: req.seedRepos ?? [], incremental: req.incremental ?? false },
    })
    .returning({ id: researchRuns.id });
  return row.id;
}

// ── Step: context ────────────────────────────────────────────────────────────

export interface RunContext {
  runId: string;
  kind: ResearchKind;
  criterion: string;
  minStars: number;
  targetRepo: string | null;
  targetInfrastructure: string | null;
  targetSummary: string | null;
  maestroProjectKey: string | null;
  parentRunId: string | null;
  seedRepos: string[];
  incremental: boolean;
}

export async function loadContext(env: Env, db: Db, runId: string): Promise<RunContext> {
  const [run] = await db.select().from(researchRuns).where(eq(researchRuns.id, runId));
  if (!run) throw new Error(`research run ${runId} does not exist`);
  await db.update(researchRuns).set({ status: "running", startedAt: new Date() }).where(eq(researchRuns.id, runId));
  const plan = (run.plan ?? {}) as { seedRepos?: string[]; incremental?: boolean };

  let targetSummary: string | null = null;
  if (run.targetRepo) {
    const gh = await octokit(env);
    const [repo, readme, tree] = await Promise.all([getRepo(gh, run.targetRepo), getReadme(gh, run.targetRepo, 4000), getTopLevelTree(gh, run.targetRepo)]);
    targetSummary = [
      `Repository ${repo.full_name}: ${repo.description ?? "no description"}`,
      `Language: ${repo.language ?? "unknown"}. Topics: ${(repo.topics ?? []).join(", ") || "none"}.`,
      `Top-level files: ${tree.slice(0, 60).join(", ")}`,
      `README excerpt: ${stripMarkdown(readme ?? "").slice(0, 2500)}`,
    ].join("\n");
  }
  return {
    runId,
    kind: run.kind,
    criterion: run.criterion,
    minStars: run.minStars,
    targetRepo: run.targetRepo,
    targetInfrastructure: run.targetInfrastructure,
    targetSummary,
    maestroProjectKey: run.maestroProjectKey,
    parentRunId: run.parentRunId,
    seedRepos: plan.seedRepos ?? [],
    incremental: plan.incremental ?? false,
  };
}

async function countCall(db: Db, runId: string, costUsd: number): Promise<void> {
  await db
    .update(researchRuns)
    .set({ llmCalls: sql`${researchRuns.llmCalls} + 1`, costUsd: sql`${researchRuns.costUsd} + ${costUsd}` })
    .where(eq(researchRuns.id, runId));
}

async function assertCallBudget(env: Env, db: Db, runId: string): Promise<void> {
  const [run] = await db.select({ llmCalls: researchRuns.llmCalls }).from(researchRuns).where(eq(researchRuns.id, runId));
  if ((run?.llmCalls ?? 0) >= Number(env.RESEARCH_MAX_LLM_CALLS)) {
    throw new Error(`research run ${runId} reached its ceiling of ${env.RESEARCH_MAX_LLM_CALLS} model calls`);
  }
}

// ── Step: orchestrator plan ──────────────────────────────────────────────────

/** Keep only well-formed GitHub search queries; force a star floor and drop forks of the floor. */
export function sanitizeAgentPlans(raw: unknown, minStars: number): AgentPlan[] {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { agents?: unknown })?.agents) ? (raw as { agents: unknown[] }).agents : [];
  const plans: AgentPlan[] = [];
  for (const entry of list.slice(0, 5)) {
    const item = entry as Partial<AgentPlan>;
    if (typeof item?.name !== "string" || !Array.isArray(item.queries)) continue;
    const queries = item.queries
      .filter((q): q is string => typeof q === "string" && q.trim().length > 2)
      .map((q) => q.replace(/\bstars:\S+/g, "").replace(/\s+/g, " ").trim())
      .map((q) => `${q} stars:>=${minStars} archived:false`)
      .slice(0, 3);
    if (queries.length === 0) continue;
    plans.push({ name: item.name.slice(0, 60), angle: String(item.angle ?? item.name).slice(0, 300), queries });
  }
  return plans;
}

export async function planAgents(env: Env, db: Db, ctx: RunContext): Promise<Array<AgentPlan & { id: string }>> {
  await assertCallBudget(env, db, ctx.runId);
  const answer = await chatJson<{ agents: unknown }>(
    env,
    [
      {
        role: "system",
        content:
          "You plan GitHub research. Split the request into 3 to 5 independent search angles (sub-agents). " +
          "For each, write 2 or 3 GitHub repository search queries using GitHub search syntax " +
          "(keywords, topic:, language:, in:name,description,readme). Do not add stars: qualifiers. " +
          'Answer with JSON only: {"agents":[{"name":"short-kebab-name","angle":"one sentence","queries":["..."]}]}',
      },
      {
        role: "user",
        content: [
          `Research criterion: ${ctx.criterion}`,
          ctx.targetInfrastructure ? `Target infrastructure: ${ctx.targetInfrastructure}` : "",
          ctx.targetSummary ? `The repository being planned:\n${ctx.targetSummary}` : ctx.targetRepo === null ? "The target is a new repository." : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
    { useCase: "planning", complexity: "medium", task: "github-research-plan" },
  );
  await countCall(db, ctx.runId, answer._meta.costUsd);
  const plans = sanitizeAgentPlans(answer.agents, ctx.minStars);
  if (plans.length === 0) throw new Error("the orchestrator returned no usable search angles");
  const rows = await db
    .insert(researchAgents)
    .values(plans.map((p) => ({ runId: ctx.runId, name: p.name, angle: p.angle, queries: p.queries })))
    .returning({ id: researchAgents.id, name: researchAgents.name });
  await db.update(researchRuns).set({ plan: { agents: plans, seedRepos: ctx.seedRepos, incremental: ctx.incremental } }).where(eq(researchRuns.id, ctx.runId));
  return plans.map((p, i) => ({ ...p, id: rows[i].id }));
}

// ── Step: one sub-agent ──────────────────────────────────────────────────────

export async function runAgent(env: Env, db: Db, agent: AgentPlan & { id: string }): Promise<number[]> {
  await db.update(researchAgents).set({ status: "running", startedAt: new Date() }).where(eq(researchAgents.id, agent.id));
  try {
    const gh = await octokit(env);
    const found = new Map<number, GitHubRepo>();
    for (const query of agent.queries) {
      for (const repo of await searchRepos(gh, query, 20)) found.set(repo.id, repo);
    }
    await upsertGitHubRepos(db, [...found.values()], "research");
    await db
      .update(researchAgents)
      .set({ status: "succeeded", candidatesFound: found.size, finishedAt: new Date() })
      .where(eq(researchAgents.id, agent.id));
    return [...found.keys()];
  } catch (error) {
    await db
      .update(researchAgents)
      .set({ status: "failed", error: String((error as Error).message).slice(0, 1000), finishedAt: new Date() })
      .where(eq(researchAgents.id, agent.id));
    throw error;
  }
}

const LIBRARY_LIMIT = 25;

/**
 * The "your library" sub-agent: nearest neighbours of the criterion among every
 * repository already stored (your stars, past discoveries, past research).
 * GitHub search ranks by stars and keywords, so it misses close matches you
 * already know about; this pass catches them with no GitHub requests.
 */
export async function runLibraryAgent(env: Env, db: Db, ctx: RunContext): Promise<{ agentId: string; repoIds: number[] }> {
  const [agent] = await db
    .insert(researchAgents)
    .values({ runId: ctx.runId, name: "your-library", angle: "Nearest stored repositories (stars, discoveries, past research) by meaning", status: "running", startedAt: new Date() })
    .returning({ id: researchAgents.id });
  const [vector] = await embed(env, [`${ctx.criterion}\n${ctx.targetInfrastructure ?? ""}`.trim()], "embed research criterion (library agent)");
  const literal = `[${vector.join(",")}]`;
  const rows = await withVectorScan(db, (tx) =>
    tx
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(isNotNull(repositories.embedding), sql`${repositories.stargazersCount} >= ${ctx.minStars}`))
      .orderBy(sql`${repositories.embedding} <=> ${literal}::vector`)
      .limit(LIBRARY_LIMIT),
  );
  await db.update(researchAgents).set({ status: "succeeded", candidatesFound: rows.length, finishedAt: new Date() }).where(eq(researchAgents.id, agent.id));
  return { agentId: agent.id, repoIds: rows.map((r) => r.id) };
}

/** Seed repositories ("owner/name") for an on-demand leverage run. */
export async function loadSeedRepos(env: Env, db: Db, fullNames: string[]): Promise<number[]> {
  const gh = await octokit(env);
  const repos = await Promise.all(fullNames.slice(0, 20).map((name) => getRepo(gh, name)));
  await upsertGitHubRepos(db, repos, "manual");
  return repos.map((r) => r.id);
}

/** The selected (or, if none selected, top 10) findings of a parent run. */
export async function parentCandidates(db: Db, parentRunId: string): Promise<number[]> {
  const rows = await db
    .select({ repoId: researchFindings.repoId, selected: researchFindings.selected })
    .from(researchFindings)
    .where(eq(researchFindings.runId, parentRunId))
    .orderBy(desc(researchFindings.relevance));
  const selected = rows.filter((r) => r.selected);
  return (selected.length ? selected : rows.slice(0, 10)).map((r) => r.repoId);
}

// ── Step: dedupe, enrich, rank by similarity ─────────────────────────────────

/** Repositories earlier runs already surfaced for this project or criterion. */
export async function previouslyFound(db: Db, ctx: RunContext): Promise<Set<number>> {
  const [run] = await db.select({ hash: researchRuns.criterionHash }).from(researchRuns).where(eq(researchRuns.id, ctx.runId));
  const scope = ctx.maestroProjectKey ? eq(researchRuns.maestroProjectKey, ctx.maestroProjectKey) : eq(researchRuns.criterionHash, run.hash);
  const rows = await db
    .select({ repoId: researchFindings.repoId })
    .from(researchFindings)
    .innerJoin(researchRuns, eq(researchRuns.id, researchFindings.runId))
    .where(and(scope, ne(researchRuns.id, ctx.runId)));
  return new Set(rows.map((r) => r.repoId));
}

/** Keep the `max` closest candidates; ties go to more stars. Pure, so it is unit-tested. */
export function closestCandidates<T extends { id: number; similarity: number; stars: number }>(rows: T[], max: number): T[] {
  return [...rows].sort((a, b) => b.similarity - a.similarity || b.stars - a.stars).slice(0, max);
}

/** Upper bound on candidates embedded per run (metadata-only, so cheap: ~6 guardian calls). */
const MAX_CANDIDATES_EMBEDDED = 300;

async function similarities(db: Db, ids: number[], literal: string) {
  const rows = await db
    .select({ id: repositories.id, stars: repositories.stargazersCount, similarity: sql<number>`1 - (${repositories.embedding} <=> ${literal}::vector)` })
    .from(repositories)
    .where(and(inArray(repositories.id, ids), isNotNull(repositories.embedding)));
  return rows.map((r) => ({ ...r, similarity: Number(r.similarity) }));
}

/**
 * Narrow candidates by MEANING, not popularity: embed every candidate from its
 * metadata, keep the RESEARCH_MAX_CANDIDATES closest to the criterion, then fetch
 * READMEs for those only and re-embed with the richer text. Ranking by stars
 * first let 100,000-star generalists push out the 5,000-star exact match.
 */
export async function rankCandidates(
  env: Env,
  db: Db,
  ctx: RunContext,
  candidates: Array<{ repoId: number; agentId: string | null }>,
): Promise<number> {
  const exclude = ctx.incremental ? await previouslyFound(db, ctx) : new Set<number>();
  const byRepo = new Map<number, string | null>();
  for (const c of candidates) if (!exclude.has(c.repoId) && !byRepo.has(c.repoId)) byRepo.set(c.repoId, c.agentId);
  if (byRepo.size === 0) return 0;

  const all = [...byRepo.keys()].slice(0, MAX_CANDIDATES_EMBEDDED);
  await embedPending(env, db, { ids: all, limit: all.length });
  const [criterionVector] = await embed(env, [`${ctx.criterion}\n${ctx.targetInfrastructure ?? ""}`.trim()], "embed research criterion");
  const literal = `[${criterionVector.join(",")}]`;
  const shortlist = closestCandidates(await similarities(db, all, literal), Number(env.RESEARCH_MAX_CANDIDATES));
  const ids = shortlist.map((r) => r.id);

  const missing = await db
    .select({ id: repositories.id, fullName: repositories.fullName })
    .from(repositories)
    .where(and(inArray(repositories.id, ids), isNull(repositories.readmeExcerpt)));
  const gh = await octokit(env);
  for (const row of missing) {
    await setReadme(db, row.id, (await getReadme(gh, row.fullName, 4000)) ?? "");
  }
  await embedPending(env, db, { ids, limit: ids.length });

  const scored = await similarities(db, ids, literal);
  if (scored.length) {
    await db
      .insert(researchFindings)
      .values(scored.map((s) => ({ runId: ctx.runId, repoId: s.id, agentId: byRepo.get(s.id) ?? null, similarity: s.similarity })))
      .onConflictDoNothing({ target: [researchFindings.runId, researchFindings.repoId] });
  }
  return scored.length;
}

// ── Step: judge relevance ────────────────────────────────────────────────────

const JUDGE_BATCH = 15;
const JUDGE_TOP = 30;

export async function judgeFindings(env: Env, db: Db, ctx: RunContext): Promise<number> {
  const rows = await db
    .select({
      findingId: researchFindings.id,
      fullName: repositories.fullName,
      description: repositories.description,
      stars: repositories.stargazersCount,
      topics: repositories.topics,
      readme: repositories.readmeExcerpt,
    })
    .from(researchFindings)
    .innerJoin(repositories, eq(repositories.id, researchFindings.repoId))
    .where(eq(researchFindings.runId, ctx.runId))
    .orderBy(desc(researchFindings.similarity))
    .limit(JUDGE_TOP);

  let judged = 0;
  for (let i = 0; i < rows.length; i += JUDGE_BATCH) {
    const batch = rows.slice(i, i + JUDGE_BATCH);
    await assertCallBudget(env, db, ctx.runId);
    const answer = await chatJson<{ results: Array<{ repo: string; relevance: number; rationale: string }> }>(
      env,
      [
        {
          role: "system",
          content:
            "You judge how relevant GitHub repositories are to a research criterion. " +
            "Score relevance from 0 to 1 and give one plain-English sentence of rationale. " +
            'Answer with JSON only: {"results":[{"repo":"owner/name","relevance":0.0,"rationale":"..."}]}',
        },
        {
          role: "user",
          content: `Criterion: ${ctx.criterion}\n${ctx.targetInfrastructure ? `Infrastructure: ${ctx.targetInfrastructure}\n` : ""}\nRepositories:\n${batch
            .map((r) => `- ${r.fullName} (${r.stars.toLocaleString("en-US")} stars) ${r.description ?? ""} [${r.topics.join(", ")}] ${stripMarkdown(r.readme ?? "").slice(0, 400)}`)
            .join("\n")}`,
        },
      ],
      { useCase: "classification", complexity: "low", importance: "low", task: "github-research-judge" },
    );
    await countCall(db, ctx.runId, answer._meta.costUsd);
    const byName = new Map(batch.map((r) => [r.fullName.toLowerCase(), r.findingId]));
    for (const result of answer.results ?? []) {
      const findingId = byName.get(String(result.repo ?? "").toLowerCase());
      const relevance = Math.min(Math.max(Number(result.relevance), 0), 1);
      if (!findingId || !Number.isFinite(relevance)) continue;
      await db.update(researchFindings).set({ relevance, rationale: String(result.rationale ?? "").slice(0, 1000) }).where(eq(researchFindings.id, findingId));
      judged++;
    }
  }
  return judged;
}

// ── Step: leverage analysis ──────────────────────────────────────────────────

const LEVERAGE_TOP = 8;
type LeverageMode = "idea" | "service" | "dependency" | "fork" | "none";
const LEVERAGE_MODES: LeverageMode[] = ["idea", "service", "dependency", "fork", "none"];

export async function analyzeLeverage(env: Env, db: Db, ctx: RunContext): Promise<number> {
  const rows = await db
    .select({ findingId: researchFindings.id, fullName: repositories.fullName, description: repositories.description, readme: repositories.readmeExcerpt, license: repositories.license, language: repositories.language })
    .from(researchFindings)
    .innerJoin(repositories, eq(repositories.id, researchFindings.repoId))
    .where(eq(researchFindings.runId, ctx.runId))
    .orderBy(sql`${researchFindings.selected} desc, ${researchFindings.relevance} desc nulls last, ${researchFindings.similarity} desc`)
    .limit(LEVERAGE_TOP);
  if (rows.length === 0) return 0;

  await assertCallBudget(env, db, ctx.runId);
  const answer = await chatJson<{ results: Array<{ repo: string; mode: string; borrow: string[]; effort: string; risks: string[]; summary: string }> }>(
    env,
    [
      {
        role: "system",
        content:
          "You are a staff engineer deciding what an existing open-source repository can contribute to a project. " +
          "For each repository choose one mode: idea (borrow a design idea), service (run it as a separate service), " +
          "dependency (install it as a library), fork (copy and adapt the code), or none. " +
          "List the concrete things to borrow, the effort (small, medium, large), license or fit risks, and a one-sentence summary. " +
          'Answer with JSON only: {"results":[{"repo":"owner/name","mode":"idea","borrow":["..."],"effort":"small","risks":["..."],"summary":"..."}]}',
      },
      {
        role: "user",
        content: [
          `Goal: ${ctx.criterion}`,
          ctx.targetInfrastructure ? `Target infrastructure: ${ctx.targetInfrastructure}` : "",
          ctx.targetSummary ? `Existing repository:\n${ctx.targetSummary}` : "The target is a new repository.",
          "Candidates:",
          ...rows.map((r) => `- ${r.fullName} (license ${r.license ?? "unknown"}, ${r.language ?? "unknown language"}): ${r.description ?? ""}\n  ${stripMarkdown(r.readme ?? "").slice(0, 700)}`),
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
    { useCase: "analysis", complexity: "high", importance: "medium", task: "github-research-leverage", repo: ctx.targetRepo ?? undefined },
  );
  await countCall(db, ctx.runId, answer._meta.costUsd);
  const byName = new Map(rows.map((r) => [r.fullName.toLowerCase(), r.findingId]));
  let analyzed = 0;
  for (const result of answer.results ?? []) {
    const findingId = byName.get(String(result.repo ?? "").toLowerCase());
    if (!findingId) continue;
    const mode = (LEVERAGE_MODES as string[]).includes(result.mode) ? (result.mode as LeverageMode) : "none";
    await db
      .update(researchFindings)
      .set({ leverageMode: mode, leverage: { borrow: result.borrow ?? [], effort: result.effort ?? "unknown", risks: result.risks ?? [], summary: result.summary ?? "" } })
      .where(eq(researchFindings.id, findingId));
    analyzed++;
  }
  return analyzed;
}

// ── Step: report ─────────────────────────────────────────────────────────────

export async function findingsForReport(db: Db, runId: string, limit = 15) {
  return db
    .select({
      findingId: researchFindings.id,
      repoId: repositories.id,
      fullName: repositories.fullName,
      htmlUrl: repositories.htmlUrl,
      description: repositories.description,
      stars: repositories.stargazersCount,
      license: repositories.license,
      isStarred: repositories.isStarred,
      similarity: researchFindings.similarity,
      relevance: researchFindings.relevance,
      rationale: researchFindings.rationale,
      leverageMode: researchFindings.leverageMode,
      leverage: researchFindings.leverage,
      selected: researchFindings.selected,
    })
    .from(researchFindings)
    .innerJoin(repositories, eq(repositories.id, researchFindings.repoId))
    .where(eq(researchFindings.runId, runId))
    .orderBy(sql`${researchFindings.relevance} desc nulls last, ${researchFindings.similarity} desc nulls last`)
    .limit(limit);
}

export async function writeReport(env: Env, db: Db, ctx: RunContext): Promise<void> {
  const findings = await findingsForReport(db, ctx.runId);
  const table = [
    "| Repository | Stars | Relevance | Mode | Why |",
    "|---|---|---|---|---|",
    ...findings.map(
      (f) =>
        `| [${f.fullName}](${f.htmlUrl}) | ${f.stars.toLocaleString("en-US")} | ${f.relevance === null ? "n/a" : `${Math.round(f.relevance * 100)}%`} | ${f.leverageMode ?? "-"} | ${(f.rationale ?? "").replace(/\|/g, "/")} |`,
    ),
  ].join("\n");

  let summary = "No repositories matched this criterion above the star floor.";
  if (findings.length) {
    await assertCallBudget(env, db, ctx.runId);
    const answer = await chatJson<{ summary: string; recommendations: string[] }>(
      env,
      [
        {
          role: "system",
          content:
            "Summarize GitHub research for a busy developer in plain US English. Lead with the answer. " +
            'Answer with JSON only: {"summary":"3 to 5 sentences","recommendations":["at most 5 concrete next steps"]}',
        },
        {
          role: "user",
          content: `Criterion: ${ctx.criterion}\n${ctx.targetInfrastructure ? `Infrastructure: ${ctx.targetInfrastructure}\n` : ""}Findings:\n${findings
            .map((f) => `- ${f.fullName}: relevance ${f.relevance ?? "n/a"}, mode ${f.leverageMode ?? "n/a"}. ${f.rationale ?? ""} ${JSON.stringify(f.leverage ?? {})}`)
            .join("\n")}`,
        },
      ],
      { useCase: "summarization", complexity: "medium", importance: "low", task: "github-research-report" },
    );
    await countCall(db, ctx.runId, answer._meta.costUsd);
    summary = [answer.summary, "", "**Next steps**", ...(answer.recommendations ?? []).slice(0, 5).map((r, i) => `${i + 1}. ${r}`)].join("\n");
  }

  const markdown = [`# Research: ${ctx.criterion}`, "", summary, "", "## Findings", "", table].join("\n");
  await db.update(researchRuns).set({ reportMarkdown: markdown, status: "succeeded", completedAt: new Date() }).where(eq(researchRuns.id, ctx.runId));
}

export async function failRun(db: Db, runId: string, error: unknown): Promise<void> {
  await db
    .update(researchRuns)
    .set({ status: "failed", error: String((error as Error)?.message ?? error).slice(0, 2000), completedAt: new Date() })
    .where(eq(researchRuns.id, runId));
}

// ── Maestro export: plan, epic, tasks ────────────────────────────────────────

/** Markdown for the Maestro plan. Each finding gets an h2 so a task can attach to it. Pure, so it is unit-tested. */
export function exportMarkdown(run: { id: string; criterion: string; targetRepo: string | null; targetInfrastructure: string | null; reportMarkdown: string | null }, findings: Awaited<ReturnType<typeof findingsForReport>>): string {
  const lines = [
    `# Leverage plan: ${run.criterion}`,
    "",
    `> Written by github-stars-manager from research run \`${run.id}\`.${run.targetRepo ? ` Target: \`${run.targetRepo}\`.` : " Target: a new repository."}${run.targetInfrastructure ? ` Infrastructure: ${run.targetInfrastructure}.` : ""}`,
    "",
    "## Summary",
    "",
    (run.reportMarkdown ?? "").split("## Findings")[0].replace(/^# .*\n/, "").trim() || "See the findings below.",
  ];
  for (const f of findings) {
    const leverage = (f.leverage ?? {}) as { borrow?: string[]; effort?: string; risks?: string[]; summary?: string };
    lines.push(
      "",
      `## ${f.fullName}`,
      "",
      `${f.htmlUrl} · ${f.stars.toLocaleString("en-US")} stars · license ${f.license ?? "unknown"} · mode **${f.leverageMode ?? "idea"}** · effort ${leverage.effort ?? "unknown"}`,
      "",
      leverage.summary || f.rationale || "",
      ...(leverage.borrow?.length ? ["", "What to borrow:", ...leverage.borrow.map((b) => `- ${b}`)] : []),
      ...(leverage.risks?.length ? ["", "Risks:", ...leverage.risks.map((r) => `- ${r}`)] : []),
    );
  }
  return lines.join("\n");
}

export async function exportToMaestro(
  env: Env,
  db: Db,
  runId: string,
  opts: { projectKey?: string; repoPath?: string; findingIds?: string[]; minRelevance?: number },
): Promise<{ planId: string; epicTaskId: string; taskIds: string[] }> {
  const [run] = await db.select().from(researchRuns).where(eq(researchRuns.id, runId));
  if (!run) throw new Error(`research run ${runId} does not exist`);
  if (run.status !== "succeeded") throw new Error(`research run ${runId} is ${run.status}; export needs a finished run`);
  const projectKey = opts.projectKey ?? run.maestroProjectKey;
  if (!projectKey) throw new Error("projectKey is required: this run is not tied to a Colby Maestro project");

  const projects = await maestro.listProjects(env);
  const project = projects.find((p) => p.project_key === projectKey);
  if (!project) throw new Error(`colby-maestro has no project "${projectKey}"`);
  const repoPath = opts.repoPath ?? project.repo_path;

  let findings = await findingsForReport(db, runId, 25);
  if (opts.findingIds?.length) findings = findings.filter((f) => opts.findingIds!.includes(f.findingId));
  else findings = findings.filter((f) => f.selected || (f.relevance ?? 0) >= (opts.minRelevance ?? 0.7));
  findings = findings.filter((f) => f.leverageMode !== "none").slice(0, 10);
  if (findings.length === 0) throw new Error("no findings qualify for export; select some or lower minRelevance");

  const plan = await maestro.createPlan(env, { projectKey, repoPath, title: `Leverage plan: ${run.criterion.slice(0, 100)}`, markdown: exportMarkdown(run, findings) });
  const summarySection = plan.sections.find((s) => s.title === "Summary") ?? plan.sections[0];
  const epic = await maestro.createTask(env, {
    projectKey,
    repoPath,
    title: `Adopt what open source already solved: ${run.criterion.slice(0, 80)}`,
    description: `Epic from github-stars-manager research run ${runId}. ${findings.length} repositories to review and borrow from.`,
    taskType: "epic",
    priority: "medium",
    planId: plan.id,
    sectionIds: [summarySection.id],
    tags: ["github-research", "leverage"],
  });
  const taskIds: string[] = [];
  for (const f of findings) {
    const section = plan.sections.find((s) => s.title === f.fullName) ?? summarySection;
    const leverage = (f.leverage ?? {}) as { borrow?: string[]; effort?: string };
    const task = await maestro.createTask(env, {
      projectKey,
      repoPath,
      title: `${modeVerb(f.leverageMode)} ${f.fullName}`,
      description: [`${f.htmlUrl}`, leverage.borrow?.length ? `Borrow: ${leverage.borrow.join("; ")}` : f.rationale ?? "", `Effort: ${leverage.effort ?? "unknown"}.`].join("\n"),
      taskType: f.leverageMode === "idea" ? "spike" : "task",
      priority: (f.relevance ?? 0) >= 0.85 ? "high" : "medium",
      planId: plan.id,
      sectionIds: [section.id],
      parentTaskId: epic.task_id,
      tags: ["github-research", `leverage-${f.leverageMode ?? "idea"}`],
    });
    taskIds.push(task.task_id);
  }
  await db.insert(maestroExports).values({ runId, projectKey, planId: plan.id, epicTaskId: epic.task_id, taskIds });
  await db.update(researchRuns).set({ maestroProjectKey: projectKey, maestroPlanId: plan.id, maestroTaskId: epic.task_id }).where(eq(researchRuns.id, runId));
  return { planId: plan.id, epicTaskId: epic.task_id, taskIds };
}

function modeVerb(mode: string | null): string {
  switch (mode) {
    case "dependency":
      return "Evaluate as a dependency:";
    case "service":
      return "Evaluate running as a service:";
    case "fork":
      return "Evaluate forking:";
    default:
      return "Borrow ideas from";
  }
}

// ── Maestro-driven auto research (cron) ──────────────────────────────────────

const RESCAN_AFTER_DAYS = 7;

export interface AutoResearchDecision {
  action: "full" | "incremental" | "skip";
  reason: string;
}

/** Pure: decide whether a project needs research today. Unit-tested. */
export function decideAutoResearch(scan: { planHash: string | null; lastScannedAt: Date } | undefined, planHash: string, now: Date): AutoResearchDecision {
  if (!scan) return { action: "full", reason: "never researched" };
  if (scan.planHash !== planHash) return { action: "full", reason: "the plan changed" };
  const ageDays = (now.getTime() - scan.lastScannedAt.getTime()) / 86_400_000;
  if (ageDays < RESCAN_AFTER_DAYS) return { action: "skip", reason: `researched ${ageDays.toFixed(1)} days ago` };
  return { action: "incremental", reason: "look only for repositories not found before" };
}

export interface AutoResearchCandidate {
  projectKey: string;
  planId: string;
  criterion: string;
  planHash: string;
  decision: AutoResearchDecision;
}

/** Pick up to DAILY_MAESTRO_PROJECTS projects whose plans need research. Does not start runs. */
export async function pickMaestroProjects(env: Env, db: Db, now = new Date()): Promise<AutoResearchCandidate[]> {
  const projects = (await maestro.listProjects(env)).filter((p) => p.open_task_count > 0).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const scans = new Map((await db.select().from(maestroProjectScans)).map((s) => [s.projectKey, s]));
  const picked: AutoResearchCandidate[] = [];
  for (const project of projects) {
    if (picked.length >= Number(env.DAILY_MAESTRO_PROJECTS)) break;
    const [latest] = (await maestro.listPlans(env, project.project_key)).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    if (!latest) continue;
    const plan = await maestro.getPlan(env, latest.id);
    const planHash = await sha256Hex(plan.markdown ?? "");
    const decision = decideAutoResearch(scans.get(project.project_key), planHash, now);
    if (decision.action === "skip") continue;
    const outline = plan.sections
      .filter((s) => s.heading_level <= 2)
      .map((s) => `${s.title}: ${stripMarkdown(s.body_markdown).slice(0, 200)}`)
      .join("\n")
      .slice(0, 1800);
    picked.push({
      projectKey: project.project_key,
      planId: plan.id,
      planHash,
      decision,
      criterion: `Open-source GitHub projects that would help build "${plan.title}" (project ${project.project_key}). Plan outline:\n${outline}`,
    });
  }
  return picked;
}

export async function recordMaestroScan(db: Db, projectKey: string, runId: string, planHash: string): Promise<void> {
  await db
    .insert(maestroProjectScans)
    .values({ projectKey, lastRunId: runId, planHash, lastScannedAt: new Date() })
    .onConflictDoUpdate({ target: maestroProjectScans.projectKey, set: { lastRunId: runId, planHash, lastScannedAt: new Date() } });
}
