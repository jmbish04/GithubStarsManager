import type { Repository } from '../types';

/**
 * Plugin page opened via modal action. The session is attached to the app root
 * and does not unmount with repository cards or dropdown menus.
 * When repository is omitted, the page has no repository context (e.g. opened from Settings).
 */
export interface PluginPageSession {
  pluginId: string;
  pluginName: string;
  pageId: string;
  pageTitle: string;
  repository?: Repository;
}

let session: PluginPageSession | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export const pluginPageSession = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): PluginPageSession | null {
    return session;
  },
  open(next: PluginPageSession) {
    session = next;
    emit();
  },
  close() {
    if (!session) return;
    session = null;
    emit();
  },
};
