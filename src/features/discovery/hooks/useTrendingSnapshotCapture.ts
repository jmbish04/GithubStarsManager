import { useEffect, useRef } from 'react';
import type { DiscoveryRepo, TrendingTimeRange } from '../../../types';
import { MAX_TRENDING_ENTRIES_PER_SNAPSHOT } from '../../../types/trendingSnapshot';
import { useAppStore } from '../../../store/useAppStore';

/**
 * Records the currently viewed Trending list as a snapshot (Development Guide §7).
 *
 * Called only on trending channels; retains only one snapshot per "period × platform" per day
 * (deduplication and limits are handled by `utils/trendingSnapshots`), so re-renders, pagination,
 * and navigating back won't accumulate conflicting history.
 */
export const useTrendingSnapshotCapture = (
  repos: DiscoveryRepo[],
  isTrendingChannel: boolean,
  period: TrendingTimeRange,
  platform: string,
  lastRefresh: string | null,
): void => {
  const recordTrendingSnapshot = useAppStore((state) => state.recordTrendingSnapshot);
  const capturedRefreshRef = useRef(lastRefresh);

  useEffect(() => {
    if (!isTrendingChannel || !lastRefresh || lastRefresh === capturedRefreshRef.current || repos.length === 0) return;
    capturedRefreshRef.current = lastRefresh;
    recordTrendingSnapshot({
      period,
      platform,
      capturedAt: new Date().toISOString(),
      entries: repos.slice(0, MAX_TRENDING_ENTRIES_PER_SNAPSHOT).map((repo, index) => ({
        repositoryFullName: repo.full_name,
        // The rank provided by the API may be missing; fall back to current list order
        rank: typeof repo.rank === 'number' && repo.rank >= 1 ? repo.rank : index + 1,
        stars: typeof repo.stargazers_count === 'number' && repo.stargazers_count >= 0 ? repo.stargazers_count : 0,
      })),
    });
  }, [repos, isTrendingChannel, period, platform, lastRefresh, recordTrendingSnapshot]);
};
