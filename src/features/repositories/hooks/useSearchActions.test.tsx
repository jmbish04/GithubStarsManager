import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Category, Repository, VectorSearchConfig } from '../../../types';
import {
  applyListsToRepositories,
  buildSearchPatch,
  countNewStarredRepositories,
  mergeStarredRepositories,
  planListCategories,
  useSearchActions,
} from './useSearchActions';

const mocks = vi.hoisted(() => ({
  useAppStore: vi.fn(),
  toast: vi.fn(),
  embed: vi.fn(),
  vectorQuery: vi.fn(),
  generateHyDEQuery: vi.fn(),
  searchRepositoriesWithSemanticReranking: vi.fn(),
  searchRepositoriesWithSelection: vi.fn(),
  getAllStarredRepositories: vi.fn(),
  getUserLists: vi.fn(),
  forceSyncToBackend: vi.fn(),
}));

vi.mock('../../../store/useAppStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../store/useAppStore')>();
  return { ...actual, useAppStore: mocks.useAppStore };
});

vi.mock('../../../hooks/useDialog', () => ({
  useDialog: () => ({ toast: mocks.toast, confirm: vi.fn() }),
}));

vi.mock('../../../services/vectorSearchService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/vectorSearchService')>();
  return {
    ...actual,
    EmbeddingClient: class {
      embed = mocks.embed;
    },
    VectorSearchService: class {
      query = mocks.vectorQuery;
    },
  };
});

vi.mock('../../../services/aiService', () => ({
  AIService: class {
    generateHyDEQuery = mocks.generateHyDEQuery;
    searchRepositoriesWithSemanticReranking = mocks.searchRepositoriesWithSemanticReranking;
    searchRepositoriesWithSelection = mocks.searchRepositoriesWithSelection;
  },
  isAbortError: (error: unknown) => error instanceof Error && error.name === 'AbortError',
}));

vi.mock('../../../services/githubApi', () => ({
  GitHubApiService: class {
    getAllStarredRepositories = mocks.getAllStarredRepositories;
  },
}));

vi.mock('../../../services/githubApiFactory', () => ({
  createGitHubApiService: () => ({
    getAllStarredRepositories: mocks.getAllStarredRepositories,
  }),
  createGitHubListsApiService: () => ({
    getUserLists: mocks.getUserLists,
  }),
}));

vi.mock('../../../services/autoSync', () => ({
  forceSyncToBackend: mocks.forceSyncToBackend,
}));

const baseRepo = (overrides: Partial<Repository> & { id: number; full_name: string }): Repository => ({
  name: overrides.full_name.split('/')[1] ?? 'repo',
  description: '',
  html_url: `https://github.com/${overrides.full_name}`,
  stargazers_count: 1,
  forks_count: 0,
  forks: 0,
  language: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  pushed_at: '2026-01-03T00:00:00.000Z',
  owner: { login: 'owner', avatar_url: 'https://example.com/a.png' },
  topics: [],
  ...overrides,
});

const createStoreState = () => ({
  repositories: [] as Repository[],
  aiConfigs: [{
    id: 'ai-config',
    name: 'Test AI',
    baseUrl: 'https://example.com/v1',
    apiKey: 'ai-key',
    model: 'ai-model',
  }],
  activeAIConfig: 'ai-config',
  language: 'zh' as const,
  setSearchFilters: vi.fn(),
  setSearchResults: vi.fn(),
  githubToken: 'github-token' as string | null,
  setRepositories: vi.fn(),
  setLastSync: vi.fn(),
  setSyncingStars: vi.fn(),
  syncMode: 'stars-only' as 'stars-only' | 'stars-and-lists',
  user: { login: 'me' } as { login: string } | null,
  addCustomCategory: vi.fn(),
  customCategories: [] as Category[],
  hiddenDefaultCategoryIds: [] as string[],
  defaultCategoryOverrides: {},
  vectorSearchConfig: {
    enabled: false,
    workerUrl: '',
    authToken: '',
    embeddingConfigId: 'emb',
    indexMode: 'description' as const,
    readmeMaxChars: 6000,
  } as VectorSearchConfig,
  embeddingConfigs: [{
    id: 'emb',
    name: 'Test embedding',
    apiType: 'openai-compatible' as const,
    baseUrl: 'https://example.com/v1',
    apiKey: 'emb-key',
    model: 'emb-model',
  }],
});

let storeState = createStoreState();
const mockUseAppStore = vi.mocked(mocks.useAppStore);

const identity = <T,>(repos: T[]): T[] => repos;

// resetAllMocks clears useAppStore's mockImplementation along with everything else, so rebuild each time.
// Use resetAllMocks rather than clearAllMocks: the latter does not reset implementations, causing
// mockRejectedValue etc. to leak into subsequent test cases and create order dependencies.
const setupStoreMocks = () => {
  storeState = createStoreState();
  mockUseAppStore.mockImplementation((selector?: (state: typeof storeState) => unknown) =>
    selector ? selector(storeState) : storeState);
  (mockUseAppStore as unknown as { getState: () => typeof storeState }).getState = () => storeState;
};

