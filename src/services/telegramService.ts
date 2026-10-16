/**
 * Telegram channel data service (custom scraper connecting directly to t.me public web previews without third-party instances).
 *
 * Data pipeline: Transport layer (Electron main process IPC or fullstack server route) proxies fetching of
 * https://t.me/s/<name> public preview HTML → DOMParser parses message blocks (message ID from
 * data-post, body in tgme_widget_message_text, timestamp from time[datetime]) →
 * GitHub repo links extracted from text and link previews (reuses weekly issue extraction rules) →
 * deduplicated incremental merge by `<channel>/<id>` → repo details enrichment (GraphQL batch preferred, REST per-repo
 * fallback) → dedicated IndexedDB persistence → paginated slicing in reverse chronological order.
 *
 * Pagination model (verified 2026-09): The public preview page returns the latest 20 messages per page.
 * Within the page, <link rel="prev" href="?before=N"> points to an earlier page (before=N returns messages with id < N);
 * the absence of rel="prev" indicates that the channel history is exhausted. Unlike X channels, this is real server-side
 * pagination: each "load more" fetches one page for each unexhausted followed channel. Cursors (including exhaustion flags)
 * are atomically persisted with messages across sessions; page 1 refresh always refetches the latest page without rewinding
 * advanced cursors. The 60-second watermark is only used for page 1 debouncing and does not block "load more" (clicking should paginate).
 * Pure browser (static deployment) cannot be used due to CORS restrictions; desktop or server mode is required.
 */

import type {
  DiscoveryChannelId,
  DiscoveryRepo,
  PaginatedDiscoveryRepositories,
  TelegramFollow,
  WeeklySyncStatus,
} from '../types';
import { logger } from './logger';
import { backend, getBackendAuthHeaders } from './backendAdapter';
import { fetchTelegramChannelViaDesktop } from './electronProxy';
import type { GitHubApiService } from './githubApi';
import { extractRepoFullNames } from './weeklyIssuesService';
import {
  telegramStorage,
  type TelegramStoredMessage,
  type TelegramStoredRepo,
  type TelegramSyncMeta,
} from './telegramStorage';

const TELEGRAM_CHANNEL: DiscoveryChannelId = 'telegram';
/** Number of cards per page for channel (UI pagination window) */
export const TELEGRAM_CARD_PAGE_SIZE = 20;
/** Throttle interval between per-channel fetches */
const CHANNEL_THROTTLE_MS = 500;
const REST_ENRICH_THROTTLE_MS = 80;
/** Refresh interval for repository details: snapshots within 30 days are considered fresh */
const REPO_DETAIL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Retry interval for unavailable repositories (404/private) */
const UNAVAILABLE_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
/** Skip page 1 refresh traversal if synced within 60 seconds (repeated triggers use cache; does not block load more) */
const RECENT_SYNC_SKIP_MS = 60 * 1000;

