/**
 * Batch Repository Intake — Extraction and normalization.
 *
 * Pure function, zero I/O: normalizes pasted plain text / Markdown / JSON into `owner/repo` candidates,
 * deduplicating them and returning them in order of first appearance. Network validation (repo existence,
 * private status, renames) belongs to the subsequent phase.
 *
 * GitHub URL forms covered by normalization (subpaths are discarded, preserving only the parent repo):
 * ```
 * https://github.com/owner/repo            github.com/owner/repo
 * https://www.github.com/owner/repo/       https://github.com/owner/repo.git
 * https://github.com/owner/repo/releases/tag/v1.2.0
 * https://github.com/owner/repo/issues/12  /pull/34  /tree/main/src  /blob/main/a.ts
 * https://github.com/owner/repo/actions|wiki|discussions|commit|compare|stargazers|…
 * ```
 * as well as bare `owner/repo` slugs in prose.
 *
 * Intentional non-goals:
 * - No network requests; do not guess actual repository casing (GitHub is case-insensitive; true casing is resolved during the Resolve phase).
 * - Do not treat site feature paths like `github.com/orgs/…`, `github.com/topics/…`, `github.com/settings/…`
 *   as repositories; mark them explicitly as `invalid` with reasons so users can see them rather than silently discarding them.
 * - Do not pretend certainty for bare `owner/repo`: `A/B` in prose is naturally isomorphic with repo slugs,
 *   so these are uniformly marked with `confidence: 'low'`, delegating confirmation to the user during preview.
 */
import type { Repository } from '../types';
import type {
  ImportCandidateConfidence,
  ImportCandidateMatchedBy,
  ImportFailureReason,
  ImportedRepositoryCandidate,
  ImportSource,
  RepositoryImportExtractionOptions,
  RepositoryImportExtractionResult,
} from '../types/repositoryImport';

const DEFAULT_MAX_INPUT_LENGTH = 512 * 1024;
const DEFAULT_MAX_VALUES = 20_000;
const DEFAULT_MAX_DEPTH = 32;

/** GitHub username: alphanumeric and hyphens, cannot start with hyphen, max 39 characters. */
const OWNER_PATTERN = /^(?=.{1,39}$)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
/** GitHub repository name: alphanumeric, '-', '_', '.', max 100 characters. */
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Reserved words for `github.com/<segment1>` representing site feature entries rather than usernames.
 * Second-level segments under these paths (`orgs/foo`, `topics/react`) are not repositories, and must also be rejected in bare slug notation.
 */
const RESERVED_ROOTS = new Set([
  'about', 'account', 'apps', 'blog', 'business', 'careers', 'codespaces', 'collections',
  'contact', 'customer-stories', 'dashboard', 'developer', 'donate', 'education', 'enterprise',
  'events', 'explore', 'features', 'home', 'issues', 'join', 'login', 'logout',
  'marketplace', 'mobile', 'new', 'notifications', 'organizations', 'orgs', 'pages', 'partners',
  'pricing', 'projects', 'pulls', 'readme', 'search', 'security', 'settings', 'site', 'sponsors',
  'stars', 'topics', 'trending', 'users', 'wiki', 'sitemap',
]);

/**
 * False-positive suppression for bare `owner/repo` #1: common code directory names.
 * This repo's own documentation is filled with fragments like `src/utils` and `docs/plans`, which would otherwise trigger heavy false positives.
 */
const CODE_LIKE_DIRECTORIES = new Set([
  'src', 'app', 'lib', 'libs', 'test', 'tests', 'docs', 'doc', 'dist', 'build', 'out',
  'public', 'assets', 'static', 'config', 'configs', 'scripts', 'script', 'node_modules',
  'server', 'client', 'packages', 'package', 'components', 'component', 'hooks', 'hook',
  'utils', 'util', 'pages', 'api', 'apis', 'routes', 'router', 'store', 'stores',
  'styles', 'types', 'features', 'feature', 'examples', 'example', 'fixtures', 'mocks',
  'templates', 'template', 'locales', 'i18n', 'electron', 'cloudflare-worker',
  'versions', 'bin', 'cmd', 'internal', 'pkg', 'vendor', 'third_party',
]);

