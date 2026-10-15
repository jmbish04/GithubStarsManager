/**
 * Ruan Yifeng Weekly channel data service (on-demand paginated fetching).
 *
 * Data pipeline: Fetch ruanyf/weekly issues page by page -> filter titles containing "开源" -> extract
 * GitHub repository links from body -> deduplicate by full_name (link to latest submission) -> enrich
 * repository details (GraphQL batch first, REST fallback) -> persist in dedicated IndexedDB -> client-side
 * sort descending by submission time + "Weekly publication" filter + paginated slicing.
 *
 * Pagination semantics (does not fetch everything at once):
 * - Refresh walk (page 1 / manual refresh): `state=all&sort=updated&since=lastSync-7days`,
 *   label changes bump updated_at, so a single pass covers "new submissions + edits + inclusion labels
 *   added days after release"; server-side filtering by window means stopping at short/empty page completes the window.
 *   First run (no watermark) omits since and fetches only 1 page for sub-second initial data.
 * - Deep walk (when cached cards are insufficient for current page): omits since, resumes from persisted cursor
 *   deepNextPage-1 (1 page overlap to guard against shift from deletions), persisting each page and advancing cursor,
 *   until target card count is reached, short/empty page encountered (-> historyComplete), or single-pass page limit reached.
 * - Repeated scans quickly skipped via updatedAt; incremental persistence per page, cancelation does not lose processed items.
 *
 * Why search/issues API is not used: hard cap of 1,000 results and independent rate limit of 30 req/min;
 * list endpoint uses core API (5,000 req/hour). Details enriched via GraphQL alias batching
 * (100 repos/request), falling back to REST per repository on failure.
 */

import type {
  DiscoveryChannelId,
  DiscoveryRepo,
  PaginatedDiscoveryRepositories,
  WeeklyIssueRef,
  WeeklySyncStatus,
} from '../types';
import { logger } from './logger';
import type { GitHubApiService, GitHubIssueListRead, GitHubRepoDetailRead } from './githubApi';
import {
  weeklyIssuesStorage,
  type WeeklyStoredIssue,
  type WeeklyStoredRepo,
  type WeeklySyncMeta,
} from './weeklyIssuesStorage';

export const WEEKLY_REPO_OWNER = 'ruanyf';
export const WEEKLY_REPO_NAME = 'weekly';
const WEEKLY_CHANNEL: DiscoveryChannelId = 'weekly';
/** Issue title keyword (submission titles like 【开源自荐】/【开源项目】contain this word) */
export const WEEKLY_TITLE_KEYWORD = '开源';
/** Weekly collection label (added to submissions included in the weekly newsletter) */
export const WEEKLY_COLLECTED_LABEL = 'weekly';
/** GitHub site-level paths (github.com/<these>/... are not repository links) */
const NON_REPO_OWNER_PATHS = new Set([
  'features', 'topics', 'collections', 'sponsors', 'marketplace', 'settings', 'orgs',
  'enterprises', 'account', 'notifications', 'explore', 'trending', 'about', 'pricing',
  'security', 'contact', 'site', 'resources', 'events', 'customer-stories', 'readme',
  'user-attachments', 'github-assets', 'apps', 'codespaces', 'copilot', 'login', 'signup',
  'new', 'import', 'organizations', 'users', 'blog', 'docs', 'support', 'status', 'team',
]);
const ISSUE_PAGE_SIZE = 100;
const CARD_PAGE_SIZE = 50;
/** Label grace window: look back 7 extra days on incremental sync to catch inclusion labels added days later */
const LABEL_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/** Repository detail refresh interval: snapshots within 30 days are considered fresh */
const REPO_DETAIL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Retry interval for unavailable repositories (404/private) */
const UNAVAILABLE_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
/** Maximum repositories for detail maintenance per refresh walk (expired snapshots / unavailable retries) */
const MAINTENANCE_CAP = 30;
/** Maximum issue pages to fetch in a single deep walk ("load more") */
const DEEP_WALK_MAX_PAGES = 10;
/** Maximum issue pages in a refresh walk (safety fuse if since window expands abnormally) */
const REFRESH_WALK_MAX_PAGES = 20;
/** Skip refresh walk if synced within 60 seconds (re-renders from filter toggle use cache) */
const RECENT_SYNC_SKIP_MS = 60 * 1000;
const ISSUE_LIST_THROTTLE_MS = 100;
const REST_ENRICH_THROTTLE_MS = 80;

