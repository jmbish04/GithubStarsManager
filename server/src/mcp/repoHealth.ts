/**
 * Repository Health facts (backend MCP runtime).
 *
 * This is one of three mirrors of the same algorithm (along with `electron/repoHealth.js` and
 * `src/utils/repositoryHealth.ts`): Core objective facts must remain consistent across runtimes,
 * otherwise the UI, MCP, and plugins will report contradictory numbers.
 * The reason these are mirrored rather than a shared module: server's tsconfig `rootDir: "src"`
 * does not permit importing the app source tree, while the Electron side uses CommonJS.
 * When updating this file, please synchronize the other two copies.
 *
 * Consistent boundaries: only outputs objective facts and conservative observations;
 * never outputs an aggregate health score or a "healthy / unhealthy" verdict.
 */

const MS_PER_DAY = 86_400_000;
const DAYS_PER_YEAR = 365.25;
/** Aligned with TS version: no pushes for over a year is treated only as the neutral observation "No pushes in 12 months". */
export const NO_RECENT_ACTIVITY_DAYS = 365;
const MIN_FREQUENCY_WINDOW_DAYS = 30;
const PRERELEASE_TOKENS = new Set([
  'alpha', 'beta', 'rc', 'pre', 'prerelease', 'preview', 'dev', 'devel',
  'next', 'canary', 'snapshot', 'nightly', 'insider', 'unstable',
]);

/** Minimal repository shape used for health fact derivation (backend does not store native GitHub status fields). */
export interface HealthRepositoryInput {
  id: number;
  created_at?: string | null;
  updated_at?: string | null;
  pushed_at?: string | null;
  stargazers_count?: number | null;
  forks_count?: number | null;
  forks?: number | null;
  license?: string | null;
  has_fetched_releases?: boolean;
  archived?: boolean;
  disabled?: boolean;
  fork?: boolean;
  is_template?: boolean;
  open_issues_count?: number;
  default_branch?: string;
}

/** Minimal release shape required for health fact derivation. */
export interface HealthReleaseInput {
  repo_id?: number;
  repository?: { id?: number } | null;
  tag_name?: string | null;
  published_at?: string | null;
  prerelease?: boolean;
}

export interface RepositoryHealthFacts {
  archived: boolean | null;
  disabled: boolean | null;
  fork: boolean | null;
  is_template: boolean | null;
  created_at: string | null;
  pushed_at: string | null;
  age_days: number | null;
  days_since_last_push: number | null;
  release_count: number | null;
  has_releases: boolean | null;
  releases_fetched: boolean;
  latest_release_at: string | null;
  latest_stable_version: string | null;
  latest_prerelease_version: string | null;
  releases_per_year: number | null;
  stars: number;
  forks: number;
  open_issues_count: number | null;
  default_branch: string | null;
  license: string | null;
  signals: string[];
}

