/**
 * Daily discovery: search GitHub for new repositories that match your interests,
 * rank them against the centroid of your starred repositories, and put the best
 * in an inbox. Each repository enters the inbox once, ever (`discovery_items`
 * has a unique repo_id), so a reviewed repository never comes back.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { discoveryItems, discoveryRuns, interestProfiles, repositories } from "../db/schema";
import { type GitHubRepo, getReadme, isoDay, octokit, searchRepos } from "../lib/github";
import { embedPending, setReadme, upsertGitHubRepos } from "./repos";
import { starRepository } from "./stars";

export interface Profile {
  id: string | null;
  name: string;
  keywords: string[];
  topics: string[];
  languages: string[];
  minStars: number;
  freshnessDays: number;
}

/** When no profile is configured, derive one from the topics and languages you star most. */
export async function derivedProfile(db: Db): Promise<Profile | null> {
  const topics = await db.execute<{ topic: string; n: number }>(sql`
    select topic, count(*)::int as n from repositories, unnest(topics) as topic
    where is_starred group by topic order by n desc limit 8`);
  const languages = await db.execute<{ language: string; n: number }>(sql`
    select language, count(*)::int as n from repositories
    where is_starred and language is not null group by language order by n desc limit 3`);
  if (topics.length === 0 && languages.length === 0) return null;
  return {
    id: null,
    name: "Derived from your stars",
    keywords: [],
    topics: topics.map((t) => t.topic),
    languages: languages.map((l) => l.language),
    minStars: 100,
    freshnessDays: 30,
  };
}

/** GitHub search queries for one profile. Pure, so it is unit-tested. */
export function buildQueries(profile: Profile, now: Date): string[] {
  const since = isoDay(new Date(now.getTime() - profile.freshnessDays * 86_400_000));
  const base = `stars:>=${profile.minStars} created:>=${since} archived:false`;
  const languageFilter = profile.languages.length === 1 ? ` language:${quote(profile.languages[0])}` : "";
  const queries = [
    ...profile.topics.map((topic) => `topic:${quote(topic)} ${base}${languageFilter}`),
    ...profile.keywords.map((keyword) => `${quote(keyword)} in:name,description,readme ${base}${languageFilter}`),
  ];
  if (queries.length === 0 && profile.languages.length) {
    queries.push(...profile.languages.map((language) => `language:${quote(language)} ${base}`));
  }
  return [...new Set(queries)].slice(0, 12); // GitHub search allows 30 requests a minute.
}

