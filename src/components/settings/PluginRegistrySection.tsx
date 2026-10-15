import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Store } from 'lucide-react';
import { TranslateFn } from '../../i18n/useT';
import { pluginRegistry } from '../../plugins/pluginRegistry';
import { pluginMarketplaceService } from '../../services/pluginMarketplaceService';
import type { MarketplaceState } from '../../plugins/types';
import { comparePluginVersions } from '../../utils/pluginRegistryStatus';
import { Button } from '../ui/button';

interface PluginRegistrySectionProps {
  t: TranslateFn;
  onOpenMarketplace: () => void;
  /** Re-reads local state on change: when sources are modified in the marketplace dialog, card counts update accordingly. */
  reloadSignal?: number;
}

/**
 * Community plugin registry entry card.
 *
 * Provides an entry point and overview (source count, available plugin count) without listing specific plugins:
 * browsing, installing, and source management are handled in the marketplace dialog (PluginMarketplaceDialog).
 */
export const PluginRegistrySection: React.FC<PluginRegistrySectionProps> = ({ t, onOpenMarketplace, reloadSignal = 0 }) => {
  const [state, setState] = useState<MarketplaceState | null>(null);
  const available = pluginMarketplaceService.isAvailable();
  const installedSnapshot = useSyncExternalStore(
    pluginRegistry.subscribe,
    pluginRegistry.getSnapshot,
    pluginRegistry.getSnapshot
  );

  useEffect(() => {
    if (!available) return;
    let disposed = false;
    // Local read only (source list + last-traversed catalog cache); does not make network requests.
    pluginMarketplaceService.getState().then((result) => {
      if (!disposed) setState(result);
    }).catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [available, reloadSignal]);

  if (!available) return null;

  const sourceCount = state?.sources.length ?? 0;
  const pluginCount = state?.entries.reduce((total, entry) => total + entry.plugins.length, 0) ?? 0;
  // Cross-source deduplication matching the marketplace list (for duplicate plugin IDs, only the first encountered source is used);
  // otherwise "updates available" counts could count later source entries that the marketplace never displays.
  const firstEntryById = new Map<string, { version: string }>();
  for (const entry of state?.entries ?? []) {
    for (const plugin of entry.plugins) {
      if (!firstEntryById.has(plugin.manifest.id)) {
        firstEntryById.set(plugin.manifest.id, { version: plugin.manifest.version });
      }
    }
  }
  const updatableCount = new Set(
    installedSnapshot.plugins
      .filter((installed) => {
        const catalogEntry = firstEntryById.get(installed.manifest.id);
        return !!catalogEntry && comparePluginVersions(catalogEntry.version, installed.manifest.version) > 0;
      })
      .map((installed) => installed.manifest.id),
  ).size;

  return (
    <div className="rounded-lg border border-border p-4" data-testid="plugin-registry">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Store className="h-4 w-4" />
            {t('pluginSettingsPanel.community-registry')}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('pluginSettingsPanel.community-registry-hint')}
          </p>
          {sourceCount > 0 && (
            <p className="mt-2 text-xs text-muted-foreground" data-testid="plugin-registry-stats">
              {t('pluginSettingsPanel.marketplace-sources-count-v1', { v1: sourceCount })}
              {pluginCount > 0
                ? ` · ${t('pluginSettingsPanel.marketplace-plugins-count-v1', { v1: pluginCount })}`
                : ''}
              {updatableCount > 0
                ? ` · ${t('pluginSettingsPanel.marketplace-updatable-count-v1', { v1: updatableCount })}`
                : ''}
            </p>
          )}
        </div>
        <Button type="button" size="sm" onClick={onOpenMarketplace} data-testid="plugin-registry-open">
          {t('pluginSettingsPanel.browse-plugins')}
        </Button>
      </div>
    </div>
  );
};

export default PluginRegistrySection;
