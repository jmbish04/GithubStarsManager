/**
 * Client for the GitHub Stars Manager Worker backend (worker/ in this repo).
 *
 * Unlike the legacy Vectorize proxy, the Worker owns embeddings: it embeds repositories and queries
 * in Postgres (pgvector + pg_textsearch) through core-guardian, so the app sends text, never vectors.
 *
 *   GET  /api/search?q=&mode=&limit=   hybrid semantic + BM25 search over starred repositories
 *   POST /api/stars/sync               sync stars from GitHub, fetch READMEs, embed new rows
 *   POST /api/embeddings/backfill      embed rows that still have no vector
 *   GET  /api/repositories?limit=1     cheap authenticated probe for "test connection"
 *
 * Auth is `Authorization: Bearer <passcode>` (the Worker's WORKER_API_KEY).
 */
import type { VectorSearchConfig } from '../types';
import type { VectorQueryResult } from './vectorSearchService';

export interface WorkerRepoHit {
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

export type WorkerSearchMode = 'semantic' | 'keyword' | 'hybrid';

/** Max rows the Worker accepts per backfill call. */
export const BACKFILL_BATCH = 500;
/** Safety ceiling on backfill calls in one indexing run (500 x 40 = 20,000 repositories). */
export const MAX_BACKFILL_CALLS = 40;

type WorkerBackendConfig = Pick<VectorSearchConfig, 'workerUrl' | 'authToken'>;

/** Map a Worker hit to the shape the search UI already consumes. */
export function toVectorQueryResult(hit: WorkerRepoHit): VectorQueryResult {
  return {
    id: String(hit.id),
    // Prefer cosine similarity; keyword-only hits have none, so fall back to the fused rank score.
    score: hit.similarity ?? hit.score,
    metadata: {
      full_name: hit.fullName,
      description: hit.description ?? '',
      language: hit.language ?? '',
      stars: hit.stargazersCount,
      tags: hit.topics ?? [],
    },
  };
}

export class WorkerBackendService {
  private readonly baseUrl: string;
  private readonly authToken: string;

  constructor(config: WorkerBackendConfig) {
    this.baseUrl = config.workerUrl.replace(/\/+$/, '');
    this.authToken = config.authToken;
  }

  private async request<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      // The passcode rides on this request; never follow a redirect to another host.
      redirect: 'error',
      signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.authToken}`, ...(init.headers as Record<string, string>) },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Worker backend error ${response.status}: ${detail.slice(0, 300)}`);
    }
    return (await response.json()) as T;
  }

  async search(query: string, options: { limit?: number; mode?: WorkerSearchMode; signal?: AbortSignal } = {}): Promise<VectorQueryResult[]> {
    const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
    const params = new URLSearchParams({ q: query.slice(0, 500), mode: options.mode ?? 'hybrid', limit: String(limit) });
    const result = await this.request<{ items: WorkerRepoHit[] }>(`/api/search?${params}`, {}, options.signal);
    return (result.items ?? []).map(toVectorQueryResult);
  }

  /**
   * Sync stars on the Worker, then embed everything still missing a vector.
   * Reports progress as (embedded so far, remaining). Stops at MAX_BACKFILL_CALLS.
   */
  async syncAndEmbed(onProgress?: (embedded: number, remaining: number) => void, signal?: AbortSignal): Promise<{ starred: number; embedded: number; remaining: number }> {
    const sync = await this.request<{ starred: number; embedded: number }>('/api/stars/sync', { method: 'POST', body: JSON.stringify({}) }, signal);
    let embedded = sync.embedded ?? 0;
    let remaining = Number.POSITIVE_INFINITY;
    for (let call = 0; call < MAX_BACKFILL_CALLS && remaining > 0; call++) {
      const batch = await this.request<{ embedded: number; remaining: number }>('/api/embeddings/backfill', { method: 'POST', body: JSON.stringify({ limit: BACKFILL_BATCH }) }, signal);
      embedded += batch.embedded;
      remaining = batch.remaining;
      onProgress?.(embedded, remaining);
      if (batch.embedded === 0) break;
    }
    return { starred: sync.starred ?? 0, embedded, remaining: Number.isFinite(remaining) ? remaining : 0 };
  }

  /**
   * Repositories similar to `source`, from the caller's own list, best first. The Worker has no
   * "similar to id" route, so this searches semantically on the source's name, description and topics.
   */
  async similar<T extends { id: number }>(
    source: { id: number; full_name: string; description?: string | null; topics?: string[] | null },
    allRepos: T[],
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<T[]> {
    const text = similarityQuery(source);
    const hits = await this.search(text, { limit: Math.min((options.limit ?? 30) + 1, 100), mode: 'semantic', signal: options.signal });
    const byId = new Map(allRepos.map((repo) => [String(repo.id), repo]));
    const out: T[] = [];
    for (const hit of hits) {
      if (hit.id === String(source.id)) continue;
      const repo = byId.get(hit.id);
      if (repo) out.push(repo);
    }
    return out.slice(0, options.limit ?? 30);
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.request<{ items: unknown[] }>('/api/repositories?limit=1');
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

/** The text a "find similar" search uses: name, description and topics, capped at the route's 500 characters. */
export function similarityQuery(source: { full_name: string; description?: string | null; topics?: string[] | null }): string {
  const name = source.full_name.split('/').pop() ?? source.full_name;
  return [name, source.description ?? '', (source.topics ?? []).join(' ')].filter(Boolean).join(' ').slice(0, 500);
}

/** True when vector search is configured to use the Worker backend. */
export function usesWorkerBackend(config: Pick<VectorSearchConfig, 'backend' | 'enabled' | 'workerUrl'> | null | undefined): boolean {
  return Boolean(config?.enabled && config.workerUrl && config.backend === 'worker');
}
