import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CategorySidebar } from './CategorySidebar';
import { useAppStore } from '../store/useAppStore';
import { useRepositoryDragStore } from '../store/useRepositoryDragStore';
import type { Repository } from '../types';

vi.mock('../store/useAppStore', () => ({
  useAppStore: vi.fn(),
  getAllCategories: () => [
    { id: 'all', name: 'All Categories', icon: '📁', keywords: [] },
    { id: 'cat-b', name: 'Category B', icon: '📦', keywords: [], isCustom: true },
    { id: 'cat-c', name: 'Category C', icon: '🧪', keywords: [], isCustom: true },
  ],
  sortCategoriesByOrder: (categories: { id: string }[]) => categories,
}));

const syncMocks = vi.hoisted(() => ({
  forceSyncToBackend: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../hooks/useDialog', () => ({
  useDialog: () => ({ toast: syncMocks.toast, confirm: vi.fn().mockResolvedValue(true) }),
}));

vi.mock('../features/repositories/hooks/useCategorySyncActions', () => ({
  useCategorySyncActions: () => syncMocks,
}));

const categorizedRepo: Repository = {
  id: 1,
  name: 'example-repository',
  full_name: 'owner/example-repository',
  description: 'Repository description',
  html_url: 'https://github.com/owner/example-repository',
  stargazers_count: 128,
  forks_count: 3,
  forks: 3,
  language: 'TypeScript',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  pushed_at: '2026-01-03T00:00:00.000Z',
  owner: {
    login: 'owner',
    avatar_url: 'https://example.com/avatar.png',
  },
  topics: ['test'],
  ai_platforms: ['web', 'cli'],
  custom_category: 'Category B',
  category_locked: true,
};

const storeState = {
  customCategories: [],
  hiddenDefaultCategoryIds: [],
  defaultCategoryOverrides: {},
  categoryOrder: [],
  collapsedSidebarCategoryCount: 6,
  categoryMatchMode: 'effective' as const,
  listsPush: { isRunning: false },
  deleteCustomCategory: vi.fn(),
  hideDefaultCategory: vi.fn(),
  showDefaultCategory: vi.fn(),
  language: 'en' as const,
  updateRepository: vi.fn(),
  isSidebarCollapsed: false,
  setSidebarCollapsed: vi.fn(),
};

const mockUseAppStore = vi.mocked(useAppStore);

const renderSidebar = (repositories: Repository[]) =>
  render(
    <CategorySidebar
      repositories={repositories}
      selectedCategory="cat-b"
      onCategorySelect={vi.fn()}
    />
  );

const dropOnCategory = async (categoryName: string, repoId: string) => {
  const target = screen.getByText(categoryName);
  const dataTransfer = { getData: vi.fn(() => repoId) };
  await act(async () => {
    fireEvent.drop(target, { dataTransfer });
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  useRepositoryDragStore.getState().endDrag();
  syncMocks.forceSyncToBackend.mockReset().mockResolvedValue(undefined);
  mockUseAppStore.mockImplementation(((selector?: (state: typeof storeState) => unknown) => (
    selector ? selector(storeState) : storeState
  )) as typeof useAppStore);
});

describe('CategorySidebar drop-to-uncategorize (issue #353 suggestion)', () => {
  it('explicitly clears category and syncs to backend when dragging categorized repo to "All Categories"', async () => {
    renderSidebar([categorizedRepo]);

    await dropOnCategory('All Categories', String(categorizedRepo.id));

    expect(storeState.updateRepository).toHaveBeenCalledOnce();
    const updated = storeState.updateRepository.mock.calls[0][0] as Repository;
    expect(updated.custom_category).toBe('');
    expect(updated.category_locked).toBe(false);
    expect(syncMocks.forceSyncToBackend).toHaveBeenCalledOnce();
    expect(useRepositoryDragStore.getState().isDragging).toBe(false);
  });

  it('does not write or sync when dragging an already uncategorized repo to "All Categories"', async () => {
    renderSidebar([{ ...categorizedRepo, custom_category: '', category_locked: false }]);

    await dropOnCategory('All Categories', String(categorizedRepo.id));

    expect(storeState.updateRepository).not.toHaveBeenCalled();
    expect(syncMocks.forceSyncToBackend).not.toHaveBeenCalled();
  });

  it('remains a no-op when dragging a repo with no locked category and no AI/default match to "All Categories" (preserving undefined for future AI categorization)', async () => {
    const neverMatchedRepo: Repository = {
      ...categorizedRepo,
      id: 2,
      name: 'zzz-project',
      full_name: 'owner/zzz-project',
      description: '',
      language: 'Rust',
      topics: [],
      ai_tags: undefined,
      ai_summary: undefined,
      custom_category: undefined,
      category_locked: false,
    };
    renderSidebar([neverMatchedRepo]);

    await dropOnCategory('All Categories', '2');

    expect(storeState.updateRepository).not.toHaveBeenCalled();
    expect(syncMocks.forceSyncToBackend).not.toHaveBeenCalled();
  });

  it('follows standard re-categorization logic when dragging to a normal category (regression guard)', async () => {
    renderSidebar([categorizedRepo]);

    await dropOnCategory('Category C', String(categorizedRepo.id));

    expect(storeState.updateRepository).toHaveBeenCalledOnce();
    const updated = storeState.updateRepository.mock.calls[0][0] as Repository;
    expect(updated.custom_category).toBe('Category C');
    expect(updated.category_locked).toBe(true);
    expect(syncMocks.forceSyncToBackend).toHaveBeenCalledOnce();
  });

  it('rolls back to original repository data when sync fails', async () => {
    syncMocks.forceSyncToBackend.mockRejectedValue(new Error('sync failed'));
    renderSidebar([categorizedRepo]);

    await dropOnCategory('All Categories', String(categorizedRepo.id));

    // Rollback: calls updateRepository with original repo object
    expect(storeState.updateRepository).toHaveBeenCalledTimes(2);
    const rollback = storeState.updateRepository.mock.calls[1][0] as Repository;
    expect(rollback.custom_category).toBe('Category B');
    expect(rollback.category_locked).toBe(true);
    expect(syncMocks.toast).toHaveBeenCalledWith('Failed to sync to backend. Category change has been reverted.', 'error');
  });
});