type StatusCallback = ((status: WeeklySyncStatus | null) => void) | undefined;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isAbortError = (error: unknown): boolean =>
  (error instanceof Error && (error.name === 'AbortError' || error.message === 'Aborted')) ||
  (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError');

const isRateLimitError = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith('GitHub API rate limit exceeded');

const isTokenInvalidError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('token expired or invalid');

/**
 * Extract GitHub repository full_name from issue body.
 * Only recognizes complete https links, stripping subpaths (/tree/, /blob/, etc.); excludes attachment images,
 * site-level paths, and the weekly repository itself; returns empty array when no links found (caller drops item).
 */
export function extractRepoFullNames(body: string | null | undefined): string[] {
  if (!body) return [];
  const result = new Set<string>();
  const pattern = /https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const owner = match[1];
    let name = match[2];
    if (!owner || !name) continue;
    const ownerLower = owner.toLowerCase();
    if (NON_REPO_OWNER_PATHS.has(ownerLower)) continue;
    if (ownerLower === WEEKLY_REPO_OWNER && name.toLowerCase() === WEEKLY_REPO_NAME) continue;
    // GitHub repository names cannot end with a period (`bar.` punctuation matched by [\w.-]);
    // trailing hyphen is valid in repo names, keep it
    name = name.replace(/\.+$/, '');
    if (!name) continue;
    if (name.toLowerCase().endsWith('.git')) name = name.slice(0, -4);
    result.add(`${owner}/${name}`);
  }
  return [...result];
}

export const hasCollectedLabel = (labels: string[]): boolean =>
  labels.some((label) => label.toLowerCase() === WEEKLY_COLLECTED_LABEL);

/**
 * Issue change registration marks: cumulative sets for post-walk detail enrichment (preserved across pages);
 * page-level dirty sets for atomic persistence per page (cleared on transaction success). When the same repo
 * changes again across pages, cumulative deduplication does not advance, but page-level sets still register —
 * persistence must use page-level sets.
 */
export interface IssueChangeMarks {
  changedIssueNumbers: Set<number>;
  changedRepoKeys: Set<string>;
  dirtyIssueNumbers: Set<number>;
  dirtyRepoKeys: Set<string>;
}

/**
 * Process a single issue: if matched (title contains keyword and body contains repo link), upsert to
 * issues/repos map and register to change marks. Known issues with unchanged updatedAt are fast-skipped.
 * Returns whether issue was a matched submission item.
 */
export function processWeeklyIssue(
  issue: GitHubIssueListRead,
  issues: Map<number, WeeklyStoredIssue>,
  repos: Map<string, WeeklyStoredRepo>,
  marks: IssueChangeMarks,
): boolean {
  const existing = issues.get(issue.number);
  if (existing && existing.updatedAt === issue.updated_at) return Boolean(existing.repoFullNames.length);
  if (issue.isPullRequest || !issue.title.includes(WEEKLY_TITLE_KEYWORD)) return false;
  const fullNames = extractRepoFullNames(issue.body);
  if (fullNames.length === 0) return false;

  issues.set(issue.number, {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    labels: issue.labels,
    state: issue.state,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    htmlUrl: issue.html_url,
    repoFullNames: fullNames.map((fullName) => fullName.toLowerCase()),
  });
  marks.changedIssueNumbers.add(issue.number);
  marks.dirtyIssueNumbers.add(issue.number);

  for (const fullName of fullNames) {
    const key = fullName.toLowerCase();
    const repo = repos.get(key);
    if (!repo) {
      repos.set(key, {
        fullName,
        detail: null,
        lastFetchedAt: '',
        sourceIssueNumber: issue.number,
        issueLabels: issue.labels,
        issueCreatedAt: issue.created_at,
      });
    } else if (issue.created_at > repo.issueCreatedAt) {
      // Multiple submissions for same repo: link original post to the newest submission issue
      repo.sourceIssueNumber = issue.number;
      repo.issueLabels = issue.labels;
      repo.issueCreatedAt = issue.created_at;
    } else if (repo.sourceIssueNumber === issue.number) {
      // Update original issue labels (weekly label may be added days after publication)
      repo.issueLabels = issue.labels;
    }
    marks.changedRepoKeys.add(key);
    marks.dirtyRepoKeys.add(key);
  }
  return true;
}