type StatusCallback = ((status: WeeklySyncStatus | null) => void) | undefined;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isAbortError = (error: unknown): boolean =>
  (error instanceof Error && (error.name === 'AbortError' || error.message === 'Aborted')) ||
  (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError');

const isRateLimitError = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith('GitHub API rate limit exceeded');

const isTokenInvalidError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('token expired or invalid');

/** Persistence failure marker: saveSyncBatch rejection must abort the entire cycle, cannot skip as channel fetch failure. */
const markPersistenceError = (error: unknown): unknown => {
  if (error instanceof Error) {
    (error as Error & { isPersistenceError?: boolean }).isPersistenceError = true;
  }
  return error;
};

const isPersistenceError = (error: unknown): boolean =>
  error instanceof Error && (error as Error & { isPersistenceError?: boolean }).isPersistenceError === true;

/** Unadvanced pagination cursor: cannot be skipped as ordinary fetch failure, otherwise hasMore stays true forever. */
const markStalledCursorError = (error: unknown): unknown => {
  if (error instanceof Error) {
    (error as Error & { isStalledCursorError?: boolean }).isStalledCursorError = true;
  }
  return error;
};

const isStalledCursorError = (error: unknown): boolean =>
  error instanceof Error && (error as Error & { isStalledCursorError?: boolean }).isStalledCursorError === true;

export const isValidTelegramChannel = (channel: string): boolean =>
  /^[A-Za-z0-9_]{3,64}$/.test(channel);

export type TelegramChannelTransport = (channel: string, before?: string) => Promise<string>;

/**
 * Transport layer: fetch t.me/s/<name> public preview HTML (before is previous page cursor).
 * Desktop uses main process IPC (following app proxy), falling back to fullstack server route on failure;
 * throws if neither is available (pure browser mode is unsupported).
 */
export const defaultTelegramChannelTransport: TelegramChannelTransport = async (channel, before) => {
  let desktopError: unknown = null;
  if (typeof window !== 'undefined' && window.electronAPI?.telegramFetchChannel) {
    try {
      const html = await fetchTelegramChannelViaDesktop(channel, before);
      if (html !== null) return html;
    } catch (error) {
      desktopError = error;
    }
  }
  const backendUrl = backend.backendUrl;
  if (backendUrl) {
    const suffix = before ? `?before=${encodeURIComponent(before)}` : '';
    const response = await fetch(`${backendUrl}/telegram/channel/${encodeURIComponent(channel)}${suffix}`, {
      headers: getBackendAuthHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Server failed to fetch t.me (${response.status})`);
    }
    const data = await response.json();
    if (typeof data?.html === 'string') return data.html;
    throw new Error('Invalid data returned from server');
  }
  if (desktopError) throw desktopError;
  throw new Error('Telegram channel scraping is not supported in current mode: requires desktop (Electron) or server mode');
};

/**
 * Parse t.me/s/<name> public preview page: messages + next page cursor.
 * Service messages (e.g., "channel created") have no body and are skipped naturally;
 * media-only messages lack text but may include repo links in link previews, which are still recorded as repo sources.
 * Relative links (?q=, /s/) in content are rewritten to absolute t.me URLs for offline clickability.
 */
export function parseTelegramChannelHtml(
  html: string,
  channel: string,
): { messages: TelegramStoredMessage[]; nextCursor: string | null; exhausted: boolean } {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // <link rel="prev" href="/s/<name>?before=N"> is the official pagination anchor; missing means exhausted
  const prevHref = doc.querySelector('link[rel="prev"]')?.getAttribute('href') ?? null;
  const prevBefore = prevHref?.match(/[?&]before=(\d+)/)?.[1] ?? null;

  const displayName =
    doc.querySelector('.tgme_widget_message_owner_name span')?.textContent?.trim()
    || doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim()
    || channel;

  const messages: TelegramStoredMessage[] = [];
  const blocks = doc.querySelectorAll('.tgme_widget_message[data-post]');
  for (const block of blocks) {
    const post = block.getAttribute('data-post') ?? '';
    const slashIndex = post.indexOf('/');
    if (slashIndex <= 0) continue;
    const postChannel = post.slice(0, slashIndex);
    const messageId = post;
    const timeEl = block.querySelector('time[datetime]');
    const datetime = timeEl?.getAttribute('datetime') ?? '';
    const createdAt = datetime && Number.isFinite(Date.parse(datetime))
      ? new Date(datetime).toISOString()
      : new Date(0).toISOString();

    const textEl = block.querySelector('.tgme_widget_message_text');
    let content = '';
    if (textEl) {
      // Rewrite relative links to absolute URLs (?q= is channel topic search, / starts site paths)
      for (const anchor of textEl.querySelectorAll('a[href]')) {
        const href = anchor.getAttribute('href');
        if (href && /^[?/]/.test(href) && !href.startsWith('//')) {
          anchor.setAttribute('href', href.startsWith('/')
            ? `https://t.me${href}`
            : `https://t.me/${channel}${href}`);
        }
      }
      content = textEl.innerHTML.trim();
    }
    // Link preview card (shared messages without text may also contain repo links)
    const previewHrefs = [...block.querySelectorAll('.tgme_widget_message_link_preview a[href], a.tgme_widget_message_link_preview[href]')]
      .map((anchor) => anchor.getAttribute('href') ?? '');
    const repoFullNames = [...new Set(
      [content, ...previewHrefs].flatMap((part) => extractRepoFullNames(part)),
    )].map((fullName) => fullName.toLowerCase());

    messages.push({
      messageId,
      channel: postChannel,
      displayName,
      content,
      htmlUrl: `https://t.me/${postChannel}/${messageId.slice(postChannel.length + 1)}`,
      createdAt,
      repoFullNames,
    });
  }

  return {
    messages,
    nextCursor: prevBefore,
    exhausted: prevBefore === null,
  };
}

