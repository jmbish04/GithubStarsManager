import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageValue } from 'zustand/middleware';
import {
  getStorageEntriesStrict,
  getStorageItemStrict,
  indexedDBStorage,
  setStorageEntries,
  writeEntriesToFallbackStorage,
} from '../../services/indexedDbStorage';
import { appPersistenceOptions } from './options';
import { createInitialState } from '../initialState';
import { flushPendingPersistSnapshot, __setPersistTimingsForTest } from './storage';
import { debouncedPersistStorage, removePersistedSnapshot } from './storage';
import { normalizeAccountWorkspaces } from '../helpers/accountWorkspace';
import {
  PERSISTENCE_SHARD_FIELDS,
  PERSISTENCE_SHARD_NAMES,
  WORKSPACE_REFERENCE_FIELDS,
  WORKSPACE_VALUE_FIELDS,
  buildShardViews,
  findDirtyShards,
  metaKeyFor,
  shardKeyFor,
} from './shards';
import { normalizeTrendingSnapshots } from '../../utils/trendingSnapshots';

// Commit point barrier: intercepts writes at real storage commit entry point (setStorageEntries)
// so concurrent tests deterministically overlap with "write A is still committing"—setTimeout waiting cannot guarantee this.
const commitGate = vi.hoisted(() => {
  let hold = false;
  let release: () => void = () => undefined;
  let markReached: (() => void) | null = null;
  let reached: Promise<void> = Promise.resolve();
  return {
    arm: () => {
      hold = true;
      reached = new Promise<void>((resolve) => {
        markReached = resolve;
      });
    },
    waitReached: (): Promise<void> => reached,
    release: () => {
      hold = false;
      release();
    },
    reset: () => {
      hold = false;
      release();
    },
    wrap: async <T>(run: () => Promise<T>): Promise<T> => {
      if (hold) {
        markReached?.();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return run();
    },
  };
});

vi.mock('../../services/indexedDbStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/indexedDbStorage')>();
  return {
    ...actual,
    // The actual signature is (name, entries)—forwarding parameters must match 1:1, otherwise calling semantics are silently altered.
    setStorageEntries: (name: string, entries: ReadonlyArray<readonly [string, string]>) =>
      commitGate.wrap(() => actual.setStorageEntries(name, entries)),
  };
});

const KEY = 'github-stars-manager';

const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const buildState = (): Record<string, unknown> => ({
  // Based on createInitialState: partialize directly reads all persisted fields (such as
  // state.gistSearchFilters.sortBy); handwritten sparse objects will throw errors.
  ...(createInitialState() as unknown as Record<string, unknown>),
  theme: 'dark',
  language: 'en',
  repositories: [{ id: 1, name: 'repo-one' }],
  lastSync: '2026-01-01T00:00:00.000Z',
  gists: [{ id: 'gist-1' }],
  starredGists: [],
  releases: [{ id: 101 }],
  forks: [],
  // Normalized workspace contains all 18 fields: workspaces with differing key counts are stopped by dirty checking guards
  accountWorkspaces: {
    '1': {
      repositories: [{ id: 1, name: 'repo-one' }],
      lastSync: '2026-01-01T00:00:00.000Z',
      gists: [],
      starredGists: [],
      releases: [],
      forks: [],
      customCategories: [],
      categoryOrder: ['cat-a'],
      readReleases: [1, 2],
      readForks: [],
      releaseSubscriptions: [1],
      hiddenDefaultCategoryIds: ['cat-b'],
      selectedGistCategory: 'all',
      releaseSourceSettings: { enabledSourceIds: ['starred-release-subscription'], watchCustomReleaseRepos: [], customReleaseRepos: [] },
      defaultCategoryOverrides: {},
      categoryListIdMap: {},
      syncMode: 'stars',
      syncModeConfigured: false,
    },
  },
  // Snapshots must contain at least one entry (snapshots with empty entries are dropped by normalization)
  trendingSnapshots: [
    {
      period: 'daily',
      platform: 'All',
      capturedAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      entries: [{ repositoryFullName: 'a/b', rank: 1, stars: 9 }],
    },
  ],
  customCategories: [{ id: 'cat-1', name: 'Work' }],
});

const readRaw = async (key: string): Promise<string | null> => indexedDBStorage.getItem(key);
const readStrict = async (key: string): Promise<string | null> => getStorageItemStrict(KEY, key);
const readMeta = async (): Promise<{ savedAt: string; version: number; shards: string[] } | null> => {
  const raw = await readRaw(metaKeyFor(KEY));
  return raw ? JSON.parse(raw) : null;
};
const readShardState = async (shard: Parameters<typeof shardKeyFor>[1]): Promise<Record<string, unknown>> => {
  const raw = await readRaw(shardKeyFor(KEY, shard));
  expect(raw).not.toBeNull();
  return JSON.parse(raw as string).state as Record<string, unknown>;
};

/** Rewrites on-disk shards as indented JSON, used to detect "which shards are rewritten on subsequent launches". */
const markShardsOnDisk = async (): Promise<void> => {
  for (const shard of PERSISTENCE_SHARD_NAMES) {
    const rawJson = await readRaw(shardKeyFor(KEY, shard));
    if (rawJson) {
      await indexedDBStorage.setItem(shardKeyFor(KEY, shard), JSON.stringify(JSON.parse(rawJson), null, 2));
    }
  }
};

const rewrittenShards = async (): Promise<string[]> => {
  const rewritten: string[] = [];
  for (const shard of PERSISTENCE_SHARD_NAMES) {
    const rawJson = await readRaw(shardKeyFor(KEY, shard));
    if (rawJson && !rawJson.includes('\n  "')) rewritten.push(shard);
  }
  return rewritten;
};

beforeEach(async () => {
  vi.restoreAllMocks();
  commitGate.reset();
  debouncedPersistStorage.removeItem(KEY);
  await tick();
});

