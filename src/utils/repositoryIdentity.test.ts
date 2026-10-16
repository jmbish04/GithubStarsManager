import { describe, expect, it } from 'vitest';
import type { Repository } from '../types';
import {
  SYNTHETIC_REPOSITORY_ID_FLOOR,
  assignIdentityMatches,
  findIdentityMatch,
  isLegacySyntheticIdRecord,
  isValidGitHubRepositoryId,
  matchesLegacyNameFallback,
  matchesSameGitHubId,
} from './repositoryIdentity';

const repo = (
  id: number,
  full_name: string,
  overrides: Partial<Repository> = {},
): Repository => ({
  id,
  full_name,
  name: full_name.split('/')[1] ?? 'repo',
  description: null,
  html_url: `https://github.com/${full_name}`,
  stargazers_count: 0,
  forks_count: 0,
  forks: 0,
  language: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  pushed_at: '2026-01-01T00:00:00.000Z',
  owner: { login: 'owner', avatar_url: '' },
  topics: [],
  ...overrides,
});

/** Example legacy synthetic ID from batch Star imports (timestamp-based). */
const SYNTHETIC_ID = 1_700_000_000_123;

describe('repositoryIdentity helpers', () => {
  it('validates GitHub repository ids', () => {
    expect(isValidGitHubRepositoryId(1)).toBe(true);
    expect(isValidGitHubRepositoryId(987_654_321)).toBe(true);
    expect(isValidGitHubRepositoryId(0)).toBe(false);
    expect(isValidGitHubRepositoryId(-1)).toBe(false);
    expect(isValidGitHubRepositoryId(1.5)).toBe(false);
    expect(isValidGitHubRepositoryId(Number.NaN)).toBe(false);
    expect(isValidGitHubRepositoryId('1')).toBe(false);
    expect(isValidGitHubRepositoryId(undefined)).toBe(false);
  });

  it('separates synthetic ids from real GitHub ids', () => {
    expect(isLegacySyntheticIdRecord({ id: SYNTHETIC_ID })).toBe(true);
    expect(isLegacySyntheticIdRecord({ id: 5 })).toBe(false);
    // Edge case: threshold itself is treated as synthetic
    expect(isLegacySyntheticIdRecord({ id: SYNTHETIC_REPOSITORY_ID_FLOOR })).toBe(true);
    expect(isLegacySyntheticIdRecord({ id: SYNTHETIC_REPOSITORY_ID_FLOOR - 1 })).toBe(false);
  });

  it('matches identity by id even when the name changed (rename)', () => {
    expect(matchesSameGitHubId(repo(5, 'owner/new'), repo(5, 'owner/old'))).toBe(true);
    expect(matchesSameGitHubId(repo(5, 'owner/old'), repo(999, 'owner/old'))).toBe(false);
    // Do not match by ID when incoming ID is invalid (prevents accidental 0/NaN matches)
    expect(matchesSameGitHubId(repo(0, 'owner/x'), repo(0, 'owner/x'))).toBe(false);
  });

  it('falls back to name only for legacy synthetic records, case-insensitively', () => {
    const legacy = repo(SYNTHETIC_ID, 'Owner/Legacy');
    expect(matchesLegacyNameFallback(repo(42, 'owner/legacy'), legacy)).toBe(true);
    // Records with genuine IDs do not participate in name fallback (preventing newly reusing repos from inheriting)
    expect(matchesLegacyNameFallback(repo(42, 'owner/legacy'), repo(5, 'owner/legacy'))).toBe(false);
    expect(matchesLegacyNameFallback(repo(42, 'owner/other'), legacy)).toBe(false);
    expect(matchesLegacyNameFallback(repo(42, ''), legacy)).toBe(false);
  });

  it('prefers the id match over the name fallback', () => {
    const legacy = repo(SYNTHETIC_ID, 'owner/keep');
    const renamed = repo(42, 'owner/renamed');
    // Incoming ID 42 matches renamed; name owner/keep matches legacy => ID match must take precedence
    const match = findIdentityMatch(repo(42, 'owner/keep'), [legacy, renamed]);
    expect(match?.id).toBe(42);
  });

  it('returns undefined when nothing matches (new repository)', () => {
    expect(findIdentityMatch(repo(42, 'owner/new'), [repo(5, 'owner/old')])).toBeUndefined();
    expect(findIdentityMatch(repo(42, 'owner/old'), [])).toBeUndefined();
  });

  it('assigns each candidate at most once across a batch', () => {
    const legacy = repo(SYNTHETIC_ID, 'owner/legacy');
    const assignments = assignIdentityMatches(
      [repo(201, 'owner/legacy'), repo(202, 'OWNER/LEGACY')],
      [legacy],
    );
    expect(assignments[0]).toBe(legacy);
    expect(assignments[1]).toBeUndefined();
  });

  it('does not let a renamed repo and a name-reusing repo share one candidate', () => {
    const old = repo(1, 'owner/old');
    const assignments = assignIdentityMatches(
      [repo(1, 'owner/new'), repo(2, 'owner/old')],
      [old],
    );
    // Renamed repository is claimed by ID; repository reusing former name is treated as new
    expect(assignments[0]).toBe(old);
    expect(assignments[1]).toBeUndefined();
  });

  it('is order-independent when resolving name fallbacks', () => {
    const old = repo(1, 'owner/old');
    const forward = assignIdentityMatches([repo(1, 'owner/new'), repo(2, 'owner/old')], [old]);
    const reversed = assignIdentityMatches([repo(2, 'owner/old'), repo(1, 'owner/new')], [old]);
    // Same result regardless of alignment order: ID 1 claims old record, ID 2 is new
    expect(forward[0]).toBe(old);
    expect(forward[1]).toBeUndefined();
    expect(reversed[0]).toBeUndefined();
    expect(reversed[1]).toBe(old);
  });

  it('records real-id candidates so a name-reusing repo never inherits them', () => {
    // Legacy record with authentic ID (original repo renamed/deleted) whose previous name is reused by a new repo
    const stale = repo(5, 'owner/old');
    const assignments = assignIdentityMatches([repo(999, 'owner/old')], [stale]);
    expect(assignments[0]).toBeUndefined();
  });

  it('handles empty inputs', () => {
    expect(assignIdentityMatches([], [repo(1, 'owner/x')])).toEqual([]);
    expect(assignIdentityMatches([repo(1, 'owner/x')], [])).toEqual([undefined]);
  });
});
