/**
 * Persistence layer for the Ruan Yifeng Weekly channel (independent IndexedDB, patterned after discoveryAnalysisStorage).
 *
 * Channel discoveryRepos are session-level data and not persisted, but the weekly dataset is expensive to construct
 * (the initial full sync traverses tens of thousands of issues in ruanyf/weekly and batch-fills repo details),
 * so it is stored here to reuse across sessions, allowing refreshChannel to perform incremental syncs only.
 */

import type { GitHubRepoDetailRead } from './githubApi';

/** Submission issue matching an "open source" title with repo links in its body (cached for offline rendering of "view original post"). */
export interface WeeklyStoredIssue {
  number: number;
  title: string;
  body: string | null;
  labels: string[];
  state: 'open' | 'closed';
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  /** Repository full_name extracted from the body (lowercased key, corresponding to the repos store) */
  repoFullNames: string[];
}

/**
 * GitHub repository referenced in submissions (deduplicated by lowercased full_name, one entry per repository).
 * A null detail with non-empty lastFetchedAt indicates the repository is unavailable (deleted/private); retry upon expiration.
 */
export interface WeeklyStoredRepo {
  /** Display full_name (from the submission link or the canonical casing returned by the API) */
  fullName: string;
  detail: GitHubRepoDetailRead | null;
  lastFetchedAt: string;
  /** Original post = the issue with the latest submission timestamp */
  sourceIssueNumber: number;
  issueLabels: string[];
  issueCreatedAt: string;
}

export interface WeeklySyncMeta {
  lastSyncedAt: string | null;
  /** Deep pagination cursor: next page (1-based) consumed in full (no since) descending updated traversal */
  deepNextPage: number;
  /** Whether the full history has been completely fetched (deep traversal encountered an incomplete or empty page) */
  historyComplete: boolean;
}

const DEFAULT_META: WeeklySyncMeta = {
  lastSyncedAt: null,
  deepNextPage: 1,
  historyComplete: false,
};

const normalizeMeta = (meta: WeeklySyncMeta | null | undefined): WeeklySyncMeta => ({
  lastSyncedAt: meta?.lastSyncedAt ?? null,
  deepNextPage: typeof meta?.deepNextPage === 'number' && Number.isFinite(meta.deepNextPage) && meta.deepNextPage >= 1
    ? Math.floor(meta.deepNextPage)
    : 1,
  historyComplete: meta?.historyComplete === true,
});

const DB_NAME = 'github-stars-weekly';
const DB_VERSION = 1;
const ISSUES_STORE = 'issues';
const REPOS_STORE = 'repos';
const META_STORE = 'meta';

const canUseIndexedDB = (): boolean =>
  typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';

const openDb = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ISSUES_STORE)) db.createObjectStore(ISSUES_STORE);
      if (!db.objectStoreNames.contains(REPOS_STORE)) db.createObjectStore(REPOS_STORE);
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  const timeoutPromise = new Promise<T>((_, reject) =>
    setTimeout(() => reject(new Error('weeklyIssuesStorage timeout')), timeoutMs),
  );
  return Promise.race([promise, timeoutPromise]);
};

/**
 * Transaction timeout guard: returns a one-time settle function. When timeout occurs before settlement,
 * abort the transaction and reject (Promise.race cannot abort background transactions; explicit abort is required to release locks);
 * when complete/error/abort arrives first, clear the timer and settle only once.
 */
const guardTx = (
  tx: IDBTransaction,
  timeoutMs: number,
  reject: (reason: Error) => void,
): (() => boolean) => {
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    try {
      tx.abort();
    } catch {
      // Transaction may have already finished on its own
    }
    reject(new Error('weeklyIssuesStorage timeout'));
  }, timeoutMs);
  return () => {
    if (settled) return false;
    settled = true;
    clearTimeout(timer);
    return true;
  };
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
      const settle = guardTx(tx, timeoutMs, reject);
      try {
        execute(tx.objectStore(storeName));
      } catch (e) {
        if (settle()) reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      tx.oncomplete = () => {
        if (settle()) resolve();
      };
      tx.onerror = () => {
        if (settle()) reject(tx.error ?? new Error('transaction error'));
      };
      tx.onabort = () => {
        if (settle()) reject(tx.error ?? new Error('transaction aborted'));
      };
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
      const settle = guardTx(tx, timeoutMs, reject);
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => {
        if (settle()) resolve(req.result as T | undefined);
      };
      req.onerror = () => {
        if (settle()) reject(req.error ?? new Error('request error'));
      };
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
      const settle = guardTx(tx, timeoutMs, reject);
      const req = tx.objectStore(storeName).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          if (settle()) resolve();
          return;
        }
        try {
          visit(cursor.value, cursor.key);
        } catch (e) {
          if (settle()) reject(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        cursor.continue();
      };
      req.onerror = () => {
        if (settle()) reject(req.error ?? new Error('request error'));
      };
    });
  } finally {
    db.close();
  }
};