describe('persistence shard layout', () => {
  it('assigns fields to the expected shards and falls back to core for unknown fields', () => {
    const views = buildShardViews({
      theme: 'dark',
      repositories: [{ id: 1 }],
      lastSync: '2026-01-01T00:00:00.000Z',
      gists: [],
      starredGists: [],
      releases: [],
      forks: [],
      accountWorkspaces: {},
      trendingSnapshots: [],
      someFutureField: 'kept-in-core',
    });

    expect(Object.keys(views.core)).toEqual(['theme', 'lastSync', 'someFutureField']);
    expect(views.repositories).toEqual({ repositories: [{ id: 1 }] });
    expect(Object.keys(views.gists)).toEqual(['gists', 'starredGists']);
    expect(Object.keys(views.releases)).toEqual(['releases']);
    expect(Object.keys(views.forks)).toEqual(['forks']);
    expect(Object.keys(views.accountWorkspaces)).toEqual(['accountWorkspaces']);
    expect(Object.keys(views.trendingSnapshots)).toEqual(['trendingSnapshots']);
  });

  it('covers every persisted partialize key with exactly one shard', () => {
    const partialize = appPersistenceOptions.partialize!;
    const persistedKeys = Object.keys(partialize(createInitialState() as never));
    expect(persistedKeys.length).toBeGreaterThan(0);

    const covered = PERSISTENCE_SHARD_NAMES.flatMap((shard) => [...PERSISTENCE_SHARD_FIELDS[shard]]);
    expect(new Set(covered).size).toBe(covered.length);
    for (const key of persistedKeys) {
      expect(covered, `persisted key "${key}" must be assigned to a shard`).toContain(key);
    }
  });

  it('covers every normalized workspace field with exactly one comparison list', () => {
    // When a new field is added to AccountWorkspace, it must be included in either REFERENCE or VALUE list;
    // otherwise content changes to that field will be missed by dirty checking (omitted write).
    const normalized = normalizeAccountWorkspaces({ '1': {} })['1'];
    const covered = new Set<string>([...WORKSPACE_REFERENCE_FIELDS, ...WORKSPACE_VALUE_FIELDS]);
    for (const field of Object.keys(normalized)) {
      expect(covered.has(field), `workspace field "${field}" must be in a comparison list`).toBe(true);
    }
    for (const field of covered) {
      expect(field in normalized, `comparison list field "${field}" must exist on the workspace`).toBe(true);
    }
  });
});

describe('persistence shard dirty detection', () => {
  const viewsOf = (state: Record<string, unknown>) => buildShardViews(state);

  it('treats every shard as dirty without a baseline and none as dirty with identical references', () => {
    const state = buildState();
    const views = viewsOf(state);

    expect(findDirtyShards(views, null)).toEqual([...PERSISTENCE_SHARD_NAMES]);
    expect(findDirtyShards(views, views)).toEqual([]);
  });

  it('marks only the shard whose field reference changed', () => {
    const state = buildState();
    const baseline = viewsOf(state);
    const next = viewsOf({ ...state, theme: 'light' });

    expect(findDirtyShards(next, baseline)).toEqual(['core']);
  });

  it('ignores hydration-normalized accountWorkspaces with equal content and detects real changes', () => {
    // Passing through real normalizeAccountWorkspaces: normalization must not mark an unchanged
    // workspace as changed by recreating array references (otherwise every startup would rewrite the shard).
    const state = buildState();
    const baseline = viewsOf(state);
    const normalized = normalizeAccountWorkspaces(state.accountWorkspaces);

    const untouched = findDirtyShards(viewsOf({ ...state, accountWorkspaces: normalized }), baseline);
    expect(untouched).toEqual([]);

    // Real changes (logout snapshot replacing heavy array references) must be marked dirty
    const changedWorkspaces = {
      '1': {
        ...(normalized as unknown as Record<string, Record<string, unknown>>)['1'],
        repositories: [{ id: 2, name: 'repo-two' }],
      },
    };
    expect(findDirtyShards(viewsOf({ ...state, accountWorkspaces: changedWorkspaces }), baseline))
      .toEqual(['accountWorkspaces']);
  });

  it('keeps trendingSnapshots reference when normalization is content-equal', () => {
    const state = buildState();
    const snapshots = state.trendingSnapshots as unknown as Array<Record<string, unknown>>;
    expect(normalizeTrendingSnapshots(snapshots as never)).toBe(snapshots as never);

    // When content is truly expired or invalid, it is still reconstructed
    const stale = [{ ...snapshots[0], capturedAt: '2000-01-01T00:00:00.000Z' }];
    expect(normalizeTrendingSnapshots(stale)).toEqual([]);
  });

  it('compares core shard fields by content because partialize rebuilds small objects', () => {
    // Real partialize reconstructs core fields like searchFilters/proxyConfig/derived arrays every time;
    // comparing core by value is essential to allow "unchanged writes" to actually be skipped.
    const state = buildState();
    const first = appPersistenceOptions.partialize!(state as never);
    const second = appPersistenceOptions.partialize!(state as never);
    const baseline = viewsOf(first as Record<string, unknown>);

    expect(findDirtyShards(viewsOf(second as Record<string, unknown>), baseline)).toEqual([]);

    const changed = appPersistenceOptions.partialize!({ ...state, theme: 'light' } as never);
    expect(findDirtyShards(viewsOf(changed as Record<string, unknown>), baseline)).toEqual(['core']);
  });
});

