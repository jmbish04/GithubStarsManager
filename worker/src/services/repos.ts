/**
 * Repository rows: upsert from GitHub, embed what changed, search.
 */
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { type Db, withVectorScan } from "../db/client";
import { repositories } from "../db/schema";
import { sha256Hex } from "../lib/auth";
import type { GitHubRepo } from "../lib/github";
import { embed } from "../lib/guardian";

type RepoSource = "star_sync" | "discovery" | "research" | "manual";

/** The text that is BM25-indexed and embedded. Keep it short: bge-small reads 512 tokens. */
export function repoSearchText(repo: { fullName: string; description: string | null; topics: string[]; readmeExcerpt: string | null }): string {
  return [repo.fullName, repo.description ?? "", repo.topics.join(" "), (repo.readmeExcerpt ?? "").slice(0, 4000)]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The shorter text sent to the embedding model (~2,000 chars is ~500 tokens). */
export function repoEmbeddingText(repo: { fullName: string; description: string | null; topics: string[]; language: string | null; readmeExcerpt: string | null }): string {
  return [
    repo.fullName.replace("/", " "),
    repo.description ?? "",
    repo.language ? `Language: ${repo.language}` : "",
    repo.topics.length ? `Topics: ${repo.topics.join(", ")}` : "",
    stripMarkdown(repo.readmeExcerpt ?? "").slice(0, 1500),
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 2000);
}

export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)]\([^)]*\)/g, "$1")
    .replace(/[#>*_`|~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rowFromGitHub(repo: GitHubRepo, source: RepoSource) {
  return {
    id: repo.id,
    fullName: repo.full_name,
    name: repo.name,
    ownerLogin: repo.owner?.login ?? repo.full_name.split("/")[0],
    ownerAvatarUrl: repo.owner?.avatar_url ?? null,
    description: repo.description,
    htmlUrl: repo.html_url,
    homepage: repo.homepage ?? null,
    language: repo.language,
    topics: repo.topics ?? [],
    license: repo.license?.spdx_id ?? null,
    stargazersCount: repo.stargazers_count ?? 0,
    forksCount: repo.forks_count ?? 0,
    archived: repo.archived ?? false,
    ghCreatedAt: repo.created_at ? new Date(repo.created_at) : null,
    ghPushedAt: repo.pushed_at ? new Date(repo.pushed_at) : null,
    firstSeenSource: source,
  };
}

/**
 * Insert or refresh GitHub metadata for many repositories in one statement.
 * Never touches star state, curation fields, README or embedding: those have
 * their own writers. `first_seen_source` is kept from the first insert.
 */
export async function upsertGitHubRepos(db: Db, repos: GitHubRepo[], source: RepoSource): Promise<number> {
  if (repos.length === 0) return 0;
  const unique = [...new Map(repos.map((repo) => [repo.id, repo])).values()];
  const rows = unique.map((repo) => {
    const row = rowFromGitHub(repo, source);
    return { ...row, searchText: repoSearchText({ ...row, readmeExcerpt: null }) };
  });
  // Postgres allows 65,535 bind parameters per statement; 18 per row means chunks.
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    await upsertChunk(db, rows.slice(i, i + UPSERT_CHUNK));
  }
  return rows.length;
}

/** Rows per INSERT. 500 x 18 columns = 9,000 parameters, far below the 65,535 limit. */
export const UPSERT_CHUNK = 500;

async function upsertChunk(db: Db, rows: Array<ReturnType<typeof rowFromGitHub> & { searchText: string }>): Promise<void> {
  await db
    .insert(repositories)
    .values(rows)
    .onConflictDoUpdate({
      target: repositories.id,
      set: {
        fullName: sql`excluded.full_name`,
        name: sql`excluded.name`,
        ownerLogin: sql`excluded.owner_login`,
        ownerAvatarUrl: sql`excluded.owner_avatar_url`,
        description: sql`excluded.description`,
        htmlUrl: sql`excluded.html_url`,
        homepage: sql`excluded.homepage`,
        language: sql`excluded.language`,
        topics: sql`excluded.topics`,
        license: sql`excluded.license`,
        stargazersCount: sql`excluded.stargazers_count`,
        forksCount: sql`excluded.forks_count`,
        archived: sql`excluded.archived`,
        ghCreatedAt: sql`excluded.gh_created_at`,
        ghPushedAt: sql`excluded.gh_pushed_at`,
        // Keep the README part of the search text when one is already stored.
        searchText: sql`excluded.search_text || coalesce(' ' || left(${repositories.readmeExcerpt}, 4000), '')`,
        // A changed description or topic list means the stored vector is stale.
        contentHash: sql`case when ${repositories.description} is distinct from excluded.description
          or ${repositories.topics} is distinct from excluded.topics
          or ${repositories.language} is distinct from excluded.language
          then null else ${repositories.contentHash} end`,
        lastSyncedAt: sql`now()`,
      },
    });
}

/** Store a README excerpt and refresh the search text. */
export async function setReadme(db: Db, repoId: number, readme: string | null): Promise<void> {
  const [row] = await db
    .select({ fullName: repositories.fullName, description: repositories.description, topics: repositories.topics })
    .from(repositories)
    .where(eq(repositories.id, repoId));
  if (!row) throw new Error(`repository ${repoId} is not stored`);
  const readmeExcerpt = readme ? readme.slice(0, 6000) : null;
  await db
    .update(repositories)
    .set({
      readmeExcerpt,
      searchText: repoSearchText({ ...row, readmeExcerpt }),
      // A changed README means the stored vector is stale.
      contentHash: sql`case when ${repositories.readmeExcerpt} is distinct from ${readmeExcerpt} then null else ${repositories.contentHash} end`,
    })
    .where(eq(repositories.id, repoId));
}

