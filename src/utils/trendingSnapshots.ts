import type { TrendingTimeRange } from '../types';
import type { TrendingSnapshot, TrendingSnapshotEntry } from '../types/trendingSnapshot';
import {
  MAX_TRENDING_SNAPSHOTS_PER_BUCKET,
  MAX_TRENDING_ENTRIES_PER_SNAPSHOT,
  TRENDING_SNAPSHOT_MAX_AGE_DAYS,
  TRENDING_STREAK_WINDOW_DAYS,
} from '../types/trendingSnapshot';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_MS = TRENDING_SNAPSHOT_MAX_AGE_DAYS * DAY_MS;
const PERIODS: TrendingTimeRange[] = ['daily', 'weekly', 'monthly'];
const ISO_DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/;

const toTimestamp = (value: string): number | null => {
  const match = ISO_DATE_PREFIX.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year
    || calendarDate.getUTCMonth() !== month - 1
    || calendarDate.getUTCDate() !== day
  ) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Calendar day key: multiple refreshes on the same day only keep the latest snapshot. */
const dayKey = (iso: string): string => {
  const date = new Date(toTimestamp(iso) ?? 0);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const dayNumber = (iso: string): number => {
  const date = new Date(toTimestamp(iso) ?? 0);
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
};

const bucketKey = (period: TrendingTimeRange, platform: string): string => `${period}\u0000${platform}`;

const isPeriod = (value: unknown): value is TrendingTimeRange => (
  typeof value === 'string' && (PERIODS as string[]).includes(value)
);

/** Normalizes a single entry; discards entries with an empty name or a non-positive rank. */
const normalizeEntry = (value: unknown): TrendingSnapshotEntry | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const fullName = typeof record.repositoryFullName === 'string' ? record.repositoryFullName.trim() : '';
  if (!fullName) return null;
  const rank = typeof record.rank === 'number' && Number.isFinite(record.rank) && record.rank >= 1
    ? Math.floor(record.rank)
    : null;
  if (rank === null) return null;
  const stars = typeof record.stars === 'number' && Number.isFinite(record.stars) && record.stars >= 0
    ? Math.floor(record.stars)
    : 0;
  return { repositoryFullName: fullName, rank, stars };
};

/** Normalizes an entire snapshot; returns null on invalid input. */
export const normalizeTrendingSnapshot = (value: unknown): TrendingSnapshot | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (!isPeriod(record.period)) return null;
  const platform = typeof record.platform === 'string' && record.platform.trim() ? record.platform.trim() : 'All';
  const capturedTimestamp = typeof record.capturedAt === 'string' ? toTimestamp(record.capturedAt) : null;
  if (capturedTimestamp === null) return null;
  const capturedAt = new Date(capturedTimestamp).toISOString();
  if (!Array.isArray(record.entries)) return null;

  const candidates = record.entries
    .map(normalizeEntry)
    .filter((entry): entry is TrendingSnapshotEntry => entry !== null)
    .sort((left, right) => left.rank - right.rank);
  const seen = new Set<string>();
  const entries: TrendingSnapshotEntry[] = [];
  for (const entry of candidates) {
    if (seen.has(entry.repositoryFullName)) continue;
    seen.add(entry.repositoryFullName);
    entries.push(entry);
    if (entries.length === MAX_TRENDING_ENTRIES_PER_SNAPSHOT) break;
  }
  if (entries.length === 0) return null;

  return { period: record.period, platform, capturedAt, entries };
};

/** Normalizes each snapshot and discards invalid items. */
export const normalizeTrendingSnapshots = (value: unknown): TrendingSnapshot[] => {
  if (!Array.isArray(value)) return [];
  const snapshots = value
    .map(normalizeTrendingSnapshot)
    .filter((snapshot): snapshot is TrendingSnapshot => snapshot !== null);
  const pruned = pruneTrendingSnapshots(snapshots);
  // Preserve original array reference when content is equivalent: sharded persistence
  // uses reference equality for dirty checking. Rebuilding the array every time would
  // falsely mark the trendingSnapshots shard as modified and trigger a full rewrite on each startup.
  if (pruned.length === value.length
    && pruned.every((snapshot, index) => trendingSnapshotContentEqual(snapshot, value[index]))) {
    return value as TrendingSnapshot[];
  }
  return pruned;
};

