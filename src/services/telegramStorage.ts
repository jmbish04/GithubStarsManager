/**
 * Telegram channel persistence layer (dedicated IndexedDB, modeled after xTweetStorage).
 *
 * Discovery page discoveryRepos are session-level data and not persisted, but fetching channel messages
 * and repository details is expensive (each fetch proxies t.me public preview pages and batch-enriches repo details),
 * so they are stored here for cross-session reuse, while refreshChannel only performs incremental synchronization.
 */

import type { GitHubRepoDetailRead } from './githubApi';

/** Channel message (body cached for "view original message" offline rendering) */
export interface TelegramStoredMessage {
  /** Composite key `<channel>/<messageId>` (globally unique across channels) */
  messageId: string;
  /** Channel name (without @) */
  channel: string;
  /** Channel display name (snapshot from page owner_name during scrape) */
  displayName: string;
  /** Message body (HTML snippet output by t.me public preview) */
  content: string;
  /** Message URL (https://t.me/<channel>/<id>) */
  htmlUrl: string;
  createdAt: string;
  /** Repository full_name extracted from the message (lowercased key, corresponding to repos store) */
  repoFullNames: string[];
}

/**
 * GitHub repositories referenced in messages (deduplicated by lowercased full_name, one entry per repo).
 * A null detail with non-empty lastFetchedAt indicates the repository is unavailable (deleted/private); retry upon expiry.
 */
export interface TelegramStoredRepo {
  fullName: string;
  detail: GitHubRepoDetailRead | null;
  lastFetchedAt: string;
  /** Source message = message with the latest publication timestamp */
  sourceMessageId: string;
  messageCreatedAt: string;
}

/** Pagination cursor for a single channel: cursor is the next page ?before= value (null = has not paginated yet) */
export interface TelegramChannelPageState {
  cursor: string | null;
  /** Reached the end of channel history (rel=prev absent) */
  exhausted: boolean;
}

export interface TelegramSyncMeta {
  lastSyncedAt: string | null;
  /** Follows list signature when watermark was generated (normalized channel names sorted and concatenated); invalidates on list changes */
  followsSignature: string;
  /** Pagination cursor for each channel (preserved across sessions; "load more" continues from last position) */
  pages: Record<string, TelegramChannelPageState>;
}

const createDefaultMeta = (): TelegramSyncMeta => ({
  lastSyncedAt: null,
  followsSignature: '',
  pages: {},
});

const normalizeMeta = (meta: TelegramSyncMeta | null | undefined): TelegramSyncMeta => ({
  lastSyncedAt: meta?.lastSyncedAt ?? null,
  followsSignature: typeof meta?.followsSignature === 'string' ? meta.followsSignature : '',
  pages: meta?.pages && typeof meta.pages === 'object'
    ? Object.fromEntries(
        Object.entries(meta.pages)
          .filter(([, v]) => v && typeof v === 'object')
          .map(([k, v]) => [k, {
            cursor: typeof (v as TelegramChannelPageState).cursor === 'string'
              ? (v as TelegramChannelPageState).cursor : null,
            exhausted: Boolean((v as TelegramChannelPageState).exhausted),
          }]),
      )
    : {},
});

const DB_NAME = 'github-stars-telegram';
const DB_VERSION = 1;
const MESSAGES_STORE = 'messages';
const REPOS_STORE = 'repos';
const META_STORE = 'meta';

const canUseIndexedDB = (): boolean =>
  typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';

const openDb = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MESSAGES_STORE)) db.createObjectStore(MESSAGES_STORE);
      if (!db.objectStoreNames.contains(REPOS_STORE)) db.createObjectStore(REPOS_STORE);
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  const timeoutPromise = new Promise<T>((_, reject) =>
    setTimeout(() => reject(new Error('telegramStorage timeout')), timeoutMs),
  );
  return Promise.race([promise, timeoutPromise]);
};