/**
 * Ingest parsed results: register new messages into memory map and upsert referenced repositories
 * (source post points to the latest message by published time), returning repo keys that need details enriched this cycle.
 */
export function ingestFeedMessages(
  feed: TelegramStoredMessage[],
  messages: Map<string, TelegramStoredMessage>,
  repos: Map<string, TelegramStoredRepo>,
): { newMessages: TelegramStoredMessage[]; pendingRepoKeys: Set<string> } {
  const newMessages: TelegramStoredMessage[] = [];
  const pendingRepoKeys = new Set<string>();
  for (const message of feed) {
    const existing = messages.get(message.messageId);
    if (existing) {
      const sameRepos =
        existing.repoFullNames.length === message.repoFullNames.length &&
        existing.repoFullNames.every((name, idx) => name === message.repoFullNames[idx]);
      const isIdentical =
        existing.content === message.content &&
        existing.displayName === message.displayName &&
        sameRepos;
      if (isIdentical) continue;

      // If an existing message was edited and previously referenced repos were removed, recompute the repo's source message
      const newRepoKeys = new Set(message.repoFullNames);
      for (const oldKey of existing.repoFullNames) {
        if (!newRepoKeys.has(oldKey)) {
          const repo = repos.get(oldKey);
          if (repo && repo.sourceMessageId === message.messageId) {
            let latestOtherMsg: TelegramStoredMessage | null = null;
            for (const otherMsg of messages.values()) {
              if (otherMsg.messageId !== message.messageId && otherMsg.repoFullNames.includes(oldKey)) {
                if (!latestOtherMsg || otherMsg.createdAt > latestOtherMsg.createdAt) {
                  latestOtherMsg = otherMsg;
                }
              }
            }
            if (latestOtherMsg) {
              repo.sourceMessageId = latestOtherMsg.messageId;
              repo.messageCreatedAt = latestOtherMsg.createdAt;
            } else {
              repos.delete(oldKey);
            }
          }
        }
      }
    }

    messages.set(message.messageId, message);
    newMessages.push(message);

    for (const key of message.repoFullNames) {
      const repo = repos.get(key);
      if (!repo) {
        repos.set(key, {
          fullName: key,
          detail: null,
          lastFetchedAt: '',
          sourceMessageId: message.messageId,
          messageCreatedAt: message.createdAt,
        });
      } else if (message.createdAt >= repo.messageCreatedAt || repo.sourceMessageId === message.messageId) {
        repo.sourceMessageId = message.messageId;
        repo.messageCreatedAt = message.createdAt;
      }
      pendingRepoKeys.add(key);
    }
  }
  return { newMessages, pendingRepoKeys };
}

/** Repositories needing detail enrichment/maintenance: newly reached (never fetched), expired snapshots, or unavailable repos due for retry. */
export function reposNeedingDetail(
  repos: Map<string, TelegramStoredRepo>,
  touchedKeys: Set<string>,
  nowMs: number,
): TelegramStoredRepo[] {
  const targets: TelegramStoredRepo[] = [];
  for (const key of touchedKeys) {
    const repo = repos.get(key);
    if (!repo) continue;
    if (!repo.lastFetchedAt) {
      targets.push(repo);
    } else if (repo.detail) {
      if (nowMs - Date.parse(repo.lastFetchedAt) > REPO_DETAIL_TTL_MS) targets.push(repo);
    } else if (nowMs - Date.parse(repo.lastFetchedAt) > UNAVAILABLE_RETRY_MS) {
      targets.push(repo);
    }
  }
  return targets;
}