describe('useSearchActions.aiSearch (vector hit)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupStoreMocks();
  });

  it('queries with default topK 30 / threshold 0.35, boosts scores and sets the skip ref', async () => {
    storeState.vectorSearchConfig = {
      enabled: true,
      workerUrl: 'https://worker.example',
      authToken: 'worker-token',
      embeddingConfigId: 'emb',
      indexMode: 'description',
      readmeMaxChars: 6000,
      enableHyDE: false,
      enableReranking: false,
    };
    storeState.repositories = [
      baseRepo({ id: 1, full_name: 'owner/foo-bar' }),
      baseRepo({ id: 2, full_name: 'owner/other', description: 'has foo inside' }),
      baseRepo({ id: 3, full_name: 'owner/tagged', topics: [] }),
    ];
    // Pre-seed a local category with the same name as the list so this test doesn't trigger the create category branch
    storeState.customCategories = [{ id: 'custom-1', name: 'MyList', icon: 'x', isCustom: true, keywords: [] }];
    mocks.embed.mockResolvedValue([[0.1, 0.2]]);
    mocks.vectorQuery.mockResolvedValue([
      { id: '1', score: 0.9, metadata: { full_name: 'owner/foo-bar', description: '', tags: [] } },
      { id: '2', score: 0.8, metadata: { full_name: '', description: 'the foo thing', tags: [] } },
      { id: '3', score: 0.7, metadata: { full_name: '', description: '', tags: ['FOO'] } },
    ]);

    const { result } = renderHook(() => useSearchActions());
    await act(async () => { await result.current.aiSearch('foo', identity); });

    expect(mocks.vectorQuery).toHaveBeenCalledWith([0.1, 0.2], { topK: 30, threshold: 0.35 });
    expect(result.current.vectorScoreMapRef.current).toEqual({
      query: 'foo',
      scores: new Map([['1', 0.9 + 0.05], ['2', 0.8 + 0.03], ['3', 0.7 + 0.02]]),
    });
    expect(result.current.skipNextTextSearchRef.current).toBe(true);
    // Descending by score after boosting: 3(0.72+0.02=0.74)? — see below: tag boost 0.02 -> 0.72
    expect(storeState.setSearchResults).toHaveBeenCalledWith([
      storeState.repositories[0],
      storeState.repositories[1],
      storeState.repositories[2],
    ]);
    expect(storeState.setSearchFilters).toHaveBeenCalledWith({ query: 'foo' });
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(result.current.isSearching).toBe(false);
  });

  it('falls back to vector order without a toast when AI reranking fails', async () => {
    storeState.vectorSearchConfig = {
      enabled: true,
      workerUrl: 'https://worker.example',
      authToken: 'worker-token',
      embeddingConfigId: 'emb',
      indexMode: 'description',
      readmeMaxChars: 6000,
      enableHyDE: false,
    };
    storeState.repositories = [
      baseRepo({ id: 1, full_name: 'owner/aaa' }),
      baseRepo({ id: 2, full_name: 'owner/bbb' }),
    ];
    mocks.embed.mockResolvedValue([[0.1]]);
    mocks.vectorQuery.mockResolvedValue([
      { id: '1', score: 0.9, metadata: { full_name: '', description: '', tags: [] } },
      { id: '2', score: 0.8, metadata: { full_name: '', description: '', tags: [] } },
    ]);
    mocks.searchRepositoriesWithSemanticReranking.mockRejectedValue(new Error('rerank down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = renderHook(() => useSearchActions());
    await act(async () => { await result.current.aiSearch('anything', identity); });
    warnSpy.mockRestore();

    expect(mocks.searchRepositoriesWithSemanticReranking).toHaveBeenCalledTimes(1);
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(storeState.setSearchResults).toHaveBeenCalledWith([
      storeState.repositories[0],
      storeState.repositories[1],
    ]);
  });

  it('falls back to the raw query when HyDE misses the 5s budget and aborts the HyDE request', async () => {
    vi.useFakeTimers();
    try {
      storeState.vectorSearchConfig = {
        enabled: true,
        workerUrl: 'https://worker.example',
        authToken: 'worker-token',
        embeddingConfigId: 'emb',
        indexMode: 'description',
        readmeMaxChars: 6000,
        enableHyDE: true,
        enableReranking: false,
      };
      const hydeSignals: AbortSignal[] = [];
      mocks.generateHyDEQuery.mockImplementation((_q: string, signal: AbortSignal) => {
        hydeSignals.push(signal);
        return new Promise<string>(() => undefined);
      });
      mocks.embed.mockResolvedValue([[0.1]]);
      mocks.vectorQuery.mockResolvedValue([]);
      mocks.searchRepositoriesWithSelection.mockResolvedValue([]);

      const { result } = renderHook(() => useSearchActions());
      let promise!: Promise<void>;
      act(() => { promise = result.current.aiSearch('foo', identity); });
      await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
      await act(async () => { await promise; });

      expect(mocks.embed).toHaveBeenCalledWith(['foo'], 'query');
      // After the 5s budget is exhausted, the local HyDE controller must abort the pending request
      expect(hydeSignals[0]?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns early for a blank query without touching search state', async () => {
    const { result } = renderHook(() => useSearchActions());
    await act(async () => { await result.current.aiSearch('   ', identity); });
    expect(mocks.embed).not.toHaveBeenCalled();
    expect(mocks.searchRepositoriesWithSelection).not.toHaveBeenCalled();
    expect(storeState.setSearchResults).not.toHaveBeenCalled();
    expect(storeState.setSearchFilters).not.toHaveBeenCalled();
    expect(result.current.isSearching).toBe(false);
    expect(result.current.skipNextTextSearchRef.current).toBe(false);
  });

  it('falls through to keyword search when the embedding returns no vectors', async () => {
    storeState.vectorSearchConfig = {
      enabled: true,
      workerUrl: 'https://worker.example',
      authToken: 'worker-token',
      embeddingConfigId: 'emb',
      indexMode: 'description',
      readmeMaxChars: 6000,
      enableHyDE: false,
      enableReranking: false,
    };
    storeState.repositories = [
      baseRepo({ id: 1, full_name: 'owner/foo-repo' }),
      baseRepo({ id: 2, full_name: 'owner/bar-repo' }),
    ];
    mocks.embed.mockResolvedValue([]);
    mocks.searchRepositoriesWithSelection.mockResolvedValue([storeState.repositories[0]]);

    const { result } = renderHook(() => useSearchActions());
    await act(async () => { await result.current.aiSearch('foo', identity); });

    expect(mocks.vectorQuery).not.toHaveBeenCalled();
    expect(storeState.setSearchResults).toHaveBeenCalledWith([storeState.repositories[0]]);
    expect(storeState.setSearchFilters).toHaveBeenCalledWith({ query: 'foo' });
  });

  it('falls through to keyword search when vector hits match no local repository', async () => {
    storeState.vectorSearchConfig = {
      enabled: true,
      workerUrl: 'https://worker.example',
      authToken: 'worker-token',
      embeddingConfigId: 'emb',
      indexMode: 'description',
      readmeMaxChars: 6000,
      enableHyDE: false,
      enableReranking: false,
    };
    storeState.repositories = [
      baseRepo({ id: 1, full_name: 'owner/foo-repo' }),
      baseRepo({ id: 2, full_name: 'owner/bar-repo' }),
    ];
    mocks.embed.mockResolvedValue([[0.1]]);
    mocks.vectorQuery.mockResolvedValue([
      { id: '99', score: 0.9, metadata: { full_name: '', description: '', tags: [] } },
    ]);
    mocks.searchRepositoriesWithSelection.mockResolvedValue([storeState.repositories[0]]);

    const { result } = renderHook(() => useSearchActions());
    await act(async () => { await result.current.aiSearch('foo', identity); });

    // When falling into keywordSearch with successful AI selection: results must block the filter effect override, matching the vector path
    expect(result.current.skipNextTextSearchRef.current).toBe(true);
    expect(storeState.setSearchResults).toHaveBeenCalledWith([storeState.repositories[0]]);
    expect(storeState.setSearchFilters).toHaveBeenCalledWith({ query: 'foo' });
  });

  it('falls back to keyword search when the vector pipeline throws', async () => {
    storeState.vectorSearchConfig = {
      enabled: true,
      workerUrl: 'https://worker.example',
      authToken: 'worker-token',
      embeddingConfigId: 'emb',
      indexMode: 'description',
      readmeMaxChars: 6000,
      enableHyDE: false,
      enableReranking: false,
    };
    storeState.repositories = [
      baseRepo({ id: 1, full_name: 'owner/foo-repo' }),
      baseRepo({ id: 2, full_name: 'owner/bar-repo' }),
    ];
    mocks.embed.mockRejectedValue(new Error('embed down'));
    mocks.searchRepositoriesWithSelection.mockResolvedValue([storeState.repositories[0]]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = renderHook(() => useSearchActions());
    await act(async () => { await result.current.aiSearch('foo', identity); });
    warnSpy.mockRestore();

    expect(storeState.setSearchResults).toHaveBeenCalledWith([storeState.repositories[0]]);
    expect(storeState.setSearchFilters).toHaveBeenCalledWith({ query: 'foo' });
    expect(result.current.isSearching).toBe(false);
  });

  it('uses the HyDE output when it resolves within the budget', async () => {
    storeState.vectorSearchConfig = {
      enabled: true,
      workerUrl: 'https://worker.example',
      authToken: 'worker-token',
      embeddingConfigId: 'emb',
      indexMode: 'description',
      readmeMaxChars: 6000,
      enableHyDE: true,
      enableReranking: false,
    };
    mocks.generateHyDEQuery.mockResolvedValue('an ideal description of foo');
    mocks.embed.mockResolvedValue([[0.1]]);
    mocks.vectorQuery.mockResolvedValue([]);
    mocks.searchRepositoriesWithSelection.mockResolvedValue([]);

    const { result } = renderHook(() => useSearchActions());
    await act(async () => { await result.current.aiSearch('foo', identity); });
    expect(mocks.embed).toHaveBeenCalledWith(['an ideal description of foo'], 'query');
  });
});

describe('useSearchActions.keywordSearch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupStoreMocks();
  });

  it('falls back to basic text search when AI selection fails and vector search found nothing', async () => {
    storeState.vectorSearchConfig = {
      enabled: true,
      workerUrl: 'https://worker.example',
      authToken: 'worker-token',
      embeddingConfigId: 'emb',
      indexMode: 'description',
      readmeMaxChars: 6000,
      enableHyDE: false,
    };
    storeState.repositories = [
      baseRepo({ id: 1, full_name: 'owner/foo-repo' }),
      baseRepo({ id: 2, full_name: 'owner/bar-repo' }),
    ];
    mocks.embed.mockResolvedValue([[0.1]]);
    mocks.vectorQuery.mockResolvedValue([]);
    mocks.searchRepositoriesWithSelection.mockRejectedValue(new Error('ai down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = renderHook(() => useSearchActions());
    await act(async () => { await result.current.aiSearch('foo', identity); });
    warnSpy.mockRestore();

    expect(mocks.searchRepositoriesWithSelection).toHaveBeenCalledTimes(1);
    expect(storeState.setSearchResults).toHaveBeenCalledWith([storeState.repositories[0]]);
    expect(storeState.setSearchFilters).toHaveBeenCalledWith({ query: 'foo' });
    // AI failure falls back to basic text search: ordering is not an AI artifact, no need to block SearchBar's filter effect
    expect(result.current.skipNextTextSearchRef.current).toBe(false);
  });

  it('presents an empty result when AI selection explicitly returns no relevant repositories', async () => {
    storeState.vectorSearchConfig = {
      enabled: true,
      workerUrl: 'https://worker.example',
      authToken: 'worker-token',
      embeddingConfigId: 'emb',
      indexMode: 'description',
      readmeMaxChars: 6000,
      enableHyDE: false,
    };
    storeState.repositories = [
      baseRepo({ id: 1, full_name: 'owner/foo-repo' }),
      baseRepo({ id: 2, full_name: 'owner/bar-repo' }),
    ];
    mocks.embed.mockResolvedValue([[0.1]]);
    mocks.vectorQuery.mockResolvedValue([]);
    // Model explicitly determines "no relevant repositories": returning [] is a valid outcome; UI should show empty state rather than noise from the entire repo list
    mocks.searchRepositoriesWithSelection.mockResolvedValue([]);

    const { result } = renderHook(() => useSearchActions());
    await act(async () => { await result.current.aiSearch('完全不相关的东西', identity); });

    expect(storeState.setSearchResults).toHaveBeenCalledWith([]);
    expect(storeState.setSearchFilters).toHaveBeenCalledWith({ query: '完全不相关的东西' });
    // Empty state is an explicit decision by the model and must also block backfilling by SearchBar's filter effect
    expect(result.current.skipNextTextSearchRef.current).toBe(true);
  });

  it('keeps the AI-provided ordering instead of the default star ordering', async () => {
    storeState.vectorSearchConfig = {
      enabled: true,
      workerUrl: 'https://worker.example',
      authToken: 'worker-token',
      embeddingConfigId: 'emb',
      indexMode: 'description',
      readmeMaxChars: 6000,
      enableHyDE: false,
    };
    storeState.repositories = [
      baseRepo({ id: 1, full_name: 'owner/high-star', stargazers_count: 1000 }),
      baseRepo({ id: 2, full_name: 'owner/low-star', stargazers_count: 3 }),
    ];
    mocks.embed.mockResolvedValue([[0.1]]);
    mocks.vectorQuery.mockResolvedValue([]);
    // LLM curation ranks lower-star repos higher: applyFilters star-descending sort must not override this ordering
    mocks.searchRepositoriesWithSelection.mockResolvedValue([
      storeState.repositories[1],
      storeState.repositories[0],
    ]);
    // Simulate SearchBar's real applyFilters: sort descending by stars
    const starSort = (repos: Repository[]) =>
      [...repos].sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0));

    const { result } = renderHook(() => useSearchActions());
    await act(async () => { await result.current.aiSearch('foo', starSort); });

    expect(storeState.setSearchResults).toHaveBeenCalledWith([
      storeState.repositories[1],
      storeState.repositories[0],
    ]);
    // AI result order/subset/empty state must not be overwritten by SearchBar's filter effect using basic text search:
    // keywordSearch needs to set skipNextTextSearchRef, matching the vector path
    expect(result.current.skipNextTextSearchRef.current).toBe(true);
  });

  it('toasts the fallback reason when AI selection reports a failure', async () => {
    storeState.vectorSearchConfig = {
      enabled: true,
      workerUrl: 'https://worker.example',
      authToken: 'worker-token',
      embeddingConfigId: 'emb',
      indexMode: 'description',
      readmeMaxChars: 6000,
      enableHyDE: false,
    };
    storeState.repositories = [
      baseRepo({ id: 1, full_name: 'owner/foo-repo' }),
      baseRepo({ id: 2, full_name: 'owner/bar-repo' }),
    ];
    mocks.embed.mockResolvedValue([[0.1]]);
    mocks.vectorQuery.mockResolvedValue([]);
    // Endpoint jitter / configuration issue: service invokes onFallback with ai_failed; lexical hits are returned as usual
    mocks.searchRepositoriesWithSelection.mockImplementation(
      (_repos: Repository[], _query: string, opts?: { onFallback?: (reason: string) => void }) => {
        opts?.onFallback?.('ai_failed');
        return Promise.resolve([storeState.repositories[0]]);
      },
    );

    const { result } = renderHook(() => useSearchActions());
    await act(async () => { await result.current.aiSearch('foo', identity); });

    expect(mocks.toast).toHaveBeenCalledWith('AI 请求失败，已回退本地词法搜索', 'warning');
    expect(storeState.setSearchResults).toHaveBeenCalledWith([storeState.repositories[0]]);
    // Fallback results (weighted lexical + CJK bigram recall) are superior to filter effect's AND exact string matching;
    // must set skipNextTextSearchRef to prevent being reset by it (CJK queries would be reset to empty)
    expect(result.current.skipNextTextSearchRef.current).toBe(true);
  });

  it('stops quietly without fallback results when the search is cancelled', async () => {
    storeState.vectorSearchConfig = {
      enabled: true,
      workerUrl: 'https://worker.example',
      authToken: 'worker-token',
      embeddingConfigId: 'emb',
      indexMode: 'description',
      readmeMaxChars: 6000,
      enableHyDE: false,
    };
    storeState.repositories = [
      baseRepo({ id: 1, full_name: 'owner/foo-repo' }),
      baseRepo({ id: 2, full_name: 'owner/bar-repo' }),
    ];
    mocks.embed.mockResolvedValue([[0.1]]);
    mocks.vectorQuery.mockResolvedValue([]);
    // Service re-throws AbortError per contract: cancellation is not a failure; hook does not perform basic text fallback
    mocks.searchRepositoriesWithSelection.mockRejectedValue(
      Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }),
    );

    const { result } = renderHook(() => useSearchActions());
    await act(async () => { await result.current.aiSearch('foo', identity); });

    expect(mocks.toast).not.toHaveBeenCalled();
    expect(storeState.setSearchResults).not.toHaveBeenCalled();
    expect(storeState.setSearchFilters).not.toHaveBeenCalled();
    expect(result.current.isSearching).toBe(false);
  });

  it('supersedes an in-flight AI search: the previous signal aborts and writes nothing', async () => {
    storeState.repositories = [
      baseRepo({ id: 1, full_name: 'owner/foo-repo' }),
      baseRepo({ id: 2, full_name: 'owner/bar-repo' }),
    ];
    const signals: Array<AbortSignal | undefined> = [];
    mocks.searchRepositoriesWithSelection.mockImplementation(
      (_repos: Repository[], _query: string, opts?: { signal?: AbortSignal }) => {
        signals.push(opts?.signal);
        // Simulate real in-flight request: reject with AbortError when signal aborts
        return new Promise<Repository[]>((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
          });
        });
      },
    );

    const { result } = renderHook(() => useSearchActions());
    let first!: Promise<void>;
    await act(async () => { first = result.current.aiSearch('first', identity); });
    // Second search (not awaited: simulate still in-flight) aborts the first upon launch
    await act(async () => { result.current.aiSearch('second', identity); });
    // Starting the second search aborts the in-flight controller of the first
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    await act(async () => { await first; });

    // Superseded search must not write results, nor reset isSearching of the second search
    expect(storeState.setSearchResults).not.toHaveBeenCalled();
    expect(result.current.isSearching).toBe(true);
  });

  it('uses basic text search directly when no AI config exists', async () => {
    storeState.aiConfigs = [];
    storeState.repositories = [
      baseRepo({ id: 1, full_name: 'owner/foo-repo' }),
      baseRepo({ id: 2, full_name: 'owner/bar-repo' }),
    ];
    const { result } = renderHook(() => useSearchActions());
    await act(async () => { await result.current.keywordSearch('foo', identity); });

    expect(mocks.searchRepositoriesWithSelection).not.toHaveBeenCalled();
    expect(storeState.setSearchResults).toHaveBeenCalledWith([storeState.repositories[0]]);
  });
});

