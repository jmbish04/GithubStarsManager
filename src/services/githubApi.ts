import {
  Repository,
  Gist,
  GistFile,
  Release,
  GitHubUser,
  DiscoveryPlatform,
  ProgrammingLanguage,
  SortBy,
  SortOrder,
  PaginatedDiscoveryRepositories,
  DiscoveryRepo,
  DiscoveryChannelId,
  TopicCategory,
  TrendingTimeRange,
  SubscriptionRepo,
  SubscriptionDev,
  GitHubSearchUserResponse,
  GitHubUserDetail,
  GitHubOrganization,
  ForkRepo,
  WorkflowDefinition,
} from '../types';
import { logger } from './logger';
import { isReadmeCandidateItem, type GitHubReadmeCandidateItem } from '../utils/readmeVariants';

interface GitHubContentResponse {
  content?: string;
  encoding?: string;
  path?: string;
  sha?: string;
  size?: number;
  type?: string;
}

export interface GitHubRepositoryTreeEntry {
  path: string;
  type?: string;
  sha?: string;
  size?: number;
}

interface GitHubTreeResponse {
  sha?: string;
  tree?: GitHubRepositoryTreeEntry[];
  truncated?: boolean;
}

export interface RepositoryMetaRead {
  defaultBranch: string;
}

export interface RepositoryTreeRead {
  ref: string;
  sha?: string;
  truncated: boolean;
  entries: GitHubRepositoryTreeEntry[];
}

export interface RepositoryFileRead {
  path: string;
  ref: string;
  sha?: string;
  size: number;
  content: string;
}

/** Issue search result used by repository chat search_issues tool (body truncated to restrict size). */
export interface RepositoryIssueSearchRead {
  number: number;
  title: string;
  state: 'open' | 'closed';
  html_url: string;
  body: string;
  comments: number;
  updated_at: string;
  labels: string[];
}

/** Issue comment (used to supply solution excerpts in troubleshooting scenarios). */
export interface RepositoryIssueCommentRead {
  user: string;
  createdAt: string;
  body: string;
}

/** Raw item from repository issue list endpoint (PR items carry isPullRequest flag, callers filter as needed). */
export interface GitHubIssueListRead {
  number: number;
  title: string;
  state: 'open' | 'closed';
  html_url: string;
  body: string | null;
  created_at: string;
  updated_at: string;
  labels: string[];
  isPullRequest: boolean;
}

/** Minimal repository details field set used for weekly channel enrichment (compatible subset of Repository). */
export interface GitHubRepoDetailRead {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  forks_count: number;
  forks: number;
  language: string | null;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  topics: string[];
  owner: { login: string; avatar_url: string };
  license: string | null;
  /** Native GitHub status fields: objective source of truth for Repository Health (carried free on detail paths). */
  archived?: boolean;
  disabled?: boolean;
  fork?: boolean;
  is_template?: boolean;
  open_issues_count?: number;
  default_branch?: string;
}

interface GitHubStarredItem {
  starred_at?: string;
  repo?: Repository;
  [key: string]: unknown;
}

/**
 * Unify license values returned by GitHub into an SPDX ID string or null.
 * Accepts raw GitHub object `{ key, spdx_id, name, url }`, normalized string, or null.
 * Prioritizes spdx_id (e.g. "MIT"), falling back to key (e.g. "Other").
 */
function toLicenseSpdxId(license: unknown): string | null {
  if (license == null) return null;
  if (typeof license === 'string') return license.trim() || null;
  if (typeof license === 'object') {
    // Runtime check: malformed backup or third-party source may provide non-string spdx_id/key
    const l = license as { spdx_id?: unknown; key?: unknown };
    const spdx = typeof l.spdx_id === 'string' ? l.spdx_id.trim() : '';
    const key = typeof l.key === 'string' ? l.key.trim() : '';
    return spdx || key || null;
  }
  return null;
}

interface GitHubRateLimitResponse {
  rate: {
    remaining: number;
    reset: number;
  };
}

/**
 * Decode text (typically README rendered HTML in RSS `content:encoded`) to plain text.
 *
 * DOMParser must be used instead of assigning `innerHTML` to a detached node: the browser
 * still immediately fires resource requests for `<img>`/`<picture><source>` upon parsing—GitHub Trending RSS
 * descriptions are the rendered HTML of trending repository READMEs, and their relative image paths
 * resolve against the `file://…/dist/` document root in desktop environments, generating guaranteed
 * `ERR_FILE_NOT_FOUND` requests on each trending refresh.
 *
 * Documents created by DOMParser lack a browsing context (base URL is `about:blank`),
 * so relative asset URLs cannot resolve to requestable addresses; verified on Electron 44 / Chromium 152
 * that parsing also generates zero requests for absolute img/source/iframe URLs. Removing resource-bearing elements
 * before extracting text serves as a cross-engine fallback independent of when engines load images from inert documents.
 */
function decodeRssHtmlToText(html: string): string {
  if (!html) return '';
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll(
      'img, source, iframe, frame, video, audio, embed, object, link, script, style',
    ).forEach((el) => el.remove());
    return doc.body.textContent || '';
  } catch {
    return '';
  }
}

/** Normalize a REST issue item into GitHubIssueListRead (unwinds labels object array into names). */
function mapRestIssueListItem(item: Record<string, unknown>): GitHubIssueListRead {
  const labels = Array.isArray(item.labels)
    ? item.labels.map((label) => {
        if (label && typeof label === 'object' && typeof (label as { name?: unknown }).name === 'string') return (label as { name: string }).name;
        return '';
      }).filter(Boolean)
    : [];
  return {
    number: typeof item.number === 'number' ? item.number : 0,
    title: typeof item.title === 'string' ? item.title : '',
    state: item.state === 'closed' ? 'closed' : 'open',
    html_url: typeof item.html_url === 'string' ? item.html_url : '',
    body: typeof item.body === 'string' ? item.body : null,
    created_at: typeof item.created_at === 'string' ? item.created_at : '',
    updated_at: typeof item.updated_at === 'string' ? item.updated_at : '',
    labels,
    isPullRequest: item.pull_request != null,
  };
}

/** Normalize a REST /repos/{owner}/{repo} response into GitHubRepoDetailRead. */
function mapRestRepoDetail(data: Record<string, unknown>): GitHubRepoDetailRead {
  const owner = (data.owner as { login?: unknown; avatar_url?: unknown } | undefined) ?? {};
  return {
    id: typeof data.id === 'number' ? data.id : 0,
    name: typeof data.name === 'string' ? data.name : '',
    full_name: typeof data.full_name === 'string' ? data.full_name : '',
    description: typeof data.description === 'string' ? data.description : null,
    html_url: typeof data.html_url === 'string' ? data.html_url : '',
    stargazers_count: typeof data.stargazers_count === 'number' ? data.stargazers_count : 0,
    forks_count: typeof data.forks_count === 'number' ? data.forks_count : 0,
    forks: typeof data.forks === 'number' ? data.forks : 0,
    language: typeof data.language === 'string' ? data.language : null,
    created_at: typeof data.created_at === 'string' ? data.created_at : '',
    updated_at: typeof data.updated_at === 'string' ? data.updated_at : '',
    pushed_at: typeof data.pushed_at === 'string' ? data.pushed_at : '',
    topics: Array.isArray(data.topics) ? data.topics.filter((t): t is string => typeof t === 'string') : [],
    owner: {
      login: typeof owner.login === 'string' ? owner.login : '',
      avatar_url: typeof owner.avatar_url === 'string' ? owner.avatar_url : '',
    },
    license: toLicenseSpdxId(data.license),
    archived: data.archived === true,
    disabled: data.disabled === true,
    fork: data.fork === true,
    is_template: data.is_template === true,
    open_issues_count: typeof data.open_issues_count === 'number' ? data.open_issues_count : 0,
    default_branch: typeof data.default_branch === 'string' ? data.default_branch : '',
  };
}

/** Normalize a GraphQL Repository node into GitHubRepoDetailRead. */
function mapGraphqlRepoDetail(node: Record<string, unknown>): GitHubRepoDetailRead {
  const owner = (node.owner as { login?: unknown; avatarUrl?: unknown } | undefined) ?? {};
  const primaryLanguage = node.primaryLanguage as { name?: unknown } | null | undefined;
  const licenseInfo = node.licenseInfo as { spdxId?: unknown } | null | undefined;
  const topics: string[] = [];
  const topicNodes = (node.repositoryTopics as { nodes?: Array<{ topic?: { name?: unknown } }> } | null | undefined)?.nodes;
  if (Array.isArray(topicNodes)) {
    for (const topicNode of topicNodes) {
      const name = topicNode?.topic?.name;
      if (typeof name === 'string' && name) topics.push(name);
    }
  }
  return {
    id: typeof node.databaseId === 'number' ? node.databaseId : 0,
    name: typeof node.name === 'string' ? node.name : '',
    full_name: typeof node.nameWithOwner === 'string' ? node.nameWithOwner : '',
    description: typeof node.description === 'string' ? node.description : null,
    html_url: typeof node.url === 'string' ? node.url : '',
    stargazers_count: typeof node.stargazerCount === 'number' ? node.stargazerCount : 0,
    forks_count: typeof node.forkCount === 'number' ? node.forkCount : 0,
    forks: typeof node.forkCount === 'number' ? node.forkCount : 0,
    language: primaryLanguage && typeof primaryLanguage.name === 'string' ? primaryLanguage.name : null,
    created_at: typeof node.createdAt === 'string' ? node.createdAt : '',
    updated_at: typeof node.updatedAt === 'string' ? node.updatedAt : '',
    pushed_at: typeof node.pushedAt === 'string' ? node.pushedAt : '',
    topics,
    owner: {
      login: typeof owner.login === 'string' ? owner.login : '',
      avatar_url: typeof owner.avatarUrl === 'string' ? owner.avatarUrl : '',
    },
    license: licenseInfo && typeof licenseInfo.spdxId === 'string' ? licenseInfo.spdxId : null,
    archived: node.isArchived === true,
    disabled: node.isDisabled === true,
    fork: node.isFork === true,
    is_template: node.isTemplate === true,
    open_issues_count:
      typeof (node.openIssues as { totalCount?: unknown } | undefined)?.totalCount === 'number'
        ? (node.openIssues as { totalCount: number }).totalCount
        : 0,
    default_branch:
      typeof (node.defaultBranchRef as { name?: unknown } | null | undefined)?.name === 'string'
        ? (node.defaultBranchRef as { name: string }).name
        : '',
  };
}

