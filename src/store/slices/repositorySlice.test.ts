import { describe, expect, it, vi } from 'vitest';
import { beforeEach } from 'vitest';
import type { Category, Repository } from '../../types';
import { defaultCategories } from '../schema';
import { createRepositorySlice } from './repositorySlice';
import { logger } from '../../services/logger';
import { GITHUB_LISTS_MAX_COUNT, GITHUB_LISTS_NAME_MAX_LENGTH } from '../helpers/listsPushPlan';

vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), errorFromError: vi.fn() },
}));

interface HarnessState {
  listsPush: { isRunning: boolean; total: number; done: number; currentLabel: string | null; message: string | null; error: string | null };
  categoryListIdMap: Record<string, string>;
  [key: string]: unknown;
}

type MockListsApi = {
  getUserLists: ReturnType<typeof vi.fn>;
  createUserList: ReturnType<typeof vi.fn>;
  updateUserList: ReturnType<typeof vi.fn>;
  updateUserListsForItem: ReturnType<typeof vi.fn>;
  resolveRepositoryNodeIds: ReturnType<typeof vi.fn>;
};

function makeRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    id: 1,
    name: 'my-cli-app',
    full_name: 'owner/my-cli-app',
    description: null,
    html_url: 'https://github.com/owner/my-cli-app',
    stargazers_count: 1,
    forks_count: 0,
    forks: 0,
    language: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    pushed_at: '2024-01-01T00:00:00Z',
    owner: { login: 'owner', avatar_url: '' },
    topics: ['cli'],
    ...overrides,
  };
}

/**
 * Minimal slice test harness: only provides state fields read/written by pushCategoriesToLists.
 * Repository my-cli-app (topics: ['cli']) matches the devtools category keyword 'cli',
 * allowing the push flow to proceed through the final set() call so categoryListIdMap persistence can be asserted.
 */
function makeSliceHarness(options: {
  currentLists: Array<{ id: string; name: string; items: string[] }>;
  categoryListIdMap?: Record<string, string>;
  repositories?: Repository[];
  customCategories?: Category[];
  nodeIdMap?: Map<string, string>;
  hiddenDefaultCategoryIds?: string[];
}) {
  const state: HarnessState = {
    listsPush: { isRunning: false, total: 0, done: 0, currentLabel: null, message: null, error: null },
    githubToken: 'token',
    user: { login: 'octocat' },
    repositories: options.repositories ?? [makeRepo()],
    customCategories: options.customCategories ?? [],
    language: 'en',
    hiddenDefaultCategoryIds: options.hiddenDefaultCategoryIds ?? defaultCategories.filter(c => c.id !== 'devtools').map(c => c.id),
    defaultCategoryOverrides: {},
    categoryListIdMap: options.categoryListIdMap ?? {},
  };
  const set = (partial: unknown) => {
    const next = typeof partial === 'function'
      ? (partial as (s: HarnessState) => Partial<HarnessState>)(state)
      : partial;
    Object.assign(state, next);
  };
  const get = () => state;
  const api: MockListsApi = {
    getUserLists: vi.fn().mockResolvedValue(options.currentLists),
    createUserList: vi.fn().mockResolvedValue('L_new'),
    updateUserList: vi.fn().mockResolvedValue(undefined),
    updateUserListsForItem: vi.fn().mockResolvedValue(undefined),
    resolveRepositoryNodeIds: vi.fn().mockResolvedValue(options.nodeIdMap ?? new Map()),
  };
  const slice = createRepositorySlice(set as never, get as never);
  const push = (categoryIds?: string[]) => slice.pushCategoriesToLists(api as never, categoryIds);
  return { push, api, state };
}