/** REST per-repo enrichment fallback (when GraphQL is unavailable); rate limit/auth errors are rethrown to abort this cycle. */
async function enrichReposViaRest(
  api: GitHubApiService,
  targets: TelegramStoredRepo[],
  onStatus: StatusCallback,
  signal?: AbortSignal,
): Promise<void> {
  for (let i = 0; i < targets.length; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const repo = targets[i];
    const [owner, name] = repo.fullName.split('/');
    try {
      repo.detail = await api.getRepositoryDetails(owner, name, signal);
      repo.lastFetchedAt = new Date().toISOString();
    } catch (error) {
      if (isAbortError(error) || isRateLimitError(error) || isTokenInvalidError(error)) throw error;
      // 404/410/other 4xx: mark unavailable and retry upon expiry (makeRequest already retried network/5xx errors)
      logger.warn('telegram', `Repo details unavailable: ${repo.fullName}`, error);
      repo.lastFetchedAt = new Date().toISOString();
    }
    onStatus?.({ phase: 'enriching', current: i + 1, total: targets.length });
    await sleep(REST_ENRICH_THROTTLE_MS);
  }
}

/** GraphQL batch enrichment; falls back to REST only for repositories that failed within the batch. */
async function enrichRepos(
  api: GitHubApiService,
  targets: TelegramStoredRepo[],
  onStatus: StatusCallback,
  signal?: AbortSignal,
): Promise<void> {
  if (targets.length === 0) return;
  const total = targets.length;
  onStatus?.({ phase: 'enriching', current: 0, total });
  const fullNames = targets.map((repo) => repo.fullName);
  const appliedKeys = new Set<string>();
  try {
    const details = await api.graphqlFetchRepositories(fullNames, {
      signal,
      batchSize: 100,
      onBatchDone: (doneBatches) => {
        const done = Math.min(total, doneBatches * 100);
        onStatus?.({ phase: 'enriching', current: done, total });
      },
    });
    const fetchedAtIso = new Date().toISOString();
    for (const [key, detail] of details) {
      const repo = targets.find((repo) => repo.fullName.toLowerCase() === key);
      if (!repo) continue;
      if (detail !== undefined) appliedKeys.add(key);
      repo.lastFetchedAt = fetchedAtIso;
      repo.detail = detail ?? null;
    }
  } catch (error) {
    if (isAbortError(error) || isRateLimitError(error) || isTokenInvalidError(error)) throw error;
    logger.warn('telegram', 'GraphQL batch enrichment failed, falling back to REST', error);
  }
  const restTargets = targets.filter((repo) => !appliedKeys.has(repo.fullName.toLowerCase()));
  if (restTargets.length > 0) {
    await enrichReposViaRest(api, restTargets, onStatus, signal);
  }
}

/** Build channel cards from repositories with completed details (items without details are temporarily hidden). */
export function buildTelegramDiscoveryRepos(
  messages: Map<string, TelegramStoredMessage>,
  repos: Map<string, TelegramStoredRepo>,
  channels: string[],
): DiscoveryRepo[] {
  const channelSet = new Set(channels.map((channel) => channel.toLowerCase()));
  const list: DiscoveryRepo[] = [];
  for (const repo of repos.values()) {
    if (!repo.detail) continue;
    const message = messages.get(repo.sourceMessageId);
    if (!message || !channelSet.has(message.channel.toLowerCase())) continue;
    list.push({
      ...repo.detail,
      rank: 0,
      channel: TELEGRAM_CHANNEL,
      platform: 'All',
      telegram: {
        messageId: message.messageId,
        channel: message.channel,
        displayName: message.displayName,
        content: message.content,
        html_url: message.htmlUrl,
        createdAt: message.createdAt,
      },
    });
  }
  list.sort((a, b) => (b.telegram?.createdAt ?? '').localeCompare(a.telegram?.createdAt ?? ''));
  list.forEach((repo, index) => { repo.rank = index + 1; });
  return list;
}

