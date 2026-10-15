/**
 * Pure repo search helpers for MCP (mirrors src/utils/repoSearch.ts).
 * Kept server-local to avoid coupling the Express package to the Vite app tree.
 */
import { hasRecentActivity, isArchivedRepository } from './repoHealth.js';

/**
 * Server-side mirror of license normalization (consistent with src/utils/licenseFilter.ts).
 * The server MCP cannot import the src/ tree, so an identical implementation is kept here;
 * update both when making changes.
 */
export const NO_LICENSE_SENTINEL = '__NO_LICENSE__';
const NOASSERTION_KEYS = new Set(['', 'noassertion', 'other', 'none', 'no-license']);
export function normalizeLicense(v: unknown): string {
  if (v == null || v === '') return NO_LICENSE_SENTINEL;
  if (typeof v === 'object') {
    const l = v as { spdx_id?: unknown; key?: unknown };
    const spdx = typeof l.spdx_id === 'string' ? l.spdx_id.trim() : '';
    const key = typeof l.key === 'string' ? l.key.trim() : '';
    const resolved = spdx || key;
    if (!resolved) return NO_LICENSE_SENTINEL;
    return NOASSERTION_KEYS.has(resolved.toLowerCase()) ? NO_LICENSE_SENTINEL : resolved;
  }
  if (typeof v !== 'string') return NO_LICENSE_SENTINEL;
  // String paths must also be trimmed: prevents whitespace variations like " Other " / " NOASSERTION " from escaping sentinel normalization
  const normalized = v.trim();
  return !normalized || NOASSERTION_KEYS.has(normalized.toLowerCase())
    ? NO_LICENSE_SENTINEL
    : normalized;
}

export interface McpRepository {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  language: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  pushed_at?: string | null;
  starred_at?: string | null;
  topics: string[];
  ai_summary?: string | null;
  ai_tags?: string[];
  ai_platforms?: string[];
  analyzed_at?: string | null;
  analysis_failed?: boolean;
  custom_description?: string | null;
  custom_tags?: string[];
  custom_category?: string | null;
  category_locked?: boolean;
  subscribed_to_releases?: boolean;
  owner?: { login: string; avatar_url?: string };
  license?: string | null;
  /**
   * Native GitHub status fields. The current backend schema does not store these columns,
   * so they are undefined at runtime; Repository Health facts accordingly remain `null`
   * (unknown) rather than asserting "not archived".
   */
  archived?: boolean;
  disabled?: boolean;
  fork?: boolean;
  is_template?: boolean;
  open_issues_count?: number;
  default_branch?: string;
}

export interface McpSearchFilters {
  query?: string;
  tags?: string[];
  languages?: string[];
  platforms?: string[];
  sortBy?: 'stars' | 'updated' | 'name' | 'starred' | 'created';
  sortOrder?: 'desc' | 'asc';
  minStars?: number;
  maxStars?: number;
  isAnalyzed?: boolean;
  isSubscribed?: boolean;
  isCategoryLocked?: boolean;
  analysisFailed?: boolean;
  category?: string;
  /** SPDX id filter; containing {@link NO_LICENSE_SENTINEL} represents "none / undeclared license". */
  licenses?: string[];
  /** Repository Health objective facts filter (same semantics as src/utils/repoSearch.ts). */
  healthArchived?: boolean;
  healthRecentActivity?: boolean;
  healthHasLicense?: boolean;
  limit?: number;
  offset?: number;
}

export function performBasicTextSearch<T extends McpRepository>(repos: T[], query: string): T[] {
  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedQuery) return repos;
  const queryWords = normalizedQuery.split(/\s+/).filter(Boolean);

  return repos.filter((repo) => {
    const searchableText = [
      repo.name,
      repo.full_name,
      repo.description || '',
      repo.custom_description || '',
      repo.language || '',
      ...(repo.topics || []),
      repo.ai_summary || '',
      ...(repo.ai_tags || []),
      ...(repo.ai_platforms || []),
      ...(repo.custom_tags || []),
      repo.custom_category || '',
      normalizeLicense(repo.license),
    ]
      .join(' ')
      .toLowerCase();
    return queryWords.every((word) => searchableText.includes(word));
  });
}

/**
 * Pure predicate for the facet filters shared by keyword and vector search.
 * Vector search uses this predicate after retrieval so it never changes the
 * Worker contract or pretends to provide an exact corpus-wide filtered topK.
 */
