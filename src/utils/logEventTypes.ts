export type LogEventType =
  | 'sync'
  | 'aiAnalysis'
  | 'aiSearch'
  | 'githubApi'
  | 'trending'
  | 'release'
  | 'fork'
  | 'workflow'
  | 'backendSync'
  | 'webdav'
  | 'update'
  | 'store'
  | 'app'
  | 'error'
  | 'other';

export const EVENT_TYPE_LABELS: Record<LogEventType, { zh: string; en: string }> = {
  sync:          { zh: 'Sync Repos', en: 'Sync Repos' },
  aiAnalysis:    { zh: 'AI Analysis', en: 'AI Analysis' },
  aiSearch:      { zh: 'AI Search', en: 'AI Search' },
  githubApi:     { zh: 'GitHub API', en: 'GitHub API' },
  trending:      { zh: 'Refresh Trending', en: 'Refresh Trending' },
  release:       { zh: 'Update Releases', en: 'Update Releases' },
  fork:          { zh: 'Refresh Forks', en: 'Refresh Forks' },
  workflow:      { zh: 'Run Workflow', en: 'Run Workflow' },
  backendSync:   { zh: 'Backend Sync', en: 'Backend Sync' },
  webdav:        { zh: 'WebDAV Backup', en: 'WebDAV Backup' },
  update:        { zh: 'App Update', en: 'App Update' },
  store:         { zh: 'Data Store', en: 'Data Store' },
  app:           { zh: 'App', en: 'App' },
  error:         { zh: 'Error', en: 'Error' },
  other:         { zh: 'Other', en: 'Other' },
};

export function inferEventType(module: string, message: string, data?: unknown): LogEventType {
  // Check for explicit operationTag first (set by makeRequest callers)
  const operationTag = (data && typeof data === 'object' && !Array.isArray(data))
    ? (data as Record<string, unknown>).operationTag
    : undefined;
  if (typeof operationTag === 'string') {
    if (operationTag === 'trending') return 'trending';
    if (operationTag === 'release') return 'release';
    if (operationTag === 'fork') return 'fork';
    if (operationTag === 'workflow') return 'workflow';
  }

  if (module.startsWith('sync')) return 'sync';
  if (module === 'ai' && /analysis|analyze/i.test(message)) return 'aiAnalysis';
  if (module === 'ai' && /search/i.test(message)) return 'aiSearch';
  if (module === 'ai' && /request/i.test(message)) return 'aiAnalysis';
  if (module === 'githubApi' && /trending/i.test(message)) return 'trending';
  if (module === 'githubApi' && /release/i.test(message)) return 'release';
  if (module === 'githubApi' && /fork/i.test(message)) return 'fork';
  if (module === 'githubApi' && /workflow/i.test(message)) return 'workflow';
  if (module === 'backendAdapter') return 'backendSync';
  if (module === 'webdav') return 'webdav';
  if (module === 'update') return 'update';
  if (module.startsWith('store')) return 'store';
  if (module === 'app') return 'app';
  if (module === 'ui.errorBoundary') return 'error';
  if (module === 'githubApi') return 'githubApi';
  return 'other';
}