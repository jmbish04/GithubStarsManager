import { logger } from './logger';

/**
 * Shared AI request rate limiter: provides unified 429/RPM handling for batch AI analysis.
 *
 * Design modeled after OpenAI / Anthropic SDKs and mature agent practices:
 * - Retry-After priority (adheres to server wait duration within sane bounds), otherwise uses jittered exponential backoff
 * - Consecutive 429s trigger global circuit-breaker cooldown: all workers pause until the cooldown window elapses
 * - Concurrency cap (semaphore) and requests per minute (RPM, 60s sliding window) for active admission control,
 *   with 0 meaning unconstrained (default)
 * - Single 429s also set a short cooldown to keep remaining workers from hammering an already rate-limited bucket
 */
export interface AIRateLimitConfig {
  /** Concurrency limit: maximum number of in-flight requests. 0 = unconstrained */
  maxConcurrency?: number;
  /** Requests per minute limit (60s sliding window). 0 = unconstrained */
  requestsPerMinute?: number;
  /** Consecutive 429 count that triggers global circuit breaker. Defaults to 3 */
  cooldownThreshold?: number;
  /** Exponential backoff base (ms). Defaults to 1000 */
  backoffBaseMs?: number;
  /** Backoff cap (ms). Defaults to 60000 */
  backoffCapMs?: number;
  /** Maximum Retry-After duration respected (ms). Defaults to 60000 */
  maxRetryAfterMs?: number;
  /** RPM statistical window (ms). Defaults to 60000; primarily used by tests to shrink window */
  rpmWindowMs?: number;
}

const RPM_WINDOW_MS = 60_000;
const WAIT_POLL_MS = 100;

const DEFAULT_CONFIG: Required<AIRateLimitConfig> = {
  maxConcurrency: 0,
  requestsPerMinute: 0,
  cooldownThreshold: 3,
  backoffBaseMs: 1000,
  backoffCapMs: 60000,
  maxRetryAfterMs: 60000,
  rpmWindowMs: RPM_WINDOW_MS,
};

function abortError(): Error {
  const e = new Error('Aborted') as Error & { name: string };
  e.name = 'AbortError';
  return e;
}

export interface AIRateLimitStatus {
  active: number;
  consecutiveRateLimits: number;
  cooldownRemainingMs: number;
  circuitOpen: boolean;
  maxConcurrency: number;
  requestsPerMinute: number;
}

export class AIRateLimiter {
  private readonly config: AIRateLimitConfig;
  private active = 0;
  private requestTimestamps: number[] = [];
  private consecutiveRateLimits = 0;
  private cooldownUntil = 0;

  constructor(config: AIRateLimitConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Call before starting request: waits for and acquires a concurrency slot (including cooldown / RPM / concurrency cap waits). */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    for (;;) {
      this.assertNotAborted(signal);
      const now = Date.now();
      const wait = this.computeWaitMs(now);
      const max = this.config.maxConcurrency ?? 0;
      // When cooldown, RPM window, and concurrency slots are all satisfied, complete admission synchronously:
      // no await between validation and slot assignment ensures atomic acquire without interleaving on a single thread.
      if (wait <= 0 && (max === 0 || this.active < max)) {
        this.active++;
        if ((this.config.requestsPerMinute ?? 0) > 0) {
          this.requestTimestamps.push(now);
          this.pruneTimestamps();
        }
        return () => {
          this.active = Math.max(0, this.active - 1);
        };
      }
      await this.sleep(wait > 0 ? wait : WAIT_POLL_MS, signal);
    }
  }

  /** Call after request succeeds: resets consecutive 429 count. */
  notifySuccess(): void {
    this.consecutiveRateLimits = 0;
  }