describe('useSearchActions.syncStars', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupStoreMocks();
  });

  it('keeps the setRepositories → forceSyncToBackend → setLastSync order and applies lists', async () => {
    mocks.getAllStarredRepositories.mockResolvedValue([
      baseRepo({ id: 1, full_name: 'owner/repo-one' }),
    ]);
    mocks.getUserLists.mockResolvedValue([{ id: 'l1', name: 'MyList', isPrivate: false, items: ['owner/repo-one'] }]);
    storeState.repositories = [baseRepo({ id: 1, full_name: 'owner/repo-one' })];
    // Pre-seed a local category with the same name as the list so this test doesn't trigger the create category branch
    storeState.customCategories = [{ id: 'custom-1', name: 'MyList', icon: 'x', isCustom: true, keywords: [] }];

    const { result } = renderHook(() => useSearchActions());
    await act(async () => { await result.current.syncStars('stars-and-lists'); });

    expect(storeState.setRepositories).toHaveBeenCalledTimes(1);
    const written = storeState.setRepositories.mock.calls[0][0] as Repository[];
    expect(written[0].custom_tags).toContain('MyList');
    // List name matches local category of the same name -> set category and lock
    expect(written[0].custom_category).toBe('MyList');
    expect(written[0].category_locked).toBe(true);
    expect(written[0].last_edited).toEqual(expect.any(String));

    const setOrder = storeState.setRepositories.mock.invocationCallOrder[0];
    const syncOrder = mocks.forceSyncToBackend.mock.invocationCallOrder[0];
    const lastSyncOrder = storeState.setLastSync.mock.invocationCallOrder[0];
    expect(setOrder).toBeLessThan(syncOrder);
    expect(syncOrder).toBeLessThan(lastSyncOrder);

    expect(mocks.toast).toHaveBeenCalledWith(
      '已同步 1 个 list，并应用到 1 个未锁定仓库：MyList(1)',
      'info',
    );
    expect(mocks.toast).toHaveBeenCalledWith('同步完成！所有仓库都是最新的。', 'info');
    expect(storeState.setSyncingStars).toHaveBeenCalledWith(true);
    expect(storeState.setSyncingStars).toHaveBeenLastCalledWith(false);
  });

  it('creates missing categories for cloud lists', async () => {
    mocks.getAllStarredRepositories.mockResolvedValue([baseRepo({ id: 1, full_name: 'owner/repo-one' })]);
    mocks.getUserLists.mockResolvedValue([{ id: 'l1', name: 'BrandNewList', isPrivate: false, items: ['owner/repo-one'] }]);
    storeState.repositories = [baseRepo({ id: 1, full_name: 'owner/repo-one' })];

    const { result } = renderHook(() => useSearchActions());
    await act(async () => { await result.current.syncStars('stars-and-lists'); });

    expect(storeState.addCustomCategory).toHaveBeenCalledTimes(1);
    const created = storeState.addCustomCategory.mock.calls[0][0];
    expect(created.name).toBe('BrandNewList');
    expect(created.id).toMatch(/^custom-sync-\d+-0$/);
    expect(created.isCustom).toBe(true);
    expect(mocks.toast).toHaveBeenCalledWith(
      '已同步 1 个 list，并应用到 1 个未锁定仓库：BrandNewList(1)（新建 1 个分类）',
      'info',
    );
  });

  it('keeps the starred sync result when the list sync fails', async () => {
    mocks.getAllStarredRepositories.mockResolvedValue([baseRepo({ id: 1, full_name: 'owner/repo-one' })]);
    mocks.getUserLists.mockRejectedValue(new Error('lists unavailable'));
    storeState.repositories = [baseRepo({ id: 1, full_name: 'owner/repo-one' })];

    const { result } = renderHook(() => useSearchActions());
    await act(async () => { await result.current.syncStars('stars-and-lists'); });

    expect(mocks.toast).toHaveBeenCalledWith(
      'List 同步失败，星标仓库已同步。请稍后重试，或检查 GitHub Token 权限（需 user scope）。',
      'error',
    );
    expect(storeState.setRepositories).toHaveBeenCalledWith([
      expect.objectContaining({ id: 1, full_name: 'owner/repo-one' }),
    ]);
    expect(mocks.forceSyncToBackend).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith('同步完成！所有仓库都是最新的。', 'info');
  });

  it('syncs lists when auto mode follows the stars-and-lists config', async () => {
    mocks.getAllStarredRepositories.mockResolvedValue([baseRepo({ id: 1, full_name: 'owner/repo-one' })]);
    mocks.getUserLists.mockResolvedValue([{ id: 'l1', name: 'MyList', isPrivate: false, items: ['owner/repo-one'] }]);
    storeState.repositories = [baseRepo({ id: 1, full_name: 'owner/repo-one' })];
    storeState.syncMode = 'stars-and-lists';
    storeState.customCategories = [{ id: 'custom-1', name: 'MyList', icon: 'x', isCustom: true, keywords: [] }];

    const { result } = renderHook(() => useSearchActions());
    await act(async () => { await result.current.syncStars(); }); // mode 'auto'

    expect(mocks.getUserLists).toHaveBeenCalledTimes(1);
    const written = storeState.setRepositories.mock.calls[0][0] as Repository[];
    expect(written[0].custom_tags).toContain('MyList');
  });

  it('keeps the starred result and toasts the list failure when the user login is missing', async () => {
    mocks.getAllStarredRepositories.mockResolvedValue([baseRepo({ id: 1, full_name: 'owner/repo-one' })]);
    storeState.user = null;

    const { result } = renderHook(() => useSearchActions());
    await act(async () => { await result.current.syncStars('stars-and-lists'); });

    expect(mocks.getUserLists).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      'List 同步失败，星标仓库已同步。请稍后重试，或检查 GitHub Token 权限（需 user scope）。',
      'error',
    );
    expect(storeState.setRepositories).toHaveBeenCalledWith([
      expect.objectContaining({ id: 1, full_name: 'owner/repo-one' }),
    ]);
    expect(mocks.forceSyncToBackend).toHaveBeenCalledTimes(1);
  });

  it('toasts the created-categories summary when no list item matches a local repo', async () => {
    mocks.getAllStarredRepositories.mockResolvedValue([baseRepo({ id: 1, full_name: 'owner/repo-one' })]);
    mocks.getUserLists.mockResolvedValue([{ id: 'l1', name: 'BrandNewList', isPrivate: false, items: [] }]);
    storeState.repositories = [baseRepo({ id: 1, full_name: 'owner/repo-one' })];

    const { result } = renderHook(() => useSearchActions());
    await act(async () => { await result.current.syncStars('stars-and-lists'); });

    expect(storeState.addCustomCategory).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith('已同步 1 个 list（新建 1 个分类）。', 'info');
  });

  it('toasts the new-repositories count when the sync finds unseen repos', async () => {
    storeState.repositories = [baseRepo({ id: 1, full_name: 'owner/repo-one' })];
    mocks.getAllStarredRepositories.mockResolvedValue([
      baseRepo({ id: 1, full_name: 'owner/repo-one' }),
      baseRepo({ id: 2, full_name: 'owner/repo-two' }),
    ]);

    const { result } = renderHook(() => useSearchActions());
    await act(async () => { await result.current.syncStars('stars-only'); });

    expect(mocks.toast).toHaveBeenCalledWith('同步完成！发现 1 个新仓库。', 'success');
  });

  it('shows the token-expired message when the sync error mentions token', async () => {
    mocks.getAllStarredRepositories.mockRejectedValue(new Error('Bad credentials: token expired'));
    const { result } = renderHook(() => useSearchActions());
    await act(async () => { await result.current.syncStars(); });

    expect(mocks.toast).toHaveBeenCalledWith('GitHub token 已过期或无效，请重新登录。', 'error');
    expect(storeState.setRepositories).not.toHaveBeenCalled();
  });

  it('toasts the token-missing message before doing anything', async () => {
    storeState.githubToken = null;
    const { result } = renderHook(() => useSearchActions());
    await act(async () => { await result.current.syncStars(); });
    expect(mocks.toast).toHaveBeenCalledWith('GitHub token 未找到，请重新登录。', 'error');
    expect(mocks.getAllStarredRepositories).not.toHaveBeenCalled();
    expect(storeState.setSyncingStars).not.toHaveBeenCalled();
  });
});

