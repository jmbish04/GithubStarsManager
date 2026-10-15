import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveryRepo } from '../../../types';
import { discoveryRepoToRepository, useDiscoveryRepoActions } from './useDiscoveryRepoActions';

const mocks = vi.hoisted(() => ({
  useAppStore: vi.fn(),
  getAllCategories: vi.fn(() => []),
  toast: vi.fn(),
  analyzeRepository: vi.fn(),
  createFailedAnalysisResult: vi.fn((error: string) => ({
    analyzed_at: '2026-08-25T00:00:00.000Z',
    analysis_failed: true,
    analysis_error: error,
  })),
  forceSyncToBackend: vi.fn(),
  starRepository: vi.fn(),
  unstarRepository: vi.fn(),
}));

vi.mock('../../../store/useAppStore', () => ({
  useAppStore: mocks.useAppStore,
  getAllCategories: mocks.getAllCategories,
}));

vi.mock('../../../hooks/useDialog', () => ({
  useDialog: () => ({ toast: mocks.toast, confirm: vi.fn() }),
}));

vi.mock('../../../services/aiAnalysisHelper', () => ({
  analyzeRepository: mocks.analyzeRepository,
  createFailedAnalysisResult: mocks.createFailedAnalysisResult,
}));

vi.mock('../../../services/autoSync', () => ({
  forceSyncToBackend: mocks.forceSyncToBackend,
}));

vi.mock('../../../services/githubApi', () => ({
  GitHubApiService: class {
    starRepository = mocks.starRepository;
    unstarRepository = mocks.unstarRepository;
  },
}));

const repo: DiscoveryRepo = {
  id: 7,
  name: 'discovered-repo',
  full_name: 'owner/discovered-repo',
  description: 'A discovered repository',
  html_url: 'https://github.com/owner/discovered-repo',
  stargazers_count: 512,
  forks_count: 12,
  forks: 12,
  language: 'TypeScript',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  pushed_at: '2026-01-03T00:00:00.000Z',
  owner: { login: 'owner', avatar_url: 'https://example.com/avatar.png' },
  topics: ['test'],
  rank: 3,
  channel: 'trending',
  platform: 'Macos',
};

const createStoreState = () => ({
  githubToken: 'github-token' as string | null,
  aiConfigs: [{
    id: 'ai-config',
    name: 'Test AI',
    baseUrl: 'https://example.com/v1',
    apiKey: 'ai-key',
    model: 'ai-model',
  }] as Array<{ id: string; name: string; baseUrl?: string; apiKey?: string; model?: string; apiKeyStatus?: 'ok' | 'decrypt_failed' | 'empty' }>,
  activeAIConfig: 'ai-config',
  language: 'en' as const,
  customCategories: [],
  repositories: [] as { id: number; full_name: string }[],
  updateDiscoveryRepo: vi.fn(),
  addRepository: vi.fn(),
  deleteRepository: vi.fn(),
});

let storeState = createStoreState();
const mockUseAppStore = vi.mocked(mocks.useAppStore);
mockUseAppStore.mockImplementation((selector?: (state: typeof storeState) => unknown) =>
  selector ? selector(storeState) : storeState);
(mockUseAppStore as unknown as { getState: () => typeof storeState }).getState = () => storeState;

