
import type {
  AppState,
  AssetFilter,
  Category,
  DiscoveryChannel,
  GistSearchFilters,
  HeaderMenuId,
  ProxyConfig,
  RpcDownloadConfig,
  McpServiceConfig,
  SearchFilters,
  VectorSearchConfig,
  VectorSearchStatus,
  RepositoryChatSettings,
} from '../types';
import { defaultRepositoryChatAgentBudget, defaultRepositoryChatSettings } from '../types/repositoryChat';
import { EMBEDDING_FORMAT_VERSION } from '../services/vectorSearchService';
import { MCP_DEFAULT_HOST, MCP_DEFAULT_PORT, normalizeMcpHost } from '../utils/mcpHost';
import { PRESET_FILTERS } from '../constants/presetFilters';

export const REQUIRED_HEADER_MENU_IDS: ReadonlySet<HeaderMenuId> = new Set(['repositories', 'settings']);

export const initialSearchFilters: SearchFilters = {
  query: '',
  tags: [],
  languages: [],
  platforms: [],
  licenses: [],
  sortBy: 'stars',
  sortOrder: 'desc',
  isAnalyzed: undefined,
  isSubscribed: undefined,
  isEdited: undefined,
  isCategoryLocked: undefined,
  analysisFailed: undefined,
  healthArchived: undefined,
  healthRecentActivity: undefined,
  healthHasLicense: undefined,
};

export const initialGistSearchFilters: GistSearchFilters = {
  query: '',
  sortBy: 'updated',
  sortOrder: 'desc',
  isAnalyzed: undefined,
};

export type PersistedAppState = Partial<
  Omit<Pick<
    AppState,
    | 'user'
    | 'githubToken'
    | 'isAuthenticated'
    | 'backendApiSecret'
    | 'accountWorkspaces'
    | 'repositories'
    | 'gists'
    | 'starredGists'
    | 'gistSearchFilters'
    | 'gistSearchResults'
    | 'selectedGistCategory'
    | 'lastSync'
    | 'aiConfigs'
    | 'activeAIConfig'
    | 'repositoryChatSettings'
    | 'themeTokens'
    | 'embeddingConfigs'
    | 'activeEmbeddingConfig'
    | 'vectorSearchConfig'
    | 'vectorSearchStatus'
    | 'webdavConfigs'
    | 'activeWebDAVConfig'
    | 'lastBackup'
    | 'releases'
    | 'releaseSourceSettings'
    | 'customCategories'
    | 'hiddenDefaultCategoryIds'
    | 'defaultCategoryOverrides'
    | 'categoryOrder'
    | 'collapsedSidebarCategoryCount'
    | 'categoryMatchMode'
    | 'assetFilters'
    | 'trendingSnapshots'
    | 'repositoryCardFields'
    | 'repositoryCardActions'
    | 'theme'
    | 'themePreset'
    | 'currentView'
    | 'selectedCategory'
    | 'language'
    | 'translationEngine'
    | 'autoTranslateRepoDescription'
    | 'searchFilters'
    | 'isSidebarCollapsed'
    | 'repositoryViewMode'
    | 'forks'
    | 'forkViewMode'
    | 'forkSelectedFilters'
    | 'forkSearchQuery'
    | 'forkExpandedRepositories'
    | 'releaseViewMode'
    | 'releaseShowMode'
    | 'releaseLatestMode'
    | 'releaseSelectedFilters'
    | 'releaseSearchQuery'
    | 'includePreRelease'
    | 'includeKeysInBackup'
    | 'discoveryChannels'
    | 'discoveryRepos'
    | 'discoveryLastRefresh'
    | 'discoveryTotalCount'
    | 'discoveryHasMore'
    | 'discoveryNextPage'
    | 'selectedDiscoveryChannel'
    | 'discoveryPlatform'
    | 'discoveryLanguage'
    | 'discoverySortBy'
    | 'discoverySortOrder'
    | 'discoverySelectedTopic'
    | 'weeklyOnlyCollected'
    | 'xTweetFollows'
    | 'xTweetAuthRevision'
    | 'telegramFollows'
    | 'proxyConfig'
    | 'rpcDownloadConfig'
    | 'routeMode'
    | 'subscriptionRepos'
    | 'subscriptionLastRefresh'
    | 'subscriptionIsLoading'
    | 'subscriptionChannels'
    | 'headerMenuConfig'
    | 'mcpConfig'
    | 'syncMode'
    | 'syncModeConfigured'
    | 'categoryListIdMap'
  >, 'gistSearchFilters' | 'searchFilters' | 'releaseExpandedRepositories' | 'forkExpandedRepositories'>> & {
  gistSearchFilters?: Pick<GistSearchFilters, 'sortBy' | 'sortOrder'>;
  searchFilters?: Pick<SearchFilters, 'sortBy' | 'sortOrder'>;
  proxyConfig?: ProxyConfig;
  rpcDownloadConfig?: RpcDownloadConfig;
  releaseSubscriptions?: unknown;
  readReleases?: unknown;
  readForks?: unknown;
  analyzingGistIds?: unknown;
  releaseExpandedRepositories?: unknown;
  forkExpandedRepositories?: unknown;
};

