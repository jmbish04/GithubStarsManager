
import type {
  Category,
  DiscoveryChannelId,
  DiscoveryRepo,
  SubscriptionChannel,
  TrendingTimeRange,
} from '../../types';
import { defaultHeaderMenuConfig, defaultSubscriptionChannels } from '../../types';
import { DEFAULT_THEME_PRESET_ID, isThemePresetId } from '../../constants/themePresets';
import { isAppLanguage } from '../../i18n/languages';
import { normalizeReleaseSourceSettings } from '../../utils/releaseSources';
import { normalizeAssetFilters } from '../../utils/assetFilters';
import { normalizeThemeTokens } from '../../utils/themeTokens';
import { normalizeTrendingSnapshots } from '../../utils/trendingSnapshots';
import { normalizeRepositoryCardFields } from '../../utils/repositoryCardFields';
import { normalizeRepositoryCardActions } from '../../utils/repositoryCardActions';
import { normalizeXTweetAuth, normalizeXTweetFollows } from '../../utils/xTweetFollows';
import { normalizeTelegramFollows } from '../../utils/telegramFollows';
import { normalizeExternalDiscoveryChannels } from '../../utils/discoveryFeeds';
import { isChannelScrapable, isScrapeSupportSettled } from '../../services/scrapeSupport';
import type { AppStoreState } from '../types';
import { normalizeAccountWorkspaces } from '../helpers/accountWorkspace';
import { readAuthMirror } from '../persistence/authStorage';
import {
  defaultDiscoveryChannels,
  defaultPresetFilters,
  initialGistSearchFilters,
  initialSearchFilters,
  normalizeMcpConfig,
  normalizeNumberSet,
  normalizeRepositoryChatSettings,
  normalizeVectorSearchConfig,
  normalizeVectorSearchStatus,
  PersistedAppState,
  REQUIRED_HEADER_MENU_IDS,
} from '../schema';

