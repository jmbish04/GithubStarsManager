import type { StateStorage } from 'zustand/middleware';

export const DB_NAME = 'github-stars-manager-db';
const STORE_NAME = 'app_state';
const DB_VERSION = 1;

const canUseIndexedDB = () => typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';

const withTimeout = async <T>(promise: Promise<T>, timeoutMs = 2000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('IndexedDB timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const safeLocalStorageGet = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const safeLocalStorageSet = (key: string, value: string): boolean => {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    // Quota/security errors are expected in some environments; report failure to caller.
    return false;
  }
};

const safeLocalStorageRemove = (key: string): void => {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
};

/** Set timeout only for "open database"; the transaction lifecycle itself is guaranteed to conclude via oncomplete/onabort/onerror. */
const openDb = (): Promise<IDBDatabase> => withTimeout(new Promise<IDBDatabase>((resolve, reject) => {
  const request = window.indexedDB.open(DB_NAME, DB_VERSION);

  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      db.createObjectStore(STORE_NAME);
    }
  };

  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
}), 2000);

const idbGet = async (key: string): Promise<string | null> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);

    req.onsuccess = () => resolve((req.result as string | undefined) ?? null);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error('[storage] IndexedDB read transaction aborted'));
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
};

const idbSet = async (key: string, value: string): Promise<void> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);

    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error('[storage] IndexedDB write transaction aborted'));
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
};

const idbDelete = async (key: string): Promise<void> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);

    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error('[storage] IndexedDB delete transaction aborted'));
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
};

/** Single-transaction batch write: all keys either commit together or roll back together (atomic commit point for chunked persistence). */
const idbSetMany = async (entries: ReadonlyArray<readonly [string, string]>): Promise<void> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const [key, value] of entries) {
      store.put(value, key);
    }

    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error('[storage] IndexedDB batch transaction aborted'));
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
};

/** Single connection + single readonly transaction batch read, avoiding concurrent open connections during hydration. */
const idbGetMany = async (keys: ReadonlyArray<string>): Promise<Array<string | null>> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const results: Array<string | null> = new Array(keys.length).fill(null);
    keys.forEach((key, index) => {
      const req = store.get(key);
      req.onsuccess = () => {
        results[index] = (req.result as string | undefined) ?? null;
      };
      req.onerror = () => reject(req.error);
    });

    tx.oncomplete = () => {
      db.close();
      resolve(results);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error('[storage] IndexedDB batch read transaction aborted'));
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
};

/** Check if a key exists without transferring its value, used for cheap legacy snapshot existence probes. */
const idbHasKey = async (key: string): Promise<boolean> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getKey(key);

    req.onsuccess = () => resolve(req.result !== undefined);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error('[storage] IndexedDB key probe aborted'));
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
};

/** Delete the exact key and all its derived keys (`${name}#` prefix: chunks and meta). */
const idbDeleteWithDerivedKeys = async (name: string): Promise<void> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(name);
    if (typeof IDBKeyRange !== 'undefined') {
      store.delete(IDBKeyRange.bound(`${name}#`, `${name}#\uffff`));
    }

    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error('[storage] IndexedDB delete transaction aborted'));
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
};

const safeLocalStorageRemoveByPrefix = (prefix: string): void => {
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(prefix)) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // ignore
  }
};

const safeLocalStorageRemoveWithDerivedKeys = (name: string): void => {
  safeLocalStorageRemove(name);
  safeLocalStorageRemoveByPrefix(`${name}#`);
};

/**
 * localStorage fallback authority marker: set when IndexedDB batch write fails and fallback write succeeds,
 * indicating "the latest committed values for these keys reside in localStorage, and reads must prioritize localStorage".
 * Cleared on the next successful IndexedDB write once localStorage no longer holds any derived data keys
 * (retained if any remain, preventing stale IndexedDB values from shadowing newer data). Without this marker,
 * reads would continue to prioritize stale values in IndexedDB, preventing new values in localStorage from taking effect (silent state rollback).
 */
const fallbackMarkerKey = (name: string): string => `${name}#fallback`;

const isFallbackAuthoritative = (name: string): boolean =>
  safeLocalStorageGet(fallbackMarkerKey(name)) !== null;

/**
 * Whether localStorage still holds derived data keys for this name (excluding the authority marker itself).
 * If checking fails, treated as "still present" (fail-safe): retains the marker to prevent stale values in IndexedDB
 * from shadowing new values in localStorage on next hydration.
 */
