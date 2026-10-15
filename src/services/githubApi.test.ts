import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repository, Release } from '../types';
import { BACKEND_PROXY_UNAUTHORIZED_ERROR, GITHUB_TOKEN_INVALID_ERROR, GitHubApiService } from './githubApi';

const makeRepository = (id: number, fullName: string, overrides: Partial<Repository> = {}): Repository => {
  const [owner, name] = fullName.split('/');
  return {
    id,
    name,
    full_name: fullName,
    description: null,
    html_url: `https://github.com/${fullName}`,
    stargazers_count: 1,
    forks_count: 0,
    forks: 0,
    language: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    pushed_at: '2026-01-01T00:00:00.000Z',
    owner: { login: owner, avatar_url: `https://github.com/${owner}.png` },
    topics: [],
    ...overrides,
  };
};

const makeRelease = (id: number, publishedAt: string, overrides: Partial<Release> = {}): Release => ({
  id,
  tag_name: `v${id}`,
  name: `Release ${id}`,
  body: null,
  published_at: publishedAt,
  html_url: `https://github.com/owner/repo/releases/tag/v${id}`,
  assets: [
    {
      id: 100 + id,
      name: 'app.dmg',
      size: 1000,
      download_count: 0,
      browser_download_url: 'https://example.com/app.dmg',
      content_type: 'application/octet-stream',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
  ],
  repository: { id: 0, full_name: 'owner/repo', name: 'repo' },
  ...overrides,
});

const releasePage = (releases: Release[], hasMore = false) => ({ releases, hasMore });

describe('GitHubApiService.getMultipleRepositoryReleases asset refresh', () => {
  it('collects the latest release per already-synced repo when refreshExistingAssets is enabled', async () => {
    const service = new GitHubApiService('token');
    const latest = makeRelease(1, '2026-01-03T00:00:00.000Z');
    const older = makeRelease(2, '2026-01-01T00:00:00.000Z');

    // Synced repo: watermark at 01-02, latest Release (01-03) is after the watermark (fresh), older Release is before it.
    vi.spyOn(service, 'getRepositoryReleasesPage').mockResolvedValueOnce(
      releasePage([latest, older]) as never
    );
    vi.spyOn(service, 'fetchAllReleasesForRepo').mockResolvedValueOnce([] as never);

    const repo = makeRepository(10, 'owner/repo', { has_fetched_releases: true, last_release_fetch_time: '2026-01-02T00:00:00.000Z' });

    const result = await service.getMultipleRepositoryReleases(
      [repo],
      { includePreRelease: true, refreshExistingAssets: true }
    );

    // The new list includes the latest Release after the watermark
    expect(result.releases.map(r => r.id)).toEqual([1]);
    // The latest Release is also collected for asset fingerprint comparison, and carries the repo id
    expect(result.latestReleases).toHaveLength(1);
    expect(result.latestReleases![0].id).toBe(1);
    expect(result.latestReleases![0].repository.id).toBe(10);
  });

  it('collects latest release even when it is below the watermark (already fetched)', async () => {
    const service = new GitHubApiService('token');
    const latest = makeRelease(1, '2026-01-01T00:00:00.000Z'); // before the watermark
    const older = makeRelease(2, '2025-12-01T00:00:00.000Z');

    // Returns a page with two entries, both before the watermark, so releases is empty, but the latest entry should still be collected
    vi.spyOn(service, 'getRepositoryReleasesPage').mockResolvedValueOnce(
      releasePage([latest, older]) as never
    );

    const repo = makeRepository(10, 'owner/repo', { has_fetched_releases: true, last_release_fetch_time: '2026-01-02T00:00:00.000Z' });

    const result = await service.getMultipleRepositoryReleases(
      [repo],
      { includePreRelease: true, refreshExistingAssets: true }
    );

    expect(result.releases).toHaveLength(0);
    expect(result.latestReleases).toHaveLength(1);
    expect(result.latestReleases![0].id).toBe(1);
    expect(result.latestReleases![0].repository.id).toBe(10);
  });

  it('does not populate latestReleases when refreshExistingAssets is disabled', async () => {
    const service = new GitHubApiService('token');
    const latest = makeRelease(1, '2026-01-03T00:00:00.000Z');

    vi.spyOn(service, 'getRepositoryReleasesPage').mockResolvedValueOnce(releasePage([latest]) as never);

    const repo = makeRepository(10, 'owner/repo', { has_fetched_releases: true, last_release_fetch_time: '2026-01-02T00:00:00.000Z' });

    const result = await service.getMultipleRepositoryReleases(
      [repo],
      { includePreRelease: true, refreshExistingAssets: false }
    );

    expect(result.latestReleases).toBeUndefined();
  });

  it('skips a prerelease latest when includePreRelease is false and collects the newest stable release instead', async () => {
    const service = new GitHubApiService('token');
    const prerelease = makeRelease(1, '2026-01-05T00:00:00.000Z', { prerelease: true });
    const stable = makeRelease(2, '2026-01-04T00:00:00.000Z');

    // First entry on page one is a new (pre-release) publish; the latest stable release is below it
    vi.spyOn(service, 'getRepositoryReleasesPage').mockResolvedValueOnce(
      releasePage([prerelease, stable]) as never
    );

    const repo = makeRepository(10, 'owner/repo', { has_fetched_releases: true, last_release_fetch_time: '2026-01-02T00:00:00.000Z' });

    const result = await service.getMultipleRepositoryReleases(
      [repo],
      { includePreRelease: false, refreshExistingAssets: true }
    );

    // The latest Release should skip pre-releases and collect the first stable release
    expect(result.latestReleases).toHaveLength(1);
    expect(result.latestReleases![0].id).toBe(2);
    expect(result.latestReleases![0].repository.id).toBe(10);
  });

  it('continues past page one of only prereleases to collect the newest stable release', async () => {
    const service = new GitHubApiService('token');
    // All 10 entries on page one are pre-releases (and all after the watermark); the stable release only appears on page two
    const page1 = Array.from({ length: 10 }, (_, i) =>
      makeRelease(100 + i, `2026-01-${String(20 - i).padStart(2, '0')}T00:00:00.000Z`, { prerelease: true })
    );
    const stable = makeRelease(50, '2026-01-05T00:00:00.000Z');
    const older = makeRelease(40, '2025-12-01T00:00:00.000Z');

    vi.spyOn(service, 'getRepositoryReleasesPage')
      .mockResolvedValueOnce(releasePage(page1, true) as never)
      .mockResolvedValueOnce(releasePage([stable, older]) as never);

    const repo = makeRepository(10, 'owner/repo', {
      has_fetched_releases: true,
      last_release_fetch_time: '2026-01-02T00:00:00.000Z',
    });

    const result = await service.getMultipleRepositoryReleases(
      [repo],
      { includePreRelease: false, refreshExistingAssets: true }
    );

    expect(result.latestReleases).toHaveLength(1);
    expect(result.latestReleases![0].id).toBe(50);
    expect(result.latestReleases![0].repository.id).toBe(10);
    // The stable release is after the watermark and should enter the new list; pre-releases are filtered by includePreRelease=false
    expect(result.releases.map(r => r.id)).toEqual([50]);
  });
});

describe('GitHubApiService.getWatchedRepositories', () => {
  it('returns [] when GitHub responds 204 and makeRequest normalizes the body to null', async () => {
    const service = new GitHubApiService('token');
    // Reproduces issue #285: GitHub returns a 204 empty body for watched repos, which makeRequest normalizes to null
    vi.spyOn(service as unknown as { makeRequest: () => Promise<unknown> }, 'makeRequest').mockResolvedValueOnce(null as never);

    const repos = await service.getWatchedRepositories();

    expect(repos).toEqual([]);
  });

  it('normalizes raw license objects into SPDX ids', async () => {
    const service = new GitHubApiService('token');
    const repo = makeRepository(10, 'owner/repo', {
      license: { key: 'mit', name: 'MIT License', spdx_id: 'MIT', url: 'https://api.github.com/licenses/mit', node_id: 'x' } as never,
    });
    vi.spyOn(service as unknown as { makeRequest: () => Promise<unknown> }, 'makeRequest').mockResolvedValueOnce([repo] as never);

    const [result] = await service.getWatchedRepositories();

    expect(result.license).toBe('MIT');
  });

  it('paginates /user/subscriptions only and stops on a partial page', async () => {
    const service = new GitHubApiService('token');
    const makeRequestSpy = vi.spyOn(service as unknown as { makeRequest: () => Promise<unknown> }, 'makeRequest')
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => makeRepository(i + 1, `owner/repo-${i + 1}`)) as never)
      .mockResolvedValueOnce([makeRepository(999, 'owner/last')] as never);

    const repos = await service.getAllWatchedRepositories();

    expect(repos).toHaveLength(101);
    // Pin pagination behavior and endpoint sequence: only /user/subscriptions is used
    // (the old parallel merge of /users/{login}/subscriptions has been removed entirely, enforced by the compiler)
    expect(makeRequestSpy.mock.calls.map((call: unknown[]) => (call[0] as string).split('?')[0])).toEqual([
      '/user/subscriptions',
      '/user/subscriptions',
    ]);
  });
});


