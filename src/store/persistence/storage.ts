
import type { PersistStorage, StorageValue } from 'zustand/middleware';
import {
  getStorageEntriesStrict,
  getStorageItemStrict,
  hasLegacySnapshot,
  indexedDBStorage,
  removeLegacySnapshot,
  setStorageEntries,
} from '../../services/indexedDbStorage';
import { logger } from '../../services/logger';
import {
  PERSISTENCE_SHARD_FORMAT,
  PERSISTENCE_SHARD_NAMES,
  buildShardViews,
  findDirtyShards,
  metaKeyFor,
  shardKeyFor,
  type PersistenceShardName,
  type ShardMeta,
  type ShardPayload,
} from './shards';

const scheduleIdleTask = (callback: () => void): number => {
  if (typeof window === 'undefined') {
    return setTimeout(callback, 0) as unknown as number;
  }

  if ('requestIdleCallback' in window) {
    return window.requestIdleCallback(callback, { timeout: idleCallbackTimeoutMs });
  }

  return globalThis.setTimeout(callback, 0) as unknown as number;
};

const cancelIdleTask = (id: number): void => {
  if (typeof window !== 'undefined' && 'cancelIdleCallback' in window) {
    window.cancelIdleCallback(id);
    return;
  }

  clearTimeout(id);
};

let persistTimeoutId: ReturnType<typeof setTimeout> | null = null;
let persistIdleTaskId: number | null = null;
let latestPersistName: string | null = null;
let latestPersistValue: StorageValue<unknown> | null = null;
let persistWriteVersion = 0;
let persistFlushListenersRegistered = false;

// In-session bookkeeping for sharded persistence:
// - lastWrittenShards tracks the field references of each shard from the last successful write as the dirty-check baseline;
// - committedShards tracks shards successfully committed in this session, used to determine when the legacy single-key snapshot can be retired;
// - legacySnapshotHydrated indicates this session hydrated from an old single-key snapshot (or partial shards + legacy snapshot fallback);
//   the next write will force-commit all shards to complete migration in one shot and retire the old key;
// - hydratedIncomplete indicates the latest hydration had read failures (IDB failure/timeout). At this point the hydration
//   result is incomplete, and disk writes must be refused—otherwise default values would overwrite still-intact shards on disk.
// Known trade-offs (multi-tab/multi-window): The dirty-check baseline is the snapshot each tab hydrated with, unaware of other tabs;
// when one tab clears data and another tab performs a partial write, it could produce "meta declares all shards + some shards missing",
// which the reader handles via merged/best-effort fallback paths. Compared to the old single-key full snapshot LWW, the tearing window
// is smaller but still exists; cross-tab arbitration (BroadcastChannel/versioning) is left as a follow-up.
type ShardViews = Record<PersistenceShardName, Record<string, unknown>>;
let lastWrittenShards: ShardViews | null = null;
const committedShards = new Set<PersistenceShardName>();
let legacySnapshotHydrated = false;
let hydratedIncomplete = false;

// Idle large shard write throttling:
// - SHARD_SIZE_WARN_BYTES: Threshold for classifying a shard as large (shared with "Large state shard serialized" warning),
//   based on the serialized size from the shard's last successful write;
// - LARGE_SHARD_IDLE_WRITE_MIN_INTERVAL_MS: Minimum interval between two idle writes of the same large shard.
// Full stringify/write overhead for large shards is substantial (benchmarked 130-540ms for a single 140MB shard stringify).
// Repeatedly triggering this during idle periods causes ongoing main-thread overhead, so a minimum interval is enforced for idle writes touching large shards.
// Throttling only defers without dropping: idle write requests during cooldown retain the latest pending values in
// latestPersistValue/persistWriteVersion and coalesce into a single final write once cooldown expires;
// non-idle flush sources (pagehide/visibilitychange) bypass throttling and write immediately.
const SHARD_SIZE_WARN_BYTES = 5 * 1024 * 1024;
// Timing parameters are mutable: default values represent production behavior; tests inject
// smaller values via __setPersistTimingsForTest to deterministically verify throttling timings with real timers (fake timers
// interleaved with fake-indexeddb macrotasks are unstable in slow CI environments).
let largeShardIdleWriteMinIntervalMs = 60_000;
let persistDebounceMs = 1000;
let idleCallbackTimeoutMs = 3000;
const lastWrittenShardBytes = new Map<PersistenceShardName, number>();
const lastShardWriteAt = new Map<PersistenceShardName, number>();
let deferredLargeShardWriteTimerId: ReturnType<typeof setTimeout> | null = null;

