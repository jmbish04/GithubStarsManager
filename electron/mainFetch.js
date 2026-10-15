'use strict';

/**
 * Main process unified outbound request helper (shared by WebDAV, X, Telegram).
 *
 * Background: Node fetch (undici) network-layer failures are uniformly TypeError('fetch failed'),
 * while the root cause (DNS, connection refused, cert verification, connect timeout) sits on the error.cause chain;
 * furthermore, undici direct connections do not follow system proxies/system cert stores, inevitably failing
 * in common scenarios where the Chromium network stack (net.fetch) succeeds. Therefore:
 * 1. extractCauseChain / summarizeFetchError unpacks the cause chain into diagnostic text;
 * 2. fetchAcrossStacks tries multiple network stacks in sequence, treating HTTP responses (including 4xx/5xx) as success,
 *    and only attempts the next stack when an exception (network layer failure) is thrown;
 * 3. totalTimeoutMs constrains total duration across multiple stacks within caller's timeout budget.
 */

/** Collects { code, message } along error.cause chain; AggregateError merges sub-errors. */
function extractCauseChain(error, seen = new Set()) {
  const chain = [];
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const code = typeof current.code === 'string' ? current.code : undefined;
    const message = typeof current.message === 'string' ? current.message : String(current);
    chain.push({ code, message });
    // Sub-errors of AggregateError (e.g. Happy Eyeballs dual-stack dialing) live on errors;
    // seen is shared across recursion to prevent infinite loops when sub-errors reference parents.
    if (Array.isArray(current.errors)) {
      for (const sub of current.errors) {
        if (sub && typeof sub === 'object') chain.push(...extractCauseChain(sub, seen));
      }
    }
    current = current.cause;
  }
  return chain;
}

/**
 * Normalizes arbitrary exceptions into { message, causeCode, causeMessage, timedOut }.
 * message looks like "fetch failed <- ECONNREFUSED: connect ECONNREFUSED 10.0.0.5:5006",
 * with causeCode/causeMessage taken from the deepest entry on the cause chain (closest to OS).
 */
function summarizeFetchError(error) {
  const chain = extractCauseChain(error);
  const name = (error && typeof error === 'object' && typeof error.name === 'string') ? error.name : '';
  const timedOut =
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    // Covers UND_ERR_CONNECT_TIMEOUT / ETIMEDOUT / "connect timed out" etc.
    chain.some((c) => /TIMED[\s_]?OUT|TIMEOUT/i.test(c.code || '')) ||
    /timed[\s_]?out|timeout/i.test(chain.map((c) => c.message).join(' '));
  const distinct = [];
  for (const entry of chain) {
    const text = entry.code ? `${entry.code}: ${entry.message}` : entry.message;
    if (text && !distinct.includes(text)) distinct.push(text);
  }
  const deepestWithCode = [...chain].reverse().find((c) => c.code);
  return {
    message: distinct.join(' <- ') || (error instanceof Error ? error.message : String(error)),
    causeCode: deepestWithCode?.code,
    causeMessage: deepestWithCode?.message,
    timedOut,
  };
}

/**
 * Tries multiple network stacks in sequence. stacks[i] = { name, run(ctx) => Promise<Response> }.
 * ctx.remainingMs is remaining millisecond budget for this call (defined only when totalTimeoutMs is provided);
 * stacks use it to set their own AbortSignal.timeout, preventing each stack from waiting for a full timeout.
 *
 * Optional stack.onResponseRetryable(response): stack treats specific responses as "misses",
 * delegating to next stack. Used when target sites treat network stacks differently by TLS fingerprint—for example
 * x.com edge WAF returns 403 HTML challenge pages to Node network stacks (undici) while Chromium passes;
 * returning 403 as a normal response would prevent fallback from ever reaching Chromium.
 *
 * Return value: { response, stack }. Returns as soon as any stack gets an HTTP response without falling back;
 * if all stacks' responses are deemed misses, returns the last one (still a valid HTTP response).
 * If all stacks throw exceptions, throws a combined error: err.message contains failure details per stack;
 * err.timedOut is true only if all stacks timed out; err.failures retains per-stack summaries.
 */
/** Minimum budget per stack: aligns with lower bound of timeoutSignalFromBudget to guarantee staying within total budget */
const MIN_STACK_BUDGET_MS = 1000;

/** Discards unconsumed response body: undici connections require explicit cancel to return to pool immediately */
async function discardResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // Stream already cancelled/locked/does not support cancel: ignore
  }
}