describe('pushCategoriesToLists language switch auto-rename', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renames persistedId-mapped Chinese list to category name in English without creating new list', async () => {
    const { push, api, state } = makeSliceHarness({
      currentLists: [{ id: 'L_zh', name: '\u5f00\u53d1\u5de5\u5177', items: [] }], // Chinese for "Development Tools"
      categoryListIdMap: { devtools: 'L_zh' },
    });

    await push();

    expect(api.updateUserList).toHaveBeenCalledTimes(1);
    expect(api.updateUserList).toHaveBeenCalledWith('L_zh', 'Development Tools');
    expect(api.createUserList).not.toHaveBeenCalled();
    expect(state.categoryListIdMap.devtools).toBe('L_zh');
    expect(state.listsPush.error).toBeNull();
  });

  it('matches existing Chinese list by name variant when unmapped: renames and saves mapping', async () => {
    const { push, api, state } = makeSliceHarness({
      currentLists: [{ id: 'L_legacy', name: '\u5f00\u53d1\u5de5\u5177', items: [] }], // Chinese for "Development Tools"
    });

    await push();

    expect(api.updateUserList).toHaveBeenCalledWith('L_legacy', 'Development Tools');
    expect(api.createUserList).not.toHaveBeenCalled();
    expect(state.categoryListIdMap.devtools).toBe('L_legacy');
  });

  it('does not call updateUserList when list name already matches category name', async () => {
    const { push, api } = makeSliceHarness({
      currentLists: [{ id: 'L_en', name: 'Development Tools', items: [] }],
      categoryListIdMap: { devtools: 'L_en' },
    });

    await push();

    expect(api.updateUserList).not.toHaveBeenCalled();
    expect(api.createUserList).not.toHaveBeenCalled();
  });

  it('retains mapping and continues push when rename fails (best-effort, retries next round)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { push, api, state } = makeSliceHarness({
      currentLists: [{ id: 'L_zh', name: '\u5f00\u53d1\u5de5\u5177', items: [] }], // Chinese for "Development Tools"
      categoryListIdMap: { devtools: 'L_zh' },
    });
    api.updateUserList.mockRejectedValue(new Error('network down'));

    await expect(push()).resolves.toBeUndefined();

    expect(api.createUserList).not.toHaveBeenCalled();
    expect(state.categoryListIdMap.devtools).toBe('L_zh');
    expect(state.listsPush.error).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      'githubLists',
      'Some lists failed to rename, will retry next push',
      { failures: ['\u5f00\u53d1\u5de5\u5177 -> Development Tools'] } // Chinese for "Development Tools"
    );
    warnSpy.mockRestore();
  });

  it('creates new list using current language category name (rather than canonical Chinese name)', async () => {
    const { push, api, state } = makeSliceHarness({
      currentLists: [],
    });

    await push();

    expect(api.createUserList).toHaveBeenCalledWith('Development Tools', true);
    expect(state.categoryListIdMap.devtools).toBe('L_new');
  });
});

describe('pushCategoriesToLists GitHub Lists hard limit pre-validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('aborts push with zero writes and lists offending name when category name exceeds 32 characters', async () => {
    const longName = 'x'.repeat(GITHUB_LISTS_NAME_MAX_LENGTH + 1);
    const { push, api, state } = makeSliceHarness({
      currentLists: [],
      customCategories: [{ id: 'custom-long', name: longName, icon: '📦', keywords: [] }],
    });

    await push();

    expect(api.createUserList).not.toHaveBeenCalled();
    expect(api.updateUserList).not.toHaveBeenCalled();
    expect(api.updateUserListsForItem).not.toHaveBeenCalled();
    expect(state.listsPush.error).toContain(longName);
    expect(state.listsPush.error).toContain(String(GITHUB_LISTS_NAME_MAX_LENGTH));
  });

  it('aborts push when remote already has 32 lists and new list creation is needed (count limit)', async () => {
    const currentLists = Array.from({ length: GITHUB_LISTS_MAX_COUNT }, (_, i) => ({
      id: `L_${i}`,
      name: `Unrelated List ${i}`,
      items: [] as string[],
    }));
    const { push, api, state } = makeSliceHarness({ currentLists });

    await push();

    expect(api.createUserList).not.toHaveBeenCalled();
    expect(api.updateUserListsForItem).not.toHaveBeenCalled();
    expect(state.listsPush.error).not.toBeNull();
  });

  it('pushes normally when remote already has 32 lists but all categories can be reused (reuse does not count against limit)', async () => {
    const currentLists = [
      ...Array.from({ length: GITHUB_LISTS_MAX_COUNT - 1 }, (_, i) => ({
        id: `L_${i}`,
        name: `Unrelated List ${i}`,
        items: [] as string[],
      })),
      { id: 'L_devtools', name: 'Development Tools', items: [] },
    ];
    const { push, api, state } = makeSliceHarness({
      currentLists,
      categoryListIdMap: { devtools: 'L_devtools' },
    });

    await push();

    expect(api.createUserList).not.toHaveBeenCalled();
    expect(state.listsPush.error).toBeNull();
  });
});