describe('sharded persist storage', () => {
  it('hydrates from the legacy single-key snapshot, commits shards atomically and retires the legacy key', async () => {
    const legacyValue: StorageValue<unknown> = { state: buildState(), version: 16 };
    await indexedDBStorage.setItem(KEY, JSON.stringify(legacyValue));

    const hydrated = await debouncedPersistStorage.getItem(KEY);
    // Legacy snapshot underwent JSON round-trip (Set -> object, undefined dropped); expected side uses same normalization
    expect(hydrated).toEqual(JSON.parse(JSON.stringify(legacyValue)));

    const nextValue: StorageValue<unknown> = { state: buildState(), version: 16 };
    debouncedPersistStorage.setItem(KEY, nextValue);
    await flushPendingPersistSnapshot();

    // All shards + meta have been committed
    const meta = await readMeta();
    expect(meta?.version).toBe(16);
    expect(meta?.shards).toEqual([...PERSISTENCE_SHARD_NAMES]);
    const repositoriesShard = await readShardState('repositories');
    expect(repositoriesShard.repositories).toEqual([{ id: 1, name: 'repo-one' }]);
    const coreShard = await readShardState('core');
    expect(coreShard.theme).toBe('dark');
    expect(coreShard.lastSync).toBe('2026-01-01T00:00:00.000Z');

    // Legacy single-key snapshot is retired after full migration commit
    expect(await readRaw(KEY)).toBeNull();

    // Re-hydration yields complete state (seamless upgrade)
    const rehydrated = await debouncedPersistStorage.getItem(KEY);
    expect(rehydrated?.version).toBe(16);
    expect(rehydrated?.state).toEqual(JSON.parse(JSON.stringify(nextValue.state)));
  });

  it('skips the write entirely when two real partialize calls produce equal content', async () => {
    // In production path, partialize reconstructs small objects every time; only checking core by value can skip it.
    const state = buildState();
    debouncedPersistStorage.setItem(KEY, { state: appPersistenceOptions.partialize!(state as never) as Record<string, unknown>, version: 16 });
    await flushPendingPersistSnapshot();
    const savedAtAfterFirstWrite = (await readMeta())?.savedAt;

    debouncedPersistStorage.setItem(KEY, { state: appPersistenceOptions.partialize!(state as never) as Record<string, unknown>, version: 16 });
    await flushPendingPersistSnapshot();
    expect((await readMeta())?.savedAt).toBe(savedAtAfterFirstWrite);
  });

  it('rewrites only the core shard when a small preference changes', async () => {
    const state = buildState();
    debouncedPersistStorage.setItem(KEY, { state, version: 16 });
    await flushPendingPersistSnapshot();
    const repositoriesShardBefore = await readRaw(shardKeyFor(KEY, 'repositories'));
    const gistsShardBefore = await readRaw(shardKeyFor(KEY, 'gists'));

    // Spread preserves heavy data field references, simulating real partialize behavior
    const nextState = { ...state, language: 'en' };
    debouncedPersistStorage.setItem(KEY, { state: nextState, version: 16 });
    await flushPendingPersistSnapshot();

    const coreShard = await readShardState('core');
    expect(coreShard.language).toBe('en');
    // Heavy data field references unchanged: shard content remains identical
    expect(await readRaw(shardKeyFor(KEY, 'repositories'))).toBe(repositoriesShardBefore);
    expect(await readRaw(shardKeyFor(KEY, 'gists'))).toBe(gistsShardBefore);
  });

  it('rewrites the repositories shard when its array reference changes but leaves other heavy shards', async () => {
    const state = buildState();
    debouncedPersistStorage.setItem(KEY, { state, version: 16 });
    await flushPendingPersistSnapshot();
    const gistsShardBefore = await readRaw(shardKeyFor(KEY, 'gists'));

    const nextState = { ...state, repositories: [{ id: 1, name: 'repo-one', ai_summary: 'new' }] };
    debouncedPersistStorage.setItem(KEY, { state: nextState, version: 16 });
    await flushPendingPersistSnapshot();

    expect((await readShardState('repositories')).repositories).toEqual([
      { id: 1, name: 'repo-one', ai_summary: 'new' },
    ]);
    expect(await readRaw(shardKeyFor(KEY, 'gists'))).toBe(gistsShardBefore);
  });

  it('does not rewrite heavy shards on a plain boot after data has converged', async () => {
    // Contract: hydration -> merge -> partialize startup sequence must not rewrite any heavy data shards
    // (accountWorkspaces/trendingSnapshots retain references via normalization + lastSync belongs to core).
    const seedState = appPersistenceOptions.partialize!(buildState() as never);
    debouncedPersistStorage.setItem(KEY, { state: seedState as Record<string, unknown>, version: 16 });
    await flushPendingPersistSnapshot();
    await markShardsOnDisk();

    const hydrated = await debouncedPersistStorage.getItem(KEY);
    const merged = appPersistenceOptions.merge!(hydrated!.state as never, createInitialState() as never);
    debouncedPersistStorage.setItem(KEY, { state: appPersistenceOptions.partialize!(merged as never) as Record<string, unknown>, version: 16 });
    await flushPendingPersistSnapshot();

    expect(await rewrittenShards()).toEqual([]);
  });

  it('serializes overlapping idle/flush writes so the dirty baseline never trails the disk', async () => {
    // Regression: during write A commit (version expired), if write B checks dirty against expired baseline it would skip write,
    // leaving old value of A on disk with cache unaware.
    const state = buildState();
    debouncedPersistStorage.setItem(KEY, { state, version: 16 });
    await flushPendingPersistSnapshot();

    const stateLight = { ...state, theme: 'light' };
    const stateDark = { ...state, theme: 'dark' };
    commitGate.arm();
    debouncedPersistStorage.setItem(KEY, { state: stateLight, version: 16 });
    const flushInFlight = flushPendingPersistSnapshot();
    await commitGate.waitReached(); // Write A finished dirty checking, deterministically intercepted at real commit point
    debouncedPersistStorage.setItem(KEY, { state: stateDark, version: 16 });
    const flushAfterDark = flushPendingPersistSnapshot(); // B queues after A
    commitGate.release();
    await flushInFlight;
    await flushAfterDark;

    expect((await readShardState('core')).theme).toBe('dark');
    const rehydrated = await debouncedPersistStorage.getItem(KEY);
    expect(rehydrated?.state).toMatchObject({ theme: 'dark', language: 'en' });
  });

  it('rebuilds the full shard set when removeItem follows a write still in flight', async () => {
    const state = buildState();
    commitGate.arm();
    debouncedPersistStorage.setItem(KEY, { state, version: 16 });
    const inFlightWrite = flushPendingPersistSnapshot();
    await commitGate.waitReached(); // Write A finished dirty checking, deterministically intercepted at real commit point
    debouncedPersistStorage.removeItem(KEY);
    const nextState = { ...state, language: 'en' };
    debouncedPersistStorage.setItem(KEY, { state: nextState, version: 16 });
    const flushAfterClear = flushPendingPersistSnapshot(); // Queues after deletion
    commitGate.release();
    await inFlightWrite;
    await flushAfterClear;

    // First write after deletion must fully rebuild: meta matches all shards, no missing shards
    const rehydrated = await debouncedPersistStorage.getItem(KEY);
    expect(rehydrated?.state).toMatchObject({ theme: 'dark', language: 'en' });
    expect(await readMeta()).not.toBeNull();
    expect(await readShardState('gists')).toMatchObject({ gists: [{ id: 'gist-1' }] });
    expect(await readShardState('repositories')).toMatchObject({
      repositories: [{ id: 1, name: 'repo-one' }],
    });
  });

  it('merges persisted shards with the legacy snapshot when some shards are missing, then converges', async () => {
    // Simulate mid-migration crash: meta + partial shards committed, legacy single-key snapshot still exists
    const legacyState = { ...buildState(), gists: [{ id: 'legacy-gist' }], theme: 'light' };
    await indexedDBStorage.setItem(KEY, JSON.stringify({ state: legacyState, version: 16 }));
    await setStorageEntries(KEY, [
      [metaKeyFor(KEY), JSON.stringify({ format: 1, version: 16, shards: [...PERSISTENCE_SHARD_NAMES], savedAt: 't0' })],
      [shardKeyFor(KEY, 'core'), JSON.stringify({ format: 1, version: 16, state: { theme: 'dark', language: 'en' } })],
    ]);

    const hydrated = await debouncedPersistStorage.getItem(KEY);
    // Present shard contents (newer) overwrite legacy snapshot, missing shards fall back to legacy snapshot
    expect(hydrated?.state).toMatchObject({ theme: 'dark', language: 'en', gists: [{ id: 'legacy-gist' }] });

    // Next write forcibly commits all shards and retires legacy key (converged migration)
    debouncedPersistStorage.setItem(KEY, { state: buildState(), version: 16 });
    await flushPendingPersistSnapshot();

    expect(await readRaw(KEY)).toBeNull();
    expect(await readShardState('gists')).toMatchObject({ gists: [{ id: 'gist-1' }] });
    const rehydrated = await debouncedPersistStorage.getItem(KEY);
    expect(rehydrated?.state).toMatchObject({ theme: 'dark', gists: [{ id: 'gist-1' }] });
  });

  it('assembles a full shard set and retires a leftover legacy key on read', async () => {
    // Simulate successful commit but crash before cleanup: shards complete + legacy key remains
    const value: StorageValue<unknown> = { state: buildState(), version: 16 };
    debouncedPersistStorage.setItem(KEY, value);
    await flushPendingPersistSnapshot();
    await indexedDBStorage.setItem(KEY, JSON.stringify({ state: { stale: true }, version: 16 }));

    const hydrated = await debouncedPersistStorage.getItem(KEY);
    expect(hydrated?.state).toEqual(JSON.parse(JSON.stringify(value.state)));
    await tick();
    expect(await readRaw(KEY)).toBeNull();
  });

  it('falls back to the legacy snapshot when the meta format is unknown', async () => {
    const legacyValue: StorageValue<unknown> = { state: buildState(), version: 16 };
    await indexedDBStorage.setItem(KEY, JSON.stringify(legacyValue));
    await setStorageEntries(KEY, [
      [metaKeyFor(KEY), JSON.stringify({ format: 999, version: 99, shards: ['core'], savedAt: 't0' })],
    ]);

    const hydrated = await debouncedPersistStorage.getItem(KEY);
    expect(hydrated).toEqual(JSON.parse(JSON.stringify(legacyValue)));
  });

  it('treats an incomplete or duplicated shard list as an invalid meta and keeps the legacy snapshot', async () => {
    // H2 regression: meta with valid format but listing only partial shards must not bypass recovery path,
    // nor retire the only fallback legacy single-key snapshot.
    const legacyValue: StorageValue<unknown> = {
      state: { theme: 'light', repositories: [{ id: 1 }], gists: [{ id: 'keep' }] },
      version: 16,
    };
    await indexedDBStorage.setItem(KEY, JSON.stringify(legacyValue));
    for (const shards of [['core'], ['core', 'core'], [...PERSISTENCE_SHARD_NAMES.slice(0, -1)], ['core', 'unknown-shard']]) {
      await setStorageEntries(KEY, [
        [metaKeyFor(KEY), JSON.stringify({ format: 1, version: 16, shards, savedAt: 't0' })],
        [shardKeyFor(KEY, 'core'), JSON.stringify({ format: 1, version: 16, state: { theme: 'dark' } })],
      ]);
      await indexedDBStorage.setItem(KEY, JSON.stringify(legacyValue));

      const hydrated = await debouncedPersistStorage.getItem(KEY);
      expect(hydrated?.state).toMatchObject({ theme: 'light', gists: [{ id: 'keep' }] });
      await tick();
      expect(await readRaw(KEY), `legacy must survive invalid meta ${JSON.stringify(shards)}`).not.toBeNull();
    }
  });

  it('salvages readable orphaned shards when meta and legacy are both gone', async () => {
    await setStorageEntries(KEY, [
      [shardKeyFor(KEY, 'core'), JSON.stringify({ format: 1, version: 16, state: { theme: 'dark', language: 'en' } })],
      [shardKeyFor(KEY, 'repositories'), JSON.stringify({ format: 1, version: 16, state: { repositories: [{ id: 7 }] } })],
    ]);

    const hydrated = await debouncedPersistStorage.getItem(KEY);
    expect(hydrated?.state).toMatchObject({ theme: 'dark', repositories: [{ id: 7 }] });

    // First write after salvaging fully rebuilds from empty baseline (including self-healing meta)
    debouncedPersistStorage.setItem(KEY, { state: buildState(), version: 16 });
    await flushPendingPersistSnapshot();
    expect(await readMeta()).not.toBeNull();
    expect(await readShardState('gists')).toMatchObject({ gists: [{ id: 'gist-1' }] });
  });

  it('treats corrupt shard payloads as missing and recovers from the legacy snapshot', async () => {
    const legacyState = buildState();
    await indexedDBStorage.setItem(KEY, JSON.stringify({ state: legacyState, version: 16 }));
    await setStorageEntries(KEY, [
      [metaKeyFor(KEY), JSON.stringify({ format: 1, version: 16, shards: [...PERSISTENCE_SHARD_NAMES], savedAt: 't0' })],
      [shardKeyFor(KEY, 'core'), 'not-json'],
    ]);

    const hydrated = await debouncedPersistStorage.getItem(KEY);
    expect(hydrated?.state).toEqual(JSON.parse(JSON.stringify(legacyState)));
  });

  it('hydrates best-effort from readable shards when nothing else is available', async () => {
    await setStorageEntries(KEY, [
      [metaKeyFor(KEY), JSON.stringify({ format: 1, version: 16, shards: [...PERSISTENCE_SHARD_NAMES], savedAt: 't0' })],
      [shardKeyFor(KEY, 'core'), JSON.stringify({ format: 1, version: 16, state: { theme: 'dark' } })],
    ]);

    const hydrated = await debouncedPersistStorage.getItem(KEY);
    expect(hydrated?.version).toBe(16);
    expect(hydrated?.state).toEqual({ theme: 'dark' });
  });

  it('keeps the fallback authority marker while localStorage still holds shard keys', async () => {
    // Regression (CodeRabbit r4165367360): unconditionally clearing the authority marker after successful IDB batch write
    // causes an issue under the combination of "fallback write + IDB legacy key delete failure during fallback":
    // the old IDB shard would mask the new value in localStorage on next hydration—silently rolling back user preferences,
    // and because the dirty baseline was already updated with the new value, it never self-heals.
    const state = buildState();
    debouncedPersistStorage.setItem(KEY, { state, version: 16 });
    await flushPendingPersistSnapshot();

    // Fallback episode: only core is written to localStorage via fallback path; simulate IDB delete failure
    // during fallback (not uncommon right after an IDB failure); old core remains in IndexedDB
    const fallbackCore = JSON.stringify({ format: 1, version: 16, state: { theme: 'light', language: 'en' } });
    const originalDelete = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function () { throw new Error('simulated delete failure'); };
    try {
      await writeEntriesToFallbackStorage(KEY, [[shardKeyFor(KEY, 'core'), fallbackCore]]);
    } finally {
      IDBObjectStore.prototype.delete = originalDelete;
    }
    expect(window.localStorage.getItem(`${KEY}#fallback`)).not.toBeNull();
    expect(await readRaw(shardKeyFor(KEY, 'core'))).not.toBeNull(); // Old IDB core was not deleted

    // Subsequent batch of writes not containing core succeeds via IndexedDB: LS still holds newer core -> marker must be kept
    await setStorageEntries(KEY, [
      [shardKeyFor(KEY, 'releases'), JSON.stringify({ format: 1, version: 16, state: { releases: [{ id: 202 }] } })],
      [metaKeyFor(KEY), JSON.stringify({ format: 1, version: 16, shards: [...PERSISTENCE_SHARD_NAMES], savedAt: 't2' })],
    ]);
    expect(window.localStorage.getItem(`${KEY}#fallback`)).not.toBeNull();

    // Hydration reads newer core in localStorage, rather than older core in IndexedDB
    const hydrated = await debouncedPersistStorage.getItem(KEY);
    expect(hydrated?.state).toMatchObject({
      theme: 'light',
      language: 'en',
      releases: [{ id: 202 }],
      gists: [{ id: 'gist-1' }],
    });

    // Self-healing: once a batch write overwrites core and succeeds via IDB, LS mirror is cleared and no derived keys remain;
    // only then is the marker cleared; subsequent reads return to IDB priority
    const healedCore = JSON.stringify({ format: 1, version: 16, state: { theme: 'dark', language: 'en' } });
    await setStorageEntries(KEY, [[shardKeyFor(KEY, 'core'), healedCore]]);
    expect(window.localStorage.getItem(`${KEY}#fallback`)).toBeNull();
    expect(await readStrict(shardKeyFor(KEY, 'core'))).toBe(healedCore);
  });

  it('refuses to write after a shard read failure so real data cannot be overwritten', async () => {
    // F2r2 regression: hydration results are incomplete after a read failure (distinct from "key does not exist");
    // subsequent writes must be rejected, otherwise real shards on disk would be overwritten with default values.
    const state = buildState();
    debouncedPersistStorage.setItem(KEY, { state, version: 16 });
    await flushPendingPersistSnapshot();
    const savedAtBefore = (await readMeta())?.savedAt;
    const gistsBefore = await readRaw(shardKeyFor(KEY, 'gists'));

    const originalGet = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function () { throw new Error('simulated transient IDB failure'); };
    try {
      const hydrated = await debouncedPersistStorage.getItem(KEY);
      expect(hydrated).toBeNull();
    } finally {
      IDBObjectStore.prototype.get = originalGet;
    }

    debouncedPersistStorage.setItem(KEY, { state: { ...state, language: 'en' }, version: 16 });
    await flushPendingPersistSnapshot();

    // Write rejected: disk remains untouched
    expect((await readMeta())?.savedAt).toBe(savedAtBefore);
    expect(await readRaw(shardKeyFor(KEY, 'gists'))).toBe(gistsBefore);

    // Writes become available again after read recovers
    const recovered = await debouncedPersistStorage.getItem(KEY);
    expect(recovered?.state).toMatchObject({ theme: 'dark' });
    debouncedPersistStorage.setItem(KEY, { state: { ...state, language: 'en' }, version: 16 });
    await flushPendingPersistSnapshot();
    expect((await readShardState('core')).language).toBe('en');
  });

  it('removes every derived key on removeItem', async () => {
    const value: StorageValue<unknown> = { state: buildState(), version: 16 };
    debouncedPersistStorage.setItem(KEY, value);
    await flushPendingPersistSnapshot();
    expect(await readMeta()).not.toBeNull();

    debouncedPersistStorage.removeItem(KEY);
    await tick();

    expect(await readRaw(KEY)).toBeNull();
    expect(await readMeta()).toBeNull();
    for (const shard of PERSISTENCE_SHARD_NAMES) {
      expect(await readRaw(shardKeyFor(KEY, shard))).toBeNull();
    }
  });

  it('removeItem resolves only after the on-disk removal has completed', async () => {
    // Reload 2 seconds after "clear all data": removeItem must be awaitable (zustand v4
    // clearStorage does not return a Promise), otherwise reload could happen before delete commit, resurrecting data.
    debouncedPersistStorage.setItem(KEY, { state: buildState(), version: 16 });
    await flushPendingPersistSnapshot();
    expect(await readMeta()).not.toBeNull();

    // No sleep: returned Promise itself must cover the entire serial chain (queued writes -> wipe disk -> bookkeeping reset)
    await expect(debouncedPersistStorage.removeItem(KEY)).resolves.toBeUndefined();

    expect(await readRaw(KEY)).toBeNull();
    expect(await readMeta()).toBeNull();
    expect(await readRaw(shardKeyFor(KEY, 'core'))).toBeNull();
  });

  it('removePersistedSnapshot rejects when the on-disk removal fails, without poisoning the write chain', async () => {
    // Regression (CodeRabbit r4165367349): delete failure must be faithfully propagated to callers (clear data flow
    // skips state reset and reload accordingly, instead of treating leftover snapshots as deleted); simultaneously,
    // shared write chain does not reject and bookkeeping still resets, so subsequent writes fully rebuild and restore consistency.
    debouncedPersistStorage.setItem(KEY, { state: buildState(), version: 16 });
    await flushPendingPersistSnapshot();
    expect(await readMeta()).not.toBeNull();

    const originalDelete = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function () { throw new Error('simulated delete failure'); };
    try {
      await expect(removePersistedSnapshot(KEY)).rejects.toThrow('simulated delete failure');
    } finally {
      IDBObjectStore.prototype.delete = originalDelete;
    }

    // Old data on disk was not deleted (failure faithfully exposed rather than treated as success)
    expect(await readMeta()).not.toBeNull();

    // Chain not poisoned, bookkeeping reset: subsequent writes fully rebuild, rehydration yields consistent state
    const nextState = { ...buildState(), language: 'en' };
    debouncedPersistStorage.setItem(KEY, { state: nextState, version: 16 });
    await flushPendingPersistSnapshot();
    expect((await readShardState('core')).language).toBe('en');
    const rehydrated = await debouncedPersistStorage.getItem(KEY);
    expect(rehydrated?.state).toMatchObject({ theme: 'dark', language: 'en' });
  });
});