const bySubmissionDesc = (a: WeeklyStoredRepo, b: WeeklyStoredRepo) =>
  b.issueCreatedAt.localeCompare(a.issueCreatedAt);

/** Repositories newly reached this walk that lack details (no cap; additions from walk must be enriched). */
export function pendingReposFromKeys(
  repos: Map<string, WeeklyStoredRepo>,
  keys: Set<string>,
): WeeklyStoredRepo[] {
  const pending: WeeklyStoredRepo[] = [];
  for (const key of keys) {
    const repo = repos.get(key);
    if (repo && !repo.lastFetchedAt) pending.push(repo);
  }
  return pending.sort(bySubmissionDesc);
}

/**
 * Detail maintenance bundled with refresh walk (individual quotas to manage API budget):
 * Stale snapshots (>30 days), unavailable repositories due for retry, and straggler pending repositories
 * (orphaned from previously aborted syncs, outside this walk's changed set).
 */
export function refreshMaintenanceRepos(
  repos: Map<string, WeeklyStoredRepo>,
  changedKeys: Set<string>,
  nowMs: number,
): WeeklyStoredRepo[] {
  const stale: WeeklyStoredRepo[] = [];
  const unavailableRetry: WeeklyStoredRepo[] = [];
  const stragglers: WeeklyStoredRepo[] = [];
  for (const repo of repos.values()) {
    if (!repo.lastFetchedAt) {
      if (!changedKeys.has(repo.fullName.toLowerCase())) stragglers.push(repo);
    } else if (repo.detail) {
      if (nowMs - Date.parse(repo.lastFetchedAt) > REPO_DETAIL_TTL_MS) stale.push(repo);
    } else if (nowMs - Date.parse(repo.lastFetchedAt) > UNAVAILABLE_RETRY_MS) {
      unavailableRetry.push(repo);
    }
  }
  return [
    ...stale.sort(bySubmissionDesc).slice(0, MAINTENANCE_CAP),
    ...unavailableRetry.sort(bySubmissionDesc).slice(0, MAINTENANCE_CAP),
    ...stragglers.sort(bySubmissionDesc).slice(0, MAINTENANCE_CAP),
  ];
}

/** Write enrichment results back to repos map (null = unavailable, timestamped for retry). */
function applyEnrichmentResults(
  details: Map<string, GitHubRepoDetailRead | null>,
  repos: Map<string, WeeklyStoredRepo>,
  changedRepoKeys: Set<string>,
  fetchedAtIso: string,
): void {
  for (const [key, detail] of details) {
    const repo = repos.get(key);
    if (!repo) continue;
    repo.lastFetchedAt = fetchedAtIso;
    if (detail) repo.detail = detail;
    changedRepoKeys.add(key);
  }
}

/** REST per-repository enrichment fallback (when GraphQL is unavailable); throws immediately on rate limit/auth errors to abort walk. */
async function enrichReposViaRest(
  api: GitHubApiService,
  targets: WeeklyStoredRepo[],
  changedRepoKeys: Set<string>,
  onStatus: StatusCallback,
  signal?: AbortSignal,
): Promise<void> {
  for (let i = 0; i < targets.length; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const repo = targets[i];
    const key = repo.fullName.toLowerCase();
    const [owner, name] = key.split('/');
    try {
      const detail = await api.getRepositoryDetails(owner, name, signal);
      repo.detail = detail;
      repo.lastFetchedAt = new Date().toISOString();
    } catch (error) {
      if (isAbortError(error) || isRateLimitError(error) || isTokenInvalidError(error)) throw error;
      // 404/410/other 4xx: mark unavailable for future retry (makeRequest already handles network/5xx retries)
      logger.warn('weeklyIssues', `Repo details unavailable: ${repo.fullName}`, error);
      repo.lastFetchedAt = new Date().toISOString();
    }
    changedRepoKeys.add(key);
    onStatus?.({ phase: 'enriching', current: i + 1, total: targets.length });
    await sleep(REST_ENRICH_THROTTLE_MS);
  }
}