/**
 * Embed repositories whose text changed since their last embedding.
 * Returns how many vectors were written. `limit` caps neurons per call.
 */
export async function embedPending(env: Env, db: Db, opts: { ids?: number[]; limit: number }): Promise<number> {
  const rows = await db
    .select({
      id: repositories.id,
      fullName: repositories.fullName,
      description: repositories.description,
      topics: repositories.topics,
      language: repositories.language,
      readmeExcerpt: repositories.readmeExcerpt,
      contentHash: repositories.contentHash,
    })
    .from(repositories)
    .where(opts.ids?.length ? inArray(repositories.id, opts.ids) : or(isNull(repositories.embedding), isNull(repositories.contentHash)))
    .limit(Math.max(opts.limit * 2, opts.limit));

  const pending: Array<{ id: number; text: string; hash: string }> = [];
  for (const row of rows) {
    const text = repoEmbeddingText(row);
    const hash = await sha256Hex(`${env.EMBEDDING_MODEL}|${text}`);
    if (hash !== row.contentHash) pending.push({ id: row.id, text, hash });
    if (pending.length >= opts.limit) break;
  }
  if (pending.length === 0) return 0;

  const vectors = await embed(env, pending.map((p) => p.text), `embed ${pending.length} repositories`);
  await db.transaction(async (tx) => {
    for (let i = 0; i < pending.length; i++) {
      await tx
        .update(repositories)
        .set({ embedding: vectors[i], contentHash: pending[i].hash, embeddedAt: new Date() })
        .where(eq(repositories.id, pending[i].id));
    }
  });
  return pending.length;
}

export type SearchMode = "semantic" | "keyword" | "hybrid";

export interface SearchHit {
  id: number;
  fullName: string;
  description: string | null;
  htmlUrl: string;
  language: string | null;
  topics: string[];
  stargazersCount: number;
  isStarred: boolean;
  score: number;
  similarity: number | null;
}

const hitColumns = {
  id: repositories.id,
  fullName: repositories.fullName,
  description: repositories.description,
  htmlUrl: repositories.htmlUrl,
  language: repositories.language,
  topics: repositories.topics,
  stargazersCount: repositories.stargazersCount,
  isStarred: repositories.isStarred,
};

/** Reciprocal-rank fusion: merge ranked lists without comparing their raw scores. */
export function reciprocalRankFusion<T extends { id: number }>(lists: T[][], k = 60): Array<T & { score: number }> {
  const scores = new Map<number, { item: T; score: number }>();
  for (const list of lists) {
    list.forEach((item, rank) => {
      const entry = scores.get(item.id) ?? { item, score: 0 };
      entry.score += 1 / (k + rank + 1);
      scores.set(item.id, entry);
    });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score).map(({ item, score }) => ({ ...item, score }));
}

export async function searchRepositories(
  env: Env,
  db: Db,
  opts: { query: string; mode: SearchMode; limit: number; starredOnly: boolean; queryVector?: number[] },
): Promise<SearchHit[]> {
  const limit = Math.min(Math.max(opts.limit, 1), 100);
  const where = opts.starredOnly ? eq(repositories.isStarred, true) : undefined;
  const pool = Math.min(limit * 3, 150);

  let semantic: SearchHit[] = [];
  if (opts.mode !== "keyword") {
    const vector = opts.queryVector ?? (await embed(env, [opts.query], "embed search query"))[0];
    const literal = `[${vector.join(",")}]`;
    const distance = sql<number>`${repositories.embedding} <=> ${literal}::vector`;
    const rows = await withVectorScan(db, (tx) =>
      tx
        .select({ ...hitColumns, distance })
        .from(repositories)
        .where(and(where, sql`${repositories.embedding} is not null`))
        .orderBy(distance)
        .limit(pool),
    );
    semantic = rows.map(({ distance: d, ...row }) => ({ ...row, similarity: 1 - Number(d), score: 1 - Number(d) }));
  }

  let keyword: SearchHit[] = [];
  if (opts.mode !== "semantic") {
    const bm25 = sql<number>`${repositories.searchText} <@> to_bm25query(${opts.query}, 'repositories_search_bm25')`;
    const rows = await db
      .select({ ...hitColumns, bm25 })
      .from(repositories)
      .where(where)
      .orderBy(bm25)
      .limit(pool);
    // pg_textsearch scores are negative (lower is better); keep only real matches.
    keyword = rows.filter((row) => Number(row.bm25) < 0).map(({ bm25, ...row }) => ({ ...row, similarity: null, score: -Number(bm25) }));
  }

  if (opts.mode === "semantic") return semantic.slice(0, limit);
  if (opts.mode === "keyword") return keyword.slice(0, limit);
  const similarityById = new Map(semantic.map((hit) => [hit.id, hit.similarity]));
  return reciprocalRankFusion([semantic, keyword])
    .slice(0, limit)
    .map((hit) => ({ ...hit, similarity: similarityById.get(hit.id) ?? null }));
}

export async function listStarredRepos(db: Db, limit: number, offset: number) {
  return db
    .select({ ...hitColumns, starredAt: repositories.starredAt, aiSummary: repositories.aiSummary, categoryId: repositories.categoryId })
    .from(repositories)
    .where(eq(repositories.isStarred, true))
    .orderBy(desc(repositories.starredAt))
    .limit(limit)
    .offset(offset);
}
