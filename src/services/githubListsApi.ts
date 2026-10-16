import { logger } from './logger';
import { createCombinedAbortController } from '../utils/abortUtils';

const GITHUB_GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';

/**
 * Concurrency limit for fetching items across lists in stage two.
 * Value balances parallel throughput against secondary rate limits on GitHub GraphQL
 * (tested: concurrency of 6 triggered 503s during certain periods).
 * Combined with exponential backoff on 5xx / rate limits in request to absorb transient overload.
 */
const LIST_ITEMS_CONCURRENCY = 3;

/**
 * Controlled concurrency mapping: invokes mapper on each element in items with at most concurrency executions in flight,
 * preserving input ordering. Any mapper error is re-thrown (fail-fast semantics matching the original sequential
 * implementation—failure to fetch any single list fails the sync run).
 * Supports AbortSignal: if signal is aborted, immediately throws AbortError; in-flight requests will still
 * complete (fetch aborts via its own signal).
 */
async function mapPool<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  concurrency: number,
  signal?: AbortSignal
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      if (signal?.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  };
  const workers: Promise<void>[] = [];
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/**
 * Marks transient, retryable errors. Captured by the outer backoff loop in request for retrying.
 * retryAfterMs takes precedence (from Retry-After header); otherwise uses exponential backoff.
 */
class RetriableError extends Error {
  readonly retryAfterMs?: number;
  /** Whether the failure originated from the proxy layer itself (proxy network failure / non-JSON 5xx / 5xx with backend code/details),
   *  rather than a transient error forwarded from GitHub (rate limit, upstream 5xx). Only proxy layer failures switch to sticky direct connection:
   *  transient GitHub errors forwarded by a healthy proxy would also occur directly and should not permanently bypass the proxy. */
  readonly proxyLayerFailure: boolean;
  constructor(message: string, retryAfterMs?: number, proxyLayerFailure = false) {
    super(message);
    this.name = 'RetriableError';
    this.retryAfterMs = retryAfterMs;
    this.proxyLayerFailure = proxyLayerFailure;
  }
}

/**
 * Backend proxy returned "GitHub token not configured" (400 GITHUB_TOKEN_NOT_CONFIGURED).
 * The frontend always holds a token; switch to direct connection mode to retry without backoff delay.
 */
class BackendTokenMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackendTokenMissingError';
  }
}

export interface GitHubList {
  id: string;
  name: string;
  description?: string;
  isPrivate: boolean;
  /** Set of repository full_names in this list */
  items: string[];
}

export interface GitHubListSummary {
  id: string;
  name: string;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message?: string; type?: string; extensions?: { code?: string } }>;
}

type UserListNode = {
  id: string;
  name: string;
  description: string | null;
  isPrivate: boolean;
};

type UserListsPage = {
  user: {
    lists: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<UserListNode | null> | null;
    };
  } | null;
};

type UserListItemsPage = {
  node: {
    items: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{ __typename?: string; id?: string; nameWithOwner?: string } | null> | null;
    };
  } | null;
};

type UserListSummariesPage = {
  user: {
    lists: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<GitHubListSummary | null> | null;
    };
  } | null;
};

/** Response body when backend proxy /api/proxy/github/* fails (proxyService fallback and upstream error pass-through). */
interface BackendProxyErrorBody {
  error?: string;
  code?: string;
  details?: string;
}

/** Extract backend proxy diagnostic info from response body (outputs if either code or details exists; empty string otherwise). */
function buildProxyDiagnostics(payload: unknown): string {
  const proxyErr = payload as Partial<BackendProxyErrorBody>;
  const parts: string[] = [];
  if (proxyErr.code) parts.push(proxyErr.code);
  if (typeof proxyErr.details === 'string' && proxyErr.details) parts.push(proxyErr.details);
  return parts.length > 0 ? ` (backend proxy: ${parts.join(': ')})` : '';
}

/**
 * GitHub Lists GraphQL client.
 *
 * Supports two request modes:
 * - With backend proxy: POST {backendUrl}/proxy/github/graphql, where the server reads the encrypted token and forwards;
 * - Direct connection mode: POST https://api.github.com/graphql, carrying the passed-in token.
 *
 * Once the backend proxy fails (network / 5xx / missing token), automatically switch to direct mode and maintain it for the rest of this sync run,
 * avoiding hammering a failing proxy on every query in the same batch. Direct mode requires browser direct access to GitHub.
 *
 * Managing star lists via GraphQL requires a classic PAT with `user` scope (or a token with star lists permissions).
 */