export const normalizePersistedState = (
  persisted: PersistedAppState | undefined,
  currentState: AppStoreState
): Partial<AppStoreState> => {
  const safePersisted = persisted ?? {};
  const persistedDiscoveryChannels = (safePersisted as Record<string, unknown>).discoveryChannels;
  const normalizedDiscoveryChannels = [...defaultDiscoveryChannels.map((defaultChannel) => {
    const persistedChannel = Array.isArray(persistedDiscoveryChannels)
      ? persistedDiscoveryChannels.find((channel: unknown) =>
          (channel as Record<string, unknown>)?.id === defaultChannel.id
        ) as Record<string, unknown> | undefined
      : undefined;
    return {
      ...defaultChannel,
      enabled: persistedChannel?.enabled !== false,
    };
  }), ...normalizeExternalDiscoveryChannels(persistedDiscoveryChannels)];
  // While scrape support resolution is unsettled (web startup probe in progress), do not make visibility decisions;
  // fully preserve persisted enabled flags to avoid mistakenly enabling "Trending" and having it persisted (desktop is constantly settled).
  const scrapeSupportSettled = isScrapeSupportSettled();
  if (scrapeSupportSettled && !normalizedDiscoveryChannels.some(channel => channel.enabled && isChannelScrapable(channel.id))) {
    normalizedDiscoveryChannels[0] = { ...normalizedDiscoveryChannels[0], enabled: true };
  }
  const authMirror = readAuthMirror();

  // Effective auth: persisted values win; the synchronous localStorage mirror
  // back-fills when the IndexedDB snapshot lost them (asynchronous unload write).
  const resolvedUser = safePersisted.user ?? authMirror?.user ?? null;
  const resolvedGithubToken =
    typeof safePersisted.githubToken === 'string'
      ? safePersisted.githubToken
      : (authMirror?.githubToken ?? null);
  const resolvedBackendApiSecret =
    typeof safePersisted.backendApiSecret === 'string'
      ? (safePersisted.backendApiSecret || null)
      : (authMirror?.backendApiSecret ?? currentState.backendApiSecret ?? null);

  const repositories = Array.isArray(safePersisted.repositories) ? safePersisted.repositories : [];
  const gists = Array.isArray(safePersisted.gists) ? safePersisted.gists : [];
  const starredGists = Array.isArray(safePersisted.starredGists) ? safePersisted.starredGists : [];
  const releases = Array.isArray(safePersisted.releases) ? safePersisted.releases : [];

  // Migration for old users: mark repos with existing releases as already synced.
  // Reference preservation: return original array directly when no backfill is needed—sharded persistence
  // detects dirty state by reference; if hydration always creates new array references,
  // it triggers a full rewrite on every launch.
  // Index by String(id): in legacy snapshots, id might have been persisted as a string;
  // maintaining equivalence with the legacy loose match `===` on historical data; single-pass Map construction, backfill overall O(R+L).
  const latestReleaseTimeByRepoId = new Map<string, number>();
  for (const release of releases) {
    const repoId = release.repository?.id;
    if (repoId === undefined || repoId === null) continue;
    const key = String(repoId);
    const publishedTime = new Date(release.published_at).getTime();
    const previous = latestReleaseTimeByRepoId.get(key);
    latestReleaseTimeByRepoId.set(key, previous === undefined ? publishedTime : Math.max(previous, publishedTime));
  }
  const needsReleaseBackfill = repositories.some(
    repo => latestReleaseTimeByRepoId.has(String(repo.id)) && !repo.has_fetched_releases,
  );
  const migratedRepositories = needsReleaseBackfill
    ? repositories.map(repo => {
      if (repo.has_fetched_releases) {
        return repo;
      }
      // Backfill last_release_fetch_time from the latest persisted release timestamp
      const latestReleaseTime = latestReleaseTimeByRepoId.get(String(repo.id));
      if (latestReleaseTime === undefined) {
        return repo;
      }
      return {
        ...repo,
        has_fetched_releases: true,
        last_release_fetch_time: repo.last_release_fetch_time || (latestReleaseTime ? new Date(latestReleaseTime).toISOString() : new Date().toISOString())
      };
    })
    : repositories;

  // Default includePreRelease to true if not set (backward compatibility)
  const includePreRelease = safePersisted.includePreRelease !== undefined
    ? safePersisted.includePreRelease
    : true;

  const normalizedAssetFilters = normalizeAssetFilters(safePersisted.assetFilters);

  return {
    ...currentState,
    ...safePersisted,
    // Auth fallback: if the IndexedDB snapshot is missing the login credentials
    // (e.g. async unload write never completed), restore from the synchronous
    // localStorage mirror. Persisted values always win over the mirror.
    user: resolvedUser,
    githubToken: resolvedGithubToken,
    backendApiSecret: resolvedBackendApiSecret,
    accountWorkspaces: normalizeAccountWorkspaces(
      (safePersisted as Record<string, unknown>).accountWorkspaces,
    ),
    theme:
      safePersisted.theme === 'light' || safePersisted.theme === 'dark'
        ? safePersisted.theme
        : 'dark',
    themePreset: isThemePresetId(safePersisted.themePreset)
      ? safePersisted.themePreset
      : DEFAULT_THEME_PRESET_ID,
    themeTokens: normalizeThemeTokens((safePersisted as Record<string, unknown>).themeTokens),
    repositories: migratedRepositories,
    gists,
    starredGists,
    gistSearchResults: Array.isArray(safePersisted.gistSearchResults) ? safePersisted.gistSearchResults : gists,
    selectedGistCategory: safePersisted.selectedGistCategory === 'starred' || safePersisted.selectedGistCategory === 'mine'
      ? safePersisted.selectedGistCategory
      : 'all',
    // Do not restore analyzing states: asynchronous tasks cannot survive a page reload, and restoring them would cause cards to remain permanently stuck in "analyzing" state.
    analyzingRepositoryIds: new Set<number>(),
    analyzingGistIds: new Set<string>(),
    releases,
    searchResults: migratedRepositories,
    releaseSubscriptions: normalizeNumberSet(safePersisted.releaseSubscriptions),
    repositoryViewMode: safePersisted.repositoryViewMode === 'list' ? 'list' : 'grid',
    releaseSourceSettings: normalizeReleaseSourceSettings(safePersisted.releaseSourceSettings),
    readReleases: normalizeNumberSet(safePersisted.readReleases),
    readForks: normalizeNumberSet(safePersisted.readForks),
    forks: Array.isArray(safePersisted.forks) ? safePersisted.forks : [],
    forkViewMode: safePersisted.forkViewMode || 'timeline',
    forkSelectedFilters: Array.isArray(safePersisted.forkSelectedFilters) ? safePersisted.forkSelectedFilters : [],
    forkSearchQuery: typeof safePersisted.forkSearchQuery === 'string' ? safePersisted.forkSearchQuery : '',
    forkExpandedRepositories: normalizeNumberSet(safePersisted.forkExpandedRepositories),
    releaseExpandedRepositories: normalizeNumberSet(safePersisted.releaseExpandedRepositories),
    includePreRelease,
    syncMode: safePersisted.syncMode === 'stars-and-lists' ? 'stars-and-lists' : 'stars',
    syncModeConfigured: safePersisted.syncModeConfigured === true,
    // Category id -> GitHub List id mapping: retain only string key-value pairs to prevent corrupted data from polluting state
    categoryListIdMap: safePersisted.categoryListIdMap
      && typeof safePersisted.categoryListIdMap === 'object'
      ? Object.fromEntries(
          Object.entries(safePersisted.categoryListIdMap).filter(
            ([key, value]) => typeof key === 'string' && typeof value === 'string'
          )
        )
      : {},
    searchFilters: {
      ...initialSearchFilters,
      ...safePersisted.searchFilters,
      sortBy: safePersisted.searchFilters?.sortBy || 'stars',
      sortOrder: safePersisted.searchFilters?.sortOrder || 'desc',
    },
    gistSearchFilters: {
      ...initialGistSearchFilters,
      ...safePersisted.gistSearchFilters,
      sortBy: safePersisted.gistSearchFilters?.sortBy || 'updated',
      sortOrder: safePersisted.gistSearchFilters?.sortOrder || 'desc',
    },
    webdavConfigs: Array.isArray(safePersisted.webdavConfigs) ? safePersisted.webdavConfigs : [],
    embeddingConfigs: Array.isArray(safePersisted.embeddingConfigs) ? safePersisted.embeddingConfigs : [],
    activeEmbeddingConfig: typeof safePersisted.activeEmbeddingConfig === 'string' ? safePersisted.activeEmbeddingConfig : null,
    vectorSearchConfig: normalizeVectorSearchConfig(
      safePersisted.vectorSearchConfig,
      safePersisted.embeddingConfigs
    ),
    vectorSearchStatus: normalizeVectorSearchStatus(
      safePersisted.vectorSearchStatus ?? currentState.vectorSearchStatus
    ),
// Persist full mcpConfig including token so Agent configs stay stable across restarts
    // unless the user explicitly resets the token.
    mcpConfig: normalizeMcpConfig((safePersisted as Record<string, unknown>).mcpConfig),
    repositoryChatSettings: normalizeRepositoryChatSettings((safePersisted as Record<string, unknown>).repositoryChatSettings),
    customCategories: Array.isArray(safePersisted.customCategories) ? safePersisted.customCategories : [],
    hiddenDefaultCategoryIds: (() => {
      const persistedIds = (safePersisted as Record<string, unknown>).hiddenDefaultCategoryIds;
      return Array.isArray(persistedIds)
        ? persistedIds.filter((id): id is string => typeof id === 'string')
        : [];
    })(),
    defaultCategoryOverrides: (() => {
      const persisted = (safePersisted as Record<string, unknown>).defaultCategoryOverrides;
      return persisted && typeof persisted === 'object' && !Array.isArray(persisted)
        ? persisted as Record<string, Partial<Category>>
        : {};
    })(),
    categoryOrder: Array.isArray(safePersisted.categoryOrder) ? safePersisted.categoryOrder.filter((id: unknown): id is string => typeof id === 'string') : [],
    collapsedSidebarCategoryCount: typeof safePersisted.collapsedSidebarCategoryCount === 'number' && safePersisted.collapsedSidebarCategoryCount > 0 ? safePersisted.collapsedSidebarCategoryCount : 20,
    categoryMatchMode: safePersisted.categoryMatchMode === 'legacy' ? 'legacy' : 'effective',
    assetFilters: normalizedAssetFilters.length > 0 ? normalizedAssetFilters : defaultPresetFilters,
    // Trending snapshots (Development Guidelines §7): validate and prune individually; bad snapshots do not enter memory
    trendingSnapshots: normalizeTrendingSnapshots((safePersisted as Record<string, unknown>).trendingSnapshots),
    // Card visible fields (Development Guidelines §14): validate item by item; invalid values fall back to default (visible)
    repositoryCardFields: normalizeRepositoryCardFields((safePersisted as Record<string, unknown>).repositoryCardFields),
    repositoryCardActions: normalizeRepositoryCardActions((safePersisted as Record<string, unknown>).repositoryCardActions),
    language: isAppLanguage(safePersisted.language) ? safePersisted.language : currentState.language,
    translationEngine: safePersisted.translationEngine === 'google' || safePersisted.translationEngine === 'ai'
      ? safePersisted.translationEngine
      : 'microsoft',
    autoTranslateRepoDescription: typeof safePersisted.autoTranslateRepoDescription === 'boolean'
      ? safePersisted.autoTranslateRepoDescription
      : false,
    isAuthenticated: !!(resolvedUser && resolvedGithubToken),
    releaseViewMode: safePersisted.releaseViewMode || 'timeline',
    releaseShowMode: safePersisted.releaseShowMode === 'unread' ? 'unread' : 'all',
    releaseLatestMode: safePersisted.releaseLatestMode === 'latest' ? 'latest' : 'all',
    releaseSelectedFilters: Array.isArray(safePersisted.releaseSelectedFilters) ? safePersisted.releaseSelectedFilters : [],
    releaseSearchQuery: typeof safePersisted.releaseSearchQuery === 'string' ? safePersisted.releaseSearchQuery : '',
    discoveryChannels: normalizedDiscoveryChannels,
    // discoveryRepos is session-only runtime data. Never revive a stale legacy
    // cache during hydration, even if a historical snapshot contains the field.
    discoveryRepos: { 'trending': [], 'hot-release': [], 'most-popular': [], 'topic': [], 'x-tweet': [], 'telegram': [], 'weekly': [], 'search': [], 'code-search': [] } as Record<DiscoveryChannelId, DiscoveryRepo[]>,
    discoveryLastRefresh: { 'trending': null, 'hot-release': null, 'most-popular': null, 'topic': null, 'x-tweet': null, 'telegram': null, 'weekly': null, 'search': null, 'code-search': null },
    discoveryTotalCount: { 'trending': 0, 'hot-release': 0, 'most-popular': 0, 'topic': 0, 'x-tweet': 0, 'telegram': 0, 'weekly': 0, 'search': 0, 'code-search': 0 },
    // Selected channel retains persisted value (as long as it exists and is enabled; while unsettled, visibility evaluation is deferred,
    // and corrected by DiscoveryView after scrape support resolution settles, avoiding loss of selection for web + backend users before startup probe completes)
    selectedDiscoveryChannel: normalizedDiscoveryChannels.some(channel => channel.id === safePersisted.selectedDiscoveryChannel && channel.enabled && (!scrapeSupportSettled || isChannelScrapable(channel.id)))
      ? safePersisted.selectedDiscoveryChannel as DiscoveryChannelId
      : normalizedDiscoveryChannels.find(channel => channel.enabled && (!scrapeSupportSettled || isChannelScrapable(channel.id)))?.id ?? defaultDiscoveryChannels[0].id,
    // discoveryIsLoading is not persisted and is always reset to false (prevents malformed legacy data)
    discoveryIsLoading: { 'trending': false, 'hot-release': false, 'most-popular': false, 'topic': false, 'x-tweet': false, 'telegram': false, 'weekly': false, 'search': false, 'code-search': false },
    discoveryIsLoadingMore: { 'trending': false, 'hot-release': false, 'most-popular': false, 'topic': false, 'x-tweet': false, 'telegram': false, 'weekly': false, 'search': false, 'code-search': false },
    discoveryLoadMoreError: { 'trending': null, 'hot-release': null, 'most-popular': null, 'topic': null, 'x-tweet': null, 'telegram': null, 'weekly': null, 'search': null, 'code-search': null },
    discoveryHasMore: { 'trending': false, 'hot-release': false, 'most-popular': false, 'topic': false, 'x-tweet': false, 'telegram': false, 'weekly': false, 'search': false, 'code-search': false },
    discoveryNextPage: { 'trending': 1, 'hot-release': 1, 'most-popular': 1, 'topic': 1, 'x-tweet': 1, 'telegram': 1, 'weekly': 1, 'search': 1, 'code-search': 1 },
    // discoveryScrollPositions is not persisted and is always reset to 0
    discoveryScrollPositions: { 'trending': 0, 'hot-release': 0, 'most-popular': 0, 'topic': 0, 'x-tweet': 0, 'telegram': 0, 'weekly': 0, 'search': 0, 'code-search': 0 },
  trendingTimeRange: 'weekly' as TrendingTimeRange,
    xTweetFollows: normalizeXTweetFollows(safePersisted.xTweetFollows),
    // xTweetAuth is only stored securely via desktop safeStorage (memory-only in web mode); debouncedPersistStorage does not write it to snapshot (CWE-922).
    // During hydration, preserve current runtime currentState.xTweetAuth to avoid overwriting desktop restored authentication state.
    xTweetAuth: normalizeXTweetAuth(currentState.xTweetAuth),
    xTweetAuthRevision: typeof (safePersisted as Record<string, unknown>).xTweetAuthRevision === 'number'
      && Number.isFinite((safePersisted as Record<string, unknown>).xTweetAuthRevision)
      ? (safePersisted as Record<string, unknown>).xTweetAuthRevision as number
      : 0,
    telegramFollows: normalizeTelegramFollows(safePersisted.telegramFollows),
    // Ensure subscription-related state contains trending key
    subscriptionRepos: {
      'most-stars': [],
      'most-forks': [],
      'most-dev': [],
      'trending': [],
      ...(safePersisted.subscriptionRepos as Record<string, unknown> || {}),
    },
    subscriptionLastRefresh: {
      'most-stars': null,
      'most-forks': null,
      'most-dev': null,
      'trending': null,
      ...((safePersisted as Record<string, unknown>).subscriptionLastRefresh as Record<string, unknown> || {}),
    },
    subscriptionIsLoading: {
      'most-stars': false,
      'most-forks': false,
      'most-dev': false,
      'trending': false,
      ...((safePersisted as Record<string, unknown>).subscriptionIsLoading as Record<string, unknown> || {}),
    },
    // Ensure subscriptionChannels contains trending, and all channels have nameEn (legacy data compatibility)
    subscriptionChannels: (() => {
      const persisted = (safePersisted as Record<string, unknown>).subscriptionChannels;
      const defaultChannelsMap = new Map(defaultSubscriptionChannels.map(ch => [ch.id, ch]));
      if (!Array.isArray(persisted)) return defaultSubscriptionChannels;
      // Merge: use persisted channels, but backfill missing fields (nameEn, trending, etc.)
      return persisted.map((ch: unknown) => {
        const chRecord = ch as Record<string, unknown>;
        const defaultCh = defaultChannelsMap.get(chRecord.id as string);
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
      }).concat(
        defaultSubscriptionChannels.filter(dch => !persisted.some((ch: unknown) => (ch as Record<string, unknown>).id === dch.id))
      );
    })(),
    proxyConfig: (() => {
      const p = (safePersisted as Record<string, unknown>).proxyConfig;
      if (p && typeof p === 'object') {
        const obj = p as Record<string, unknown>;
        const validType = obj.type === 'http' || obj.type === 'socks5' ? obj.type : 'http';
        const validHost = typeof obj.host === 'string' ? obj.host : '';
        const validPort = typeof obj.port === 'number' && Number.isFinite(obj.port) ? obj.port : 7890;
        return {
          enabled: typeof obj.enabled === 'boolean' ? obj.enabled : false,
          type: validType as import('../../types').ProxyType,
          host: validHost,
          port: validPort,
          username: typeof obj.username === 'string' ? obj.username : undefined,
          password: typeof obj.password === 'string' ? obj.password : undefined,
        };
      }
      return { enabled: false, type: 'http' as const, host: '', port: 7890 };
    })(),
    rpcDownloadConfig: (() => {
      const r = (safePersisted as Record<string, unknown>).rpcDownloadConfig;
      if (r && typeof r === 'object') {
        const obj = r as Record<string, unknown>;
        return {
          enabled: typeof obj.enabled === 'boolean' ? obj.enabled : false,
          host: typeof obj.host === 'string' ? obj.host : '',
          port: typeof obj.port === 'number' && Number.isFinite(obj.port) ? obj.port : 6800,
          secret: typeof obj.secret === 'string' ? obj.secret : undefined,
        };
      }
      return { enabled: false, host: '', port: 6800 };
    })(),
    routeMode: (() => {
      const m = (safePersisted as Record<string, unknown>).routeMode;
      return m === 'backend' || m === 'browser' ? m : 'auto';
    })(),
    headerMenuConfig: (() => {
      const persisted = (safePersisted as Record<string, unknown>).headerMenuConfig;
      if (!Array.isArray(persisted)) return defaultHeaderMenuConfig;
      // Merge: ensure all default menus exist while preserving user-customized visible/order
      // Defensive filtering: skip non-object or null corrupted data
      const persistedMap = new Map(
        persisted
          .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
          .map((item) => [item.id, item])
      );
      return defaultHeaderMenuConfig.map((defaultItem) => {
        const persistedItem = persistedMap.get(defaultItem.id);
        if (!persistedItem) return defaultItem;
        const isRequired = REQUIRED_HEADER_MENU_IDS.has(defaultItem.id);
        return {
          ...defaultItem,
          visible: isRequired ? true : (typeof persistedItem.visible === 'boolean' ? persistedItem.visible : defaultItem.visible),
          order: typeof persistedItem.order === 'number' ? persistedItem.order : defaultItem.order,
        };
      });
    })(),
  };
};