/** False-positive suppression for bare `owner/repo` #2: common file extensions (`src/utils.ts`, `docs/guide.md`). */
const FILE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'md', 'mdx', 'txt', 'yml', 'yaml',
  'toml', 'ini', 'cfg', 'conf', 'lock', 'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'py', 'rb', 'php', 'go', 'rs', 'java', 'kt',
  'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'sql',
  'env', 'log', 'map', 'wasm',
]);

/**
 * False-positive suppression for bare `owner/repo` #3: common English and technical terms.
 *
 * This is an inherently incomplete heuristic — `and/or`, `24/7`, `TCP/IP` share the same format as repo slugs
 * and cannot be completely enumerated by word lists. Bare slugs are therefore uniformly downgraded to `confidence: 'low'`,
 * leaving final confirmation to the user in the preview step (the exact rationale for the Review phase).
 */
const BARE_SLUG_STOPWORDS = new Set([
  'and', 'or', 'either', 'neither', 'both', 'not', 'with', 'without', 'per', 'vs', 'versus',
  'he', 'she', 'it', 'they', 'we', 'you', 'his', 'her', 'its', 'their', 'our', 'your',
  'tcp', 'udp', 'ip', 'http', 'https', 'ftp', 'ssh', 'dns', 'ssl', 'tls',
  'read', 'write', 'readonly', 'readwrite', 'input', 'output', 'request', 'response',
  'client', 'server', 'frontend', 'backend', 'parent', 'child', 'master', 'slave', 'primary',
  'replica', 'source', 'target', 'left', 'right', 'up', 'down', 'in', 'out', 'on', 'off',
  'before', 'after', 'over', 'under', 'plus', 'minus', 'min', 'max', 'start', 'end', 'open',
  'close', 'true', 'false', 'yes', 'no', 'null', 'none', 'all', 'any', 'km', 'miles',
  'day', 'week', 'month', 'year', 'cost', 'benefit', 'pros', 'cons', 'win', 'loss',
]);