export class GitHubListsApiService {
  private token: string;
  private backendUrl: string | null = null;
  private backendAuthToken: string | null = null;
  /** Set when backend proxy fails; remaining requests in this instance use direct connection (idempotent switch). */
  private proxyFailed = false;

  constructor(token: string) {
    this.token = token;
  }

  setBackendUrl(url: string | null): void {
    this.backendUrl = url;
  }

  setBackendAuthToken(token: string | null): void {
    this.backendAuthToken = token;
  }

  private getBackendHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.backendAuthToken) {
      headers.Authorization = `Bearer ${this.backendAuthToken}`;
    }
    return headers;
  }

  /**
   * Send a GraphQL request. Queries support $variables placeholders.
   * Throws errors with human-readable messages on unauthorized or insufficient permissions.
   *
   * Applies exponential backoff retries for transient GitHub-side errors:
   * - 5xx (502/503/504, including upstream gateway timeout and heavy load)
   * - Rate limiting 403 (x-ratelimit-remaining=0 or with Retry-After; secondary rate limits also use 403)
   * - Network errors (fetch rejection, e.g. transient connection resets)
   * Retries respect Retry-After header, up to 4 attempts, backing off 1→2→4→8s (whichever is larger with Retry-After).
   * Auth errors (401 / 403 insufficient scope), business errors (GraphQL errors), and other 4xx errors are not retried.
   *
   * In backend proxy mode, if the proxy fails (network / 5xx / missing token), switches to direct connection and stays direct
   * for the duration of the sync run; direct mode failures retry using the normal backoff sequence.
   *
   * @param toleratePartialErrors When true, if response is 200 and contains partial data,
   *   does not throw even if errors array is non-empty (used in batch resolution where individual failures shouldn't discard successes).
   *   Auth errors (401 / 403 insufficient scope) are always thrown regardless of mode.
   * @param replayableMutation Only applies to mutations. Under unknown results (network / 5xx / timeout), default is NOT to auto-replay
   *   because the proxy might have succeeded upstream while the response was lost, causing duplicate execution (e.g. duplicate list creation).
   *   Only set to true if the mutation is server-side idempotent (e.g. whole-set replacement).
   */
  private async request<T>(
    query: string,
    variables: Record<string, unknown> = {},
    options: { toleratePartialErrors?: boolean; signal?: AbortSignal; timeoutMs?: number; replayableMutation?: boolean } = {}
  ): Promise<T> {
    const body = JSON.stringify({ query, variables });
    const parentSignal = options.signal;
    // Unknown results for mutations are not auto-replayed; queries are always safe to replay.
    const isMutation = query.trim().startsWith('mutation');
    const mayReplay = !isMutation || options.replayableMutation === true;

    const MAX_ATTEMPTS = 4;
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (parentSignal?.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
      // Independent timeout per attempt: timeout budget is not drained by retries + backoff, nor does it abort backoff sleep
      // (otherwise sleep throws AbortError, masking the eventual RetriableError). Backoff is governed solely by parentSignal.
      const controller = createCombinedAbortController(parentSignal, options.timeoutMs ?? 30_000);
      // If backend proxy fails (network / 5xx / missing token), switch to direct connection for the remainder of sync:
      // avoids hitting a failing proxy on every query in the same batch.
      const useProxy = this.backendUrl !== null && !this.proxyFailed;
      try {
        return await this.attemptRequest<T>(body, controller.signal, options, useProxy);
      } catch (e) {
        if (e instanceof RetriableError) {
          lastError = e;
          // Mutation unknown result (proxy might have succeeded upstream but response was lost): do not auto-replay;
          // defer to higher layer to verify target state and avoid duplicate execution (e.g. creating duplicate list).
          if (!mayReplay) {
            if (e.proxyLayerFailure && this.backendUrl && !this.proxyFailed) {
              this.proxyFailed = true;
              logger.warn('githubLists', 'Mutation outcome unknown, not auto-replaying', { error: e.message });
            }
            break;
          }
          // Only switch to sticky direct connection if proxy layer itself failed (network / non-JSON 5xx / 5xx with backend code/details);
          // transient GitHub errors forwarded by a healthy proxy (rate limit, upstream 5xx) stay on proxy with backoff retry.
          if (e.proxyLayerFailure && this.backendUrl && !this.proxyFailed) {
            this.proxyFailed = true;
            logger.warn('githubLists', 'Backend proxy failed, falling back to direct connection', { error: e.message });
          }
          // Do not wait on the final attempt; throw directly
          if (attempt === MAX_ATTEMPTS - 1) break;
          const backoffMs = e.retryAfterMs ?? (1000 * Math.pow(2, attempt));
          await this.sleep(backoffMs, parentSignal);
          continue;
        }
        if (e instanceof BackendTokenMissingError) {
          // Backend has no configured token (e.g. before initial sync); frontend holds token, so direct connect without backoff.
          // 400 is returned before forwarding to GitHub, so mutation definitely did not run and is safe to replay.
          lastError = e;
          this.proxyFailed = true;
          logger.warn('githubLists', 'Backend token missing, falling back to direct connection');
          continue;
        }
        // An internal timeout on an individual attempt (e.g. stalled proxy request) aborts the combined controller, causing fetch to fail with AbortError.
        // Caller cancellation (parentSignal aborted) should propagate as-is; internal timeouts are transient errors,
        // so queries fall back to direct connection with backoff retry, while mutations with unknown results do not auto-replay.
        if (e instanceof Error && e.name === 'AbortError' && !parentSignal?.aborted) {
          lastError = new RetriableError('GitHub GraphQL request timed out.');
          if (!mayReplay) {
            if (useProxy && this.backendUrl && !this.proxyFailed) {
              this.proxyFailed = true;
              logger.warn('githubLists', 'Mutation timeout, not auto-replaying');
            }
            break;
          }
          // Only switch to direct connection if the timeout occurred on a proxy request in this step (cannot switch away from direct).
          if (useProxy && this.backendUrl && !this.proxyFailed) {
            this.proxyFailed = true;
            logger.warn('githubLists', 'Request timeout, falling back to direct connection');
          }
          if (attempt === MAX_ATTEMPTS - 1) break;
          const backoffMs = 1000 * Math.pow(2, attempt);
          await this.sleep(backoffMs, parentSignal);
          continue;
        }
        // Non-retryable (auth / business / AbortError, etc.), throw directly
        throw e;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('GitHub GraphQL request failed after multiple retries.');
  }

  /**
   * Interruptible sleep: respects signal abort, throwing AbortError immediately if aborted.
   */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        reject(err);
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        const err = new Error('Aborted');
        err.name = 'AbortError';
        reject(err);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Single GraphQL request attempt. Throws RetriableError for transient errors for outer retry;
   * permanent errors (auth / business / missing data) throw directly.
   * @param useProxy true routes through backend proxy; false connects directly to GitHub using browser token.
   */
  private async attemptRequest<T>(
    body: string,
    signal: AbortSignal,
    options: { toleratePartialErrors?: boolean },
    useProxy: boolean
  ): Promise<T> {
    let response: Response;
    try {
      if (useProxy && this.backendUrl) {
        const proxyUrl = `${this.backendUrl}/proxy/github/graphql`;
        response = await fetch(proxyUrl, {
          method: 'POST',
          headers: this.getBackendHeaders(),
          signal,
          body: JSON.stringify({
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.parse(body),
          }),
        });
      } else {
        response = await fetch(GITHUB_GRAPHQL_ENDPOINT, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal,
          body,
        });
      }
    } catch (e) {
      // Network layer error: do not retry AbortError; retry other transient errors (connection resets/timeouts)
      if (e instanceof DOMException && e.name === 'AbortError') {
        const abortErr = new Error('Aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      throw new RetriableError(
        `GitHub GraphQL network request failed: ${e instanceof Error ? e.message : String(e)}`,
        undefined,
        useProxy
      );
    }

    let payload: GraphQLResponse<T>;
    try {
      payload = await response.json();
    } catch {
      // Non-JSON response: gateways may return HTML error pages on 5xx, retry as transient error
      if (response.status >= 500 && response.status <= 599) {
        throw new RetriableError(
          `Failed to parse GitHub GraphQL response (HTTP ${response.status}).`,
          this.parseRetryAfterMs(response),
          useProxy
        );
      }
      throw new Error('Failed to parse GitHub GraphQL response (non-JSON).');
    }

    // Backend missing token (400 GITHUB_TOKEN_NOT_CONFIGURED): frontend holds token, direct connect works.
    // Throw dedicated error so request switches to direct mode to retry (without backoff).
    if (useProxy && response.status === 400 && (payload as unknown as BackendProxyErrorBody).code === 'GITHUB_TOKEN_NOT_CONFIGURED') {
      throw new BackendTokenMissingError('Backend has no configured GitHub token; switching to direct connection to retry.');
    }

    // Rate limit: 403 can indicate insufficient scope or primary/secondary rate limit.
    // Must evaluate before auth classification to avoid falsely reporting rate limits as "permission denied".
    const isRateLimited =
      response.status === 403 &&
      (response.headers.get('x-ratelimit-remaining') === '0' ||
        response.headers.get('retry-after') !== null);
    if (isRateLimited) {
      // Primary/secondary rate limits are transient: respect Retry-After rather than immediately throwing to user.
      // If Retry-After is not provided, use backoff sequence.
      throw new RetriableError(
        `GitHub API rate limit exceeded (HTTP 403).`,
        this.parseRetryAfterMs(response)
      );
    }

    if (payload.errors && payload.errors.length > 0) {
      const error = payload.errors[0];
      const message = error.message || 'GitHub GraphQL request failed';
      // Upstream 5xx is unconditionally treated as a transient error: even if error text hints at auth (e.g.
      // "authorized"/"permission" in 502 gateway error), it should retry / switch to direct, rather than being misclassified as insufficient permission.
      // If payload also carries backend code/details diagnostics (proxyLayerFailure=true), pass through and treat as proxy layer failure.
      if (response.status >= 500 && response.status <= 599) {
        const diagnostics = buildProxyDiagnostics(payload);
        throw new RetriableError(
          `${message}${diagnostics}`,
          this.parseRetryAfterMs(response),
          useProxy && diagnostics !== ''
        );
      }
      // Auth error: GraphQL usually returns "401 Unauthorized" or error message contains scope/permission keywords.
      // Regardless of whether partial failures are tolerated, auth errors must be thrown and never silently swallowed.
      if (response.status === 401 || response.status === 403 || /scope|permission|authorized|not granted/i.test(message)) {
        throw new Error(
          'The current GitHub token lacks permission to manage star lists.\n\n' +
          'Please resolve this using one of the following methods:\n' +
          '• Personal access token (classic): add the `user` scope\n' +
          '• In terminal, run: gh auth refresh -h github.com -s user\n' +
          '• Or log in again with a token that includes star lists permissions.'
        );
      }
      // Non-auth error: if partial failures allowed, response is 200, and partial data exists, keep partial results; otherwise throw.
      if (options.toleratePartialErrors && response.status === 200 && payload.data) {
        return payload.data;
      }
      throw new Error(message);
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        'The current GitHub token lacks permission to manage star lists.\n\n' +
        'Please resolve this using one of the following methods:\n' +
        '• Personal access token (classic): add the `user` scope\n' +
        '• In terminal, run: gh auth refresh -h github.com -s user\n' +
        '• Or log in again with a token that includes star lists permissions.'
      );
    }

    // 5xx (502/503/504): GitHub overload/gateway timeout, or backend proxy unreachable; transient error, retryable.
    // Pass through backend proxy code/details on failure to distinguish "backend container cannot reach GitHub" (proxyLayerFailure)
    // from "GitHub itself returned 5xx" (healthy proxy transparently forwarding, should not flip sticky direct).
    if (response.status >= 500 && response.status <= 599) {
      const diagnostics = buildProxyDiagnostics(payload);
      throw new RetriableError(
        `GitHub GraphQL request failed: ${response.status} ${response.statusText}${diagnostics}`,
        this.parseRetryAfterMs(response),
        useProxy && diagnostics !== ''
      );
    }

    if (!response.ok) {
      throw new Error(`GitHub GraphQL request failed: ${response.status} ${response.statusText}`);
    }

    if (!payload.data) {
      throw new Error('GitHub GraphQL response missing data field.');
    }

    return payload.data;
  }

  /**
   * Parse Retry-After header (seconds) into milliseconds; returns undefined if absent or invalid.
   */
  private parseRetryAfterMs(response: Response): number | undefined {
    const raw = response.headers.get('retry-after');
    if (!raw) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return undefined;
    // Rate limit Retry-After may be large; cap at 60s to avoid a single backoff stalling the overall sync.
    return Math.min(Math.round(n * 1000), 60_000);
  }

  /**
   * Get all Lists for current user (including full_name of repositories in each list).
   *
   * Uses a two-phase strategy: "fetch summaries first, then fetch items per list":
   * - Phase 1: Paginate lists summaries (id/name/description/isPrivate), lightweight per request, stable without timeouts;
   * - Phase 2: For each list, paginate items via node(id:) (100 per page).
   *
   * Items cannot be inlined directly in the lists query as in earlier implementations: when lists count is large (~15-20+)
   * and each list contains many repositories, a single GraphQL response payload becomes too large and GitHub times out with 502/504.
   *
   * Phase 2 runs concurrently across lists (governed by LIST_ITEMS_CONCURRENCY), while each list internally
   * paginates sequentially (cursor dependency between pages). In testing with 22 lists and 2,533 repositories, this significantly reduced wall-clock time
   * while staying well below GitHub GraphQL concurrency limits without triggering secondary rate limits.
   *
   * @param options.concurrency Concurrency across lists in Phase 2 (default LIST_ITEMS_CONCURRENCY)
   */
  async getUserLists(
    login: string,
    signal?: AbortSignal,
    options: { concurrency?: number } = {}
  ): Promise<GitHubList[]> {
    logger.info('githubLists', 'Fetching user lists', { login });

    const summaries: Array<{ id: string; name: string; description?: string; isPrivate: boolean }> = [];
    let hasNextPage = true;
    let cursor: string | null = null;

    while (hasNextPage) {
      const data: UserListsPage = await this.request<UserListsPage>(
        `query($login: String!, $cursor: String) {
          user(login: $login) {
            lists(first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes { id name description isPrivate }
            }
          }
        }`,
        { login, cursor },
        { signal }
      );

      // user being null indicates login does not exist or current token lacks access
      if (!data.user) {
        throw new Error(`GitHub user "${login}" does not exist or current token lacks access.`);
      }

      const nodes = data.user.lists.nodes ?? [];
      summaries.push(
        ...nodes
          .filter((node): node is UserListNode => node !== null)
          .map((node) => ({ ...node, description: node.description ?? undefined }))
      );
      hasNextPage = data.user.lists.pageInfo.hasNextPage;
      const nextCursor: string | null = data.user.lists.pageInfo.endCursor;
      // Guard: if hasNextPage is true but cursor is empty or stalled, terminate pagination to avoid infinite loop / duplicate pages
      if (!nextCursor || nextCursor === cursor) {
        hasNextPage = false;
      } else {
        cursor = nextCursor;
      }
    }

    // Phase 2: fetch items concurrently across lists with sequential pagination within each list.
    const concurrency = Math.max(1, options.concurrency ?? LIST_ITEMS_CONCURRENCY);
    const results = await mapPool(
      summaries,
      async (summary) => {
        const items = await this.fetchListItems(summary.id, signal);
        return {
          id: summary.id,
          name: summary.name,
          description: summary.description,
          isPrivate: summary.isPrivate,
          items,
        } satisfies GitHubList;
      },
      concurrency,
      signal
    );

    logger.info('githubLists', 'Fetched user lists', { count: results.length });
    return results;
  }

  /**
   * Paginate items for a single list (100 per page), returning a list of repository nameWithOwner strings.
   * Internal pagination within a single list must be sequential: the next page's itemCursor depends on the previous endCursor.
   */
  private async fetchListItems(listId: string, signal?: AbortSignal): Promise<string[]> {
    const items: string[] = [];
    let itemHasNext = true;
    let itemCursor: string | null = null;
    while (itemHasNext) {
      const itemPage: UserListItemsPage = await this.request<UserListItemsPage>(
        `query($listId: ID!, $itemCursor: String) {
          node(id: $listId) {
            ... on UserList {
              items(first: 100, after: $itemCursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  __typename
                  ... on Repository { id nameWithOwner }
                }
              }
            }
          }
        }`,
        { listId, itemCursor },
        { signal }
      );
      if (!itemPage.node) break;
      for (const item of itemPage.node.items.nodes ?? []) {
        if (item?.nameWithOwner) items.push(item.nameWithOwner);
      }
      itemHasNext = itemPage.node.items.pageInfo.hasNextPage;
      const nextItemCursor: string | null = itemPage.node.items.pageInfo.endCursor;
      // Guard: terminate pagination if cursor is empty or stalled to prevent infinite loops / duplicate pages
      if (!nextItemCursor || nextItemCursor === itemCursor) {
        itemHasNext = false;
      } else {
        itemCursor = nextItemCursor;
      }
    }
    return items;
  }

  /** Get IDs and names of all Lists for current user (excluding members), used for duplicate name detection before syncing. */
  async getUserListSummaries(login: string, signal?: AbortSignal): Promise<GitHubListSummary[]> {
    const summaries: GitHubListSummary[] = [];
    let hasNextPage = true;
    let cursor: string | null = null;

    while (hasNextPage) {
      const data: UserListSummariesPage = await this.request<UserListSummariesPage>(
        `query($login: String!, $cursor: String) {
          user(login: $login) {
            lists(first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes { id name }
            }
          }
        }`,
        { login, cursor },
        { signal }
      );
      if (!data.user) {
        throw new Error(`GitHub user "${login}" does not exist or current token lacks access.`);
      }
      summaries.push(
        ...(data.user.lists.nodes ?? []).filter(
          (node): node is GitHubListSummary => node !== null
        )
      );
      hasNextPage = data.user.lists.pageInfo.hasNextPage;
      const nextCursor: string | null = data.user.lists.pageInfo.endCursor;
      // Guard: if hasNextPage is true but cursor is empty or stalled, terminate pagination to avoid infinite loop / duplicate pages
      if (!nextCursor || nextCursor === cursor) {
        hasNextPage = false;
      } else {
        cursor = nextCursor;
      }
    }

    return summaries;
  }

  /**
   * Create a new List and return its ID.
   * Creation is a non-idempotent mutation: on unknown results (network/5xx/timeout), request does not auto-replay,
   * but first checks current user's lists by name—if a list with the same name exists, the initial request succeeded
   * but the response was lost, so we reuse its ID to avoid duplicates.
   */
  async createUserList(name: string, isPrivate = true, description?: string): Promise<string> {
    try {
      const data = await this.request<{
        createUserList: { list: { id: string; name: string } };
      }>(
        `mutation($name: String!, $isPrivate: Boolean!, $description: String) {
        createUserList(input: { name: $name, isPrivate: $isPrivate, description: $description }) {
          list { id name }
        }
      }`,
        { name, isPrivate, description: description ?? null }
      );
      return data.createUserList.list.id;
    } catch (error) {
      // Only check on unknown results (RetriableError); retain original error on check failure to avoid masking root cause.
      if (error instanceof RetriableError) {
        try {
          const existingId = await this.findListIdByName(name);
          if (existingId !== null) return existingId;
        } catch {
          // Ignore verification query failure and preserve original error.
        }
      }
      throw error;
    }
  }

  /**
   * Look up ID by name in current user's lists (for state verification after non-idempotent mutation unknown results).
   * Paginates via viewer, returning the first case-insensitive matching list ID, or null if not found.
   */
  private async findListIdByName(name: string): Promise<string | null> {
    const target = name.toLowerCase();
    let cursor: string | null = null;
    // Pagination guard: list count is typically small; 10 pages (1000 items) is sufficient for extreme cases and avoids infinite loops.
    for (let i = 0; i < 10; i++) {
      // Explicit type annotation to avoid circular type inference with implicit any (existing TS7022 pattern in this file)
      const data: {
        viewer: {
          lists: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<{ id: string; name: string }>;
          };
        } | null;
      } = await this.request(
        `query($cursor: String) {
          viewer {
            lists(first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes { id name }
            }
          }
        }`,
        { cursor }
      );
      const lists: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{ id: string; name: string }>;
      } | undefined = data.viewer?.lists;
      if (!lists) return null;
      for (const list of lists.nodes) {
        if (list.name.toLowerCase() === target) return list.id;
      }
      if (!lists.pageInfo.hasNextPage) return null;
      const nextCursor: string | null = lists.pageInfo.endCursor;
      // Guard: hasNextPage is true but cursor is empty or stalled, terminate to avoid infinite loops
      if (!nextCursor || nextCursor === cursor) return null;
      cursor = nextCursor;
    }
    return null;
  }

  /** Delete a List. */
  async deleteUserList(listId: string): Promise<void> {
    await this.request<{ deleteUserList: { clientMutationId: string | null } }>(
      `mutation($listId: ID!) {
        deleteUserList(input: { listId: $listId }) {
          clientMutationId
        }
      }`,
      { listId },
      // Deletion by node ID is idempotent: replaying hits "already deleted" at most without additional side effects.
      { replayableMutation: true }
    );
  }
  /**
   * Rename a List (used for automated migration during language switching).
   * description is sent only when explicitly provided: omitting this parameter omits the description key from variables,
   * which GraphQL treats as "field not provided", preserving existing description; explicitly passing null clears the description.
   * Unknown results (network/timeout) are not auto-replayed: renaming is idempotent, but the next push cycle will naturally retry
   * due to name mismatch without needing replay at the transport layer.
   */
  async updateUserList(listId: string, name: string, description?: string | null): Promise<void> {
    const variables: { listId: string; name: string; description?: string | null } = { listId, name };
    if (description !== undefined) {
      variables.description = description;
    }
    await this.request<{ updateUserList: { list: { id: string; name: string } } }>(
      `mutation($listId: ID!, $name: String!, $description: String) {
        updateUserList(input: { listId: $listId, name: $name, description: $description }) {
          list { id name }
        }
      }`,
      variables,
      { replayableMutation: false }
    );
  }

  /**
   * Add a repository (itemId is GraphQL node ID) to specified set of lists.
   * Note: This operation replaces the entire set of lists for the repository (overwrite semantics).
   * Passing an empty array removes the repository from all lists (used to clean up obsolete memberships).
   */
  async updateUserListsForItem(itemId: string, listIds: string[]): Promise<void> {
    await this.request<{ updateUserListsForItem: { clientMutationId: string | null } }>(
      `mutation($itemId: ID!, $listIds: [ID!]!) {
        updateUserListsForItem(input: { itemId: $itemId, listIds: $listIds }) {
          clientMutationId
        }
      }`,
      { itemId, listIds },
      // Whole-set replacement semantics (server de-duplicates by set): regardless of replay count, the final membership set is identical,
      // so replaying after unknown results is safe, identical to queries.
      { replayableMutation: true }
    );
  }

  /**
   * Batch resolve repository node IDs (itemId) via GraphQL.
   * @param ownerNamePairs Repository owner/name (passed preserving GitHub original case, GraphQL matching is case-sensitive)
   * @returns Map<lowercase full_name, node_id> — keyed by lowercase for consistent lookups by callers
   */
  async resolveRepositoryNodeIds(ownerNamePairs: Array<{ owner: string; name: string }>, signal?: AbortSignal): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const BATCH = 50;

    for (let i = 0; i < ownerNamePairs.length; i += BATCH) {
      const batch = ownerNamePairs.slice(i, i + BATCH);
      const aliases: string[] = [];
      const variables: Record<string, string> = {};
      batch.forEach(({ owner, name }, idx) => {
        const alias = `r${idx}`;
        const ownerVar = `${alias}Owner`;
        const nameVar = `${alias}Name`;
        variables[ownerVar] = owner;
        variables[nameVar] = name;
        aliases.push(
          `${alias}: repository(owner: $${ownerVar}, name: $${nameVar}) { id nameWithOwner }`
        );
      });

      const variableDecls = Object.keys(variables).map(v => `$${v}: String!`).join(', ');
      const data = await this.request<Record<string, { id?: string; nameWithOwner?: string } | null>>(
        `query(${variableDecls}) { ${aliases.join(' ')} }`,
        variables,
        // Tolerate partial failures: individual repo resolution failures (e.g. deleted/renamed) should not discard the entire batch of successful results.
        // Auth errors are still thrown.
        { toleratePartialErrors: true, signal }
      );

      for (const key of Object.keys(data)) {
        const node = data[key];
        if (node?.id && node.nameWithOwner) {
          // Key by lowercase full_name for caller lookups
          result.set(node.nameWithOwner.toLowerCase(), node.id);
        }
      }
    }

    return result;
  }
}
