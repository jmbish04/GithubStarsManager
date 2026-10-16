/**
 * Trending Snapshots (Development Guidelines §7).
 *
 * Current Trending is only a "point-in-time display": refreshed data overwrites the view,
 * making rank changes and new entries invisible.
 * Here, each viewed leaderboard is stored as a snapshot keyed by "period × platform × calendar day",
 * retaining a limited number of historical entries locally.
 *
 * An independent Trending details model is not maintained: snapshots record only repository name,
 * rank, and star count at capture time, standardizing back to the Repository model for display
 * (consistent with Development Guidelines §7).
 */
import type { TrendingTimeRange } from './index';

export interface TrendingSnapshotEntry {
  repositoryFullName: string;
  /** Rank within this snapshot (1-indexed). */
  rank: number;
  /** Total star count when captured; used to compute "delta since our tracking started", not GitHub's "today's stars". */
  stars: number;
}

export interface TrendingSnapshot {
  period: TrendingTimeRange;
  /** 'All' or platform id; matches the platform filter used by Trending requests. */
  platform: string;
  /** ISO timestamp. */
  capturedAt: string;
  entries: TrendingSnapshotEntry[];
}

/** Maximum number of snapshots retained per "period × platform" bucket. */
export const MAX_TRENDING_SNAPSHOTS_PER_BUCKET = 30;

/** Each snapshot retains only the top entries of the leaderboard to prevent unbounded expansion of corrupted persisted data. */
export const MAX_TRENDING_ENTRIES_PER_SNAPSHOT = 50;

/** Snapshots older than this number of days are purged on write. */
export const TRENDING_SNAPSHOT_MAX_AGE_DAYS = 90;

/** Maximum lookback window (in days) when calculating consecutive appearances (streaks). */
export const TRENDING_STREAK_WINDOW_DAYS = 30;

