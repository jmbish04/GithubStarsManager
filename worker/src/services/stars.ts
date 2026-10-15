/**
 * Mirror the authenticated user's GitHub stars into `repositories`.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { repositories } from "../db/schema";
import { getReadme, listStarred, octokit, starRepo, unstarRepo } from "../lib/github";
import { embedPending, setReadme, upsertGitHubRepos } from "./repos";

export interface StarSyncResult {
  starred: number;
  /** False when GitHub's list was capped; unstars were then not applied. */
  complete: boolean;
  newlyUnstarred: number;
  readmesFetched: number;
  embedded: number;
}

export async function syncStars(env: Env, db: Db, opts: { readmeLimit: number; embedLimit: number }): Promise<StarSyncResult> {
  const gh = await octokit(env);
  const { rows: starred, complete } = await listStarred(gh);
  await upsertGitHubRepos(db, starred.map((s) => s.repo), "star_sync");

  const ids = starred.map((s) => s.repo.id);
  // Star state in one statement per side: set the current stars, clear the rest.
  for (let i = 0; i < starred.length; i += 2_000) {
    const values = sql.join(
      starred.slice(i, i + 2_000).map((s) => sql`(${s.repo.id}::bigint, ${s.starred_at}::timestamptz)`),
      sql`, `,
    );
    await db.execute(sql`
      update repositories r set is_starred = true, starred_at = v.starred_at, unstarred_at = null
      from (values ${values}) as v(id, starred_at)
      where r.id = v.id`);
  }
  // Clear stars only from a complete, non-empty list. An empty or capped list is
  // an absence we cannot read as "unstarred": it would wipe every star.
  const cleared =
    shouldClearMissingStars(complete, ids.length)
      ? await db
          .update(repositories)
          .set({ isStarred: false, unstarredAt: new Date() })
          .where(and(eq(repositories.isStarred, true), sql`${repositories.id} <> all(${`{${ids.join(",")}}`}::bigint[])`))
          .returning({ id: repositories.id })
      : [];

  // READMEs are one request each: fetch a bounded number per sync.
  const missing = await db
    .select({ id: repositories.id, fullName: repositories.fullName })
    .from(repositories)
    .where(and(eq(repositories.isStarred, true), isNull(repositories.readmeExcerpt)))
    .limit(opts.readmeLimit);
  for (const repo of missing) {
    await setReadme(db, repo.id, (await getReadme(gh, repo.fullName)) ?? "");
  }

  const embedded = await embedPending(env, db, { limit: opts.embedLimit });
  return { starred: starred.length, complete, newlyUnstarred: cleared.length, readmesFetched: missing.length, embedded };
}

/** Pure, so it is unit-tested: only a complete, non-empty list may unstar anything. */
export function shouldClearMissingStars(complete: boolean, listed: number): boolean {
  return complete && listed > 0;
}

/** Star on GitHub, then record it. GitHub first: a failed star must not show as starred. */
export async function starRepository(env: Env, db: Db, repoId: number): Promise<{ fullName: string }> {
  const [repo] = await db.select({ fullName: repositories.fullName }).from(repositories).where(eq(repositories.id, repoId));
  if (!repo) throw new Error(`repository ${repoId} is not stored`);
  await starRepo(await octokit(env), repo.fullName);
  await db.update(repositories).set({ isStarred: true, starredAt: new Date(), unstarredAt: null }).where(eq(repositories.id, repoId));
  return repo;
}

export async function unstarRepository(env: Env, db: Db, repoId: number): Promise<{ fullName: string }> {
  const [repo] = await db.select({ fullName: repositories.fullName }).from(repositories).where(eq(repositories.id, repoId));
  if (!repo) throw new Error(`repository ${repoId} is not stored`);
  await unstarRepo(await octokit(env), repo.fullName);
  await db.update(repositories).set({ isStarred: false, unstarredAt: new Date() }).where(eq(repositories.id, repoId));
  return repo;
}

export async function starredIds(db: Db, ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const rows = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(inArray(repositories.id, ids), eq(repositories.isStarred, true)));
  return new Set(rows.map((r) => r.id));
}
