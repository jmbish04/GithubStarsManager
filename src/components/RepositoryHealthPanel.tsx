import React, { useMemo } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { AlertTriangle, Archive, Ban, PackageOpen } from 'lucide-react';
import type { Release, Repository } from '../types';
import type {
  RepositoryHealthFact,
  RepositoryHealthFactId,
  RepositoryHealthGroup,
  RepositoryHealthSignalId,
} from '../types/health';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion';
import { Badge } from './ui/badge';
import { formatNumber, getDateFnsLocale } from '../i18n/format';
import { useT, type TranslateFn } from '../i18n/useT';
import type { AppLanguage } from '../i18n/languages';
import {
  deriveRepositoryHealthSnapshot,
  groupRepositoryHealthFacts,
} from '../utils/repositoryHealth';

/**
 * Repository Health facts panel.
 *
 * Only displays objective facts and conservative observations; **does not display any aggregate health score or "healthy / unhealthy" conclusions**—
 * subjective scoring belongs in plugins (see docs/plans/2026-09-17-product-roadmap.md §4.3).
 * Therefore, colorized "good / bad" judgments are deliberately avoided here, and unknown facts are shown as "Unknown" rather than guessed.
 */
interface RepositoryHealthPanelProps {
  repository: Repository;
  /** Local releases for this repo; used to derive Release-related facts. When absent, the corresponding facts are unknown. */
  releases?: Release[];
  /** Used solely for date-fns localization; UI copy exclusively uses i18n keys. */
  language: AppLanguage;
}

/** i18n keys for group headers. */
const GROUP_KEYS: Record<RepositoryHealthGroup, string> = {
  activity: 'repositoryHealthPanel.activity',
  maintenance: 'repositoryHealthPanel.maintenance',
  community: 'repositoryHealthPanel.community',
  maturity: 'repositoryHealthPanel.maturity',
};

/** i18n keys for fact labels. */
const FACT_KEYS: Record<RepositoryHealthFactId, string> = {
  pushedAt: 'repositoryHealthPanel.last-push',
  latestCommitAt: 'repositoryHealthPanel.latest-commit',
  recentCommitCount: 'repositoryHealthPanel.recent-commits',
  hasReleases: 'repositoryHealthPanel.has-releases',
  latestReleaseAt: 'repositoryHealthPanel.latest-release',
  archived: 'repositoryHealthPanel.archived',
  disabled: 'repositoryHealthPanel.disabled',
  fork: 'repositoryHealthPanel.fork',
  template: 'repositoryHealthPanel.template',
  license: 'repositoryHealthPanel.license',
  hasSecurityPolicy: 'repositoryHealthPanel.security-policy',
  hasCI: 'repositoryHealthPanel.ci-github-actions',
  hasReadme: 'repositoryHealthPanel.readme',
  hasDocs: 'repositoryHealthPanel.docs',
  stars: 'repositoryHealthPanel.stars',
  forks: 'repositoryHealthPanel.forks',
  openIssues: 'repositoryHealthPanel.open-issues',
  closedIssues: 'repositoryHealthPanel.closed-issues',
  contributors: 'repositoryHealthPanel.contributors',
  createdAt: 'repositoryHealthPanel.created',
  ageDays: 'repositoryHealthPanel.repository-age',
  releaseCount: 'repositoryHealthPanel.releases',
  releasesPerYear: 'repositoryHealthPanel.release-frequency',
  latestStableVersion: 'repositoryHealthPanel.latest-stable-version',
};

/**
 * i18n keys for conservative observations (see {@link SIGNAL_ICONS} for icons).
 * `no-recent-activity` uses neutral copy and icon to avoid implying "unhealthy".
 */
const SIGNAL_KEYS: Record<RepositoryHealthSignalId, string> = {
  archived: 'repositoryHealthPanel.archived',
  disabled: 'repositoryHealthPanel.disabled',
  'no-releases': 'repositoryHealthPanel.no-releases',
  'no-recent-activity': 'repositoryHealthPanel.no-pushes-in-12-months',
};

const SIGNAL_ICONS: Record<RepositoryHealthSignalId, React.ComponentType<{ className?: string }>> = {
  archived: Archive,
  disabled: Ban,
  'no-releases': PackageOpen,
  'no-recent-activity': AlertTriangle,
};

/** Number with thousand separators; non-finite values fall back as-is to avoid displaying NaN. */
function formatCount(value: number, language: AppLanguage): string {
  return Number.isFinite(value) ? formatNumber(value, language) : '—';
}