let syncAbortController: AbortController | null = null;
let syncInFlight: Promise<void> | null = null;

/**
 * Abort and wait for currently running Telegram channel sync to complete.
 * Primarily called before clearing cache in data management panel to prevent concurrent writes from re-persisting dirty data.
 */
export async function abortTelegramSync(): Promise<void> {
  syncAbortController?.abort();
  if (syncInFlight) {
    await syncInFlight.catch(() => {});
  }
}

/** Mutually exclusive execution: register new cycle before waiting for previous cycle to avoid overlapping requests executing body concurrently. */
async function runExclusiveSync(
  body: (signal: AbortSignal) => Promise<void>,
  onStatus: StatusCallback,
): Promise<void> {
  const controller = new AbortController();
  const prev = syncInFlight;
  const prevController = syncAbortController;
  let resolveSlot: () => void = () => {};
  const slot = new Promise<void>((resolve) => { resolveSlot = resolve; });
  // Register first: subsequent requests wait for this cycle's slot, preventing concurrent body execution
  syncAbortController = controller;
  syncInFlight = slot;
  prevController?.abort();
  // Wait for aborted cycle to finish persisting to prevent old snapshots from overwriting newly written results
  if (prev) await prev.catch(() => {});
  // May have been superseded by a newer request during wait: exit directly without executing body
  if (syncAbortController !== controller) {
    resolveSlot();
    return;
  }
  const run = body(controller.signal);
  try {
    await run;
  } finally {
    resolveSlot();
    // Only clear status if still holding sync ownership to avoid aborted old cycles wiping out new progress display
    if (syncAbortController === controller) {
      syncAbortController = null;
      syncInFlight = null;
      onStatus?.(null);
    }
  }
}

/**
 * 60-second watermark requires both: time within window + matching follows list signature.
 * Checking only the timestamp would cause follows added within 60 seconds after sync to be skipped until the window expires.
 * Watermark only debounces page 1 refresh; "load more" should paginate on every click and is not blocked.
 */
const isRecentlySynced = (meta: TelegramSyncMeta, signature: string): boolean =>
  meta.followsSignature === signature
  && meta.lastSyncedAt !== null
  && Number.isFinite(Date.parse(meta.lastSyncedAt))
  && Date.now() - Date.parse(meta.lastSyncedAt) < RECENT_SYNC_SKIP_MS;

/** Follows list signature: sorted concatenation of normalized channel names (case-insensitive deduplicated set identity) */
const followsSignatureOf = (channels: string[]): string =>
  [...new Set(channels.map((channel) => channel.toLowerCase()))].sort().join(',');

/** Channels that still have history pages to fetch (no record in pages is treated as not yet paginated) */
const channelsWithMore = (meta: TelegramSyncMeta, channels: string[]): string[] =>
  channels.filter((channel) => {
    const state = meta.pages[channel.toLowerCase()];
    return !state || !state.exhausted;
  });

/**
 * Single-channel single-page fetch-parse-persist cycle (messages + repos + cursor in same transaction).
 * Returns newly added repo keys. Fetch/parse failures are rethrown for caller to handle as "skip this channel".
 */
