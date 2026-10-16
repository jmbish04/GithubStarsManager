/**
 * Vector semantic search service
 *
 * 1. EmbeddingClient — invokes user-configured Embedding API to generate vectors
 * 2. VectorSearchService — communicates with Cloudflare Worker (store/query/delete vectors)
 */

import type { EmbeddingConfig, VectorSearchConfig, Repository, VectorIndexMode } from '../types';
import { NO_LICENSE_SENTINEL, normalizeLicense } from '../utils/licenseFilter';

// ============================================================
// EmbeddingClient
// ============================================================

export class EmbeddingClient {
  constructor(private config: EmbeddingConfig) {}

  /**
   * Batch generate embedding vectors
   * @param purpose 'document' for indexing, 'query' for search queries
   */
  async embed(texts: string[], purpose: 'document' | 'query' = 'document', signal?: AbortSignal): Promise<number[][]> {
    switch (this.config.apiType) {
      case 'openai':
      case 'openai-compatible':
      case 'siliconflow':
        return this.embedOpenAICompatible(texts, signal);
      case 'ollama':
        return this.embedOllama(texts, signal);
      case 'gemini':
        return this.embedGemini(texts, purpose, signal);
      case 'cohere':
        return this.embedCohere(texts, purpose, signal);
      default:
        throw new Error(`Unsupported embedding API type: ${this.config.apiType}`);
    }
  }

