import type { StoreApi } from 'zustand';
import type { AppLanguage } from '../i18n/languages';
import type {
  AppState,
  Gist,
  GistCategoryId,
  GistSearchFilters,
  Repository,
  Release,
  ForkRepo,
  AIConfig,
  WebDAVConfig,
  EmbeddingConfig,
  VectorSearchConfig,
  VectorSearchStatus,
  McpServiceConfig,
  VectorIndexingState,
  ProxyConfig,
  RpcDownloadConfig,
  SearchFilters,
  GitHubUser,
  Category,
  AssetFilter,
  UpdateNotification,
  AnalysisProgress,
  DiscoveryChannelId,
  DiscoveryRepo,
  DiscoveryPlatform,
  ExternalFeedKind,
  ProgrammingLanguage,
  SortBy,
  SortOrder,
  TrendingTimeRange,
  WeeklySyncStatus,
  XTweetAuth,
  TopicCategory,
  CustomReleaseRepository,
  ReleaseSourceId,
  ReleaseSourceSettings,
  HeaderMenuItem,
  SyncMode,
  TranslationEngine,
  RepositoryCardFieldId,
  RepositoryCardActionPreference,
  RepositoryChatSettings,
  ThemeTokens,
  TrendingSnapshot,
} from '../types';
import type { ThemePresetId } from '../constants/themePresets';
import type { GitHubListsApiService } from '../services/githubListsApi';

export interface AppActions {
  // Auth actions
  setUser: (user: GitHubUser | null) => void;
  setGitHubToken: (token: string | null) => void;
  logout: () => void;

  // Repository actions
  setRepositories: (repos: Repository[], options?: { allowEmpty?: boolean }) => void;
  updateRepository: (repo: Repository) => void;
  /** Batch updates specified fields for multiple repositories without resetting currently filtered searchResults */
  updateRepositoriesMetadata: (updates: { id: number; patch: Partial<Repository> }[]) => void;
  addRepository: (repo: Repository) => void;
  setLoading: (loading: boolean) => void;
  setSyncingStars: (syncing: boolean) => void;
  setLastSync: (timestamp: string) => void;
  setSyncMode: (mode: SyncMode) => void;
  setSyncModeConfigured: (configured: boolean) => void;
  pushCategoriesToLists: (api: GitHubListsApiService, categoryIds?: string[]) => Promise<void>;
  resetListsPush: () => void;
  setListsPushError: (error: string | null) => void;
  setCategoryListIdMap: (categoryId: string, listId: string) => void;
  deleteRepository: (repoId: number) => void;
  setAnalyzingRepository: (repoId: number, isAnalyzing: boolean) => void;

  // Gist actions
  setGists: (gists: Gist[], options?: { allowEmpty?: boolean }) => void;
  setStarredGists: (gists: Gist[], options?: { allowEmpty?: boolean }) => void;
  updateGist: (gist: Gist) => void;
  deleteGist: (gistId: string) => void;
  setGistSearchFilters: (filters: Partial<GistSearchFilters>) => void;
  setGistSearchResults: (results: Gist[]) => void;
  setSelectedGistCategory: (category: GistCategoryId) => void;
  setAnalyzingGist: (gistId: string, isAnalyzing: boolean) => void;

  // AI actions
  addAIConfig: (config: AIConfig) => void;
  updateAIConfig: (id: string, updates: Partial<AIConfig>) => void;
  deleteAIConfig: (id: string) => void;
  setActiveAIConfig: (id: string | null) => void;
  setAIConfigs: (configs: AIConfig[]) => void;
  setRepositoryChatSettings: (settings: Partial<RepositoryChatSettings>) => void;

  // WebDAV actions
  addWebDAVConfig: (config: WebDAVConfig) => void;
  updateWebDAVConfig: (id: string, updates: Partial<WebDAVConfig>) => void;
  deleteWebDAVConfig: (id: string) => void;
  setActiveWebDAVConfig: (id: string | null) => void;
  setWebDAVConfigs: (configs: WebDAVConfig[]) => void;
  setLastBackup: (timestamp: string) => void;

  // Embedding actions
  addEmbeddingConfig: (config: EmbeddingConfig) => void;
  updateEmbeddingConfig: (id: string, updates: Partial<EmbeddingConfig>) => void;
  deleteEmbeddingConfig: (id: string) => void;
  setActiveEmbeddingConfig: (id: string | null) => void;
  setEmbeddingConfigs: (configs: EmbeddingConfig[]) => void;

  // Vector Search actions
  setVectorSearchConfig: (config: Partial<VectorSearchConfig>) => void;
  setVectorSearchStatus: (status: VectorSearchStatus | undefined) => void;
  setVectorIndexingState: (state: Partial<VectorIndexingState>) => void;

  // MCP service (local prefs; backend SQLite is source of truth when connected)
  setMcpConfig: (config: Partial<McpServiceConfig>) => void;

  // Similar repositories view actions
  enterSimilarView: (repos: Repository[], anchor: Repository) => void;
  resetSimilarView: () => void;
  exitSimilarView: () => void;

