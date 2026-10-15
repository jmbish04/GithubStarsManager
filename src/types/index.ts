import type { ThemePresetId } from '../constants/themePresets';
import type { AppLanguage } from '../i18n/languages';

import type { RepositoryCardFields } from './repositoryCardFields';
export type { RepositoryCardFieldId, RepositoryCardFields } from './repositoryCardFields';
import type { RepositoryCardActionPreference } from './repositoryCardActions';
export type { RepositoryCardActionId, RepositoryCardActionPreference } from './repositoryCardActions';
import type { RepositoryChatSettings } from './repositoryChat';
export type { RepositoryChatSettings } from './repositoryChat';
import type { ThemeTokens } from './themeTokens';
export type { ThemeTokens } from './themeTokens';
import type { TrendingSnapshot } from './trendingSnapshot';
export type { TrendingSnapshot } from './trendingSnapshot';
export type {
  RepositoryHealthEnrichment,
  RepositoryHealthFact,
  RepositoryHealthFactId,
  RepositoryHealthFactKind,
  RepositoryHealthFactSource,
  RepositoryHealthGroup,
  RepositoryHealthGroupView,
  RepositoryHealthSignal,
  RepositoryHealthSignalId,
  RepositoryHealthSnapshot,
} from './health';

export interface Repository {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  forks_count: number;
  forks: number;
  language: string | null;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  starred_at?: string;
  owner: {
    login: string;
    avatar_url: string;
  };
  topics: string[];
  /**
   * GitHub native status fields. The raw `/user/starred` response naturally includes these fields,
   * which are incorporated into the type definition here for reuse by Repository Health and filtering.
   *
   * The backend does not persist these fields, so `src/utils/repositoryMerge.ts` includes them in both
   * `CLIENT_ONLY_REPOSITORY_FIELDS` (excluded from backend sync fingerprints to prevent hash churn in Issue #304)
   * and `LOCAL_REPOSITORY_FIELDS` (retaining local values on fetch so they are not cleared by backend responses).
   */
  archived?: boolean;
  disabled?: boolean;
  fork?: boolean;
  is_template?: boolean;
  open_issues_count?: number;
  default_branch?: string;
  ai_summary?: string;
  ai_tags?: string[];
  ai_platforms?: string[];
  analyzed_at?: string;
  analysis_failed?: boolean;
  analysis_error?: string;
  subscribed_to_releases?: boolean;
  custom_description?: string;
  custom_tags?: string[];
  custom_category?: string;
  category_locked?: boolean;
  last_edited?: string;
  vector_indexed_at?: string;  // ISO timestamp of last successful vector indexing
  /** License (SPDX ID or null) used during the last vector indexing. Incremental predicates use this to detect license changes and trigger reindexing. */
  vector_indexed_license?: string | null;
  last_release_fetch_time?: string;  // ISO timestamp, for incremental sync
  has_fetched_releases?: boolean;   // whether this repo has been synced for releases
  /** SPDX ID (e.g. 'MIT', 'Apache-2.0'); null if no license or unrecognized. AI, search, and filtering all rely on this. */
  license?: string | null;
}

export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  download_count: number;
  browser_download_url: string;
  content_type: string;
  created_at: string;
  updated_at: string;
}

export interface Release {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  published_at: string;
  html_url: string;
  assets: ReleaseAsset[];
  zipball_url?: string;
  tarball_url?: string;
  prerelease?: boolean;
  repository: {
    id: number;
    full_name: string;
    name: string;
  };
  /** IDs of assets added or changed during the latest refresh. */
  updated_asset_ids?: number[];
  is_read?: boolean;
}

export type ReleaseSourceId = 'starred-release-subscription' | 'watch-custom-release' | 'custom-release';

export interface CustomReleaseRepository {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  owner: {
    login: string;
    avatar_url: string;
  };
  has_fetched_releases?: boolean;
  last_release_fetch_time?: string;
  source_added_at?: string;
  release_hidden?: boolean;
}

export interface ReleaseSourceSettings {
  enabledSourceIds: ReleaseSourceId[];
  watchCustomReleaseRepos: CustomReleaseRepository[];
  customReleaseRepos: CustomReleaseRepository[];
}

export const defaultReleaseSourceSettings: ReleaseSourceSettings = {
  enabledSourceIds: ['starred-release-subscription'],
  watchCustomReleaseRepos: [],
  customReleaseRepos: [],
};