/** GraphQL batch enrichment; falls back to REST only for repositories that failed in batch. */
async function enrichRepos(
  api: GitHubApiService,
  targets: WeeklyStoredRepo[],
  repos: Map<string, WeeklyStoredRepo>,
  changedRepoKeys: Set<string>,
  onStatus: StatusCallback,
  signal?: AbortSignal,
): Promise<void> {
  if (targets.length === 0) return;
  const total = targets.length;
  onStatus?.({ phase: 'enriching', current: 0, total });
  const fullNames = targets.map((repo) => repo.fullName);
  const batchSize = 100;
  const appliedKeys = new Set<string>();
  try {
    const details = await api.graphqlFetchRepositories(fullNames, {
      signal,
      batchSize,
      onBatchDone: (doneBatches) => {
        const done = Math.min(total, doneBatches * batchSize);
        onStatus?.({ phase: 'enriching', current: done, total });
      },
    });
    for (const [key, detail] of details) {
      if (detail !== undefined) appliedKeys.add(key);
    }
    applyEnrichmentResults(details, repos, changedRepoKeys, new Date().toISOString());
  } catch (error) {
    if (isAbortError(error) || isRateLimitError(error) || isTokenInvalidError(error)) throw error;
    logger.warn('weeklyIssues', 'GraphQL batch enrichment failed, falling back to REST', error);
  }
  const restTargets = targets.filter((repo) => !appliedKeys.has(repo.fullName.toLowerCase()));
  if (restTargets.length > 0) {
    await enrichReposViaRest(api, restTargets, changedRepoKeys, onStatus, signal);
  }
}

/** Mutable state shared across walks: in-memory issue/repo maps, change marks (cumulative + page-level dirty). */
interface WalkContext {
  api: GitHubApiService;
  signal: AbortSignal | undefined;
  onStatus: StatusCallback;
  issues: Map<number, WeeklyStoredIssue>;
  repos: Map<string, WeeklyStoredRepo>;
  changedIssueNumbers: Set<number>;
  changedRepoKeys: Set<string>;
  dirtyIssueNumbers: Set<number>;
  dirtyRepoKeys: Set<string>;
  meta: WeeklySyncMeta;
}

interface WalkOptions {
  /** Only fetch issues with updated_at >= since (refresh walk); omitted for deep walk */
  since?: string;
  startPage: number;
  maxPages: number;
  /** Whether to advance deep pagination cursor (only for fully-ordered walk without since) */
  advanceCursor: boolean;
  /** Stop condition evaluated after each page (deep walk: stop once target cards reached) */
  stopWhen?: () => boolean;
  /**
   * Short/empty pages from this page onward mark historyComplete. Overlap region of deep walk cursor
   * (startPage = deepNextPage-1) is a previously consumed page; its short length could be stale information
   * caused by deletion shift, so it cannot mark completion; undefined = never mark.
   */
  completeFromPage?: number;
}

interface WalkResult {
  pagesFetched: number;
  scanned: number;
  matched: number;
  /** History exhausted: true only when walk without since encounters a short or empty page */
  hitEnd: boolean;
}

/**
 * Atomically persist dirty data + cursor for this page: issues, repos, meta (deepNextPage/historyComplete)
 * within the same transaction. Page-level dirty sets are cleared and in-memory cursor advanced only upon
 * transaction success; failures throw to abort walk, and next sync will re-fetch this page, preventing
 * permanent gaps where the cursor was advanced without data persisting.
 */
async function flushWalkPage(
  ctx: WalkContext,
  page: number,
  opts: { advanceCursor: boolean; markComplete: boolean },
): Promise<void> {
  const newIssues = [...ctx.dirtyIssueNumbers].map((number) => ctx.issues.get(number)!).filter(Boolean);
  const newRepos = [...ctx.dirtyRepoKeys].map((key) => ctx.repos.get(key)!).filter(Boolean);
  const nextMeta: WeeklySyncMeta = { ...ctx.meta };
  let metaChanged = false;
  if (opts.advanceCursor) {
    nextMeta.deepNextPage = page + 1;
    metaChanged = true;
  }
  if (opts.markComplete && !nextMeta.historyComplete) {
    nextMeta.historyComplete = true;
    metaChanged = true;
  }
  if (newIssues.length === 0 && newRepos.length === 0 && !metaChanged) return;
  await weeklyIssuesStorage.saveWalkPage({ issues: newIssues, repos: newRepos, meta: nextMeta });
  ctx.dirtyIssueNumbers.clear();
  ctx.dirtyRepoKeys.clear();
  ctx.meta = nextMeta;
}

