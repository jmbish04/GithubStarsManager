import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubListsApiService } from './githubListsApi';

function makeJsonResponse(status: number, body: unknown, statusText = '', headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Response;
}

const DIRECT_URL = 'https://api.github.com/graphql';
const PROXY_URL = 'http://backend.test/api/proxy/github/graphql';
const BACKEND_URL = 'http://backend.test/api';

const SUCCESS_DATA = {
  data: { createUserList: { list: { id: 'L_1', name: 't' } } },
};

const LIST_SUMMARIES_DATA = {
  data: {
    user: {
      lists: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: 'L_1', name: 't' }] },
    },
  },
};

const UPDATE_ITEM_DATA = {
  data: { updateUserListsForItem: { clientMutationId: 'c1' } },
};

const UPDATE_LIST_DATA = {
  data: { updateUserList: { list: { id: 'L_1', name: 'renamed' } } },
};

const VIEWER_LISTS_DATA = {
  data: {
    viewer: {
      lists: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: 'L_99', name: 't' }] },
    },
  },
};

function makeService(backendUrl: string | null = null): GitHubListsApiService {
  const api = new GitHubListsApiService('gh_token');
  if (backendUrl) {
    api.setBackendUrl(backendUrl);
    api.setBackendAuthToken('backend_secret');
  }
  return api;
}

