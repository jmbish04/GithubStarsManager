import { describe, it, expect } from 'vitest';
import { AIRateLimiter } from './aiRequestLimiter';

describe('AIRateLimiter', () => {
  describe('acquire/release concurrency slots', () => {
    it('allows multiple concurrent requests and returns signal after release', async () => {
      const limiter = new AIRateLimiter({ maxConcurrency: 3 });
      const r1 = await limiter.acquire();
      const r2 = await limiter.acquire();
      expect(limiter.activeRequests).toBe(2);
      r1();
      expect(limiter.activeRequests).toBe(1);
      r2();
      expect(limiter.activeRequests).toBe(0);
    });

    it('blocks when maxConcurrency is exceeded until semaphore is released', async () => {
      const limiter = new AIRateLimiter({ maxConcurrency: 1 });
      const release = await limiter.acquire();
      let acquired = false;
      const pending = limiter.acquire().then(() => { acquired = true; });
      await new Promise(r => setTimeout(r, 50));
      expect(acquired).toBe(false);
      release();
      await pending;
      expect(acquired).toBe(true);
    });
  });

  describe('RPM sliding window', () => {
    it('waits for next window when requests per minute limit is exceeded', async () => {
      const limiter = new AIRateLimiter({ requestsPerMinute: 2, rpmWindowMs: 300 });
      const r1 = await limiter.acquire();
      const r2 = await limiter.acquire();
      r1(); r2();

      const startedAt = Date.now();
      await limiter.acquire();
      const waited = Date.now() - startedAt;
      expect(waited).toBeGreaterThanOrEqual(200); // Earliest request leaves the window after ~200ms
    });
  });

  describe('concurrent admission atomicity (Promise.all)', () => {
    it('does not over-admit concurrent acquires under maxConcurrency', async () => {
      const limiter = new AIRateLimiter({ maxConcurrency: 2 });
      let peak = 0;
      let completed = 0;
      const tasks = Array.from({ length: 6 }, async () => {
        const release = await limiter.acquire();
        peak = Math.max(peak, limiter.activeRequests);
        // Return slot immediately so subsequent wait pool can proceed; peak recorded by activeRequests
        release();
        completed++;
      });

      await Promise.all(tasks);
      expect(completed).toBe(6);
      // Simultaneously occupied slots must not exceed maxConcurrency at any moment
      expect(peak).toBeLessThanOrEqual(2);
      expect(limiter.activeRequests).toBe(0);
    });

    it('does not over-admit concurrent acquires under requestsPerMinute', async () => {
      // Use 2s window and 200ms probe: with real timers, even if CI event loop hiccups,
      // the probe window is far smaller than the limit window, preventing spurious over-admission.
      const limiter = new AIRateLimiter({ requestsPerMinute: 2, rpmWindowMs: 2000 });
      let acquired = 0;
      const pending = Array.from({ length: 4 }, async () => {
        const release = await limiter.acquire();
        acquired++;
        release();
      });

      // The first two requests fill the RPM window; remaining requests must wait to leave window, not penetrate concurrently
      await new Promise(r => setTimeout(r, 200));
      expect(acquired).toBe(2);

      await Promise.all(pending);
      expect(acquired).toBe(4);
    });
  });

  describe('429 cooldown and circuit breaker', () => {
    it('opens circuit breaker after consecutive 429 threshold is reached', () => {
      const limiter = new AIRateLimiter({ cooldownThreshold: 3, backoffBaseMs: 1000 });
      limiter.notifyRateLimit();
      expect(limiter.getStatus().circuitOpen).toBe(false);
      limiter.notifyRateLimit();
      expect(limiter.getStatus().circuitOpen).toBe(false);
      limiter.notifyRateLimit();
      const status = limiter.getStatus();
      expect(status.circuitOpen).toBe(true);
      expect(status.consecutiveRateLimits).toBe(3);
      expect(status.cooldownRemainingMs).toBeGreaterThan(0);
    });

    it('notifySuccess resets consecutive 429 count', () => {
      const limiter = new AIRateLimiter({ cooldownThreshold: 2 });
      limiter.notifyRateLimit();
      limiter.notifySuccess();
      expect(limiter.getStatus().consecutiveRateLimits).toBe(0);
    });

    it('respects Retry-After: server duration acts as floor and jitter never reduces it', () => {
      const limiter = new AIRateLimiter({ maxRetryAfterMs: 60000 });
      limiter.notifyRateLimit(5000);
      // Wait must floor at the full Retry-After (5000ms), never falling below it
      expect(limiter.getStatus().cooldownRemainingMs).toBeGreaterThanOrEqual(4900);
      // And capped by backoffCap
      limiter.notifyRateLimit(999999);
      expect(limiter.getStatus().cooldownRemainingMs).toBeLessThanOrEqual(60000);
    });

    it('blocks acquire during cooldown and admits after cooldown passes', async () => {
      const limiter = new AIRateLimiter({ backoffBaseMs: 100, backoffCapMs: 1000, cooldownThreshold: 1 });
      limiter.notifyRateLimit();
      const before = Date.now();
      const release = await limiter.acquire();
      const waited = Date.now() - before;
      release();
      // Backoff 100ms * (0.75~1.25) = 75~125ms; relaxed assertion
      expect(waited).toBeGreaterThanOrEqual(50);
    });
  });

  describe('abort', () => {
    it('acquire throws AbortError when given an already-aborted signal', async () => {
      const limiter = new AIRateLimiter({ requestsPerMinute: 1, rpmWindowMs: 100000 });
      const release = await limiter.acquire();
      release();

      const controller = new AbortController();
      controller.abort();
      await expect(limiter.acquire(controller.signal)).rejects.toThrow('Aborted');
    });
  });

  describe('overlapping RPM and cooldown', () => {
    it('takes the longer duration of the two', async () => {
      // RPM window 500ms, cooldown 400ms -> final wait >= 400ms
      const limiter = new AIRateLimiter({ requestsPerMinute: 1, rpmWindowMs: 500, backoffBaseMs: 400, cooldownThreshold: 1 });
      limiter.notifyRateLimit();
      const start = Date.now();
      const release = await limiter.acquire();
      const waited = Date.now() - start;
      release();
      expect(waited).toBeGreaterThanOrEqual(300);
    });
  });

  it('getStatus exposes configuration values', () => {
    const limiter = new AIRateLimiter({ maxConcurrency: 5, requestsPerMinute: 60, cooldownThreshold: 4 });
    const s = limiter.getStatus();
    expect(s.maxConcurrency).toBe(5);
    expect(s.requestsPerMinute).toBe(60);
    expect(s.circuitOpen).toBe(false);
    expect(s.cooldownRemainingMs).toBe(0);
  });
});