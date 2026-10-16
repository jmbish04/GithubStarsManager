/**
 * Repository Health Core — derives objective health facts from local data.
 *
 * Pure function, zero side effects, no network calls: takes `Repository` + local `Release[]`
 * (plus optional enrichment) and returns a {@link RepositoryHealthSnapshot}. As a result,
 * repository lists, filtering, sorting, Discovery, AI prompts, MCP evidence, and plugin snapshots
 * can all reuse the same results offline.
 *
 * Explicit non-goals:
 * - Do not compute a 0–100 overall health score; do not output "healthy / unhealthy" verdicts
 *   (subjective scoring belongs in plugins).
 * - Do not flag mature, stable projects as anomalous due to "few recent commits": `no-recent-activity`
 *   is purely a neutral observation.
 * - Do not guess missing facts: fields that require network enrichment remain `undefined` (unknown)
 *   until enriched.
 */
import type { Release, Repository } from '../types';
import type {
  RepositoryHealthEnrichment,
  RepositoryHealthFact,
  RepositoryHealthFactId,
  RepositoryHealthGroup,
  RepositoryHealthGroupView,
  RepositoryHealthSignal,
  RepositoryHealthSnapshot,
} from '../types/health';
import { NO_LICENSE_SENTINEL, normalizeLicense } from './licenseFilter';

const MS_PER_DAY = 86_400_000;
const DAYS_PER_YEAR = 365.25;

/**
 * Observation threshold (in days) for "no recent commits".
 * One year is merely a **display** threshold: once exceeded, the UI displays the neutral copy
 * "No pushes in the last 12 months", rather than deeming the project unhealthy (mature and stable
 * projects going long periods without updates is completely normal).
 */
export const NO_RECENT_ACTIVITY_DAYS = 365;

/** Minimum denominator window (in months) for release frequency to avoid noisy outliers like "365 releases/year" on brand-new repos. */
const MIN_FREQUENCY_WINDOW_DAYS = 30;

/** Any matching token in a tag marks it as a prerelease. Tokenized matching avoids false positives like `pre` inside `presto`. */
const PRERELEASE_TOKENS = new Set([
  'alpha',
  'beta',
  'rc',
  'pre',
  'prerelease',
  'preview',
  'dev',
  'devel',
  'next',
  'canary',
  'snapshot',
  'nightly',
  'insider',
  'unstable',
]);