export const weeklyIssuesStorage = {
  /** Batch upsert issues (keyed by issue number). Does not throw on write failure (does not block sync flow). */
  async saveIssues(issues: WeeklyStoredIssue[]): Promise<void> {
    if (issues.length === 0) return;
    try {
      await runWriteTx(ISSUES_STORE, 15_000, (store) => {
        for (const issue of issues) store.put(issue, issue.number);
      });
    } catch (e) {
      console.warn('[weeklyIssuesStorage] saveIssues failed:', e);
    }
  },

  /**
   * Throws read failures upward (does not return partial snapshots): callers treat this as authoritative in-memory state;
   * missing keys would cause known entries to be recreated as new entries, overwriting persisted data with empty details.
   */
  async getAllIssues(): Promise<Map<number, WeeklyStoredIssue>> {
    const result = new Map<number, WeeklyStoredIssue>();
    if (!canUseIndexedDB()) return result;
    await runCursorTx(ISSUES_STORE, 20_000, (value) => {
      const issue = value as WeeklyStoredIssue;
      if (issue && typeof issue.number === 'number') result.set(issue.number, issue);
    });
    return result;
  },

  async getIssue(issueNumber: number): Promise<WeeklyStoredIssue | null> {
    if (!canUseIndexedDB()) return null;
    try {
      const issue = await withTimeout(runGetTx<WeeklyStoredIssue>(ISSUES_STORE, 5000, issueNumber), 6000);
      return issue ?? null;
    } catch (e) {
      console.warn('[weeklyIssuesStorage] getIssue failed:', e);
      return null;
    }
  },

  /** Batch upsert repositories (keyed by lowercased full_name). Does not throw on write failure (does not block sync flow). */
  async saveRepos(repos: WeeklyStoredRepo[]): Promise<void> {
    if (repos.length === 0) return;
    try {
      await runWriteTx(REPOS_STORE, 15_000, (store) => {
        for (const repo of repos) store.put(repo, repo.fullName.toLowerCase());
      });
    } catch (e) {
      console.warn('[weeklyIssuesStorage] saveRepos failed:', e);
    }
  },

  /** Throws read failures upward (same as getAllIssues: does not return partial snapshots). */
  async getAllRepos(): Promise<Map<string, WeeklyStoredRepo>> {
    const result = new Map<string, WeeklyStoredRepo>();
    if (!canUseIndexedDB()) return result;
    await runCursorTx(REPOS_STORE, 15_000, (value, key) => {
      const repo = value as WeeklyStoredRepo;
      if (repo && typeof repo.fullName === 'string') result.set(String(key), repo);
    });
    return result;
  },

  async getSyncMeta(): Promise<WeeklySyncMeta> {
    if (!canUseIndexedDB()) return { ...DEFAULT_META };
    try {
      const meta = await withTimeout(runGetTx<WeeklySyncMeta>(META_STORE, 5000, 'sync'), 6000);
      return normalizeMeta(meta);
    } catch (e) {
      console.warn('[weeklyIssuesStorage] getSyncMeta failed:', e);
      return { ...DEFAULT_META };
    }
  },

  async saveSyncMeta(meta: WeeklySyncMeta): Promise<void> {
    try {
      await runWriteTx(META_STORE, 5000, (store) => {
        store.put(meta, 'sync');
      });
    } catch (e) {
      console.warn('[weeklyIssuesStorage] saveSyncMeta failed:', e);
    }
  },

  /**
   * Atomic persistence for paginated traversal: issues + repos + meta (deepNextPage/historyComplete)
   * are written in a single cross-store readwrite transaction. If any write fails, the entire transaction rolls back and throws—callers
   * will not advance the in-memory cursor, and the next sync will re-fetch this page, preventing historyComplete from skipping unpersisted data.
   */
  async saveWalkPage(payload: {
    issues: WeeklyStoredIssue[];
    repos: WeeklyStoredRepo[];
    meta: WeeklySyncMeta;
  }): Promise<void> {
    if (!canUseIndexedDB()) throw new Error('IndexedDB unavailable');
    const db = await withTimeout(openDb(), 15_000);
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([ISSUES_STORE, REPOS_STORE, META_STORE], 'readwrite');
        const settle = guardTx(tx, 15_000, reject);
        try {
          const issueStore = tx.objectStore(ISSUES_STORE);
          for (const issue of payload.issues) issueStore.put(issue, issue.number);
          const repoStore = tx.objectStore(REPOS_STORE);
          for (const repo of payload.repos) repoStore.put(repo, repo.fullName.toLowerCase());
          tx.objectStore(META_STORE).put(payload.meta, 'sync');
        } catch (e) {
          if (settle()) reject(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        tx.oncomplete = () => {
          if (settle()) resolve();
        };
        tx.onerror = () => {
          if (settle()) reject(tx.error ?? new Error('transaction error'));
        };
        tx.onabort = () => {
          if (settle()) reject(tx.error ?? new Error('transaction aborted'));
        };
      });
    } finally {
      db.close();
    }
  },

  /**
   * Clear all weekly data (called by "delete discovery cache/delete all data" in settings).
   * Throws errors upward (so callers can determine whether to notify success); clears meta first so that even if subsequent
   * store cleanups fail, the sync watermark is removed and the next sync self-heals by falling back to a full rescan.
   */
  async clearAll(): Promise<void> {
    if (!canUseIndexedDB()) return;
    await runWriteTx(META_STORE, 5000, (store) => store.clear());
    await runWriteTx(ISSUES_STORE, 15_000, (store) => store.clear());
    await runWriteTx(REPOS_STORE, 15_000, (store) => store.clear());
  },
};
