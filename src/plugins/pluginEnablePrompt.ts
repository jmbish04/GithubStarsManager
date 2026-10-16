import type { TranslateFn } from '../i18n/useT';
import type { PluginManifest } from './types';

export interface PluginEnablePrompt {
  title: string;
  message: string;
  confirmText: string;
}

/**
 * Assembles the permission confirmation text for "Enable plugin". Shared between
 * the local plugin panel and the plugin marketplace, ensuring both entry points
 * disclose identical information to the user.
 */
export function buildPluginEnablePrompt(t: TranslateFn, manifest: PluginManifest): PluginEnablePrompt {
  const permissions = manifest.permissions;
  const permissionText = permissions.length > 0
    ? permissions.map((permission) => `• ${permission}`).join('\n')
    : t('pluginSettingsPanel.no-additional-host-permissions');
  const repositoryDataNotice = permissions.some((permission) =>
    permission === 'repositories:read' || permission === 'privateRepositories:read')
    ? t('pluginSettingsPanel.note-repository-read-access-includes-metadata-of')
    : '';
  const networkNotice = permissions.some((permission) => permission.startsWith('network:'))
    ? t('pluginSettingsPanel.note-network-access-uses-your-github-token')
    : '';
  return {
    title: t('pluginSettingsPanel.enable-v1', { v1: manifest.name }),
    message: `${t('pluginSettingsPanel.local-plugins-with-worker-js-have-node-js-access')}\n\n${t('pluginSettingsPanel.requested-permissions')}\n${permissionText}${repositoryDataNotice}${networkNotice}`,
    confirmText: t('pluginSettingsPanel.confirm-and-enable'),
  };
}