const hasFallbackDerivedKeys = (name: string): boolean => {
  const marker = fallbackMarkerKey(name);
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key !== marker && key.startsWith(`${name}#`)) return true;
    }
  } catch {
    return true;
  }
  return false;
};

/**
 * localStorage fallback write: all-or-nothing semantics; failure on any key rolls back the entire batch and throws.
 * Rollback restores previous values for each key before the write (rather than simply removing)—chunk keys in a batch
 * often already hold data from the previous commit, and deleting them would cause metadata still referencing them to misidentify missing chunks on next hydration.
 * Upon success: sets authority marker and makes a best-effort deletion of corresponding stale IndexedDB keys (defense-in-depth against stale IndexedDB shadowing).
 */
export const writeEntriesToFallbackStorage = async (
  name: string,
  entries: ReadonlyArray<readonly [string, string]>,
): Promise<void> => {
  const written: Array<readonly [string, string | null]> = [];
  try {
    for (const [key, value] of entries) {
      const previous = safeLocalStorageGet(key);
      if (!safeLocalStorageSet(key, value)) {
        throw new Error('[storage] localStorage fallback write failed');
      }
      written.push([key, previous]);
    }
  } catch (error) {
    const unrestorable: string[] = [];
    for (let i = written.length - 1; i >= 0; i--) {
      const [key, previous] = written[i];
      const restored = previous === null
        ? (safeLocalStorageRemove(key), true)
        : safeLocalStorageSet(key, previous);
      if (!restored) {
        unrestorable.push(key);
      }
    }
    if (unrestorable.length > 0) {
      console.warn('[storage] fallback rollback could not restore keys:', unrestorable);
    }
    throw error;
  }

  if (!safeLocalStorageSet(fallbackMarkerKey(name), new Date().toISOString())) {
    console.warn('[storage] failed to mark localStorage as fallback authority;');
  }
  if (canUseIndexedDB()) {
    for (const [key] of entries) {
      try {
        await idbDelete(key);
      } catch (error) {
        console.warn('[storage] failed to invalidate stale IndexedDB key after fallback:', key, error);
      }
    }
  }
};

/**
 * Batch write multiple keys within a single IndexedDB transaction (commit point for chunked persistence).
 * - When IndexedDB is available: a single readwrite transaction holds all chunks and metadata, inherently atomic—
 *   failure of any chunk write rolls back the entire batch, keeping previous snapshots intact without torn states.
 *   Transactions do not use timeouts: timeouts cannot cancel an already started transaction, and concurrent late commits
 *   alongside localStorage fallback would cause double-writes; transaction convergence is guaranteed by oncomplete/onabort/onerror.
 * - When IndexedDB is unavailable or write fails: falls back to localStorage and sets authority marker
 *   (see writeEntriesToFallbackStorage).
 */
export const setStorageEntries = async (
  name: string,
  entries: ReadonlyArray<readonly [string, string]>,
): Promise<void> => {
  if (typeof window === 'undefined') return;
  if (entries.length === 0) return;

  if (canUseIndexedDB()) {
    try {
      await idbSetMany(entries);
      for (const [key] of entries) {
        safeLocalStorageRemove(key);
      }
      // Clear the authority marker only when localStorage no longer holds any derived data keys: chunk writes only
      // commit dirty chunks, so earlier fallback chunks may still exist only in localStorage (best-effort deletion
      // of stale IDB keys during fallback may have failed); clearing prematurely would allow stale IDB values to shadow new data on next hydration.
      if (!hasFallbackDerivedKeys(name)) {
        safeLocalStorageRemove(fallbackMarkerKey(name));
      }
      return;
    } catch (error) {
      console.warn('[storage] IndexedDB batch set failed, fallback to localStorage:', error);
    }
  }

  await writeEntriesToFallbackStorage(name, entries);
};

/**
 * Strict read: throws on read failure (IndexedDB open failure / transaction error) instead of silently degrading—
 * callers must distinguish between "key does not exist" and "temporarily unreadable", as the latter must never overwrite data as empty.
 * Read priority: when localStorage fallback authority marker is set, localStorage takes precedence; otherwise
 * IndexedDB takes precedence, falling back to localStorage if missing (covering post-fallback write scenarios).
 */
export const getStorageItemStrict = async (name: string, key: string): Promise<string | null> => {
  if (typeof window === 'undefined') return null;
  if (!canUseIndexedDB()) return safeLocalStorageGet(key);

  const idbValue = await idbGet(key);
  if (idbValue !== null) {
    return isFallbackAuthoritative(name) ? (safeLocalStorageGet(key) ?? idbValue) : idbValue;
  }
  return safeLocalStorageGet(key);
};