async function fetchAcrossStacks(stacks, options = {}) {
  const { totalTimeoutMs } = options;
  const minStackBudgetMs = Number.isFinite(options.minStackBudgetMs)
    ? options.minStackBudgetMs
    : MIN_STACK_BUDGET_MS;
  const startedAt = Date.now();
  const failures = [];
  let retryableMiss = null;

  for (const stack of stacks) {
    let remainingMs;
    if (typeof totalTimeoutMs === 'number' && Number.isFinite(totalTimeoutMs)) {
      remainingMs = Math.trunc(totalTimeoutMs) - (Date.now() - startedAt);
      // Do not proceed to next stack if remaining budget is below minimum dial attempt
      if (remainingMs < minStackBudgetMs) break;
    }
    try {
      const response = await stack.run({ remainingMs });
      if (typeof stack.onResponseRetryable === 'function' && stack.onResponseRetryable(response)) {
        await discardResponseBody(retryableMiss?.response);
        retryableMiss = { response, stack: stack.name };
        continue;
      }
      // Subsequent stack succeeded: discard previous miss response, cancelling body to return connection
      await discardResponseBody(retryableMiss?.response);
      return { response, stack: stack.name };
    } catch (error) {
      failures.push({ name: stack.name, summary: summarizeFetchError(error) });
    }
  }

  if (retryableMiss) return retryableMiss;

  const combined = failures.map((f) => `${f.name}: ${f.summary.message}`).join('; ');
  const err = new Error(combined || 'all network stacks failed');
  err.failures = failures;
  err.timedOut = failures.length > 0 && failures.every((f) => f.summary.timedOut);
  const last = failures[failures.length - 1]?.summary;
  if (last?.causeCode) err.causeCode = last.causeCode;
  if (last?.causeMessage) err.causeMessage = last.causeMessage;
  throw err;
}

/** Constructs timeout signal from remaining budget; falls back to caller-supplied milliseconds when budget info is absent. */
function timeoutSignalFromBudget(remainingMs, fallbackMs) {
  const budget = typeof remainingMs === 'number' ? remainingMs : fallbackMs;
  return AbortSignal.timeout(Math.max(MIN_STACK_BUDGET_MS, Math.trunc(budget)));
}

/** 3xx statuses permitted for automatic following in fetch specification */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Follows redirects manually. Chromium net.fetch's redirect:'follow' does not strip
 * Authorization/Cookie headers on cross-origin redirects (verified in Electron 44),
 * violating fetch specification credential isolation—requests with credentials (WebDAV Basic)
 * must use this instead of direct follow.
 *
 * Rules align with Fetch specification: http(s) targets only; cross-origin redirects strip Authorization/Cookie;
 * 303 (and 301/302+POST) degrade to GET without body; other methods and bodies preserved.
 */
async function followRedirectsManually(fetchImpl, url, options, { maxRedirects = 10 } = {}) {
  let currentUrl = url;
  let method = options.method || 'GET';
  let body = options.body;

  for (let redirects = 0; ; redirects++) {
    const headers = { ...(options.headers ?? {}) };
    const response = await fetchImpl(currentUrl, {
      ...options,
      redirect: 'manual',
      method,
      body, // Must clear explicitly after 303/transition to GET, otherwise original body is passed through ...options
      headers,
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get('location');
    if (!location) return response;
    if (redirects >= maxRedirects - 1) {
      throw new Error(`too many redirects (limit ${maxRedirects})`);
    }

    const next = new URL(location, currentUrl);
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      throw new Error(`redirect to unsupported protocol blocked: ${next.protocol}`);
    }
    // Cross-origin redirects strip credential headers (same-origin DAV redirects like /path → /path/ unaffected)
    if (next.origin !== new URL(currentUrl).origin) {
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase();
        if (lower === 'authorization' || lower === 'cookie') delete headers[key];
      }
    }
    // 303 converts to GET; 301/302 converts POST to GET (fetch spec); other methods preserved
    const becomeGet = response.status === 303
      ? method !== 'GET' && method !== 'HEAD'
      : (response.status === 301 || response.status === 302) && method === 'POST';
    if (becomeGet) {
      method = 'GET';
      body = undefined;
      // Remove body-related Content-* headers after degrading to GET (manual redirects not cleaned automatically by fetch)
      for (const key of Object.keys(headers)) {
        if (/^content-(type|length|encoding|language|location)$/i.test(key)) delete headers[key];
      }
    }
    options = { ...options, headers, body };
    currentUrl = next.toString();
  }
}

/**
 * Normalizes fetchAcrossStacks combined errors (or other exceptions) into IPC failure return shape:
 * { success:false, timedOut, error, causeCode?, causeMessage? }
 * Used by handlers like webdav-request to pass to renderer for error code mapping in catch blocks.
 */
function toFailureResult(error) {
  const summary = error && Array.isArray(error.failures)
    ? {
        message: error.message,
        timedOut: !!error.timedOut,
        causeCode: error.causeCode,
        causeMessage: error.causeMessage,
      }
    : summarizeFetchError(error);
  return {
    success: false,
    timedOut: summary.timedOut,
    error: summary.message,
    ...(summary.causeCode ? { causeCode: summary.causeCode } : {}),
    ...(summary.causeMessage ? { causeMessage: summary.causeMessage } : {}),
  };
}

module.exports = {
  MIN_STACK_BUDGET_MS,
  extractCauseChain,
  summarizeFetchError,
  fetchAcrossStacks,
  timeoutSignalFromBudget,
  followRedirectsManually,
  toFailureResult,
};