describe('GitHubApiService.getRepositoryReleases draft filtering', () => {
  it('excludes draft releases with null publication times from direct GitHub results', async () => {
    const service = new GitHubApiService('token');
    const draft = { ...makeRelease(1, '2026-01-03T00:00:00.000Z'), draft: true, published_at: null };
    const published = makeRelease(2, '2026-01-02T00:00:00.000Z');
    vi.spyOn(service as unknown as { makeRequest: () => Promise<unknown> }, 'makeRequest')
      .mockResolvedValueOnce([draft, published] as never);

    const releases = await service.getRepositoryReleases('owner', 'repo');

    expect(releases).toEqual([expect.objectContaining({ id: published.id, published_at: published.published_at })]);
  });
});


describe('GitHubApiService.searchRepositoryIssues', () => {
  it('strips embedded qualifiers, boolean operators, and prefixed tokens from untrusted keywords', async () => {
    const service = new GitHubApiService('token');
    const makeRequestSpy = vi.spyOn(service as unknown as { makeRequest: () => Promise<unknown> }, 'makeRequest')
      .mockResolvedValueOnce({ total_count: 0, items: [] } as never);

    await service.searchRepositoryIssues('owner', 'repo', [
      'crash repo:other/repo is:pr',
      'OR (repo:github/docs)',
      '-repo:owner/repo',
      'audio crackle',
      'user:someone label:good-first-issue',
      'AND -is:open',
    ]);

    const endpoint = (makeRequestSpy.mock.calls as unknown as Array<[string]>)[0]?.[0] ?? '';
    expect(endpoint.startsWith('/search/issues?q=')).toBe(true);
    // Beyond the fixed repo scope + is:issue, only plain-text keywords may survive:
    // qualifiers (anywhere), parenthesized groups, -/+ prefixes, and boolean operators are all stripped.
    const query = decodeURIComponent(endpoint.slice('/search/issues?q='.length).split('&')[0] ?? '');
    expect(query.split(/\s+/)).toEqual(['repo:owner/repo', 'is:issue', 'crash', 'audio', 'crackle']);
  });

  it('does not call the search endpoint when no plain-text keywords survive sanitization', async () => {
    const service = new GitHubApiService('token');
    const makeRequestSpy = vi.spyOn(service as unknown as { makeRequest: () => Promise<unknown> }, 'makeRequest');

    await expect(service.searchRepositoryIssues('owner', 'repo', [
      'repo:other/repo',
      'OR AND NOT',
      '-is:pr',
      '(repo:github/docs)',
    ])).resolves.toEqual([]);

    // A bare repo+is:issue query would match any Issue in the repo: with no plain-text keywords, no request may be made.
    expect(makeRequestSpy).not.toHaveBeenCalled();
  });

  it('normalizes search hits into bounded issue reads', async () => {
    const service = new GitHubApiService('token');
    vi.spyOn(service as unknown as { makeRequest: () => Promise<unknown> }, 'makeRequest')
      .mockResolvedValueOnce({
        total_count: 1,
        items: [{
          number: 42,
          title: 'App crashes on start',
          state: 'closed',
          html_url: 'https://github.com/owner/repo/issues/42',
          body: 'Crash body',
          comments: 2,
          updated_at: '2026-06-01T00:00:00.000Z',
          labels: [{ name: 'bug' }, { name: 'crash' }],
        }],
      } as never);

    await expect(service.searchRepositoryIssues('owner', 'repo', ['crash'])).resolves.toEqual([{
      number: 42,
      title: 'App crashes on start',
      state: 'closed',
      html_url: 'https://github.com/owner/repo/issues/42',
      body: 'Crash body',
      comments: 2,
      updated_at: '2026-06-01T00:00:00.000Z',
      labels: ['bug', 'crash'],
    }]);
  });
});