describe('idle large shard write throttling', () => {
  // Large shards are determined by serialized size of last successful write (threshold SHARD_SIZE_WARN_BYTES = 5MB);
  // construct a releases shard with a 5MB+ string.
  const bigBlob = (ch: string): string => ch.repeat(5 * 1024 * 1024 + 1024);
  const bigReleases = [{ id: 1, blob: bigBlob('x') }];

  // Verify throttling timing with real timers: inject smaller debounce/cooldown durations via __setPersistTimingsForTest.
  // Previously fake timers skipped 60s, but fake-indexeddb transaction progression relies on real macrotasks;
  // their interleaving caused CI flakiness where "cooldown expired and disk read before write committed" (hard to repro locally);
  // under real timers there is no clash between two clocks.
  // Injected values must satisfy: cooldown interval > debounce + single wait window, for cooldown to be meaningful.
  const DEBOUNCE_MS = 5;
  const INTERVAL_MS = 300;
  /** Polls disk until check passes; bounded by elapsed time (default 5s), with brief real waits between checks—iteration count cap can exhaust prematurely on very slow environments. */
  const settleUntil = async (check: () => Promise<boolean>, message: string, deadlineMs = 5000): Promise<void> => {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      if (await check()) return;
      if (Date.now() >= deadline) throw new Error(`${message} (wait timed out, actual state not satisfied)`);
      await realWait(5);
    }
  };
  const diskReleasesEquals = async (expected: unknown): Promise<boolean> => {
    const current = (await readShardState('releases')).releases;
    return JSON.stringify(current) === JSON.stringify(expected);
  };
  const realWait = async (ms: number): Promise<void> => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  };

  beforeEach(() => {
    __setPersistTimingsForTest({ debounceMs: DEBOUNCE_MS, idleTimeoutMs: 10, largeShardIdleMinIntervalMs: INTERVAL_MS });
  });

  afterEach(() => {
    __setPersistTimingsForTest({ debounceMs: 1000, idleTimeoutMs: 3000, largeShardIdleMinIntervalMs: 60_000 });
  });

  it('coalesces multiple idle writes during cooldown into one final write with latest value on disk', async () => {
    const baseState = { ...buildState(), releases: bigReleases };
    debouncedPersistStorage.setItem(KEY, { state: baseState, version: 16 });
    await flushPendingPersistSnapshot(); // Initial write establishes baseline (releases serialized size > 5MB)
    const savedAtAfterFirst = (await readMeta())?.savedAt;

    // First write in cooldown: releases reference changed -> deferred, disk keeps baseline content.
    // Negative assertion must wait for debounce dispatch to occur (debounce 5ms + idle callback cap 10ms + margin),
    // otherwise assertion might pass before dispatch, missing regressions even if throttling were removed.
    const releasesV2 = [{ id: 2, blob: bigBlob('y') }];
    debouncedPersistStorage.setItem(KEY, { state: { ...baseState, releases: releasesV2 }, version: 16 });
    await realWait(60);
    expect(await diskReleasesEquals(bigReleases)).toBe(true);

    // Second write in cooldown: merged with first write, timer re-aligned to end of cooldown
    const releasesV3 = [{ id: 3, blob: bigBlob('z') }];
    debouncedPersistStorage.setItem(KEY, {
      state: { ...baseState, releases: releasesV3, theme: 'light' },
      version: 16,
    });
    await realWait(60);
    expect(await diskReleasesEquals(bigReleases)).toBe(true);

    // Cooldown expired (300ms after last successful write): timer triggers a final write with latest value
    await settleUntil(() => diskReleasesEquals(releasesV3), 'cooldown expiration should persist latest v3 value to disk');
    expect((await readShardState('core')).theme).toBe('light');
    expect((await readMeta())?.savedAt).not.toBe(savedAtAfterFirst);
  });

  it('does not delay idle writes outside cooldown, persisting to disk immediately when ready', async () => {
    const baseState = { ...buildState(), releases: bigReleases };
    debouncedPersistStorage.setItem(KEY, { state: baseState, version: 16 });
    await flushPendingPersistSnapshot();

    // Exceeded cooldown interval since last write: debounce + idle writes directly upon timer expiry without extra delay
    await realWait(INTERVAL_MS + 150);
    const releasesV2 = [{ id: 2, blob: bigBlob('y') }];
    debouncedPersistStorage.setItem(KEY, { state: { ...baseState, releases: releasesV2 }, version: 16 });
    await settleUntil(() => diskReleasesEquals(releasesV2), 'write outside cooldown should immediately persist v2 to disk');
  });

  it('bypasses throttling for non-idle sources like flush, persisting immediately even during cooldown', async () => {
    const baseState = { ...buildState(), releases: bigReleases };
    debouncedPersistStorage.setItem(KEY, { state: baseState, version: 16 });
    await flushPendingPersistSnapshot();

    // Immediately after writing large shard (in cooldown): flush (pagehide/visibilitychange path) must persist immediately
    const releasesV2 = [{ id: 2, blob: bigBlob('y') }];
    debouncedPersistStorage.setItem(KEY, { state: { ...baseState, releases: releasesV2 }, version: 16 });
    await flushPendingPersistSnapshot();
    await settleUntil(() => diskReleasesEquals(releasesV2), 'flush should bypass cooldown and immediately persist v2 to disk');
  });

  it('immediately persists when only small shards change during large shard cooldown', async () => {
    const baseState = { ...buildState(), releases: bigReleases };
    debouncedPersistStorage.setItem(KEY, { state: baseState, version: 16 });
    await flushPendingPersistSnapshot();

    // releases reference unchanged (only core theme changed): does not enter large shard cooldown, persists immediately after debounce
    debouncedPersistStorage.setItem(KEY, { state: { ...baseState, theme: 'light' }, version: 16 });
    await settleUntil(async () => (await readShardState('core')).theme === 'light', 'small shard only change should persist immediately');
    expect((await readShardState('releases')).releases).toEqual(bigReleases);
  });

  it('does not block concurrent dirty shards during large shard cooldown: core persists immediately, releases persists after expiry', async () => {
    const baseState = { ...buildState(), releases: bigReleases };
    debouncedPersistStorage.setItem(KEY, { state: baseState, version: 16 });
    await flushPendingPersistSnapshot(); // Baseline = v1

    // releases (large shard, in cooldown) and core change simultaneously: core writes immediately, releases is deferred
    const releasesV2 = [{ id: 2, blob: bigBlob('y') }];
    debouncedPersistStorage.setItem(KEY, {
      state: { ...baseState, releases: releasesV2, theme: 'light' },
      version: 16,
    });
    await settleUntil(async () => (await readShardState('core')).theme === 'light', 'core change should not be held back by large shard cooldown');
    expect(await diskReleasesEquals(bigReleases)).toBe(true); // releases not persisted during cooldown

    await settleUntil(() => diskReleasesEquals(releasesV2), 'releases should persist v2 after cooldown expires');
  });

  it('defers queued subsequent large shard writes according to cooldown after an in-flight large shard commits', async () => {
    // When dispatching v3, cooldown relative to old baseline (v1) already expired, but v2 only commits between dispatch and execution—
    // write execution must re-check cooldown against latest commit time, otherwise interval between two large shard writes is shorter than cooldown.
    const baseState = { ...buildState(), releases: bigReleases };
    debouncedPersistStorage.setItem(KEY, { state: baseState, version: 16 });
    await flushPendingPersistSnapshot(); // Baseline = v1 (committed at T0)
    await realWait(INTERVAL_MS + 150); // Cooldown relative to T0 has expired

    try {
      commitGate.arm();
      const releasesV2 = [{ id: 2, blob: bigBlob('y') }];
      debouncedPersistStorage.setItem(KEY, { state: { ...baseState, releases: releasesV2 }, version: 16 });
      const flushing = flushPendingPersistSnapshot(); // v2 write begins and halts at commit gate (in flight)
      await commitGate.waitReached();

      // Dispatch v3: cooldown expired relative to old baseline (v1) -> queued immediately behind in-flight v2
      const releasesV3 = [{ id: 3, blob: bigBlob('z') }];
      debouncedPersistStorage.setItem(KEY, { state: { ...baseState, releases: releasesV3 }, version: 16 });
      await realWait(60);

      commitGate.release(); // v2 commits (lastShardWriteAt updated to current time)
      await flushing;
      // v3 write execution re-checks cooldown: interval since v2 commit is less than cooldown -> deferred instead of immediate write
      await realWait(60);
      expect(await diskReleasesEquals(releasesV2)).toBe(true);

      await settleUntil(() => diskReleasesEquals(releasesV3), 'v3 should persist to disk after cooldown expires');
    } finally {
      commitGate.reset();
    }
  });

  it('does not drop restored updates when state is changed back to old value before in-flight write commits', async () => {
    // commitGate intercepts commit entrance creating deterministic in-flight window: v2 write arrived at
    // setStorageEntries but uncommitted; lastWrittenShards is still v1 old baseline—when state is changed
    // back to old baseline, dispatch evaluates dirty as empty against old baseline and must not discard this update.
    const baseState = { ...buildState(), releases: bigReleases };
    debouncedPersistStorage.setItem(KEY, { state: baseState, version: 16 });
    await flushPendingPersistSnapshot(); // Baseline = v1

    try {
      commitGate.arm();
      const releasesV2 = [{ id: 2, blob: bigBlob('y') }];
      debouncedPersistStorage.setItem(KEY, { state: { ...baseState, releases: releasesV2 }, version: 16 });
      const flushing = flushPendingPersistSnapshot(); // v2 write starts and halts at commit point
      await commitGate.waitReached(); // v2 in-flight, uncommitted
      debouncedPersistStorage.setItem(KEY, { state: baseState, version: 16 }); // Change back to old baseline
      // While gate is held, wait for debounce (5ms) + idle callback (10ms) dispatch to occur: evaluated
      // dirty is empty against old baseline. Releasing early would commit v2 first and make dirty non-empty, invalidating test.
      await realWait(60);
      commitGate.release(); // Release v2 commit
      await flushing;
      await settleUntil(() => diskReleasesEquals(bigReleases), 'update restoring old value should not be discarded by in-flight write');
    } finally {
      commitGate.reset(); // Error path resets so gate state does not leak to subsequent test cases
    }
  });
});