  // Search actions
  setSearchFilters: (filters: Partial<SearchFilters>) => void;
  setSearchResults: (results: Repository[]) => void;

  // Release actions
  setReleases: (releases: Release[], options?: { allowEmpty?: boolean }) => void;
  addReleases: (releases: Release[]) => void;
  /** Merges and updates assets/metadata for existing Releases by id; resets to unread on content changes (is_read=false and removed from readReleases) */
  upsertReleases: (releases: Release[]) => void;
  toggleReleaseSubscription: (repoId: number) => void;
  batchUnsubscribeReleases: (repoIds: number[]) => void;
  removeReleasesByRepoId: (repoId: number) => void;
  removeReleasesByRepoFullName: (fullName: string) => void;
  /** Marks a Release as read; marked entries also clear updated_asset_ids ("asset updated" badges disappear upon reading) */
  markReleaseAsRead: (releaseId: number) => void;
  /** Clears "asset updated" badge for a specific asset upon click (removes from updated_asset_ids) without affecting Release-level unread status */
  markAssetAsRead: (assetId: number) => void;
  markAllReleasesAsRead: () => void;
  setReleaseSourceSettings: (settings: ReleaseSourceSettings) => void;
  setReleaseEnabledSources: (sourceIds: ReleaseSourceId[]) => void;
  toggleReleaseSource: (sourceId: ReleaseSourceId) => void;
  setReleaseSourceRepositories: (sourceId: ReleaseSourceId, repos: CustomReleaseRepository[]) => void;
  addReleaseSourceRepository: (sourceId: ReleaseSourceId, repo: CustomReleaseRepository) => void;
  removeReleaseSourceRepository: (sourceId: ReleaseSourceId, fullName: string) => void;
  updateReleaseSourceRepository: (sourceId: ReleaseSourceId, fullName: string, updates: Partial<CustomReleaseRepository>) => void;

  // Fork actions
  setForks: (forks: ForkRepo[], options?: { allowEmpty?: boolean }) => void;
  addForks: (forks: ForkRepo[]) => void;
  updateFork: (fork: ForkRepo) => void;
  markForkAsRead: (forkId: number) => void;
  markAllForksAsRead: () => void;

  // Category actions
  addCustomCategory: (category: Category) => void;
  updateCustomCategory: (id: string, updates: Partial<Category>) => void;
  updateDefaultCategory: (id: string, updates: Partial<Category>) => void;
  resetDefaultCategory: (id: string) => void;
  resetDefaultCategoryNameIcon: (id: string) => void;
  resetDefaultCategoryKeywords: (id: string) => void;
  deleteCustomCategory: (id: string) => void;
  hideDefaultCategory: (id: string) => void;
  showDefaultCategory: (id: string) => void;
  setCategoryOrder: (order: string[]) => void;
  reorderCategories: (oldIndex: number, newIndex: number) => void;
  setCollapsedSidebarCategoryCount: (count: number) => void;
  setCategoryMatchMode: (mode: 'legacy' | 'effective') => void;

  // Asset Filter actions
  addAssetFilter: (filter: AssetFilter) => void;
  updateAssetFilter: (id: string, updates: Partial<AssetFilter>) => void;
  deleteAssetFilter: (id: string) => void;

