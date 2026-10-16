import type { Repository } from '../types';

/**
 * Sole authoritative implementation of repository identity determination.
 *
 * ## Invariant
 *
 * **`id` is the authoritative GitHub identity; `full_name` is only used as a fallback clue when identity is missing.**
 *
 * Historical context: Prior to this module, this rule was implemented separately in `addRepository`,
 * `mergeStarredRepositories`, and the Discovery page. The implementations were inconsistent
 * (some required matching both full_name and id, some matched by name only, some were case-sensitive),
 * causing renames, name reuses, and legacy synthetic IDs to repeatedly interfere with one another.
 * All repository identity decisions must go through this module.
 *
 * ## Synthetic IDs
 *
 * Early versions of batch Star imports from links assigned timestamp-based synthetic IDs
 * (`Date.now() + random`, ~1.8e12) to new repositories. These records lack authoritative GitHub IDs.
 * Genuine GitHub repository IDs are well below this threshold (currently < 1e10), so a lower bound
 * safely distinguishes them.
 */
export const SYNTHETIC_REPOSITORY_ID_FLOOR = 1e11;

/** Whether the parameter contains a valid GitHub repository ID (positive integer). */
export const isValidGitHubRepositoryId = (id: unknown): id is number =>
  typeof id === 'number' && Number.isInteger(id) && id > 0;

/**
 * Checks whether this record is a legacy synthetic ID record from batch Star imports.
 *
 * Only these records may be claimed by name: they have no authentic GitHub ID, making name
 * their only identifier. Conversely, records with genuine IDs have authoritative identities —
 * an ID mismatch means the repository was renamed or deleted. Claiming by name in that case
 * would cause a new repository reusing an old name to incorrectly inherit AI analysis and tags.
 */
export const isLegacySyntheticIdRecord = (repo: Pick<Repository, 'id'>): boolean =>
  repo.id >= SYNTHETIC_REPOSITORY_ID_FLOOR;

/** Parameter shape required for identity resolution. */
export type RepositoryIdentity = Pick<Repository, 'id' | 'full_name'>;

/** Same GitHub identity: incoming ID is valid and matches the candidate ID (renames do not affect this, matching solely by ID). */
export const matchesSameGitHubId = (
  incoming: RepositoryIdentity,
  candidate: RepositoryIdentity,
): boolean => isValidGitHubRepositoryId(incoming.id) && candidate.id === incoming.id;

/**
 * Name fallback: incoming name matches candidate name, **and** the candidate is a legacy synthetic ID record.
 * Case-insensitive — GitHub owner/repo names are inherently case-insensitive, and local cached casing
 * may differ from upstream.
 */
export const matchesLegacyNameFallback = (
  incoming: RepositoryIdentity,
  candidate: RepositoryIdentity,
): boolean => Boolean(incoming.full_name)
  && Boolean(candidate.full_name)
  && isLegacySyntheticIdRecord(candidate)
  && candidate.full_name.toLowerCase() === incoming.full_name.toLowerCase();

/**
 * Finds the corresponding local record for an incoming repository, returning `undefined` if none match (treated as new).
 *
 * The selection order enforces the invariant: **ID match first, synthetic ID name fallback second**.
 */
export const findIdentityMatch = (
  incoming: RepositoryIdentity,
  candidates: Repository[],
): Repository | undefined => candidates.find(candidate => matchesSameGitHubId(incoming, candidate))
  ?? candidates.find(candidate => matchesLegacyNameFallback(incoming, candidate));

/**
 * Assigns local candidate records across an entire batch of incoming repositories,
 * aligning one-to-one with `incoming` (`undefined` = new repository).
 *
 * Two-pass assignment, strictly one-to-one in the second pass:
 * 1. Match the whole incoming batch by ID first, marking all matched local candidates as claimed.
 * 2. Perform name fallback on remaining unmatched incoming items, skipping already claimed candidates.
 *
 * Why two passes are required: GitHub allows a new repository to reuse a newly renamed repository's former name.
 * If local has `{ id: 1, full_name: 'owner/old' }`, and the incoming batch contains both the renamed
 * `{ id: 1, full_name: 'owner/new' }` and the new repository reusing the old name `{ id: 2, full_name: 'owner/old' }`,
 * a single-pass match would assign both incoming repos to the same local record -> producing duplicate `id: 1`
 * records and improperly copying the old repository's AI analysis and tags to the new one.
 * Two passes also ensure the result is independent of input order.
 */
export const assignIdentityMatches = (
  incoming: Repository[],
  candidates: Repository[],
): Array<Repository | undefined> => {
  const assignments: Array<Repository | undefined> = new Array(incoming.length).fill(undefined);
  if (incoming.length === 0 || candidates.length === 0) return assignments;

  // Claimed candidate records tracked by object reference to ensure each local record is used at most once.
  const claimed = new Set<Repository>();

  // Pass 1: match entire batch by ID, claiming all matched local records.
  incoming.forEach((repo, index) => {
    const match = candidates.find(candidate => matchesSameGitHubId(repo, candidate));
    if (!match) return;
    assignments[index] = match;
    claimed.add(match);
  });

  // Pass 2: perform name fallback only for unmatched repositories, skipping candidates claimed in pass 1.
  incoming.forEach((repo, index) => {
    if (assignments[index]) return;
    const match = candidates.find(
      candidate => !claimed.has(candidate) && matchesLegacyNameFallback(repo, candidate),
    );
    if (!match) return;
    assignments[index] = match;
    claimed.add(match);
  });

  return assignments;
};
