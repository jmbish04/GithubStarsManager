
/**
 * Sharded persistence layout (Development Guidelines §7 Performance Rules).
 *
 * Historical versions serialized the entire partialize result into a single IndexedDB key.
 * Any state change (including toggling a modal) required re-stringifying and rewriting all data
 * (empirically up to ~144MB, ~130ms stringify + ~270ms write, continually blocking the main thread).
 *
 * Sharding principles:
 * - Heavy, infrequently changed data (repositories/gists/releases/forks/accountWorkspaces/
 *   trendingSnapshots) reside in independent shards, rewritten only when contents actually change (reference dirty check);
 * - Lightweight, frequently changed preferences and view states are aggregated into the core shard, with single rewrites taking only a few KB;
 * - Future keys added to partialize are safely defaulted to core by resolveShardForField,
 *   ensuring no persisted field is lost due to a missing shard mapping.
 *
 * ── Hard Contract ────────────────────────────────────────────────────────
 * 1. Immutable updates: Shards checking dirty status by "field reference" relies on persisted fields always being updated immutably.
 *    Any in-place mutation (push/sort/index assignment) to repositories/gists/releases/forks/accountWorkspaces/trendingSnapshots
 *    will silently fail to persist because the reference did not change.
 *    New code must use immutable updates (an established convention in the zustand ecosystem).
 * 2. Format version: When bumping PERSISTENCE_SHARD_FORMAT, you must provide
 *    a migration branch for older formats in readPersistedSnapshot; changing only the constant makes older shards unreadable,
 *    and the legacy single-key snapshot was retired after the initial migration—resulting in an empty startup overwriting all data.
 * ─────────────────────────────────────────────────────────────────────────
 */

export const PERSISTENCE_SHARD_FORMAT = 1;

export type PersistenceShardName =
  | 'core'
  | 'repositories'
  | 'gists'
  | 'releases'
  | 'forks'
  | 'accountWorkspaces'
  | 'trendingSnapshots';

export const PERSISTENCE_SHARD_NAMES: readonly PersistenceShardName[] = [
  'core',
  'repositories',
  'gists',
  'releases',
  'forks',
  'accountWorkspaces',
  'trendingSnapshots',
];

export const PERSISTENCE_SHARD_FIELDS: Record<PersistenceShardName, readonly string[]> = {
  // Lightweight, frequently changed preference/view/config state; single stringify + write is only a few KB.
  core: [
    'user',
    'githubToken',
    'isAuthenticated',
    'themeTokens',
    'gistSearchFilters',
    'selectedGistCategory',
    'analyzingGistIds',
    'aiConfigs',
    'activeAIConfig',
    'repositoryChatSettings',
    'embeddingConfigs',
    'activeEmbeddingConfig',
    'vectorSearchConfig',
    'vectorSearchStatus',
    'mcpConfig',
    'webdavConfigs',
    'activeWebDAVConfig',
    'lastBackup',
    'releaseSubscriptions',
    'releaseSourceSettings',
    'readReleases',
    'readForks',
    'customCategories',
    'hiddenDefaultCategoryIds',
    'categoryOrder',
    'collapsedSidebarCategoryCount',
    'categoryMatchMode',
    'defaultCategoryOverrides',
    'assetFilters',
    'repositoryCardFields',
    'repositoryCardActions',
    'lastSync',
    'theme',
    'themePreset',
    'currentView',
    'selectedCategory',
    'language',
    'translationEngine',
    'autoTranslateRepoDescription',
    'isSidebarCollapsed',
    'headerMenuConfig',
    'backendApiSecret',
    'syncMode',
    'syncModeConfigured',
    'categoryListIdMap',
    'searchFilters',
    'repositoryViewMode',
    'releaseViewMode',
    'releaseShowMode',
    'releaseLatestMode',
    'releaseSelectedFilters',
    'releaseSearchQuery',
    'releaseExpandedRepositories',
    'includePreRelease',
    'includeKeysInBackup',
    'forkViewMode',
    'forkSelectedFilters',
    'forkSearchQuery',
    'forkExpandedRepositories',
    'discoveryChannels',
    'selectedDiscoveryChannel',
    'discoveryPlatform',
    'discoveryLanguage',
    'discoverySortBy',
    'discoverySortOrder',
    'discoverySelectedTopic',
    'weeklyOnlyCollected',
    'xTweetFollows',
    'xTweetAuthRevision',
    'telegramFollows',
    'proxyConfig',
    'rpcDownloadConfig',
    'routeMode',
  ],
  // The following are heavy, infrequently changed data shards: rewritten only when corresponding array references change.
  repositories: ['repositories'],
  gists: ['gists', 'starredGists'],
  releases: ['releases'],
  forks: ['forks'],
  // Snapshots full data per account on logout, potentially becoming the largest shard; checks dirty state per account (see
  // accountWorkspacesUnchanged) to prevent new object references produced by hydration normalization from triggering full rewrites.
  accountWorkspaces: ['accountWorkspaces'],
  trendingSnapshots: ['trendingSnapshots'],
};

const FIELD_TO_SHARD = new Map<string, PersistenceShardName>();
for (const [shard, fields] of Object.entries(PERSISTENCE_SHARD_FIELDS)) {
  for (const field of fields) {
    if (FIELD_TO_SHARD.has(field)) {
      throw new Error(`[persistence] field "${field}" is assigned to more than one shard`);
    }
    FIELD_TO_SHARD.set(field, shard as PersistenceShardName);
  }
}

