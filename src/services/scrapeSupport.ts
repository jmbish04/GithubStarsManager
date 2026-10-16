import type { DiscoveryChannelId } from '../types';
import { isElectron } from './electronProxy';

/**
 * Scraping for X tweets and Telegram channels can only be performed in the desktop app (main process IPC)
 * or in web mode with a configured backend (server-side route proxy); neither is available in pure browser mode.
 *
 * Backend availability is pushed by backendAdapter once probing finishes via setBackendAvailability /
 * setBackendProbed (avoiding direct import of backendAdapter to prevent the module cycle:
 * store -> this module -> backendAdapter -> store). For the reactive UI version, see useWebScrapeSupport.
 */
let backendAvailable = false;
let backendProbed = false;

export const setBackendAvailability = (available: boolean): void => {
  backendAvailable = available;
};

/** The availability status is only considered settled after backend.init() completes at least one probe. */
export const setBackendProbed = (): void => {
  backendProbed = true;
};

export const supportsWebScraping = (): boolean => isElectron() || backendAvailable;

/** Scraping support is always available on desktop; web mode must wait until the init probe completes. */
export const isScrapeSupportSettled = (): boolean => isElectron() || backendProbed;

/**
 * Browser environments without scraping support hide x-tweet/telegram channels;
 * store enablement and fallback logic should likewise only account for visible channels.
 */
export const isChannelScrapable = (id: DiscoveryChannelId): boolean =>
  (id !== 'x-tweet' && id !== 'telegram') || supportsWebScraping();