/**
 * Test-only hook to inject smaller timing parameters (write debounce / idle callback timeout / large shard idle write
 * min interval). Does not change semantics, only shortens waits; tests must restore defaults when done.
 */
export function __setPersistTimingsForTest(timings: {
  debounceMs?: number;
  idleTimeoutMs?: number;
  largeShardIdleMinIntervalMs?: number;
}): void {
  if (timings.debounceMs !== undefined) persistDebounceMs = timings.debounceMs;
  if (timings.idleTimeoutMs !== undefined) idleCallbackTimeoutMs = timings.idleTimeoutMs;
  if (timings.largeShardIdleMinIntervalMs !== undefined) largeShardIdleWriteMinIntervalMs = timings.largeShardIdleMinIntervalMs;
}

const emptyShardViews = (): ShardViews => {
  const views = {} as ShardViews;
  for (const shard of PERSISTENCE_SHARD_NAMES) {
    views[shard] = {};
  }
  return views;
};

const cancelPendingPersistTasks = (): void => {
  if (persistTimeoutId) {
    clearTimeout(persistTimeoutId);
    persistTimeoutId = null;
  }

  if (persistIdleTaskId !== null) {
    cancelIdleTask(persistIdleTaskId);
    persistIdleTaskId = null;
  }

  if (deferredLargeShardWriteTimerId !== null) {
    clearTimeout(deferredLargeShardWriteTimerId);
    deferredLargeShardWriteTimerId = null;
  }
};

const parseShardPayload = (raw: string | null): { state: Record<string, unknown>; version: number } | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ShardPayload | null;
    if (!parsed || parsed.format !== PERSISTENCE_SHARD_FORMAT || !parsed.state
      || typeof parsed.state !== 'object') {
      return null;
    }
    return { state: parsed.state, version: typeof parsed.version === 'number' ? parsed.version : 0 };
  } catch {
    return null;
  }
};

/**
 * meta is the catalog of the sharded layout and must be treated as untrusted input:
 * - Shard names must be known shards, and the set must exactly match PERSISTENCE_SHARD_NAMES (no missing,
 *   no duplicate, no unknown entries). An incomplete meta would cause fields to silently disappear while being treated
 *   as "all shards present", prematurely retiring the only fallback (legacy single-key snapshot).
 * - Read failures of meta itself (IDB failure/timeout) are distinguished and handled by callers.
 */
const parseMeta = (raw: string | null): ShardMeta | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ShardMeta | null;
    if (!parsed || parsed.format !== PERSISTENCE_SHARD_FORMAT
      || typeof parsed.version !== 'number'
      || !Array.isArray(parsed.shards)
      || parsed.shards.length !== PERSISTENCE_SHARD_NAMES.length
      || !PERSISTENCE_SHARD_NAMES.every((shard) => parsed.shards.includes(shard))) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const readLegacySnapshot = async (
  name: string,
): Promise<StorageValue<unknown> | null> => {
  const raw = await getStorageItemStrict(name, name);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StorageValue<unknown>;
  } catch {
    return null;
  }
};

/** Salvage when meta is missing/corrupted: read parseable shard payloads directly by known shard names. */
const salvageOrphanedShards = async (name: string): Promise<{
  parts: Record<string, unknown> | null;
  version: number | null;
  readFailed: boolean;
  foundButUnreadable: boolean;
}> => {
  const keys = PERSISTENCE_SHARD_NAMES.map((shard) => shardKeyFor(name, shard));
  let results: Array<string | null>;
  try {
    results = await getStorageEntriesStrict(name, keys);
  } catch (error) {
    logger.errorFromError('store.persist', 'Failed to salvage orphaned persistence shards', error);
    return { parts: null, version: null, readFailed: true, foundButUnreadable: false };
  }

  const parts: Record<string, unknown> = {};
  let version: number | null = null;
  let foundButUnreadable = false;
  PERSISTENCE_SHARD_NAMES.forEach((_shard, index) => {
    const parsed = parseShardPayload(results[index]);
    if (results[index] !== null && !parsed) {
      foundButUnreadable = true;
    }
    if (!parsed) return;
    Object.assign(parts, parsed.state);
    version = version ?? parsed.version;
  });
  return {
    parts: Object.keys(parts).length > 0 ? parts : null,
    version,
    readFailed: false,
    foundButUnreadable,
  };
};