export const normalizeRepositoryChatSettings = (value: unknown): RepositoryChatSettings => {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const retainSessionDays = typeof record.retainSessionDays === 'number' && Number.isFinite(record.retainSessionDays)
    ? Math.min(365, Math.max(1, Math.round(record.retainSessionDays)))
    : defaultRepositoryChatSettings.retainSessionDays;
  const legacyMaxToolsPerTurn = typeof record.maxToolsPerTurn === 'number' && Number.isFinite(record.maxToolsPerTurn)
    ? Math.min(48, Math.max(1, Math.round(record.maxToolsPerTurn)))
    : defaultRepositoryChatSettings.maxToolsPerTurn;
  const rawBudget = record.agentBudget && typeof record.agentBudget === 'object' && !Array.isArray(record.agentBudget)
    ? record.agentBudget as Record<string, unknown>
    : {};
  const inRange = (value: unknown, fallback: number, min: number, max: number): number => (
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(max, Math.max(min, Math.round(value)))
      : fallback
  );
  const maxToolCalls = inRange(rawBudget.maxToolCalls, legacyMaxToolsPerTurn, 1, 48);
  const maxReadFiles = inRange(rawBudget.maxReadFiles, defaultRepositoryChatAgentBudget.maxReadFiles, 1, 16);
  const agentBudget = {
    maxTurns: inRange(rawBudget.maxTurns, defaultRepositoryChatAgentBudget.maxTurns, 1, 8),
    maxToolCalls,
    maxReadFiles,
    maxCodeReads: Math.min(maxReadFiles, inRange(rawBudget.maxCodeReads, defaultRepositoryChatAgentBudget.maxCodeReads, 0, 12)),
    maxNoProgressRounds: inRange(rawBudget.maxNoProgressRounds, defaultRepositoryChatAgentBudget.maxNoProgressRounds, 1, 4),
    maxDurationMs: inRange(rawBudget.maxDurationMs, defaultRepositoryChatAgentBudget.maxDurationMs, 15_000, 300_000),
  };
  const taskDepth = record.taskDepth === 'quick' || record.taskDepth === 'deep' || record.taskDepth === 'unlimited'
    ? record.taskDepth
    : 'default';
  return {
    enabled: record.enabled !== false,
    chatConfigId: typeof record.chatConfigId === 'string' ? record.chatConfigId : null,
    streamingMode: record.streamingMode === 'off' ? 'off' : 'auto',
    taskDepth,
    enableWebTools: record.enableWebTools === true,
    enableAgentToolLoop: record.enableAgentToolLoop === true,
    retainSessionDays,
    maxToolsPerTurn: maxToolCalls,
    agentBudget,
  };
};

export const normalizeNumberSet = (value: unknown): Set<number> => {
  if (value instanceof Set) {
    return new Set(Array.from(value).filter((item): item is number => typeof item === 'number'));
  }

  if (Array.isArray(value)) {
    return new Set(value.filter((item): item is number => typeof item === 'number'));
  }

  return new Set<number>();
};

// Default for fresh installs / reset configs: starts at the latest format version to prevent initial incremental indexing from triggering an unnecessary full rebuild
export const defaultVectorSearchConfig: VectorSearchConfig = {
  enabled: false,
  workerUrl: '',
  authToken: '',
  embeddingConfigId: '',
  indexMode: 'readme',
  readmeMaxChars: 6000,
  searchThreshold: 0.35,
  searchTopK: 30,
  enableHyDE: true,
  enableReranking: true,
  embeddingFormatVersion: EMBEDDING_FORMAT_VERSION,
};

