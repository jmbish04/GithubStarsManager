import type {
  ProxyConfig,
  Repository,
  Category,
  EmbeddingConfig,
  McpServiceConfig,
  Release,
} from '../types';
import type { ElectronPluginAPI } from '../plugins/types';
import type { LogEntry } from './logger';

/** Alias of persisted MCP prefs — keep identical to McpServiceConfig to avoid drift. */
export type McpLocalConfig = McpServiceConfig;

/** Renderer → main diagnostics payload; entries are already sanitized. */
export interface DiagnosticsIpcPayload {
  /** Renderer debug flag piggybacked so main-process capture level follows the same switch. */
  debugMode: boolean;
  entries: LogEntry[];
}

/** Network/time window options for reading the main-process journal. */
export interface DiagnosticsReadOptions {
  since?: string;
  limit?: number;
}

export interface DiagnosticsReadResult {
  success: boolean;
  main: LogEntry[];
  plugins: LogEntry[];
  error?: string;
}

export interface DiagnosticsExportPayload {
  /** null = all history; otherwise hours back (1..168). */
  windowHours: number | null;
  frontendLogs: LogEntry[];
  backendLogs: LogEntry[];
  networkEntries: LogEntry[];
  environment?: Record<string, unknown>;
  sanitizationNote?: string;
}

export interface DiagnosticsExportResult {
  success: boolean;
  canceled?: boolean;
  filePath?: string;
  error?: string;
}

export interface DiagnosticsElectronAPI {
  append: (payload: DiagnosticsIpcPayload) => Promise<{ success: boolean; accepted?: number; error?: string }>;
  /** One-way send (ipcRenderer.send) used on pagehide/beforeunload. */
  flush: (payload: DiagnosticsIpcPayload) => void;
  read: (options?: DiagnosticsReadOptions) => Promise<DiagnosticsReadResult>;
  exportBundle: (payload: DiagnosticsExportPayload) => Promise<DiagnosticsExportResult>;
}

/** Secrets stay in main-process memory only (IPC snapshot); not written to disk by MCP server. */
export interface McpVectorRuntimeConfig {
  enabled: boolean;
  workerUrl: string;
  authToken: string;
  searchThreshold?: number;
  searchTopK?: number;
  embedding: Pick<
    EmbeddingConfig,
    'apiType' | 'baseUrl' | 'apiKey' | 'model' | 'dimensions'
  > | null;
}

export interface McpDataSnapshot {
  repositories: Repository[];
  customCategories: Category[];
  releases: Release[];
  vectorSearchConfig: McpVectorRuntimeConfig;
  snapshotAt: string;
}

export interface McpElectronAPI {
  setConfig: (config: McpLocalConfig) => Promise<{ success: boolean; error?: string }>;
  getConfig: () => Promise<McpLocalConfig | null>;
  pushSnapshot: (snapshot: McpDataSnapshot) => Promise<{ success: boolean }>;
  start: () => Promise<{ success: boolean; error?: string; url?: string }>;
  stop: () => Promise<{ success: boolean }>;
  getStatus: () => Promise<{ running: boolean; url?: string; error?: string }>;
}

/** Desktop client prefs: auto-launch + tray behavior (#345). Electron only. */
export interface DesktopPrefs {
  autoLaunch: boolean;
  closeToTray: boolean;
  minimizeToTray: boolean;
}

export type DesktopPrefsResult = { success: boolean; prefs?: DesktopPrefs; error?: string };

export interface DesktopElectronAPI {
  getPrefs: () => Promise<DesktopPrefs>;
  setAutoLaunch: (enabled: boolean) => Promise<DesktopPrefsResult>;
  setCloseToTray: (enabled: boolean) => Promise<DesktopPrefsResult>;
  setMinimizeToTray: (enabled: boolean) => Promise<DesktopPrefsResult>;
  show: () => Promise<{ success: boolean }>;
}

