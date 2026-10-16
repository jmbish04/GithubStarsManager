
import { useT } from '../../../i18n/useT';
import { useCallback, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { WebDAVConfig } from '../../../types';
import { useAppStore } from '../../../store/useAppStore';
import { useDialog } from '../../../hooks/useDialog';
import { WebDAVService } from '../../../services/webdavService';

export type WebDAVForm = Pick<WebDAVConfig, 'name' | 'url' | 'username' | 'password' | 'path'>;

export interface WebDAVActions {
  testingId: string | null;
  save: (form: WebDAVForm, editingId: string | null) => boolean;
  test: (config: WebDAVConfig) => Promise<void>;
}

/** Keeps WebDAV validation and remote connection work outside the settings view. */
export const useWebDAVActions = (): WebDAVActions => {
  const t = useT('settings');
  const { webdavConfigs, addWebDAVConfig, updateWebDAVConfig } = useAppStore(useShallow((state) => ({
    webdavConfigs: state.webdavConfigs,
    addWebDAVConfig: state.addWebDAVConfig,
    updateWebDAVConfig: state.updateWebDAVConfig,
  })));
  const { toast } = useDialog();
  const [testingId, setTestingId] = useState<string | null>(null);

  const save = useCallback((form: WebDAVForm, editingId: string | null) => {
    const errors = WebDAVService.validateConfig(form);
    if (errors.length > 0) {
      const translated = errors.map((error) => {
        // Supports English validation errors from WebDAVService and unicode-escaped legacy messages
        if (error === 'WebDAV URL is required' || error === 'WebDAV URL\u662f\u5fc5\u9700\u7684') return t('useWebDAVActions.webdav-url-is-required');
        if (error === 'WebDAV URL must start with http:// or https://' || error === 'WebDAV URL\u5fc5\u987b\u4ee5 http:// \u6216 https:// \u5f00\u5934') return t('useWebDAVActions.webdav-url-must-start-with-http-or-https');
        if (error === 'Username is required' || error === '\u7528\u6237\u540d\u662f\u5fc5\u9700\u7684') return t('useWebDAVActions.username-is-required');
        if (error === 'Password is required' || error === '\u5bc6\u7801\u662f\u5fc5\u9700\u7684') return t('useWebDAVActions.password-is-required');
        if (error === 'Path is required' || error === '\u8def\u5f84\u662f\u5fc5\u9700\u7684') return t('useWebDAVActions.path-is-required');
        if (error === 'Path must start with /' || error === '\u8def\u5f84\u5fc5\u987b\u4ee5 / \u5f00\u5934') return t('useWebDAVActions.path-must-start-with');
        return error;
      });
      toast(translated.join('\n'), 'error');
      return false;
    }

    const existingConfig = editingId ? webdavConfigs.find((config) => config.id === editingId) : undefined;
    const config: WebDAVConfig = {
      id: editingId || Date.now().toString(),
      name: form.name,
      url: form.url.replace(/\/$/, ''),
      username: form.username,
      password: form.password,
      path: form.path,
      isActive: existingConfig?.isActive ?? false,
    };

    if (editingId) {
      updateWebDAVConfig(editingId, config);
    } else {
      addWebDAVConfig(config);
    }
    return true;
  }, [addWebDAVConfig, t, toast, updateWebDAVConfig, webdavConfigs]);

  const test = useCallback(async (config: WebDAVConfig) => {
    setTestingId(config.id);
    try {
      const isConnected = await new WebDAVService(config).testConnection();
      toast(
        isConnected
          ? t('useWebDAVActions.webdav-connection-successful')
          : t('useWebDAVActions.webdav-connection-failed-please-check-configurat'),
        isConnected ? 'success' : 'error',
      );
    } catch (error) {
      console.error('WebDAV test failed:', error);
      toast(`${t('useWebDAVActions.webdav-test-failed')}: ${(error as Error).message}`, 'error');
    } finally {
      setTestingId(null);
    }
  }, [t, toast]);

  return { testingId, save, test };
};
