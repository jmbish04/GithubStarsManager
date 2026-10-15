import React, { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ArrowDownRight, ArrowUpRight, Sparkles, TrendingUp } from 'lucide-react';
import type { TrendingTimeRange } from '../../../types';
import { useT } from '../../../i18n/useT';
import { getDateFnsLocale } from '../../../i18n/format';
import { useAppStore } from '../../../store/useAppStore';
import { buildTrendingHistory, pickTrendingHighlights } from '../../../utils/trendingSnapshots';
import { formatDistanceToNow } from 'date-fns';

interface TrendingHistoryPanelProps {
  period: TrendingTimeRange;
  platform: string;
}

/**
 * Trending history panel (Development Guide §7).
 *
 * All data comes from local snapshots: rank changes compare against the **previous day's** record
 * (refreshing multiple times on the same day does not count as a change).
 * "Stars gained" is the difference between our two records, not GitHub's "gained in this period" —
 * this is clarified in the copy to avoid confusion with official metrics.
 *
 * Does not render when only one snapshot exists (day one), as all entries would count as "new entries",
 * providing little informational value.
 */
export const TrendingHistoryPanel: React.FC<TrendingHistoryPanelProps> = ({ period, platform }) => {
  const t = useT('discovery');
  const { snapshots, appLanguage } = useAppStore(useShallow((state) => ({
    snapshots: state.trendingSnapshots,
    appLanguage: state.language,
  })));

  const bucketSize = useMemo(
    () => snapshots.filter((snapshot) => snapshot.period === period && snapshot.platform === platform).length,
    [snapshots, period, platform],
  );

  const rows = useMemo(
    () => buildTrendingHistory(snapshots, period, platform),
    [snapshots, period, platform],
  );
  const highlights = useMemo(() => pickTrendingHighlights(rows, 2), [rows]);

  if (bucketSize < 2 || highlights.length === 0) return null;

  const iconFor = (kind: 'new-entry' | 'rising' | 'falling') => {
    if (kind === 'rising') return <ArrowUpRight className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />;
    if (kind === 'falling') return <ArrowDownRight className="h-3.5 w-3.5 text-rose-500" aria-hidden="true" />;
    return <Sparkles className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" />;
  };

  const labelFor = (kind: 'new-entry' | 'rising' | 'falling') => (
    kind === 'rising' ? t('trendingHistoryPanel.rising')
      : kind === 'falling' ? t('trendingHistoryPanel.falling')
        : t('trendingHistoryPanel.new-entry')
  );

  return (
    <section className="ui-toolbar p-3" aria-label={t('trendingHistoryPanel.title')} data-testid="trending-history">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
          {t('trendingHistoryPanel.title')}
        </span>
        <span className="text-[11px] text-muted-foreground">{t('trendingHistoryPanel.hint')}</span>
      </div>

      <ul className="grid gap-2 sm:grid-cols-2">
        {highlights.map((highlight) => {
          const row = rows.find((candidate) => candidate.repositoryFullName === highlight.repositoryFullName);
          return (
            <li
              key={`${highlight.kind}-${highlight.repositoryFullName}`}
              className="flex items-center gap-2 rounded-md border border-border bg-background/60 px-2 py-1.5"
              data-testid={`trending-highlight-${highlight.kind}`}
            >
              {iconFor(highlight.kind)}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-foreground" title={highlight.repositoryFullName}>
                  {highlight.repositoryFullName}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {labelFor(highlight.kind)}
                  {highlight.rankChange !== null ? ` ${Math.abs(highlight.rankChange)}` : ''}
                  {row ? ` · ${t('trendingHistoryPanel.streak-days', { v1: row.streakDays })}` : ''}
                </span>
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                #{highlight.rank}
              </span>
            </li>
          );
        })}
      </ul>

      {rows[0] && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {t('trendingHistoryPanel.first-seen', {
            v1: formatDistanceToNow(new Date(rows[0].firstSeenAt), {
              addSuffix: true,
              locale: getDateFnsLocale(appLanguage),
            }),
          })}
          {rows[0].starsGained !== null ? ` · ${t('trendingHistoryPanel.stars-gained', { v1: rows[0].starsGained })}` : ''}
        </p>
      )}
    </section>
  );
};

export default TrendingHistoryPanel;