describe('GitHubListsApiService backend proxy fallback to direct connection', () => {
  beforeEach(() => {
    // Complete backoff sleep immediately to avoid slowing tests with 1→2→4s delays
    vi.spyOn(GitHubListsApiService.prototype as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.mocked(window.fetch).mockReset();
    vi.restoreAllMocks();
  });

  it('query (getUserListSummaries) falls back to direct connection and succeeds after proxy 502', async () => {
    const api = makeService(BACKEND_URL);
    vi.mocked(window.fetch)
      .mockResolvedValueOnce(makeJsonResponse(502, { error: 'Bad Gateway', code: 'BAD_GATEWAY', details: 'getaddrinfo ENOTFOUND api.github.com' }, 'Bad Gateway'))
      .mockResolvedValueOnce(makeJsonResponse(200, LIST_SUMMARIES_DATA));

    const summaries = await api.getUserListSummaries('cgy141514');

    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe('L_1');
    const calls = vi.mocked(window.fetch).mock.calls;
    expect(calls).toHaveLength(2);
    expect(String(calls[0][0])).toBe(PROXY_URL);
    expect(String(calls[1][0])).toBe(DIRECT_URL);
  });

  it('falls back to direct connection and succeeds after proxy 400 GITHUB_TOKEN_NOT_CONFIGURED (no backoff needed, mutation definitely unexecuted)', async () => {
    const api = makeService(BACKEND_URL);
    vi.mocked(window.fetch)
      .mockResolvedValueOnce(makeJsonResponse(400, { error: 'GitHub token not configured', code: 'GITHUB_TOKEN_NOT_CONFIGURED' }))
      .mockResolvedValueOnce(makeJsonResponse(200, SUCCESS_DATA));

    const id = await api.createUserList('t');

    expect(id).toBe('L_1');
    const calls = vi.mocked(window.fetch).mock.calls;
    expect(calls).toHaveLength(2);
    expect(String(calls[0][0])).toBe(PROXY_URL);
    expect(String(calls[1][0])).toBe(DIRECT_URL);
  });

  it('stays on proxy when proxy succeeds, not initiating direct connection', async () => {
    const api = makeService(BACKEND_URL);
    vi.mocked(window.fetch).mockResolvedValueOnce(makeJsonResponse(200, SUCCESS_DATA));

    const id = await api.createUserList('t');

    expect(id).toBe('L_1');
    const calls = vi.mocked(window.fetch).mock.calls;
    expect(calls).toHaveLength(1);
    expect(String(calls[0][0])).toBe(PROXY_URL);
  });

  it('subsequent queries on same instance use direct connection directly after fallback, no longer hitting proxy', async () => {
    const api = makeService(BACKEND_URL);
    vi.mocked(window.fetch)
      .mockResolvedValueOnce(makeJsonResponse(502, { error: 'Bad Gateway', code: 'BAD_GATEWAY' }, 'Bad Gateway'))
      .mockResolvedValue(makeJsonResponse(200, LIST_SUMMARIES_DATA));

    await api.getUserListSummaries('first');
    await api.getUserListSummaries('second');

    const calls = vi.mocked(window.fetch).mock.calls;
    expect(calls).toHaveLength(3);
    expect(String(calls[0][0])).toBe(PROXY_URL);
    expect(String(calls[1][0])).toBe(DIRECT_URL);
    expect(String(calls[2][0])).toBe(DIRECT_URL);
  });

  it('throws permission error when proxy returns 401, not triggering direct fallback', async () => {
    const api = makeService(BACKEND_URL);
    vi.mocked(window.fetch).mockResolvedValueOnce(
      makeJsonResponse(401, { data: null, errors: [{ message: '401 Unauthorized' }] })
    );

    await expect(api.createUserList('t')).rejects.toThrow(/lacks permission to manage star lists/);
    expect(vi.mocked(window.fetch).mock.calls).toHaveLength(1);
  });

  it('retries via proxy as transient error when 5xx error text contains auth keywords, rather than misjudging insufficient permissions', async () => {
    const api = makeService(BACKEND_URL);
    vi.mocked(window.fetch)
      .mockResolvedValueOnce(makeJsonResponse(502, { data: null, errors: [{ message: 'Something went wrong while processing a permission-authorized request' }] }, 'Bad Gateway'))
      .mockResolvedValueOnce(makeJsonResponse(200, LIST_SUMMARIES_DATA));

    const summaries = await api.getUserListSummaries('cgy141514');

    expect(summaries).toHaveLength(1);
    const calls = vi.mocked(window.fetch).mock.calls;
    expect(calls).toHaveLength(2);
    // This 502 has no backend code/details (transparently forwarded by healthy proxy); does not switch to direct, retries on proxy
    expect(String(calls[0][0])).toBe(PROXY_URL);
    expect(String(calls[1][0])).toBe(PROXY_URL);
  });

  it('retries on proxy without switching to direct when proxy transparently passes upstream GitHub 5xx (without code/details)', async () => {
    const api = makeService(BACKEND_URL);
    vi.mocked(window.fetch)
      .mockResolvedValueOnce(makeJsonResponse(502, { data: null, errors: [{ message: 'Something went wrong' }] }, 'Bad Gateway'))
      .mockResolvedValueOnce(makeJsonResponse(200, LIST_SUMMARIES_DATA));

    const summaries = await api.getUserListSummaries('cgy141514');

    expect(summaries).toHaveLength(1);
    const calls = vi.mocked(window.fetch).mock.calls;
    expect(calls).toHaveLength(2);
    expect(String(calls[0][0])).toBe(PROXY_URL);
    expect(String(calls[1][0])).toBe(PROXY_URL);
  });

  it('retries on proxy without switching to direct when proxy passes through GitHub rate limit (403 x-ratelimit-remaining=0)', async () => {
    const api = makeService(BACKEND_URL);
    vi.mocked(window.fetch)
      .mockResolvedValueOnce(makeJsonResponse(403, { data: null, errors: [{ message: 'rate limit' }] }, 'Forbidden', { 'x-ratelimit-remaining': '0' }))
      .mockResolvedValueOnce(makeJsonResponse(200, LIST_SUMMARIES_DATA));

    const summaries = await api.getUserListSummaries('cgy141514');

    expect(summaries).toHaveLength(1);
    const calls = vi.mocked(window.fetch).mock.calls;
    expect(calls).toHaveLength(2);
    expect(String(calls[0][0])).toBe(PROXY_URL);
    expect(String(calls[1][0])).toBe(PROXY_URL);
  });

  it('throws on unknown mutation (createUserList) result after proxy 502, not auto-replaying direct connection', async () => {
    const api = makeService(BACKEND_URL);
    vi.mocked(window.fetch)
      .mockResolvedValueOnce(makeJsonResponse(502, { error: 'Bad Gateway', code: 'BAD_GATEWAY', details: 'getaddrinfo ENOTFOUND api.github.com' }, 'Bad Gateway'))
      // Preserve original error when verification query (viewer) fails
      .mockResolvedValue(makeJsonResponse(502, { data: null, errors: [{ message: 'Something went wrong' }] }, 'Bad Gateway'));

    await expect(api.createUserList('t')).rejects.toThrow(/backend proxy: BAD_GATEWAY/);
    expect(String(vi.mocked(window.fetch).mock.calls[0][0])).toBe(PROXY_URL);
    // Verify direct path did not replay createUserList mutation (inspect body rather than String(c[1]))
    expect(
      vi.mocked(window.fetch).mock.calls.some(
        c => String(c[0]) === DIRECT_URL &&
          String((c[1] as RequestInit)?.body ?? '').includes('createUserList')
      )
    ).toBe(false);
  });

  it('reuses existing list by name verification after proxy network failure on mutation (createUserList), not creating duplicate', async () => {
    const api = makeService(BACKEND_URL);
    vi.mocked(window.fetch)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(makeJsonResponse(200, VIEWER_LISTS_DATA));

    const id = await api.createUserList('t');

    expect(id).toBe('L_99');
    const calls = vi.mocked(window.fetch).mock.calls;
    expect(calls).toHaveLength(2);
    expect(String(calls[0][0])).toBe(PROXY_URL);
    expect(String(calls[1][0])).toBe(DIRECT_URL);
    // The second call is a viewer verification query, not replaying createUserList mutation
    const secondBody = String((calls[1][1] as RequestInit).body ?? '');
    expect(secondBody).toContain('viewer');
    expect(secondBody).not.toContain('createUserList');
  });

  it('falls back to direct connection and succeeds after proxy 502 for idempotent whole-set replacement mutation (updateUserListsForItem)', async () => {
    const api = makeService(BACKEND_URL);
    vi.mocked(window.fetch)
      .mockResolvedValueOnce(makeJsonResponse(502, { error: 'Bad Gateway', code: 'BAD_GATEWAY' }, 'Bad Gateway'))
      .mockResolvedValueOnce(makeJsonResponse(200, UPDATE_ITEM_DATA));

    await api.updateUserListsForItem('node_1', ['L_1', 'L_2']);

    const calls = vi.mocked(window.fetch).mock.calls;
    expect(calls).toHaveLength(2);
    expect(String(calls[0][0])).toBe(PROXY_URL);
    expect(String(calls[1][0])).toBe(DIRECT_URL);
  });

  describe('updateUserList', () => {
    function lastVariables(): Record<string, unknown> {
      const calls = vi.mocked(window.fetch).mock.calls;
      return JSON.parse(String((calls[calls.length - 1][1] as RequestInit).body ?? '{}')).variables;
    }

    it('omits description key from variables when description is omitted (renaming preserves existing description, not wiped by explicit null)', async () => {
      const api = makeService(null);
      vi.mocked(window.fetch).mockResolvedValueOnce(makeJsonResponse(200, UPDATE_LIST_DATA));

      await api.updateUserList('L_1', 'Development Tools');

      const variables = lastVariables();
      expect(variables).toEqual({ listId: 'L_1', name: 'Development Tools' });
      // toEqual ignores keys with undefined value; explicitly assert key does not exist here
      expect('description' in variables).toBe(false);
    });

    it('sends description: null when explicitly passing null (preserves ability to clear description)', async () => {
      const api = makeService(null);
      vi.mocked(window.fetch).mockResolvedValueOnce(makeJsonResponse(200, UPDATE_LIST_DATA));

      await api.updateUserList('L_1', 'Development Tools', null);

      expect(lastVariables()).toEqual({ listId: 'L_1', name: 'Development Tools', description: null });
    });

    it('sends description string as-is when explicitly passed', async () => {
      const api = makeService(null);
      vi.mocked(window.fetch).mockResolvedValueOnce(makeJsonResponse(200, UPDATE_LIST_DATA));

      await api.updateUserList('L_1', 'Development Tools', 'curated tools');

      expect(lastVariables()).toEqual({ listId: 'L_1', name: 'Development Tools', description: 'curated tools' });
    });

    it('throws on unknown result (internal timeout), without auto-replaying or falling back to direct connection', async () => {
      const api = makeService(BACKEND_URL);
      vi.mocked(window.fetch).mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'));

      await expect(api.updateUserList('L_1', 'Development Tools')).rejects.toThrow(/request timed out/);
      const calls = vi.mocked(window.fetch).mock.calls;
      expect(calls).toHaveLength(1);
      expect(String(calls[0][0])).toBe(PROXY_URL);
    });
  });

  it('falls back to direct connection and succeeds after proxy request internal timeout (AbortError)', async () => {
    const api = makeService(BACKEND_URL);
    vi.mocked(window.fetch)
      .mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'))
      .mockResolvedValueOnce(makeJsonResponse(200, LIST_SUMMARIES_DATA));

    const summaries = await api.getUserListSummaries('cgy141514');

    expect(summaries).toHaveLength(1);
    const calls = vi.mocked(window.fetch).mock.calls;
    expect(calls).toHaveLength(2);
    expect(String(calls[0][0])).toBe(PROXY_URL);
    expect(String(calls[1][0])).toBe(DIRECT_URL);
  });

  it('throws on mutation internal timeout (AbortError) unknown result without auto-replaying', async () => {
    const api = makeService(BACKEND_URL);
    vi.mocked(window.fetch)
      .mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'))
      .mockResolvedValueOnce(makeJsonResponse(200, SUCCESS_DATA));

    await expect(api.createUserList('t')).rejects.toThrow(/request timed out/);
    const calls = vi.mocked(window.fetch).mock.calls;
    // After mutation timeout, ran one viewer verification query (not replay), then threw original timeout error
    expect(calls).toHaveLength(2);
    expect(String(calls[0][0])).toBe(PROXY_URL);
    const secondBody = String((calls[1][1] as RequestInit).body ?? '');
    expect(secondBody).toContain('viewer');
    expect(secondBody).not.toContain('createUserList');
  });

  it('propagates AbortError on caller cancellation (parent signal aborted) without retrying or falling back', async () => {
    const api = makeService(BACKEND_URL);
    const controller = new AbortController();
    // Simulate caller cancellation during in-flight request: abort parent signal first, fetch then fails with AbortError
    vi.mocked(window.fetch).mockImplementationOnce(() => {
      controller.abort();
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    });

    await expect(api.getUserListSummaries('cgy141514', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.mocked(window.fetch).mock.calls).toHaveLength(1);
  });

  it('connects directly when backend is unconfigured', async () => {
    const api = makeService(null);
    vi.mocked(window.fetch).mockResolvedValueOnce(makeJsonResponse(200, SUCCESS_DATA));

    const id = await api.createUserList('t');

    expect(id).toBe('L_1');
    expect(String(vi.mocked(window.fetch).mock.calls[0][0])).toBe(DIRECT_URL);
  });

  it('throws after exhausting query retries when both proxy and direct connection return persistent 5xx', async () => {
    const api = makeService(BACKEND_URL);
    vi.mocked(window.fetch)
      .mockResolvedValueOnce(makeJsonResponse(502, { error: 'Bad Gateway', code: 'BAD_GATEWAY' }, 'Bad Gateway'))
      .mockResolvedValue(makeJsonResponse(502, { data: null, errors: [{ message: 'Something went wrong' }] }, 'Bad Gateway'));

    await expect(api.getUserListSummaries('cgy141514')).rejects.toThrow(/Something went wrong/);
  });

  it('passes backend proxy error code/details through to error message', async () => {
    const api = makeService(BACKEND_URL);
    vi.mocked(window.fetch)
      .mockResolvedValueOnce(makeJsonResponse(502, { error: 'Bad Gateway', code: 'BAD_GATEWAY', details: 'getaddrinfo ENOTFOUND api.github.com' }, 'Bad Gateway'))
      .mockResolvedValue(makeJsonResponse(502, { error: 'Bad Gateway', code: 'BAD_GATEWAY', details: 'getaddrinfo ENOTFOUND api.github.com' }, 'Bad Gateway'));

    await expect(api.createUserList('t')).rejects.toThrow(/backend proxy: BAD_GATEWAY: getaddrinfo ENOTFOUND/);
  });

  it('passes code/details diagnostics through on 5xx errors branch as well', async () => {
    const api = makeService(BACKEND_URL);
    vi.mocked(window.fetch)
      .mockResolvedValueOnce(makeJsonResponse(502, { data: null, errors: [{ message: 'Something went wrong' }], code: 'BAD_GATEWAY', details: 'getaddrinfo ENOTFOUND' }, 'Bad Gateway'))
      .mockResolvedValue(makeJsonResponse(502, { data: null, errors: [{ message: 'Something went wrong' }], code: 'BAD_GATEWAY', details: 'getaddrinfo ENOTFOUND' }, 'Bad Gateway'));

    await expect(api.createUserList('t')).rejects.toThrow(/Something went wrong.*backend proxy: BAD_GATEWAY: getaddrinfo ENOTFOUND/);
  });

  it('passes diagnostics through on 5xx with details only and no code', async () => {
    const api = makeService(BACKEND_URL);
    vi.mocked(window.fetch)
      .mockResolvedValueOnce(makeJsonResponse(502, { error: 'Bad Gateway', details: 'ECONNREFUSED' }, 'Bad Gateway'))
      .mockResolvedValue(makeJsonResponse(502, { error: 'Bad Gateway', details: 'ECONNREFUSED' }, 'Bad Gateway'));

    await expect(api.createUserList('t')).rejects.toThrow(/backend proxy: ECONNREFUSED/);
  });
});