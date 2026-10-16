import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWatchedSourcesSync } from './useWatchedSourcesSync';

const mocks = vi.hoisted(() => ({
  useAppStore: vi.fn(),
  toast: vi.fn(),
  confirm: vi.fn(),
  getAllWatchedRepositories: vi.fn(),
  setReleaseSourceRepositories: vi.fn(),
}));

vi.mock('../../../store/useAppStore', () => ({
  useAppStore: mocks.useAppStore,
}));

vi.mock('../../../hooks/useDialog', () => ({
  useDialog: () => ({ toast: mocks.toast, confirm: mocks.confirm }),
}));

vi.mock('../../../services/githubApi', () => ({
  GitHubApiService: class {
    getAllWatchedRepositories = mocks.getAllWatchedRepositories;
  },
}));

const createStoreState = () => ({
  // All subscriptions of useWatchedSourcesSync: githubToken / language /
  // setReleaseSourceRepositories single-value selectors + releaseSourceSettings
  // in getState(). Narrow subscription does not touch other release timeline state.
  releaseSourceSettings: {
    enabledSourceIds: ['watch-custom-release'],
    watchCustomReleaseRepos: [
      { full_name: 'owner/watched', html_url: 'https://github.com/owner/watched', release_hidden: true },
    ],
    customReleaseRepos: [],
  },
  githubToken: 'github-token' as string | null,
  language: 'en' as const,
  setReleaseSourceRepositories: mocks.setReleaseSourceRepositories,
});

let storeState = createStoreState();
const mockUseAppStore = vi.mocked(mocks.useAppStore);
mockUseAppStore.mockImplementation((selector?: (state: typeof storeState) => unknown) =>
  selector ? selector(storeState) : storeState);
(mockUseAppStore as unknown as { getState: () => typeof storeState }).getState = () => storeState;

describe('useWatchedSourcesSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState = createStoreState();
  });

  it('returns silently without token or while a sync is running', async () => {
    storeState.githubToken = null;
    const { result } = renderHook(() => useWatchedSourcesSync());
    await act(async () => { await result.current.syncWatchedSources(); });
    expect(mocks.getAllWatchedRepositories).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.setReleaseSourceRepositories).not.toHaveBeenCalled();
  });

  it('maps watched repositories, keeps release_hidden, writes the store and toasts success', async () => {
    mocks.getAllWatchedRepositories.mockResolvedValue([
      {
        id: 1,
        name: 'watched',
        full_name: 'owner/watched',
        html_url: 'https://github.com/owner/watched',
        owner: { login: 'owner', avatar_url: 'https://example.com/a.png' },
        description: 'desc',
        language: 'TypeScript',
        stargazers_count: 5,
        forks_count: 1,
        forks: 1,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
        pushed_at: '2026-01-03T00:00:00.000Z',
        topics: [],
      },
      {
        id: 2,
        name: 'fresh',
        full_name: 'owner/fresh',
        html_url: 'https://github.com/owner/fresh',
        owner: { login: 'owner', avatar_url: 'https://example.com/a.png' },
        description: 'd2',
        language: 'Go',
        stargazers_count: 7,
        forks_count: 2,
        forks: 2,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
        pushed_at: '2026-01-03T00:00:00.000Z',
        topics: [],
      },
    ]);
    const { result } = renderHook(() => useWatchedSourcesSync());
    await act(async () => { await result.current.syncWatchedSources(); });

    expect(mocks.setReleaseSourceRepositories).toHaveBeenCalledTimes(1);
    const [sourceId, repos] = mocks.setReleaseSourceRepositories.mock.calls[0];
    expect(sourceId).toBe('watch-custom-release');
    expect(repos).toHaveLength(2);
    const previouslyHidden = repos.find((repo: { full_name: string }) => repo.full_name === 'owner/watched');
    expect(previouslyHidden.release_hidden).toBe(true);
    const fresh = repos.find((repo: { full_name: string }) => repo.full_name === 'owner/fresh');
    expect(fresh.release_hidden).toBeUndefined();
    expect(mocks.toast).toHaveBeenCalledWith('Synced 2 Watch repositories.', 'success');
    expect(result.current.isSyncingWatchedSources).toBe(false);
  });

  it('reads release_hidden from the latest state after the request resolves', async () => {
    // Simulate user toggling hidden state in settings panel during sync: modify store while await is suspended;
    // sourceRepos written upon completion must keep the toggled value rather than the stale snapshot from invocation.
    let resolveWatched!: (repos: unknown[]) => void;
    mocks.getAllWatchedRepositories.mockImplementation(() => new Promise((resolve) => {
      resolveWatched = resolve;
    }));
    const { result } = renderHook(() => useWatchedSourcesSync());

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.syncWatchedSources();
    });
    await waitFor(() => expect(mocks.getAllWatchedRepositories).toHaveBeenCalled());
    act(() => {
      storeState.releaseSourceSettings = {
        ...storeState.releaseSourceSettings,
        watchCustomReleaseRepos: [
          { full_name: 'owner/watched', html_url: 'https://github.com/owner/watched', release_hidden: false },
        ],
      };
    });
    resolveWatched([
      {
        id: 1,
        name: 'watched',
        full_name: 'owner/watched',
        html_url: 'https://github.com/owner/watched',
        owner: { login: 'owner', avatar_url: 'https://example.com/a.png' },
        description: 'desc',
        language: 'TypeScript',
        stargazers_count: 5,
        forks_count: 1,
        forks: 1,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
        pushed_at: '2026-01-03T00:00:00.000Z',
        topics: [],
      },
    ]);
    await act(async () => { await pending; });

    const repos = mocks.setReleaseSourceRepositories.mock.calls[0][1];
    expect(repos[0].release_hidden).toBeUndefined();
    expect(mocks.toast).toHaveBeenCalledWith('Synced 1 Watch repositories.', 'success');
  });

  it('toasts a failure without writing the store when the api rejects', async () => {
    mocks.getAllWatchedRepositories.mockRejectedValue(new Error('rate limited'));
    const { result } = renderHook(() => useWatchedSourcesSync());
    await act(async () => { await result.current.syncWatchedSources(); });

    expect(mocks.setReleaseSourceRepositories).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith('Failed to sync Watch repositories. Check network or token permissions.', 'error');
    expect(result.current.isSyncingWatchedSources).toBe(false);
  });
});