/**
 * Reads the persisted snapshot.
 *
 * Read precedence (guarantees seamless upgrade and zero historical data loss):
 * 1. meta (exact shard set) + all shards present → assemble new format snapshot;
 * 2. meta present but some shards missing/corrupted → merge existing shard contents with legacy single-key snapshot
 *    (shards were committed later than the legacy snapshot, representing the latest known state for each field);
 * 3. meta missing/corrupted/incomplete → fallback to legacy single-key snapshot (v16 behavior, used on first launch after upgrade);
 * 4. legacy also missing → salvage orphaned shards by known shard names (meta cleared/corrupted but shards still intact);
 * 5. Any "read failure" (as distinct from "confirmed non-existent") sets hydratedIncomplete,
 *    subsequently refusing disk writes to prevent incomplete hydration results from overwriting real data on disk.
 */
const readPersistedSnapshot = async (
  name: string,
): Promise<StorageValue<unknown> | null> => {
  let readFailed = false;

  let meta: ShardMeta | null = null;
  try {
    meta = parseMeta(await getStorageItemStrict(name, metaKeyFor(name)));
  } catch (error) {
    readFailed = true;
    logger.errorFromError('store.persist', 'Failed to read persistence meta', error);
  }

  if (!meta) {
    const legacy = await readLegacySnapshot(name).catch(() => {
      readFailed = true;
      return null;
    });
    if (legacy && legacy.state && typeof legacy.state === 'object') {
      // meta unreadable but legacy single-key snapshot readable: rely on legacy (complete snapshot, safe for full write).
      legacySnapshotHydrated = true;
      lastWrittenShards = buildShardViews(legacy.state as Record<string, unknown>);
      hydratedIncomplete = false;
      return legacy;
    }

    // legacy does not exist: salvage orphaned shards (meta key lost/corrupted but shards readable).
    const salvage = await salvageOrphanedShards(name);
    if (salvage.readFailed) readFailed = true;
    if (salvage.parts) {
      logger.errorFromError(
        'store.persist',
        'Persistence meta missing but shards are readable; recovering from orphaned shards',
        new Error('meta missing'),
      );
      // Leave baseline empty: next write rebuilds everything (including self-healing meta); salvaged content will be written back.
      lastWrittenShards = null;
      hydratedIncomplete = false;
      return { state: salvage.parts, version: salvage.version ?? 0 };
    }
    if (readFailed || salvage.foundButUnreadable) {
      // Persisted data exists on disk but is currently unreadable: refuse to hydrate with empty state (subsequent writes would overwrite real data).
      hydratedIncomplete = true;
      logger.errorFromError(
        'store.persist',
        'Persisted data exists but cannot be read; refusing to hydrate and overwrite',
        new Error('meta and shards unreadable'),
      );
      return null;
    }
    return null;
  }

  let shardResults: Array<string | null>;
  try {
    shardResults = await getStorageEntriesStrict(
      name,
      PERSISTENCE_SHARD_NAMES.map((shard) => shardKeyFor(name, shard)),
    );
  } catch (error) {
    readFailed = true;
    logger.errorFromError('store.persist', 'Failed to read persistence shards', error);
    shardResults = PERSISTENCE_SHARD_NAMES.map(() => null);
  }

  const parts: Record<string, unknown> = {};
  const views = emptyShardViews();
  const missing: PersistenceShardName[] = [];
  PERSISTENCE_SHARD_NAMES.forEach((shard, index) => {
    const parsed = parseShardPayload(shardResults[index]);
    if (!parsed) {
      missing.push(shard);
      return;
    }
    Object.assign(parts, parsed.state);
    views[shard] = parsed.state;
  });

  if (missing.length === 0 && !readFailed) {
    lastWrittenShards = views;
    // All shards present and read successfully: legacy single-key snapshot has served its purpose; retire only when confirmed present (idempotent, cheap).
    if (await hasLegacySnapshot(name)) {
      void Promise.resolve(removeLegacySnapshot(name)).catch(() => undefined);
    }
    return { state: parts, version: meta.version };
  }

  if (readFailed) {
    logger.warn('store.persist', 'Some persistence shards failed to read; merge degraded', {
      missing,
    });
  } else {
    logger.warn('store.persist', 'Some persistence shards are missing; merging with legacy snapshot', {
      missing,
      shards: meta.shards,
    });
  }

  const legacy = await readLegacySnapshot(name).catch(() => {
    readFailed = true;
    return null;
  });
  if (!legacy || !legacy.state || typeof legacy.state !== 'object') {
    // No legacy snapshot available for fallback (extreme case: shards cleared externally); return readable shards best-effort, treating missing fields as empty.
    logger.errorFromError(
      'store.persist',
      'Persistence shards missing and no legacy snapshot available; hydrating best-effort',
      new Error(`missing shards: ${missing.join(', ')}`),
    );
    lastWrittenShards = views;
    hydratedIncomplete = readFailed;
    return { state: parts, version: meta.version };
  }

  // Use legacy snapshot as base and overlay existing shards: each field takes the latest known state, avoiding full reversion to stale data.
  const legacyState = legacy.state as Record<string, unknown>;
  const legacyViews = buildShardViews(legacyState);
  const mergedState: Record<string, unknown> = { ...legacyState, ...parts };
  PERSISTENCE_SHARD_NAMES.forEach((shard, index) => {
    const parsed = parseShardPayload(shardResults[index]);
    views[shard] = parsed?.state ?? legacyViews[shard];
  });
  lastWrittenShards = views;
  legacySnapshotHydrated = true;
  hydratedIncomplete = readFailed;
  return { state: mergedState, version: meta.version };
};

