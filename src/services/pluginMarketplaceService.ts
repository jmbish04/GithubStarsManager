/**
 * Client bridge for the plugin marketplace (self-service plugin sources).
 *
 * Source management, catalog traversal, and installation all happen in the main process; the renderer only receives already-validated structures.
 * Only the desktop build has this channel; the Web build returns false, and the UI uses that to hide the marketplace entry.
 */

import type {
  MarketplaceInstallRequest,
  MarketplaceMutationResult,
  MarketplaceState,
  PluginError,
} from '../plugins/types';

export interface MarketplaceElectronAPI {
  getState: () => Promise<MarketplaceState>;
  addSource: (input: { url: string; name?: string }) => Promise<MarketplaceMutationResult>;
  updateSource: (input: { id: string; url?: string; name?: string }) => Promise<MarketplaceMutationResult>;
  removeSource: (input: { id: string }) => Promise<MarketplaceMutationResult>;
  refresh: (options?: { sourceId?: string }) => Promise<MarketplaceMutationResult>;
  install: (request: MarketplaceInstallRequest) => Promise<
    { success: true; pluginId: string; permissionsChanged?: boolean; keptEnabled?: boolean } | { success: false; error: PluginError }
  >;
}

const unavailableError = () => ({
  success: false as const,
  error: { code: 'MARKETPLACE_UNAVAILABLE', message: 'The plugin marketplace is only available in the desktop app' },
});

const getApi = (): MarketplaceElectronAPI | undefined => (
  typeof window === 'undefined' ? undefined : window.electronAPI?.plugins?.marketplace as MarketplaceElectronAPI | undefined
);

export const pluginMarketplaceService = {
  isAvailable(): boolean {
    return !!getApi();
  },

  async getState(): Promise<MarketplaceState> {
    const api = getApi();
    if (!api) return { sources: [], entries: [] };
    return api.getState();
  },

  async addSource(input: { url: string; name?: string }): Promise<MarketplaceMutationResult> {
    const api = getApi();
    if (!api) return unavailableError();
    return api.addSource(input);
  },

  async updateSource(input: { id: string; url?: string; name?: string }): Promise<MarketplaceMutationResult> {
    const api = getApi();
    if (!api) return unavailableError();
    return api.updateSource(input);
  },

  async removeSource(input: { id: string }): Promise<MarketplaceMutationResult> {
    const api = getApi();
    if (!api) return unavailableError();
    return api.removeSource(input);
  },

  async refresh(options?: { sourceId?: string }): Promise<MarketplaceMutationResult> {
    const api = getApi();
    if (!api) return unavailableError();
    return api.refresh(options);
  },

  async install(request: MarketplaceInstallRequest) {
    const api = getApi();
    if (!api) return unavailableError();
    return api.install(request);
  },
};