// Fork types
export interface GitHubOrganization {
  id: number;
  login: string;
  avatar_url: string;
  description: string | null;
  html_url: string;
}

export interface ForkRepo {
  id: number;
  name: string;
  fork: boolean;
  full_name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  forks_count: number;
  forks: number;
  language: string | null;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  default_branch: string;
  owner: {
    login: string;
    avatar_url: string;
  };
  source: {
    id: number;
    full_name: string;
    name: string;
    description: string | null;
    html_url: string;
    stargazers_count: number;
    forks_count: number;
    updated_at: string;
    owner: {
      login: string;
      avatar_url: string;
    };
  };
  parent?: {
    id: number;
    full_name: string;
    name: string;
    html_url: string;
  };
  has_unread?: boolean;
  upstream_updated_at?: string; // last time we checked/fetched upstream updates
}

export interface WorkflowDefinition {
  id: number;
  name: string;
  path: string; // workflow file path, e.g. ".github/workflows/ci.yml"
  state: string; // "active" | "disabled" | "warning"
  created_at: string;
  updated_at: string;
  url: string;
  html_url: string;
  badge_url: string;
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string;
  avatar_url: string;
  email: string | null;
}

export interface GistFile {
  filename: string;
  type: string | null;
  language: string | null;
  raw_url?: string;
  size: number;
  truncated?: boolean;
  content?: string;
}

export interface Gist {
  id: string;
  description: string | null;
  public: boolean;
  html_url: string;
  created_at: string;
  updated_at: string;
  comments: number;
  owner: {
    login: string;
    avatar_url: string;
    html_url?: string;
  } | null;
  files: Record<string, GistFile>;
  starred?: boolean;
  ai_summary?: string;
  analyzed_at?: string;
  analysis_failed?: boolean;
  analysis_error?: string;
  last_edited?: string;
}

export type GistCategoryId = 'all' | 'starred' | 'mine';

export interface GistSearchFilters {
  query: string;
  sortBy: 'updated' | 'created' | 'name' | 'files';
  sortOrder: 'desc' | 'asc';
  isAnalyzed?: boolean;
}

export type AIApiType = 'openai' | 'openai-responses' | 'claude' | 'gemini' | 'deepseek' | 'mimo' | 'openai-compatible';

// Embedding provider type
export type EmbeddingApiType = 'openai' | 'openai-compatible' | 'gemini' | 'cohere' | 'ollama' | 'siliconflow';

// Embedding configuration (structured parallel to AIConfig/WebDAVConfig)
export interface EmbeddingConfig {
  id: string;
  name: string;
  apiType: EmbeddingApiType;
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
  isActive: boolean;
  apiKeyStatus?: SecretStatus;
}

// Index content mode
export type VectorIndexMode = 'description' | 'readme';

// Vector search overall configuration (persisted + synced, excluding runtime state)
export interface VectorSearchConfig {
  enabled: boolean;
  workerUrl: string;
  authToken: string;
  embeddingConfigId: string;
  indexMode: VectorIndexMode;
  readmeMaxChars: number;  // Max character length truncated from README, default 6000
  // Search parameters (optional, with defaults)
  searchThreshold?: number;   // Similarity threshold, default 0.35
  searchTopK?: number;        // Number of results returned, default 30
  enableHyDE?: boolean;       // Whether to enable HyDE query preprocessing, default true
  enableReranking?: boolean;  // Whether to enable LLM semantic reranking, default true
  // Embedding text format version, incremented when buildEmbeddingText format changes
  embeddingFormatVersion?: number;
}

export interface VectorSearchStatus {
  connected: boolean;
  vectorCount: number;
  dimensions: number;
  lastSyncAt?: string;
  error?: string;
}

export interface VectorIndexingState {
  isIndexing: boolean;
  phase: 'readme' | 'embedding' | 'uploading' | null;
  phaseDone: number;
  phaseTotal: number;
  result: { indexed: number; skipped: number; errors: number; error?: string } | null;
}

/** Local (Electron) / client-side MCP service preferences. Server is source of truth when backend is on. */
export interface McpServiceConfig {
  enabled: boolean;
  /** Local bind host for Electron standalone MCP (default 127.0.0.1) */
  host: string;
  /** Local bind port for Electron standalone MCP (default 3927) */
  port: number;
  /** Plaintext MCP bearer token — viewable anytime; regenerate via reset */
  token: string;
}