const writeShardedSnapshot = async (
  name: string,
  value: StorageValue<unknown>,
  writeVersion: number,
  source: 'idle' | 'flush',
  shardFilter?: ReadonlyArray<PersistenceShardName>,
): Promise<void> => {
  if (latestPersistValue === null || latestPersistName !== name || persistWriteVersion !== writeVersion) {
    return;
  }

  if (hydratedIncomplete) {
    // Last hydration suffered read failure: hydration result is incomplete, and writing to disk would overwrite
    // still-intact shards with default values. Refuse writes until the next successful complete read.
    logger.errorFromError(
      'store.persist',
      'Skipping persist write: last hydration was incomplete; refusing to overwrite',
      new Error('hydrated incomplete'),
      { source },
    );
    return;
  }

  // The version in payload must be the persist version (which drives migrate on hydration);
  // writeVersion is only used to discard stale write schedules.
  const persistVersion = typeof value.version === 'number' ? value.version : 0;
  const state = (value.state ?? {}) as Record<string, unknown>;
  const views = buildShardViews(state);
  // For sessions hydrated from a legacy snapshot: force-commit all shards on first write, after which the legacy key can be retired.
  let dirty = legacySnapshotHydrated
    ? [...PERSISTENCE_SHARD_NAMES]
    : findDirtyShards(views, lastWrittenShards);
  if (shardFilter) {
    const allowed = new Set(shardFilter);
    dirty = dirty.filter((shard) => allowed.has(shard));
  }
  if (source === 'idle') {
    // Re-check cooldown against latest commit time when write actually executes: in-flight writes might have
    // committed between dispatch and execution (so large shard cooldown hasn't elapsed). Skipped shards are deferred
    // to post-cooldown dispatch (reading latest module-level values at that time); no data is lost.
    let stillCoolingMs = 0;
    dirty = dirty.filter((shard) => {
      const remaining = cooldownRemainingMsFor(shard);
      if (remaining > stillCoolingMs) stillCoolingMs = remaining;
      return remaining === 0;
    });
    if (stillCoolingMs > 0) armDeferredLargeShardWrite(stillCoolingMs);
  }
  if (dirty.length === 0) return;

  const entries: Array<readonly [string, string]> = [];
  const serializedBytes = new Map<PersistenceShardName, number>();
  // serialized.length is the UTF-16 code unit count; with CJK/emoji and other multi-byte characters, UTF-8 byte count
  // is larger (up to 3x), while UTF-8 byte count is always >= code unit count. Thus if code unit count already reaches the threshold,
  // we can conclude immediately; only below threshold do we use TextEncoder for exact byte count (upper bound 3x threshold, bounded cost)—
  // avoiding creating a full byte copy for ~140MB shards.
  const byteLengthOf = (serialized: string): number => {
    if (serialized.length >= SHARD_SIZE_WARN_BYTES) return serialized.length;
    return new TextEncoder().encode(serialized).length;
  };
  try {
    for (const shard of dirty) {
      const stringifyStartedAt = performance.now();
      const payload: ShardPayload = {
        format: PERSISTENCE_SHARD_FORMAT,
        version: persistVersion,
        state: views[shard],
      };
      const serialized = JSON.stringify(payload);
      const byteLength = byteLengthOf(serialized);
      serializedBytes.set(shard, byteLength);
      const stringifyMs = Math.round(performance.now() - stringifyStartedAt);
      if (stringifyMs > 50) {
        logger.warn('store.persist', 'Large state stringify completed', {
          source,
          shard,
          stringifyMs,
          bytes: byteLength,
        });
      } else if (byteLength > SHARD_SIZE_WARN_BYTES) {
        logger.warn('store.persist', 'Large state shard serialized', {
          source,
          shard,
          bytes: byteLength,
        });
      }
      entries.push([shardKeyFor(name, shard), serialized]);
    }
    const meta: ShardMeta = {
      format: PERSISTENCE_SHARD_FORMAT,
      version: persistVersion,
      shards: [...PERSISTENCE_SHARD_NAMES],
      savedAt: new Date().toISOString(),
    };
    entries.push([metaKeyFor(name), JSON.stringify(meta)]);
  } catch (e) {
    logger.errorFromError('store.persist', 'Failed to stringify state for persistence', e);
    return;
  }

  const writeStartedAt = performance.now();
  try {
    await setStorageEntries(name, entries);
  } catch (error) {
    // Commit failed (atomic rollback): previous snapshot preserved intact with zero data loss, retrying on next change.
    logger.errorFromError('store.persist', 'Sharded persist write failed; previous snapshot kept', error, {
      source,
      shards: dirty,
    });
    return;
  }
  const writeMs = Math.round(performance.now() - writeStartedAt);
  if (writeMs > 50) {
    logger.warn('store.persist', 'Large state IndexedDB write completed', {
      source,
      shards: dirty,
      writeMs,
    });
  }

  // Even if a newer schedule occurred during this write (stale version), what landed on disk is this batch;
  // the dirty cache must accurately reflect disk state. Newer writes queued behind this batch will re-evaluate against this baseline.
  const writeCompletedAt = Date.now();
  const nextCache: ShardViews = { ...(lastWrittenShards ?? emptyShardViews()) };
  for (const shard of dirty) {
    nextCache[shard] = views[shard];
    committedShards.add(shard);
    // Record serialized size and commit timestamp for this shard as the baseline for idle write throttling (dispatchIdleShardedWrite);
    // failed/skipped write paths do not reach here, so cooldown is not triggered by failed writes.
    const bytes = serializedBytes.get(shard);
    if (bytes !== undefined) lastWrittenShardBytes.set(shard, bytes);
    lastShardWriteAt.set(shard, writeCompletedAt);
  }
  lastWrittenShards = nextCache;

  // Only after all shards have been successfully committed at least once can the legacy single-key snapshot be safely retired (ensuring fallback availability).
  if (legacySnapshotHydrated && PERSISTENCE_SHARD_NAMES.every((shard) => committedShards.has(shard))) {
    legacySnapshotHydrated = false;
    logger.info('store.persist', 'Legacy single-key snapshot retired after sharded migration');
    await removeLegacySnapshot(name);
  }
};