describe('useDiscoveryRepoActions.analyze', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState = createStoreState();
  });

  it('runs the four validations in order with the card-specific wording', async () => {
    storeState.githubToken = null;
    const { result, rerender } = renderHook(() => useDiscoveryRepoActions({ repo }));
    await act(async () => { await result.current.analyze(); });
    expect(mocks.toast).toHaveBeenNthCalledWith(1, 'GitHub token not found. Please login again.', 'error');

    storeState.githubToken = 'github-token';
    storeState.aiConfigs = [];
    rerender();
    await act(async () => { await result.current.analyze(); });
    expect(mocks.toast).toHaveBeenNthCalledWith(2, 'Please configure AI service in settings first.', 'error');

    storeState.aiConfigs = [{
      id: 'ai-config',
      name: 'Broken',
      baseUrl: 'https://example.com/v1',
      apiKey: 'ai-key',
      model: 'ai-model',
      apiKeyStatus: 'decrypt_failed',
    }];
    rerender();
    await act(async () => { await result.current.analyze(); });
    expect(mocks.toast).toHaveBeenNthCalledWith(3, 'The AI service API key could not be decrypted or is empty. Please re-enter and save the configuration in settings.', 'error');

    storeState.aiConfigs = [{ id: 'ai-config', name: 'Incomplete', baseUrl: '', apiKey: '', model: '' }];
    rerender();
    await act(async () => { await result.current.analyze(); });
    expect(mocks.toast).toHaveBeenNthCalledWith(4, 'AI service configuration is incomplete. Please check the API endpoint, key, and model name.', 'error');
    expect(mocks.analyzeRepository).not.toHaveBeenCalled();
    expect(mocks.forceSyncToBackend).not.toHaveBeenCalled();
  });

  it('patches success fields without custom_category and without force sync; forwards onAnalyzed', async () => {
    mocks.analyzeRepository.mockResolvedValue({
      summary: 'AI summary',
      tags: ['tag'],
      platforms: ['cli'],
      analyzed_at: '2026-09-05T00:00:00.000Z',
      analysis_failed: false,
    });
    const onAnalyzed = vi.fn();
    const { result } = renderHook(() => useDiscoveryRepoActions({ repo }));
    await act(async () => { await result.current.analyze(onAnalyzed); });

    expect(storeState.updateDiscoveryRepo).toHaveBeenCalledTimes(1);
    const patch = storeState.updateDiscoveryRepo.mock.calls[0][0] as DiscoveryRepo;
    expect(patch).toEqual({
      ...repo,
      ai_summary: 'AI summary',
      ai_tags: ['tag'],
      ai_platforms: ['cli'],
      analyzed_at: '2026-09-05T00:00:00.000Z',
      analysis_failed: false,
      analysis_error: undefined,
    });
    expect('custom_category' in patch).toBe(false);
    expect('category_locked' in patch).toBe(false);
    expect(onAnalyzed).toHaveBeenCalledWith(patch);
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.forceSyncToBackend).not.toHaveBeenCalled();
  });

  it('stores the failure result and toasts on analysis error', async () => {
    mocks.analyzeRepository.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useDiscoveryRepoActions({ repo }));
    await act(async () => { await result.current.analyze(); });

    expect(mocks.createFailedAnalysisResult).toHaveBeenCalledWith('network down');
    expect(storeState.updateDiscoveryRepo).toHaveBeenCalledWith({
      ...repo,
      analyzed_at: '2026-08-25T00:00:00.000Z',
      analysis_failed: true,
      analysis_error: 'network down',
    });
    expect(mocks.toast).toHaveBeenCalledWith('AI analysis failed. Please check your AI configuration.', 'error');
  });

  it('stays silent after unmount aborts an in-flight analysis', async () => {
    let rejectAnalysis!: (error: Error) => void;
    mocks.analyzeRepository.mockImplementation(({ signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        rejectAnalysis = (error: Error) => {
          if (signal.aborted) {
            reject(error);
          }
        };
      }),
    );
    const { result, unmount } = renderHook(() => useDiscoveryRepoActions({ repo }));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.analyze();
    });
    unmount();
    rejectAnalysis(new Error('Aborted'));
    await act(async () => { await pending.catch(() => undefined); });

    expect(storeState.updateDiscoveryRepo).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});

describe('useDiscoveryRepoActions.star', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState = createStoreState();
  });

  it('keeps the optimistic → remote → addRepository → onStar → forceSync → clear → toast order', async () => {
    mocks.starRepository.mockResolvedValue(undefined);
    const onStar = vi.fn();
    const { result } = renderHook(() => useDiscoveryRepoActions({ repo }));
    await act(async () => { await result.current.star(onStar); });

    expect(mocks.starRepository).toHaveBeenCalledWith('owner', 'discovered-repo');
    expect(storeState.addRepository).toHaveBeenCalledTimes(1);
    const added = storeState.addRepository.mock.calls[0][0];
    expect(added).toEqual({
      ...repo,
      rank: undefined,
      channel: undefined,
      platform: undefined,
      starred_at: expect.any(String),
    });
    expect(onStar).toHaveBeenCalledWith(repo);

    const starRepoOrder = mocks.starRepository.mock.invocationCallOrder[0];
    const addOrder = storeState.addRepository.mock.invocationCallOrder[0];
    const onStarOrder = onStar.mock.invocationCallOrder[0];
    const syncOrder = mocks.forceSyncToBackend.mock.invocationCallOrder[0];
    expect(starRepoOrder).toBeLessThan(addOrder);
    expect(addOrder).toBeLessThan(onStarOrder);
    expect(onStarOrder).toBeLessThan(syncOrder);

    expect(result.current.optimisticStarred).toBeNull();
    expect(mocks.toast).toHaveBeenCalledWith('Successfully starred', 'success');
  });

  it('rolls back the optimistic state and toasts when starring fails', async () => {
    let rejectStar!: (error: Error) => void;
    mocks.starRepository.mockImplementation(() => new Promise((_resolve, reject) => {
      rejectStar = reject;
    }));
    storeState.repositories = [{ id: 1, full_name: 'other/repo' }];
    const { result } = renderHook(() => useDiscoveryRepoActions({ repo }));

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.star();
    });
    await waitFor(() => expect(result.current.optimisticStarred).toBe(true));

    rejectStar(new Error('network'));
    await act(async () => { await pending; });

    expect(result.current.optimisticStarred).toBeNull();
    expect(storeState.addRepository).not.toHaveBeenCalled();
    expect(mocks.forceSyncToBackend).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith('Failed to star repository. Please check your network connection or GitHub Token permissions.', 'error');
  });

  it('adds the repository for a repo that is not yet starred', async () => {
    mocks.starRepository.mockResolvedValue(undefined);
    const { result } = renderHook(() => useDiscoveryRepoActions({ repo }));
    expect(result.current.isStarred).toBe(false);
    await act(async () => { await result.current.star(); });
    expect(storeState.addRepository).toHaveBeenCalledTimes(1);
    expect(storeState.addRepository.mock.calls[0][0]).toMatchObject({
      id: repo.id,
      full_name: repo.full_name,
      rank: undefined,
      channel: undefined,
      platform: undefined,
      starred_at: expect.any(String),
    });
    expect(result.current.isStarred).toBe(false); // repositories fixture does not contain repo; optimistic state is cleared
    expect(result.current.isStarring).toBe(false);
  });
});

