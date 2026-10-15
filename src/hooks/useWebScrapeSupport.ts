import { useSyncExternalStore } from 'react';
import { backend } from '../services/backendAdapter';
import { isScrapeSupportSettled, supportsWebScraping } from '../services/scrapeSupport';

export interface WebScrapeSupport {
  /** Whether the current environment has an X (Twitter) tweet/Telegram scraping channel (desktop IPC or backend route). */
  supported: boolean;
  /** Whether the determination is finalized: the web client must wait for backend.init() probing to finish; do not hide channels or migrate selections before then. */
  settled: boolean;
}

/**
 * Scraping X tweets/Telegram channels can only be performed on desktop (main-process IPC)
 * or web clients configured with a backend (server routes proxy scraping); neither is available
 * in pure browser mode. This hook reactively returns channel support status: on desktop it is
 * always supported=true, settled=true; on web, it triggers re-renders via subscription once
 * backend.init() probing settles.
 */
export const useWebScrapeSupport = (): WebScrapeSupport => {
  const supported = useSyncExternalStore(
    listener => backend.subscribeAvailability(listener),
    () => supportsWebScraping(),
    () => false,
  );
  const settled = useSyncExternalStore(
    listener => backend.subscribeAvailability(listener),
    () => isScrapeSupportSettled(),
    () => false,
  );
  return { supported, settled };
};