export const defaultVectorSearchStatus: VectorSearchStatus = {
  connected: false,
  vectorCount: 0,
  dimensions: 0,
};

export const normalizeVectorSearchStatus = (raw: unknown): VectorSearchStatus => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...defaultVectorSearchStatus };
  }

  const status = raw as Record<string, unknown>;
  const vectorCount = typeof status.vectorCount === 'number'
    && Number.isInteger(status.vectorCount)
    && status.vectorCount >= 0
    ? status.vectorCount
    : defaultVectorSearchStatus.vectorCount;
  const dimensions = typeof status.dimensions === 'number'
    && Number.isInteger(status.dimensions)
    && status.dimensions >= 0
    ? status.dimensions
    : defaultVectorSearchStatus.dimensions;

  return {
    connected: status.connected === true,
    vectorCount,
    dimensions,
    ...(typeof status.lastSyncAt === 'string' && Number.isFinite(Date.parse(status.lastSyncAt))
      ? { lastSyncAt: status.lastSyncAt }
      : {}),
    ...(typeof status.error === 'string' ? { error: status.error } : {}),
  };
};

export const defaultMcpConfig: McpServiceConfig = {
  enabled: false,
  host: MCP_DEFAULT_HOST,
  port: MCP_DEFAULT_PORT,
  token: '',
};

export const normalizeMcpConfig = (raw: unknown): McpServiceConfig => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...defaultMcpConfig };
  }
  const config = raw as Record<string, unknown>;
  const port =
    typeof config.port === 'number' && Number.isInteger(config.port) && config.port >= 1 && config.port <= 65535
      ? config.port
      : defaultMcpConfig.port;
  return {
    enabled: config.enabled === true,
    host: normalizeMcpHost(config.host),
    port,
    token: typeof config.token === 'string' ? config.token : '',
  };
};

// Fallback version when persisted historical config lacks embeddingFormatVersion: legacy value is 1, ensuring existing users trigger a rebuild
export const LEGACY_EMBEDDING_FORMAT_VERSION = 1;

export const isKnownEmbeddingFormatVersion = (value: unknown): value is number => (
  typeof value === 'number'
  && Number.isInteger(value)
  && value >= LEGACY_EMBEDDING_FORMAT_VERSION
  && value <= EMBEDDING_FORMAT_VERSION
);

export const normalizeVectorSearchConfig = (
  raw: unknown,
  embeddingConfigs: unknown
): VectorSearchConfig => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...defaultVectorSearchConfig };
  }

  const config = raw as Record<string, unknown>;
  const configId = typeof config.embeddingConfigId === 'string' ? config.embeddingConfigId : '';
  // Only search for embedding config when embeddingConfigId is present, avoiding iterating embeddingConfigs on every hydration
  const hasValidConfig = configId
    ? (Array.isArray(embeddingConfigs)
        ? embeddingConfigs.some((cfg) => cfg && typeof cfg === 'object' && (cfg as { id?: unknown }).id === configId)
        : false)
    : false;
  const searchThreshold = typeof config.searchThreshold === 'number' && Number.isFinite(config.searchThreshold) && config.searchThreshold >= 0 && config.searchThreshold <= 1
    ? config.searchThreshold
    : defaultVectorSearchConfig.searchThreshold;
  const searchTopK = typeof config.searchTopK === 'number' && Number.isInteger(config.searchTopK) && config.searchTopK >= 5 && config.searchTopK <= 50
    ? config.searchTopK
    : defaultVectorSearchConfig.searchTopK;
  // Fallback to legacy version 1 when persisted embeddingFormatVersion is missing or out of range, triggering a full rebuild;
  // do not use defaultVectorSearchConfig.embeddingFormatVersion (= latest version), otherwise existing users would skip the rebuild
  const embeddingFormatVersion = isKnownEmbeddingFormatVersion(config.embeddingFormatVersion)
    ? config.embeddingFormatVersion
    : LEGACY_EMBEDDING_FORMAT_VERSION;

  return {
    ...defaultVectorSearchConfig,
    enabled: config.enabled === true && hasValidConfig,
    workerUrl: typeof config.workerUrl === 'string' ? config.workerUrl : defaultVectorSearchConfig.workerUrl,
    authToken: typeof config.authToken === 'string' ? config.authToken : defaultVectorSearchConfig.authToken,
    embeddingConfigId: hasValidConfig ? configId : defaultVectorSearchConfig.embeddingConfigId,
    indexMode: config.indexMode === 'description' ? 'description' : 'readme',
    readmeMaxChars: typeof config.readmeMaxChars === 'number' && config.readmeMaxChars > 0
      ? config.readmeMaxChars
      : defaultVectorSearchConfig.readmeMaxChars,
    searchThreshold,
    searchTopK,
    enableHyDE: typeof config.enableHyDE === 'boolean'
      ? config.enableHyDE
      : defaultVectorSearchConfig.enableHyDE,
    enableReranking: typeof config.enableReranking === 'boolean'
      ? config.enableReranking
      : defaultVectorSearchConfig.enableReranking,
    embeddingFormatVersion,
  };
};