function quote(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/"/g, "")}"` : value;
}

/** Score = cosine similarity to your stars, nudged by star count (log scale). */
export function discoveryScore(similarity: number | null, stars: number): number {
  const sim = similarity ?? 0;
  return Number((sim * 0.8 + Math.min(Math.log10(Math.max(stars, 1)) / 5, 1) * 0.2).toFixed(4));
}

/** GitHub search allows 30 requests a minute; stay well under it across all profiles. */
const MAX_QUERIES_PER_RUN = 24;

export async function runDiscovery(env: Env, db: Db, trigger: "cron" | "manual" | "api" | "mcp"): Promise<{ runId: string; candidatesSeen: number; itemsAdded: number }> {
  const [run] = await db.insert(discoveryRuns).values({ trigger }).returning({ id: discoveryRuns.id });
  try {
    const configured = await db.select().from(interestProfiles).where(eq(interestProfiles.enabled, true));
    const profiles: Profile[] = configured.length ? configured : [await derivedProfile(db)].filter((p): p is Profile => p !== null);
    if (profiles.length === 0) throw new Error("No interest profile and no starred repositories to derive one from. Sync stars or add a profile.");

    const gh = await octokit(env);
    const now = new Date();
    const found = new Map<number, { repo: GitHubRepo; query: string; profileId: string | null }>();
    const queryLog: string[] = [];
    for (const profile of profiles) {
      for (const query of buildQueries(profile, now)) {
        if (queryLog.length >= MAX_QUERIES_PER_RUN) break;
        queryLog.push(query);
        for (const repo of await searchRepos(gh, query, 20)) {
          if (!found.has(repo.id)) found.set(repo.id, { repo, query, profileId: profile.id });
        }
      }
    }

    // Drop what you already starred or already reviewed (any inbox row, read or not).
    const ids = [...found.keys()];
    const seen = ids.length
      ? await db
          .select({ id: repositories.id })
          .from(repositories)
          .leftJoin(discoveryItems, eq(discoveryItems.repoId, repositories.id))
          .where(and(inArray(repositories.id, ids), sql`(${repositories.isStarred} or ${discoveryItems.id} is not null)`))
      : [];
    const seenIds = new Set(seen.map((row) => row.id));
    const fresh = [...found.values()].filter((entry) => !seenIds.has(entry.repo.id));

    const limit = Number(env.DAILY_DISCOVERY_LIMIT);
    // Pre-rank by stars so README fetches and embeddings stay bounded.
    const shortlist = fresh.sort((a, b) => b.repo.stargazers_count - a.repo.stargazers_count).slice(0, limit * 2);
    await upsertGitHubRepos(db, shortlist.map((entry) => entry.repo), "discovery");
    for (const entry of shortlist) {
      await setReadme(db, entry.repo.id, (await getReadme(gh, entry.repo.full_name, 3000)) ?? "");
    }
    await embedPending(env, db, { ids: shortlist.map((entry) => entry.repo.id), limit: shortlist.length });

    const similarities = shortlist.length
      ? await db.execute<{ id: string; similarity: number | null }>(sql`
          with centroid as (select avg(embedding) as v from repositories where is_starred and embedding is not null)
          select r.id::text as id, case when c.v is null then null else 1 - (r.embedding <=> c.v) end as similarity
          from repositories r cross join centroid c
          where r.id in (${sql.join(shortlist.map((e) => sql`${e.repo.id}`), sql`, `)})`)
      : [];
    const simById = new Map(similarities.map((row) => [Number(row.id), row.similarity === null ? null : Number(row.similarity)]));

    const ranked = shortlist
      .map((entry) => {
        const similarity = simById.get(entry.repo.id) ?? null;
        return { ...entry, similarity, score: discoveryScore(similarity, entry.repo.stargazers_count) };
      })
      .filter((entry) => entry.score >= Number(env.DISCOVERY_MIN_SCORE))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (ranked.length) {
      await db
        .insert(discoveryItems)
        .values(
          ranked.map((entry) => ({
            repoId: entry.repo.id,
            runId: run.id,
            profileId: entry.profileId,
            score: entry.score,
            matchedQuery: entry.query,
            reason:
              entry.similarity === null
                ? `Matched "${entry.query}" with ${entry.repo.stargazers_count.toLocaleString("en-US")} stars.`
                : `Matched "${entry.query}"; ${(entry.similarity * 100).toFixed(0)}% similar to your stars; ${entry.repo.stargazers_count.toLocaleString("en-US")} stars.`,
          })),
        )
        .onConflictDoNothing({ target: discoveryItems.repoId });
    }

    await db
      .update(discoveryRuns)
      .set({ status: "succeeded", queries: queryLog, candidatesSeen: found.size, itemsAdded: ranked.length, finishedAt: new Date() })
      .where(eq(discoveryRuns.id, run.id));
    return { runId: run.id, candidatesSeen: found.size, itemsAdded: ranked.length };
  } catch (error) {
    await db
      .update(discoveryRuns)
      .set({ status: "failed", error: String((error as Error).message ?? error).slice(0, 2000), finishedAt: new Date() })
      .where(eq(discoveryRuns.id, run.id));
    throw error;
  }
}

export async function listInbox(db: Db, opts: { includeRead: boolean; limit: number }) {
  return db
    .select({
      itemId: discoveryItems.id,
      repoId: repositories.id,
      fullName: repositories.fullName,
      description: repositories.description,
      htmlUrl: repositories.htmlUrl,
      language: repositories.language,
      topics: repositories.topics,
      stargazersCount: repositories.stargazersCount,
      isStarred: repositories.isStarred,
      score: discoveryItems.score,
      reason: discoveryItems.reason,
      discoveredAt: discoveryItems.discoveredAt,
      readAt: discoveryItems.readAt,
    })
    .from(discoveryItems)
    .innerJoin(repositories, eq(repositories.id, discoveryItems.repoId))
    .where(opts.includeRead ? undefined : isNull(discoveryItems.readAt))
    .orderBy(desc(discoveryItems.score))
    .limit(opts.limit);
}

export async function markRead(db: Db, itemIds: string[]): Promise<number> {
  if (!itemIds.length) return 0;
  const rows = await db
    .update(discoveryItems)
    .set({ readAt: new Date() })
    .where(and(inArray(discoveryItems.id, itemIds), isNull(discoveryItems.readAt)))
    .returning({ id: discoveryItems.id });
  return rows.length;
}

/** Star the repository behind an inbox item, then mark the item read. */
export async function starInboxItem(env: Env, db: Db, itemId: string): Promise<{ fullName: string }> {
  const [item] = await db.select({ repoId: discoveryItems.repoId }).from(discoveryItems).where(eq(discoveryItems.id, itemId));
  if (!item) throw new Error(`inbox item ${itemId} does not exist`);
  const result = await starRepository(env, db, item.repoId);
  await db.update(discoveryItems).set({ readAt: new Date(), starredViaAppAt: new Date() }).where(eq(discoveryItems.id, itemId));
  return result;
}