/**
 * Walk issue pages in descending updated order: process page by page, persist atomically, advance cursor.
 * Stop conditions: page limit reached / short or empty page (marks historyComplete atomically when without since)
 * / deep walk reaches target card count.
 */
async function walkIssuePages(ctx: WalkContext, opts: WalkOptions): Promise<WalkResult> {
  let page = opts.startPage;
  let scanned = 0;
  let matched = 0;
  let pagesFetched = 0;
  let hitEnd = false;
  while (pagesFetched < opts.maxPages) {
    const items = await ctx.api.listRepositoryIssues(WEEKLY_REPO_OWNER, WEEKLY_REPO_NAME, {
      state: 'all',
      sort: 'updated',
      direction: 'desc',
      since: opts.since,
      perPage: ISSUE_PAGE_SIZE,
      page,
      signal: ctx.signal,
    });
    pagesFetched++;
    const isShort = items.length < ISSUE_PAGE_SIZE;
    const isNewTerritory = opts.completeFromPage === undefined || page >= opts.completeFromPage;
    const markComplete = isShort && isNewTerritory && !opts.since;
    if (items.length > 0) {
      for (const issue of items) {
        if (processWeeklyIssue(issue, ctx.issues, ctx.repos, ctx)) matched++;
      }
      scanned += items.length;
      ctx.onStatus?.({ phase: 'syncing', current: scanned, total: 0 });
    }
    await flushWalkPage(ctx, page, { advanceCursor: opts.advanceCursor, markComplete });
    if (isShort && isNewTerritory) {
      hitEnd = markComplete;
      break;
    }
    // Short overlapping old page: completion check is stale (history already moved past this point), continue deeper (capped by maxPages)
    if (opts.stopWhen?.()) break;
    page++;
    await sleep(ISSUE_LIST_THROTTLE_MS);
  }
  return { pagesFetched, scanned, matched, hitEnd };
}

/** Build discovery channel cards from stored repo/issue data (items without enriched details are hidden). */
export function buildWeeklyDiscoveryRepos(
  repos: Map<string, WeeklyStoredRepo>,
  issues: Map<number, WeeklyStoredIssue>,
  onlyCollected: boolean,
): DiscoveryRepo[] {
  const list: DiscoveryRepo[] = [];
  for (const repo of repos.values()) {
    if (!repo.detail) continue;
    if (onlyCollected && !hasCollectedLabel(repo.issueLabels)) continue;
    const issue = issues.get(repo.sourceIssueNumber);
    const weeklyIssue: WeeklyIssueRef = {
      number: repo.sourceIssueNumber,
      title: issue?.title ?? '',
      html_url: issue?.htmlUrl || `https://github.com/${WEEKLY_REPO_OWNER}/${WEEKLY_REPO_NAME}/issues/${repo.sourceIssueNumber}`,
      labels: repo.issueLabels,
      createdAt: repo.issueCreatedAt,
    };
    list.push({
      ...repo.detail,
      rank: 0,
      channel: WEEKLY_CHANNEL,
      platform: 'All',
      weeklyIssue,
    });
  }
  list.sort((a, b) => (b.weeklyIssue?.createdAt ?? '').localeCompare(a.weeklyIssue?.createdAt ?? ''));
  list.forEach((repo, index) => { repo.rank = index + 1; });
  return list;
}

/** Current displayable cards (respecting filters, counting only enriched items), used to decide if deep walk is needed. */
const countCards = (repos: Map<string, WeeklyStoredRepo>, onlyCollected: boolean): number => {
  let count = 0;
  for (const repo of repos.values()) {
    if (repo.detail && (!onlyCollected || hasCollectedLabel(repo.issueLabels))) count++;
  }
  return count;
};

/**
 * Expected displayable cards after walk finishes: already enriched repos + pending repos actually scheduled
 * for enrichment this walk (in enrichKeys). Straggler pending items from previously aborted syncs outside
 * enrichKeys will not be enriched this round and are excluded — otherwise mismatch between stop condition
 * and enrichment set causes pagination to repeatedly return short pages. Unavailable repos never display cards, excluded.
 */
