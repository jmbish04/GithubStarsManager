import React from 'react';
import type { TranslateFn } from '../../i18n/useT';
import type { InstalledPlugin } from '../../plugins/types';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';

interface PluginUninstallDialogProps {
  /** Uninstallation target; does not render when null. */
  target: InstalledPlugin | null;
  t: TranslateFn;
  onClose: () => void;
  /** removePluginData indicates whether to delete stored plugin data and logs along with the plugin. */
  onUninstall: (removePluginData: boolean) => void;
}

/**
 * Plugin uninstallation confirmation dialog: shared by local plugins and the marketplace.
 * Three actions: cancel, uninstall while keeping data, uninstall and delete data.
 */
export const PluginUninstallDialog: React.FC<PluginUninstallDialogProps> = ({ target, t, onClose, onUninstall }) => (
  <AlertDialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>
          {t('pluginSettingsPanel.uninstall-v1', { v1: target?.manifest.name ?? '' })}
        </AlertDialogTitle>
        <AlertDialogDescription className="whitespace-pre-wrap break-all">
          {t('pluginSettingsPanel.the-installed-plugin-directory-is-deleted-choose')}
          {target ? `\n\n${target.manifest.id}` : ''}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>{t('pluginSettingsPanel.cancel')}</AlertDialogCancel>
        <AlertDialogAction onClick={() => onUninstall(false)}>
          {t('pluginSettingsPanel.uninstall-keep-data')}
        </AlertDialogAction>
        <AlertDialogAction
          className="bg-destructive hover:bg-destructive/90"
          onClick={() => onUninstall(true)}
        >
          {t('pluginSettingsPanel.uninstall-and-delete-data')}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);