  /**
   * Call when 429 is encountered. Returns the number of milliseconds to wait (already written to global cooldown).
   * @param retryAfterMs Server-provided Retry-After (optional, ms)
   */
  notifyRateLimit(retryAfterMs?: number): number {
    this.consecutiveRateLimits++;
    const now = Date.now();

    let retryWait = 0;
    if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      retryWait = Math.min(retryAfterMs, this.config.maxRetryAfterMs ?? DEFAULT_CONFIG.maxRetryAfterMs);
    }

    const attempt = this.consecutiveRateLimits - 1;
    const backoff = Math.min(
      this.config.backoffCapMs ?? DEFAULT_CONFIG.backoffCapMs,
      (this.config.backoffBaseMs ?? DEFAULT_CONFIG.backoffBaseMs) * 2 ** Math.min(attempt, 6)
    );

    // Jitter applies only to local exponential backoff; server Retry-After serves as a floor and is never reduced
    const jitteredBackoff = Math.round(backoff * (0.75 + Math.random() * 0.5));
    const waitMs = Math.max(retryWait, jitteredBackoff);
    // Final wait is bounded by backoff cap to prevent a single Retry-After from stalling indefinitely
    const cappedWait = Math.min(this.config.backoffCapMs ?? DEFAULT_CONFIG.backoffCapMs, waitMs);
    this.cooldownUntil = Math.max(this.cooldownUntil, now + cappedWait);

    const threshold = this.config.cooldownThreshold ?? DEFAULT_CONFIG.cooldownThreshold;
    const circuitOpen = this.consecutiveRateLimits >= threshold;
    logger.warn('aiLimiter', 'AI rate limit notified', {
      consecutiveRateLimits: this.consecutiveRateLimits,
      waitMs,
      circuitOpen,
      cooldownMs: Math.max(0, this.cooldownUntil - now),
    });
    return cappedWait;
  }

  getStatus(): AIRateLimitStatus {
    const now = Date.now();
    const threshold = this.config.cooldownThreshold ?? DEFAULT_CONFIG.cooldownThreshold;
    return {
      active: this.active,
      requestsPerMinute: (this.config.requestsPerMinute ?? 0),
      maxConcurrency: (this.config.maxConcurrency ?? 0),
      consecutiveRateLimits: this.consecutiveRateLimits,
      cooldownRemainingMs: Math.max(0, this.cooldownUntil - now),
      circuitOpen: this.consecutiveRateLimits >= threshold,
    };
  }

  /** For metrics only: current number of in-flight requests */
  get activeRequests(): number {
    return this.active;
  }

  /** Milliseconds to wait: max(remaining cooldown, RPM release timestamp). */
  private computeWaitMs(now: number): number {
    let ms = 0;
    if (this.cooldownUntil > now) {
      ms = this.cooldownUntil - now;
    }
    const rpm = this.config.requestsPerMinute ?? 0;
    if (rpm > 0) {
      const windowMs = this.config.rpmWindowMs ?? RPM_WINDOW_MS;
      // Note: failed requests like 429s also count against requests per minute (consistent with OpenAI docs),
      // so counting is based on request start timestamp rather than success count.
      this.requestTimestamps = this.requestTimestamps.filter((ts) => ts > now - windowMs);
      if (this.requestTimestamps.length >= rpm) {
        const earliest = this.requestTimestamps[0];
        const releaseAt = earliest + windowMs;
        ms = Math.max(ms, releaseAt - now);
      }
    }
    return ms;
  }

  private pruneTimestamps(): void {
    const now = Date.now();
    const windowMs = this.config.rpmWindowMs ?? RPM_WINDOW_MS;
    this.requestTimestamps = this.requestTimestamps.filter((ts) => ts > now - windowMs);
  }

  private assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw abortError();
    }
  }

  /** Abortable polling sleep: waits up to WAIT_POLL_MS, allowing admission loop to re-evaluate conditions in chunks. */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(abortError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, Math.min(ms, WAIT_POLL_MS));
      signal?.addEventListener('abort', onAbort);
      if (signal?.aborted) onAbort();
    });
  }
}