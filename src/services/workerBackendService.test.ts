import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AIConfig } from '../types';
import { AIService } from './aiService';
import {
  MAX_BACKFILL_CALLS,
  similarityQuery,
  toVectorQueryResult,
  usesWorkerBackend,
  WorkerBackendService,
  type WorkerRepoHit,
} from './workerBackendService';

const hit = (id: number, overrides: Partial<WorkerRepoHit> = {}): WorkerRepoHit => ({
  id,
  fullName: `owner/repo-${id}`,
  description: `repo ${id}`,
  htmlUrl: `https://github.com/owner/repo-${id}`,
  language: 'TypeScript',
  topics: ['vector'],
  stargazersCount: 10 * id,
  isStarred: true,
  score: 0.01 * id,
  similarity: 0.5 + id / 100,
  ...overrides,
});

type Recorded = { url: string; init: RequestInit };

/** Stub fetch with a queue of JSON answers and record every call. */
function stubFetch(answers: Array<{ status?: number; body: unknown }>) {
  const calls: Recorded[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (!next) throw new Error(`unexpected fetch ${calls.length}: ${url}`);
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }));
  return calls;
}

const service = () => new WorkerBackendService({ workerUrl: 'https://gsm.example.dev/', authToken: 'passcode' });

afterEach(() => vi.unstubAllGlobals());

describe('toVectorQueryResult', () => {
  it('uses cosine similarity as the score and maps the metadata the UI reads', () => {
    expect(toVectorQueryResult(hit(7, { similarity: 0.57 }))).toEqual({
      id: '7',
      score: 0.57,
      metadata: { full_name: 'owner/repo-7', description: 'repo 7', language: 'TypeScript', stars: 70, tags: ['vector'] },
    });
  });
  it('falls back to the fused rank score for keyword-only hits and to empty strings for nulls', () => {
    const result = toVectorQueryResult(hit(3, { similarity: null, description: null, language: null }));
    expect(result.score).toBe(0.03);
    expect(result.metadata.description).toBe('');
    expect(result.metadata.language).toBe('');
  });
});

describe('WorkerBackendService.search', () => {
  it('sends the text query with the passcode, never a vector, and refuses redirects', async () => {
    const calls = stubFetch([{ body: { items: [hit(1), hit(2)] } }]);
    const results = await service().search('vector database', { limit: 5 });
    expect(results.map((r) => r.id)).toEqual(['1', '2']);
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe('https://gsm.example.dev/api/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'vector database', mode: 'hybrid', limit: '5' });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer passcode');
    expect(calls[0].init.redirect).toBe('error');
    expect(calls[0].init.body).toBeUndefined();
  });
  it('clamps the limit to what the route accepts and trims the query to 500 characters', async () => {
    const calls = stubFetch([{ body: { items: [] } }, { body: { items: [] } }]);
    await service().search('x'.repeat(900), { limit: 500 });
    await service().search('y', { limit: 0 });
    expect(new URL(calls[0].url).searchParams.get('limit')).toBe('100');
    expect(new URL(calls[0].url).searchParams.get('q')).toHaveLength(500);
    expect(new URL(calls[1].url).searchParams.get('limit')).toBe('1');
  });
  it('throws with the status when the Worker refuses, so search falls back to keywords', async () => {
    stubFetch([{ status: 401, body: { error: 'Unauthorized' } }]);
    await expect(service().search('q')).rejects.toThrow(/401/);
  });
});