describe('indexedDbStorage batch helpers', () => {
  it('writes every entry to localStorage on the fallback path', async () => {
    await writeEntriesToFallbackStorage(KEY, [['fallback-a', '1'], ['fallback-b', '2']]);
    expect(window.localStorage.getItem('fallback-a')).toBe('1');
    expect(window.localStorage.getItem('fallback-b')).toBe('2');
    window.localStorage.removeItem('fallback-a');
    window.localStorage.removeItem('fallback-b');
  });

  it('rolls back the whole fallback batch when any key write fails', async () => {
    // Under Node >= 24 native localStorage imported via vitest can return a new wrapper object on every access,
    // making vi.spyOn unreliable; replacing completely with a controllable fake guarantees module and test see the exact same instance.
    // Pre-populate fallback-a in the batch with an old value: rollback must restore the old value rather than deleting it
    // (meta still references this shard key, and deletion would be misidentified as a missing shard during hydration).
    const backing = new Map<string, string>([
      ['fallback-a', 'old-committed-core'],
      ['fallback-c', 'previous'],
    ]);
    const failingStorage: Storage = {
      clear: () => backing.clear(),
      getItem: (key: string) => (backing.has(key) ? (backing.get(key) as string) : null),
      key: (index: number) => Array.from(backing.keys())[index] ?? null,
      removeItem: (key: string) => {
        backing.delete(key);
      },
      setItem: (key: string, value: string) => {
        if (key === 'fallback-b') throw new Error('quota exceeded');
        backing.set(key, String(value));
      },
      get length() {
        return backing.size;
      },
    };
    const savedDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, value: failingStorage });
    try {
      await expect(writeEntriesToFallbackStorage(KEY, [['fallback-a', '1'], ['fallback-b', '2']])).rejects.toThrow();
      // Overwritten keys restore previous values; keys newly added in this batch are rolled back and deleted; keys outside batch are unaffected
      expect(backing.get('fallback-a')).toBe('old-committed-core');
      expect(backing.has('fallback-b')).toBe(false);
      expect(backing.get('fallback-c')).toBe('previous');
    } finally {
      if (savedDescriptor) {
        Object.defineProperty(window, 'localStorage', savedDescriptor);
      } else {
        delete (window as unknown as Record<string, unknown>).localStorage;
      }
    }
  });

  it('marks localStorage as the authority after a fallback write so stale IDB values cannot shadow it', async () => {
    // F1 regression (CodeRabbit thread r4164377998): after an IDB batch write fails but fallback write succeeds,
    // stale IndexedDB shards/meta must be invalidated, otherwise restart hydration will silently roll back to stale state.
    await setStorageEntries(KEY, [[`${KEY}#shard:core`, 'OLD-FROM-IDB'], [metaKeyFor(KEY), '{"format":1}']]);

    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () { throw new Error('simulated quota exceeded'); };
    try {
      await setStorageEntries(KEY, [[`${KEY}#shard:core`, 'NEW-FROM-FALLBACK']]);
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }

    // Strict read must return the new value from fallback write (rather than stale IDB value)
    expect(await readStrict(`${KEY}#shard:core`)).toBe('NEW-FROM-FALLBACK');
    // localStorage authority marker is set
    expect(window.localStorage.getItem(`${KEY}#fallback`)).not.toBeNull();

    // The next successful write after IDB recovers clears authority marker and writes back to IDB
    await setStorageEntries(KEY, [[`${KEY}#shard:core`, 'NEWER-FROM-IDB']]);
    expect(await readStrict(`${KEY}#shard:core`)).toBe('NEWER-FROM-IDB');
  });

  it('falls back to localStorage for batch-read keys missing from IndexedDB even without the authority marker', async () => {
    // Extreme edge case (e.g. fallback marker itself fails to write): IDB lacks this key but localStorage has value and no marker;
    // batch strict read must fall back to localStorage consistently with single-key strict read, rather than judging shard missing.
    window.localStorage.setItem(`${KEY}#shard:core`, 'LS-ONLY');
    try {
      expect(await getStorageEntriesStrict(KEY, [`${KEY}#shard:core`])).toEqual(['LS-ONLY']);
      // Comparison: when IDB has the key, IDB value takes precedence (LS mirror will not be mistakenly used)
      await setStorageEntries(KEY, [[`${KEY}#shard:core`, 'IDB-VALUE']]);
      expect(await getStorageEntriesStrict(KEY, [`${KEY}#shard:core`])).toEqual(['IDB-VALUE']);
    } finally {
      window.localStorage.removeItem(`${KEY}#shard:core`);
      await indexedDBStorage.removeItem(`${KEY}#shard:core`);
    }
  });

  it('writes batch entries through the IndexedDB path and reads them back', async () => {
    await setStorageEntries(KEY, [['idb-a', '1'], ['idb-b', '2']]);
    expect(await indexedDBStorage.getItem('idb-a')).toBe('1');
    expect(await indexedDBStorage.getItem('idb-b')).toBe('2');
    await indexedDBStorage.removeItem('idb-a');
    await indexedDBStorage.removeItem('idb-b');
  });

  it('migrates an existing localStorage snapshot when reading a key missing from IndexedDB', async () => {
    window.localStorage.setItem('migrate-me', '{"legacy":true}');
    try {
      expect(await indexedDBStorage.getItem('migrate-me')).toBe('{"legacy":true}');
      // Read-as-migrate: snapshot enters IndexedDB, localStorage mirror is cleared
      expect(window.localStorage.getItem('migrate-me')).toBeNull();
      expect(await readRaw('migrate-me')).toBe('{"legacy":true}');
    } finally {
      await indexedDBStorage.removeItem('migrate-me');
    }
  });

  it('sweeps derived `${name}#` keys from localStorage on removeItem', async () => {
    window.localStorage.setItem(KEY, 'legacy');
    window.localStorage.setItem(`${KEY}#shard:core`, '{}');
    window.localStorage.setItem(`${KEY}#meta`, '{}');
    window.localStorage.setItem('unrelated-key', 'keep');

    await indexedDBStorage.removeItem(KEY);

    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(window.localStorage.getItem(`${KEY}#shard:core`)).toBeNull();
    expect(window.localStorage.getItem(`${KEY}#meta`)).toBeNull();
    expect(window.localStorage.getItem('unrelated-key')).toBe('keep');
    window.localStorage.removeItem('unrelated-key');
  });
});