/** Write transaction: execute synchronously dispatches all write requests; completion of the transaction indicates success. */
const runWriteTx = async (
  storeName: string,
  timeoutMs: number,
  execute: (store: IDBObjectStore) => void,
): Promise<void> => {
  if (!canUseIndexedDB()) throw new Error('IndexedDB unavailable');
  const db = await withTimeout(openDb(), timeoutMs);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const timer = setTimeout(() => {
        try {
          tx.abort();
        } catch {
          // Transaction may have already finished on its own
        }
        reject(new Error('telegramStorage timeout'));
      }, timeoutMs);
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      try {
        execute(tx.objectStore(storeName));
      } catch (e) {
        settle(() => reject(e instanceof Error ? e : new Error(String(e))));
        return;
      }
      tx.oncomplete = () => settle(resolve);
      tx.onerror = () => settle(() => reject(tx.error ?? new Error('transaction error')));
      tx.onabort = () => settle(() => reject(tx.error ?? new Error('transaction aborted')));
    });
  } finally {
    db.close();
  }
};

/** Read transaction: retrieves a single record (resolves undefined if record does not exist). */
const runGetTx = async <T>(
  storeName: string,
  timeoutMs: number,
  key: IDBValidKey,
): Promise<T | undefined> => {
  if (!canUseIndexedDB()) throw new Error('IndexedDB unavailable');
  const db = await withTimeout(openDb(), timeoutMs);
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const timer = setTimeout(() => reject(new Error('telegramStorage timeout')), timeoutMs);
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => settle(() => resolve(req.result as T | undefined));
      req.onerror = () => settle(() => reject(req.error ?? new Error('request error')));
    });
  } finally {
    db.close();
  }
};

/** Cursor traversal: visit consumes each key-value pair; finishes when traversal completes. */
const runCursorTx = async (
  storeName: string,
  timeoutMs: number,
  visit: (value: unknown, key: IDBValidKey) => void,
): Promise<void> => {
  if (!canUseIndexedDB()) throw new Error('IndexedDB unavailable');
  const db = await withTimeout(openDb(), timeoutMs);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const timer = setTimeout(() => {
        try {
          tx.abort();
        } catch {
          // Transaction may have already finished on its own
        }
        reject(new Error('telegramStorage timeout'));
      }, timeoutMs);
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const req = tx.objectStore(storeName).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          settle(resolve);
          return;
        }
        try {
          visit(cursor.value, cursor.key);
        } catch (e) {
          settle(() => reject(e instanceof Error ? e : new Error(String(e))));
          return;
        }
        cursor.continue();
      };
      req.onerror = () => settle(() => reject(req.error ?? new Error('request error')));
    });
  } finally {
    db.close();
  }
};