const countProspectiveCards = (
  repos: Map<string, WeeklyStoredRepo>,
  onlyCollected: boolean,
  enrichKeys: Set<string>,
): number => {
  let count = 0;
  for (const repo of repos.values()) {
    const willDisplay = repo.detail
      || (!repo.lastFetchedAt && enrichKeys.has(repo.fullName.toLowerCase()));
    if (!willDisplay) continue;
    if (onlyCollected && !hasCollectedLabel(repo.issueLabels)) continue;
    count++;
  }
  return count;
};

const isRecentlySynced = (lastSyncedAt: string | null): boolean =>
  lastSyncedAt !== null
  && Number.isFinite(Date.parse(lastSyncedAt))
  && Date.now() - Date.parse(lastSyncedAt) < RECENT_SYNC_SKIP_MS;

let syncAbortController: AbortController | null = null;
let syncInFlight: Promise<void> | null = null;

/** Mutually exclusive execution: new requests abort previous run and wait for its persistence to settle before starting. */
async function runExclusiveSync(
  body: (signal: AbortSignal) => Promise<void>,
  onStatus: StatusCallback,
): Promise<void> {
  syncAbortController?.abort();
  // Wait for aborted run to finish persistence, preventing stale snapshot from overwriting freshly written results
  if (syncInFlight) await syncInFlight.catch(() => {});
  const controller = new AbortController();
  syncAbortController = controller;
  const run = body(controller.signal);
  syncInFlight = run.then(() => {}, () => {});
  try {
    await run;
  } finally {
    // Clear status only if still holding sync ownership, preventing an aborted old run from clearing progress of a new one
    if (syncAbortController === controller) {
      syncAbortController = null;
      onStatus?.(null);
    }
  }
}

/** Enrich targets and persist in finally block (prevents losing fetched details even if rate limited/aborted midway). */
async function enrichAndPersist(
  ctx: WalkContext,
  targets: WeeklyStoredRepo[],
  signal: AbortSignal,
): Promise<void> {
  if (targets.length === 0) return;
  try {
    await enrichRepos(ctx.api, targets, ctx.repos, ctx.changedRepoKeys, ctx.onStatus, signal);
  } finally {
    await weeklyIssuesStorage.saveRepos(
      [...ctx.changedRepoKeys].map((key) => ctx.repos.get(key)!).filter(Boolean),
    );
  }
}

/**
 * Channel fetch entry point (called by refreshChannel). On-demand pagination:
 * - page 1: bounded refresh walk if unsynced within 60s (since window / 1 page on first run);
 * - any page: bounded deep walk if cached cards are insufficient for the requested page (cursor continuation);
 * - when cache is sufficient: pure slicing without network requests. "Weekly publication" filter is client-side.
 */