export function matchesRepoFilters(repo: McpRepository, filters: McpSearchFilters): boolean {
  if (filters.languages?.length && (!repo.language || !filters.languages.includes(repo.language))) {
    return false;
  }
  if (filters.tags?.length) {
    const tags = [...(repo.ai_tags || []), ...(repo.topics || []), ...(repo.custom_tags || [])];
    if (!filters.tags.some((tag) => tags.includes(tag))) return false;
  }
  if (filters.platforms?.length) {
    const platforms = repo.ai_platforms || [];
    if (!filters.platforms.some((platform) => platforms.includes(platform))) return false;
  }
  if (filters.licenses?.length && !filters.licenses.includes(normalizeLicense(repo.license))) {
    return false;
  }
  if (filters.isAnalyzed !== undefined && filters.analysisFailed === undefined) {
    const matches = filters.isAnalyzed
      ? !!repo.analyzed_at && !repo.analysis_failed
      : !repo.analyzed_at;
    if (!matches) return false;
  }
  if (filters.isSubscribed !== undefined && filters.isSubscribed !== !!repo.subscribed_to_releases) {
    return false;
  }
  if (filters.isCategoryLocked !== undefined && filters.isCategoryLocked !== !!repo.category_locked) {
    return false;
  }
  if (filters.analysisFailed !== undefined && filters.isAnalyzed === undefined) {
    const failed = !!(repo.analyzed_at && repo.analysis_failed);
    if (filters.analysisFailed !== failed) return false;
  }
  if (filters.minStars !== undefined && (repo.stargazers_count ?? 0) < filters.minStars) {
    return false;
  }
  if (filters.maxStars !== undefined && (repo.stargazers_count ?? 0) > filters.maxStars) {
    return false;
  }
  // Repository Health fact filters: same semantics as Electron MCP / frontend (see repoHealth.ts).
  if (filters.healthArchived !== undefined && isArchivedRepository(repo) !== filters.healthArchived) {
    return false;
  }
  if (
    filters.healthRecentActivity !== undefined &&
    hasRecentActivity(repo) !== filters.healthRecentActivity
  ) {
    return false;
  }
  if (filters.healthHasLicense !== undefined) {
    const hasLicense = normalizeLicense(repo.license) !== NO_LICENSE_SENTINEL;
    if (hasLicense !== filters.healthHasLicense) return false;
  }
  if (filters.category && filters.category !== 'all' && repo.custom_category !== filters.category) {
    return false;
  }
  return true;
}

function getSortValue(repo: McpRepository, sortBy: McpSearchFilters['sortBy']): number | string {
  switch (sortBy) {
    case 'stars':
      return repo.stargazers_count ?? 0;
    case 'updated':
      return new Date(repo.pushed_at || repo.updated_at || 0).getTime();
    case 'name':
      return repo.name.toLowerCase();
    case 'starred':
      return repo.starred_at ? new Date(repo.starred_at).getTime() : 0;
    case 'created':
      return repo.created_at ? new Date(repo.created_at).getTime() : 0;
    default:
      return new Date(repo.pushed_at || repo.updated_at || 0).getTime();
  }
}

export function applyRepoFilters<T extends McpRepository>(
  repos: T[],
  filters: McpSearchFilters
): T[] {
  const filtered = repos.filter((repo) => matchesRepoFilters(repo, filters));

  const sortBy = filters.sortBy ?? 'stars';
  const sortOrder = filters.sortOrder ?? 'desc';
  const sorted = [...filtered];
  sorted.sort((a, b) => {
    const aValue = getSortValue(a, sortBy);
    const bValue = getSortValue(b, sortBy);
    if (aValue < bValue) return sortOrder === 'desc' ? 1 : -1;
    if (aValue > bValue) return sortOrder === 'desc' ? -1 : 1;
    // Consistent with sortRepositories in src/utils/repoSearch.ts: stable sort by full_name
    // on tiebreaks to ensure consistent cross-platform (backend / Electron) pagination results.
    return a.full_name.localeCompare(b.full_name);
  });
  return sorted;
}

export function searchRepositories<T extends McpRepository>(
  repos: T[],
  filters: McpSearchFilters
): { items: T[]; total: number } {
  let result = repos;
  if (filters.query?.trim()) {
    result = performBasicTextSearch(result, filters.query);
  }
  result = applyRepoFilters(result, filters);
  const total = result.length;
  const offset = Math.max(0, filters.offset ?? 0);
  const limit = Math.min(100, Math.max(1, filters.limit ?? 20));
  return { items: result.slice(offset, offset + limit), total };
}

export function projectRepoForAgent(
  repo: McpRepository,
  opts: { summaryMaxChars?: number } = {}
): Record<string, unknown> {
  const max = opts.summaryMaxChars ?? 400;
  const summary = repo.ai_summary || repo.custom_description || repo.description || null;
  const truncated =
    typeof summary === 'string' && summary.length > max ? `${summary.slice(0, max)}…` : summary;

  return {
    id: repo.id,
    full_name: repo.full_name,
    name: repo.name,
    html_url: repo.html_url,
    description: repo.description,
    language: repo.language,
    stargazers_count: repo.stargazers_count,
    topics: repo.topics ?? [],
    ai_summary: truncated,
    ai_tags: repo.ai_tags ?? [],
    ai_platforms: repo.ai_platforms ?? [],
    custom_description: repo.custom_description,
    custom_tags: repo.custom_tags,
    custom_category: repo.custom_category,
    analyzed_at: repo.analyzed_at,
    subscribed_to_releases: !!repo.subscribed_to_releases,
    starred_at: repo.starred_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    license: repo.license ?? null,
  };
}
