import { describe, it, expect, vi } from 'vitest';
import { AIAnalysisOptimizer, AnalysisTask } from './aiAnalysisOptimizer';
import type { AIService } from './aiService';
import type { GitHubApiService } from './githubApi';
import { AIRequestError } from './aiService';
import type { Repository } from '../types';

vi.mock('../store/useAppStore', () => ({
  useAppStore: { getState: () => ({ routeMode: 'auto' }) },
}));

function makeRepo(id: number): Repository {
  return {
    id,
    name: `repo-${id}`,
    full_name: `acme/repo-${id}`,
    description: null,
    html_url: `https://github.com/acme/repo-${id}`,
    stargazers_count: 0,
    forks_count: 0,
    forks: 0,
    language: 'TypeScript',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-06-01T00:00:00Z',
    pushed_at: '2024-06-01T00:00:00Z',
    owner: { login: 'owner', avatar_url: '' },
    topics: [],
  };
}

function makeTask(id: number): AnalysisTask {
  return { repo: makeRepo(id), readmeContent: '# readme', retries: 0 };
}

describe('AIAnalysisOptimizer integration with shared rate limiter', () => {
  it('records 429 in rate limiter, retries successfully after wait, and resets counter', async () => {
    const optimizer = new AIAnalysisOptimizer({
      maxRetries: 2,
      retryDelayBaseMs: 1,
      rateLimiter: {
        maxConcurrency: 0,
        requestsPerMinute: 0,
        cooldownThreshold: 3,
        backoffBaseMs: 10,
        backoffCapMs: 120,
        maxRetryAfterMs: 50,
      },
    });

    const analyze = vi.fn()
      .mockRejectedValueOnce(new AIRequestError('rate limited', 429, 200000))
      .mockResolvedValueOnce({ summary: 'ok', tags: [], platforms: [] });
    const fakeAi = { analyzeRepository: analyze } as unknown as AIService;

    const result = await optimizer.analyzeWithRetry(makeTask(1), fakeAi, []);

    expect(result.success).toBe(true);
    expect(analyze).toHaveBeenCalledTimes(2);
    // Reset consecutive 429 count upon success
    expect(optimizer.limiter.getStatus().consecutiveRateLimits).toBe(0);
  });

  it('triggers circuit breaker when consecutive 429s exceed threshold and fails after retries exhausted', async () => {
    const optimizer = new AIAnalysisOptimizer({
      maxRetries: 2,
      retryDelayBaseMs: 1,
      rateLimiter: {
        maxConcurrency: 0,
        requestsPerMinute: 0,
        cooldownThreshold: 2,
        backoffBaseMs: 5,
        backoffCapMs: 50,
        maxRetryAfterMs: 30,
      },
    });

    const analyze = vi.fn().mockRejectedValue(new AIRequestError('too many requests', 429));
    const fakeAi = { analyzeRepository: analyze } as unknown as AIService;

    const result = await optimizer.analyzeWithRetry(makeTask(2), fakeAi, []);

    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(AIRequestError);
    // 3 calls >= threshold 2 => circuit breaker opens
    expect(optimizer.limiter.getStatus().circuitOpen).toBe(true);
    expect(optimizer.limiter.getStatus().consecutiveRateLimits).toBe(3);
  });

  it('does not subject non-rate-limit errors to RateLimiter cooldown', async () => {
    const optimizer = new AIAnalysisOptimizer({
      maxRetries: 1,
      rateLimiter: { maxConcurrency: 0, requestsPerMinute: 0, cooldownThreshold: 2 },
    });

    const analyze = vi.fn()
      .mockRejectedValueOnce(new Error('some server error'))
      .mockResolvedValueOnce({ summary: 'ok', tags: [], platforms: [] });
    const fakeAi = { analyzeRepository: analyze } as unknown as AIService;

    const result = await optimizer.analyzeWithRetry(makeTask(3), fakeAi, []);

    expect(result.success).toBe(true);
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(optimizer.limiter.getStatus().consecutiveRateLimits).toBe(0);
  });

  it('immediately stops workers blocked in rate limit wait or retry delay on abort()', async () => {
    const optimizer = new AIAnalysisOptimizer({
      maxRetries: 3,
      retryDelayBaseMs: 10000,
      rateLimiter: {
        maxConcurrency: 0,
        requestsPerMinute: 0,
        cooldownThreshold: 1,
        backoffBaseMs: 10000,
        backoffCapMs: 10000,
        maxRetryAfterMs: 10000,
      },
    });

    const analyze = vi.fn().mockRejectedValue(new AIRequestError('too many requests', 429));
    const fakeAi = { analyzeRepository: analyze } as unknown as AIService;

    // The first task hits a 429 and enters a long retry delay; the second task blocks on limiter acquire
    const first = optimizer.analyzeWithRetry(makeTask(4), fakeAi, []);
    const second = optimizer.analyzeWithRetry(makeTask(5), fakeAi, []);

    // Give both tasks time to enter blocked states, then abort the entire batch
    await new Promise(r => setTimeout(r, 100));
    const start = Date.now();
    optimizer.abort();

    const [r1, r2] = await Promise.all([first, second]);
    const elapsed = Date.now() - start;

    // abort should cut through cooldown wait / retry delay immediately (total configured duration was 10s)
    expect(elapsed).toBeLessThan(500);
    expect(r1.success).toBe(false);
    expect(r1.error?.message).toBe('Analysis aborted');
    expect(r2.success).toBe(false);
    expect(r2.error?.message).toBe('Analysis aborted');
  });

  it('immediately terminates the pipeline on abort(), even if README requests are in flight', async () => {
    const optimizer = new AIAnalysisOptimizer({
      maxRetries: 0,
      rateLimiter: { maxConcurrency: 0, requestsPerMinute: 0 },
    });

    const analyze = vi.fn().mockResolvedValue({ summary: 'ok', tags: [], platforms: [] });
    const fakeAi = { analyzeRepository: analyze } as unknown as AIService;

    // README fetch stays pending until the batch abort signal is received: verifies signal propagates to request API
    let resolveReadmeStarted = () => {};
    const readmeStarted = new Promise<void>(resolve => {
      resolveReadmeStarted = resolve;
    });
    const readmeAborted = vi.fn();
    const githubApi = {
      getRepositoryReadme: vi.fn((_owner: string, _repo: string, signal?: AbortSignal) => {
        resolveReadmeStarted();
        return new Promise<string>((_resolve, reject) => {
          const onAbort = () => {
            readmeAborted();
            reject(new Error('Aborted'));
          };
          if (!signal) {
            reject(new Error('Missing AbortSignal'));
          } else if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener('abort', onAbort, { once: true });
          }
        });
      }),
    } as unknown as GitHubApiService;

    const pending = optimizer.analyzeRepositoriesPipelined(
      [makeRepo(6), makeRepo(7)], githubApi, fakeAi, []);

    // Wait until README request actually starts before aborting the batch, avoiding race conditions with fixed delays
    await readmeStarted;
    const start = Date.now();
    optimizer.abort();
    await pending;

    expect(Date.now() - start).toBeLessThan(500);
    expect(githubApi.getRepositoryReadme).toHaveBeenCalled();
    // Assert that the README request actually received the abort signal, rather than the pipeline returning early and leaving it hung
    expect(readmeAborted).toHaveBeenCalled();
  });
});