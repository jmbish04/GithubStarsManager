/**
 * grep.app code search service (frontend direct connection preferred).
 *
 * Interface reverse-engineered from unofficial spec: `GET https://grep.app/api/search`, no authentication required.
 * Operational notes:
 * - Datacenter IPs trigger Vercel Challenges (429), whereas browser egress works normally, so fetch directly from the browser by default.
 * - `repo/path` is actually a plain string (the `{raw}` wrapper in docs is outdated); bi-directional compatibility is maintained here.
 * - Filters like `f.lang` work, but `facets` still return global distributions; UI should use facets for selection options and hits for display.
 */

export const GREP_APP_BASE_URL = 'https://grep.app';
export const GREP_APP_SEARCH_URL = `${GREP_APP_BASE_URL}/api/search`;

export type GrepMatchMode = 'fuzzy' | 'words' | 'regexp';

export interface GrepSearchParams {
  q: string;
  /** Matching mode: fuzzy (default, nothing passed) / words (whole word) / regexp (RE2 regex) */
  mode?: GrepMatchMode;
  /** Case-sensitive matching, can be combined with any mode */
  caseSensitive?: boolean;
  /** Language filter (pass multiple f.lang parameters) */
  langs?: string[];
  /** Repository filter (owner/repo, pass multiple f.repo parameters) */
  repos?: string[];
  /** Path filter (pass multiple f.path parameters) */
  paths?: string[];
  /** Page number for pagination (corresponds to Load More), defaults to 1 */
  page?: number;
}

export interface GrepFacetBucket {
  val: string;
  count: number;
}

export interface GrepCodeHit {
  repo: string;
  branch: string;
  path: string;
  language: string;
  totalMatches: string;
  /** Server-returned highlight-table HTML (contains <mark>), must be sanitized before rendering */
  snippetHtml: string;
}

export interface GrepSearchResult {
  total: number;
  repoFacets: GrepFacetBucket[];
  pathFacets: GrepFacetBucket[];
  langFacets: GrepFacetBucket[];
  hits: GrepCodeHit[];
}

/** Compatible with both legacy doc format `{raw: string}` and actual plain string (numeric values normalized to string) */
function rawToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value && typeof value === 'object' && typeof (value as { raw?: unknown }).raw === 'string') {
    return (value as { raw: string }).raw;
  }
  return '';
}

function toBucketList(input: unknown): GrepFacetBucket[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      const record = item as { val?: unknown; count?: unknown };
      const val = typeof record.val === 'string' ? record.val : '';
      const count = typeof record.count === 'number' ? record.count : Number(record.count) || 0;
      return { val, count };
    })
    .filter((bucket) => bucket.val !== '');
}

/** Builds grep.app search URL: multi-value filters repeat query params; mutual exclusion between words and regexp is caller's responsibility. */
export function buildGrepSearchUrl(params: GrepSearchParams): string {
  const query = new URLSearchParams();
  query.set('q', params.q);
  if (params.mode === 'words') query.set('words', 'true');
  if (params.mode === 'regexp') query.set('regexp', 'true');
  if (params.caseSensitive) query.set('case', 'true');
  for (const lang of params.langs ?? []) {
    if (lang) query.append('f.lang', lang);
  }
  for (const repo of params.repos ?? []) {
    if (repo) query.append('f.repo', repo);
  }
  for (const path of params.paths ?? []) {
    if (path) query.append('f.path', path);
  }
  if (params.page && params.page > 1) query.set('page', String(params.page));
  return `${GREP_APP_SEARCH_URL}?${query.toString()}`;
}