/** Matches absolute URLs first, then uses `URL.hostname` to accurately check if it is GitHub. */
const ABSOLUTE_URL_PATTERN = /https?:\/\/[^\s<>()[\]{}"'`,;:|*~]+/gi;

/** Schemeless `github.com/owner/repo`; does not match in the middle of longer domains or paths. */
const SCHEMELESS_GITHUB_URL_PATTERN =
  /(?<![A-Za-z0-9./-])(?:www\.)?github\.com\/([^\s<>()[\]{}"'`,;:|*~]*)/gi;

/**
 * Matches bare `owner/repo` slugs in prose.
 * Negative lookaround before and after excludes segments that are part of longer paths: in `a/b/c`, neither `a/b` nor `b/c` matches.
 */
const BARE_SLUG_PATTERN =
  /(?<![A-Za-z0-9._/-])(?:(_{1,2})([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\1|([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}))(?![A-Za-z0-9_/-])/g;

/** Common trailing punctuation or wrapping characters on URLs (`owner/repo.`, `owner/repo,`). Parens and quotes are excluded by capture groups. */
function trimUrlTail(value: string): string {
  return value.replace(/[.,;:!?]+$/, '');
}

/** Extracts file extension (lowercase); returns empty string if no extension. `.git` is treated as a suffix rather than an extension and handled separately. */
function extensionOf(segment: string): string {
  const index = segment.lastIndexOf('.');
  if (index <= 0 || index === segment.length - 1) return '';
  return segment.slice(index + 1).toLowerCase();
}

/**
 * Validates and normalizes `owner/repo`.
 *
 * @param owner Username segment.
 * @param repo Repository name segment (optional `.git` suffix will be stripped).
 * @returns Normalized `owner/repo` (preserving original casing), or null if invalid.
 */
export function normalizeRepositoryFullName(owner: string, repo: string): string | null {
  const cleanRepo = repo.toLowerCase().endsWith('.git') ? repo.slice(0, -4) : repo;
  if (!OWNER_PATTERN.test(owner)) return null;
  if (!REPO_PATTERN.test(cleanRepo)) return null;
  // Pure dots ('.', '..') are not valid repository names
  if (/^\.+$/.test(cleanRepo)) return null;
  return `${owner}/${cleanRepo}`;
}

/**
 * Resolves repository from the path portion of a GitHub URL (subpaths such as release / issue / PR / tree / blob are discarded).
 *
 * @param url Full segment following `github.com/`, optionally with query / fragment / trailing punctuation.
 * @returns Normalized result, or failure reason.
 */
export function resolveRepositoryFromGitHubUrl(
  url: string,
): { repositoryFullName: string } | { reason: ImportFailureReason } {
  const withoutQuery = url.split(/[?#]/)[0];

  // Trailing punctuation is usually sentence punctuation (`…/repo.`), but could also belong to path itself (`owner/..`).
  // Try parsing without trailing punctuation first; retry with original string only if segment count drops below two.
  for (const candidate of [trimUrlTail(withoutQuery), withoutQuery]) {
    const segments = candidate.split('/').filter(Boolean);
    if (segments.length === 0) continue;

    // First segment is a site reserved keyword -> feature page, not a repo
    if (RESERVED_ROOTS.has(segments[0].toLowerCase())) {
      return { reason: 'not-a-repository-url' };
    }
    // `github.com/<owner>` is a user/org profile page with no repo name; retry with untrimmed string
    if (segments.length < 2) continue;

    const fullName = normalizeRepositoryFullName(segments[0], segments[1]);
    return fullName ? { repositoryFullName: fullName } : { reason: 'malformed-slug' };
  }

  return { reason: 'not-a-repository-url' };
}

/**
 * Determines whether a bare `owner/repo` is plausible as a candidate.
 * Rejects on any matching suppression rule — better to miss than to clutter the preview with noise.
 */
export function isPlausibleBareSlug(owner: string, repo: string): boolean {
  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo)) return false;
  if (/^\.+$/.test(repo)) return false;
  // Single-character segments in prose are almost always noise like I/O or N/A, not repos
  if (owner.length < 2 || repo.length < 2) return false;

  const ownerLower = owner.toLowerCase();
  const repoLower = repo.toLowerCase();
  if (RESERVED_ROOTS.has(ownerLower)) return false;
  if (BARE_SLUG_STOPWORDS.has(ownerLower) || BARE_SLUG_STOPWORDS.has(repoLower)) return false;
  if (CODE_LIKE_DIRECTORIES.has(ownerLower) || CODE_LIKE_DIRECTORIES.has(repoLower)) return false;

  const extension = extensionOf(repo);
  if (extension && extension !== 'git' && FILE_EXTENSIONS.has(extension)) return false;
  return true;
}

/** Removes closing Markdown underscore delimiters matching opening count. */
function trimMarkdownUnderscoreDelimiter(text: string, matchStart: number, path: string): string {
  let delimiterLength = 0;
  for (let index = matchStart - 1; index >= 0 && text[index] === '_'; index -= 1) {
    delimiterLength += 1;
  }
  const delimiter = '_'.repeat(delimiterLength);
  return delimiterLength > 0 && path.endsWith(delimiter)
    ? path.slice(0, -delimiterLength)
    : path;
}

/** Replaces complete URLs and schemeless GitHub URLs with equal-length whitespace to prevent duplicate path scanning. */
function maskUrls(text: string): string {
  return text
    .replace(ABSOLUTE_URL_PATTERN, (match) => ' '.repeat(match.length))
    .replace(SCHEMELESS_GITHUB_URL_PATTERN, (match) => ' '.repeat(match.length));
}

/** Recursively collects string values from JSON (values only, ignoring object keys). Returns whether collection was truncated by limits. */
function collectJsonStrings(
  value: unknown,
  out: string[],
  limit: number,
  depth: number,
  maxDepth: number,
): 'ok' | 'value-limit' | 'depth-limit' {
  if (typeof value === 'string') {
    if (out.length >= limit) return 'value-limit';
    out.push(value);
    return 'ok';
  }
  if (value === null || typeof value !== 'object') return 'ok';
  if (depth >= maxDepth) return 'depth-limit';

  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  let result: 'ok' | 'value-limit' | 'depth-limit' = 'ok';
  for (const child of children) {
    const childResult = collectJsonStrings(child, out, limit, depth + 1, maxDepth);
    if (childResult === 'value-limit') return 'value-limit';
    if (childResult === 'depth-limit') result = 'depth-limit';
  }
  return result;
}

/** Deduplication key: valid candidates use repository name (case-insensitive); invalid ones use raw fragment to avoid duplicate error reports. */
function dedupeKey(candidate: ImportedRepositoryCandidate): string {
  return candidate.repositoryFullName
    ? candidate.repositoryFullName.toLowerCase()
    : `invalid:${candidate.originalValue.trim().toLowerCase()}`;
}

/**
 * Extracts repository candidates from pasted content.
 *
 * @param raw Raw input (text / Markdown / JSON string).
 * @param options Extraction options; parses JSON first when `source: 'json'` before recursively scanning string values.
 */
export function extractRepositoryCandidates(
  raw: string,
  options: RepositoryImportExtractionOptions = {},
): RepositoryImportExtractionResult {
  const source: ImportSource = options.source ?? 'text';
  const maxInputLength = options.maxInputLength ?? DEFAULT_MAX_INPUT_LENGTH;
  const maxValues = options.maxValues ?? DEFAULT_MAX_VALUES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const local = options.localRepositoryFullNames;

  if (raw.length > maxInputLength) {
    return {
      candidates: [],
      inputErrors: [
        {
          code: 'input-too-large',
          message: `Input exceeds the ${maxInputLength} character limit`,
        },
      ],
      stats: { scanned: 0, valid: 0, duplicates: 0, invalid: 0 },
    };
  }

  const inputErrors: RepositoryImportExtractionResult['inputErrors'] = [];
  // Initial version implements text / json; clipboard and file share the same extraction logic.
  let strings: string[];
  if (source === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return {
        candidates: [],
        inputErrors: [
          {
            code: 'json-parse-failed',
            message: error instanceof Error ? error.message : 'Invalid JSON',
          },
        ],
        stats: { scanned: 0, valid: 0, duplicates: 0, invalid: 0 },
      };
    }
    strings = [];
    const collected = collectJsonStrings(parsed, strings, maxValues, 0, maxDepth);
    if (collected === 'value-limit') {
      inputErrors.push({
        code: 'too-many-values',
        message: `JSON contains more than ${maxValues} string values; extraction stopped early`,
      });
    } else if (collected === 'depth-limit') {
      inputErrors.push({
        code: 'depth-limit-exceeded',
        message: `JSON nesting exceeds ${maxDepth} levels; deeper values were skipped`,
      });
    }
  } else {
    strings = [raw];
  }

  const candidates: ImportedRepositoryCandidate[] = [];
  const seen = new Map<string, ImportedRepositoryCandidate>();

  /** Records candidate; appends `duplicate` when the same key reappears, preserving order of first appearance. */
  const push = (
    repositoryFullName: string,
    originalValue: string,
    status: ImportedRepositoryCandidate['status'],
    extra: {
      reason?: ImportFailureReason;
      matchedBy?: ImportCandidateMatchedBy;
      confidence?: ImportCandidateConfidence;
    } = {},
  ) => {
    const draft: ImportedRepositoryCandidate = {
      repositoryFullName,
      source,
      originalValue,
      status,
      ...extra,
    };
    if (status === 'pending' && local?.has(repositoryFullName.toLowerCase())) {
      draft.alreadyStarred = true;
    }
    const existing = seen.get(dedupeKey(draft));
    if (existing) {
      if (existing.confidence === 'low' && draft.confidence === 'high') {
        existing.confidence = 'high';
        existing.matchedBy = 'github-url';
      }
      candidates.push({ ...draft, status: 'duplicate' });
      return;
    }
    seen.set(dedupeKey(draft), draft);
    candidates.push(draft);
  };

  for (const text of strings) {
    // Merge-sort the two match types by input position before deduplicating: scanning all URLs before bare slugs
    // would push earlier `owner/repo` fragments to the back, losing the user's pasted ordering.
    // Masking uses equal-length replacement, so index positions can be compared directly.
    const found: Array<{
      index: number;
      repositoryFullName: string;
      originalValue: string;
      status: ImportedRepositoryCandidate['status'];
      matchedBy: ImportCandidateMatchedBy;
      reason?: ImportFailureReason;
    }> = [];

    for (const match of text.matchAll(ABSOLUTE_URL_PATTERN)) {
      let url: URL;
      try {
        url = new URL(match[0]);
      } catch {
        continue;
      }
      const hostname = url.hostname.toLowerCase();
      if (hostname !== 'github.com' && hostname !== 'www.github.com') continue;
      const matchStart = match.index ?? 0;
      const path = trimMarkdownUnderscoreDelimiter(text, matchStart, url.pathname.slice(1));
      const parsed = resolveRepositoryFromGitHubUrl(path);
      const resolved = 'repositoryFullName' in parsed;
      found.push({
        index: matchStart,
        repositoryFullName: resolved ? parsed.repositoryFullName : '',
        originalValue: match[0],
        status: resolved ? 'pending' : 'invalid',
        matchedBy: 'github-url',
        reason: resolved ? undefined : parsed.reason,
      });
    }

    const withoutAbsoluteUrls = text.replace(
      ABSOLUTE_URL_PATTERN,
      (match) => ' '.repeat(match.length),
    );
    for (const match of withoutAbsoluteUrls.matchAll(SCHEMELESS_GITHUB_URL_PATTERN)) {
      const matchStart = match.index ?? 0;
      const path = trimMarkdownUnderscoreDelimiter(text, matchStart, match[1]);
      const parsed = resolveRepositoryFromGitHubUrl(path);
      const resolved = 'repositoryFullName' in parsed;
      found.push({
        index: matchStart,
        repositoryFullName: resolved ? parsed.repositoryFullName : '',
        originalValue: text.slice(matchStart, matchStart + match[0].length),
        status: resolved ? 'pending' : 'invalid',
        matchedBy: 'github-url',
        reason: resolved ? undefined : parsed.reason,
      });
    }

    // URLs have already been consumed; mask their path segments before matching bare slugs to avoid misinterpreting releases/tag etc.
    for (const match of maskUrls(text).matchAll(BARE_SLUG_PATTERN)) {
      const owner = match[2] ?? match[4];
      const repo = match[3] ?? match[5];
      const trimmedRepo = repo.replace(/[.;:!?]+$/, '');
      if (!isPlausibleBareSlug(owner, trimmedRepo)) continue;
      const fullName = normalizeRepositoryFullName(owner, trimmedRepo);
      if (!fullName) continue;
      found.push({
        index: match.index ?? 0,
        repositoryFullName: fullName,
        originalValue: match[0],
        status: 'pending',
        matchedBy: 'bare-slug',
      });
    }

    found.sort((left, right) => left.index - right.index);

    for (const entry of found) {
      push(entry.repositoryFullName, entry.originalValue, entry.status, {
        reason: entry.reason,
        matchedBy: entry.matchedBy,
        confidence: entry.matchedBy === 'github-url' ? 'high' : 'low',
      });
    }
  }

  return {
    candidates,
    inputErrors,
    stats: {
      scanned: strings.length,
      valid: candidates.filter((candidate) => candidate.status === 'pending').length,
      duplicates: candidates.filter((candidate) => candidate.status === 'duplicate').length,
      invalid: candidates.filter((candidate) => candidate.status === 'invalid').length,
    },
  };
}

/**
 * Convenience helper: derives lowercase `owner/repo` set from synced repositories for `alreadyStarred` flagging.
 * Preserves pure function semantics — does not read store during extraction. The preview phase can overlay My Apps associations etc.
 */
export function toLocalRepositoryNameSet(
  repositories: readonly Pick<Repository, 'full_name'>[] | undefined,
): Set<string> {
  return new Set((repositories ?? []).map((repository) => repository.full_name.toLowerCase()));
}