describe('pushCategoriesToLists hidden categories do not participate in push', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves existing mapping for hidden categories without renaming or creating', async () => {
    const { push, api, state } = makeSliceHarness({
      currentLists: [{ id: 'L_web', name: 'Web\u5e94\u7528', items: [] }], // Chinese for "Web Apps"
      categoryListIdMap: { web: 'L_web' },
    });

    await push();

    expect(api.updateUserList).not.toHaveBeenCalled();
    expect(api.createUserList).toHaveBeenCalledWith('Development Tools', true);
    expect(state.categoryListIdMap.web).toBe('L_web');
  });

  it('preserves existing repository membership in hidden category list (kept as unmanaged member)', async () => {
    const { push, api } = makeSliceHarness({
      currentLists: [{ id: 'L_web', name: 'Web\u5e94\u7528', items: ['owner/my-cli-app'] }], // Chinese for "Web Apps"
      categoryListIdMap: { web: 'L_web' },
      nodeIdMap: new Map([['owner/my-cli-app', 'node_1']]),
    });

    await push();

    // When the repo is added to the devtools list, preserve its membership in the hidden category list (L_web)
    expect(api.updateUserListsForItem).toHaveBeenCalledWith('node_1', ['L_web', 'L_new']);
  });
});

describe('pushCategoriesToLists only pushes selected categories', () => {
  const alpha: Category = { id: 'custom-alpha', name: 'Alpha', icon: '📁', keywords: ['alpha'], isCustom: true };

  const thingRepo = (topics: string[]) => makeRepo({ name: 'thing', full_name: 'owner/thing', html_url: 'https://github.com/owner/thing', topics });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('only creates new lists for selected categories and preserves repository membership in unselected managed lists', async () => {
    const { push, api, state } = makeSliceHarness({
      currentLists: [{ id: 'L_dev', name: 'Development Tools', items: ['owner/thing'] }],
      categoryListIdMap: { devtools: 'L_dev' },
      customCategories: [alpha],
      repositories: [thingRepo(['alpha'])],
      nodeIdMap: new Map([['owner/thing', 'node_1']]),
    });

    await push(['custom-alpha']);

    expect(api.createUserList).toHaveBeenCalledTimes(1);
    expect(api.createUserList).toHaveBeenCalledWith('Alpha', true);
    expect(api.updateUserList).not.toHaveBeenCalled();
    expect(api.updateUserListsForItem).toHaveBeenCalledWith('node_1', ['L_dev', 'L_new']);
    expect(state.categoryListIdMap).toEqual({ devtools: 'L_dev', 'custom-alpha': 'L_new' });
    expect(state.listsPush.error).toBeNull();
  });

  it('only cleans up stale members in lists for selected categories', async () => {
    const { push, api } = makeSliceHarness({
      currentLists: [
        { id: 'L_dev', name: 'Development Tools', items: ['owner/thing'] },
        { id: 'L_alpha', name: 'Alpha', items: ['owner/thing'] },
      ],
      categoryListIdMap: { devtools: 'L_dev', 'custom-alpha': 'L_alpha' },
      customCategories: [alpha],
      repositories: [thingRepo([])],
      nodeIdMap: new Map([['owner/thing', 'node_1']]),
    });

    await push(['custom-alpha']);

    expect(api.updateUserListsForItem).toHaveBeenCalledTimes(1);
    expect(api.updateUserListsForItem).toHaveBeenCalledWith('node_1', ['L_dev']);
  });

  it('does not clean up shared list memberships when selected and unselected categories share the same list', async () => {
    // Historical overlapping mappings: devtools (unselected) and custom-alpha (selected) point to the same list.
    // thing is only in L_shared because of devtools and does not match selected alpha;
    // if the shared list were cleared as a managed list of the selected category, thing's membership would be erroneously deleted.
    const { push, api, state } = makeSliceHarness({
      currentLists: [{ id: 'L_shared', name: 'Alpha', items: ['owner/thing'] }],
      categoryListIdMap: { devtools: 'L_shared', 'custom-alpha': 'L_shared' },
      customCategories: [alpha],
      repositories: [thingRepo([])],
      nodeIdMap: new Map([['owner/thing', 'node_1']]),
    });

    await push(['custom-alpha']);

    expect(api.updateUserListsForItem).not.toHaveBeenCalled();
    expect(api.updateUserList).not.toHaveBeenCalled();
    expect(api.createUserList).not.toHaveBeenCalled();
    expect(state.listsPush.error).toBeNull();
  });

  it.each([
    ['empty array', [] as string[]],
    ['unknown/hidden category id', ['missing', 'web']],
  ])('errors without making any requests when selected set is %s', async (_label, ids) => {
    const { push, api, state } = makeSliceHarness({ currentLists: [] });

    await push(ids);

    expect(api.getUserLists).not.toHaveBeenCalled();
    expect(state.listsPush.isRunning).toBe(false);
    expect(state.listsPush.error).toBe('No categories selected to push');
  });
});