  /**
   * Test connection: sends a single text to verify returned vector dimensions
   */
  async testConnection(): Promise<{ success: boolean; dimensions: number; error?: string }> {
    try {
      const vectors = await this.embed(['hello']);
      if (!vectors || vectors.length === 0 || !Array.isArray(vectors[0])) {
        return { success: false, dimensions: 0, error: 'Invalid response format' };
      }
      return { success: true, dimensions: vectors[0].length };
    } catch (error) {
      return {
        success: false,
        dimensions: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ----------------------------------------------------------
  // OpenAI / OpenAI-compatible
  // POST /v1/embeddings  or  custom URL
  // ----------------------------------------------------------
  private async embedOpenAICompatible(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const url =
      this.config.apiType === 'openai' || this.config.apiType === 'siliconflow'
        ? `${this.config.baseUrl.replace(/\/+$/, '')}/v1/embeddings`
        : this.config.baseUrl;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: this.config.model, input: texts }),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Embedding API error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    // OpenAI format: { data: [{ embedding: [...], index: 0 }] }
    return data.data
      .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
      .map((d: { embedding: number[] }) => d.embedding);
  }

  // ----------------------------------------------------------
  // Ollama local model
  // POST /api/embed
  // ----------------------------------------------------------
  private async embedOllama(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/api/embed`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.config.model, input: texts }),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Ollama API error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    // Ollama format: { embeddings: [[...], [...]] }
    return data.embeddings;
  }

  // ----------------------------------------------------------
  // Google Gemini
  // POST /v1beta/models/{model}:batchEmbedContents
  // ----------------------------------------------------------
  private async embedGemini(texts: string[], purpose: 'document' | 'query' = 'document', signal?: AbortSignal): Promise<number[][]> {
    const baseUrl = this.config.baseUrl.replace(/\/+$/, '');
    const url = `${baseUrl}/v1beta/models/${this.config.model}:batchEmbedContents?key=${this.config.apiKey}`;
    const taskType = purpose === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${this.config.model}`,
          content: { parts: [{ text }] },
          taskType,
        })),
      }),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Gemini API error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    return data.embeddings.map((e: { values: number[] }) => e.values);
  }

  // ----------------------------------------------------------
  // Cohere
  // POST /v1/embed
  // ----------------------------------------------------------
  private async embedCohere(texts: string[], purpose: 'document' | 'query' = 'document', signal?: AbortSignal): Promise<number[][]> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/v1/embed`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        texts,
        input_type: purpose === 'query' ? 'search_query' : 'search_document',
      }),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Cohere API error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    return data.embeddings;
  }
}

// ============================================================
// VectorSearchService — communicates with Cloudflare Worker
// ============================================================

// Vectorize V2 limit: topK is capped at 50 when returnMetadata returns metadata.
// Worker /query similarly clamps topK to 50; kept consistent here to prevent requests from being silently truncated.
export const VECTORIZE_QUERY_TOPK_LIMIT = 50;

export interface VectorizeVector {
  id: string;
  values: number[];
  metadata: {
    full_name: string;
    description: string;
    language: string;
    stars: number;
    tags: string[];
    // Optional: vectors indexed before this PR (embedding v2) lacked the license key and appear as undefined until reindexed.
    // indexAllRepos populates a string on write; consumers should treat as optional.
    license?: string;
  };
}

export interface VectorQueryResult {
  id: string;
  score: number;
  metadata: {
    full_name: string;
    description: string;
    language: string;
    stars: number;
    tags: string[];
    // Same as above: legacy vector queries omit this key, treat as optional.
    license?: string;
  };
}

export interface VectorizeStatus {
  vectorCount: number;
  dimensions: number;
  indexName?: string;
}

type VectorSearchServiceConfig = Pick<VectorSearchConfig, 'workerUrl' | 'authToken'>;

export class VectorSearchService {
  private workerUrl: string;
  private authToken: string;

  constructor(config: VectorSearchServiceConfig) {
    this.workerUrl = config.workerUrl.replace(/\/+$/, '');
    this.authToken = config.authToken;
  }

  private async request<T>(path: string, options: RequestInit = {}, signal?: AbortSignal): Promise<T> {
    const url = `${this.workerUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.authToken}`,
      ...(options.headers as Record<string, string>),
    };

    const response = await fetch(url, { ...options, headers, signal });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Worker error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    if (data.success === false) {
      throw new Error(data.error || 'Unknown worker error');
    }
    return data as T;
  }

  /**
   * Batch upsert vectors to Vectorize
   */
  async upsert(vectors: VectorizeVector[], signal?: AbortSignal): Promise<{ upserted: number }> {
    return this.request<{ upserted: number }>('/upsert', {
      method: 'POST',
      body: JSON.stringify({ vectors }),
    }, signal);
  }

  /**
   * Query vector similarity
   */
  async query(
    vector: number[],
    options: { topK?: number; threshold?: number } = {},
    signal?: AbortSignal,
  ): Promise<VectorQueryResult[]> {
    const { topK = 20, threshold = 0.35 } = options;
    const result = await this.request<{ matches: VectorQueryResult[] }>('/query', {
      method: 'POST',
      body: JSON.stringify({ vector, topK, threshold }),
    }, signal);
    return result.matches;
  }

  /**
   * Delete vectors by IDs
   */
  async delete(ids: string[], signal?: AbortSignal): Promise<{ deleted: number }> {
    return this.request<{ deleted: number }>('/delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }, signal);
  }

  /**
   * Clean up vectors not in keepIds list (delete unstarred repositories)
   */
  async cleanup(keepIds: string[], signal?: AbortSignal): Promise<{ deleted: number }> {
    return this.request<{ deleted: number }>('/cleanup', {
      method: 'POST',
      body: JSON.stringify({ keepIds }),
    }, signal);
  }

  /**
   * Get index status
   */
  async getStatus(): Promise<VectorizeStatus> {
    return this.request<VectorizeStatus>('/status');
  }

  /**
   * Test Worker connectivity
   */
  async testConnection(): Promise<{ success: boolean; vectorCount: number; dimensions: number; error?: string }> {
    try {
      const status = await this.getStatus();
      return {
        success: true,
        vectorCount: status.vectorCount,
        dimensions: status.dimensions,
      };
    } catch (error) {
      return {
        success: false,
        vectorCount: 0,
        dimensions: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ============================================================
// Utility functions
// ============================================================

/**
 * Embedding text format version.
 * Must be incremented when buildEmbeddingText output format changes,
 * allowing incremental indexing to detect format changes and force reindexing of all vectors.
 */
export const EMBEDDING_FORMAT_VERSION = 3;

/**
 * Concatenate repository text for embedding
 * @param repo Repository data
 * @param readmeContent README content (optional)
 * @param maxChars Maximum characters from README, default 6000
 */
export function buildEmbeddingText(repo: Repository, readmeContent?: string, maxChars = 6000): string {
  const parts: string[] = [];

  // Structured field labels help embedding model understand field roles and weights
  if (repo.full_name) parts.push(`Repository: ${repo.full_name}`);

  // Deduplication: skip shorter description when description and ai_summary overlap
  const description = repo.description || '';
  const aiSummary = repo.ai_summary || '';
  const customDesc = repo.custom_description || '';

  if (description && !aiSummary.includes(description)) {
    parts.push(`Description: ${description}`);
  }
  if (customDesc) parts.push(`About: ${customDesc}`);
  if (aiSummary) parts.push(`Summary: ${aiSummary}`);

  // Merge topics and tags, deduplicate
  const allTopics = [...new Set([
    ...(repo.topics || []),
    ...(repo.ai_tags || []),
    ...(repo.custom_tags || []),
  ])];
  if (allTopics.length > 0) parts.push(`Topics: ${allTopics.join(', ')}`);

  if (repo.language) parts.push(`Language: ${repo.language}`);
  // Open source license: normalize first to avoid raw GitHub objects becoming "[object Object]" and polluting embedding;
  // sentinels (none/unspecified) are omitted, maintaining identical semantics with null/missing.
  {
    const lic = normalizeLicense(repo.license);
    if (lic !== NO_LICENSE_SENTINEL) parts.push(`License: ${lic}`);
  }

  // README content provides the richest semantic information
  if (readmeContent) {
    const cleaned = readmeContent
      .replace(/\[!\[.*?\]\(.*?\)\]\(.*?\)/g, '') // Remove link badges [![...](...)](...) — must precede images
      .replace(/!\[.*?\]\(.*?\)/g, '') // Remove images/badges ![...](...)
      .replace(/<[^>]+>/g, ' ') // Remove HTML tags
      .replace(/\n{3,}/g, '\n\n') // Collapse extra blank lines
      .trim();
    const truncated = cleaned.slice(0, maxChars);
    if (truncated) parts.push(`README:\n${truncated}`);
  }
  return parts.join('\n');
}

/**
 * Determines whether a single repository needs vector reindexing (authoritative implementation of incremental predicate).
 *
 * Considered needing reindexing if any of the following hold:
 *  - Never indexed (`vector_indexed_at` missing);
 *  - Embedding format version upgraded (passed in via `formatVersionChanged` by caller);
 *  - Content timestamp (newer of `last_edited` and `analyzed_at`) is later than last index time;
 *  - License changed (compares normalized `vector_indexed_license` with `license`).
 *
 * This module's predicate must stay consistent with `VectorSearchSettings.tsx` `unindexedCount` / `attemptedCount`,
 * so it is extracted as an export for reuse to prevent drift across three copies.
 */
export function needsReindex(repo: Pick<Repository, 'last_edited' | 'analyzed_at' | 'license' | 'vector_indexed_at' | 'vector_indexed_license'>, formatVersionChanged: boolean): boolean {
  if (!repo.vector_indexed_at) return true; // Never indexed
  if (formatVersionChanged) return true; // Format version upgrade, requires reindexing
  // Use newer of last_edited and analyzed_at as content timestamp; updates require reindexing
  const contentTime = [repo.last_edited, repo.analyzed_at]
    .filter((t): t is string => !!t)
    .sort()
    .pop() || '';
  if (contentTime > repo.vector_indexed_at) return true;
  // License change (compared after normalization): GitHub sync may update only license while last_edited remains unchanged,
  // making vector metadata and the License field in embedding text stale, requiring reindexing.
  return normalizeLicense(repo.vector_indexed_license ?? null) !== normalizeLicense(repo.license ?? null);
}

/**
 * Full / incremental vector index rebuild.
 * Iterates through analyzed repositories, generates embeddings in batches, and upserts them to Worker.
 * @param readmeFetcher Optional: function to fetch repository README content (owner, repo) => content
 */
export interface IndexProgress {
  phase: 'readme' | 'embedding' | 'uploading';
  done: number;
  total: number;
}

/**
 * Determines whether an embedding error is an "input too long" error (e.g. SiliconFlow 20015).
 * Characteristic of these errors: a single item in a batch exceeding token limit causes the entire batch to fail;
 * degrading to per-item embedding isolates the item that actually exceeded the limit.
 * Matches only explicit length/token keywords to avoid misclassifying generic 400/configuration errors as retryable.
 */
export function looksLikeLengthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /\b20015\b/.test(msg) ||
    /input length/i.test(msg) ||
    /maximum token/i.test(msg) ||
    /token limit/i.test(msg) ||
    /too long/i.test(msg)
  );
}

/**
 * Truncates text, preserving a minimum threshold of 256 characters.
 */
export function truncateForRetry(text: string, maxChars: number): string {
  return text.slice(0, Math.max(256, Math.min(text.length, maxChars)));
}

/**
 * Batch embed with per-item failure isolation + truncation retry.
 * - Fast path: single batch call, fast.
 * - If batch throws a "length" error: degrade to per-item embed, failing only the item that exceeded the limit.
 * - Non-length errors (auth/5xx/network): rethrow directly for upper-layer entire batch failure handling.
 * Returns sparse array: vector at successful indices, null at completely failed indices.
 */
export async function embedWithFallback(
  texts: string[],
  embeddingClient: EmbeddingClient,
  signal: AbortSignal | undefined,
  retryMaxChars: number
): Promise<(number[] | null)[]> {
  // Fast path: try entire batch
  try {
    if (signal?.aborted) throw new Error('Aborted');
    const vectors = await embeddingClient.embed(texts, 'document', signal);
    if (Array.isArray(vectors) && vectors.length >= texts.length) {
      return vectors.slice(0, texts.length);
    }
    throw new Error(`Embedding API returned ${vectors?.length ?? 0} vectors for ${texts.length} texts`);
  } catch (err) {
    if (signal?.aborted || (err instanceof Error && err.message === 'Aborted')) {
      throw new Error('Aborted');
    }
    // Degrade to per-item only for "length" errors; other errors fail the whole batch
    if (!looksLikeLengthError(err)) {
      throw err;
    }
  }

  // Slow path: per-item embed, retry with truncation if single item exceeds limit
  const results: (number[] | null)[] = new Array(texts.length).fill(null);
  for (let i = 0; i < texts.length; i++) {
    if (signal?.aborted) throw new Error('Aborted');
    const original = texts[i];
    // Truncation retry ladder: strictly decreasing steps, lower bound 256
    const firstLimit = Math.max(256, Math.min(retryMaxChars, Math.floor(original.length / 2)));
    const secondLimit = Math.max(256, Math.floor(firstLimit / 2));
    const candidates = [
      original,
      truncateForRetry(original, firstLimit),
      truncateForRetry(original, secondLimit),
    ].filter((c, idx, arr) => idx === 0 || c.length < (arr[idx - 1]?.length ?? Infinity));
    let succeeded = false;
    for (const candidate of candidates) {
      if (!candidate) { succeeded = true; break; } // Skip empty text directly
      try {
        const v = await embeddingClient.embed([candidate], 'document', signal);
        if (Array.isArray(v) && v.length === 1 && Array.isArray(v[0])) {
          results[i] = v[0];
          succeeded = true;
          break;
        }
      } catch (err) {
        if (signal?.aborted || (err instanceof Error && err.message === 'Aborted')) {
          throw new Error('Aborted');
        }
        // Still length error -> try shorter candidate; non-length error (5xx/network/auth) throws immediately
        if (!looksLikeLengthError(err)) {
          throw err;
        }
      }
    }
    if (!succeeded) {
      results[i] = null;
    }
  }
  return results;
}

export async function indexAllRepos(
  repos: Repository[],
  embeddingClient: EmbeddingClient,
  vectorService: VectorSearchService,
  options: {
    batchSize?: number;
    onProgress?: (progress: IndexProgress) => void;
    signal?: AbortSignal;
    readmeFetcher?: (owner: string, repo: string, signal?: AbortSignal) => Promise<string>;
    indexMode?: 'description' | 'readme';
    readmeMaxChars?: number;
    incremental?: boolean;
    onRepoIndexed?: (repoId: number) => void;
    /** Currently stored format version */
    formatVersion?: number;
    /** Latest format version (EMBEDDING_FORMAT_VERSION) */
    currentFormatVersion?: number;
  } = {}
): Promise<{ indexed: number; skipped: number; errors: number; error?: string; indexedRepoIds: number[] }> {
  const { batchSize = 32, onProgress, signal, readmeFetcher, indexMode = 'readme', readmeMaxChars = 6000, incremental, onRepoIndexed } = options;

  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error('batchSize must be a positive integer');
  }

  // Only index analyzed repos that have not failed
  let indexable = repos.filter((r) => r.analyzed_at && !r.analysis_failed);
  // In incremental mode, skip indexed repos whose content has not updated
  if (incremental) {
    // When embedding text format version changes, force reindexing all vectors to prevent mixed formats
    // Missing version is treated as v1 (legacy format), still requiring an upgrade
    const formatVersionChanged = (options.formatVersion ?? 1) < (options.currentFormatVersion ?? EMBEDDING_FORMAT_VERSION);
    indexable = indexable.filter((r) => needsReindex(r, formatVersionChanged));
  }
  let indexed = 0;
  let errors = 0;
  let lastError = '';
  const indexedRepoIds: number[] = [];

  // Fetch README content only in readme mode
  const shouldFetchReadme = indexMode === 'readme' && readmeFetcher;
  const readmeCache = new Map<string, string>();
  if (shouldFetchReadme) {
    const CONCURRENCY = 5;
    let completed = 0;

    for (let i = 0; i < indexable.length; i += CONCURRENCY) {
      if (signal?.aborted) throw new Error('Aborted');

      const batch = indexable.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (repo) => {
          const [owner, name] = repo.full_name.split('/');
          const readme = await readmeFetcher(owner, name, signal);
          return { fullName: repo.full_name, readme };
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.readme) {
          readmeCache.set(result.value.fullName, result.value.readme);
        }
      }

      completed = Math.min(completed + batch.length, indexable.length);
      onProgress?.({ phase: 'readme', done: completed, total: indexable.length });
    }
  }

  const totalBatches = Math.ceil(indexable.length / batchSize);
  for (let i = 0; i < indexable.length; i += batchSize) {
    if (signal?.aborted) {
      throw new Error('Aborted');
    }

    const batch = indexable.slice(i, i + batchSize);
    const texts = batch.map(repo => buildEmbeddingText(repo, readmeCache.get(repo.full_name), readmeMaxChars));

    try {
      // 1. Call Embedding API to generate vectors (with per-item failure isolation + truncation retry)
      //    Length errors (e.g. SiliconFlow 20015) degrade to per-item embed to avoid failing entire batch
      const vectors = await embedWithFallback(texts, embeddingClient, signal, readmeMaxChars);

      // 2. Assemble Vectorize format for successful items (skip null failed items)
      const vectorizeVectors: VectorizeVector[] = [];
      let batchErrors = 0;
      for (let j = 0; j < batch.length; j++) {
        const vec = vectors[j];
        if (vec && Array.isArray(vec)) {
          vectorizeVectors.push({
            id: String(batch[j].id),
            values: vec,
            metadata: {
              full_name: batch[j].full_name,
              description: batch[j].description || '',
              language: batch[j].language || '',
              stars: batch[j].stargazers_count || 0,
              tags: batch[j].ai_tags || [],
              // Legacy/imported data license may be a GitHub object or number; normalized via normalizeLicense
              // down to SPDX id / sentinel to avoid writing "[object Object]" into vector metadata.
              license: normalizeLicense(batch[j].license),
            },
          });
        } else {
          batchErrors++;
        }
      }

      // 3. Upsert to Worker (only when there are successful vectors)
      //    Vectorize upsert is atomic, but counting via returned upserted count is more rigorous
      const currentBatch = Math.floor(i / batchSize) + 1;
      if (vectorizeVectors.length > 0) {
        onProgress?.({ phase: 'uploading', done: currentBatch, total: totalBatches });
        const upsertResult = await vectorService.upsert(vectorizeVectors, signal);
        const upsertedCount = typeof upsertResult?.upserted === 'number'
          ? Math.min(upsertResult.upserted, vectorizeVectors.length)
          : vectorizeVectors.length;
        indexed += upsertedCount;
        // Only mark repos confirmed upserted (in order)
        for (let j = 0; j < upsertedCount; j++) {
          const repoId = parseInt(vectorizeVectors[j].id, 10);
          indexedRepoIds.push(repoId);
          onRepoIndexed?.(repoId);
        }
        // If worker returns fewer upserted than sent, record difference in errors
        const notUpserted = vectorizeVectors.length - upsertedCount;
        if (notUpserted > 0) {
          batchErrors += notUpserted;
        }
      }
      if (batchErrors > 0) {
        errors += batchErrors;
        lastError = `${batchErrors} text(s) failed embedding (likely over token limit)`;
      }
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.message === 'Aborted')) {
        throw new Error('Aborted');
      }
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`Batch ${i}-${i + batch.length} failed:`, err);
      errors += batch.length;
    }

    const currentBatch = Math.floor(i / batchSize) + 1;
    onProgress?.({ phase: 'embedding', done: currentBatch, total: totalBatches });
  }

  return { indexed, skipped: repos.length - indexable.length, errors, error: lastError || undefined, indexedRepoIds };
}

/**
 * Find repositories semantically similar to source repository.
 *
 * Flow:
 * 1. Build source repository text and embed (purpose='query')
 * 2. Call Worker's /query endpoint to get list of similar vector IDs
 * 3. Map back to Repository from full repository list, filtering out source repository itself
 *
 * @returns Array of similar repositories (in descending similarity order, excluding source repository)
 */
export async function findSimilarRepositories(
  sourceRepo: Repository,
  opts: {
    embeddingClient: EmbeddingClient;
    vectorService: VectorSearchService;
    allRepos: Repository[];
    topK: number;
    threshold: number;
    /** Fetches the source README when the index itself was built in README mode. */
    readmeFetcher?: (owner: string, repo: string, signal?: AbortSignal) => Promise<string>;
    indexMode?: VectorIndexMode;
    readmeMaxChars?: number;
    signal?: AbortSignal;
  }
): Promise<Repository[]> {
  const {
    embeddingClient,
    vectorService,
    allRepos,
    topK,
    threshold,
    readmeFetcher,
    indexMode = 'readme',
    readmeMaxChars = 6000,
    signal,
  } = opts;

  // An index created from README-enriched documents must be queried with the same
  // representation. Embedding only the card metadata made the source vector a
  // different semantic object from every indexed repository and caused relevance
  // to collapse for feature-rich repositories.
  let sourceReadme = '';
  if (indexMode === 'readme' && readmeFetcher) {
    const [owner, repo] = sourceRepo.full_name.split('/');
    if (owner && repo) {
      try {
        sourceReadme = await readmeFetcher(owner, repo, signal);
      } catch {
        // README enrichment improves quality but must not make a usable vector
        // index unavailable. The metadata representation remains a safe fallback.
        sourceReadme = '';
      }
    }
  }

  // 1. Generate the source query vector from the same text schema and truncation
  // policy used during index construction.
  const text = buildEmbeddingText(sourceRepo, sourceReadme, readmeMaxChars);
  const vectors = await embeddingClient.embed([text], 'query', signal);
  if (!vectors || vectors.length === 0 || !Array.isArray(vectors[0])) {
    throw new Error('Failed to generate embedding for source repository');
  }
  const queryVector = vectors[0];

  // 2. Over-fetch modestly so the source vector, stale IDs, or duplicate matches
  // cannot consume the user's requested result count. Results are then restored to
  // the worker's explicit cosine score order below.
  const requestedTopK = Math.min(Math.max(topK + 8, topK + 1), VECTORIZE_QUERY_TOPK_LIMIT);
  const matches = await vectorService.query(queryVector, { topK: requestedTopK, threshold }, signal);

  // 3. Map valid local repositories and sort explicitly by the worker's score.
  // Relying on incidental response order makes card results change when a Worker
  // implementation, metadata filter, or stale vector changes its output order.
  const repoById = new Map<number, Repository>();
  for (const repo of allRepos) repoById.set(repo.id, repo);

  const sourceId = String(sourceRepo.id);
  const bestMatchById = new Map<string, { repo: Repository; score: number }>();
  for (const match of matches) {
    if (match.id === sourceId) continue;
    const repositoryId = Number(match.id);
    if (!Number.isInteger(repositoryId)) continue;
    const matchedRepository = repoById.get(repositoryId);
    if (!matchedRepository) continue;
    const score = Number.isFinite(match.score) ? match.score : Number.NEGATIVE_INFINITY;
    const current = bestMatchById.get(match.id);
    if (!current || score > current.score) bestMatchById.set(match.id, { repo: matchedRepository, score });
  }
  return Array.from(bestMatchById.values())
    .sort((left, right) => right.score - left.score || left.repo.full_name.localeCompare(right.repo.full_name))
    .slice(0, Math.max(1, topK))
    .map(({ repo }) => repo);
}