/** Absolute date (YYYY-MM-DD), used for tooltips and fallback for relative time. */
function formatAbsoluteDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toISOString().slice(0, 10);
}

/**
 * Display text for a fact value. `undefined` always displays "Unknown" without inference.
 *
 * `t` is passed by caller rather than using `useT()` here: this is a standard function that might be called conditionally,
 * and calling a Hook inside it would violate Hooks rules.
 */
function formatFactValue(
  fact: RepositoryHealthFact,
  t: TranslateFn,
  language: AppLanguage,
): { text: string; title?: string; muted: boolean } {
  const unknown = { text: t('repositoryHealthPanel.unknown'), muted: true };

  if (fact.value === undefined) return unknown;

  switch (fact.kind) {
    case 'boolean':
      if (fact.value === null) return { text: t('repositoryHealthPanel.none'), muted: true };
      return fact.value
        ? { text: t('repositoryHealthPanel.yes'), muted: false }
        : { text: t('repositoryHealthPanel.no'), muted: true };
    case 'count':
      if (fact.value === null) return { text: '—', muted: true };
      if (fact.id === 'releasesPerYear') {
        return { text: t('repositoryHealthPanel.v1-year', { v1: formatCount(fact.value as number, language) }), muted: false };
      }
      return { text: formatCount(fact.value as number, language), muted: false };
    case 'duration': {
      if (fact.value === null) return { text: '—', muted: true };
      const days = fact.value as number;
      const years = Math.round((days / 365.25) * 10) / 10;
      return {
        text: t('repositoryHealthPanel.v1-days-years-years', { v1: formatCount(days, language), years: years }),
        muted: false,
      };
    }
    case 'date': {
      if (fact.value === null) return { text: t('repositoryHealthPanel.none'), muted: true };
      const raw = String(fact.value);
      const timestamp = Date.parse(raw);
      if (!Number.isFinite(timestamp)) return { text: raw, muted: false };
      return {
        text: formatDistanceToNow(timestamp, {
          addSuffix: true,
          locale: getDateFnsLocale(language),
        }),
        title: formatAbsoluteDate(raw),
        muted: false,
      };
    }
    case 'text':
    default:
      if (fact.value === null) return { text: t('repositoryHealthPanel.none'), muted: true };
      return { text: String(fact.value), muted: false };
  }
}

export const RepositoryHealthPanel: React.FC<RepositoryHealthPanelProps> = ({
  repository,
  releases,
  language,
}) => {
  const t = useT('repositories');

  // Pure function derivation: no network requests; when releases are not synced, related facts automatically become "Unknown".
  const groups = useMemo(() => {
    const snapshot = deriveRepositoryHealthSnapshot(repository, releases);
    return { snapshot, views: groupRepositoryHealthFacts(snapshot) };
  }, [repository, releases]);

  const { snapshot, views } = groups;

  const title = t('repositoryHealthPanel.repository-health-facts');

  return (
    <section
      className="mb-3 rounded-md border border-border bg-muted/20"
      aria-label={title}
    >
      <Accordion type="single" collapsible>
        <AccordionItem value="facts" className="border-0">
          <AccordionTrigger className="px-3 py-2 text-xs hover:no-underline">
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <span className="font-semibold">{title}</span>
              {snapshot.signals.map((signal) => {
                const Icon = SIGNAL_ICONS[signal.id];
                return (
                  <Badge key={signal.id} variant="outline" className="gap-1 text-[11px] font-normal">
                    <Icon className="h-3 w-3" aria-hidden="true" />
                    {t(SIGNAL_KEYS[signal.id])}
                  </Badge>
                );
              })}
            </span>
          </AccordionTrigger>
          <AccordionContent className="px-3 pb-3">
            <div className="grid gap-3 sm:grid-cols-2">
              {views.map(({ group, facts }) => (
                <div key={group}>
                  <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t(GROUP_KEYS[group])}
                  </p>
                  <dl className="space-y-0.5">
                    {facts.map((fact) => {
                      const formatted = formatFactValue(fact, t, language);
                      return (
                        <div key={fact.id} className="flex items-baseline justify-between gap-2 text-xs">
                          <dt className="truncate text-muted-foreground">{t(FACT_KEYS[fact.id])}</dt>
                          <dd
                            className={`shrink-0 text-right ${formatted.muted ? 'text-muted-foreground' : ''}`}
                            title={formatted.title}
                          >
                            {formatted.text}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              {t('repositoryHealthPanel.these-are-objective-facts-with-no-overall-score')}
            </p>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </section>
  );
};

export default RepositoryHealthPanel;