async function fetchAndIngestChannelPage(
  channel: string,
  before: string | null | undefined,
  meta: TelegramSyncMeta,
  messages: Map<string, TelegramStoredMessage>,
  repos: Map<string, TelegramStoredRepo>,
  transport: TelegramChannelTransport,
  signal: AbortSignal,
): Promise<Set<string>> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const html = await transport(channel, before ?? undefined);
  const parsed = parseTelegramChannelHtml(html, channel);
  const key = channel.toLowerCase();
  const known = meta.pages[key];
  if (before === null || before === undefined) {
    // page 1 refresh: cursor is only initialized if never paginated, never rewinding advanced positions
    if (!known) {
      meta.pages[key] = { cursor: parsed.nextCursor, exhausted: parsed.exhausted };
    }
  } else {
    // Requested cursor is identical to next cursor and non-empty: upstream has not advanced, persisting would make hasMore stay true forever
    if (before && parsed.nextCursor === before) {
      throw markStalledCursorError(new Error(`Telegram pagination cursor did not advance (@${channel} before=${before})`));
    }
    meta.pages[key] = { cursor: parsed.nextCursor, exhausted: parsed.exhausted };
  }
  const { newMessages, pendingRepoKeys } = ingestFeedMessages(parsed.messages, messages, repos);
  // Per-channel atomic persistence (messages + repos + cursor in same transaction; watermark is not advanced yet).
  // Write failure must rethrow to abort entire cycle: in-memory merged state cannot safely roll back, and continuing with
  // dirty state would allow unpersisted merges into final persistence (caller identifies via isPersistenceError and throws).
  try {
    await telegramStorage.saveSyncBatch({
      messages: newMessages,
      repos: [...pendingRepoKeys]
        .map((repoKey) => repos.get(repoKey))
        .filter((repo): repo is TelegramStoredRepo => Boolean(repo)),
      meta,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw markPersistenceError(error);
  }
  return pendingRepoKeys;
}

/**
 * Channel sync entry point (called by refreshChannel):
 * - page 1 (manual refresh/initial visit): when last sync was > 60s ago, refetch latest page per channel
 *   (incremental, known messages skipped by `<channel>/<id>`), batch-enrich newly reached repos;
 * - page N (load more): fetch next page for each unexhausted channel using persisted cursor (one click
 *   advances one page per channel), then rebuild slices; once all channels are exhausted, pure slicing until cache depleted.
 * Each page returns cumulative prefix (first page × 20 cards, replaced as a whole by caller) because new cards
 * from page 1 refresh fall into already consumed windows that append slices would never reach.
 */
export async function syncTelegramChannel(
  api: GitHubApiService,
  page: number,
  follows: TelegramFollow[],
  onStatus: StatusCallback,
  transport: TelegramChannelTransport = defaultTelegramChannelTransport,
): Promise<PaginatedDiscoveryRepositories> {
  const channels = [...new Set(
    follows.map((follow) => follow.channel).filter((channel) => isValidTelegramChannel(channel)),
  )];
  if (channels.length === 0) {
    return { repos: [], hasMore: false, nextPageIndex: page + 1, totalCount: 0 };
  }

  const windowEnd = page * TELEGRAM_CARD_PAGE_SIZE;
  const signature = followsSignatureOf(channels);
  const meta0 = await telegramStorage.getSyncMeta();
  const recent = isRecentlySynced(meta0, signature);
  // Pre-read snapshot: reuse directly as settled data when not hitting network, avoiding duplicate full scans in same call
  let snapshot: { messages: Map<string, TelegramStoredMessage>; repos: Map<string, TelegramStoredRepo> } | null = null;
  let needsSync = page <= 1 && !recent;
  if (!needsSync) {
    const [messages, repos] = await Promise.all([
      telegramStorage.getAllMessages(),
      telegramStorage.getAllRepos(),
    ]);
    snapshot = { messages, repos };
    if (page > 1) {
      needsSync = channelsWithMore(meta0, channels).length > 0;
    }
  }

  if (needsSync) {
    await runExclusiveSync(async (signal) => {
      // Previous cycle may have persisted new data, re-read latest state
      const meta = await telegramStorage.getSyncMeta();
      if (page <= 1 && isRecentlySynced(meta, signature)) return;
      meta.followsSignature = signature;
      const messages = await telegramStorage.getAllMessages();
      const repos = await telegramStorage.getAllRepos();

      const touchedRepoKeys = new Set<string>();
      let succeeded = 0;
      let firstError: unknown = null;
      // page N only advances unexhausted channels; page 1 always refetches latest page for all channels
      const targets = page <= 1 ? channels : channelsWithMore(meta, channels);
      for (const channel of targets) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        onStatus?.({ phase: 'syncing', current: succeeded, total: targets.length });
        const before = page <= 1 ? null : (meta.pages[channel.toLowerCase()]?.cursor ?? null);
        try {
          const pendingKeys = await fetchAndIngestChannelPage(
            channel, before, meta, messages, repos, transport, signal,
          );
          for (const key of pendingKeys) touchedRepoKeys.add(key);
        } catch (error) {
          if (isAbortError(error) || isPersistenceError(error) || isStalledCursorError(error)) throw error;
          // Fetch/parse failure only skips this channel (unreachable channel/network jitter won't fail the whole cycle)
          logger.warn('telegram', `Channel page fetch failed for @${channel}`, error);
          firstError = firstError ?? error;
          await sleep(CHANNEL_THROTTLE_MS);
          continue;
        }
        succeeded++;
        await sleep(CHANNEL_THROTTLE_MS);
      }
      if (succeeded === 0 && targets.length > 0) {
        throw firstError instanceof Error
          ? firstError
          : new Error('Telegram channel sync failed: all channels are unreachable');
      }

      const enrichTargets = reposNeedingDetail(repos, touchedRepoKeys, Date.now());
      const touchedRepos = () => [...touchedRepoKeys]
        .map((key) => repos.get(key))
        .filter((repo): repo is TelegramStoredRepo => Boolean(repo));
      try {
        await enrichRepos(api, enrichTargets, onStatus, signal);
        // Success path: details and watermark committed in same transaction—if rolled back on failure, next cycle refetches
        // instead of skipping with new watermark and leaving unenriched repos until TTL
        meta.lastSyncedAt = new Date().toISOString();
        await telegramStorage.saveSyncBatch({ messages: [], repos: touchedRepos(), meta });
      } catch (error) {
        if (isAbortError(error)) {
          // Canceled: keep fetched details, but do not advance watermark (continue enrichment next cycle)
          await telegramStorage.saveSyncBatch({ messages: [], repos: touchedRepos(), meta });
        }
        // Rate limit/token error: do not commit partial or degraded details, nor advance watermark
        throw error;
      }
    }, onStatus);
  }

  // Network cycles already persist atomically internally, read latest on settle; non-network cycles reuse pre-read snapshot
  const settled = needsSync
    ? {
        messages: await telegramStorage.getAllMessages(),
        repos: await telegramStorage.getAllRepos(),
      }
    : snapshot!;
  const settledMeta = await telegramStorage.getSyncMeta();
  const accumulated = buildTelegramDiscoveryRepos(settled.messages, settled.repos, channels);
  const allExhausted = channelsWithMore(settledMeta, channels).length === 0;
  return {
    repos: accumulated.slice(0, windowEnd),
    hasMore: allExhausted ? accumulated.length > windowEnd : true,
    nextPageIndex: page + 1,
    totalCount: accumulated.length,
  };
}

/** Settings modal "Test Connection": fetches latest page of a channel and parses it, returning verifiable results. */
export async function probeTelegramSource(
  channel: string,
  transport: TelegramChannelTransport = defaultTelegramChannelTransport,
): Promise<{ ok: boolean; messageCount?: number; repoCount?: number; error?: string }> {
  if (!isValidTelegramChannel(channel)) {
    return { ok: false, error: 'Invalid channel name' };
  }
  try {
    const html = await transport(channel);
    const parsed = parseTelegramChannelHtml(html, channel);
    if (parsed.messages.length === 0) {
      return {
        ok: false,
        error: 'No public messages found: channel may not exist, has been made private, or has no public messages',
      };
    }
    return {
      ok: true,
      messageCount: parsed.messages.length,
      repoCount: parsed.messages.reduce((sum, message) => sum + message.repoFullNames.length, 0),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
