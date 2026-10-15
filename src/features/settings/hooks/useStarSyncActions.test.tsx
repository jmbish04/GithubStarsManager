import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStarSyncActions } from './useStarSyncActions';
import { useAppStore } from '../../../store/useAppStore';

const mocks = vi.hoisted(() => ({
  useAppStore: vi.fn(),
  confirm: vi.fn(),
  pushCategoriesToLists: vi.fn(),
  setListsPushError: vi.fn(),
}));

vi.mock('../../../store/useAppStore', () => ({ useAppStore: mocks.useAppStore }));
vi.mock('../../../hooks/useDialog', () => ({ useDialog: () => ({ confirm: mocks.confirm }) }));
vi.mock('../../../services/githubApiFactory', () => ({
  createGitHubListsApiService: (token: string) => ({ __factory: true, token }),
}));

const storeState: { language: string; githubToken: string | null; pushCategoriesToLists: ReturnType<typeof vi.fn>; setListsPushError: ReturnType<typeof vi.fn> } = {
  language: 'en',
  githubToken: 'token',
  pushCategoriesToLists: mocks.pushCategoriesToLists,
  setListsPushError: mocks.setListsPushError,
};

const mockUseAppStore = vi.mocked(useAppStore);

describe('useStarSyncActions namespace binding regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAppStore.mockImplementation(((selector?: (state: typeof storeState) => unknown) => (
      selector ? selector(storeState) : storeState
    )) as typeof useAppStore);
  });

  it('uses settings namespace translation instead of raw key in confirm modal', async () => {
    mocks.confirm.mockResolvedValue(true);
    const { result } = renderHook(() => useStarSyncActions());

    await act(async () => { await result.current.pushCategoriesToLists(); });

    const [title, body] = mocks.confirm.mock.calls[0];
    // If falling back to app namespace, these two keys would render verbatim (historical bug)
    expect(title).toBe('Push categories to GitHub lists');
    expect(title).not.toContain('useStarSyncActions.');
    expect(body).toContain('Existing same-name lists will be overwritten');
    expect(body).not.toContain('useStarSyncActions.');
    expect(mocks.pushCategoriesToLists).toHaveBeenCalledTimes(1);
  });

  it('forwards category IDs to store and uses selected-categories confirmation text', async () => {
    mocks.confirm.mockResolvedValue(true);
    const { result } = renderHook(() => useStarSyncActions());

    await act(async () => { await result.current.pushCategoriesToLists(['a', 'b']); });

    const [, body] = mocks.confirm.mock.calls[0];
    expect(body).toContain('Selected categories: 2');
    expect(body).not.toContain('useStarSyncActions.');
    expect(mocks.pushCategoriesToLists).toHaveBeenCalledWith({ __factory: true, token: 'token' }, ['a', 'b']);
  });

  it('does not call store when user cancels confirmation', async () => {
    mocks.confirm.mockResolvedValue(false);
    const { result } = renderHook(() => useStarSyncActions());

    await act(async () => { await result.current.pushCategoriesToLists(['a']); });

    expect(mocks.pushCategoriesToLists).not.toHaveBeenCalled();
  });

  it('shows settings namespace text via setListsPushError when not connected to GitHub', async () => {
    mockUseAppStore.mockImplementation(((selector?: (state: typeof storeState) => unknown) => (
      selector ? selector({ ...storeState, githubToken: null }) : storeState
    )) as typeof useAppStore);
    const { result } = renderHook(() => useStarSyncActions());

    await act(async () => { await result.current.pushCategoriesToLists(); });

    expect(mocks.setListsPushError).toHaveBeenCalledWith('Not connected to GitHub yet');
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
});
