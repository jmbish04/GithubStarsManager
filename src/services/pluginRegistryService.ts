/**
 * Client bridge for the community plugin registry (Development Guidelines §17 / §18).
 *
 * The main process fetches and validates the registry entry by entry; the renderer only receives "already-validated structures". This **does not download plugin packages**:
 * installation must first verify sha256 on the client, which is the next step and implemented separately.
 */

export interface PluginRegistryEntry {
  id: string;
  version: string;
  apiVersion: string;
  source: string;
  releaseUrl: string;
  sha256: string;
  permissions: string[];
  networkTargets: string[];
  dataUsage: string;
  review: { status: 'approved'; date: string; commit: string };
}

export interface PluginRemovalEntry {
  id: string;
  versions: string[];
  reason: string;
  date: string;
  action: 'revoke' | 'block';
}

export interface PluginRegistry {
  fetchedAt: string;
  plugins: Array<{ id: string; versions: PluginRegistryEntry[] }>;
  removed: PluginRemovalEntry[];
  /** Dropped entries and the reasons — the UI can show "N registry records failed validation". */
  rejected: Array<{ index?: number; code: string; message: string }>;
  /** The reason when one of the two files could not be fetched. */
  error: { code: string; message: string } | null;
}

export type PluginRegistryLoadResult =
  | { success: true; registry: PluginRegistry }
  | { success: false; error: { code: string; message: string } };

interface PluginRegistryElectronAPI {
  load: () => Promise<PluginRegistryLoadResult>;
}

const getApi = (): PluginRegistryElectronAPI | undefined => (
  typeof window === 'undefined' ? undefined : window.electronAPI?.plugins?.registry
);

export const pluginRegistryService = {
  /** Only the desktop build has this channel; the Web build returns false, and the UI uses that to hide the community section. */
  isAvailable(): boolean {
    return !!getApi();
  },

  async load(): Promise<PluginRegistryLoadResult> {
    const api = getApi();
    if (!api) {
      return { success: false, error: { code: 'REGISTRY_UNAVAILABLE', message: 'Plugin registry is only available in the desktop client' } };
    }
    return api.load();
  },
};