// Similar repositories view state: saves context when entering "Find Similar Repositories", restored on reset
export interface SimilarViewState {
  active: boolean;
  anchorRepoFullName: string;   // Current anchor repository full_name (banner display)
  anchorRepoName: string;        // Anchor repository name
  similarResults: Repository[];  // Similar results, for rendering
  originalSearchResults: Repository[]; // Snapshot of searchResults before entry, for restoration on reset
  originalSearchFilters: SearchFilters; // Snapshot of searchFilters before entry, for restoration on reset
}
export type AIReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';
export type MiMoPlan = 'api' | 'token-plan';

/** README document translation engine: Microsoft Edge Translate (free), Google Translate (free), or user-configured AI. */
export type TranslationEngine = 'microsoft' | 'google' | 'ai';

export type SecretStatus = 'ok' | 'empty' | 'decrypt_failed';

export interface AIConfig {
  id: string;
  name: string;
  apiType?: AIApiType; // API format / compatibility protocol (default openai)
  baseUrl: string;
  apiKey: string;
  model: string;
  isActive: boolean;
  customPrompt?: string; // Custom prompt
  useCustomPrompt?: boolean; // Whether to use custom prompt
  concurrency?: number; // AI analysis concurrency, default 1
  requestsPerMinute?: number; // Max AI requests per minute (used by shared rate limiter for batch analysis), 0/default = unlimited
  reasoningEffort?: AIReasoningEffort; // Optional reasoning effort for OpenAI GPT-5/Responses
  mimoPlan?: MiMoPlan; // MiMo channel: api (pay-as-you-go) or token-plan (subscription)
  supportsToolCalls?: boolean; // Endpoint/model supports OpenAI-style function calling (used for repository Q&A tool loop, default false)
  apiKeyStatus?: SecretStatus;
}

export interface WebDAVConfig {
  id: string;
  name: string;
  url: string;
  username: string;
  password: string;
  path: string;
  isActive: boolean;
  passwordStatus?: SecretStatus;
}

export type ProxyType = 'http' | 'socks5';

/** GitHub / Release data plane request egress preference; local device only, excluded from backend/autoSync sync. */
export type RouteMode = 'auto' | 'backend' | 'browser';

