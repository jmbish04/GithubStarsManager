/**
 * Persistence layer for X tweet channels (independent IndexedDB, patterned after weeklyIssuesStorage).
 *
 * Discovery page discoveryRepos are session-level data and not persisted, but tweets and repository details are expensive to fetch
 * (each refresh requires fetching timelines of multiple creators across RSSHub instances and batch-filling repository details),
 * so they are stored here to reuse across sessions, allowing refreshChannel to perform incremental syncs only.
 */

import type { GitHubRepoDetailRead } from './githubApi';

/** Tweets from followed creators (body cached for offline rendering of "view original post") */
export interface XStoredTweet {
  tweetId: string;
  handle: string;
  displayName: string;
  /** Tweet body (HTML snippet output by RSS) */
  content: string;
  htmlUrl: string;
  createdAt: string;
  /** Repository full_name extracted from the tweet (lowercased key, corresponding to repos store) */
  repoFullNames: string[];
}

/**
 * GitHub repositories referenced in tweets (deduplicated by lowercased full_name, one entry per repository).
 * A null detail with non-empty lastFetchedAt indicates the repository is unavailable (deleted/private); retry upon expiration.
 */
export interface XStoredRepo {
  fullName: string;
  detail: GitHubRepoDetailRead | null;
  lastFetchedAt: string;
  /** Source tweet = tweet with the latest publication timestamp */
  sourceTweetId: string;
  tweetCreatedAt: string;
}

/** GraphQL pagination cursor for a single creator: cursor is the request parameter for the next page (null = has not paginated yet) */
export interface XTweetPageState {
  cursor: string | null;
  /** Reached the end of the timeline (no bottom cursor) */
  exhausted: boolean;
}

export interface XTweetSyncMeta {
  lastSyncedAt: string | null;
  /** Follows list signature when the watermark was generated (normalized handles sorted and concatenated); watermark invalidates on list changes */
  followsSignature: string;
  /** Auth fingerprint (clears tweet and repository caches when switching between different cookies) */
  authFingerprint?: string;
  /** Pagination cursors for auth path (preserved across sessions; "load more" continues from the last position) */
  pages: Record<string, XTweetPageState>;
  /** Resolved creator user IDs (handle -> rest_id, reused by auth GraphQL path) */
  userIds: Record<string, string>;
  /** GraphQL queryId extracted from online bundles (cached to protect against queryId rotations) */
  queryIds: Record<string, string>;
}

const createDefaultMeta = (): XTweetSyncMeta => ({
  lastSyncedAt: null,
  followsSignature: '',
  authFingerprint: '',
  pages: {},
  userIds: {},
  queryIds: {},
});

const normalizeStringRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'string' && v.length > 0)
      .map(([k, v]) => [k, v as string]),
  );
};

const normalizeMeta = (meta: XTweetSyncMeta | null | undefined): XTweetSyncMeta => ({
  lastSyncedAt: meta?.lastSyncedAt ?? null,
  followsSignature: typeof meta?.followsSignature === 'string' ? meta.followsSignature : '',
  authFingerprint: typeof meta?.authFingerprint === 'string' ? meta.authFingerprint : '',
  pages: meta?.pages && typeof meta.pages === 'object'
    ? Object.fromEntries(
        Object.entries(meta.pages)
          .filter(([, v]) => v && typeof v === 'object')
          .map(([k, v]) => [k, {
            cursor: typeof (v as XTweetPageState).cursor === 'string'
              ? (v as XTweetPageState).cursor : null,
            exhausted: Boolean((v as XTweetPageState).exhausted),
          }]),
      )
    : {},
  userIds: normalizeStringRecord(meta?.userIds),
  queryIds: normalizeStringRecord(meta?.queryIds),
});

const DB_NAME = 'github-stars-x-tweet';
const DB_VERSION = 1;
const TWEETS_STORE = 'tweets';
const REPOS_STORE = 'repos';
const META_STORE = 'meta';

const canUseIndexedDB = (): boolean =>
  typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';