let writeChain: Promise<void> = Promise.resolve();

/**
 * Serializes sharded writes: dirty checks must be based on the cache from the last completed write (lastWrittenShards).
 * Idle writes and flush writes can overlap; if executed concurrently, later writes would evaluate against an outdated baseline
 * and skip disk writes, leaving stale state on disk without the cache realizing it.
 */
const enqueueShardedWrite = (
  name: string,
  value: StorageValue<unknown>,
  writeVersion: number,
  source: 'idle' | 'flush',
  shardFilter?: ReadonlyArray<PersistenceShardName>,
): Promise<void> => {
  // Catch-all at chain tail: writeChain never rejects, so callers (void idle schedules,
  // sync pagehide event handlers) will not encounter unhandled rejections.
  writeChain = writeChain
    .catch(() => undefined)
    .then(() => writeShardedSnapshot(name, value, writeVersion, source, shardFilter))
    .catch((error: unknown) => {
      logger.errorFromError('store.persist', 'Persist write chain failed', error, { source });
    });
  return writeChain;
};

/**
 * Remaining cooldown duration for a large shard; returns 0 if not a large shard or never written (no cooldown).
 */
const cooldownRemainingMsFor = (shard: PersistenceShardName): number => {
  if ((lastWrittenShardBytes.get(shard) ?? 0) <= SHARD_SIZE_WARN_BYTES) return 0;
  const lastWriteAt = lastShardWriteAt.get(shard);
  if (lastWriteAt === undefined) return 0;
  return Math.max(0, largeShardIdleWriteMinIntervalMs - (Date.now() - lastWriteAt));
};