export interface ProxyConfig {
  enabled: boolean;
  type: ProxyType;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface RpcDownloadConfig {
  enabled: boolean;
  host: string;
  port: number;
  secret?: string;
}

export interface SearchFilters {
  query: string;
  tags: string[];
  languages: string[];
  platforms: string[]; // Platform filter
  sortBy: 'stars' | 'updated' | 'name' | 'starred' | 'created';
  sortOrder: 'desc' | 'asc';
  minStars?: number;
  maxStars?: number;
  isAnalyzed?: boolean; // Whether AI analysis is complete
  isSubscribed?: boolean; // Whether subscribed to releases
  isEdited?: boolean; // Whether customized / edited
  isCategoryLocked?: boolean; // Whether category is locked
  analysisFailed?: boolean; // Whether AI analysis failed
  /** SPDX ID filter; the filter panel may use `NO_LICENSE_SENTINEL` to represent "none / undeclared license". */
  licenses: string[]; // Open source license filter
  /**
   * Filters applied based on objective Repository Health facts (see `src/utils/repositoryHealth.ts`).
   * Uses only existing local `Repository` fields without triggering extra network requests;
   * Release-dependent facts (whether releases exist, latest version) are shared by the Health panel and MCP/AI,
   * but excluded from list filters — list filters do not have access to the Release array, and forcing them in causes full re-renders.
   */
  healthArchived?: boolean;
  healthRecentActivity?: boolean;
  healthHasLicense?: boolean;
}

export type CategoryMatchMode = 'legacy' | 'effective';

export interface Category {
  id: string;
  name: string;
  icon: string;
  keywords: string[];
  isCustom?: boolean;
  isHidden?: boolean;
}

export interface AssetFilter {
  id: string;
  name: string;
  keywords: string[];
  /**
   * Blacklisted keywords: when an asset filename matches any of these keywords, it does not match even if it matches keywords.
   * Used to filter out installer noise within the same platform filter (e.g. "setup", "installer").
   */
  excludeKeywords?: string[];
  /**
   * Always-included repositories (Repository.full_name): when this filter is active, releases from these repositories
   * appear in filter results even without matching keywords (useful for repositories whose releases lack filter keywords,
   * such as projects releasing only zip or source archives); unselected filters do not affect the list or subscriptions.
   */
  includeRepos?: string[];
  /**
   * Always-excluded repositories (Repository.full_name): scoped only to this filter. When this filter is active,
   * releases from these repositories do not pass this filter (takes precedence over filter keywords and includeRepos),
   * but does not veto matches from other active filters. Does not reuse the legacy `excludeRepos` key from #405
   * to avoid historical data being reinterpreted with this semantic.
   */
  alwaysExcludeRepos?: string[];
  isPreset?: boolean;
  icon?: string;
}

export type HeaderMenuId = 'repositories' | 'gists' | 'releases' | 'forks' | 'subscription' | 'settings';

export interface HeaderMenuItem {
  id: HeaderMenuId;
  visible: boolean;
  order: number;
}

export const defaultHeaderMenuConfig: HeaderMenuItem[] = [
  { id: 'repositories', visible: true, order: 0 },
  { id: 'gists', visible: true, order: 1 },
  { id: 'releases', visible: true, order: 2 },
  { id: 'forks', visible: true, order: 3 },
  { id: 'subscription', visible: true, order: 4 },
  { id: 'settings', visible: true, order: 5 },
];

export interface AccountWorkspace {
  repositories: Repository[];
  lastSync: string | null;
  gists: Gist[];
  starredGists: Gist[];
  selectedGistCategory: GistCategoryId;
  releases: Release[];
  releaseSubscriptions: number[];
  releaseSourceSettings: ReleaseSourceSettings;
  readReleases: number[];
  forks: ForkRepo[];
  readForks: number[];
  customCategories: Category[];
  hiddenDefaultCategoryIds: string[];
  categoryOrder: string[];
  defaultCategoryOverrides: Record<string, Partial<Category>>;
  categoryListIdMap: Record<string, string>;
  syncMode: SyncMode;
  syncModeConfigured: boolean;
}

export interface AppState {
  // Auth
  user: GitHubUser | null;
  githubToken: string | null;
  isAuthenticated: boolean;
  hasHydrated: boolean;
  accountWorkspaces: Record<string, AccountWorkspace>;
  
  // Repositories
  repositories: Repository[];
  isLoading: boolean;
  isSyncingStars: boolean;
  lastSync: string | null;
  analyzingRepositoryIds: Set<number>;
  repositoryViewMode: 'grid' | 'list';
  /** Which fields to display on repository cards (Development Guidelines §14): stores declarative toggles only */
  repositoryCardFields: RepositoryCardFields;
  /** Quick-action order and toolbar visibility; hidden actions remain in the menu. */
  repositoryCardActions: RepositoryCardActionPreference[];

  // Theme tokens (Development Guidelines §14): declarative appearance preferences applied as CSS variables on <html>
  themeTokens: ThemeTokens;

  // Gists
  gists: Gist[];
  starredGists: Gist[];
  gistSearchFilters: GistSearchFilters;
  gistSearchResults: Gist[];
  selectedGistCategory: GistCategoryId;
  analyzingGistIds: Set<string>;
  
  // AI
  aiConfigs: AIConfig[];
  activeAIConfig: string | null;
  repositoryChatSettings: RepositoryChatSettings;

  // Embedding
  embeddingConfigs: EmbeddingConfig[];
  activeEmbeddingConfig: string | null;

  // Vector Search
  vectorSearchConfig: VectorSearchConfig;
  vectorSearchStatus?: VectorSearchStatus;
  vectorIndexingState: VectorIndexingState;

  // Similar repositories view (triggered by "Find Similar Repositories")
  similarView: SimilarViewState | null;

  // WebDAV
  webdavConfigs: WebDAVConfig[];
  activeWebDAVConfig: string | null;
  lastBackup: string | null;
  
  // Search
  searchFilters: SearchFilters;
  searchResults: Repository[];
  
  // Releases
  releases: Release[];
  releaseSubscriptions: Set<number>;
  releaseSourceSettings: ReleaseSourceSettings;
  readReleases: Set<number>; // Read releases
  