const openDb = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(TWEETS_STORE)) db.createObjectStore(TWEETS_STORE);
      if (!db.objectStoreNames.contains(REPOS_STORE)) db.createObjectStore(REPOS_STORE);
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  const timeoutPromise = new Promise<T>((_, reject) =>
    setTimeout(() => reject(new Error('xTweetStorage timeout')), timeoutMs),
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
        reject(new Error('xTweetStorage timeout'));
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
      const timer = setTimeout(() => reject(new Error('xTweetStorage timeout')), timeoutMs);
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
        reject(new Error('xTweetStorage timeout'));
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

export const xTweetStorage = {
  /** Batch upsert tweets (keyed by tweetId). Does not throw on write failure (does not block sync flow). */
  async saveTweets(tweets: XStoredTweet[]): Promise<void> {
    if (tweets.length === 0) return;
    try {
      await runWriteTx(TWEETS_STORE, 15_000, (store) => {
        for (const tweet of tweets) store.put(tweet, tweet.tweetId);
      });
    } catch (e) {
      console.warn('[xTweetStorage] saveTweets failed:', e);
    }
  },

  /**
   * Throws read failures upward (does not return partial snapshots): callers treat this as authoritative in-memory state;
   * missing keys would cause known tweets to be recreated as new tweets, overwriting persisted data with empty details.
   */
  async getAllTweets(): Promise<Map<string, XStoredTweet>> {
    const result = new Map<string, XStoredTweet>();
    if (!canUseIndexedDB()) return result;
    await runCursorTx(TWEETS_STORE, 20_000, (value) => {
      const tweet = value as XStoredTweet;
      if (tweet && typeof tweet.tweetId === 'string') result.set(tweet.tweetId, tweet);
    });
    return result;
  },

  /** Batch upsert repositories (keyed by lowercased full_name). Does not throw on write failure (does not block sync flow). */
  async saveRepos(repos: XStoredRepo[]): Promise<void> {
    if (repos.length === 0) return;
    try {
      await runWriteTx(REPOS_STORE, 15_000, (store) => {
        for (const repo of repos) store.put(repo, repo.fullName.toLowerCase());
      });
    } catch (e) {
      console.warn('[xTweetStorage] saveRepos failed:', e);
    }
  },

  /** Throws read failures upward (same as getAllTweets: does not return partial snapshots). */
  async getAllRepos(): Promise<Map<string, XStoredRepo>> {
    const result = new Map<string, XStoredRepo>();
    if (!canUseIndexedDB()) return result;
    await runCursorTx(REPOS_STORE, 15_000, (value) => {
      const repo = value as XStoredRepo;
      if (repo && typeof repo.fullName === 'string') result.set(repo.fullName.toLowerCase(), repo);
    });
    return result;
  },

  async getSyncMeta(): Promise<XTweetSyncMeta> {
    // Non-IndexedDB environment is treated as non-existent record, returning a fresh default value (independent nested objects
    // to prevent shallow-copy sharing of DEFAULT_META.pages/userIds/queryIds from causing cross-call pollution);
    // actual read failures throw upward to avoid callers misjudging cursors.
    if (!canUseIndexedDB()) return createDefaultMeta();
    const meta = await withTimeout(runGetTx<XTweetSyncMeta>(META_STORE, 5000, 'sync'), 6000);
    if (meta === undefined) return createDefaultMeta();
    return normalizeMeta(meta);
  },

  async saveSyncMeta(meta: XTweetSyncMeta): Promise<void> {
    try {
      await runWriteTx(META_STORE, 5000, (store) => {
        store.put(meta, 'sync');
      });
    } catch (e) {
      console.warn('[xTweetStorage] saveSyncMeta failed:', e);
    }
  },

  /**
   * Atomic persistence for sync batches: tweets + repos + meta (watermark/exhausted flags)
   * are written in a single cross-store readwrite transaction. If any write fails, the entire transaction rolls back and throws—callers
   * will not advance the in-memory cursor, and the next sync will re-fetch this batch of tweets, preventing gaps where watermarks advance without data persistence.
   */
  async saveSyncBatch(payload: {
    tweets: XStoredTweet[];
    repos: XStoredRepo[];
    meta: XTweetSyncMeta;
  }): Promise<void> {
    if (!canUseIndexedDB()) throw new Error('IndexedDB unavailable');
    const db = await withTimeout(openDb(), 15_000);
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([TWEETS_STORE, REPOS_STORE, META_STORE], 'readwrite');
        const timer = setTimeout(() => {
          try {
            tx.abort();
          } catch {
            // Transaction may have already finished on its own
          }
          reject(new Error('xTweetStorage timeout'));
        }, 15_000);
        let settled = false;
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn();
        };
        try {
          const tweetStore = tx.objectStore(TWEETS_STORE);
          for (const tweet of payload.tweets) tweetStore.put(tweet, tweet.tweetId);
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
   * Clear all tweet data (called by "delete discovery cache/delete all data" in settings).
   * Throws errors upward (so callers can determine whether to notify success); clears meta first so that even if subsequent
   * store cleanups fail, the sync watermark is removed and the next sync self-heals by falling back to a full rescan.
   */
  async clearAll(): Promise<void> {
    if (!canUseIndexedDB()) return;
    await runWriteTx(META_STORE, 5000, (store) => store.clear());
    await runWriteTx(TWEETS_STORE, 15_000, (store) => store.clear());
    await runWriteTx(REPOS_STORE, 15_000, (store) => store.clear());
  },
};