interface ElectronAPI {
  setProxy: (config: ProxyConfig) => Promise<{ success: boolean }>;
  getProxy: () => Promise<ProxyConfig>;
  testProxy: (config: ProxyConfig) => Promise<{ success: boolean; error?: string }>;
  /** X tweet channel: the main process fetches the logged-out x.com home page HTML (bypassing renderer CORS) */
  xFetchTimeline?: (handle: string) => Promise<{ success: boolean; html?: string; error?: string }>;
  /**
   * X tweet channel authenticated path: the main process issues x.com GraphQL / static asset GET requests
   * (with the user's auth_token/ct0 cookies and Bearer, bypassing renderer CORS)
   */
  xFetchGraphQL?: (url: string, auth: { authToken: string; ct0: string } | null) => Promise<{ success: boolean; body?: string; error?: string }>;
  /** Telegram channel: the main process fetches the t.me/s/<name> public preview HTML (optional before cursor to page through history) */
  telegramFetchChannel?: (channel: string, before?: string) => Promise<{ success: boolean; html?: string; error?: string }>;
  /**
   * WebDAV: the main process issues DAV requests (the renderer has webSecurity enabled and file:// origins are likewise subject to CORS,
   * and the desktop build has no backend, so the main process must send them). The response body is returned as-is text, so upper layers can rebuild a Response.
   */
  webdavRequest?: (params: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  }) => Promise<{
    success: boolean;
    status?: number;
    statusText?: string;
    body?: string;
    contentType?: string;
    error?: string;
    /** Lowest-level error code when the main process network stack fails (e.g. ECONNREFUSED / ENOTFOUND / DEPTH_ZERO_SELF_SIGNED_CERT) */
    causeCode?: string;
    /** Raw description of the lowest-level error (e.g. "connect ECONNREFUSED 10.0.0.5:5006") */
    causeMessage?: string;
    timedOut?: boolean;
  }>;
  xAuth?: {
    save: (auth: { authToken: string; ct0: string }) => Promise<{ success: boolean; error?: string }>;
    get: () => Promise<{ authToken: string; ct0: string } | null>;
    clear: () => Promise<{ success: boolean; error?: string }>;
  };
  desktop?: DesktopElectronAPI;
  mcp?: McpElectronAPI;
  /** Diagnostics bridge (desktop only; absent in web builds). */
  diagnostics?: DiagnosticsElectronAPI;
  plugins?: ElectronPluginAPI & {
    registry?: { load: () => Promise<import('./pluginRegistryService').PluginRegistryLoadResult> };
    marketplace?: import('./pluginMarketplaceService').MarketplaceElectronAPI;
  };
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export const isElectron = (): boolean => {
  return typeof window !== 'undefined' && !!window.electronAPI;
};

export const electronProxy = {
  async setProxy(config: ProxyConfig): Promise<void> {
    if (window.electronAPI) {
      await window.electronAPI.setProxy(config);
    }
  },

  async getProxy(): Promise<ProxyConfig | null> {
    return window.electronAPI?.getProxy() ?? null;
  },

  async testProxy(config: ProxyConfig): Promise<{ success: boolean; error?: string }> {
    if (!window.electronAPI) {
      return { success: false, error: 'Not running in Electron' };
    }
    return window.electronAPI.testProxy(config);
  },
};

/** X tweet channel: fetches the logged-out x.com home page HTML via the main process. Returns null outside desktop. */
export const fetchXTimelineViaDesktop = async (handle: string): Promise<string | null> => {
  if (!window.electronAPI?.xFetchTimeline) return null;
  const result = await window.electronAPI.xFetchTimeline(handle);
  if (!result.success || typeof result.html !== 'string') {
    throw new Error(result.error || 'desktop x.com fetch failed');
  }
  return result.html;
};

const X_HOME_URL = 'https://x.com/home';
const X_MAIN_JS_PATTERN = /^https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/main\.[a-zA-Z0-9_-]+\.js$/;
const X_GRAPHQL_API_PATTERN = /^https:\/\/x\.com\/i\/api\/graphql\/[A-Za-z0-9_-]+\/(UserTweets|UserByScreenName)(\?.*)?$/;

export const isAllowedXGraphQLUrl = (url: string): boolean =>
  url === X_HOME_URL || X_MAIN_JS_PATTERN.test(url) || X_GRAPHQL_API_PATTERN.test(url);

/**
 * X tweet channel authenticated path: issues x.com GraphQL / static asset requests via the main process. Returns null outside desktop.
 * Only x.com and abs.twimg.com targets are allowed; the main process sets redirect: 'error'
 * to reject cross-origin redirects, so cookies cannot be forwarded outside the allowed domains.
 * When auth is null, uses the main process's login-free guest flow (guest token + Chromium stack),
 * as the fallback when an authenticated request is 403'd by x.com's edge WAF (TLS fingerprint blocking).
 */