const GITHUB_API_BASE = 'https://api.github.com';
// Sentinel message for the 401 thrown above; callers match on it to tell a
// confirmed auth failure apart from network/rate-limit/5xx errors.
export const GITHUB_TOKEN_INVALID_ERROR = 'GitHub token expired or invalid';

/** GitHub accepted the token, but it lacks permission for this request. */
export class GitHubTokenPermissionError extends Error {
  constructor() {
    super('Resource not accessible by personal access token');
    this.name = 'GitHubTokenPermissionError';
  }
}
// Sentinel for 401s produced by the backend proxy's own auth middleware (its
// body carries code: 'UNAUTHORIZED'). Kept distinct from the GitHub sentinel
// so callers can tell a stale backend API key from a dead GitHub token.
export const BACKEND_PROXY_UNAUTHORIZED_ERROR = 'Backend API key was rejected. Please check your backend settings';
const REPOSITORY_CHAT_MAX_FILE_BYTES = 96 * 1024;
// Larger Markdown files are common repository documentation. This bounded exception is
// deliberately narrower than the normal chat-file reader: only non-sensitive Markdown
// can use it, it remains pinned to the caller's SHA, and repository chat exposes only
// line-ranged excerpts to the model.
const REPOSITORY_CHAT_MAX_MARKDOWN_EVIDENCE_BYTES = 512 * 1024;
const REPOSITORY_CHAT_MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx', '.markdown', '.txt']);
const REPOSITORY_CHAT_ALLOWED_EXTENSIONS = new Set([
  '.md', '.mdx', '.markdown', '.txt', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.yaml', '.yml', '.toml',
  '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php', '.cs', '.c', '.h', '.cpp', '.hpp', '.vue', '.svelte',
  '.html', '.css', '.scss', '.sql', '.graphql', '.gql', '.sh', '.bash', '.zsh', '.xml', '.ini', '.properties',
]);
const REPOSITORY_CHAT_SENSITIVE_PATH = /(^|\/)(?:\.env(?:\.[^/]*)?|[^/]*(?:secret|credential|private[_-]?key|id_rsa)[^/]*|[^/]*\.(?:pem|p12|pfx|key))(?:$|\/)/i;
const REPOSITORY_CHAT_LOCK_FILE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|cargo\.lock|poetry\.lock)$/i;
const REPOSITORY_CHAT_MINIFIED_FILE = /\.min\.(?:js|css)$/i;

const isRepositoryChatSensitivePath = (path: string): boolean => {
  const pathSegments = path.split('/');
  const fileName = pathSegments[pathSegments.length - 1] || path;
  const fileNameSegments = fileName.split('.');
  const extension = fileName.includes('.') ? `.${fileNameSegments[fileNameSegments.length - 1]}`.toLowerCase() : '';
  return REPOSITORY_CHAT_SENSITIVE_PATH.test(path)
    || REPOSITORY_CHAT_LOCK_FILE.test(path)
    || REPOSITORY_CHAT_MINIFIED_FILE.test(path)
    || !REPOSITORY_CHAT_ALLOWED_EXTENSIONS.has(extension);
};

interface GitHubSearchRepoResponse {
  items: (Repository & { forks_count?: number })[];
  total_count: number;
}

export interface GistFileInput {
  filename: string;
  content: string;
}

export interface GistCreateInput {
  description: string;
  public: boolean;
  files: GistFileInput[];
}

export interface GistUpdateInput {
  description?: string;
  files?: Array<GistFileInput & { previousFilename?: string; deleted?: boolean }>;
}

export interface ReleaseFetchOptions {
  includePreRelease?: boolean;
  /**
   * When enabled, additionally checks whether the asset fingerprint for the latest release
   * of each synced repository has changed, placing entries where "assets changed but ID exists"
   * into updatedReleases so callers can merge and update them by ID.
   * Does not incur extra network requests: the latest release is obtained from page 1 of the incremental fetch (per_page=10).
   */
  refreshExistingAssets?: boolean;
}

export interface MultipleReleasesResult {
  /** Newly added releases (IDs not existing locally) */
  releases: Release[];
  /**
   * Latest release for synchronized repositories (collected only when refreshExistingAssets is enabled).
   * Used by callers to compare asset fingerprints against local storage; if the fingerprint changed, assets are merged and updated, and marked unread.
   */
  latestReleases?: Release[];
  failedRepos: { repoId: number; full_name: string; error: string }[];
}


/** Bare Boolean operators in GitHub search: discarded from untrusted keywords to prevent altering query semantics. */
const SEARCH_BOOLEAN_OPERATORS = new Set(['or', 'and', 'not']);

export class GitHubApiService {
  private token: string;
  private rateLimitRemaining: number | null = null;
  private rateLimitReset: number | null = null;
  private backendUrl: string | null = null;
  private backendAuthToken: string | null = null;

  constructor(token: string) {
    this.token = token;
  }

  /**
   * Set the backend proxy URL. When set, all requests (makeRequest / getGistFileRaw)
   * will be forwarded through the server's /api/proxy/github/* route, thus using the user's configured proxy.
   * Pass null to restore direct connection mode.
   */
  setBackendUrl(url: string | null): void {
    this.backendUrl = url;
  }

  setBackendAuthToken(token: string | null): void {
    this.backendAuthToken = token;
  }