describe('GitHubApiService repository chat read APIs', () => {
  it('resolves default branch, immutable head SHA, and a recursive tree through tagged read requests', async () => {
    const service = new GitHubApiService('token');
    const makeRequestSpy = vi.spyOn(service as unknown as { makeRequest: () => Promise<unknown> }, 'makeRequest')
      .mockResolvedValueOnce({ default_branch: 'main' } as never)
      .mockResolvedValueOnce({ sha: 'abcdef1234567890' } as never)
      .mockResolvedValueOnce({ sha: 'tree-sha', truncated: false, tree: [{ path: 'src/App.tsx', type: 'blob', sha: 'file-sha' }] } as never);

    await expect(service.getRepositoryMeta('owner', 'repo')).resolves.toEqual({ defaultBranch: 'main' });
    await expect(service.getRepositoryHeadSha('owner', 'repo', 'main')).resolves.toBe('abcdef1234567890');
    await expect(service.getRepositoryTree('owner', 'repo', 'abcdef1234567890')).resolves.toMatchObject({
      ref: 'abcdef1234567890',
      sha: 'tree-sha',
      truncated: false,
      entries: [{ path: 'src/App.tsx', type: 'blob' }],
    });

    expect(makeRequestSpy.mock.calls.map((call: unknown[]) => call[1])).toEqual([
      { operationTag: 'repository-chat:meta' },
      { operationTag: 'repository-chat:head-sha' },
      { operationTag: 'repository-chat:tree' },
    ]);
  });

  it('reads a text file at the supplied immutable ref and rejects sensitive paths before any request', async () => {
    const service = new GitHubApiService('token');
    const makeRequestSpy = vi.spyOn(service as unknown as { makeRequest: () => Promise<unknown> }, 'makeRequest')
      .mockResolvedValueOnce({
        type: 'file',
        path: 'src/App.tsx',
        sha: 'file-sha',
        size: 20,
        encoding: 'base64',
        content: btoa('export const App = () => null;'),
      } as never);

    await expect(service.getRepositoryFile('owner', 'repo', 'src/App.tsx', 'abcdef1234567890')).resolves.toMatchObject({
      path: 'src/App.tsx',
      ref: 'abcdef1234567890',
      sha: 'file-sha',
      content: 'export const App = () => null;',
    });
    const requestCalls = makeRequestSpy.mock.calls as unknown as Array<[string]>;
    expect(requestCalls[0]?.[0]).toContain('?ref=abcdef1234567890');

    await expect(service.getRepositoryFile('owner', 'repo', '.env.production', 'abcdef1234567890')).rejects.toThrow(/excluded/i);
    await expect(service.getRepositoryFile('owner', 'repo', 'package-lock.json', 'abcdef1234567890')).rejects.toThrow(/excluded/i);
    await expect(service.getRepositoryFile('owner', 'repo', 'config/secrets.json', 'abcdef1234567890')).rejects.toThrow(/excluded/i);
    await expect(service.getRepositoryFile('owner', 'repo', 'config/credentials.json', 'abcdef1234567890')).rejects.toThrow(/excluded/i);
    await expect(service.getRepositoryFile('owner', 'repo', 'keys/private_key.txt', 'abcdef1234567890')).rejects.toThrow(/excluded/i);
    await expect(service.getRepositoryFile('owner', 'repo', 'keys/id_rsa.pub', 'abcdef1234567890')).rejects.toThrow(/excluded/i);
    expect(makeRequestSpy).toHaveBeenCalledTimes(1);
  });

  it('allows a bounded Markdown evidence file at the pinned SHA without weakening the normal file limit or sensitive-path guard', async () => {
    const service = new GitHubApiService('token');
    const largeMarkdown = `# Deployment\n\n${'documented content\n'.repeat(8_000)}`;
    expect(new TextEncoder().encode(largeMarkdown).byteLength).toBeGreaterThan(96 * 1024);
    expect(new TextEncoder().encode(largeMarkdown).byteLength).toBeLessThan(512 * 1024);
    const makeRequestSpy = vi.spyOn(service as unknown as { makeRequest: () => Promise<unknown> }, 'makeRequest')
      .mockResolvedValue({
        type: 'file',
        path: 'docs/deployment.markdown',
        sha: 'markdown-sha',
        size: new TextEncoder().encode(largeMarkdown).byteLength,
        encoding: 'base64',
        content: btoa(largeMarkdown),
      } as never);

    await expect(service.getRepositoryFile('owner', 'repo', 'docs/deployment.markdown', 'abcdef1234567890')).rejects.toThrow(/96 KB/i);
    await expect(service.getRepositoryMarkdownEvidenceFile('owner', 'repo', 'docs/deployment.markdown', 'abcdef1234567890')).resolves.toMatchObject({
      path: 'docs/deployment.markdown',
      ref: 'abcdef1234567890',
      sha: 'markdown-sha',
      content: largeMarkdown,
    });
    await expect(service.getRepositoryMarkdownEvidenceFile('owner', 'repo', 'docs/credentials.md', 'abcdef1234567890')).rejects.toThrow(/excluded/i);
    await expect(service.getRepositoryMarkdownEvidenceFile('owner', 'repo', 'src/main.ts', 'abcdef1234567890')).rejects.toThrow(/not Markdown/i);

    const requestCalls = makeRequestSpy.mock.calls as unknown as Array<[string, { operationTag?: string } | undefined]>;
    expect(requestCalls).toHaveLength(2);
    expect(requestCalls[1]?.[0]).toContain('?ref=abcdef1234567890');
    expect(requestCalls[1]?.[1]).toEqual({ operationTag: 'repository-chat:markdown-evidence' });
  });
});