/** Considered equivalent if all four known fields match item by item (raw objects come from our own JSON round-trips without extra keys). */
const trendingSnapshotContentEqual = (normalized: TrendingSnapshot, raw: unknown): boolean => {
  if (!raw || typeof raw !== 'object') return false;
  const record = raw as Record<string, unknown>;
  if (record.period !== normalized.period) return false;
  if (record.platform !== normalized.platform) return false;
  if (record.capturedAt !== normalized.capturedAt) return false;
  const rawEntries = Array.isArray(record.entries) ? record.entries : null;
  if (!rawEntries || rawEntries.length !== normalized.entries.length) return false;
  return normalized.entries.every((entry, index) => {
    const rawEntry = rawEntries[index];
    if (!rawEntry || typeof rawEntry !== 'object') return false;
    const candidate = rawEntry as Record<string, unknown>;
    return candidate.repositoryFullName === entry.repositoryFullName
      && candidate.rank === entry.rank
      && candidate.stars === entry.stars;
  });
};

/** Drops expired snapshots and trims buckets to their limit (keeping the latest N snapshots per bucket). */
export const pruneTrendingSnapshots = (
  snapshots: TrendingSnapshot[],
  now: number = Date.now(),
): TrendingSnapshot[] => {
  const fresh = snapshots.filter((snapshot) => {
    const captured = toTimestamp(snapshot.capturedAt);
    if (captured === null) return false;
    const age = now - captured;
    return age >= 0 && age <= MAX_AGE_MS;
  });

  const byBucket = new Map<string, TrendingSnapshot[]>();
  for (const snapshot of fresh) {
    const key = bucketKey(snapshot.period, snapshot.platform);
    const bucket = byBucket.get(key) ?? [];
    bucket.push(snapshot);
    byBucket.set(key, bucket);
  }

  const kept: TrendingSnapshot[] = [];
  for (const bucket of byBucket.values()) {
    const latestByDay = new Map<string, TrendingSnapshot>();
    bucket
      .sort((a, b) => (toTimestamp(a.capturedAt) ?? 0) - (toTimestamp(b.capturedAt) ?? 0))
      .forEach((snapshot) => latestByDay.set(dayKey(snapshot.capturedAt), snapshot));
    [...latestByDay.values()]
      .slice(-MAX_TRENDING_SNAPSHOTS_PER_BUCKET)
      .forEach((snapshot) => kept.push(snapshot));
  }
  return kept.sort((a, b) => (toTimestamp(a.capturedAt) ?? 0) - (toTimestamp(b.capturedAt) ?? 0));
};

/**
 * Records a snapshot.
 *
 * Keeps only the last seen leaderboard for the same "period × platform × calendar day" bucket—paging,
 * switching platforms, and switching back within a single day should not leave contradictory snapshots.
 * Also prunes expired and excess history during writes.
 */
export const recordTrendingSnapshot = (
  snapshots: TrendingSnapshot[],
  next: TrendingSnapshot,
  now: number = Date.now(),
): TrendingSnapshot[] => {
  const normalized = normalizeTrendingSnapshot(next);
  if (!normalized) return pruneTrendingSnapshots(snapshots, now);

  const sameBucketAndDay = (snapshot: TrendingSnapshot) => (
    snapshot.period === normalized.period
    && snapshot.platform === normalized.platform
    && dayKey(snapshot.capturedAt) === dayKey(normalized.capturedAt)
  );

  const rest = snapshots.filter((snapshot) => !sameBucketAndDay(snapshot));
  return pruneTrendingSnapshots([...rest, normalized], now);
};

export interface TrendingHistoryRow {
  repositoryFullName: string;
  /** Rank in the latest snapshot. */
  rank: number;
  /** Rank in the previous snapshot; null if not previously ranked. */
  previousRank: number | null;
  /** Positive = moved up (rank number decreased), negative = moved down, 0 = unchanged; null for new entries. */
  rankChange: number | null;
  firstSeenAt: string;
  /** Consecutive calendar days on the leaderboard (at least one snapshot per day, looking back up to 30 days). */
  streakDays: number;
  /** Star gain since first recorded; null if insufficient data or negative. */
  starsGained: number | null;
}

/**
 * Organizes snapshots for a specific "period × language" bucket into per-repository history.
 *
 * Rank changes are compared against the **previous day's snapshot**, not the "previous snapshot"—multiple
 * refreshes on the same day do not count as changes, preventing users from seeing a false "climbed N ranks"
 * on every refresh.
 */