/** Parses a date string into epoch milliseconds; returns null if missing or unparsable. */
function toTimestamp(value?: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** Coerces a potentially undefined/NaN count into a non-negative integer. */
function toCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/** Rounds to one decimal place to eliminate floating point artifacts. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Checks whether a single Release is a prerelease.
 * First trusts GitHub's `prerelease` flag, then falls back to tag tokens (many maintainers only express prereleases via tags).
 */
export function isPrereleaseRelease(release: Pick<Release, 'prerelease' | 'tag_name'>): boolean {
  if (release.prerelease === true) return true;
  const tag = (release.tag_name ?? '').toLowerCase();
  if (!tag) return false;
  return tag
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .some((token) => PRERELEASE_TOKENS.has(token.replace(/\d+$/, '')));
}

/**
 * Retrieves releases for a given repository sorted in descending order of published date (unparsable entries discarded).
 * Only counts entries matching `repository.id` — callers frequently pass a global Release array.
 */
export function releasesForRepository<T extends Pick<Release, 'repository' | 'published_at'>>(
  releases: readonly T[] | undefined,
  repositoryId: number,
): T[] {
  return (releases ?? [])
    .filter((release) => Number(release.repository?.id) === Number(repositoryId))
    .filter((release) => toTimestamp(release.published_at) !== null)
    .slice()
    .sort(
      (left, right) =>
        (toTimestamp(right.published_at) as number) - (toTimestamp(left.published_at) as number),
    );
}

/**
 * Derives a repository health fact snapshot.
 *
 * @param repository Repository entity (including GitHub native status fields and local AI/custom fields).
 * @param releases Locally synced releases; can be a global array, filtered internally by `repository.id`.
 * @param enrichment Optional network enrichment result; omitted fields remain `undefined` (unknown) in snapshot.
 * @param now Reference timestamp for calculating elapsed time, injectable for testing.
 */
export function deriveRepositoryHealthSnapshot(
  repository: Repository,
  releases?: readonly Release[],
  enrichment?: RepositoryHealthEnrichment,
  now: number = Date.now(),
): RepositoryHealthSnapshot {
  const ownReleases = releasesForRepository(releases, repository.id);
  const releaseCount = ownReleases.length;
  const latestRelease = ownReleases[0] ?? null;
  const latestStable =
    ownReleases.find((release) => !isPrereleaseRelease(release)) ?? null;
  const latestPrerelease =
    ownReleases.find((release) => isPrereleaseRelease(release)) ?? null;

  const createdTimestamp = toTimestamp(repository.created_at);
  // Consistent with `hasRecentActivity` and the electron/server mirrors: falls back to
  // updated_at when pushed_at is missing or unparsable, avoiding conflicting results
  // between the "recent activity" filter and the health fact panel on identical data.
  const pushedTimestamp =
    toTimestamp(repository.pushed_at) ?? toTimestamp(repository.updated_at);
  const ageDays =
    createdTimestamp === null
      ? null
      : Math.max(0, Math.floor((now - createdTimestamp) / MS_PER_DAY));
  const daysSinceLastPush =
    pushedTimestamp === null
      ? null
      : Math.max(0, Math.floor((now - pushedTimestamp) / MS_PER_DAY));

  // Release frequency: uses repository age as the window with a minimum denominator of one month
  // to prevent noisy extremes on new repositories.
  // When repository age is unknown, frequency cannot be converted:
  // - Caller provided no release data -> null (unknown)
  // - Caller provided data but no releases -> 0 (repository never releases)
  // - Caller provided data and releases exist -> must remain null: treating "total" as "releases/year" is invalid
  const releasesPerYear =
    ageDays === null
      ? releases !== undefined && releaseCount === 0
        ? 0
        : null
      : round1(
          releaseCount /
            (Math.max(ageDays, MIN_FREQUENCY_WINDOW_DAYS) / DAYS_PER_YEAR),
        );

  const forkCount =
    repository.forks_count !== undefined
      ? toCount(repository.forks_count)
      : toCount(repository.forks);

  const snapshot: RepositoryHealthSnapshot = {
    // Pass through tri-state directly: preserve undefined (unknown) when fields are missing;
    // do not coerce with `=== true` to false, which would falsely report legacy or unpersisted
    // repositories as "not archived / not fork / not template".
    archived: repository.archived,
    disabled: repository.disabled,
    fork: repository.fork,
    isTemplate: repository.is_template,

    createdAt: repository.created_at ?? '',
    pushedAt: repository.pushed_at || null,
    latestCommitAt: enrichment?.latestCommitAt,
    recentCommitCount: enrichment?.recentCommitCount,

    hasReleases: releaseCount > 0,
    // Acknowledge release status as "known" only if caller explicitly passed a releases array
    // (even if empty); omitting it indicates caller lacks release data, keeping release facts unknown.
    releasesFetched: releases !== undefined && repository.has_fetched_releases === true,
    latestReleaseAt: latestRelease?.published_at ?? null,
    releaseCount,
    releasesPerYear,
    latestStableVersion: latestStable?.tag_name ?? null,
    latestPrereleaseVersion: latestPrerelease?.tag_name ?? null,

    stars: toCount(repository.stargazers_count),
    forks: forkCount,
    openIssues:
      repository.open_issues_count === undefined
        ? undefined
        : toCount(repository.open_issues_count),
    closedIssues: enrichment?.closedIssues,
    contributors: enrichment?.contributors,

    license: repository.license,
    hasSecurityPolicy: enrichment?.hasSecurityPolicy,
    hasCI: enrichment?.hasCI,
    hasReadme: enrichment?.hasReadme,
    hasDocs: enrichment?.hasDocs,

    ageDays,
    daysSinceLastPush,
    signals: [],
  };

  snapshot.signals = deriveRepositoryHealthSignals(snapshot);
  return snapshot;
}

/**
 * Derives conservative signals supported by Core.
 *
 * Emits only 4 signals with a fixed order (archived -> disabled -> no-releases -> no-recent-activity)
 * so UI and tests can rely on stable ordering. `no-releases` is emitted only once releases are
 * confirmed synced; otherwise, an empty local release list simply means releases have not been fetched yet.
 * `since` is populated only for time-based observations.
 */
export function deriveRepositoryHealthSignals(
  snapshot: RepositoryHealthSnapshot,
): RepositoryHealthSignal[] {
  const signals: RepositoryHealthSignal[] = [];

  if (snapshot.archived) {
    signals.push({ id: 'archived', since: null, detail: snapshot.pushedAt });
  }
  if (snapshot.disabled === true) {
    signals.push({ id: 'disabled', since: null, detail: null });
  }
  if (snapshot.releasesFetched && snapshot.releaseCount === 0) {
    signals.push({ id: 'no-releases', since: null, detail: null });
  }
  if (
    snapshot.daysSinceLastPush !== null &&
    snapshot.daysSinceLastPush >= NO_RECENT_ACTIVITY_DAYS
  ) {
    signals.push({
      id: 'no-recent-activity',
      since: toTimestamp(snapshot.pushedAt),
      detail: snapshot.pushedAt,
    });
  }

  return signals;
}

/** Stable group ordering required by UI and tests. */
export const REPOSITORY_HEALTH_GROUP_ORDER: readonly RepositoryHealthGroup[] = [
  'activity',
  'maintenance',
  'community',
  'maturity',
];

/** Fact IDs and stable ordering for each group. */
const GROUP_FACT_IDS: Record<RepositoryHealthGroup, readonly RepositoryHealthFactId[]> = {
  activity: ['pushedAt', 'latestCommitAt', 'recentCommitCount', 'hasReleases', 'latestReleaseAt'],
  maintenance: [
    'archived',
    'disabled',
    'fork',
    'template',
    'license',
    'hasSecurityPolicy',
    'hasCI',
    'hasReadme',
    'hasDocs',
  ],
  community: ['stars', 'forks', 'openIssues', 'closedIssues', 'contributors'],
  maturity: ['createdAt', 'ageDays', 'releaseCount', 'releasesPerYear', 'latestStableVersion'],
};

/** Source of each fact, allowing UI to annotate "requires online enrichment" and filter capability. */
const FACT_SOURCE: Record<RepositoryHealthFactId, RepositoryHealthFact['source']> = {
  pushedAt: 'repository',
  latestCommitAt: 'enrichment',
  recentCommitCount: 'enrichment',
  hasReleases: 'releases',
  latestReleaseAt: 'releases',
  archived: 'repository',
  disabled: 'repository',
  fork: 'repository',
  template: 'repository',
  license: 'repository',
  hasSecurityPolicy: 'enrichment',
  hasCI: 'enrichment',
  hasReadme: 'enrichment',
  hasDocs: 'enrichment',
  stars: 'repository',
  forks: 'repository',
  openIssues: 'repository',
  closedIssues: 'enrichment',
  contributors: 'enrichment',
  createdAt: 'repository',
  ageDays: 'repository',
  releaseCount: 'releases',
  releasesPerYear: 'releases',
  latestStableVersion: 'releases',
};

/** Data type of each fact for UI formatting selection. */
const FACT_KIND: Record<RepositoryHealthFactId, RepositoryHealthFact['kind']> = {
  pushedAt: 'date',
  latestCommitAt: 'date',
  recentCommitCount: 'count',
  hasReleases: 'boolean',
  latestReleaseAt: 'date',
  archived: 'boolean',
  disabled: 'boolean',
  fork: 'boolean',
  template: 'boolean',
  license: 'text',
  hasSecurityPolicy: 'boolean',
  hasCI: 'boolean',
  hasReadme: 'boolean',
  hasDocs: 'boolean',
  stars: 'count',
  forks: 'count',
  openIssues: 'count',
  closedIssues: 'count',
  contributors: 'count',
  createdAt: 'date',
  ageDays: 'duration',
  releaseCount: 'count',
  releasesPerYear: 'count',
  latestStableVersion: 'text',
};

/**
 * Reads the raw fact value from the snapshot.
 *
 * Note the tri-state semantics: `undefined` = unknown, `null` = known and empty (e.g., no license / no stable release).
 */
function readFactValue(
  snapshot: RepositoryHealthSnapshot,
  id: RepositoryHealthFactId,
): RepositoryHealthFact['value'] {
  switch (id) {
    case 'hasReleases':
      // When releases have not been synced yet, "no releases" is not factual — keep unknown.
      if (!snapshot.releasesFetched && !snapshot.hasReleases) return undefined;
      return snapshot.hasReleases;
    case 'license':
      // Empty value normalized to "no license" sentinel to prevent UI from treating '' as declared.
      if (snapshot.license === undefined) return undefined;
      return normalizeLicense(snapshot.license) === NO_LICENSE_SENTINEL
        ? null
        : snapshot.license;
    case 'template':
      // Fact ID uses `template` (GitHub semantics); snapshot field uses `isTemplate` (avoids JS keyword confusion).
      return snapshot.isTemplate;
    default:
      return snapshot[id] as RepositoryHealthFact['value'];
  }
}

/**
 * Expands the snapshot into UI group views (Activity / Maintenance / Community / Maturity).
 * Performs no formatting — labels, dates, and number formats are determined by the UI layer (localized via i18n).
 */
export function groupRepositoryHealthFacts(
  snapshot: RepositoryHealthSnapshot,
): RepositoryHealthGroupView[] {
  return REPOSITORY_HEALTH_GROUP_ORDER.map((group) => ({
    group,
    facts: GROUP_FACT_IDS[group].map((id) => ({
      id,
      group,
      kind: FACT_KIND[id],
      value: readFactValue(snapshot, id),
      source: FACT_SOURCE[id],
    })),
  }));
}

/**
 * Evaluates whether a repository is archived, returning a tri-state boolean.
 *
 * Returns `undefined` (unknown) if the field is missing. Callers must use strict equality checks
 * so neither `healthArchived: true` nor `healthArchived: false` matches unknown repositories —
 * otherwise filtering for "unarchived" would include repositories where the field was simply never stored locally.
 */
export function isArchivedRepository(
  repository: Pick<Repository, 'archived'>,
): boolean | undefined {
  return typeof repository.archived === 'boolean' ? repository.archived : undefined;
}

/**
 * Evaluates whether a repository has recent push activity.
 * `now` can be injected for testing; returns false if timestamps cannot be parsed (filter semantics: unknown != active).
 */
export function hasRecentActivity(
  repository: Pick<Repository, 'pushed_at' | 'updated_at'>,
  now: number = Date.now(),
): boolean {
  const pushed = toTimestamp(repository.pushed_at) ?? toTimestamp(repository.updated_at);
  if (pushed === null) return false;
  return now - pushed < NO_RECENT_ACTIVITY_DAYS * MS_PER_DAY;
}

/** Checks whether a repository declared a recognized license (reuses shared normalization for consistency with license filter). */
export function hasDeclaredLicense(repository: Pick<Repository, 'license'>): boolean {
  return normalizeLicense(repository.license) !== NO_LICENSE_SENTINEL;
}
