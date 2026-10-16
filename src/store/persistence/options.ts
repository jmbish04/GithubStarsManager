
import type { PersistOptions, PersistStorage } from 'zustand/middleware';
import type { Repository, SubscriptionChannel } from '../../types';
import { defaultHeaderMenuConfig, defaultReleaseSourceSettings, defaultSubscriptionChannels } from '../../types';
import { defaultRepositoryChatSettings } from '../../types/repositoryChat';
import { logger } from '../../services/logger';
import { normalizeReleaseSourceSettings } from '../../utils/releaseSources';
import { normalizeXTweetFollows } from '../../utils/xTweetFollows';
import { normalizeTelegramFollows } from '../../utils/telegramFollows';
import { normalizeExternalDiscoveryChannels } from '../../utils/discoveryFeeds';
import type { AppStoreState } from '../types';
import {
  defaultDiscoveryChannels,
  normalizeMcpConfig,
  normalizeRepositoryChatSettings,
  normalizeVectorSearchConfig,
  normalizeVectorSearchStatus,
  PersistedAppState,
} from '../schema';
import { normalizePersistedState } from '../normalizers/persistedState';
import { writeAuthMirror } from './authStorage';
import { debouncedPersistStorage } from './storage';

export const appPersistenceOptions: PersistOptions<AppStoreState, PersistedAppState> = {
  name: 'github-stars-manager',
  version: 16,
  storage: debouncedPersistStorage as PersistStorage<PersistedAppState>,
partialize: (state) => ({
  // Persist user info and authentication state
  user: state.user,
  githubToken: state.githubToken,
  isAuthenticated: state.isAuthenticated,
  accountWorkspaces: state.accountWorkspaces,

  // Persist repository data
  repositories: state.repositories,
  lastSync: state.lastSync,

  // Theme tokens (Development Guidelines §14): declarative appearance preferences
  themeTokens: state.themeTokens,

  // Persist Gist data
  gists: state.gists,
  starredGists: state.starredGists,
  gistSearchFilters: {
sortBy: state.gistSearchFilters.sortBy,
sortOrder: state.gistSearchFilters.sortOrder,
  },
  selectedGistCategory: state.selectedGistCategory,
  analyzingGistIds: Array.from(state.analyzingGistIds),

  // Persist AI config
  aiConfigs: state.aiConfigs,
  activeAIConfig: state.activeAIConfig,
  repositoryChatSettings: state.repositoryChatSettings,

  // Persist Embedding config
  embeddingConfigs: state.embeddingConfigs,
  activeEmbeddingConfig: state.activeEmbeddingConfig,

  // Persist vector search config
  vectorSearchConfig: state.vectorSearchConfig,
  // Persist vector search status (vectorCount etc., retained across restarts)
  vectorSearchStatus: state.vectorSearchStatus,

  // MCP prefs + bearer token (stable across restarts; only changes on user reset)
  mcpConfig: state.mcpConfig,

  // Persist WebDAV config
  webdavConfigs: state.webdavConfigs,
  activeWebDAVConfig: state.activeWebDAVConfig,
  lastBackup: state.lastBackup,

  // Persist release subscriptions, sources, and read status
  releaseSubscriptions: Array.from(state.releaseSubscriptions),
  releaseSourceSettings: state.releaseSourceSettings,
  readReleases: Array.from(state.readReleases),
  releases: state.releases,

  // Persist Fork data
  forks: state.forks,
  readForks: Array.from(state.readForks),

  // Persist custom categories
  customCategories: state.customCategories,
  hiddenDefaultCategoryIds: state.hiddenDefaultCategoryIds,
  categoryOrder: state.categoryOrder,
  collapsedSidebarCategoryCount: state.collapsedSidebarCategoryCount,
  categoryMatchMode: state.categoryMatchMode,
  defaultCategoryOverrides: state.defaultCategoryOverrides,

  // Persist asset filters
  assetFilters: state.assetFilters,
  // Card visible fields (Development Guidelines §14)
  repositoryCardFields: state.repositoryCardFields,
  repositoryCardActions: state.repositoryCardActions,

  // Trending snapshots (Development Guidelines §7): local trending history, not synced remotely
  trendingSnapshots: state.trendingSnapshots,

  // Persist UI settings
  theme: state.theme,
  themePreset: state.themePreset,
  currentView: state.currentView,
  selectedCategory: state.selectedCategory,
  language: state.language,
  translationEngine: state.translationEngine,
  autoTranslateRepoDescription: state.autoTranslateRepoDescription,
  isSidebarCollapsed: state.isSidebarCollapsed,
  headerMenuConfig: state.headerMenuConfig,

  // Persist backend API Secret (retained across sessions/tabs, fixing #259). Also preserve
  // localStorage mirror (AUTH_MIRROR_KEY) as fallback when asynchronous IndexedDB write fails.
  backendApiSecret: state.backendApiSecret,

  // Persist sync scope configuration (GitHub Lists sync)
  syncMode: state.syncMode,
  syncModeConfigured: state.syncModeConfigured,
  // Persist category -> GitHub List mapping (cross-language stable identity)
  categoryListIdMap: state.categoryListIdMap,

  // Persist search sort settings
  searchFilters: {
sortBy: state.searchFilters.sortBy,
sortOrder: state.searchFilters.sortOrder,
  },

  // Persist repository page view settings
  repositoryViewMode: state.repositoryViewMode,
  // Persist release page view settings
  releaseViewMode: state.releaseViewMode,
  releaseShowMode: state.releaseShowMode,
  releaseLatestMode: state.releaseLatestMode,
  releaseSelectedFilters: state.releaseSelectedFilters,
  releaseSearchQuery: state.releaseSearchQuery,
  releaseExpandedRepositories: Array.from(state.releaseExpandedRepositories),
  includePreRelease: state.includePreRelease,
  includeKeysInBackup: state.includeKeysInBackup,

  // Persist fork page view settings
  forkViewMode: state.forkViewMode,
  forkSelectedFilters: state.forkSelectedFilters,
  forkSearchQuery: state.forkSearchQuery,
  forkExpandedRepositories: Array.from(state.forkExpandedRepositories),

// Persist discovery settings
discoveryChannels: state.discoveryChannels,
selectedDiscoveryChannel: state.selectedDiscoveryChannel,
// discoveryRepos is not persisted because it is an enormous JSON object.
// During the IDB partialize phase on Electron 41/v8/macOS,
// frequently serializing this large multi-MB object triggers underlying JIT CHECK assertion failed (brk 0) crashes.
// All session-level runtime data here is excluded from persistence:
// discoveryRepos
// discoveryLastRefresh
// discoveryTotalCount
// discoveryHasMore
// discoveryNextPage
discoveryPlatform: state.discoveryPlatform,
discoveryLanguage: state.discoveryLanguage,
discoverySortBy: state.discoverySortBy,
discoverySortOrder: state.discoverySortOrder,
discoverySelectedTopic: state.discoverySelectedTopic,
  weeklyOnlyCollected: state.weeklyOnlyCollected,
  xTweetFollows: state.xTweetFollows,
  // xTweetAuth is only encrypted and stored via desktop safeStorage (memory-only in web mode) to avoid writing plaintext cookies to IndexedDB/localStorage (CWE-922).
  // Only non-sensitive xTweetAuthRevision is persisted for cross-session request signature stability.
  xTweetAuthRevision: state.xTweetAuthRevision,
  telegramFollows: state.telegramFollows,
// Persist complete proxy configuration including auth password, ensuring no re-entry on restart.
proxyConfig: {
  enabled: state.proxyConfig.enabled,
  type: state.proxyConfig.type,
  host: state.proxyConfig.host,
  port: state.proxyConfig.port,
  username: state.proxyConfig.username,
  password: state.proxyConfig.password,
},
// Persist RPC download configuration (including secret to avoid loss on restart)
rpcDownloadConfig: {
  enabled: state.rpcDownloadConfig.enabled,
  host: state.rpcDownloadConfig.host,
  port: state.rpcDownloadConfig.port,
  secret: state.rpcDownloadConfig.secret,
},
routeMode: state.routeMode,
}),
migrate: (persistedState) => {
  // Version upgrade adaptation handling
  const state = persistedState as PersistedAppState | undefined;

  if (state && !state.releaseSourceSettings) {
console.log('Migrating from old version: initializing releaseSourceSettings');
state.releaseSourceSettings = defaultReleaseSourceSettings;
  } else if (state) {
state.releaseSourceSettings = normalizeReleaseSourceSettings(state.releaseSourceSettings);
  }

  // Ensure categoryOrder field exists when upgrading from older versions
  if (state && !Array.isArray(state.categoryOrder)) {
console.log('Migrating from old version: initializing categoryOrder');
state.categoryOrder = [];
  }

  // Ensure collapsedSidebarCategoryCount field exists when upgrading from older versions
  if (state && typeof state.collapsedSidebarCategoryCount !== 'number') {
console.log('Migrating from old version: initializing collapsedSidebarCategoryCount');
state.collapsedSidebarCategoryCount = 20;
  }

  // Ensure defaultCategoryOverrides field exists when upgrading from older versions
  if (state && typeof state.defaultCategoryOverrides !== 'object') {
console.log('Migrating from old version: initializing defaultCategoryOverrides');
state.defaultCategoryOverrides = {};
  }

  // Ensure vectorSearchStatus field exists when upgrading from older versions (vectorCount etc.)
  if (state) {
state.vectorSearchStatus = normalizeVectorSearchStatus(state.vectorSearchStatus);
  }

  // Additive: MCP config defaults when missing (upgrade). Old builds ignore this key on downgrade.
  if (state) {
const stateRecord = state as Record<string, unknown>;
stateRecord.mcpConfig = normalizeMcpConfig(stateRecord.mcpConfig);
  }

  // Migrate legacy flags in repository data
  if (state && Array.isArray(state.repositories)) {
let migratedCount = 0;
state.repositories = state.repositories.map((repo: Repository) => {
  // Convert legacy '__EMPTY__' flag to empty string (indicating user explicitly cleared it)
  if (repo.custom_description === '__EMPTY__') {
    migratedCount++;
    return { ...repo, custom_description: '' };
  }
  return repo;
});
if (migratedCount > 0) {
  console.log(`Migrated ${migratedCount} repositories: converted '__EMPTY__' to empty string`);
}
  }

  if (state && !state.selectedDiscoveryChannel) {
state.selectedDiscoveryChannel = 'trending';
  }
  if (state && (!state.discoveryChannels || !Array.isArray(state.discoveryChannels))) {
state.discoveryChannels = defaultDiscoveryChannels;
  } else if (state && Array.isArray(state.discoveryChannels)) {
const persistedChannels = state.discoveryChannels as unknown[];
state.discoveryChannels = [...defaultDiscoveryChannels.map((defaultChannel) => {
const persistedChannel = persistedChannels.find((channel) => {
  return (channel as Record<string, unknown>)?.id === defaultChannel.id;
}) as Record<string, unknown> | undefined;

if (!persistedChannel) {
  return defaultChannel;
}

return {
...defaultChannel,
enabled: persistedChannel.enabled !== false,
};
}), ...normalizeExternalDiscoveryChannels(persistedChannels)];
  }
  // Migrate subscription channels (version 4->5: daily-dev -> most-dev, add trending, backfill nameEn)
  const defaultChannelsMap = new Map(defaultSubscriptionChannels.map(ch => [ch.id, ch]));
  if (state && !Array.isArray(state.subscriptionChannels)) {
console.log('Migrating: initializing subscription channels');
state.subscriptionChannels = defaultSubscriptionChannels;
  } else if (state && Array.isArray(state.subscriptionChannels)) {
state.subscriptionChannels = state.subscriptionChannels.map((ch: unknown) => {
const chRecord = ch as Record<string, unknown>;
const defaultCh = defaultChannelsMap.get(chRecord.id as string);
if (chRecord.id === 'daily-dev' || chRecord.id === 'most-dev') {
  return { ...chRecord, id: 'most-dev', name: '热门开发者', nameEn: 'Top Developers', icon: '👤' } as unknown as SubscriptionChannel;
}
if (defaultCh) {
  return {
...(chRecord as Partial<SubscriptionChannel>),
name: defaultCh.name, // Always use default definition name
nameEn: (chRecord.nameEn as string) || defaultCh.nameEn || (chRecord.name as string) || defaultCh.nameEn,
icon: (chRecord.icon as string) || defaultCh.icon,
description: (chRecord.description as string) || defaultCh.description,
  } as unknown as SubscriptionChannel;
}
return chRecord as unknown as SubscriptionChannel;
});
// Ensure trending channel exists (add if missing)
const hasTrending = state.subscriptionChannels.some((ch: SubscriptionChannel) => ch.id === 'trending');
if (!hasTrending) {
console.log('Migrating: adding trending channel');
state.subscriptionChannels.push({
  id: 'trending',
  name: '热门趋势',
  nameEn: 'Trending',
  icon: 'trending',
  description: 'GitHub 上近期最受关注的项目 Top 10',
  enabled: true,
} as SubscriptionChannel);
}
  }
  if (state && !state.discoveryPlatform) {
state.discoveryPlatform = 'All';
  }
  // Version 6->7: add includeKeysInBackup (default false, security first)
  if (state && typeof state.includeKeysInBackup !== 'boolean') {
console.log('Migrating: initializing includeKeysInBackup to false (security first)');
state.includeKeysInBackup = false;
  }
  if (state && !state.discoveryLanguage) {
state.discoveryLanguage = 'All';
  }
  if (state && !state.discoverySortBy) {
state.discoverySortBy = 'BestMatch';
  }
  if (state && !state.discoverySortOrder) {
state.discoverySortOrder = 'Descending';
  }
  // discoveryIsLoading should not be persisted; always reset on migrate to prevent spread crash on malformed legacy data
  if (state) {
(state as Record<string, unknown>).discoveryIsLoading = {
'trending': false, 'hot-release': false, 'most-popular': false, 'topic': false, 'x-tweet': false, 'telegram': false, 'weekly': false, 'search': false, 'code-search': false,
};
// discoveryScrollPositions also should not be persisted; reset to avoid stale scroll positions
(state as Record<string, unknown>).discoveryScrollPositions = {
'trending': 0, 'hot-release': 0, 'most-popular': 0, 'topic': 0, 'x-tweet': 0, 'telegram': 0, 'weekly': 0, 'search': 0, 'code-search': 0,
};
  }

  // v14: Fallback for weekly channel filter preference
  if (state && typeof (state as Record<string, unknown>).weeklyOnlyCollected !== 'boolean') {
    (state as Record<string, unknown>).weeklyOnlyCollected = false;
  }

  // v14->v15: Fallback for X tweet channel options (follow list includes geekbb by default)
  if (state) {
    const stateRecord = state as Record<string, unknown>;
    stateRecord.xTweetFollows = normalizeXTweetFollows(stateRecord.xTweetFollows);
    // Legacy snapshots might contain plaintext xTweetAuth: delete directly (without dropping whole snapshot), set in-memory state to null;
    // the cleaned snapshot is written back to IndexedDB/localStorage on the next persist.
    if ('xTweetAuth' in stateRecord) delete stateRecord.xTweetAuth;
    if (typeof stateRecord.xTweetAuthRevision !== 'number' || !Number.isFinite(stateRecord.xTweetAuthRevision)) {
      stateRecord.xTweetAuthRevision = 0;
    }
    (state as Record<string, unknown>).telegramFollows = normalizeTelegramFollows(
      (state as Record<string, unknown>).telegramFollows,
    );
  }

  // v5->v6: Initialize proxyConfig
  if (state && !(state as Record<string, unknown>).proxyConfig) {
(state as Record<string, unknown>).proxyConfig = { enabled: false, type: 'http', host: '', port: 7890 };
  }

  // Initialize rpcDownloadConfig
  if (state && !(state as Record<string, unknown>).rpcDownloadConfig) {
(state as Record<string, unknown>).rpcDownloadConfig = { enabled: false, host: '', port: 6800 };
  }

  // v12->v13: Initialize routeMode (purely local preference, falls back to auto if missing or invalid, not synced with backend/autoSync)
  if (state) {
    const stateRecord = state as Record<string, unknown>;
    if (stateRecord.routeMode !== 'backend' && stateRecord.routeMode !== 'browser') {
      stateRecord.routeMode = 'auto';
    }
  }

  // v8->v9: Initialize headerMenuConfig
  if (state && !Array.isArray((state as Record<string, unknown>).headerMenuConfig)) {
(state as Record<string, unknown>).headerMenuConfig = defaultHeaderMenuConfig;
  }

  // v9->v10: Initialize backendApiSecret (legacy only stored in sessionStorage; set to null before migrate)
  if (state && typeof (state as Record<string, unknown>).backendApiSecret !== 'string') {
(state as Record<string, unknown>).backendApiSecret = null;
  }

  // v11->v12: Repository chat settings only store non-sensitive fields; legacy snapshots use safe defaults.
  if (state) {
    const stateRecord = state as Record<string, unknown>;
    stateRecord.repositoryChatSettings = normalizeRepositoryChatSettings(
      stateRecord.repositoryChatSettings ?? defaultRepositoryChatSettings,
    );
  }

  // Initialize embeddingConfigs
  if (state && !Array.isArray((state as Record<string, unknown>).embeddingConfigs)) {
(state as Record<string, unknown>).embeddingConfigs = [];
  }
  if (state && typeof (state as Record<string, unknown>).activeEmbeddingConfig !== 'string') {
(state as Record<string, unknown>).activeEmbeddingConfig = null;
  }

  // Initialize/migrate vectorSearchConfig
  if (state) {
const stateRecord = state as Record<string, unknown>;
stateRecord.vectorSearchConfig = normalizeVectorSearchConfig(
stateRecord.vectorSearchConfig,
stateRecord.embeddingConfigs
);
stateRecord.mcpConfig = normalizeMcpConfig(stateRecord.mcpConfig);
    }

  // v15→v16: per-GitHub-id workspace snapshots so logout does not wipe local data
  if (state) {
    const stateRecord = state as Record<string, unknown>;
    if (typeof stateRecord.accountWorkspaces !== 'object'
      || stateRecord.accountWorkspaces === null
      || Array.isArray(stateRecord.accountWorkspaces)) {
      stateRecord.accountWorkspaces = {};
    }
  }

  return state as PersistedAppState;
},
merge: (persistedState, currentState) => {
  const normalized = normalizePersistedState(
persistedState as PersistedAppState | undefined,
currentState as AppStoreState
  );

  logger.info('store.hydrate', 'Store rehydrated', {
isAuthenticated: normalized.isAuthenticated,
repositoriesCount: normalized.repositories?.length || 0,
gistsCount: normalized.gists?.length || 0,
lastSync: normalized.lastSync,
language: normalized.language,
webdavConfigsCount: normalized.webdavConfigs?.length || 0,
customCategoriesCount: normalized.customCategories?.length || 0,
  });

  // Keep the synchronous localStorage mirror aligned with the hydrated
  // auth state (covers restores that came from IndexedDB or the mirror).
  const merged = {
...currentState,
...normalized,
  };
  writeAuthMirror({
user: merged.user ?? null,
githubToken: typeof merged.githubToken === 'string' ? merged.githubToken : null,
backendApiSecret: typeof merged.backendApiSecret === 'string' ? merged.backendApiSecret : null,
  });

  return merged;
},
onRehydrateStorage: (state) => {
  const hydrationStart = Date.now();
  return (_rehydratedState, error) => {
const elapsedMs = Date.now() - hydrationStart;
if (error) {
  logger.errorFromError('store.hydrate', 'Store hydration failed', error, { elapsedMs });
} else {
  logger.info('store.hydrate', 'Store hydration complete', { elapsedMs });
}
state.setHasHydrated(true);
  };
},
};