export const buildTrendingHistory = (
  snapshots: TrendingSnapshot[],
  period: TrendingTimeRange,
  platform: string,
): TrendingHistoryRow[] => {
  const bucket = snapshots
    .filter((snapshot) => snapshot.period === period && snapshot.platform === platform)
    .sort((a, b) => (toTimestamp(a.capturedAt) ?? 0) - (toTimestamp(b.capturedAt) ?? 0));
  if (bucket.length === 0) return [];

  const latest = bucket[bucket.length - 1];
  const latestDay = dayKey(latest.capturedAt);
  const previousDaySnapshot = [...bucket]
    .reverse()
    .find((snapshot) => dayKey(snapshot.capturedAt) < latestDay) ?? null;

  const byRepository = new Map<string, TrendingHistoryRow>();

  const ensureRow = (fullName: string, firstSeenAt: string): TrendingHistoryRow => {
    const existing = byRepository.get(fullName);
    if (existing) return existing;
    const row: TrendingHistoryRow = {
      repositoryFullName: fullName,
      rank: 0,
      previousRank: null,
      rankChange: null,
      firstSeenAt,
      streakDays: 0,
      starsGained: null,
    };
    byRepository.set(fullName, row);
    return row;
  };

  for (const snapshot of bucket) {
    const captured = toTimestamp(snapshot.capturedAt) ?? 0;
    for (const entry of snapshot.entries) {
      const row = ensureRow(entry.repositoryFullName, snapshot.capturedAt);
      const firstSeen = toTimestamp(row.firstSeenAt) ?? 0;
      if (captured < firstSeen) {
        row.firstSeenAt = snapshot.capturedAt;
      }
    }
  }

  const latestDayNumber = dayNumber(latest.capturedAt);
  const presenceDays = new Map<string, Set<number>>();

  for (const snapshot of bucket) {
    if (dayNumber(snapshot.capturedAt) < latestDayNumber - (TRENDING_STREAK_WINDOW_DAYS - 1)) continue;
    for (const entry of snapshot.entries) {
      const days = presenceDays.get(entry.repositoryFullName) ?? new Set<number>();
      days.add(dayNumber(snapshot.capturedAt));
      presenceDays.set(entry.repositoryFullName, days);
    }
  }

  for (const entry of latest.entries) {
    const row = ensureRow(entry.repositoryFullName, latest.capturedAt);
    row.rank = entry.rank;
    const days = presenceDays.get(entry.repositoryFullName) ?? new Set<number>();
    let streakDays = 0;
    for (let day = dayNumber(latest.capturedAt); streakDays < TRENDING_STREAK_WINDOW_DAYS; day -= 1) {
      if (!days.has(day)) break;
      streakDays += 1;
    }
    row.streakDays = Math.max(streakDays, 1);

    const previousEntry = previousDaySnapshot?.entries
      .find((candidate) => candidate.repositoryFullName === entry.repositoryFullName) ?? null;
    row.previousRank = previousEntry?.rank ?? null;
    row.rankChange = previousEntry ? previousEntry.rank - entry.rank : null;

    const earliest = bucket
      .filter((snapshot) => toTimestamp(snapshot.capturedAt) !== null)
      .map((snapshot) => snapshot.entries.find((candidate) => candidate.repositoryFullName === entry.repositoryFullName))
      .find((candidate): candidate is TrendingSnapshotEntry => Boolean(candidate));
    // Calculate difference using only locally recorded star counts; do not pretend this is GitHub's "stars gained this period"
    row.starsGained = earliest && entry.stars >= earliest.stars ? entry.stars - earliest.stars : null;
  }

  return [...byRepository.values()]
    .filter((row) => row.rank > 0)
    .sort((a, b) => a.rank - b.rank);
};

/** Most notable leaderboard changes: new entries, top risers, and top fallers. */
export interface TrendingHighlight {
  kind: 'new-entry' | 'rising' | 'falling';
  repositoryFullName: string;
  /** Rank change amount (null for new entries). */
  rankChange: number | null;
  rank: number;
}

export const pickTrendingHighlights = (
  rows: TrendingHistoryRow[],
  limit = 3,
): TrendingHighlight[] => {
  const newEntries: TrendingHighlight[] = rows
    .filter((row) => row.rankChange === null)
    .slice(0, limit)
    .map((row) => ({
      kind: 'new-entry' as const,
      repositoryFullName: row.repositoryFullName,
      rankChange: null,
      rank: row.rank,
    }));

  const risers: TrendingHighlight[] = rows
    .filter((row): row is TrendingHistoryRow & { rankChange: number } => typeof row.rankChange === 'number' && row.rankChange > 0)
    .sort((a, b) => b.rankChange - a.rankChange)
    .slice(0, limit)
    .map((row) => ({
      kind: 'rising' as const,
      repositoryFullName: row.repositoryFullName,
      rankChange: row.rankChange,
      rank: row.rank,
    }));

  const fallers: TrendingHighlight[] = rows
    .filter((row): row is TrendingHistoryRow & { rankChange: number } => typeof row.rankChange === 'number' && row.rankChange < 0)
    .sort((a, b) => a.rankChange - b.rankChange)
    .slice(0, limit)
    .map((row) => ({
      kind: 'falling' as const,
      repositoryFullName: row.repositoryFullName,
      rankChange: row.rankChange,
      rank: row.rank,
    }));

  return [...risers, ...newEntries, ...fallers];
};