  private getBackendHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.backendAuthToken) {
      headers.Authorization = `Bearer ${this.backendAuthToken}`;
    }
    return headers;
  }

  private async makeRequest<T>(endpoint: string, options: RequestInit & { operationTag?: string } = {}, signal?: AbortSignal): Promise<T> {
    const startTime = Date.now();
    const method = (options.method || 'GET') as string;
    const { operationTag, ...fetchOptions } = options;

    // Check rate limit before making request
    if (this.rateLimitRemaining !== null && this.rateLimitRemaining < 100 && this.rateLimitReset !== null) {
      const waitMs = (this.rateLimitReset * 1000) - Date.now();
      if (waitMs > 0) {
        logger.warn('githubApi', 'Rate limit low, waiting for reset', { remaining: this.rateLimitRemaining, resetTime: this.rateLimitReset });
        // Honor abort signal during rate limit wait
        await new Promise<void>((resolve, reject) => {
          const timeoutId = setTimeout(() => resolve(), waitMs + 1000);
          const signalHandler = () => {
            clearTimeout(timeoutId);
            reject(new Error('Aborted'));
          };
          signal?.addEventListener('abort', signalHandler);
          // Also check if already aborted
          if (signal?.aborted) {
            clearTimeout(timeoutId);
            signal?.removeEventListener('abort', signalHandler);
            reject(new Error('Aborted'));
          }
        }).catch(err => {
          if (err.message === 'Aborted') throw err;
        });
      }
    }

    // GitHub endpoints like gists occasionally return 502/503/504 (transient gateway failures); apply exponential backoff retry on 5xx here,
    // matching the backoff strategy in backendAdapter.fetchWithRetry (1s/2s/4s, up to 3 retries).
    const maxRetries = 3;
    let response: Response | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const viaProxy = this.backendUrl != null;
      try {
        if (this.backendUrl) {
          // Route via backend proxy: POST {backendUrl}/proxy/github/{endpoint}?query
          // The server handles adding auth headers, reading proxy config, and forwarding, so the client does not send Authorization.
          const proxyUrl = `${this.backendUrl}/proxy/github${endpoint}`;
          const proxyBody: Record<string, unknown> = { method };
          const requestHeaders = fetchOptions.headers as Record<string, string> | undefined;
          // Forward required headers (e.g. starred repos require star+json, POST/PATCH require JSON Content-Type)
          const acceptHeader = requestHeaders?.Accept || requestHeaders?.accept;
          const contentTypeHeader = requestHeaders?.['Content-Type'] || requestHeaders?.['content-type'];
          const proxyHeaders: Record<string, string> = {};
          if (acceptHeader) proxyHeaders.Accept = acceptHeader;
          if (contentTypeHeader) proxyHeaders['Content-Type'] = contentTypeHeader;
          if (Object.keys(proxyHeaders).length > 0) proxyBody.headers = proxyHeaders;
          if (fetchOptions.body) proxyBody.body = fetchOptions.body;

          response = await fetch(proxyUrl, {
            method: 'POST',
            signal,
            headers: this.getBackendHeaders(),
            body: JSON.stringify(proxyBody),
          });
        } else {
          response = await fetch(`${GITHUB_API_BASE}${endpoint}`, {
            ...fetchOptions,
            signal,
            headers: {
              'Authorization': `Bearer ${this.token}`,
              'Accept': 'application/vnd.github.v3+json',
              'X-GitHub-Api-Version': '2022-11-28',
              ...fetchOptions.headers,
            },
          });
        }
      } catch (fetchError) {
        const durationMs = Date.now() - startTime;
        // Network errors (disconnect, DNS timeout, socket hang-up, etc.) are treated as retryable transient failures,
        // thrown only on the final attempt; previous attempts continue with exponential backoff.
        if (attempt === maxRetries || signal?.aborted) {
          logger.error('githubApi', 'API request network error', { method, endpoint, durationMs, attempt: attempt + 1, maxRetries: maxRetries + 1, error: fetchError instanceof Error ? fetchError.message : String(fetchError) });
          throw fetchError;
        }
        logger.warn('githubApi', 'API request network error, retrying', { method, endpoint, attempt: attempt + 1, maxRetries: maxRetries + 1, durationMs, error: fetchError instanceof Error ? fetchError.message : String(fetchError) });
        const delayMs = Math.min(1000 * Math.pow(2, attempt), 4000);
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timeoutId);
            signal?.removeEventListener('abort', onAbort);
            reject(new Error('Aborted'));
          };
          const timeoutId = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          }, delayMs);
          signal?.addEventListener('abort', onAbort);
          if (signal?.aborted) onAbort();
        });
        continue;
      }

      // Parse rate limit headers
      const remaining = response.headers.get('X-RateLimit-Remaining');
      const reset = response.headers.get('X-RateLimit-Reset');
      if (remaining !== null) {
        this.rateLimitRemaining = parseInt(remaining, 10);
      }
      if (reset !== null) {
        this.rateLimitReset = parseInt(reset, 10);
      }

      if (response.ok) break;

      const durationMs = Date.now() - startTime;
      if (response.status === 401) {
        logger.warn('githubApi', 'API request failed: unauthorized', { method, endpoint, status: response.status, durationMs });
        if (viaProxy) {
          // The proxy forwards upstream GitHub bodies verbatim, while the
          // backend's own auth middleware marks its 401s with code
          // 'UNAUTHORIZED'. Only the latter is a backend API key problem.
          const body = await response.json().catch(() => null) as { code?: string } | null;
          if (body?.code === 'UNAUTHORIZED') {
            throw new Error(BACKEND_PROXY_UNAUTHORIZED_ERROR);
          }
        }
        throw new Error(GITHUB_TOKEN_INVALID_ERROR);
      }
      if (response.status === 403 && remaining === '0') {
        const resetDate = this.rateLimitReset
          ? new Date(this.rateLimitReset * 1000).toLocaleString()
          : 'unknown';
        logger.warn('githubApi', 'API request failed: rate limit exceeded', { method, endpoint, status: response.status, durationMs });
        throw new Error(`GitHub API rate limit exceeded. Resets at ${resetDate}`);
      }
      if (response.status === 403) {
        const body = await response.clone().json().catch(() => null) as { message?: string } | null;
        if (body?.message === 'Resource not accessible by personal access token') {
          logger.warn('githubApi', 'API request failed: token permission', { method, endpoint, status: response.status, durationMs });
          throw new GitHubTokenPermissionError();
        }
      }

      // 5xx errors are treated as retryable transient failures; other 4xx errors are thrown directly (retrying is futile).
      const isRetryable = response.status >= 500 && response.status <= 599;
      if (!isRetryable || attempt === maxRetries) {
        logger.warn('githubApi', 'API request failed', { method, endpoint, status: response.status, durationMs });
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }

      // If the request was aborted before retry, do not wait; throw immediately with current failure state.
      if (signal?.aborted) {
        logger.warn('githubApi', 'API request aborted before retry', { method, endpoint, status: response.status });
        throw new Error('Aborted');
      }
      const delayMs = Math.min(1000 * Math.pow(2, attempt), 4000);
      logger.warn('githubApi', 'API request failed, retrying', { method, endpoint, status: response.status, attempt: attempt + 1, maxRetries: maxRetries + 1, delayMs, durationMs });
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timeoutId);
          signal?.removeEventListener('abort', onAbort);
          reject(new Error('Aborted'));
        };
        const timeoutId = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, delayMs);
        signal?.addEventListener('abort', onAbort);
        if (signal?.aborted) onAbort();
      });
    }

    // When the loop exits normally, response is guaranteed to be assigned (broke on final success or threw in loop).
    const finalResponse = response!;

    if (logger.isDebugMode()) {
      // Capture request headers (mask auth)
      const requestHeaders: Record<string, string> = {
        'Authorization': 'Bearer ***',
        'Accept': 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.headers as Record<string, string> || {}),
      };
      // Capture response headers
      const responseHeaders: Record<string, string> = {};
      finalResponse.headers.forEach((v, k) => { responseHeaders[k] = v; });
      // Capture response body preview (clone to avoid consuming)
      let responseBody: string | undefined;
      try {
        const cloned = finalResponse.clone();
        const text = await cloned.text();
        if (text.length > 0) {
          responseBody = text.length > 4000 ? text.slice(0, 4000) + '...[truncated]' : text;
        }
      } catch { /* body not readable */ }
      logger.debug('githubApi', 'API request', {
        method, endpoint, status: finalResponse.status, durationMs: Date.now() - startTime,
        rateLimitRemaining: finalResponse.headers.get('x-ratelimit-remaining'),
        requestHeaders, responseHeaders, responseBody,
        ...(operationTag ? { operationTag } : {}),
      });
    }

    const data = finalResponse.status === 204 ? null : await finalResponse.json();

    // If it's a starred repositories response, handle special format
    if (endpoint.includes('/user/starred') && Array.isArray(data)) {
      return data.map((item: GitHubStarredItem) => {
        // If star+json format was used, data structure is different
        if (item.starred_at && item.repo) {
          return {
            ...item.repo,
            // Normalize GitHub's license value (object/string/null) to SPDX ID string or null
            license: toLicenseSpdxId(item.repo.license),
            starred_at: item.starred_at
          };
        }
        return {
          ...item,
          license: toLicenseSpdxId(item.license),
        };
      }) as T;
    }

    return data;
  }

  async getCurrentUser(): Promise<GitHubUser> {
    return this.makeRequest<GitHubUser>('/user');
  }

  async getStarredRepositories(page = 1, perPage = 100): Promise<Repository[]> {
    const repos = await this.makeRequest<Repository[]>(
      `/user/starred?page=${page}&per_page=${perPage}&sort=updated`,
      {
        headers: {
          'Accept': 'application/vnd.github.star+json'
        }
      }
    );
    return repos;
  }

  async getAllStarredRepositories(): Promise<Repository[]> {
    let allRepos: Repository[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const repos = await this.getStarredRepositories(page, perPage);
      if (repos.length === 0) break;

      allRepos = [...allRepos, ...repos];

      if (repos.length < perPage) break;
      page++;

      // Rate limiting protection
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return allRepos;
  }

  private mergeGistMetadata(existing: Gist | undefined, incoming: Gist, starred?: boolean): Gist {
    // The list API does not return file content; deep merge files to preserve previously loaded content;
    // starred only trusts explicitly passed or fresh API values, not falling back to cache, avoiding stale state after unstarring.
    const mergedFiles: Record<string, GistFile> = { ...incoming.files };
    if (existing?.files) {
      for (const [filename, file] of Object.entries(mergedFiles)) {
        const existingFile = existing.files[filename];
        if (existingFile) {
          // Prioritize retaining previously loaded complete content:
          // - incoming.content does not exist (list API does not return content)
          // - incoming is marked truncated, while existing already has complete content
          const incomingIncomplete = file.content === undefined || (file.truncated && existingFile.content !== undefined && !existingFile.truncated);
          if (incomingIncomplete && existingFile.content !== undefined) {
            mergedFiles[filename] = { ...file, content: existingFile.content, truncated: false };
          }
        }
      }
    }

    return {
      ...incoming,
      files: mergedFiles,
      starred: starred ?? incoming.starred,
      ai_summary: existing?.ai_summary,
      analyzed_at: existing?.analyzed_at,
      analysis_failed: existing?.analysis_failed,
      analysis_error: existing?.analysis_error,
      last_edited: existing?.last_edited,
    };
  }

  async getGists(page = 1, perPage = 100): Promise<Gist[]> {
    return this.makeRequest<Gist[]>(`/gists?page=${page}&per_page=${perPage}`);
  }

  async getAllGists(existingGists: Gist[] = []): Promise<Gist[]> {
    let allGists: Gist[] = [];
    let page = 1;
    const perPage = 100;
    const existingById = new Map(existingGists.map(gist => [gist.id, gist]));

    while (true) {
      const gists = await this.getGists(page, perPage);
      if (gists.length === 0) break;

      allGists = [
        ...allGists,
        ...gists.map(gist => this.mergeGistMetadata(existingById.get(gist.id), gist)),
      ];

      if (gists.length < perPage) break;
      page++;
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return allGists;
  }

  async getStarredGists(page = 1, perPage = 100): Promise<Gist[]> {
    return this.makeRequest<Gist[]>(`/gists/starred?page=${page}&per_page=${perPage}`);
  }

  async getAllStarredGists(existingGists: Gist[] = []): Promise<Gist[]> {
    let allGists: Gist[] = [];
    let page = 1;
    const perPage = 100;
    const existingById = new Map(existingGists.map(gist => [gist.id, gist]));

    while (true) {
      const gists = await this.getStarredGists(page, perPage);
      if (gists.length === 0) break;

      allGists = [
        ...allGists,
        ...gists.map(gist => this.mergeGistMetadata(existingById.get(gist.id), gist, true)),
      ];

      if (gists.length < perPage) break;
      page++;
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return allGists;
  }

  async getGist(gistId: string, existing?: Gist): Promise<Gist> {
    const gist = await this.makeRequest<Gist>(`/gists/${encodeURIComponent(gistId)}`);
    return this.mergeGistMetadata(existing, gist, existing?.starred);
  }

  /**
   * Fetch gist for AI analysis. Normally uses detail API; if detail API returns 5xx (e.g. certain gists consistently 502),
   * fall back to cached metadata + raw_url to fetch file contents, ensuring analysis continues uninterrupted.
   */
  async getGistForAnalysis(gistId: string, existing?: Gist, signal?: AbortSignal): Promise<Gist> {
    try {
      return await this.getGist(gistId, existing);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isServerFailure = /5\d{2}/.test(msg);
      if (!isServerFailure || !existing) throw err;

      // Fallback: use existing metadata, fetching file contents individually from raw_url
      const files = { ...existing.files };
      const entries = Object.entries(files);
      await Promise.all(entries.map(async ([filename, file]) => {
        if (file.content || !file.raw_url) return;
        try {
          const content = await this.getGistFileRaw(file.raw_url, signal);
          files[filename] = { ...file, content, truncated: false };
        } catch { /* Single-file failure does not affect other files */ }
      }));
      return { ...existing, files };
    }
  }

  /**
   * Fetch raw content for a single gist file.
   * Used as fallback retrieval when GitHub gist details API returns truncated:true (file >1MB, content omitted).
   * raw_url points to gist.githubusercontent.com and cannot reuse makeRequest (which prepends GITHUB_API_BASE).
   * Routed via server proxy (using user-configured proxy) when backendUrl is set; otherwise direct.
   */
  async getGistFileRaw(rawUrl: string, signal?: AbortSignal): Promise<string> {
    if (this.backendUrl) {
      const proxyUrl = `${this.backendUrl}/proxy/github-raw`;
      const response = await fetch(proxyUrl, {
        method: 'POST',
        signal,
        headers: this.getBackendHeaders(),
        body: JSON.stringify({ url: rawUrl }),
      });
      if (!response.ok) {
        // Attempt to extract message from JSON error body
        let detail = response.statusText;
        try { const data = await response.json(); detail = (data as { error?: string }).error || detail; } catch { /* ignore */ }
        throw new Error(`GitHub raw proxy error: ${response.status} ${detail}`);
      }
      return response.text();
    }

    const response = await fetch(rawUrl, {
      signal,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Accept': 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }
    return response.text();
  }

  async createGist(input: GistCreateInput): Promise<Gist> {
    const files = input.files.reduce<Record<string, { content: string }>>((acc, file) => {
      acc[file.filename] = { content: file.content };
      return acc;
    }, {});

    return this.makeRequest<Gist>('/gists', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        description: input.description,
        public: input.public,
        files,
      }),
    });
  }

  async updateGist(gistId: string, input: GistUpdateInput, existing?: Gist): Promise<Gist> {
    const files = (input.files || []).reduce<Record<string, { content?: string; filename?: string } | null>>((acc, file) => {
      if (file.deleted) {
        acc[file.previousFilename || file.filename] = null;
        return acc;
      }

      acc[file.previousFilename || file.filename] = {
        content: file.content,
        ...(file.previousFilename && file.previousFilename !== file.filename ? { filename: file.filename } : {}),
      };
      return acc;
    }, {});

    const payload: Record<string, unknown> = {};
    if (input.description !== undefined) payload.description = input.description;
    if (Object.keys(files).length > 0) payload.files = files;

    const gist = await this.makeRequest<Gist>(`/gists/${encodeURIComponent(gistId)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    return this.mergeGistMetadata(existing, gist, existing?.starred);
  }

  async deleteGist(gistId: string): Promise<void> {
    await this.makeRequest<void>(`/gists/${encodeURIComponent(gistId)}`, {
      method: 'DELETE',
    });
  }

  async unstarGist(gistId: string): Promise<void> {
    await this.makeRequest<void>(`/gists/${encodeURIComponent(gistId)}/star`, {
      method: 'DELETE',
    });
  }

  async starGist(gistId: string): Promise<void> {
    await this.makeRequest<void>(`/gists/${encodeURIComponent(gistId)}/star`, {
      method: 'PUT',
    });
  }

  getGistContentPreview(gist: Gist, maxChars = 6000): string {
    return Object.values(gist.files || {})
      .map((file: GistFile) => {
        const content = file.content || '';
        return `### ${file.filename}\n${content.slice(0, maxChars)}`;
      })
      .join('\n\n')
      .slice(0, maxChars);
  }

  async getWatchedRepositories(page = 1, perPage = 100): Promise<Repository[]> {
    // GitHub also returns raw license objects for watched repos, normalized here to SPDX ID / null,
    // consistent with /user/starred to prevent downstream normalizeLicense from crashing on objects.
    // Empty response bodies (204) are normalized to null by makeRequest, treated here as an empty list to avoid .map throwing and breaking sync.
    const repos = await this.makeRequest<Repository[] | null>(`/user/subscriptions?page=${page}&per_page=${perPage}`);
    return (repos ?? []).map((repo) => ({ ...repo, license: toLicenseSpdxId(repo.license) }));
  }

  async getAllWatchedRepositories(): Promise<Repository[]> {
    let allRepos: Repository[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const repos = await this.getWatchedRepositories(page, perPage);
      if (repos.length === 0) break;

      allRepos = [...allRepos, ...repos];

      if (repos.length < perPage) break;
      page++;

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return allRepos;
  }

  private decodeContentResponse(response: GitHubContentResponse): string {
    if (response.encoding === 'base64' && response.content) {
      // Use TextDecoder to properly handle UTF-8 encoding and prevent character corruption
      const binaryString = atob(response.content.replace(/\s/g, ''));
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return new TextDecoder('utf-8').decode(bytes);
    }
    return response.content || '';
  }

  private encodeContentPath(path: string): string {
    return path.split('/').map(encodeURIComponent).join('/');
  }

  async getRepositoryMeta(owner: string, repo: string, signal?: AbortSignal): Promise<RepositoryMetaRead> {
    const response = await this.makeRequest<{ default_branch?: unknown }>(
      `/repos/${owner}/${repo}`,
      { operationTag: 'repository-chat:meta' },
      signal,
    );
    if (typeof response.default_branch !== 'string' || !response.default_branch.trim()) {
      throw new Error('GitHub did not return a default branch for this repository');
    }
    return { defaultBranch: response.default_branch };
  }

  async getRepositoryHeadSha(owner: string, repo: string, branch: string, signal?: AbortSignal): Promise<string> {
    const response = await this.makeRequest<{ sha?: unknown }>(
      `/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
      { operationTag: 'repository-chat:head-sha' },
      signal,
    );
    if (typeof response.sha !== 'string' || !response.sha.trim()) {
      throw new Error('GitHub did not return a commit SHA for the default branch');
    }
    return response.sha;
  }

  async getRepositoryTree(owner: string, repo: string, ref: string, signal?: AbortSignal): Promise<RepositoryTreeRead> {
    const response = await this.makeRequest<GitHubTreeResponse>(
      `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      { operationTag: 'repository-chat:tree' },
      signal,
    );
    return {
      ref,
      sha: response.sha,
      truncated: response.truncated === true,
      entries: Array.isArray(response.tree) ? response.tree.filter((entry) => typeof entry.path === 'string') : [],
    };
  }

  async getRepositoryFile(owner: string, repo: string, path: string, ref: string, signal?: AbortSignal): Promise<RepositoryFileRead> {
    const normalizedPath = path.replace(/^\/+/, '');
    if (!normalizedPath || normalizedPath.includes('..') || normalizedPath.includes('\\')) {
      throw new Error('Invalid repository file path');
    }
    if (isRepositoryChatSensitivePath(normalizedPath)) {
      throw new Error('This file is excluded from repository chat for safety');
    }

    const response = await this.makeRequest<GitHubContentResponse>(
      `/repos/${owner}/${repo}/contents/${this.encodeContentPath(normalizedPath)}?ref=${encodeURIComponent(ref)}`,
      { operationTag: 'repository-chat:file' },
      signal,
    );
    if (response.type && response.type !== 'file') {
      throw new Error('The requested repository path is not a text file');
    }
    if (typeof response.size === 'number' && response.size > REPOSITORY_CHAT_MAX_FILE_BYTES) {
      throw new Error('The requested file exceeds the 96 KB repository chat limit');
    }

    const content = this.decodeContentResponse(response);
    const contentSize = new TextEncoder().encode(content).byteLength;
    if (contentSize > REPOSITORY_CHAT_MAX_FILE_BYTES) {
      throw new Error('The requested file exceeds the 96 KB repository chat limit');
    }
    return {
      path: response.path || normalizedPath,
      ref,
      sha: response.sha,
      size: typeof response.size === 'number' ? response.size : contentSize,
      content,
    };
  }

  async getRepositoryMarkdownEvidenceFile(owner: string, repo: string, path: string, ref: string, signal?: AbortSignal): Promise<RepositoryFileRead> {
    const normalizedPath = path.replace(/^\/+/, '');
    if (!normalizedPath || normalizedPath.includes('..') || normalizedPath.includes('\\')) {
      throw new Error('Invalid repository file path');
    }
    if (isRepositoryChatSensitivePath(normalizedPath)) {
      throw new Error('This file is excluded from repository chat for safety');
    }
    const fileName = normalizedPath.split('/').pop() || normalizedPath;
    const extension = fileName.includes('.') ? `.${fileName.split('.').pop()}`.toLowerCase() : '';
    if (!REPOSITORY_CHAT_MARKDOWN_EXTENSIONS.has(extension)) {
      throw new Error('The requested repository evidence path is not Markdown text');
    }

    const response = await this.makeRequest<GitHubContentResponse>(
      `/repos/${owner}/${repo}/contents/${this.encodeContentPath(normalizedPath)}?ref=${encodeURIComponent(ref)}`,
      { operationTag: 'repository-chat:markdown-evidence' },
      signal,
    );
    if (response.type && response.type !== 'file') {
      throw new Error('The requested repository path is not a text file');
    }
    if (typeof response.size === 'number' && response.size > REPOSITORY_CHAT_MAX_MARKDOWN_EVIDENCE_BYTES) {
      throw new Error('The requested Markdown file exceeds the 512 KB repository chat evidence limit');
    }

    const content = this.decodeContentResponse(response);
    const contentSize = new TextEncoder().encode(content).byteLength;
    if (contentSize > REPOSITORY_CHAT_MAX_MARKDOWN_EVIDENCE_BYTES) {
      throw new Error('The requested Markdown file exceeds the 512 KB repository chat evidence limit');
    }
    return {
      path: response.path || normalizedPath,
      ref,
      sha: response.sha,
      size: typeof response.size === 'number' ? response.size : contentSize,
      content,
    };
  }

  async getRepositoryReadme(owner: string, repo: string, signal?: AbortSignal): Promise<string> {
    try {
      const response = await this.makeRequest<GitHubContentResponse>(
        `/repos/${owner}/${repo}/readme`,
        undefined,
        signal
      );

      return this.decodeContentResponse(response);
    } catch (error) {
      logger.warn('githubApi', `Failed to fetch README for ${owner}/${repo}`, error);
      return '';
    }
  }

  async listRepositoryReadmeCandidates(owner: string, repo: string, defaultBranch?: string, signal?: AbortSignal): Promise<GitHubReadmeCandidateItem[]> {
    const fetchRootContents = async (): Promise<GitHubReadmeCandidateItem[]> => {
      const rootItems = await this.makeRequest<GitHubReadmeCandidateItem[]>(
        `/repos/${owner}/${repo}/contents`,
        undefined,
        signal
      );
      return rootItems.filter(isReadmeCandidateItem);
    };

    let branch = defaultBranch;
    if (!branch) {
      try {
        const repoDetails = await this.makeRequest<{ default_branch?: string }>(
          `/repos/${owner}/${repo}`,
          undefined,
          signal
        );
        branch = repoDetails.default_branch;
      } catch (error) {
        logger.warn('githubApi', `Failed to fetch default branch for ${owner}/${repo}`, error);
      }
    }

    if (!branch) {
      try {
        return await fetchRootContents();
      } catch (error) {
        logger.warn('githubApi', `Failed to list README candidates for ${owner}/${repo}`, error);
        return [];
      }
    }

    try {
      const tree = await this.makeRequest<GitHubTreeResponse>(
        `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
        undefined,
        signal
      );
      const candidates = (tree.tree || []).filter(isReadmeCandidateItem);
      if (tree.truncated) {
        logger.warn('githubApi', `README candidate tree was truncated for ${owner}/${repo}`);
        if (candidates.length === 0) return await fetchRootContents();
      }
      return candidates;
    } catch (error) {
      logger.warn('githubApi', `Failed to list README candidates from tree for ${owner}/${repo}`, error);
      try {
        return await fetchRootContents();
      } catch (contentsError) {
        logger.warn('githubApi', `Failed to list README candidates from root contents for ${owner}/${repo}`, contentsError);
        return [];
      }
    }
  }

  async getRepositoryReadmeByPath(owner: string, repo: string, path: string, signal?: AbortSignal): Promise<string> {
    try {
      const response = await this.makeRequest<GitHubContentResponse>(
        `/repos/${owner}/${repo}/contents/${this.encodeContentPath(path)}`,
        undefined,
        signal
      );

      return this.decodeContentResponse(response);
    } catch (error) {
      logger.warn('githubApi', `Failed to fetch README ${path} for ${owner}/${repo}`, error);
      return '';
    }
  }

  async getRepositoryReleasesPage(
    owner: string,
    repo: string,
    page = 1,
    perPage = 30,
    signal?: AbortSignal,
  ): Promise<{ releases: Release[]; hasMore: boolean }> {
    try {
      const rawReleases = await this.makeRequest<Array<Release & { draft?: boolean; published_at: string | null }>>(
        `/repos/${owner}/${repo}/releases?page=${page}&per_page=${perPage}`,
        { operationTag: 'release' },
        signal,
      );

      return {
        releases: rawReleases
          .filter((release) => release.draft !== true && typeof release.published_at === 'string')
          .map(release => ({
            id: release.id,
            tag_name: release.tag_name,
            name: release.name || release.tag_name,
            body: release.body || '',
            published_at: release.published_at,
            html_url: release.html_url,
            assets: release.assets || [],
            zipball_url: release.zipball_url,
            tarball_url: release.tarball_url,
            prerelease: release.prerelease ?? false,
            repository: {
              id: 0,
              full_name: `${owner}/${repo}`,
              name: repo,
            },
          })),
        hasMore: rawReleases.length === perPage,
      };
    } catch (error) {
      logger.warn('githubApi', `Failed to fetch releases for ${owner}/${repo}`, error);
      throw error;
    }
  }

  async getRepositoryReleases(
    owner: string,
    repo: string,
    page = 1,
    perPage = 30,
    signal?: AbortSignal,
  ): Promise<Release[]> {
    const result = await this.getRepositoryReleasesPage(owner, repo, page, perPage, signal);
    return result.releases;
  }

  /**
   * Fetch all releases for a repository with pagination.
   * New repos (never synced) use this for full sync - paginates until exhausted.
   */
  async fetchAllReleasesForRepo(owner: string, repo: string): Promise<Release[]> {
    const allReleases: Release[] = [];
    let page = 1;

    while (true) {
      const { releases, hasMore } = await this.getRepositoryReleasesPage(owner, repo, page, 30);

      allReleases.push(...releases);

      if (!hasMore) break;
      page++;

      // Rate limiting protection between pages
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return allReleases;
  }

  /**
   * Search repository issues by keywords (open + closed, sorted by best-match).
   * Used by the repository chat search_issues tool: the search API has an independent rate limit
   * (30 requests/minute after authentication), so callers invoke it at most once per turn.
   */
  async searchRepositoryIssues(
    owner: string,
    repo: string,
    keywords: string[],
    options: { perPage?: number; signal?: AbortSignal } = {},
  ): Promise<RepositoryIssueSearchRead[]> {
    const perPage = Math.min(20, Math.max(1, options.perPage ?? 8));
    // Keywords come from the model and user questions (untrusted input): tokenize by whitespace and keep only "plain text" tokens.
    // Discard tokens with colons (key:value qualifiers anywhere), parentheses (grouping qualifiers), and -/+ prefixes
    // (unary operators), as well as bare Boolean operators, preventing `repo:other/repo`, `is:pr`,
    // `OR (repo:x/y)`, `-repo:owner/repo`, etc., from altering the fixed repository scope or leaking PRs.
    const sanitizedKeywords = keywords
      .flatMap((keyword) => keyword.split(/\s+/))
      .filter((token) => {
        if (!token || token.includes(':') || token.includes('(') || token.includes(')')) return false;
        if (/^[-+]/.test(token)) return false;
        return !SEARCH_BOOLEAN_OPERATORS.has(token.toLowerCase());
      });
    // Do not issue search without plain text keywords: bare queries with only repo/is:issue would match
    // any issue in the repo, returning evidence irrelevant to the question.
    if (sanitizedKeywords.length === 0) return [];
    const query = [`repo:${owner}/${repo}`, 'is:issue', ...sanitizedKeywords]
      .filter(Boolean)
      .join(' ');
    const endpoint = `/search/issues?q=${encodeURIComponent(query)}&per_page=${perPage}`;
    const response = await this.makeRequest<{ total_count?: number; items?: Array<Record<string, unknown>> }>(
      endpoint,
      { operationTag: 'issue-search' },
      options.signal,
    );
    const items = Array.isArray(response.items) ? response.items : [];
    return items.map((item) => {
      const state: 'open' | 'closed' = item.state === 'closed' ? 'closed' : 'open';
      const labels = Array.isArray(item.labels)
        ? item.labels.map((label) => {
            if (label && typeof label === 'object' && typeof (label as { name?: unknown }).name === 'string') return (label as { name: string }).name;
            return '';
          }).filter(Boolean).slice(0, 6)
        : [];
      return {
        number: typeof item.number === 'number' ? item.number : 0,
        title: typeof item.title === 'string' ? item.title : '',
        state,
        html_url: typeof item.html_url === 'string' ? item.html_url : '',
        // Truncate search result body here to keep response payload manageable; the digest layer enforces tighter limits.
        body: typeof item.body === 'string' ? item.body.slice(0, 8_000) : '',
        comments: typeof item.comments === 'number' ? item.comments : 0,
        updated_at: typeof item.updated_at === 'string' ? item.updated_at : '',
        labels,
      };
    }).filter((issue) => issue.number > 0);
  }

  /** Fetch comments for a single issue (chronological order) to supplement solutions for troubleshooting scenarios. */
  async getRepositoryIssueComments(
    owner: string,
    repo: string,
    issueNumber: number,
    options: { perPage?: number; signal?: AbortSignal } = {},
  ): Promise<RepositoryIssueCommentRead[]> {
    const perPage = Math.min(30, Math.max(1, options.perPage ?? 10));
    const response = await this.makeRequest<Array<Record<string, unknown>>>(
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${perPage}`,
      { operationTag: 'issue-comments' },
      options.signal,
    );
    return (Array.isArray(response) ? response : []).map((comment) => ({
      user: (comment.user as { login?: unknown } | undefined)?.login ? String((comment.user as { login: unknown }).login) : 'unknown',
      createdAt: typeof comment.created_at === 'string' ? comment.created_at : '',
      body: typeof comment.body === 'string' ? comment.body.slice(0, 4_000) : '',
    }));
  }

  /**
   * Paginate repository issues (state=all includes closed issues; sorted by updated for use with since
   * in incremental sync; PR entries are marked with isPullRequest and filtered by the caller).
   */
  async listRepositoryIssues(
    owner: string,
    repo: string,
    options: {
      state?: 'open' | 'closed' | 'all';
      sort?: 'created' | 'updated' | 'comments';
      direction?: 'asc' | 'desc';
      since?: string;
      perPage?: number;
      page?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<GitHubIssueListRead[]> {
    const params = new URLSearchParams({
      state: options.state ?? 'all',
      sort: options.sort ?? 'created',
      direction: options.direction ?? 'desc',
      per_page: String(Math.min(100, Math.max(1, options.perPage ?? 100))),
      page: String(Math.max(1, options.page ?? 1)),
    });
    if (options.since) params.set('since', options.since);
    const response = await this.makeRequest<Array<Record<string, unknown>>>(
      `/repos/${owner}/${repo}/issues?${params.toString()}`,
      { operationTag: 'issue-list' },
      options.signal,
    );
    return (Array.isArray(response) ? response : []).map(mapRestIssueListItem).filter((issue) => issue.number > 0);
  }

  /** Fetch full body of a single issue (fallback path when weekly "view original post" cache is missing). */
  async getRepositoryIssue(owner: string, repo: string, issueNumber: number, signal?: AbortSignal): Promise<GitHubIssueListRead> {
    const item = await this.makeRequest<Record<string, unknown>>(
      `/repos/${owner}/${repo}/issues/${issueNumber}`,
      { operationTag: 'issue-list' },
      signal,
    );
    return mapRestIssueListItem(item);
  }

  /** Fetch repository details (weekly channel REST fallback per-repository completion path). */
  async getRepositoryDetails(owner: string, repo: string, signal?: AbortSignal): Promise<GitHubRepoDetailRead> {
    const data = await this.makeRequest<Record<string, unknown>>(
      `/repos/${owner}/${repo}`,
      { operationTag: 'repo-detail' },
      signal,
    );
    return mapRestRepoDetail(data);
  }

  /**
   * Batch fetch repository details (GraphQL alias batching, default 100/request, 150ms interval per batch).
   * Returns a Map keyed by lowercase full_name passed by caller; value is null if repo does not exist or is inaccessible.
   * Throws if the entire batch request fails (network/proxy unsupported/auth), letting caller decide whether to fall back to REST per-repo completion.
   */
  async graphqlFetchRepositories(
    fullNames: string[],
    options: { signal?: AbortSignal; batchSize?: number; onBatchDone?: (doneBatches: number, totalBatches: number) => void } = {},
  ): Promise<Map<string, GitHubRepoDetailRead | null>> {
    const result = new Map<string, GitHubRepoDetailRead | null>();
    const fullNamePattern = /^[^/\s]+\/[^/\s]+$/;
    const validFullNames = fullNames.filter((fullName) => fullNamePattern.test(fullName));
    const validSet = new Set(validFullNames);
    for (const fullName of fullNames) {
      if (!validSet.has(fullName)) result.set(fullName.toLowerCase(), null);
    }
    const batchSize = Math.min(100, Math.max(1, options.batchSize ?? 100));
    const batches: string[][] = [];
    for (let i = 0; i < validFullNames.length; i += batchSize) {
      batches.push(validFullNames.slice(i, i + batchSize));
    }
    const escapeGraphQlString = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      const aliases = batch.map((fullName, idx) => {
        const [owner, name] = fullName.split('/');
        return `a${idx}: repository(owner: "${escapeGraphQlString(owner)}", name: "${escapeGraphQlString(name)}") { ...WeeklyRepoDetailFragment }`;
      });
      const query = `query WeeklyRepoBatch {\n${aliases.join('\n')}\n}\nfragment WeeklyRepoDetailFragment on Repository {\n  databaseId\n  name\n  nameWithOwner\n  description\n  url\n  stargazerCount\n  forkCount\n  primaryLanguage { name }\n  createdAt\n  updatedAt\n  pushedAt\n  repositoryTopics(first: 20) { nodes { topic { name } } }\n  owner { login avatarUrl }\n  licenseInfo { spdxId }\n  isArchived\n  isDisabled\n  isFork\n  isTemplate\n  openIssues { totalCount }\n  defaultBranchRef { name }\n}`;
      const response = await this.makeRequest<{ data?: Record<string, unknown> | null; errors?: Array<{ message?: string }> }>(
        '/graphql',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
          operationTag: 'graphql-repo-batch',
        },
        options.signal,
      );
      if (!response.data || typeof response.data !== 'object') {
        const message = response.errors?.map((e) => e.message ?? '').filter(Boolean).join('; ');
        throw new Error(message ? `GraphQL batch failed: ${message}` : 'GraphQL batch failed: empty data');
      }
      batch.forEach((fullName, idx) => {
        const node = response.data![`a${idx}`];
        result.set(fullName.toLowerCase(), node && typeof node === 'object' ? mapGraphqlRepoDetail(node as Record<string, unknown>) : null);
      });
      options.onBatchDone?.(batchIndex + 1, batches.length);
      if (batchIndex < batches.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    return result;
  }

  async getMultipleRepositoryReleases(
    repositories: Repository[],
    options: ReleaseFetchOptions = {}
  ): Promise<MultipleReleasesResult> {
    const startTime = Date.now();
    const { includePreRelease = true, refreshExistingAssets = false } = options;
    const allReleases: Release[] = [];
    const latestReleases: Release[] = [];
    const failedRepos: { repoId: number; full_name: string; error: string }[] = [];

    // Controlled concurrency: process 3 repos at a time
    const concurrency = 3;
    let index = 0;

    const workers = Array.from({ length: Math.min(concurrency, repositories.length) }, async () => {
      while (true) {
        const currentIndex = index++;
        if (currentIndex >= repositories.length) break;

        const repo = repositories[currentIndex];
        const [owner, name] = repo.full_name.split('/');

        try {
          let releases: Release[];

          if (!repo.has_fetched_releases) {
            // New subscription: full sync (fetch up to 30)
            releases = await this.fetchAllReleasesForRepo(owner, name);
          } else {
            // Already synced: incremental sync with pagination until we cross the watermark
            const sinceTime = repo.last_release_fetch_time
              ? new Date(repo.last_release_fetch_time)
              : null;

            let page = 1;
            releases = [];
            // Asset refresh: collect "the latest release per repo that matches pre-release filtering".
            // When includePreRelease=false and initial pages are all pre-releases, continue paginating for the latest official release;
            // stopping at page=1 would miss changes to official release assets.
            let collectedLatest = false;
            while (true) {
              const { releases: batch, hasMore } = await this.getRepositoryReleasesPage(owner, name, page, 10);

              if (batch.length === 0 && !hasMore) break;

              if (refreshExistingAssets && !collectedLatest && batch.length > 0) {
                const latest = includePreRelease
                  ? batch[0]
                  : batch.find(r => !r.prerelease);
                if (latest) {
                  latest.repository.id = repo.id;
                  latestReleases.push(latest);
                  collectedLatest = true;
                }
              }

              const fresh = sinceTime
                ? batch.filter(r => new Date(r.published_at) > sinceTime)
                : batch;

              releases.push(...fresh);

              // If the latest release matching filters hasn't been collected yet, keep paginating even after reaching the watermark
              // until a candidate is found or pages are exhausted (avoids missing official releases when the first 10 entries are pre-releases).
              const needMoreForLatest = refreshExistingAssets && !collectedLatest && hasMore;
              if (needMoreForLatest) {
                page++;
                continue;
              }

              // Stop if we hit the watermark or ran out of data
              if (
                !hasMore ||
                (sinceTime && batch.some(r => new Date(r.published_at) <= sinceTime))
              ) {
                break;
              }

              page++;
            }
          }

          // Add repository info to releases
          releases.forEach(release => {
            release.repository.id = repo.id;
          });

          // Filter by pre-release setting
          if (!includePreRelease) {
            releases = releases.filter(r => !r.prerelease);
          }

          allReleases.push(...releases);
        } catch (error) {
          failedRepos.push({
            repoId: repo.id,
            full_name: repo.full_name,
            error: error instanceof Error ? error.message : String(error)
          });
        }

        // Rate limiting protection between repos
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    });

    await Promise.all(workers);

    // Sort by published date (newest first)
    const sortedReleases = allReleases.sort((a, b) =>
      new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
    );

    logger.info('githubApi', 'Update releases completed', { repoCount: repositories.length, releaseCount: sortedReleases.length, latestReleaseCount: latestReleases.length, durationMs: Date.now() - startTime });

    if (refreshExistingAssets) {
      const latest = includePreRelease
        ? latestReleases
        : latestReleases.filter(r => !r.prerelease);
      return { releases: sortedReleases, latestReleases: latest, failedRepos };
    }
    return { releases: sortedReleases, failedRepos };
  }

  // Fetch incremental releases for repository (timestamp-based)
  async getIncrementalRepositoryReleases(
    owner: string,
    repo: string,
    since?: string,
    perPage = 10
  ): Promise<Release[]> {
    try {
      const endpoint = `/repos/${owner}/${repo}/releases?per_page=${perPage}`;

      const releases = await this.makeRequest<Release[]>(endpoint, { operationTag: 'release' });

      const mappedReleases = releases.map(release => ({
        id: release.id,
        tag_name: release.tag_name,
        name: release.name || release.tag_name,
        body: release.body || '',
        published_at: release.published_at,
        html_url: release.html_url,
        assets: release.assets || [],
        zipball_url: release.zipball_url,
        tarball_url: release.tarball_url,
        prerelease: release.prerelease ?? false,
        repository: {
          id: 0,
          full_name: `${owner}/${repo}`,
          name: repo,
        },
      }));

      // If a since timestamp is provided, return only newer releases
      if (since) {
        const sinceDate = new Date(since);
        return mappedReleases.filter(release =>
          new Date(release.published_at) > sinceDate
        );
      }

      return mappedReleases;
    } catch (error) {
      logger.warn('githubApi', `Failed to fetch incremental releases for ${owner}/${repo}`, error);
      return [];
    }
  }

  async unstarRepository(owner: string, repo: string): Promise<void> {
    await this.makeRequest<void>(`/user/starred/${owner}/${repo}`, {
      method: 'DELETE',
    });
  }

  async starRepository(owner: string, repo: string): Promise<void> {
    await this.makeRequest<void>(`/user/starred/${owner}/${repo}`, {
      method: 'PUT',
    });
  }

  /** GitHub returns 204 for a starred repository and 404 when it is not starred. */
  async isRepositoryStarred(owner: string, repo: string): Promise<boolean> {
    try {
      await this.makeRequest<void>(`/user/starred/${owner}/${repo}`);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('GitHub API error: 404 ')) {
        return false;
      }
      throw error;
    }
  }

  async checkRateLimit(): Promise<{ remaining: number; reset: number }> {
    const response = await this.makeRequest<GitHubRateLimitResponse>('/rate_limit');
    return {
      remaining: response.rate.remaining,
      reset: response.rate.reset,
    };
  }

  private buildPlatformQuery(platform: DiscoveryPlatform): string {
    switch (platform) {
      case 'Android':
        return 'android';
      case 'Macos':
        return 'macos OR mac OR osx';
      case 'Windows':
        return 'windows';
      case 'Linux':
        return 'linux';
      case 'All':
      default:
        return '';
    }
  }

  async searchMostStars(perPage = 10): Promise<SubscriptionRepo[]> {
    const data = await this.makeRequest<GitHubSearchRepoResponse>(
      `/search/repositories?q=stars:>1000&sort=stars&order=desc&per_page=${perPage}`
    );
    return (data.items || []).map((repo, index) => ({
      ...repo,
      rank: index + 1,
      channel: 'most-stars' as const,
    }));
  }

  async searchMostForks(perPage = 10): Promise<SubscriptionRepo[]> {
    const data = await this.makeRequest<GitHubSearchRepoResponse>(
      `/search/repositories?q=forks:>1000&sort=forks&order=desc&per_page=${perPage}`
    );
    return (data.items || []).map((repo, index) => ({
      ...repo,
      rank: index + 1,
      channel: 'most-forks' as const,
      forks_count: repo.forks_count,
    }));
  }

  async searchTrending(perPage = 10, timeRange: 'daily' | 'weekly' | 'monthly' = 'weekly'): Promise<SubscriptionRepo[]> {
    const startTime = Date.now();
    // Use GitHubTrendingRSS API
    const rssUrl = `https://mshibanami.github.io/GitHubTrendingRSS/${timeRange}/all.xml`;

    try {
      const response = await fetch(rssUrl, {
        headers: { 'Accept': 'application/rss+xml, application/xml, text/xml' }
      });

      if (!response.ok) {
        throw new Error(`RSS fetch failed: ${response.status}`);
      }

      const text = await response.text();
      const parser = new DOMParser();
      const xml = parser.parseFromString(text, 'text/xml');
      const items = xml.querySelectorAll('item');

      const repos: SubscriptionRepo[] = [];
      for (let i = 0; i < Math.min(items.length, perPage); i++) {
        const item = items[i];
        const title = item.querySelector('title')?.textContent || '';
        const link = item.querySelector('link')?.textContent || '';
        // The description element contains rendered README content, not the repository description;
        // only used below to extract stars/forks indicators, never written to repo.description
        const descriptionEl = item.querySelector('description');
        let readmeText = descriptionEl?.textContent || '';
        // Decode HTML entities (avoid innerHTML: detached node assignment still parses and immediately
        // triggers <img>/<source> asset requests; relative images in trending repo READMEs resolve against
        // the file:// document root in desktop environments, causing a barrage of file 404s on each trending refresh)
        readmeText = decodeRssHtmlToText(readmeText) || readmeText;
        // Clean up excess whitespace
        readmeText = readmeText.replace(/\s+/g, ' ').trim();

        // Parse link to extract owner/repo format
        const match = link.match(/github\.com\/([^/]+)\/([^/?#]+)/);
        const owner = match?.[1] || '';
        const repoName = match?.[2] || title;

        // Extract stars and forks from RSS text (legacy feed format like "⭐ 1,234 | 🍴 456")
        const starsMatch = readmeText.match(/⭐\s*([\d,]+)/);
        const forksMatch = readmeText.match(/🍴\s*([\d,]+)/);
        const stars = starsMatch ? parseInt(starsMatch[1].replace(/,/g, '')) : 0;
        const forks = forksMatch ? parseInt(forksMatch[1].replace(/,/g, '')) : 0;

        repos.push({
          id: i + 1,
          name: repoName,
          full_name: `${owner}/${repoName}`,
          description: null,
          html_url: link,
          stargazers_count: stars,
          forks_count: forks,
          forks: forks,
          language: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          pushed_at: new Date().toISOString(),
          owner: { login: owner, avatar_url: `https://github.com/${owner}.png` },
          topics: [],
          rank: i + 1,
          channel: 'trending',
        });
      }

      // When stars/forks are missing or description is incomplete (description only comes from GitHub API, not provided by RSS),
      // fetch from GitHub API; description completion must not depend on whether stars/forks are zero
      const reposNeedUpdate = repos.filter(r => r.stargazers_count === 0 || r.forks_count === 0 || r.description === null);
      if (reposNeedUpdate.length > 0) {
        await Promise.all(reposNeedUpdate.map(async (r) => {
          try {
            const [owner, repo] = r.full_name.split('/');
            if (!owner || !repo) return;
            const data = await this.makeRequest<{
              stargazers_count: number;
              forks_count: number;
              language: string | null;
              description: string | null;
            }>(`/repos/${owner}/${repo}`, { operationTag: 'trending' });
            r.stargazers_count = data.stargazers_count ?? r.stargazers_count;
            r.forks_count = data.forks_count ?? r.forks_count;
            r.language = data.language;
            // Description uses GitHub API as source of truth; null (no description provided) remains null, displayed as "No description" in UI
            r.description = data.description;
          } catch (e) {
            logger.warn('githubApi', `Failed to fetch repo details for ${r.full_name}`, e);
          }
          // Avoid GitHub API rate limiting
          await new Promise(resolve => setTimeout(resolve, 100));
        }));
      }

      logger.info('githubApi', 'Refresh trending completed', { repoCount: repos.length, durationMs: Date.now() - startTime });

      return repos;
    } catch (error) {
      logger.error('githubApi', 'Failed to fetch trending from RSS', error);
      return [];
    }
  }

  async searchDailyDevs(perPage = 10): Promise<SubscriptionDev[]> {
    const usersData = await this.makeRequest<GitHubSearchUserResponse>(
      `/search/users?q=followers:>1000&sort=followers&order=desc&per_page=${perPage}`
    );

    const devs: SubscriptionDev[] = [];
    for (let i = 0; i < (usersData.items || []).length; i++) {
      const searchUser = usersData.items[i];

      // The search API only returns basic fields; fetch the full profile for name/bio/followers/public_repos
      let userDetail: GitHubUserDetail = {
        login: searchUser.login,
        avatar_url: searchUser.avatar_url,
        html_url: searchUser.html_url,
        name: null,
        bio: null,
        public_repos: 0,
        followers: 0,
      };
      try {
        userDetail = await this.makeRequest<GitHubUserDetail>(`/users/${searchUser.login}`);
      } catch (error) {
        logger.warn('githubApi', `Failed to fetch user details for ${searchUser.login}`, error);
      }

      let topRepo: SubscriptionRepo | null = null;
      try {
        const reposData = await this.makeRequest<Repository[]>(
          `/users/${searchUser.login}/repos?sort=stars&per_page=1`
        );
        if (reposData && reposData.length > 0) {
          topRepo = {
            ...reposData[0],
            rank: 1,
            channel: 'most-dev' as const,
          };
        }
      } catch (error) {
        logger.warn('githubApi', `Failed to fetch top repo for ${searchUser.login}`, error);
      }
      devs.push({
        rank: i + 1,
        login: userDetail.login,
        avatar_url: userDetail.avatar_url,
        html_url: userDetail.html_url,
        name: userDetail.name,
        bio: userDetail.bio,
        public_repos: userDetail.public_repos,
        followers: userDetail.followers,
        topRepo,
      });
      if (i < (usersData.items || []).length - 1) {
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
    return devs;
  }

  private buildLanguageQuery(language: ProgrammingLanguage): string {
    if (language === 'All') return '';
    const languageMap: Record<ProgrammingLanguage, string> = {
      'All': '',
      'Kotlin': 'Kotlin',
      'Java': 'Java',
      'JavaScript': 'JavaScript',
      'TypeScript': 'TypeScript',
      'Python': 'Python',
      'Swift': 'Swift',
      'Rust': 'Rust',
      'Go': 'Go',
      'CSharp': 'C#',
      'CPlusPlus': 'C++',
      'C': 'C',
      'Dart': 'Dart',
      'Ruby': 'Ruby',
      'PHP': 'PHP',
    };
    return `language:${languageMap[language]}`;
  }

  private buildSortParams(sortBy: SortBy, sortOrder: SortOrder): { sort: string; order: string } {
    const sortMap: Record<SortBy, string> = {
      'BestMatch': 'best-match',
      'MostStars': 'stars',
      'MostForks': 'forks',
    };
    const orderMap: Record<SortOrder, string> = {
      'Descending': 'desc',
      'Ascending': 'asc',
    };
    return {
      sort: sortMap[sortBy],
      order: orderMap[sortOrder],
    };
  }

  async getTrendingRepositories(
    platform: DiscoveryPlatform,
    page: number = 1,
    perPage: number = 20,
    timeRange: TrendingTimeRange = 'weekly'
  ): Promise<PaginatedDiscoveryRepositories> {
    const startTime = Date.now();
    const rssUrlMap: Record<TrendingTimeRange, string> = {
      daily: 'https://mshibanami.github.io/GitHubTrendingRSS/daily/all.xml',
      weekly: 'https://mshibanami.github.io/GitHubTrendingRSS/weekly/all.xml',
      monthly: 'https://mshibanami.github.io/GitHubTrendingRSS/monthly/all.xml',
    };
    const rssUrl = rssUrlMap[timeRange];

    try {
      const response = await fetch(rssUrl, {
        headers: { 'Accept': 'application/rss+xml, application/xml, text/xml' }
      });
      if (!response.ok) {
        throw new Error(`RSS fetch failed: ${response.status}`);
      }
      const text = await response.text();
      const parser = new DOMParser();
      const xml = parser.parseFromString(text, 'text/xml');
      const items = xml.querySelectorAll('item');

      const repos: DiscoveryRepo[] = [];
      const startIndex = (page - 1) * perPage;
      const endIndex = Math.min(startIndex + perPage, items.length);

      for (let i = startIndex; i < endIndex; i++) {
        const item = items[i];
        const title = item.querySelector('title')?.textContent || '';
        const link = item.querySelector('link')?.textContent || '';

        // The RSS description element contains rendered README content, not the repository description;
        // only used below to extract stars/forks indicators, never written to repo.description
        const descriptionEl = item.querySelector('description');
        let readmeText = descriptionEl?.textContent || '';
        // Decode HTML entities and strip HTML tags (DOMParser, see decodeRssHtmlToText)
        readmeText = decodeRssHtmlToText(readmeText);
        // Clean up extra whitespace
        readmeText = readmeText.replace(/\s+/g, ' ').trim();

        // Parse link to get owner/repo
        const match = link.match(/github\.com\/([^/]+)\/([^/?#]+)/);
        const owner = match?.[1] || '';
        const repoName = match?.[2] || title;

        // Extract stars and forks from description (format like "⭐ 1,234 | 🍴 456")
        const starsMatch = readmeText.match(/⭐\s*([\d,]+)/);
        const forksMatch = readmeText.match(/🍴\s*([\d,]+)/);
        const stars = starsMatch ? parseInt(starsMatch[1].replace(/,/g, '')) : 0;
        const forks = forksMatch ? parseInt(forksMatch[1].replace(/,/g, '')) : 0;

        repos.push({
          id: 0, // will be filled by GitHub API
          name: repoName,
          full_name: `${owner}/${repoName}`,
          description: null,
          html_url: link,
          stargazers_count: stars,
          forks_count: forks,
          forks: forks,
          language: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          pushed_at: new Date().toISOString(),
          owner: {
            login: owner,
            avatar_url: `https://github.com/${owner}.png`,
          },
          topics: [],
          rank: i + 1,
          channel: 'trending' as DiscoveryChannelId,
          platform,
        });
      }

      // Supplement missing fields via GitHub API
      const reposNeedUpdate = repos.filter(r => r.id === 0 || r.stargazers_count === 0 || r.forks_count === 0 || !r.language);
      if (reposNeedUpdate.length > 0) {
        await Promise.all(reposNeedUpdate.map(async (r) => {
          try {
            const [owner, repo] = r.full_name.split('/');
            if (!owner || !repo) return;
            const data = await this.makeRequest<{
              id: number;
              stargazers_count: number;
              forks_count: number;
              forks: number;
              language: string | null;
              description: string | null;
              topics: string[];
              created_at: string;
              updated_at: string;
              pushed_at: string;
            }>(`/repos/${owner}/${repo}`, { operationTag: 'trending' });
            r.id = data.id;
            r.stargazers_count = data.stargazers_count ?? r.stargazers_count;
            r.forks_count = data.forks_count ?? r.forks_count;
            r.forks = data.forks ?? r.forks;
            r.language = data.language ?? r.language;
            r.topics = data.topics ?? r.topics;
            r.created_at = data.created_at ?? r.created_at;
            r.updated_at = data.updated_at ?? r.updated_at;
            r.pushed_at = data.pushed_at ?? r.pushed_at;
            // Repository description strictly uses GitHub API as source of truth; null (no description provided) remains null,
            // displayed as "No description" in UI, never falling back to RSS README content
            r.description = data.description;
          } catch (e) {
            logger.warn('githubApi', `Failed to fetch repo details for ${r.full_name}`, e);
          }
          // Avoid GitHub API rate limiting
          await new Promise(resolve => setTimeout(resolve, 80));
        }));
      }

      // Assign rank based on position
      repos.forEach((r, idx) => { r.rank = startIndex + idx + 1; });

      logger.info('githubApi', 'Refresh trending completed', { repoCount: repos.length, durationMs: Date.now() - startTime });

      return {
        repos,
        hasMore: endIndex < items.length,
        nextPageIndex: page + 1,
        totalCount: items.length,
      };
    } catch (error) {
      logger.error('githubApi', 'Failed to fetch trending from RSS', error);
      return { repos: [], hasMore: false, nextPageIndex: 1, totalCount: 0 };
    }
  }

  async getHotReleaseRepositories(
    platform: DiscoveryPlatform,
    page: number = 1,
    perPage: number = 20
  ): Promise<PaginatedDiscoveryRepositories> {
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const platformQuery = this.buildPlatformQuery(platform);

    let query = `stars:>10 archived:false pushed:>=${fourteenDaysAgo}`;
    if (platformQuery) {
      query += ` ${platformQuery}`;
    }

    const data = await this.makeRequest<GitHubSearchRepoResponse>(
      `/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${perPage}&page=${page}`
    );

    const repos = (data.items || []).map((repo, index) => ({
      ...repo,
      rank: (page - 1) * perPage + index + 1,
      channel: 'hot-release' as DiscoveryChannelId,
      platform,
    }));

    return {
      repos,
      hasMore: repos.length === perPage,
      nextPageIndex: page + 1,
      totalCount: data.total_count,
    };
  }

  async getMostPopular(
    platform: DiscoveryPlatform,
    page: number = 1,
    perPage: number = 20
  ): Promise<PaginatedDiscoveryRepositories> {
    const sixMonthsAgo = new Date(Date.now() - 6 * 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const platformQuery = this.buildPlatformQuery(platform);

    let query = `stars:>1000 archived:false created:<${sixMonthsAgo} pushed:>=${oneYearAgo}`;
    if (platformQuery) {
      query += ` ${platformQuery}`;
    }

    const data = await this.makeRequest<GitHubSearchRepoResponse>(
      `/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${perPage}&page=${page}`
    );

    const repos = (data.items || []).map((repo, index) => ({
      ...repo,
      rank: (page - 1) * perPage + index + 1,
      channel: 'most-popular' as DiscoveryChannelId,
      platform,
    }));

    return {
      repos,
      hasMore: repos.length === perPage,
      nextPageIndex: page + 1,
      totalCount: data.total_count,
    };
  }

  async searchByTopic(
    searchKeywords: string,
    platform: DiscoveryPlatform,
    page: number = 1,
    perPage: number = 20
  ): Promise<PaginatedDiscoveryRepositories> {
    const platformQuery = this.buildPlatformQuery(platform);

    let query = `${searchKeywords} in:name,description,topics stars:>10 archived:false`;
    if (platformQuery) {
      query += ` ${platformQuery}`;
    }

    const data = await this.makeRequest<GitHubSearchRepoResponse>(
      `/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${perPage}&page=${page}`
    );

    const repos = (data.items || []).map((repo, index) => ({
      ...repo,
      rank: (page - 1) * perPage + index + 1,
      channel: 'topic' as DiscoveryChannelId,
      platform,
    }));

    return {
      repos,
      hasMore: repos.length === perPage,
      nextPageIndex: page + 1,
      totalCount: data.total_count,
    };
  }

  async getTopicRepositories(
    topic: TopicCategory,
    platform: DiscoveryPlatform,
    page: number = 1,
    perPage: number = 20
  ): Promise<PaginatedDiscoveryRepositories> {
    const topicKeywords: Record<TopicCategory, string> = {
      'ai': 'artificial-intelligence machine-learning ai',
      'ml': 'machine-learning deep-learning neural-network',
      'database': 'database sql nosql mongodb postgresql mysql',
      'web': 'web frontend backend react vue angular',
      'mobile': 'mobile android ios flutter react-native',
      'devtools': 'devtools ide editor tools',
      'security': 'security cybersecurity encryption',
      'game': 'game game-engine unity unreal',
    };

    return this.searchByTopic(topicKeywords[topic], platform, page, perPage);
  }

  async searchRepositories(
    query: string,
    platform: DiscoveryPlatform,
    language: ProgrammingLanguage,
    sortBy: SortBy,
    sortOrder: SortOrder,
    page: number = 1,
    perPage: number = 20
  ): Promise<PaginatedDiscoveryRepositories> {
    const platformQuery = this.buildPlatformQuery(platform);
    const languageQuery = this.buildLanguageQuery(language);
    const { sort, order } = this.buildSortParams(sortBy, sortOrder);

    let searchQuery = `${query} archived:false`;
    if (platformQuery) {
      searchQuery += ` ${platformQuery}`;
    }
    if (languageQuery) {
      searchQuery += ` ${languageQuery}`;
    }

    let url = `/search/repositories?q=${encodeURIComponent(searchQuery)}&per_page=${perPage}&page=${page}`;
    if (sort) {
      url += `&sort=${sort}&order=${order}`;
    }

    const data = await this.makeRequest<GitHubSearchRepoResponse>(url);

    const repos = (data.items || []).map((repo, index) => ({
      ...repo,
      rank: (page - 1) * perPage + index + 1,
      channel: 'search' as DiscoveryChannelId,
      platform,
    }));

    return {
      repos,
      hasMore: repos.length === perPage,
      nextPageIndex: page + 1,
      totalCount: data.total_count,
    };
  }



  async getUserOrganizations(): Promise<GitHubOrganization[]> {
    try {
      return await this.getPaginatedFromEndpoint<GitHubOrganization>('/user/orgs', 'fork');
    } catch (error) {
      logger.warn('githubApi', 'Failed to fetch user organizations', error);
      throw error;
    }
  }

  private async getPaginatedFromEndpoint<T>(endpoint: string, operationTag: string): Promise<T[]> {
    let allItems: T[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const separator = endpoint.includes('?') ? '&' : '?';
      const items = await this.makeRequest<T[]>(
        `${endpoint}${separator}per_page=${perPage}&page=${page}`,
        { operationTag }
      );
      allItems = [...allItems, ...items];
      if (items.length < perPage) break;
      page++;
      // Rate limiting protection
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return allItems;
  }

  private async getForksFromEndpoint(endpoint: string): Promise<ForkRepo[]> {
    return this.getPaginatedFromEndpoint<ForkRepo>(endpoint, 'fork');
  }

  async getUserForks(): Promise<ForkRepo[]> {
    try {
      // Use /user/repos?type=forks to get only repositories the user has forked
      return await this.getForksFromEndpoint('/user/repos?type=forks&sort=updated');
    } catch (error) {
      logger.warn('githubApi', 'Failed to fetch user forks', error);
      throw error;
    }
  }

  async getOrganizationForks(orgLogin: string): Promise<ForkRepo[]> {
    try {
      return await this.getForksFromEndpoint(`/orgs/${encodeURIComponent(orgLogin)}/repos?type=forks&sort=updated`);
    } catch (error) {
      logger.warn('githubApi', 'Failed to fetch organization forks', { orgLogin, error });
      throw error;
    }
  }

  async syncFork(owner: string, repo: string, branch: string): Promise<{ hasUpdates: boolean; sourceUpdatedAt: string | null; mergeType?: string }> {
    // Use GitHub's merge upstream API to sync the fork with its upstream
    try {
      const result = await this.makeRequest<{ merge_type: string; message?: string }>(
        `/repos/${owner}/${repo}/merge-upstream`,
        {
          method: 'POST',
          body: JSON.stringify({ branch }),
          operationTag: 'fork',
        }
      );
      return {
        hasUpdates: result.merge_type !== 'none',
        sourceUpdatedAt: new Date().toISOString(),
        mergeType: result.merge_type,
      };
    } catch (error) {
      if (error instanceof Error) {
        const msg = error.message;
        if (msg.includes('404')) throw new Error('NOT_A_FORK');
        if (msg.includes('409')) throw new Error('MERGE_CONFLICT');
        if (msg.includes('422')) {
          return { hasUpdates: false, sourceUpdatedAt: null, mergeType: 'none' };
        }
      }
      throw error;
    }
  }

  // Check if a fork's branch is behind its upstream — returns true if "out-of-date"
  async checkForkSyncNeeded(owner: string, repo: string, branch: string, parentFullName?: string): Promise<{ needsSync: boolean, parentFullName?: string, parentHtmlUrl?: string }> {
    try {
      let parentOwner = '';
      let resultParentFullName = parentFullName;
      let resultParentHtmlUrl: string | undefined = undefined;

      if (parentFullName) {
        parentOwner = parentFullName.split('/')[0];
      } else {
        const repoData = await this.makeRequest<{ parent?: { owner: { login: string }, full_name: string, html_url: string } }>(`/repos/${owner}/${repo}`, { operationTag: 'fork' });
        if (!repoData.parent) return { needsSync: false };
        parentOwner = repoData.parent.owner.login;
        resultParentFullName = repoData.parent.full_name;
        resultParentHtmlUrl = repoData.parent.html_url;
      }

      const compareData = await this.makeRequest<{ behind_by: number }>(
        `/repos/${owner}/${repo}/compare/${parentOwner}:${branch}...${owner}:${branch}`,
        { operationTag: 'fork' }
      );
      
      return { 
        needsSync: compareData.behind_by > 0,
        parentFullName: resultParentFullName,
        parentHtmlUrl: resultParentHtmlUrl
      };
    } catch (error) {
      logger.warn('githubApi', `Failed to check sync status for ${owner}/${repo}`, error);
      return { needsSync: false };
    }
  }

  async getBranches(owner: string, repo: string): Promise<string[]> {
    try {
      const branches = await this.makeRequest<{ name: string }[]>(`/repos/${owner}/${repo}/branches?per_page=100`);
      return branches.map(b => b.name);
    } catch (error) {
      logger.warn('githubApi', `Failed to fetch branches for ${owner}/${repo}`, error);
      return [];
    }
  }

  async getRepositoryWorkflows(owner: string, repo: string): Promise<WorkflowDefinition[]> {
    try {
      // GET /repos/{owner}/{repo}/actions/workflows lists workflow files (definitions), not runs
      const data = await this.makeRequest<{ workflows: WorkflowDefinition[] }>(
        `/repos/${owner}/${repo}/actions/workflows?per_page=100`,
        { operationTag: 'workflow' }
      );
      return data.workflows || [];
    } catch (error) {
      logger.warn('githubApi', `Failed to fetch workflows for ${owner}/${repo}`, error);
      return [];
    }
  }

  async triggerWorkflowRun(owner: string, repo: string, workflowPath: string, branch: string): Promise<void> {
    // workflowPath is the file path (e.g. ".github/workflows/ci.yml") — URL-encode it
    const encodedPath = encodeURIComponent(workflowPath);
    await this.makeRequest<void>(
      `/repos/${owner}/${repo}/actions/workflows/${encodedPath}/dispatches`,
      {
        method: 'POST',
        body: JSON.stringify({ ref: branch }),
        operationTag: 'workflow',
      }
    );
  }
}

export const createGitHubOAuthUrl = (clientId: string, redirectUri: string): string => {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    // The `gist` scope is required to read and write user gists (including secret/private gists);
    // otherwise only public gists can be listed, and creating/editing/deleting gists is not permitted.
    scope: 'read:user user:email repo gist',
    state: Math.random().toString(36).substring(7),
  });

  return `https://github.com/login/oauth/authorize?${params.toString()}`;
};
