import type { AssetFilter } from '../types';
import { normalizeRepoKey } from './releaseSources';

/**
 * Deduplication key for keyword entries: trimmed and lowercased (keyword matching
 * itself is case-insensitive, so "Mac" and "mac" are treated as identical,
 * keeping the casing of the first occurrence).
 */
const keywordKey = (value: string): string => value.trim().toLowerCase();

/**
 * Sanitizes an array of strings: filters out non-strings, trims items, removes empty/whitespace-only items,
 * and deduplicates by key (preserving the first occurrence).
 * Empty string keywords must be removed — `includes("")` is always true, so `keywords: [""]`
 * would inadvertently match all releases, breaching the guard against malformed/empty filters matching everything.
 */
const sanitizeStringArray = (value: unknown, key: (item: string) => string): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;

  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const dedupeKey = key(trimmed);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    result.push(trimmed);
  }
  return result;
};

/**
 * Normalizes asset filters received from external sources (local persistence, backend sync, backup import):
 * - Drops malformed entries missing required fields (non-empty id, name, keywords array) to ensure downstream
 *   keyword matching in ReleaseTimeline does not throw when reading keywords.
 * - Uniformly sanitizes keywords / excludeKeywords / includeRepos / alwaysExcludeRepos:
 *   filters out non-strings, trims items, drops empty/whitespace-only values, and deduplicates
 *   (repositories deduplicated case-insensitively via normalizeRepoKey; keywords deduplicated trimmed lowercase;
 *   preserving the display text of the first entry).
 * - Reconstructs entries using only known AssetFilter fields, discarding unknown keys — including the legacy
 *   inverted-semantics field `excludeRepos` introduced briefly in #405 and replaced by includeRepos, avoiding
 *   endless round-trips during sync and preventing obsolete fields from being misinterpreted as `alwaysExcludeRepos`.
 */
export const normalizeAssetFilters = (filters: unknown): AssetFilter[] => {
  if (!Array.isArray(filters)) return [];

  return filters
    .filter((filter): filter is Record<string, unknown> => !!filter && typeof filter === 'object')
    .map(filter => {
      if (
        typeof filter.id !== 'string' || filter.id.length === 0 ||
        typeof filter.name !== 'string' ||
        !Array.isArray(filter.keywords)
      ) {
        return null;
      }

      const keywords = sanitizeStringArray(filter.keywords, keywordKey);
      if (!keywords) return null;

      const normalized: AssetFilter = {
        id: filter.id,
        name: filter.name,
        keywords,
      };

      const excludeKeywords = sanitizeStringArray(filter.excludeKeywords, keywordKey);
      if (excludeKeywords) normalized.excludeKeywords = excludeKeywords;
      const includeRepos = sanitizeStringArray(filter.includeRepos, normalizeRepoKey);
      if (includeRepos) normalized.includeRepos = includeRepos;
      const alwaysExcludeRepos = sanitizeStringArray(filter.alwaysExcludeRepos, normalizeRepoKey);
      if (alwaysExcludeRepos) normalized.alwaysExcludeRepos = alwaysExcludeRepos;
      if (typeof filter.isPreset === 'boolean') normalized.isPreset = filter.isPreset;
      if (typeof filter.icon === 'string') normalized.icon = filter.icon;

      return normalized;
    })
    .filter((filter): filter is AssetFilter => filter !== null);
};

/**
 * Normalizes download link names used in keyword matching (already lowercased by caller).
 *
 * GitHub automatically generates `Source code (<tag>.zip)` and
 * `Source code (<tag>.tar.gz)` pseudo-assets for *every* release, unconditionally and with no distinguishing info.
 * If matched as-is against include keywords, common archive extension keywords like `zip` / `tar.gz`
 * would match every release — effectively breaking filters (e.g., zero-asset releases showing up in macOS filters:
 * MinerU's `mineru-4.0.0-py3-none-any.whl`, cline/openclaw's source-only archive releases).
 *
 * Therefore, when matching, strip the auto-generated archive extension (names formatted as `source code (<tag>.zip)`,
 * with the archive extension preceding the closing parenthesis): `source code (<tag>)` can still be matched by `source`,
 * preserving existing behavior that `preset-source` relies on; while `zip` / `tar.gz` only match real uploaded assets
 * and download links extracted from the release body.
 */
export const normalizeMatchedLinkName = (lowerName: string, isSourceCode: boolean): string =>
  isSourceCode ? lowerName.replace(/\.(?:zip|tar\.gz)(?=\)$)/, '') : lowerName;

/**
 * Whether a single link name matches keyword rules (caller lowercases input; exclude keywords take precedence).
 * When include keywords are empty, it acts without positive constraints and evaluates exclusion only.
 */
const linkHitsKeywordRules = (
  lowerName: string,
  keywords: string[],
  excludeKeywords: string[],
): boolean =>
  !excludeKeywords.some(keyword => lowerName.includes(keyword.toLowerCase())) &&
  (keywords.length === 0 || keywords.some(keyword => lowerName.includes(keyword.toLowerCase())));

/** Repository rule evaluation outcome: exclude takes precedence over include (excluded repos are never matched). */
type RepoRuleOutcome = 'excluded' | 'included' | 'none';

