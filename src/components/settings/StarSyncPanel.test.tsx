import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StarSyncPanel } from './StarSyncPanel';
import { makeT } from '../../i18n/useT';

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {};
  return {
    state,
    useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => (selector ? selector(state) : state),
    pushCategoriesToLists: vi.fn(),
    getAllCategories: vi.fn(() => [] as Array<{ id: string; name: string; icon: string; keywords: string[]; isCustom?: boolean }>),
  };
});

vi.mock('../../store/useAppStore', () => ({
  useAppStore: mocks.useAppStore,
  getAllCategories: mocks.getAllCategories,
}));
vi.mock('../../features/settings/hooks/useStarSyncActions', () => ({
  useStarSyncActions: () => ({ pushCategoriesToLists: mocks.pushCategoriesToLists }),
}));

const t = makeT('en', 'app');

describe('StarSyncPanel push entry points', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAllCategories.mockReturnValue([]);
    Object.assign(mocks.state, {
      syncMode: 'stars',
      setSyncMode: vi.fn(),
      setSyncModeConfigured: vi.fn(),
      listsPush: { isRunning: false, total: 0, done: 0 },
      customCategories: [],
      hiddenDefaultCategoryIds: [],
      defaultCategoryOverrides: {},
      language: 'en',
    });
  });

  it('invokes push without arguments on "push all" click (click event must not leak as categoryIds)', async () => {
    render(<StarSyncPanel t={t} />);

    await userEvent.click(screen.getByRole('button', { name: 'Push categories to lists' }));

    expect(mocks.pushCategoriesToLists).toHaveBeenCalledTimes(1);
    expect(mocks.pushCategoriesToLists).toHaveBeenCalledWith();
  });

  it('passes only remaining category IDs to hook on confirm (selection must not silently expand to all)', async () => {
    mocks.getAllCategories.mockReturnValue([
      { id: 'a', name: 'Category A', icon: '📦', keywords: [] },
      { id: 'b', name: 'Category B', icon: '🧪', keywords: [], isCustom: true },
    ]);
    render(<StarSyncPanel t={t} />);

    await userEvent.click(screen.getByRole('button', { name: 'Push selected…' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Category B/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Push 1 selected' }));

    expect(mocks.pushCategoriesToLists).toHaveBeenCalledTimes(1);
    expect(mocks.pushCategoriesToLists).toHaveBeenCalledWith(['a']);
  });
});