/** Normalizes grep.app response: supports both plain strings and legacy `{raw}` wrapped hit shapes. */
export function normalizeGrepSearchResponse(data: unknown): GrepSearchResult {
  const root = (data ?? {}) as Record<string, unknown>;
  const facets = (root.facets ?? {}) as Record<string, unknown>;
  const hitsNode = (root.hits ?? {}) as Record<string, unknown>;
  const rawHits = Array.isArray(hitsNode.hits) ? (hitsNode.hits as unknown[]) : [];

  const total =
    typeof facets.count === 'number'
      ? facets.count
      : typeof hitsNode.total === 'number'
        ? hitsNode.total
        : rawHits.length;

  const repoFacets = toBucketList((facets.repo as { buckets?: unknown } | undefined)?.buckets);
  const pathFacets = toBucketList((facets.path as { buckets?: unknown } | undefined)?.buckets);
  const langFacets = toBucketList((facets.lang as { buckets?: unknown } | undefined)?.buckets);

  const hits: GrepCodeHit[] = rawHits.map((item) => {
    const record = (item ?? {}) as Record<string, unknown>;
    const content = (record.content ?? {}) as Record<string, unknown>;
    return {
      repo: rawToString(record.repo),
      branch: rawToString(record.branch) || 'main',
      path: rawToString(record.path),
      language: rawToString(record.language ?? record.lang),
      totalMatches: rawToString(record.total_matches ?? record.totalMatches),
      snippetHtml: typeof content.snippet === 'string' ? content.snippet : '',
    };
  });

  return { total, repoFacets, pathFacets, langFacets, hits };
}

/** Determines whether an error is a grep.app rate limit (HTTP 429), used for retry UI. */
export function isGrepRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = (error as { status?: unknown }).status;
  return status === 429;
}

export interface GrepSearchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Executes a grep.app search: empty queries return empty results directly; supports external cancellation and timeout;
 * 429 throws an error with `status`, as do other non-2xx responses.
 */
export async function searchGrepApp(
  params: GrepSearchParams,
  options: GrepSearchOptions = {}
): Promise<GrepSearchResult> {
  const q = params.q.trim();
  if (!q) {
    return { total: 0, repoFacets: [], pathFacets: [], langFacets: [], hits: [] };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 25000;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  // If the external signal is already aborted, addEventListener will not replay, so synchronize explicitly
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(buildGrepSearchUrl(params), {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.status === 429) {
      const error = new Error('Code search rate limited (429), please retry later');
      (error as { status?: number }).status = 429;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`Code search request failed: ${response.status}`);
      (error as { status?: number }).status = response.status;
      throw error;
    }
    const data = await response.json();
    return normalizeGrepSearchResponse(data);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Starred repository filtering: case-insensitive match on full_name.
 * grep hits only provide an `owner/repo` string; the local starred list is the sole source of truth.
 */
export function filterStarredHits(hits: GrepCodeHit[], starredFullNames: Iterable<string>): GrepCodeHit[] {
  const starred = new Set<string>();
  for (const name of starredFullNames) {
    if (typeof name === 'string' && name) starred.add(name.toLowerCase());
  }
  return hits.filter((hit) => starred.has(hit.repo.toLowerCase()));
}

/**
 * Minimal sanitization: DOMParser allowlist implementation, keeping only tags necessary
 * for pygments highlight-table formatting and `<mark>` highlights, stripping other elements
 * (preserving child node text) and all attributes.
 * Avoids adding a new DOMPurify dependency to prevent bundle size growth. Runs only in browser/jsdom environments.
 */
export function sanitizeGrepSnippet(html: string): string {
  if (!html) return '';
  const allowed = new Set([
    'TABLE', 'TBODY', 'THEAD', 'TR', 'TD', 'DIV',
    'PRE', 'SPAN', 'MARK', 'BR', 'CODE',
  ]);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Remove executable/styling elements along with their contents entirely to avoid leftover script text after unpacking
  doc.querySelectorAll('script, style').forEach((el) => el.remove());

  const sanitizeChildren = (parent: Element): void => {
    for (const child of Array.from(parent.children)) {
      sanitizeChildren(child);
      if (!allowed.has(child.tagName)) {
        // Non-allowlisted element: unpack child nodes (text/highlights) to retain them, then remove parent
        child.replaceWith(...Array.from(child.childNodes));
        continue;
      }
      // Allowlisted element: strip all attributes (including on* handlers and javascript: pseudo-protocols)
      for (const attr of Array.from(child.attributes)) {
        child.removeAttribute(attr.name);
      }
    }
  };

  sanitizeChildren(doc.body);
  return doc.body.innerHTML;
}