  // Categories
  customCategories: Category[]; // Custom categories
  hiddenDefaultCategoryIds: string[];
  defaultCategoryOverrides: Record<string, Partial<Category>>;
  categoryOrder: string[]; // Category display order
  collapsedSidebarCategoryCount: number; // Number of categories displayed when sidebar is collapsed
  categoryMatchMode: CategoryMatchMode; // Category matching mode: based on card visible tags (including custom) or AI tags only
  
  // Asset Filters
  assetFilters: AssetFilter[]; // Asset filters
  
  // UI
  theme: 'light' | 'dark';
  /** Theme color presets (default + built-in curated), see constants/themePresets */
  themePreset: ThemePresetId;
  currentView: 'repositories' | 'gists' | 'releases' | 'forks' | 'settings' | 'subscription';
  selectedCategory: string;
  language: AppLanguage;
  /** README document translation engine (Microsoft / Google / AI), see TranslationEngine */
  translationEngine: TranslationEngine;
  /** Automatically translate repository description on cards to UI language (default off; shows original on same language or failure) */
  autoTranslateRepoDescription: boolean;
  isSidebarCollapsed: boolean;
  readmeModalOpen: boolean;
  headerMenuConfig: HeaderMenuItem[];
  
  // Update
  updateNotification: UpdateNotification | null;

  // Analysis Progress
  analysisProgress: AnalysisProgress

  // Backend
  backendApiSecret: string | null;

  // MCP (local Electron prefs; backend uses SQLite settings when available)
  mcpConfig: McpServiceConfig;

  // Network Proxy
  proxyConfig: ProxyConfig;
  rpcDownloadConfig: RpcDownloadConfig;
  /** Local route preference; excluded from backend/autoSync sync */
  routeMode: RouteMode;

  // Fork Timeline View
  forks: ForkRepo[];
  readForks: Set<number>;

  // Fork Timeline View State
  forkViewMode: 'timeline' | 'repository';
  forkSelectedFilters: string[];
  forkSearchQuery: string;
  forkExpandedRepositories: Set<number>;
  forkIsRefreshing: boolean;

  // Release Timeline View
  releaseViewMode: 'timeline' | 'repository';
  releaseShowMode: 'all' | 'unread';
  releaseLatestMode: 'all' | 'latest';
  releaseSelectedFilters: string[];
  releaseSearchQuery: string;
  releaseExpandedRepositories: Set<number>;
  releaseIsRefreshing: boolean;
  includePreRelease: boolean;  // whether to include pre-release in refresh

  // Backup/Export key inclusion preference
  includeKeysInBackup: boolean;

  // Discovery
  discoveryChannels: DiscoveryChannel[];
  discoveryRepos: Record<DiscoveryChannelId, DiscoveryRepo[]>;
  discoveryLastRefresh: Record<DiscoveryChannelId, string | null>;
  discoveryIsLoading: Record<DiscoveryChannelId, boolean>;
  discoveryIsLoadingMore: Record<DiscoveryChannelId, boolean>;
  discoveryLoadMoreError: Record<DiscoveryChannelId, string | null>;
  selectedDiscoveryChannel: DiscoveryChannelId;
  discoveryPlatform: DiscoveryPlatform;
  discoveryLanguage: ProgrammingLanguage;
  discoverySortBy: SortBy;
  discoverySortOrder: SortOrder;
  discoverySearchQuery: string;
  discoverySelectedTopic: TopicCategory | null;
  discoveryHasMore: Record<DiscoveryChannelId, boolean>;
  discoveryNextPage: Record<DiscoveryChannelId, number>;
  discoveryTotalCount: Record<DiscoveryChannelId, number>;
  discoveryScrollPositions: Record<DiscoveryChannelId, number>;
  trendingTimeRange: TrendingTimeRange;
  /**
   * Trending snapshot history (Development Guidelines §7): records rankings seen locally over time,
   * used to compute rank changes, first-time entries, and consecutive runs.
   * Deduplicated by [time range x language x calendar day], capped by max entries and days.
   */
  trendingSnapshots: TrendingSnapshot[];
  /** Weekly channel filter: show only items included in weekly issues (issue labels contain 'weekly') */
  weeklyOnlyCollected: boolean;
  /** Weekly channel sync progress (session-level, not persisted) */
  weeklySyncStatus: WeeklySyncStatus | null;
  /** X tweet channel: followed creators list (handles without @, initialized with geekbb) */
  xTweetFollows: XTweetFollow[];
  /**
   * X tweet channel: optional logged-in authentication cookies (enables GraphQL fetching + historical pagination).
   * In-memory only; never persisted to IndexedDB or localStorage (protects plaintext cookies from same-origin script access).
   */
  xTweetAuth: XTweetAuth | null;
  /** X auth revision: non-sensitive counter incremented on set/clear, used for invalidating requests and refreshing lists */
  xTweetAuthRevision: number;
  /** X tweet channel sync / detail enrichment progress (session-level, not persisted) */
  xTweetSyncStatus: WeeklySyncStatus | null;
  /** Telegram channel: followed channels list (channel name without @, initialized with geekhub23) */
  telegramFollows: TelegramFollow[];
  /** Telegram channel sync / detail enrichment progress (session-level, not persisted) */
  telegramSyncStatus: WeeklySyncStatus | null;