export const fetchXGraphQLViaDesktop = async (
  url: string,
  auth: { authToken: string; ct0: string } | null,
): Promise<string | null> => {
  if (typeof url !== 'string' || !isAllowedXGraphQLUrl(url)) {
    throw new Error('invalid url for x.com fetch');
  }
  if (!window.electronAPI?.xFetchGraphQL) return null;
  const result = await window.electronAPI.xFetchGraphQL(url, auth);
  if (!result.success || typeof result.body !== 'string') {
    throw new Error(result.error || 'desktop x.com GraphQL fetch failed');
  }
  return result.body;
};

/** Reads the X auth cookies locally and securely (encrypted on this machine with Electron safeStorage). Returns null outside desktop. */
export const loadEncryptedXAuthViaDesktop = async (): Promise<{ authToken: string; ct0: string } | null> => {
  if (!window.electronAPI?.xAuth?.get) return null;
  try {
    return await window.electronAPI.xAuth.get();
  } catch {
    return null;
  }
};

/** Writes the X auth cookies locally and securely (encrypted on this machine with Electron safeStorage). */
export const saveEncryptedXAuthViaDesktop = async (auth: { authToken: string; ct0: string }): Promise<void> => {
  if (!window.electronAPI?.xAuth?.save) return;
  const result = await window.electronAPI.xAuth.save(auth);
  if (result && !result.success) {
    throw new Error(result.error || 'failed to save X authentication');
  }
};

/** Securely clears the locally stored X auth cookies. */
export const clearEncryptedXAuthViaDesktop = async (): Promise<void> => {
  if (!window.electronAPI?.xAuth?.clear) return;
  const result = await window.electronAPI.xAuth.clear();
  if (result && !result.success) {
    throw new Error(result.error || 'failed to clear X authentication');
  }
};


/** Telegram channel: fetches the t.me/s public preview HTML via the main process. Returns null outside desktop. */
export const fetchTelegramChannelViaDesktop = async (channel: string, before?: string): Promise<string | null> => {
  if (!window.electronAPI?.telegramFetchChannel) return null;
  const result = await window.electronAPI.telegramFetchChannel(channel, before);
  if (!result.success || typeof result.html !== 'string') {
    throw new Error(result.error || 'desktop t.me fetch failed');
  }
  return result.html;
};

/** Default prefs mirror the main-process defaults; used before IPC resolves. */
export const DEFAULT_DESKTOP_PREFS: DesktopPrefs = {
  autoLaunch: false,
  closeToTray: true,
  minimizeToTray: true,
};

/** Desktop (auto-launch + tray) bridge. No-op when not in the Electron client. */
export const desktopBridge = {
  isSupported(): boolean {
    return isElectron() && !!window.electronAPI?.desktop;
  },

  async getPrefs(): Promise<DesktopPrefs> {
    if (!window.electronAPI?.desktop) return { ...DEFAULT_DESKTOP_PREFS };
    try {
      return await window.electronAPI.desktop.getPrefs();
    } catch {
      return { ...DEFAULT_DESKTOP_PREFS };
    }
  },

  async setAutoLaunch(enabled: boolean): Promise<DesktopPrefsResult> {
    if (!window.electronAPI?.desktop) {
      return { success: false, error: 'Not running in Electron' };
    }
    return window.electronAPI.desktop.setAutoLaunch(enabled);
  },

  async setCloseToTray(enabled: boolean): Promise<DesktopPrefsResult> {
    if (!window.electronAPI?.desktop) {
      return { success: false, error: 'Not running in Electron' };
    }
    return window.electronAPI.desktop.setCloseToTray(enabled);
  },

  async setMinimizeToTray(enabled: boolean): Promise<DesktopPrefsResult> {
    if (!window.electronAPI?.desktop) {
      return { success: false, error: 'Not running in Electron' };
    }
    return window.electronAPI.desktop.setMinimizeToTray(enabled);
  },

  async show(): Promise<{ success: boolean }> {
    if (!window.electronAPI?.desktop) {
      return { success: false };
    }
    return window.electronAPI.desktop.show();
  },
};