/** Batch strict read: any read failure throws for the entire batch (single connection, single transaction to minimize timeout/failure windows). */
export const getStorageEntriesStrict = async (
  name: string,
  keys: ReadonlyArray<string>,
): Promise<Array<string | null>> => {
  if (typeof window === 'undefined') return keys.map(() => null);
  if (!canUseIndexedDB()) {
    return keys.map((key) => safeLocalStorageGet(key));
  }

  const results = await idbGetMany(keys);
  if (isFallbackAuthoritative(name)) {
    return keys.map((key, index) => safeLocalStorageGet(key) ?? results[index]);
  }
  // Consistent with single-key strict read: fall back to localStorage on IDB miss. Stale IDB keys deleted
  // on a best-effort basis during fallback may still be missing after clearing the authority marker (subsequent IDB batches only write back dirty chunks),
  // and omitting fallback would misclassify "key in localStorage" as "missing chunk".
  return keys.map((key, index) => results[index] ?? safeLocalStorageGet(key));
};

/** Cheap probe for whether legacy single-key snapshot still exists (without reading the value itself). */
export const hasLegacySnapshot = async (name: string): Promise<boolean> => {
  if (typeof window === 'undefined') return false;
  if (safeLocalStorageGet(name) !== null) return true;
  if (!canUseIndexedDB()) return false;
  try {
    return await idbHasKey(name);
  } catch {
    return false;
  }
};

/**
 * Delete only legacy single-key snapshot (excluding chunks / derived keys).
 * Called by persistence layer after chunk migration completes to reclaim space occupied by legacy snapshots;
 * differs from removeItem (which cleans up derived keys as well) to avoid accidentally wiping freshly committed chunks.
 */
export const removeLegacySnapshot = async (name: string): Promise<void> => {
  if (typeof window === 'undefined') return;

  safeLocalStorageRemove(name);

  if (!canUseIndexedDB()) return;

  try {
    await idbDelete(name);
  } catch (error) {
    console.warn('[storage] IndexedDB legacy snapshot remove failed:', error);
  }
};

/**
 * IndexedDB-backed Zustand persist storage with seamless migration:
 * - First read from IndexedDB
 * - If empty, migrate an existing localStorage snapshot to IndexedDB and then remove it
 * - Normal writes go to IndexedDB and clear any legacy localStorage snapshot.
 * - localStorage is only kept as the current snapshot when IndexedDB is unavailable or a write fails.
 *   This avoids stale fallback rollbacks while preserving persistence in constrained environments.
 * - removeItem also sweeps the derived sharding keys (`${name}#...`) so data-management
 *   wipes and test resets remove every persisted trace of the app.
 */
export const indexedDBStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    if (typeof window === 'undefined') return null;

    // Hard fallback for environments without IndexedDB
    if (!canUseIndexedDB()) {
      return safeLocalStorageGet(name);
    }

    try {
      const idbValue = await idbGet(name);
      if (idbValue !== null) return idbValue;

      // Migration path: restore existing localStorage snapshot into IndexedDB
      const legacyValue = safeLocalStorageGet(name);
      if (legacyValue !== null) {
        await idbSet(name, legacyValue);
        safeLocalStorageRemove(name);
        console.info('[storage] migrated state from localStorage to IndexedDB');
      }
      return legacyValue;
    } catch (error) {
      console.warn('[storage] IndexedDB get failed, fallback to localStorage:', error);
      return safeLocalStorageGet(name);
    }
  },

  setItem: async (name: string, value: string): Promise<void> => {
    if (typeof window === 'undefined') return;

    // Primary path: IndexedDB first (large data friendly)
    if (canUseIndexedDB()) {
      try {
        await idbSet(name, value);
        safeLocalStorageRemove(name);
        return;
      } catch (error) {
        console.warn('[storage] IndexedDB set failed, fallback to localStorage:', error);
      }
    }

    if (!safeLocalStorageSet(name, value)) {
      throw new Error('[storage] localStorage fallback write failed');
    }
  },

  removeItem: async (name: string): Promise<void> => {
    if (typeof window === 'undefined') return;

    safeLocalStorageRemoveWithDerivedKeys(name);

    if (!canUseIndexedDB()) return;

    // Throw deletion errors faithfully: orphaned chunks/meta would resurrect after reload; callers like
    // "clear data" must observe failures rather than proceeding as if an incomplete deletion succeeded.
    await idbDeleteWithDerivedKeys(name);
  },
};
