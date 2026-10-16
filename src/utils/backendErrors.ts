import { isAppLanguage, type AppLanguage } from '../i18n/languages';

const ERROR_MESSAGES: Record<string, { zh: string; en: string }> = {
  // Auth
  UNAUTHORIZED: { zh: 'Unauthorized, please check API Secret', en: 'Unauthorized, please check API Secret' },
  // Proxy
  GITHUB_TOKEN_NOT_CONFIGURED: { zh: 'GitHub token not configured', en: 'GitHub token not configured' },
  GITHUB_TOKEN_DECRYPT_FAILED: { zh: 'Failed to decrypt GitHub token', en: 'Failed to decrypt GitHub token' },
  GITHUB_PROXY_FAILED: { zh: 'GitHub proxy failed', en: 'GitHub proxy failed' },
  CONFIG_ID_REQUIRED: { zh: 'Config ID required', en: 'Config ID required' },
  AI_CONFIG_NOT_FOUND: { zh: 'AI config not found', en: 'AI config not found' },
  AI_PROXY_FAILED: { zh: 'AI proxy failed', en: 'AI proxy failed' },
  WEBDAV_CONFIG_NOT_FOUND: { zh: 'WebDAV config not found', en: 'WebDAV config not found' },
  WEBDAV_PROXY_FAILED: { zh: 'WebDAV proxy failed', en: 'WebDAV proxy failed' },
  GATEWAY_TIMEOUT: { zh: 'Gateway Timeout', en: 'Gateway Timeout' },
  BAD_GATEWAY: { zh: 'Bad Gateway', en: 'Bad Gateway' },
  // Repositories
  FETCH_REPOSITORIES_FAILED: { zh: 'Failed to fetch repositories', en: 'Failed to fetch repositories' },
  REPOSITORIES_ARRAY_REQUIRED: { zh: 'Repositories array required', en: 'Repositories array required' },
  UPSERT_REPOSITORIES_FAILED: { zh: 'Failed to upsert repositories', en: 'Failed to upsert repositories' },
  NO_VALID_FIELDS: { zh: 'No valid fields to update', en: 'No valid fields to update' },
  REPOSITORY_NOT_FOUND: { zh: 'Repository not found', en: 'Repository not found' },
  UPDATE_REPOSITORY_FAILED: { zh: 'Failed to update repository', en: 'Failed to update repository' },
  // Releases
  FETCH_RELEASES_FAILED: { zh: 'Failed to fetch releases', en: 'Failed to fetch releases' },
  RELEASES_ARRAY_REQUIRED: { zh: 'Releases array required', en: 'Releases array required' },
  UPSERT_RELEASES_FAILED: { zh: 'Failed to upsert releases', en: 'Failed to upsert releases' },
  IS_READ_REQUIRED: { zh: 'is_read field required', en: 'is_read field required' },
  RELEASE_NOT_FOUND: { zh: 'Release not found', en: 'Release not found' },
  UPDATE_RELEASE_FAILED: { zh: 'Failed to update release', en: 'Failed to update release' },
  MARK_ALL_READ_FAILED: { zh: 'Failed to mark all as read', en: 'Failed to mark all as read' },
  // Categories
  FETCH_CATEGORIES_FAILED: { zh: 'Failed to fetch categories', en: 'Failed to fetch categories' },
  CREATE_CATEGORY_FAILED: { zh: 'Failed to create category', en: 'Failed to create category' },
  CATEGORY_NOT_FOUND: { zh: 'Category not found', en: 'Category not found' },
  UPDATE_CATEGORY_FAILED: { zh: 'Failed to update category', en: 'Failed to update category' },
  DELETE_CATEGORY_FAILED: { zh: 'Failed to delete category', en: 'Failed to delete category' },
  // Asset filters
  FETCH_ASSET_FILTERS_FAILED: { zh: 'Failed to fetch asset filters', en: 'Failed to fetch asset filters' },
  CREATE_ASSET_FILTER_FAILED: { zh: 'Failed to create asset filter', en: 'Failed to create asset filter' },
  ASSET_FILTER_NOT_FOUND: { zh: 'Asset filter not found', en: 'Asset filter not found' },
  UPDATE_ASSET_FILTER_FAILED: { zh: 'Failed to update asset filter', en: 'Failed to update asset filter' },
  DELETE_ASSET_FILTER_FAILED: { zh: 'Failed to delete asset filter', en: 'Failed to delete asset filter' },
  // Configs
  FETCH_AI_CONFIGS_FAILED: { zh: 'Failed to fetch AI configs', en: 'Failed to fetch AI configs' },
  CREATE_AI_CONFIG_FAILED: { zh: 'Failed to create AI config', en: 'Failed to create AI config' },
  UPDATE_AI_CONFIG_FAILED: { zh: 'Failed to update AI config', en: 'Failed to update AI config' },
  DELETE_AI_CONFIG_FAILED: { zh: 'Failed to delete AI config', en: 'Failed to delete AI config' },
  FETCH_WEBDAV_CONFIGS_FAILED: { zh: 'Failed to fetch WebDAV configs', en: 'Failed to fetch WebDAV configs' },
  CREATE_WEBDAV_CONFIG_FAILED: { zh: 'Failed to create WebDAV config', en: 'Failed to create WebDAV config' },
  UPDATE_WEBDAV_CONFIG_FAILED: { zh: 'Failed to update WebDAV config', en: 'Failed to update WebDAV config' },
  DELETE_WEBDAV_CONFIG_FAILED: { zh: 'Failed to delete WebDAV config', en: 'Failed to delete WebDAV config' },
  SYNC_AI_CONFIGS_FAILED: { zh: 'Failed to sync AI configs', en: 'Failed to sync AI configs' },
  SYNC_AI_CONFIGS_ALL_SKIPPED: { zh: 'Failed to sync AI configs: all configs skipped, see errors for details', en: 'Failed to sync AI configs: all configs skipped, see errors for details' },
  SYNC_WEBDAV_CONFIGS_FAILED: { zh: 'Failed to sync WebDAV configs', en: 'Failed to sync WebDAV configs' },
  SYNC_WEBDAV_CONFIGS_ALL_SKIPPED: { zh: 'Failed to sync WebDAV configs: all configs skipped, see errors for details', en: 'Failed to sync WebDAV configs: all configs skipped, see errors for details' },
  INVALID_REQUEST: { zh: 'Invalid request', en: 'Invalid request' },
  FETCH_SETTINGS_FAILED: { zh: 'Failed to fetch settings', en: 'Failed to fetch settings' },
  UPDATE_SETTINGS_FAILED: { zh: 'Failed to update settings', en: 'Failed to update settings' },
  // Sync
  EXPORT_DATA_FAILED: { zh: 'Failed to export data', en: 'Failed to export data' },
  IMPORT_DATA_FAILED: { zh: 'Failed to import data', en: 'Failed to import data' },
  // General
  INTERNAL_SERVER_ERROR: { zh: 'Internal server error', en: 'Internal server error' },
};

function getCurrentLanguage(): AppLanguage {
  try {
    const storeData = localStorage.getItem('github-stars-manager');
    if (storeData) {
      const parsed = JSON.parse(storeData);
      const lang = parsed.state?.language;
      if (isAppLanguage(lang)) return lang;
    }
  } catch { /* ignore */ }
  return 'zh';
}

export function translateBackendError(code: string | undefined, fallback: string): string {
  if (!code) return fallback;
  const entry = ERROR_MESSAGES[code];
  if (!entry) return fallback;
  const lang = getCurrentLanguage();
  return lang === 'zh' ? entry.zh : entry.en;
}