/** Re-dispatch after cooldown expires (reads latest module-level values, coalescing into a single final write). */
const armDeferredLargeShardWrite = (remainingMs: number): void => {
  if (remainingMs <= 0) return;
  if (deferredLargeShardWriteTimerId !== null) {
    clearTimeout(deferredLargeShardWriteTimerId);
  }
  deferredLargeShardWriteTimerId = setTimeout(() => {
    deferredLargeShardWriteTimerId = null;
    dispatchIdleShardedWrite();
  }, remainingMs);
};

/**
 * Unified dispatch point for idle writes (including large shard throttling):
 *
 * - First computes dirty shards based on latest pending values. This is only used for throttling decisions; authoritative
 *   dirty checks still occur during writeShardedSnapshot. Any misjudgment here at most causes waiting one extra/fewer cooldown cycle,
 *   never compromising on-disk data correctness.
 * - Cannot drop write even if dirty shards are empty: in-flight uncommitted writes may still exist in write chain,
 *   so lastWrittenShards remains the old baseline—if the latest value happens to match the old baseline (reverting to
 *   old value), an early return would allow the in-flight new value to overwrite and lose that revert.
 *   Enqueue normally, and let the write chain re-evaluate against the latest baseline at commit time (naturally skipping if truly unchanged).
 * - Cooldown only defers the cooling large shards: dirty shards are partitioned by cooldown; non-cooling shards (including small shards
 *   like core) are enqueued immediately, while cooling large shards are re-dispatched via timer once cooldown expires.
 *   If the entire batch were deferred, small shard changes would also be blocked for up to a full cooldown cycle, risking data loss on abnormal exit.
 * - Re-enters this function when cooldown expires, re-evaluating dirty state against latest values before writing—guaranteeing that
 *   what lands on disk is always the latest scheduledVersion.
 */
const dispatchIdleShardedWrite = (): void => {
  if (latestPersistName === null || latestPersistValue === null) return;

  const views = buildShardViews((latestPersistValue.state ?? {}) as Record<string, unknown>);
  const dirty = legacySnapshotHydrated
    ? [...PERSISTENCE_SHARD_NAMES]
    : findDirtyShards(views, lastWrittenShards);
  if (dirty.length === 0) {
    void enqueueShardedWrite(latestPersistName, latestPersistValue, persistWriteVersion, 'idle');
    return;
  }

  // Cooldown only defers the cooling large shards: dirty shards are partitioned by cooldown; non-cooling shards (including small shards
  // like core) are enqueued immediately, while cooling large shards are re-dispatched via timer once cooldown expires.
  // If the entire batch were deferred, small shard changes would also be blocked for up to a full cooldown cycle, risking data loss on abnormal exit.
  let maxCoolingRemainingMs = 0;
  const eligible = dirty.filter((shard) => {
    const remaining = cooldownRemainingMsFor(shard);
    if (remaining > maxCoolingRemainingMs) maxCoolingRemainingMs = remaining;
    return remaining === 0;
  });
  if (eligible.length > 0) {
    void enqueueShardedWrite(latestPersistName, latestPersistValue, persistWriteVersion, 'idle', eligible);
  }
  if (maxCoolingRemainingMs > 0) {
    armDeferredLargeShardWrite(maxCoolingRemainingMs);
  }
};