describe('GitHubApiService 401 source differentiation', () => {
  const makeJsonResponse = (status: number, body: unknown): Response => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? 'Unauthorized' : '',
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response);

  const setBackendProxy = (service: GitHubApiService) => {
    (service as unknown as { backendUrl: string | null }).backendUrl = 'http://localhost:3000/api';
    (service as unknown as { backendAuthToken: string | null }).backendAuthToken = 'secret';
  };

  afterEach(() => {
    vi.mocked(window.fetch).mockReset();
  });

  it('proxy credential 401 (code=UNAUTHORIZED) throws BACKEND_PROXY_UNAUTHORIZED_ERROR', async () => {
    const service = new GitHubApiService('token');
    setBackendProxy(service);
    vi.mocked(window.fetch).mockResolvedValue(makeJsonResponse(401, { error: 'Unauthorized', code: 'UNAUTHORIZED' }));

    await expect(service.getCurrentUser()).rejects.toThrow(BACKEND_PROXY_UNAUTHORIZED_ERROR);
    expect(window.fetch).toHaveBeenCalledWith('http://localhost:3000/api/proxy/github/user', expect.anything());
  });

  it('GitHub 401 forwarded by the proxy (no code marker) still maps to GITHUB_TOKEN_INVALID_ERROR', async () => {
    const service = new GitHubApiService('token');
    setBackendProxy(service);
    vi.mocked(window.fetch).mockResolvedValue(makeJsonResponse(401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com' }));

    await expect(service.getCurrentUser()).rejects.toThrow(GITHUB_TOKEN_INVALID_ERROR);
  });

  it('direct-connect GitHub 401 maps to GITHUB_TOKEN_INVALID_ERROR', async () => {
    const service = new GitHubApiService('token');
    vi.mocked(window.fetch).mockResolvedValue(makeJsonResponse(401, { message: 'Bad credentials' }));

    await expect(service.getCurrentUser()).rejects.toThrow(GITHUB_TOKEN_INVALID_ERROR);
    expect(window.fetch).toHaveBeenCalledWith('https://api.github.com/user', expect.anything());
  });
});