const resolveRepoRule = (
  filter: Pick<AssetFilter, 'keywords'> & Partial<AssetFilter>,
  lowerRepoKey: string,
): RepoRuleOutcome => {
  if ((filter.alwaysExcludeRepos ?? []).some(name => normalizeRepoKey(name) === lowerRepoKey)) {
    return 'excluded';
  }
  if ((filter.includeRepos ?? []).some(name => normalizeRepoKey(name) === lowerRepoKey)) {
    return 'included';
  }
  return 'none';
};

export interface AssetFilterEvaluation {
  /** Whether the release appears in the release list */
  matchesRelease: boolean;
  /** Download link indices shown by default on the card (indices map 1:1 to lowerMatchedLinkNames) */
  matchedLinkIndexes: Set<number>;
}

/**
 * Evaluates a single filter against a single release: release-level match + asset indices contributed by this filter.
 * Across multiple filters, release matches are OR-combined and asset indices are unioned (merged by caller).
 *
 * Both tiers share the exact same rule implementation, preventing drift where "a release matches but has no assets to show"
 * or "keyword scopes diverge between tiers" (an audit showed splitting into two exported functions caused rules to drift).
 *
 * Release-level (matchesRelease):
 * 1. Repo hits "alwaysExcludeRepos" -> no match (exclusion takes precedence, evaluated before includeRepos and keywords).
 * 2. Repo hits "includeRepos" -> match (bypasses keyword checks for this filter, but not exclusion).
 * 3. With asset rules: if include keywords are non-empty, matching scope covers all download link names (including
 *    source archive pseudo-assets and release-body extracted links, relied upon by `preset-source`) — source archive
 *    pseudo-assets have their auto-generated extensions stripped via normalizeMatchedLinkName before matching to prevent
 *    `zip` / `tar.gz` from matching every release's pseudo-assets and breaking filters; if include keywords are empty,
 *    match only against real uploaded asset names in release.assets — otherwise releases whose real assets are all excluded
 *    might still match unexcluded pseudo-assets or body links, preventing exclusion keywords from hiding the release.
 * 4. Without asset rules: non-empty includeRepos -> no match (no positive condition outside whitelist);
 *    only alwaysExcludeRepos non-empty -> match (other repos match); both empty -> no match.
 *
 * Asset-level (matchedLinkIndexes):
 * 1. Only filters matching this release contribute assets: non-matching filters (including malformed/empty filters
 *    with no rules) return an empty set; otherwise they would inadvertently unlock the full asset list of all releases.
 * 2. Repo hits "includeRepos" -> all indices (releases from this repo display all assets by design).
 * 3. With keyword rules -> links matching include keywords and not matching exclude keywords; if include keywords
 *    are empty, no positive filtering applies and only exclude keywords prune assets.
 * 4. Matches without asset rules (negative repo filter with only exclusion list) -> no asset restriction, returns all indices.
 *
 * lowerRepoKey / lowerMatchedLinkNames / lowerRealAssetNames are lowercased by caller,
 * and lowerMatchedLinkNames must be normalized via normalizeMatchedLinkName first;
 * filter fields retain original values (repo and keyword matches are case-insensitive).
 */
export const evaluateAssetFilter = (
  filter: Pick<AssetFilter, 'keywords'> & Partial<AssetFilter>,
  lowerRepoKey: string,
  lowerMatchedLinkNames: readonly string[],
  lowerRealAssetNames: readonly string[],
): AssetFilterEvaluation => {
  const noIndexes = (): Set<number> => new Set<number>();
  const allIndexes = (): Set<number> =>
    new Set(lowerMatchedLinkNames.map((_, index) => index));

  const repoRule = resolveRepoRule(filter, lowerRepoKey);
  if (repoRule === 'excluded') {
    return { matchesRelease: false, matchedLinkIndexes: noIndexes() };
  }
  if (repoRule === 'included') {
    return { matchesRelease: true, matchedLinkIndexes: allIndexes() };
  }

  // Guard against unnormalized filters: empty string keywords make includes("") always true,
  // causing includes to match everything and excludes to hide all releases. Filter them out here.
  const keywords = (filter.keywords ?? []).filter(keyword => keyword.trim().length > 0);
  const excludeKeywords = (filter.excludeKeywords ?? []).filter(keyword => keyword.trim().length > 0);

  if (keywords.length === 0 && excludeKeywords.length === 0) {
    // Pure repository rule: whitelist match already returned above, leaving only negative filters with exclusion lists
    const matchesRelease = (filter.includeRepos ?? []).length === 0
      && (filter.alwaysExcludeRepos ?? []).length > 0;
    return { matchesRelease, matchedLinkIndexes: matchesRelease ? allIndexes() : noIndexes() };
  }

  const hitsKeywordRules = (lowerName: string): boolean =>
    linkHitsKeywordRules(lowerName, keywords, excludeKeywords);
  const matchScope = keywords.length > 0 ? lowerMatchedLinkNames : lowerRealAssetNames;
  if (!matchScope.some(hitsKeywordRules)) {
    return { matchesRelease: false, matchedLinkIndexes: noIndexes() };
  }

  const matchedLinkIndexes = new Set<number>();
  lowerMatchedLinkNames.forEach((lowerName, index) => {
    if (hitsKeywordRules(lowerName)) matchedLinkIndexes.add(index);
  });
  return { matchesRelease: true, matchedLinkIndexes };
};