const flushPendingPersistSnapshot = (): Promise<void> => {
  if (latestPersistName === null || latestPersistValue === null) return Promise.resolve();

  cancelPendingPersistTasks();
  const name = latestPersistName;
  const value = latestPersistValue;
  const scheduledVersion = persistWriteVersion;
  return enqueueShardedWrite(name, value, scheduledVersion, 'flush');
};

const registerPersistFlushListeners = (): void => {
  if (persistFlushListenersRegistered || typeof window === 'undefined') return;
  persistFlushListenersRegistered = true;

  window.addEventListener('pagehide', flushPendingPersistSnapshot);
  window.addEventListener('beforeunload', flushPendingPersistSnapshot);

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        flushPendingPersistSnapshot();
      }
    });
  }
};

/**
 * Clears persisted snapshots (including `${name}#` derived keys), returning a Promise spanning the entire serial chain:
 * Queued writes complete first, followed by storage clear, and finally resets dirty-check bookkeeping (including deletion failure paths).
 * Deletion and persistence share the same serialization chain—if reset happened on clear dispatch, in-flight writes would repopulate
 * the cache on completion, causing the first post-clear write to only rewrite dirty shards while meta still lists all shards, resulting in missing shards on restart.
 *
 * Failure semantics: The shared write chain never rejects (subsequent writes are not penalized by deletion failures), but the Promise
 * returned to the caller rejects truthfully on deletion failure—the "clear all data" flow uses this to skip state reset and
 * reload, rather than treating lingering snapshots as deleted and resurrecting data after restart.
 *
 * Note: zustand v4's persist.clearStorage() does not propagate the removeItem Promise;
 * callers needing to await true disk deletion should directly invoke and await this function.
 */
const removePersistedSnapshot = (name: string): Promise<void> => {
  latestPersistName = null;
  latestPersistValue = null;
  persistWriteVersion++;
  cancelPendingPersistTasks();
  const removal = writeChain
    .catch(() => undefined)
    .then(() => indexedDBStorage.removeItem(name));
  writeChain = removal
    .catch((error: unknown) => {
      logger.errorFromError('store.persist', 'Failed to remove persisted state snapshot', error);
    })
    .then(() => {
      lastWrittenShards = null;
      committedShards.clear();
      legacySnapshotHydrated = false;
      hydratedIncomplete = false;
      // Reset throttle bookkeeping as well: first write after clear must not be delayed by prior session's large shard cooldown
      lastWrittenShardBytes.clear();
      lastShardWriteAt.clear();
    });
  return removal.then(() => writeChain);
};

// Create a debounced storage to avoid frequent JSON.stringify calls on large state objects
// which causes V8 JIT assertion failures (EXC_BREAKPOINT) on macOS ARM64.
//
// Since the sharded layout, each flush only stringifies and rewrites the shards whose
// persisted fields actually changed (reference-dirty check) — a trivial UI change now
// costs a few KB instead of re-serializing the whole ~100MB snapshot.
//
// Idle writes that would touch a large shard (last serialized size over
// SHARD_SIZE_WARN_BYTES) are additionally throttled to at most one write per
// LARGE_SHARD_IDLE_WRITE_MIN_INTERVAL_MS; flush sources bypass the throttle
// (see dispatchIdleShardedWrite).
const debouncedPersistStorage: PersistStorage<unknown> = {
  getItem: async (name) => {
    // Re-evaluate read completeness on each hydration; read failures set hydratedIncomplete inside readPersistedSnapshot,
    // causing subsequent writes to be rejected until a complete read succeeds.
    hydratedIncomplete = false;
    return await readPersistedSnapshot(name);
  },
  setItem: (name: string, value: StorageValue<unknown>) => {
    registerPersistFlushListeners();
    latestPersistName = name;
    latestPersistValue = value;
    persistWriteVersion++;

    cancelPendingPersistTasks();
    persistTimeoutId = setTimeout(() => {
      persistTimeoutId = null;
      persistIdleTaskId = scheduleIdleTask(() => {
        persistIdleTaskId = null;
        // Dispatch reads latest module-level values and version: multiple writes during cooldown coalesce here,
        // with large shard throttling deciding whether to write immediately or defer until cooldown ends (see dispatchIdleShardedWrite).
        dispatchIdleShardedWrite();
      });
    }, persistDebounceMs);
  },
  removeItem: (name) => removePersistedSnapshot(name),
};

export { debouncedPersistStorage, flushPendingPersistSnapshot, removePersistedSnapshot };