describe('useDiscoveryRepoActions.executeUnstar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState = createStoreState();
  });

  it('deletes the local repository sharing the GitHub id, forces sync, and never toasts on success', async () => {
    mocks.unstarRepository.mockResolvedValue(undefined);
    // Same GitHub identity: local record and discovery entry share the same id
    storeState.repositories = [{ id: repo.id, full_name: repo.full_name }];
    const { result, rerender } = renderHook(() => useDiscoveryRepoActions({ repo }));
    rerender();
    expect(result.current.isStarred).toBe(true);

    await act(async () => { await result.current.executeUnstar(); });

    expect(mocks.unstarRepository).toHaveBeenCalledWith('owner', 'discovered-repo');
    expect(storeState.deleteRepository).toHaveBeenCalledWith(repo.id);
    const unstarOrder = mocks.unstarRepository.mock.invocationCallOrder[0];
    const deleteOrder = storeState.deleteRepository.mock.invocationCallOrder[0];
    const syncOrder = mocks.forceSyncToBackend.mock.invocationCallOrder[0];
    expect(unstarOrder).toBeLessThan(deleteOrder);
    expect(deleteOrder).toBeLessThan(syncOrder);
    expect(result.current.optimisticStarred).toBeNull();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('deletes a legacy synthetic-id record by name fallback', async () => {
    mocks.unstarRepository.mockResolvedValue(undefined);
    // Legacy synthetic id record from batch star: id differs from discovery, but lacks authoritative identity so claimed by name
    const legacyId = 1_700_000_000_042;
    storeState.repositories = [{ id: legacyId, full_name: repo.full_name }];
    const { result, rerender } = renderHook(() => useDiscoveryRepoActions({ repo }));
    rerender();
    expect(result.current.isStarred).toBe(true);

    await act(async () => { await result.current.executeUnstar(); });

    expect(storeState.deleteRepository).toHaveBeenCalledWith(legacyId);
  });

  it('does not delete an unrelated record that merely reuses the name', async () => {
    // Regression: local record with real id is a "renamed/deleted old repo" whose old name is reused by current
    // discovery entry. They are not the same repo — must not falsely judge as already starred, nor delete the wrong record.
    mocks.unstarRepository.mockResolvedValue(undefined);
    storeState.repositories = [{ id: 999, full_name: repo.full_name }];
    const { result, rerender } = renderHook(() => useDiscoveryRepoActions({ repo }));
    rerender();

    // Should not be falsely considered already in store
    expect(result.current.isStarred).toBe(false);

    await act(async () => { await result.current.executeUnstar(); });

    // Unstar target is id 7, unrelated to local id 999; must not delete this record
    expect(storeState.deleteRepository).not.toHaveBeenCalled();
  });

  it('rolls back the optimistic state and toasts on failure', async () => {
    mocks.unstarRepository.mockRejectedValue(new Error('boom'));
    storeState.repositories = [{ id: 42, full_name: repo.full_name }];
    const { result } = renderHook(() => useDiscoveryRepoActions({ repo }));

    await act(async () => { await result.current.executeUnstar(); });

    expect(result.current.optimisticStarred).toBeNull();
    expect(storeState.deleteRepository).not.toHaveBeenCalled();
    expect(mocks.forceSyncToBackend).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith('Failed to unstar repository. Please check your network connection or GitHub Token permissions.', 'error');
  });
});

describe('discoveryRepoToRepository', () => {
  it('nulls discovery-only fields and stamps starred_at', () => {
    const converted = discoveryRepoToRepository(repo, '2026-09-05T00:00:00.000Z');
    expect(converted).toEqual({
      ...repo,
      rank: undefined,
      channel: undefined,
      platform: undefined,
      starred_at: '2026-09-05T00:00:00.000Z',
    });
  });
});