export const telegramStorage = {
  /** Batch upsert messages (keyed by `<channel>/<id>` composite key). Does not throw on write failure (does not block sync flow). */
  async saveMessages(messages: TelegramStoredMessage[]): Promise<void> {
    if (messages.length === 0) return;
    try {
      await runWriteTx(MESSAGES_STORE, 15_000, (store) => {
        for (const message of messages) store.put(message, message.messageId);
      });
    } catch (e) {
      console.warn('[telegramStorage] saveMessages failed:', e);
    }
  },

  /**
   * Throws read failures upward (does not return partial snapshots): callers treat this as authoritative in-memory state;
   * missing keys would cause known messages to be recreated as new messages, overwriting persisted data with empty details.
   */
  async getAllMessages(): Promise<Map<string, TelegramStoredMessage>> {
    const result = new Map<string, TelegramStoredMessage>();
    if (!canUseIndexedDB()) return result;
    await runCursorTx(MESSAGES_STORE, 20_000, (value) => {
      const message = value as TelegramStoredMessage;
      if (message && typeof message.messageId === 'string') result.set(message.messageId, message);
    });
    return result;
  },

  /** Batch upsert repositories (keyed by lowercased full_name). Does not throw on write failure (does not block sync flow). */
  async saveRepos(repos: TelegramStoredRepo[]): Promise<void> {
    if (repos.length === 0) return;
    try {
      await runWriteTx(REPOS_STORE, 15_000, (store) => {
        for (const repo of repos) store.put(repo, repo.fullName.toLowerCase());
      });
    } catch (e) {
      console.warn('[telegramStorage] saveRepos failed:', e);
    }
  },

  /** Throws read failures upward (same as getAllMessages: does not return partial snapshots). */
  async getAllRepos(): Promise<Map<string, TelegramStoredRepo>> {
    const result = new Map<string, TelegramStoredRepo>();
    if (!canUseIndexedDB()) return result;
    await runCursorTx(REPOS_STORE, 15_000, (value) => {
      const repo = value as TelegramStoredRepo;
      if (repo && typeof repo.fullName === 'string') result.set(repo.fullName.toLowerCase(), repo);
    });
    return result;
  },

  async getSyncMeta(): Promise<TelegramSyncMeta> {
    // Non-IndexedDB environment (e.g. SSR/test) is treated as non-existent record, returning fresh default value;
    // actual read failures throw upward to prevent callers from misinterpreting a missing cursor as "has not paginated yet",
    // which would refetch the latest page and overwrite advanced positions with a new cursor.
    if (!canUseIndexedDB()) return createDefaultMeta();
    const meta = await withTimeout(runGetTx<TelegramSyncMeta>(META_STORE, 5000, 'sync'), 6000);
    if (meta === undefined) return createDefaultMeta();
    return normalizeMeta(meta);
  },

  async saveSyncMeta(meta: TelegramSyncMeta): Promise<void> {
    try {
      await runWriteTx(META_STORE, 5000, (store) => {
        store.put(meta, 'sync');
      });
    } catch (e) {
      console.warn('[telegramStorage] saveSyncMeta failed:', e);
    }
  },

  /**
   * Atomic persistence for sync batches: messages + repos + meta (watermark/cursor) are written in a single
   * cross-store readwrite transaction. If any write fails, the entire transaction rolls back and throws—callers
   * will not advance the in-memory cursor, and the next sync will re-fetch this batch of messages, preventing gaps
   * where cursors advance without data persistence.
   */
  async saveSyncBatch(payload: {
    messages: TelegramStoredMessage[];
    repos: TelegramStoredRepo[];
    meta: TelegramSyncMeta;
  }): Promise<void> {
    if (!canUseIndexedDB()) throw new Error('IndexedDB unavailable');
    const db = await withTimeout(openDb(), 15_000);
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([MESSAGES_STORE, REPOS_STORE, META_STORE], 'readwrite');
        const timer = setTimeout(() => {
          try {
            tx.abort();
          } catch {
            // Transaction may have already finished on its own
          }
          reject(new Error('telegramStorage timeout'));
        }, 15_000);
        let settled = false;
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn();
        };
        try {
          const messageStore = tx.objectStore(MESSAGES_STORE);
          for (const message of payload.messages) messageStore.put(message, message.messageId);
          const repoStore = tx.objectStore(REPOS_STORE);
          for (const repo of payload.repos) repoStore.put(repo, repo.fullName.toLowerCase());
          tx.objectStore(META_STORE).put(payload.meta, 'sync');
        } catch (e) {
          settle(() => reject(e instanceof Error ? e : new Error(String(e))));
          return;
        }
        tx.oncomplete = () => settle(resolve);
        tx.onerror = () => settle(() => reject(tx.error ?? new Error('transaction error')));
        tx.onabort = () => settle(() => reject(tx.error ?? new Error('transaction aborted')));
      });
    } finally {
      db.close();
    }
  },

  /**
   * Clear all channel data (called by "delete discovery cache/delete all data" in settings).
   * Throws errors upward (callers determine whether to notify success); clears meta first so that even if subsequent
   * store cleanups fail, the watermark and cursors are removed, allowing the next sync to self-heal via full rescan.
   */
  async clearAll(): Promise<void> {
    if (!canUseIndexedDB()) return;
    await runWriteTx(META_STORE, 5000, (store) => store.clear());
    await runWriteTx(MESSAGES_STORE, 15_000, (store) => store.clear());
    await runWriteTx(REPOS_STORE, 15_000, (store) => store.clear());
  },
};