export const mergeVectorSearchConfig = (
  current: VectorSearchConfig,
  patch: Partial<VectorSearchConfig>
): VectorSearchConfig => {
  const currentVersion = isKnownEmbeddingFormatVersion(current.embeddingFormatVersion)
    ? current.embeddingFormatVersion
    : EMBEDDING_FORMAT_VERSION;
  const patchVersion = patch.embeddingFormatVersion;
  const embeddingFormatVersion = isKnownEmbeddingFormatVersion(patchVersion)
    ? Math.max(currentVersion, patchVersion)
    : currentVersion;

  return {
    ...current,
    ...patch,
    embeddingFormatVersion,
  };
};


export const defaultCategories: Category[] = [
  {
    id: 'all',
    name: '\u5168\u90e8\u5206\u7c7b', // Chinese for "All Categories"
    icon: '📁',
    keywords: []
  },
  {
    id: 'web',
    name: 'Web\u5e94\u7528', // Chinese for "Web Apps"
    icon: '🌐',
    keywords: ['web\u5e94\u7528', 'web', 'website', 'frontend', 'react', 'vue', 'angular'] // Chinese for "web apps"
  },
  {
    id: 'mobile',
    name: '\u79fb\u52a8\u5e94\u7528', // Chinese for "Mobile Apps"
    icon: '📱',
    keywords: ['\u79fb\u52a8\u5e94\u7528', 'mobile', 'android', 'ios', 'flutter', 'react-native'] // Chinese for "mobile apps"
  },
  {
    id: 'desktop',
    name: '\u684c\u9762\u5e94\u7528', // Chinese for "Desktop Apps"
    icon: '💻',
    keywords: ['\u684c\u9762\u5e94\u7528', 'desktop', 'electron', 'gui', 'qt', 'gtk'] // Chinese for "desktop apps"
  },
  {
    id: 'database',
    name: '\u6570\u636e\u5e93', // Chinese for "Database"
    icon: '🗄️',
    keywords: ['\u6570\u636e\u5e93', 'database', 'sql', 'nosql', 'mongodb', 'mysql', 'postgresql'] // Chinese for "database"
  },
  {
    id: 'ai',
    name: 'AI/\u673a\u5668\u5b66\u4e60', // Chinese for "AI/Machine Learning"
    icon: '🤖',
    keywords: ['ai\u5de5\u5177', 'ai', 'ml', 'machine learning', 'deep learning', 'neural'] // Chinese for "ai tools"
  },
  {
    id: 'devtools',
    name: '\u5f00\u53d1\u5de5\u5177', // Chinese for "Development Tools"
    icon: '🔧',
    keywords: ['\u5f00\u53d1\u5de5\u5177', 'tool', 'cli', 'build', 'deploy', 'debug', 'test', 'automation'] // Chinese for "development tools"
  },
  {
    id: 'security',
    name: '\u5b89\u5168\u5de5\u5177', // Chinese for "Security Tools"
    icon: '🛡️',
    keywords: ['\u5b89\u5168\u5de5\u5177', 'security', 'encryption', 'auth', 'vulnerability'] // Chinese for "security tools"
  },
  {
    id: 'game',
    name: '\u6e38\u620f', // Chinese for "Games"
    icon: '🎮',
    keywords: ['\u6e38\u620f', 'game', 'gaming', 'unity', 'unreal', 'godot'] // Chinese for "game"
  },
  {
    id: 'design',
    name: '\u8bbe\u8ba1\u5de5\u5177', // Chinese for "Design Tools"
    icon: '🎨',
    keywords: ['\u8bbe\u8ba1\u5de5\u5177', 'design', 'ui', 'ux', 'graphics', 'image'] // Chinese for "design tools"
  },
  {
    id: 'productivity',
    name: '\u6548\u7387\u5de5\u5177', // Chinese for "Productivity Tools"
    icon: '⚡',
    keywords: ['\u6548\u7387\u5de5\u5177', 'productivity', 'note', 'todo', 'calendar', 'task'] // Chinese for "productivity tools"
  },
  {
    id: 'education',
    name: '\u6559\u80b2\u5b66\u4e60', // Chinese for "Education"
    icon: '📚',
    keywords: ['\u6559\u80b2\u5b66\u4e60', 'education', 'learning', 'tutorial', 'course'] // Chinese for "education"
  },
  {
    id: 'social',
    name: '\u793e\u4ea4\u7f51\u7edc', // Chinese for "Social Network"
    icon: '👥',
    keywords: ['\u793e\u4ea4\u7f51\u7edc', 'social', 'chat', 'messaging', 'communication'] // Chinese for "social network"
  },
  {
    id: 'analytics',
    name: '\u6570\u636e\u5206\u6790', // Chinese for "Data Analytics"
    icon: '📊',
    keywords: ['\u6570\u636e\u5206\u6790', 'analytics', 'data', 'visualization', 'chart'] // Chinese for "data analytics"
  }
];