function toTimestamp(value?: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function toCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Tri-state conversion for boolean facts: returns true/false only when a boolean value is present, otherwise null (unknown). */
function toTriState(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Prerelease check: trust the GitHub flag first, then fall back to tag token matching (avoids false positives like "pre" in "presto"). */
export function isPrereleaseRelease(release: Pick<HealthReleaseInput, 'prerelease' | 'tag_name'>): boolean {
  if (release?.prerelease === true) return true;
  const tag = String(release?.tag_name ?? '').toLowerCase();
  if (!tag) return false;
  return tag
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .some((token) => PRERELEASE_TOKENS.has(token.replace(/\d+$/, '')));
}

/** Fetch releases for a repository in descending order of publish date (discarding unparseable entries). */
export function releasesForRepository(
  releases: readonly HealthReleaseInput[] | undefined,
  repositoryId: number,
): HealthReleaseInput[] {
  return (Array.isArray(releases) ? releases : [])
    .filter((release) => Number(release?.repository?.id ?? release?.repo_id) === Number(repositoryId))
    .filter((release) => toTimestamp(release.published_at) !== null)
    .slice()
    .sort((left, right) => (toTimestamp(right.published_at) as number) - (toTimestamp(left.published_at) as number));
}

/**
 * Derive repository health facts.
 *
 * @param repo Stored repository record.
 * @param releases Releases for this repository; omitting indicates the caller lacks this data, making release-related facts null.
 * @param now Reference timestamp for calculating elapsed time, injected for testing.
 */
export function deriveRepositoryHealthFacts(
  repo: HealthRepositoryInput,
  releases?: readonly HealthReleaseInput[],
  now: number = Date.now(),
): RepositoryHealthFacts {
  const provided = Array.isArray(releases);
  const own = provided ? releasesForRepository(releases, repo?.id) : [];
  const latest = own[0] ?? null;
  const latestStable = own.find((release) => !isPrereleaseRelease(release)) ?? null;
  const latestPrerelease = own.find((release) => isPrereleaseRelease(release)) ?? null;

  const createdTimestamp = toTimestamp(repo?.created_at);
  const pushedTimestamp = toTimestamp(repo?.pushed_at || repo?.updated_at);
  const ageDays =
    createdTimestamp === null ? null : Math.max(0, Math.floor((now - createdTimestamp) / MS_PER_DAY));
  const daysSinceLastPush =
    pushedTimestamp === null ? null : Math.max(0, Math.floor((now - pushedTimestamp) / MS_PER_DAY));
  // Cannot compute "frequency" when repo age is unknown: only "genuinely zero releases" produces 0,
  // all other unknown cases stay null to avoid reporting "total releases" as "per year" (must match Electron / TS versions).
  const releasesPerYear =
    ageDays === null
      ? provided && own.length === 0
        ? 0
        : null
      : round1(own.length / (Math.max(ageDays, MIN_FREQUENCY_WINDOW_DAYS) / DAYS_PER_YEAR));

  const facts: RepositoryHealthFacts = {
    archived: toTriState(repo?.archived),
    disabled: toTriState(repo?.disabled),
    fork: toTriState(repo?.fork),
    is_template: toTriState(repo?.is_template),

    created_at: repo?.created_at ?? null,
    pushed_at: repo?.pushed_at ?? null,
    age_days: ageDays,
    days_since_last_push: daysSinceLastPush,

    release_count: provided ? own.length : null,
    has_releases: provided ? own.length > 0 : null,
    releases_fetched: provided && repo?.has_fetched_releases === true,
    latest_release_at: latest?.published_at ?? null,
    latest_stable_version: latestStable?.tag_name ?? null,
    latest_prerelease_version: latestPrerelease?.tag_name ?? null,
    releases_per_year: releasesPerYear,

    stars: toCount(repo?.stargazers_count),
    forks: repo?.forks_count !== undefined ? toCount(repo.forks_count) : toCount(repo?.forks),
    open_issues_count: repo?.open_issues_count === undefined ? null : toCount(repo.open_issues_count),
    default_branch: repo?.default_branch ?? null,
    license: repo?.license ?? null,
    signals: [],
  };

  facts.signals = deriveRepositoryHealthSignals(facts);
  return facts;
}

/** Conservative observations permitted by Core, in a fixed order (archived → disabled → no-releases → no-recent-activity). */
export function deriveRepositoryHealthSignals(facts: RepositoryHealthFacts): string[] {
  const signals: string[] = [];
  if (facts.archived === true) signals.push('archived');
  if (facts.disabled === true) signals.push('disabled');
  if (facts.releases_fetched && facts.release_count === 0) signals.push('no-releases');
  if (facts.days_since_last_push !== null && facts.days_since_last_push >= NO_RECENT_ACTIVITY_DAYS) {
    signals.push('no-recent-activity');
  }
  return signals;
}

/**
 * Determine if a repository is archived, returning a tri-state value (consistent with Electron / TS versions).
 * Returns undefined when the field is missing, so callers' strict equality checks won't mistake "unknown" for unarchived.
 */
export function isArchivedRepository(
  repo: Pick<HealthRepositoryInput, 'archived'>,
): boolean | undefined {
  return typeof repo?.archived === 'boolean' ? repo.archived : undefined;
}

/** Aligned with TS version: returns false if the timestamp cannot be parsed ("unknown" is not "recently active" in filter semantics). */
export function hasRecentActivity(
  repo: Pick<HealthRepositoryInput, 'pushed_at' | 'updated_at'>,
  now: number = Date.now(),
): boolean {
  const pushed = toTimestamp(repo?.pushed_at) ?? toTimestamp(repo?.updated_at);
  if (pushed === null) return false;
  return now - pushed < NO_RECENT_ACTIVITY_DAYS * MS_PER_DAY;
}