/** Fallback unknown fields to core, ensuring newly added persisted fields are not lost if mapping is missing. */
export const resolveShardForField = (field: string): PersistenceShardName =>
  FIELD_TO_SHARD.get(field) ?? 'core';

export const shardKeyFor = (name: string, shard: PersistenceShardName): string =>
  `${name}#shard:${shard}`;

export const metaKeyFor = (name: string): string => `${name}#meta`;

/** Shard manifest written to the meta key; used as source of truth to assemble full snapshot on read. */
export interface ShardMeta {
  format: number;
  version: number;
  shards: PersistenceShardName[];
  savedAt: string;
}

/** Persistence payload for an individual shard. */
export interface ShardPayload {
  format: number;
  version: number;
  state: Record<string, unknown>;
}

/** Constructs a field view for each shard from partialize output (preserves original references, no copying). */
export const buildShardViews = (
  state: Record<string, unknown>,
): Record<PersistenceShardName, Record<string, unknown>> => {
  const views = {} as Record<PersistenceShardName, Record<string, unknown>>;
  for (const shard of PERSISTENCE_SHARD_NAMES) {
    views[shard] = {};
  }
  for (const [field, value] of Object.entries(state)) {
    views[resolveShardForField(field)][field] = value;
  }
  return views;
};

// Account workspace: heavy arrays are compared by reference; small objects reconstructed by normalization are compared by value,
// preventing new post-hydration references from being falsely identified as actual changes.
// Maintenance contract: every field in AccountWorkspace must appear in exactly one of these lists
// (covered by assertions in storage.test.ts); otherwise content changes to new fields will be missed by dirty checking.
export const WORKSPACE_REFERENCE_FIELDS = [
  'repositories',
  'gists',
  'starredGists',
  'releases',
  'forks',
  'customCategories',
  'categoryOrder',
  'readReleases',
  'readForks',
  'releaseSubscriptions',
  'hiddenDefaultCategoryIds',
] as const;

export const WORKSPACE_VALUE_FIELDS = [
  'lastSync',
  'selectedGistCategory',
  'releaseSourceSettings',
  'defaultCategoryOverrides',
  'categoryListIdMap',
  'syncMode',
  'syncModeConfigured',
] as const;

const smallValueEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

const accountWorkspacesUnchanged = (prev: unknown, next: unknown): boolean => {
  if (Object.is(prev, next)) return true;
  if (!prev || !next || typeof prev !== 'object' || typeof next !== 'object') return false;
  if (Array.isArray(prev) || Array.isArray(next)) return false;
  const prevRecord = prev as Record<string, unknown>;
  const nextRecord = next as Record<string, unknown>;
  const prevKeys = Object.keys(prevRecord);
  if (prevKeys.length !== Object.keys(nextRecord).length) return false;
  for (const accountId of prevKeys) {
    if (!Object.prototype.hasOwnProperty.call(nextRecord, accountId)) return false;
    const prevWorkspace = prevRecord[accountId];
    const nextWorkspace = nextRecord[accountId];
    if (Object.is(prevWorkspace, nextWorkspace)) continue;
    if (!prevWorkspace || !nextWorkspace
      || typeof prevWorkspace !== 'object' || typeof nextWorkspace !== 'object') {
      return false;
    }
    const a = prevWorkspace as Record<string, unknown>;
    const b = nextWorkspace as Record<string, unknown>;
    // Differing unknown field counts are treated as changed to avoid missing extra fields from historical snapshots.
    if (Object.keys(a).length !== Object.keys(b).length) return false;
    for (const field of WORKSPACE_REFERENCE_FIELDS) {
      if (!Object.is(a[field], b[field])) return false;
    }
    for (const field of WORKSPACE_VALUE_FIELDS) {
      if (!smallValueEqual(a[field], b[field])) return false;
    }
  }
  return true;
};

/**
 * Identifies shards that changed relative to the last successful write.
 *
 * - Heavy data shards check dirty status by field reference (zustand immutable updates ensure unchanged fields keep identical references);
 * - core shard checks dirty status by value: partialize reconstructs multiple small objects/arrays on every call
 *   (searchFilters, proxyConfig, Array.from(Set), etc.), so checking by reference would keep core
 *   permanently dirty; core size is only a few KB, making JSON content comparison negligible in cost.
 */
export const findDirtyShards = (
  views: Record<PersistenceShardName, Record<string, unknown>>,
  lastWritten: Record<PersistenceShardName, Record<string, unknown>> | null,
): PersistenceShardName[] => {
  if (!lastWritten) return [...PERSISTENCE_SHARD_NAMES];
  return PERSISTENCE_SHARD_NAMES.filter((shard) => {
    const next = views[shard];
    const prev = lastWritten[shard];
    if (!prev) return true;
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    for (const key of keys) {
      if (shard === 'accountWorkspaces' && key === 'accountWorkspaces') {
        if (!accountWorkspacesUnchanged(prev[key], next[key])) return true;
        continue;
      }
      if (shard === 'core') {
        if (!smallValueEqual(prev[key], next[key])) return true;
        continue;
      }
      if (!Object.is(prev[key], next[key])) return true;
    }
    return false;
  });
};