// Preset filter icon mapping
const PRESET_FILTER_ICONS: Record<string, string> = {
  'preset-windows': 'Monitor',
  'preset-macos': 'Apple',
  'preset-linux': 'Terminal',
  'preset-android': 'Smartphone',
  'preset-source': 'Package',
};

// Default preset filters
export const defaultPresetFilters: AssetFilter[] = PRESET_FILTERS.map(pf => ({
  ...pf,
  isPreset: true,
  icon: PRESET_FILTER_ICONS[pf.id] || 'Package',
}));

export const defaultDiscoveryChannels: DiscoveryChannel[] = [
  {
    id: 'trending',
    name: 'Trending',
    nameEn: 'Trending',
    icon: 'trending',
    description: 'GitHub trending repositories, supports filtering by today, this week, or this month',
    enabled: true,
  },
  {
    id: 'hot-release',
    name: 'Hot Release',
    nameEn: 'Hot Release',
    icon: 'rocket',
    description: 'Repositories actively updated in the last 14 days',
    enabled: true,
  },
  {
    id: 'most-popular',
    name: 'Most Popular',
    nameEn: 'Most Popular',
    icon: 'star',
    description: 'Stable popular repositories with more than 1000 stars',
    enabled: true,
  },
  {
    id: 'topic',
    name: 'Topic',
    nameEn: 'Topic',
    icon: 'tag',
    description: 'Browse repositories categorized by topic',
    enabled: true,
  },
  {
    id: 'x-tweet',
    name: 'X Tweets',
    nameEn: 'X Tweets',
    icon: 'tweet',
    description: 'Follow GitHub projects shared in posts by X bloggers',
    enabled: true,
  },
  {
    id: 'telegram',
    name: 'Telegram Channels',
    nameEn: 'Telegram Channels',
    icon: 'telegram',
    description: 'Follow GitHub projects shared in Telegram channel messages',
    enabled: true,
  },
  {
    id: 'weekly',
    name: 'Ruanyifeng Weekly',
    nameEn: 'Ruanyifeng Weekly',
    icon: 'weekly',
    description: 'Featured open source project submissions from Ruan Yifeng Tech Enthusiast Weekly',
    enabled: true,
  },
  {
    id: 'search',
    name: 'Repo Search',
    nameEn: 'Repo Search',
    icon: 'search',
    description: 'Discover new projects with custom search',
    enabled: true,
  },
  {
    id: 'code-search',
    name: 'Code Search',
    nameEn: 'Code Search',
    icon: 'search',
    description: 'Public repository code full-text search, supporting regex and repo/path/language filters',
    enabled: true,
  },
];