describe('WorkerBackendService.syncAndEmbed', () => {
  it('syncs once, then backfills until nothing remains, reporting progress', async () => {
    const calls = stubFetch([
      { body: { starred: 1200, embedded: 200 } },
      { body: { embedded: 500, remaining: 300 } },
      { body: { embedded: 300, remaining: 0 } },
    ]);
    const progress: Array<[number, number]> = [];
    const result = await service().syncAndEmbed((embedded, remaining) => progress.push([embedded, remaining]));
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/api/stars/sync', '/api/embeddings/backfill', '/api/embeddings/backfill']);
    expect(calls.every((c) => c.init.method === 'POST')).toBe(true);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ limit: 500 });
    expect(progress).toEqual([[700, 300], [1000, 0]]);
    expect(result).toEqual({ starred: 1200, embedded: 1000, remaining: 0 });
  });
  it('stops when a batch embeds nothing, instead of looping on rows that cannot embed', async () => {
    const calls = stubFetch([{ body: { starred: 10, embedded: 0 } }, { body: { embedded: 0, remaining: 4 } }]);
    const result = await service().syncAndEmbed();
    expect(calls).toHaveLength(2);
    expect(result.remaining).toBe(4);
  });
  it(`never makes more than ${MAX_BACKFILL_CALLS} backfill calls`, async () => {
    const answers = [{ body: { starred: 1, embedded: 0 } }, ...Array.from({ length: MAX_BACKFILL_CALLS + 5 }, () => ({ body: { embedded: 1, remaining: 99 } }))];
    const calls = stubFetch(answers);
    await service().syncAndEmbed();
    expect(calls).toHaveLength(1 + MAX_BACKFILL_CALLS);
  });
});

describe('WorkerBackendService.similar', () => {
  it('returns the caller\'s own repos, best first, without the source, capped at the limit', async () => {
    stubFetch([{ body: { items: [hit(1), hit(9), hit(3), hit(4)] } }]);
    const mine = [{ id: 1, name: 'a' }, { id: 3, name: 'c' }, { id: 4, name: 'd' }];
    const similar = await service().similar({ id: 1, full_name: 'owner/repo-1', description: 'x', topics: [] }, mine, { limit: 1 });
    expect(similar).toEqual([{ id: 3, name: 'c' }]);
  });
  it('builds the query from the short name, description and topics', () => {
    expect(similarityQuery({ full_name: 'pgvector/pgvector', description: 'Open-source vector search', topics: ['postgres', 'ann'] }))
      .toBe('pgvector Open-source vector search postgres ann');
  });
});

describe('usesWorkerBackend', () => {
  it('is true only when enabled, with a URL, and the backend is the Worker', () => {
    expect(usesWorkerBackend({ enabled: true, workerUrl: 'https://x', backend: 'worker' })).toBe(true);
    expect(usesWorkerBackend({ enabled: false, workerUrl: 'https://x', backend: 'worker' })).toBe(false);
    expect(usesWorkerBackend({ enabled: true, workerUrl: '', backend: 'worker' })).toBe(false);
    expect(usesWorkerBackend({ enabled: true, workerUrl: 'https://x', backend: 'vectorize' })).toBe(false);
    expect(usesWorkerBackend({ enabled: true, workerUrl: 'https://x' })).toBe(false);
    expect(usesWorkerBackend(null)).toBe(false);
  });
});

describe('AIService routing headers', () => {
  const config = (guardianRouting?: boolean): AIConfig => ({
    id: 'c', name: 'c', apiType: 'openai-compatible', baseUrl: 'https://gsm.example.dev/v1/chat/completions',
    apiKey: 'passcode', model: 'auto', isActive: true, ...(guardianRouting === undefined ? {} : { guardianRouting }),
  });

  it('sends no extra header to an ordinary endpoint, so provider CORS is unchanged', () => {
    expect(new AIService(config()).withUseCase('rag').routingHeaders()).toEqual({});
    expect(new AIService(config(false)).routingHeaders()).toEqual({});
  });
  it('sends the use case to the Worker door, defaulting to general', () => {
    expect(new AIService(config(true)).routingHeaders()).toEqual({ 'x-guardian-use-case': 'general' });
    expect(new AIService(config(true)).withUseCase('agentic').routingHeaders()).toEqual({ 'x-guardian-use-case': 'agentic' });
  });
  it('puts the header on the real chat request', async () => {
    const calls = stubFetch([{ body: { choices: [{ message: { content: 'pong' } }] } }]);
    const text = await new AIService(config(true), 'en').withUseCase('rag').generateChatText({ system: 's', user: 'u', maxTokens: 10 });
    expect(text).toBe('pong');
    expect(calls[0].url).toBe('https://gsm.example.dev/v1/chat/completions');
    expect((calls[0].init.headers as Record<string, string>)['x-guardian-use-case']).toBe('rag');
  });
});
