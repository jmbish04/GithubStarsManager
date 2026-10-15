/**
 * Repository Health Core — Objective Facts Model.
 *
 * Design boundaries (see docs/plans/2026-09-17-product-roadmap.md §4):
 * - Core provides only verifiable facts and conservative signals; it does not compute a 0–100 overall score or subjective conclusions.
 * - "No recent commits" does not equate to "unhealthy": mature, stable projects remaining unchanged for long periods is normal,
 *   so this module outputs neutral observations (e.g. `no-recent-activity`), leaving interpretation to the UI or plugins.
 * - Facts depending on network enrichment (contributor count, closed issues, Security Policy, CI, README/docs,
 *   latest commit on default branch) remain `undefined` when not enriched, explicitly representing "unknown" without guessing.
 *
 * All facts can be derived purely from `Repository` + local `Release[]` (+ optional enrichment),
 * so filtering, sorting, Discovery, AI, MCP, and the Plugin API share the same result without extra network requests.
 */

/** UI groupings: Activity / Maintenance / Community / Maturity. */
export type RepositoryHealthGroup = 'activity' | 'maintenance' | 'community' | 'maturity';

/** Fact source: repository fields, local Releases, or network enrichment. */
export type RepositoryHealthFactSource = 'repository' | 'releases' | 'enrichment';

/**
 * Fact data type, determining UI formatting and filtering behavior.
 * `duration` is used for derived time spans such as "time ago" (epoch milliseconds).
 */
export type RepositoryHealthFactKind = 'boolean' | 'date' | 'count' | 'text' | 'duration';

export type RepositoryHealthFactId =
  // Activity
  | 'pushedAt'
  | 'latestCommitAt'
  | 'recentCommitCount'
  | 'hasReleases'
  | 'latestReleaseAt'
  // Maintenance
  | 'archived'
  | 'disabled'
  | 'fork'
  | 'template'
  | 'license'
  | 'hasSecurityPolicy'
  | 'hasCI'
  | 'hasReadme'
  | 'hasDocs'
  // Community
  | 'stars'
  | 'forks'
  | 'openIssues'
  | 'closedIssues'
  | 'contributors'
  // Maturity
  | 'createdAt'
  | 'ageDays'
  | 'releaseCount'
  | 'releasesPerYear'
  | 'latestStableVersion';

/** A single fact. `value === null` indicates known but absent (e.g. no license); `undefined` indicates unknown. */
export interface RepositoryHealthFact {
  id: RepositoryHealthFactId;
  group: RepositoryHealthGroup;
  kind: RepositoryHealthFactKind;
  /** `null` = known and absent (e.g. no license); `undefined` = fact not yet acquired. */
  value: boolean | number | string | null | undefined;
  source: RepositoryHealthFactSource;
}

/**
 * Conservative signals supported by Core. These are observations rather than scores:
 * - `archived` / `disabled`: Objective status on GitHub.
 * - `no-releases`: Emitted only after confirming Releases have been synced (`has_fetched_releases === true`).
 * - `no-recent-activity`: Most recent push exceeds `NO_RECENT_ACTIVITY_DAYS`, expressed neutrally.
 */
export type RepositoryHealthSignalId = 'archived' | 'disabled' | 'no-releases' | 'no-recent-activity';

export interface RepositoryHealthSignal {
  id: RepositoryHealthSignalId;
  /** Timestamp when the signal was triggered (epoch milliseconds); null for non-temporal signals. */
  since: number | null;
  /** Raw fact value that triggered this observation, allowing UI rendering without re-derivation. */
  detail?: string | null;
}

/**
 * Facts requiring network enrichment.
 * When enrichment is not provided, corresponding fields in snapshots remain `undefined` (unknown).
 */
export interface RepositoryHealthEnrichment {
  latestCommitAt?: string | null;
  recentCommitCount?: number;
  closedIssues?: number;
  contributors?: number;
  hasSecurityPolicy?: boolean;
  hasCI?: boolean;
  hasReadme?: boolean;
  hasDocs?: boolean;
}

/**
 * Unified health fact snapshot (recommended model in roadmap §4.1 + supplementary fields).
 * Decoupled from `Repository`: snapshots are derived read-only projections and not persisted into repository entities,
 * thus preserving the backend sync fingerprint hash contract (Issue #304).
 */
export interface RepositoryHealthSnapshot {
  /**
   * GitHub native status tri-state fields.
   * `true` / `false` represent known facts, whereas `undefined` indicates the field does not exist locally
   * (e.g. backend schema does not store that column, or legacy persisted data is missing it) — NOT the same as "not archived".
   * The panel displays "Unknown" for `undefined`, and filters match neither true nor false for unknown.
   */
  archived: boolean | undefined;
  disabled: boolean | undefined;
  fork: boolean | undefined;
  isTemplate: boolean | undefined;

  createdAt: string;
  pushedAt: string | null;
  latestCommitAt?: string | null;
  recentCommitCount?: number;

  hasReleases: boolean;
  /** Whether Releases have been confirmed synced for this repository. When false, `hasReleases === false` merely means "not yet fetched". */
  releasesFetched: boolean;
  latestReleaseAt: string | null;
  releaseCount: number;
  /** Approximate release frequency: total releases / repository age in years, rounded to 1 decimal place; null when unable to compute (unknown). */
  releasesPerYear: number | null;
  latestStableVersion: string | null;
  latestPrereleaseVersion: string | null;

  stars: number;
  forks: number;
  openIssues?: number;
  closedIssues?: number;
  contributors?: number;

  license?: string | null;
  hasSecurityPolicy?: boolean;
  hasCI?: boolean;
  hasReadme?: boolean;
  hasDocs?: boolean;

  /** Repository age in days; null if createdAt cannot be parsed. */
  ageDays: number | null;
  /** Days since last push; null if pushedAt cannot be parsed. */
  daysSinceLastPush: number | null;
  /** Conservative signals in stable order (archived → disabled → no-releases → no-recent-activity). */
  signals: RepositoryHealthSignal[];
}

/** Grouped view model for UI rendering. */
export interface RepositoryHealthGroupView {
  group: RepositoryHealthGroup;
  facts: RepositoryHealthFact[];
}