export async function syncWeeklyChannel(
  api: GitHubApiService,
  page: number,
  onlyCollected: boolean,
  onStatus: StatusCallback,
): Promise<PaginatedDiscoveryRepositories> {
  const meta0 = await weeklyIssuesStorage.getSyncMeta();
  const needsRefreshWalk = page <= 1 && !isRecentlySynced(meta0.lastSyncedAt);
  // Refresh path re-reads repositories and evaluates deep walk conditions within mutex; skip redundant full read here
  const needsDeepWalk = !needsRefreshWalk
    && !meta0.historyComplete
    && countCards(await weeklyIssuesStorage.getAllRepos(), onlyCollected) < page * CARD_PAGE_SIZE;

  let finalIssues: Map<number, WeeklyStoredIssue> | null = null;
  let finalRepos: Map<string, WeeklyStoredRepo> | null = null;

  if (needsRefreshWalk || needsDeepWalk) {
    await runExclusiveSync(async (signal) => {
      // Previous run may have persisted new data, re-read latest state
      const meta = await weeklyIssuesStorage.getSyncMeta();
      const issues = await weeklyIssuesStorage.getAllIssues();
      const repos = await weeklyIssuesStorage.getAllRepos();
      const ctx: WalkContext = {
        api,
        signal,
        onStatus,
        issues,
        repos,
        changedIssueNumbers: new Set<number>(),
        changedRepoKeys: new Set<string>(),
        dirtyIssueNumbers: new Set<number>(),
        dirtyRepoKeys: new Set<string>(),
        meta,
      };

      if (page <= 1 && !isRecentlySynced(meta.lastSyncedAt)) {
        // Fall back to first-run on corrupted (unparseable) watermark: prevents Date.parse -> NaN
        // from throwing RangeError at toISOString and permanently breaking channel refresh;
        // after initial walk, lastSyncedAt is overwritten with a valid timestamp to self-heal
        const lastSyncedMs = meta.lastSyncedAt === null ? NaN : Date.parse(meta.lastSyncedAt);
        const firstRun = !Number.isFinite(lastSyncedMs);
        onStatus?.({ phase: 'syncing', current: 0, total: 0 });
        const walk = await walkIssuePages(ctx, firstRun
          ? { startPage: 1, maxPages: 1, advanceCursor: true, completeFromPage: 1 }
          : {
              since: new Date(lastSyncedMs - LABEL_GRACE_MS).toISOString(),
              startPage: 1,
              maxPages: REFRESH_WALK_MAX_PAGES,
              advanceCursor: false,
            });
        logger.info('weeklyIssues', 'Refresh walk finished', {
          pages: walk.pagesFetched, scanned: walk.scanned, matched: walk.matched, firstRun, hitEnd: walk.hitEnd,
        });
        await enrichAndPersist(ctx, [
          ...pendingReposFromKeys(repos, ctx.changedRepoKeys),
          ...refreshMaintenanceRepos(repos, ctx.changedRepoKeys, Date.now()),
        ], signal);
        ctx.meta.lastSyncedAt = new Date().toISOString();
        await weeklyIssuesStorage.saveSyncMeta(ctx.meta);
      }

      if (countCards(repos, onlyCollected) < page * CARD_PAGE_SIZE && !ctx.meta.historyComplete) {
        onStatus?.({ phase: 'syncing', current: 0, total: 0 });
        // Pages before overlap start were already consumed; completion check for short/empty page applies only after this page
        const completeFromPage = ctx.meta.deepNextPage;
        const walk = await walkIssuePages(ctx, {
          startPage: Math.max(1, ctx.meta.deepNextPage - 1),
          maxPages: DEEP_WALK_MAX_PAGES,
          advanceCursor: true,
          stopWhen: () => countProspectiveCards(repos, onlyCollected, ctx.changedRepoKeys) >= page * CARD_PAGE_SIZE,
          completeFromPage,
        });
        logger.info('weeklyIssues', 'Deep walk finished', {
          pages: walk.pagesFetched, scanned: walk.scanned, matched: walk.matched, hitEnd: walk.hitEnd,
        });
        await enrichAndPersist(ctx, pendingReposFromKeys(repos, ctx.changedRepoKeys), signal);
      }

      finalIssues = issues;
      finalRepos = repos;
    }, onStatus);
  }

  const issues = finalIssues ?? await weeklyIssuesStorage.getAllIssues();
  const repos = finalRepos ?? await weeklyIssuesStorage.getAllRepos();
  const historyComplete = (await weeklyIssuesStorage.getSyncMeta()).historyComplete;
  const accumulated = buildWeeklyDiscoveryRepos(repos, issues, onlyCollected);
  const start = (page - 1) * CARD_PAGE_SIZE;
  return {
    repos: accumulated.slice(start, start + CARD_PAGE_SIZE),
    hasMore: !historyComplete || accumulated.length > start + CARD_PAGE_SIZE,
    nextPageIndex: page + 1,
    totalCount: accumulated.length,
  };
}

/** Fetch issue body for "View original post" modal: prefers offline cache (works without token, still readable after logout); falls back to real-time fetch if cache misses and API is provided; otherwise returns cache as-is (possibly null). */
export async function fetchWeeklyIssueBody(
  api: GitHubApiService | null,
  issueNumber: number,
): Promise<WeeklyStoredIssue | null> {
  const stored = await weeklyIssuesStorage.getIssue(issueNumber);
  if (stored?.body) return stored;
  if (!api) return stored;
  try {
    const issue = await api.getRepositoryIssue(WEEKLY_REPO_OWNER, WEEKLY_REPO_NAME, issueNumber);
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
      state: issue.state,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      htmlUrl: issue.html_url,
      repoFullNames: [],
    };
  } catch (error) {
    logger.warn('weeklyIssues', `Fallback fetch failed for issue #${issueNumber}`, error);
    return stored;
  }
}