describe('useSearchActions pure helpers', () => {
  it('buildSearchPatch applies name/desc/tag boosts', () => {
    const scores = buildSearchPatch('foo', [
      { id: '1', score: 0.9, metadata: { full_name: 'x/foo', description: '', language: '', stars: 0, tags: [] } },
      { id: '2', score: 0.8, metadata: { full_name: '', description: 'a foo b', language: '', stars: 0, tags: [] } },
      { id: '3', score: 0.7, metadata: { full_name: '', description: '', language: '', stars: 0, tags: ['FOO'] } },
      { id: '4', score: 0.6, metadata: { full_name: '', description: '', language: '', stars: 0, tags: [] } },
    ]);
    expect(scores.get('1')).toBe(0.9 + 0.05);
    expect(scores.get('2')).toBe(0.8 + 0.03);
    expect(scores.get('3')).toBe(0.7 + 0.02);
    expect(scores.get('4')).toBe(0.6);
  });

  it('mergeStarredRepositories overwrites syncable fields and backfills license null', () => {
    const storeRepos = [
      baseRepo({ id: 1, full_name: 'owner/one', description: 'old', license: 'MIT', custom_tags: ['keep'] }),
      baseRepo({ id: 2, full_name: 'owner/two' }),
    ];
    const newRepos = [
      baseRepo({ id: 1, full_name: 'owner/one', description: 'new', stargazers_count: 99, license: undefined }),
      baseRepo({ id: 3, full_name: 'owner/three' }),
    ];
    const merged = mergeStarredRepositories(newRepos, storeRepos);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ id: 1, description: 'new', stargazers_count: 99, custom_tags: ['keep'], license: null });
    expect(merged[1]).toMatchObject({ id: 3 });
  });

  it('mergeStarredRepositories keeps AI analysis when a batch-starred repo only matches by full_name', () => {
    // Regression: repositories starred in batch from links used to be assigned synthetic ids that didn't match real GitHub ids.
    // Matching only by id would mismatch and adopt raw GitHub data entirely, wiping AI analysis and category tags.
    const storeRepos = [
      baseRepo({
        id: 1_700_000_000_123,
        full_name: 'owner/batch-starred',
        ai_summary: 'AI 摘要',
        ai_tags: ['ai-tag'],
        ai_platforms: ['cli'],
        analyzed_at: '2026-02-01T00:00:00.000Z',
        custom_category: '工具',
        category_locked: true,
      }),
    ];
    const newRepos = [
      baseRepo({ id: 987_654_321, full_name: 'owner/batch-starred', description: '来自 GitHub 的新描述' }),
    ];

    const merged = mergeStarredRepositories(newRepos, storeRepos);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      // Local AI analysis and category tags must be retained
      ai_summary: 'AI 摘要',
      ai_tags: ['ai-tag'],
      ai_platforms: ['cli'],
      analyzed_at: '2026-02-01T00:00:00.000Z',
      custom_category: '工具',
      category_locked: true,
      // GitHub source metadata is still refreshed
      description: '来自 GitHub 的新描述',
    });
  });

  it('matches the full_name fallback case-insensitively', () => {
    // Synthetic ids (>=1e11) represent legacy batch-starred records and are eligible for name fallback
    const storeRepos = [
      baseRepo({ id: 1_700_000_000_555, full_name: 'Owner/Mixed-Case', ai_summary: 'AI 摘要' }),
    ];
    const merged = mergeStarredRepositories(
      [baseRepo({ id: 42, full_name: 'owner/mixed-case' })],
      storeRepos,
    );

    expect(merged[0]).toMatchObject({ ai_summary: 'AI 摘要' });
  });

  it('does not let a different repo inherit analysis by reusing a real-id repo name', () => {
    // Regression (CodeRabbit security review): when a local record has a **real GitHub id**, identity is authoritative.
    // If that repository was renamed/deleted, the old name might be reused by a new repository. Falling back by name
    // would cause the new repository to inherit the old repository's AI analysis, locked category, and subscription (misattribution).
    const storeRepos = [
      baseRepo({
        id: 555,
        full_name: 'owner/old',
        ai_summary: '机密分析',
        custom_category: '内部工具',
        category_locked: true,
        subscribed_to_releases: true,
      }),
    ];
    // Another new repository that happens to reuse the old name, with a different id
    const newRepos = [baseRepo({ id: 777, full_name: 'owner/old' })];

    const merged = mergeStarredRepositories(newRepos, storeRepos);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 777, full_name: 'owner/old' });
    expect(merged[0].ai_summary).toBeUndefined();
    expect(merged[0].custom_category).toBeUndefined();
    expect(merged[0].category_locked).toBeUndefined();
    expect(merged[0].subscribed_to_releases).toBeUndefined();
    // The repository reusing the old name is genuinely new
    expect(countNewStarredRepositories(newRepos, storeRepos)).toBe(1);
  });

  it('still repairs legacy synthetic-id records by name fallback', () => {
    // The positive fallback scenario must not be broken by the hardening above: synthetic-id records should still be claimed and have analysis restored
    const storeRepos = [
      baseRepo({
        id: 1_700_000_000_999,
        full_name: 'owner/legacy',
        ai_summary: 'AI 摘要',
        custom_category: '工具',
      }),
    ];
    const newRepos = [baseRepo({ id: 321, full_name: 'owner/legacy' })];

    const merged = mergeStarredRepositories(newRepos, storeRepos);

    expect(merged[0]).toMatchObject({
      ai_summary: 'AI 摘要',
      custom_category: '工具',
    });
    expect(countNewStarredRepositories(newRepos, storeRepos)).toBe(0);
  });

  it('assigns each local record to at most one incoming repository', () => {
    // 两条输入都只能靠名称兜底命中同一条本地记录时，必须一对一：
    // 第二条视为新增，不得复制本地记录的 AI 数据。
    const storeRepos = [
      baseRepo({ id: 1_700_000_000_100, full_name: 'owner/legacy', ai_summary: 'AI 摘要' }),
    ];
    const newRepos = [
      baseRepo({ id: 201, full_name: 'owner/legacy' }),
      baseRepo({ id: 202, full_name: 'OWNER/LEGACY' }),
    ];

    const merged = mergeStarredRepositories(newRepos, storeRepos);

    expect(merged).toHaveLength(2);
    const matched = merged.filter(repo => repo.ai_summary === 'AI 摘要');
    expect(matched).toHaveLength(1);
    expect(countNewStarredRepositories(newRepos, storeRepos)).toBe(1);
  });

  it('counts a full_name-matched legacy repo as existing, not new', () => {
    // 回归：计数若只按 id 匹配，被 full_name 兜底救回的存量仓库会被误报为
    // 「发现 N 个新仓库」。此处锁定与合并一致的口径。
    const storeRepos = [
      baseRepo({ id: 1_700_000_000_123, full_name: 'owner/legacy', ai_summary: 'AI 摘要' }),
      baseRepo({ id: 2, full_name: 'owner/unchanged' }),
    ];
    const newRepos = [
      baseRepo({ id: 987_654_321, full_name: 'owner/legacy' }),
      baseRepo({ id: 2, full_name: 'owner/unchanged' }),
      baseRepo({ id: 3, full_name: 'owner/brand-new' }),
    ];

    expect(countNewStarredRepositories(newRepos, storeRepos)).toBe(1);
    expect(countNewStarredRepositories([], storeRepos)).toBe(0);
    expect(countNewStarredRepositories(newRepos, [])).toBe(3);
  });

  it('does not let a renamed repo and a name-reusing repo share one local record', () => {
    // 回归（CodeRabbit）：GitHub 允许新仓库复用刚改完名的旧仓库名。
    // 本地 { id: 1, owner/old }，输入含改名的 { id: 1, owner/new } 与
    // 复用旧名的 { id: 2, owner/old }。单遍匹配会让两条输入都命中同一条本地
    // 记录 → 产出两条 id:1，并把旧仓库的 AI 字段复制到新仓库上。
    const storeRepos = [
      baseRepo({
        id: 1,
        full_name: 'owner/old',
        ai_summary: '旧仓库的 AI 摘要',
        custom_category: '工具',
      }),
    ];
    const newRepos = [
      baseRepo({ id: 1, full_name: 'owner/new' }),
      baseRepo({ id: 2, full_name: 'owner/old' }),
    ];

    const merged = mergeStarredRepositories(newRepos, storeRepos);

    // id 必须唯一，不能出现两条 id:1
    expect(merged.map(repo => repo.id)).toEqual([1, 2]);
    // 改名的仓库沿用本地 AI 数据（id 匹配）
    expect(merged[0]).toMatchObject({
      full_name: 'owner/new',
      ai_summary: '旧仓库的 AI 摘要',
      custom_category: '工具',
    });
    // 复用旧名的新仓库是真正的新增，不得继承旧仓库的 AI 数据与分类
    expect(merged[1]).toMatchObject({ id: 2, full_name: 'owner/old' });
    expect(merged[1].ai_summary).toBeUndefined();
    expect(merged[1].custom_category).toBeUndefined();
    // 计数应为 1（复用旧名的新仓库）
    expect(countNewStarredRepositories(newRepos, storeRepos)).toBe(1);
  });

  it('does not depend on input order when resolving name fallbacks', () => {
    const storeRepos = [
      baseRepo({ id: 1, full_name: 'owner/old', ai_summary: '旧仓库的 AI 摘要' }),
    ];
    const renamed = baseRepo({ id: 1, full_name: 'owner/new' });
    const reuse = baseRepo({ id: 2, full_name: 'owner/old' });

    const forward = mergeStarredRepositories([renamed, reuse], storeRepos);
    const reversed = mergeStarredRepositories([reuse, renamed], storeRepos);

    // 无论输入顺序如何，按 id 对齐后的结果必须一致
    const byId = (list: Repository[]) => new Map(list.map(r => [r.id, r]));
    const f = byId(forward);
    const r = byId(reversed);

    expect(f.get(1)?.full_name).toBe('owner/new');
    expect(f.get(1)?.ai_summary).toBe('旧仓库的 AI 摘要');
    expect(r.get(1)?.full_name).toBe('owner/new');
    expect(r.get(1)?.ai_summary).toBe('旧仓库的 AI 摘要');
    // 两条路径下复用旧名的仓库都不应拿到旧仓库的 AI 数据
    expect(f.get(2)?.ai_summary).toBeUndefined();
    expect(r.get(2)?.ai_summary).toBeUndefined();
    expect(countNewStarredRepositories([reuse, renamed], storeRepos)).toBe(1);
  });

  it('planListCategories skips reserved names and existing categories', () => {
    const { toCreate, categoryByLowerName } = planListCategories(
      [
        { id: 'l1', name: 'fresh', isPrivate: false, items: [] },
        { id: 'l2', name: 'none', isPrivate: false, items: [] },
        { id: 'l3', name: 'existing', isPrivate: false, items: [] },
      ],
      [{ id: 'c1', name: 'Existing', icon: '', isCustom: false, keywords: [] }],
      (idx) => `custom-sync-123-${idx}`,
    );
    expect(toCreate).toEqual([
      { id: 'custom-sync-123-0', name: 'fresh', icon: ' 📋', isCustom: true, keywords: [] },
    ]);
    expect(categoryByLowerName.get('fresh')).toBe('fresh');
    expect(categoryByLowerName.get('existing')).toBe('Existing');
    expect(categoryByLowerName.has('none')).toBe(false);
  });

  it('applyListsToRepositories tags, locks by category and respects pre-existing locks', () => {
    const categoryByLowerName = new Map([['web apps', 'Web Apps']]);
    const repositories = [
      baseRepo({ id: 1, full_name: 'owner/locked-early', category_locked: true, custom_category: 'Web Apps' }),
      baseRepo({ id: 2, full_name: 'owner/normal' }),
    ];
    const lists = [
      { id: 'l1', name: 'Web Apps', isPrivate: false, items: ['owner/locked-early', 'owner/normal'] },
      { id: 'l2', name: 'Second List', isPrivate: false, items: ['owner/normal'] },
    ];
    const { repositories: mapped, appliedTagsCount } = applyListsToRepositories(repositories, lists, categoryByLowerName);

    // 预存在锁定：仅追加标签，不改分类/锁定
    expect(mapped[0]).toMatchObject({ custom_tags: ['Web Apps'], custom_category: 'Web Apps', category_locked: true });
    expect(mapped[0].last_edited).toBeUndefined();
    // 正常仓库：第一个 list 命中分类 → 设分类并加锁；第二个 list 时仓库已被锁定 → 仅追加标签
    expect(mapped[1]).toMatchObject({ custom_tags: ['Web Apps', 'Second List'], custom_category: 'Web Apps', category_locked: true });
    expect(mapped[1].last_edited).toEqual(expect.any(String));
    expect(appliedTagsCount).toEqual({ 'Web Apps': 2, 'Second List': 1 });
  });
});