  // UI actions
  setTheme: (theme: 'light' | 'dark') => void;
  setThemePreset: (preset: ThemePresetId) => void;
  setCurrentView: (view: 'repositories' | 'gists' | 'releases' | 'forks' | 'settings' | 'subscription') => void;
  setSelectedCategory: (category: string) => void;
  setLanguage: (language: AppLanguage) => void;
  setTranslationEngine: (engine: TranslationEngine) => void;
  setAutoTranslateRepoDescription: (enabled: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setReadmeModalOpen: (open: boolean) => void;
  setHeaderMenuConfig: (config: HeaderMenuItem[]) => void;

  // Hydration state
  setHasHydrated: (hydrated: boolean) => void;

  // Update actions
  setUpdateNotification: (notification: UpdateNotification | null) => void;
  dismissUpdateNotification: () => void;

  // Update Analysis Progress
  setAnalysisProgress: (newProgress: AnalysisProgress) => void;

  // Backend actions
  setBackendApiSecret: (secret: string | null) => void;

  // Proxy actions
  setProxyConfig: (updates: Partial<ProxyConfig>) => void;
  setRouteMode: (mode: import('../types').RouteMode) => void;

  // RPC Download actions
  setRpcDownloadConfig: (updates: Partial<RpcDownloadConfig>) => void;

  // Repository list view actions
  setRepositoryViewMode: (mode: 'grid' | 'list') => void;

  // Release Timeline View actions
  setReleaseViewMode: (mode: 'timeline' | 'repository') => void;
  setReleaseShowMode: (mode: 'all' | 'unread') => void;
  setReleaseLatestMode: (mode: 'all' | 'latest') => void;
  setReleaseSelectedFilters: (filters: string[]) => void;
  toggleReleaseSelectedFilter: (filterId: string) => void;
  clearReleaseSelectedFilters: () => void;
  setReleaseSearchQuery: (query: string) => void;
  toggleReleaseExpandedRepository: (repoId: number) => void;
  setReleaseExpandedRepositories: (repoIds: Set<number>) => void;
  setReleaseIsRefreshing: (refreshing: boolean) => void;
  setIncludePreRelease: (include: boolean) => void;

  // Backup/Export key inclusion preference
  setIncludeKeysInBackup: (include: boolean) => void;

  // Fork Timeline View actions
  setForkViewMode: (mode: 'timeline' | 'repository') => void;
  setForkSelectedFilters: (filters: string[]) => void;
  toggleForkSelectedFilter: (filterId: string) => void;
  clearForkSelectedFilters: () => void;
  setForkSearchQuery: (query: string) => void;
  toggleForkExpandedRepository: (repoId: number) => void;
  setForkExpandedRepositories: (repoIds: Set<number>) => void;
  setForkIsRefreshing: (refreshing: boolean) => void;

  // Discovery actions
  setSelectedDiscoveryChannel: (channel: DiscoveryChannelId) => void;
  setDiscoveryLoading: (channel: DiscoveryChannelId, loading: boolean) => void;
  setDiscoveryLoadingMore: (channel: DiscoveryChannelId, loading: boolean) => void;
  setDiscoveryLoadMoreError: (channel: DiscoveryChannelId, error: string | null) => void;
  setDiscoveryRepos: (channel: DiscoveryChannelId, repos: DiscoveryRepo[], append?: boolean) => void;
  setDiscoveryLastRefresh: (channel: DiscoveryChannelId, timestamp: string) => void;
  updateDiscoveryRepo: (repo: DiscoveryRepo) => void;
  toggleDiscoveryChannel: (channelId: DiscoveryChannelId) => void;
  addExternalDiscoveryChannel: (name: string, sourceUrl: string, kind?: ExternalFeedKind) => DiscoveryChannelId | null;
  removeExternalDiscoveryChannel: (channelId: DiscoveryChannelId) => void;
  setDiscoveryPlatform: (platform: DiscoveryPlatform) => void;
  setDiscoveryLanguage: (language: ProgrammingLanguage) => void;
  setDiscoverySortBy: (sortBy: SortBy) => void;
  setDiscoverySortOrder: (sortOrder: SortOrder) => void;
  setDiscoverySearchQuery: (query: string) => void;
  setDiscoverySelectedTopic: (topic: TopicCategory | null) => void;
  setDiscoveryHasMore: (channel: DiscoveryChannelId, hasMore: boolean) => void;
  setDiscoveryNextPage: (channel: DiscoveryChannelId, page: number) => void;
  setDiscoveryTotalCount: (channel: DiscoveryChannelId, count: number) => void;
  setDiscoveryScrollPosition: (channel: DiscoveryChannelId, position: number) => void;
  setTrendingTimeRange: (range: TrendingTimeRange) => void;
  setWeeklyOnlyCollected: (only: boolean) => void;
  setWeeklySyncStatus: (status: WeeklySyncStatus | null) => void;
  setXTweetSyncStatus: (status: WeeklySyncStatus | null) => void;
  /** Follows an X tweet channel (accepts @handle / handle / x.com links, ignores duplicates) */
  addXTweetFollow: (handle: string) => void;
  removeXTweetFollow: (handle: string) => void;
  /** Saves X tweet channel login authentication cookies (overwrites existing values) */
  setXTweetAuth: (auth: XTweetAuth) => void;
  clearXTweetAuth: () => void;
  setTelegramSyncStatus: (status: WeeklySyncStatus | null) => void;
  /** Follows a Telegram channel (accepts @channel / channel / t.me links, ignores duplicates) */
  addTelegramFollow: (channel: string) => void;
  removeTelegramFollow: (channel: string) => void;
  appendDiscoveryRepos: (channel: DiscoveryChannelId, repos: DiscoveryRepo[]) => void;

  // Theme tokens
  /** Partial update: merged internally with current values; callers do not need to spread manually (avoids stale render values). */
  updateThemeTokens: (patch: Partial<ThemeTokens>) => void;
  /** Trending snapshot: records a ranking snapshot; deduplication and limits are handled in utils. */
  recordTrendingSnapshot: (snapshot: TrendingSnapshot) => void;
  // Repository card visible fields
  /** Toggles visibility of a specific field; omitted fields retain current values. */
  setRepositoryCardField: (id: RepositoryCardFieldId, visible: boolean) => void;
  setRepositoryCardActions: (actions: RepositoryCardActionPreference[]) => void;
}

export type AppStoreState = AppState & AppActions;
export type AppStoreSet = StoreApi<AppStoreState>['setState'];
export type AppStoreGet = StoreApi<AppStoreState>['getState'];
export type AppStoreSlice<T> = (set: AppStoreSet, get: AppStoreGet) => T;