  // Subscription
  subscriptionRepos: Record<string, SubscriptionRepo[]>;
  subscriptionLastRefresh: Record<string, string | null>;
  subscriptionIsLoading: Record<string, boolean>;
  subscriptionChannels: SubscriptionChannel[];

  // GitHub Lists sync mode: stars only / stars and lists
  syncMode: SyncMode;
  /** Whether the user has explicitly selected a sync mode (set to true after initial login modal) */
  syncModeConfigured: boolean;

  // GitHub Lists push progress (session-level, not persisted)
  listsPush: ListsPushState;
  /** Stable mapping from category ID to GitHub List ID (persisted across languages to avoid creating duplicate lists on language switch) */
  categoryListIdMap: Record<string, string>;
}

export interface ListsPushState {
  isRunning: boolean;
  total: number;
  done: number;
  currentLabel: string | null;
  message: string | null;
  error: string | null;
}

/** GitHub sync scope: 'stars' = starred repositories only; 'stars-and-lists' = starred repositories and Lists */
export type SyncMode = 'stars' | 'stars-and-lists';

export interface UpdateNotification {
  version: string;
  releaseDate: string;
  changelog: string[];
  downloadUrl: string;
  dismissed: boolean;
}

export interface AnalysisProgress {
  current: number;
  total: number;
}

export type DiscoveryPlatform = 'All' | 'Android' | 'Macos' | 'Windows' | 'Linux';

export type ProgrammingLanguage = 
  | 'All' 
  | 'Kotlin' 
  | 'Java' 
  | 'JavaScript' 
  | 'TypeScript' 
  | 'Python' 
  | 'Swift' 
  | 'Rust' 
  | 'Go' 
  | 'CSharp' 
  | 'CPlusPlus' 
  | 'C' 
  | 'Dart' 
  | 'Ruby' 
  | 'PHP';

export type SortBy = 'BestMatch' | 'MostStars' | 'MostForks';

export type SortOrder = 'Descending' | 'Ascending';

export type DiscoveryChannelId = 'trending' | 'hot-release' | 'most-popular' | 'topic' | 'x-tweet' | 'telegram' | 'weekly' | 'search' | 'code-search' | `external:${string}`;

export type DiscoveryChannelIcon = 'trending' | 'rocket' | 'star' | 'tag' | 'tweet' | 'telegram' | 'weekly' | 'search';

/** Ruan Yifeng Weekly channel: reference metadata for source issue (weekly inclusion = labels include 'weekly') */
export interface WeeklyIssueRef {
  number: number;
  title: string;
  html_url: string;
  labels: string[];
  createdAt: string;
}

/** Weekly channel sync / detail enrichment progress */
export interface WeeklySyncStatus {
  phase: 'syncing' | 'enriching';
  current: number;
  total: number;
}

/** X tweet channel: a follow configuration entry (handle without @) */
export interface XTweetFollow {
  handle: string;
  addedAt: string;
}

/**
 * X tweet channel: optional logged-in authentication cookies (configured manually by user in Settings).
 * When configured, requests use the x.com GraphQL API: ~20 tweets per creator per page with cursor-based
 * historical pagination; if empty, falls back to unauthenticated scraping (latest small batch only, no pagination).
 */
export interface XTweetAuth {
  authToken: string;
  ct0: string;
}

/** X tweet channel: reference info for the source tweet of a repo (body cached for offline "View Original Post" rendering) */
export interface XTweetRef {
  tweetId: string;
  /** Creator handle (without @) */
  handle: string;
  displayName: string;
  /** Tweet body (HTML snippet from RSS output) */
  content: string;
  /** Tweet link (https://x.com/<handle>/status/<id>) */
  html_url: string;
  createdAt: string;
}

/** Telegram channel: a follow configuration entry (channel name without @) */
export interface TelegramFollow {
  channel: string;
  addedAt: string;
}

/** Telegram channel: reference info for the source message of a repo (body cached for offline "View Original Message" rendering) */
export interface TelegramRef {
  /** Composite ID `<channel>/<messageId>` */
  messageId: string;
  /** Channel name (without @) */
  channel: string;
  /** Channel display name */
  displayName: string;
  /** Message body (HTML snippet from t.me public preview output) */
  content: string;
  /** Message link (https://t.me/<channel>/<id>) */
  html_url: string;
  createdAt: string;
}

/** User-configured external discovery source formats. */
export type ExternalFeedKind = 'json' | 'rss';

export interface DiscoveryChannel {
  id: DiscoveryChannelId;
  name: string;
  nameEn: string;
  icon: DiscoveryChannelIcon;
  description: string;
  enabled: boolean;
  /** User-configured, public feed; only present for external channels. */
  sourceUrl?: string;
  /** Feed format of `sourceUrl`; omitted means the default JSON format. */
  sourceKind?: ExternalFeedKind;
}

export interface PaginatedDiscoveryRepositories {
  repos: DiscoveryRepo[];
  hasMore: boolean;
  nextPageIndex: number;
  totalCount?: number;
}

export interface DiscoveryRepo extends Repository {
  rank: number;
  channel: DiscoveryChannelId;
  platform: DiscoveryPlatform;
  /** Weekly channel only: corresponding weekly submission issue for this repository */
  weeklyIssue?: WeeklyIssueRef;
  /** X tweet channel only: source tweet for this repository */
  xTweet?: XTweetRef;
  /** Telegram channel only: source channel message for this repository */
  telegram?: TelegramRef;
}

export type TrendingTimeRange = 'daily' | 'weekly' | 'monthly';

export type TopicCategory = 
  | 'ai' 
  | 'ml' 
  | 'database' 
  | 'web' 
  | 'mobile' 
  | 'devtools' 
  | 'security' 
  | 'game';

export interface TopicInfo {
  id: TopicCategory;
  name: string;
  nameEn: string;
  keywords: string;
}

// Subscription related types
export interface SubscriptionRepo extends Repository {
  rank: number;
  channel: 'most-stars' | 'most-forks' | 'most-dev' | 'trending';
}

export interface SubscriptionDev {
  rank: number;
  login: string;
  avatar_url: string;
  html_url: string;
  name: string | null;
  bio: string | null;
  public_repos: number;
  followers: number;
  topRepo: SubscriptionRepo | null;
}

// GitHub API response types
export interface GitHubSearchUserResponse {
  items: Array<{
    login: string;
    avatar_url: string;
    html_url: string;
  }>;
}

export interface GitHubUserDetail {
  login: string;
  avatar_url: string;
  html_url: string;
  name: string | null;
  bio: string | null;
  public_repos: number;
  followers: number;
}

// Subscription channel types
export interface SubscriptionChannel {
  id: string;
  name: string;
  nameEn: string;
  icon: string;
  description: string;
  enabled: boolean;
}

export const defaultSubscriptionChannels: SubscriptionChannel[] = [
  {
    id: 'most-stars',
    name: '最多星标',
    nameEn: 'Most Stars',
    icon: '⭐',
    description: 'GitHub 上星标数最多的项目 Top 10',
    enabled: true,
  },
  {
    id: 'most-forks',
    name: '最多复刻',
    nameEn: 'Most Forks',
    icon: '🍴',
    description: 'GitHub 上复刻数最多的项目 Top 10',
    enabled: true,
  },
  {
    id: 'most-dev',
    name: '热门开发者',
    nameEn: 'Top Developers',
    icon: '👤',
    description: 'GitHub 上最受关注的开发者 Top 10',
    enabled: true,
  },
  {
    id: 'trending',
    name: '热门趋势',
    nameEn: 'Trending',
    icon: '🔥',
    description: 'GitHub 上近期最受关注的项目 Top 10',
    enabled: true,
  },
];
