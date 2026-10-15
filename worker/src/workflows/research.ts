/**
 * ResearchWorkflow: the research orchestrator as a Cloudflare Workflow.
 *
 * Each step is durable and retried on its own, so a GitHub rate limit or a
 * guardian 429 in step 4 does not repeat steps 1 to 3. Sub-agents run as
 * parallel steps. Step outputs are kept small (ids and counts), because each
 * step result is persisted.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";

import { createDb, type Db } from "../db/client";
import {
  analyzeLeverage,
  exportToMaestro,
  failRun,
  judgeFindings,
  loadContext,
  loadSeedRepos,
  parentCandidates,
  planAgents,
  rankCandidates,
  recordMaestroScan,
  runAgent,
  runLibraryAgent,
  writeReport,
} from "../services/research";

export interface ResearchParams {
  runId: string;
  /** Set by the daily Maestro job, so the scan row is written when the run finishes. */
  maestroPlanHash?: string;
}

const RETRY = { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "10 minutes" } as const satisfies WorkflowStepConfig;

export class ResearchWorkflow extends WorkflowEntrypoint<Env, ResearchParams> {
  private async withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const { db, close } = createDb(this.env);
    try {
      return await fn(db);
    } finally {
      await close();
    }
  }

  async run(event: WorkflowEvent<ResearchParams>, step: WorkflowStep): Promise<{ runId: string; findings: number }> {
    const { runId } = event.payload;
    try {
      const ctx = await step.do("load context", RETRY, () => this.withDb((db) => loadContext(this.env, db, runId)));

      let candidates: Array<{ repoId: number; agentId: string | null }>;
      if (ctx.seedRepos.length) {
        const ids = await step.do("load seed repositories", RETRY, () => this.withDb((db) => loadSeedRepos(this.env, db, ctx.seedRepos)));
        candidates = ids.map((repoId) => ({ repoId, agentId: null }));
      } else if (ctx.parentRunId && ctx.kind === "leverage") {
        const ids = await step.do("reuse parent findings", RETRY, () => this.withDb((db) => parentCandidates(db, ctx.parentRunId!)));
        candidates = ids.map((repoId) => ({ repoId, agentId: null }));
      } else {
        const agents = await step.do("orchestrator: plan sub-agents", RETRY, () => this.withDb((db) => planAgents(this.env, db, ctx)));
        const results = await Promise.all(
          agents.map((agent) =>
            step.do(`sub-agent: ${agent.name}`, RETRY, () => this.withDb((db) => runAgent(this.env, db, agent))).then((ids) => ids.map((repoId) => ({ repoId, agentId: agent.id }))),
          ),
        );
        const library = await step.do("sub-agent: your-library", RETRY, () => this.withDb((db) => runLibraryAgent(this.env, db, ctx)));
        // GitHub sub-agents first, so a repo both found keeps the GitHub agent's attribution.
        candidates = [...results.flat(), ...library.repoIds.map((repoId) => ({ repoId, agentId: library.agentId }))];
      }

      const ranked = await step.do("dedupe, enrich and rank", RETRY, () => this.withDb((db) => rankCandidates(this.env, db, ctx, candidates)));
      if (ranked > 0) {
        await step.do("judge relevance", RETRY, () => this.withDb((db) => judgeFindings(this.env, db, ctx)));
        if (ctx.kind !== "consultation" || ctx.targetRepo || ctx.targetInfrastructure) {
          await step.do("analyze leverage", RETRY, () => this.withDb((db) => analyzeLeverage(this.env, db, ctx)));
        }
      }
      await step.do("write report", RETRY, () => this.withDb((db) => writeReport(this.env, db, ctx)));

      if (ctx.kind === "maestro_auto" && ctx.maestroProjectKey) {
        if (event.payload.maestroPlanHash) {
          await step.do("record Maestro scan", RETRY, () => this.withDb((db) => recordMaestroScan(db, ctx.maestroProjectKey!, runId, event.payload.maestroPlanHash!)));
        }
        if (ranked > 0) {
          // Only strong matches become Maestro work; weaker ones stay in the report.
          await step.do("export strong matches to Maestro", RETRY, () =>
            this.withDb(async (db) => {
              try {
                return await exportToMaestro(this.env, db, runId, { minRelevance: 0.8 });
              } catch (error) {
                if (String((error as Error).message).startsWith("no findings qualify")) return null;
                throw error;
              }
            }),
          );
        }
      }
      return { runId, findings: ranked };
    } catch (error) {
      await this.withDb((db) => failRun(db, runId, error));
      throw error;
    }
  }
}
