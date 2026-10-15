/**
 * Repository Health facts (Electron / CommonJS build).
 *
 * Maintains the exact same algorithm as `src/utils/repositoryHealth.ts`: Core objective facts must be consistent across runtimes,
 * otherwise UI, MCP, and plugins will produce conflicting figures.
 *
 * Why a duplicate implementation instead of a shared module: The Electron side is CommonJS (electron/package.json lacks
 * `"type": "module"`), whereas repository root is ESM, and electron-builder bundles only `dist/`, `electron/`,
 * and `node_modules/`, preventing imports from the `src/` tree. This is the same constraint as the 3 mirrored implementations
 * of `mcpDiscovery.js` / `server/src/mcp/repoSearch.ts`; when modifying here, please synchronize
 * `server/src/mcp/repoHealth.ts` and `src/utils/repositoryHealth.ts`.
 *
 * Boundaries match the TS version: outputs only objective facts and conservative observations, not an overall health score or "healthy / unhealthy" verdicts.
 */

const MS_PER_DAY = 86400000;
const DAYS_PER_YEAR = 365.25;
/** Matches the TS version: No pushes in over a year is treated as a neutral observation "No pushes in 12 months". */
const NO_RECENT_ACTIVITY_DAYS = 365;
const MIN_FREQUENCY_WINDOW_DAYS = 30;
const PRERELEASE_TOKENS = new Set([
  'alpha', 'beta', 'rc', 'pre', 'prerelease', 'preview', 'dev', 'devel',
  'next', 'canary', 'snapshot', 'nightly', 'insider', 'unstable',
]);

function toTimestamp(value) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function toCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/** Tri-state boolean facts: returns true/false only if the boolean actually exists in the record; otherwise null (unknown). */
function toTriState(value) {
  return typeof value === 'boolean' ? value : null;
}

/** Pre-release detection: trusts GitHub flags first, falling back to tag tokens (avoids misidentifying "pre" in "presto"). */
function isPrereleaseRelease(release) {
  if (release?.prerelease === true) return true;
  const tag = String(release?.tag_name ?? '').toLowerCase();
  if (!tag) return false;
  return tag
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .some((token) => PRERELEASE_TOKENS.has(token.replace(/\d+$/, '')));
}

/** Fetches releases for a repository in descending published_at order (drops unparseable entries). */
function releasesForRepository(releases, repositoryId) {
  return (Array.isArray(releases) ? releases : [])
    .filter((release) => Number(release?.repository?.id ?? release?.repo_id) === Number(repositoryId))
    .filter((release) => toTimestamp(release.published_at) !== null)
    .slice()
    .sort((left, right) => toTimestamp(right.published_at) - toTimestamp(left.published_at));
}

/**
 * Derives repository health facts (snake_case, suitable for direct MCP JSON evidence output).
 *
 * @param {object} repo Stored repository record.
 * @param {Array} [releases] Releases for this repository; if omitted, caller lacks this data, and Release-related facts will be null.
 * @param {number} [now] Reference timestamp for "how long ago", injected for testing.
 */
function deriveRepositoryHealthFacts(repo, releases, now = Date.now()) {
  const provided = Array.isArray(releases);
  const own = provided ? releasesForRepository(releases, repo?.id) : [];
  const latest = own[0] ?? null;
  const latestStable = own.find((release) => !isPrereleaseRelease(release)) ?? null;
  const latestPrerelease = own.find((release) => isPrereleaseRelease(release)) ?? null;

  const createdTimestamp = toTimestamp(repo?.created_at);
  const pushedTimestamp = toTimestamp(repo?.pushed_at || repo?.updated_at);
  const ageDays = createdTimestamp === null
    ? null
    : Math.max(0, Math.floor((now - createdTimestamp) / MS_PER_DAY));
  const daysSinceLastPush = pushedTimestamp === null
    ? null
    : Math.max(0, Math.floor((now - pushedTimestamp) / MS_PER_DAY));
  // Cannot compute frequency when repository age is unknown: only "genuinely zero releases" is 0; remainder remains null,
  // otherwise "total release count" would be reported as "releases/year" (must match the TS version).
  const releasesPerYear = ageDays === null
    ? (provided && own.length === 0 ? 0 : null)
    : round1(own.length / (Math.max(ageDays, MIN_FREQUENCY_WINDOW_DAYS) / DAYS_PER_YEAR));

  const facts = {
    // GitHub native status fields: tri-state. `null` = fact is completely absent in the record (e.g. not stored in backend);
    // cannot be treated as false — calling "unknown" "unarchived" falsifies facts.
    archived: toTriState(repo?.archived),
    disabled: toTriState(repo?.disabled),
    fork: toTriState(repo?.fork),
    is_template: toTriState(repo?.is_template),

    created_at: repo?.created_at ?? null,
    pushed_at: repo?.pushed_at ?? null,
    age_days: ageDays,
    days_since_last_push: daysSinceLastPush,

    // Release facts are null (unknown) when releases are not provided, rather than 0 (known none).
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
  };

  return { ...facts, signals: deriveRepositoryHealthSignals(facts) };
}

/** Conservative observations permitted by Core, in fixed order (archived → disabled → no-releases → no-recent-activity). */
function deriveRepositoryHealthSignals(facts) {
  const signals = [];
  if (facts.archived) signals.push('archived');
  if (facts.disabled) signals.push('disabled');
  if (facts.releases_fetched && facts.release_count === 0) signals.push('no-releases');
  if (facts.days_since_last_push !== null && facts.days_since_last_push >= NO_RECENT_ACTIVITY_DAYS) {
    signals.push('no-recent-activity');
  }
  return signals;
}

/**
 * Determines if a repository is archived, returning tri-state (matching TS version).
 * Returns undefined when field is missing, so caller's strict equality checks will not treat "unknown" as unarchived.
 */
function isArchivedRepository(repo) {
  return typeof repo?.archived === 'boolean' ? repo.archived : undefined;
}

/** Matches TS version: returns false when timestamp cannot be parsed ("unknown" is not "recently active" in filter semantics). */
function hasRecentActivity(repo, now = Date.now()) {
  const pushed = toTimestamp(repo?.pushed_at) ?? toTimestamp(repo?.updated_at);
  if (pushed === null) return false;
  return now - pushed < NO_RECENT_ACTIVITY_DAYS * MS_PER_DAY;
}

module.exports = {
  NO_RECENT_ACTIVITY_DAYS,
  deriveRepositoryHealthFacts,
  deriveRepositoryHealthSignals,
  hasRecentActivity,
  isArchivedRepository,
  isPrereleaseRelease,
  releasesForRepository,
};
