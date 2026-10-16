/**
 * X tweet channel data service (in-house scraper connecting directly to x.com without third-party instances).
 *
 * Two scraping modes:
 * - Unauthenticated (default): Transport layer (Electron main process IPC or fullstack server route)
 *   fetches the unauthenticated https://x.com/<handle> profile HTML -> parses embedded React
 *   Flight data (tweet ID decoded from `client:VHdlZXQ6<base64>` reference, body and link
 *   entities inside `:details` block, timestamp derived from Snowflake ID) -> extracts GitHub
 *   repository links from expanded_url (reusing weekly issue rules). Capability boundary (tested 2026-09):
 *   returns the latest small batch of tweets per creator without historical pagination cursors.
 * - Authenticated (user configures their own auth_token/ct0 in settings): connects to internal
 *   x.com GraphQL endpoints (public Web Bearer + user Cookie), resolves rest_id via UserByScreenName,
 *   pulls timeline via UserTweets—approx. 20 tweets per creator per page, with bottom cursor supporting real
 *   server-side pagination (isomorphic to Telegram channel: cursors persisted across sessions, page 1 refresh
 *   does not roll back advanced cursors, 60s throttle only checks page 1). queryId rotates with site releases:
 *   cache hits take priority; on miss/404, re-extracted from main.<hash>.js bundle referenced on authenticated
 *   homepage, falling back to built-in fallback values.
 * - Auth degradation (2026-10): x.com edge WAF intercepts Node network stacks by TLS fingerprint
 *   (403 HTML challenge page, while Chromium stack passes); when authenticated requests fail, transport layer
 *   automatically degrades to guest flow without login (guest token + Chromium stack). Public accounts remain
 *   accessible, though guest timelines lack pagination cursors (latest page only per creator).
 *
 * Shared across both paths: repository upsert (original post points to latest tweet) -> detail enrichment
 * (GraphQL batching preferred, REST per-repo fallback) -> dedicated IndexedDB persistence -> paginated slicing
 * sorted descending by tweet timestamp. In pure browser mode (static deploy), blocked by CORS; requires desktop
 * or server mode.
 */

import type {
  DiscoveryChannelId,
  DiscoveryRepo,
  PaginatedDiscoveryRepositories,
  WeeklySyncStatus,
  XTweetAuth,
  XTweetFollow,
} from '../types';
import { logger } from './logger';
import { backend, getBackendAuthHeaders } from './backendAdapter';
import { fetchXTimelineViaDesktop, fetchXGraphQLViaDesktop } from './electronProxy';
import type { GitHubApiService } from './githubApi';
import { extractRepoFullNames } from './weeklyIssuesService';
import {
  xTweetStorage,
  type XStoredRepo,
  type XStoredTweet,
  type XTweetSyncMeta,
} from './xTweetStorage';

const X_TWEET_CHANNEL: DiscoveryChannelId = 'x-tweet';
/** Number of cards per channel page */
export const X_TWEET_CARD_PAGE_SIZE = 20;
const HANDLE_THROTTLE_MS = 500;
const REST_ENRICH_THROTTLE_MS = 80;
/** Refresh cycle for repo details: snapshots within 30 days considered fresh */
const REPO_DETAIL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Retry cycle for unavailable repositories (404/private) */
const UNAVAILABLE_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
/** Skip refresh traversal if synced within 60 seconds (repeat triggers use cache) */
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

/** Persistence error marker: saveSyncBatch rejection must abort whole round, cannot skip as creator fetch failure. */
const markPersistenceError = (error: unknown): unknown => {
  if (error instanceof Error) {
    (error as Error & { isPersistenceError?: boolean }).isPersistenceError = true;
  }
  return error;
};

const isPersistenceError = (error: unknown): boolean =>
  error instanceof Error && (error as Error & { isPersistenceError?: boolean }).isPersistenceError === true;

/** Pagination cursor did not advance: cannot be skipped as normal fetch failure, otherwise hasMore remains permanently true. */
const markStalledCursorError = (error: unknown): unknown => {
  if (error instanceof Error) {
    (error as Error & { isStalledCursorError?: boolean }).isStalledCursorError = true;
  }
  return error;
};

const isStalledCursorError = (error: unknown): boolean =>
  error instanceof Error && (error as Error & { isStalledCursorError?: boolean }).isStalledCursorError === true;

const isUpstreamNotFound = (error: unknown): boolean =>
  /\b404\b/.test(error instanceof Error ? error.message : String(error));

export const isValidXTweetHandle = (handle: string): boolean =>
  /^[A-Za-z0-9_]{1,15}$/.test(handle);

export type XTimelineTransport = (handle: string) => Promise<string>;

/**
 * Transport layer: fetches unauthenticated x.com profile HTML. Desktop uses main process IPC (honoring app proxy),
 * falling back to fullstack server route on failure; throws if neither is available (unsupported in pure browser mode).
 */
export const defaultXTimelineTransport: XTimelineTransport = async (handle) => {
  let desktopError: unknown = null;
  if (typeof window !== 'undefined' && window.electronAPI?.xFetchTimeline) {
    try {
      const html = await fetchXTimelineViaDesktop(handle);
      if (html !== null) return html;
    } catch (error) {
      desktopError = error;
    }
  }
  const backendUrl = backend.backendUrl;
  if (backendUrl) {
    const response = await fetch(`${backendUrl}/xtweet/profile/${encodeURIComponent(handle)}`, {
      headers: getBackendAuthHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch x.com from server (${response.status})`);
    }
    const data = await response.json();
    if (typeof data?.html === 'string') return data.html;
    throw new Error('Invalid data returned from server');
  }
  if (desktopError) throw desktopError;
  throw new Error('Current runtime mode does not support X tweet scraping: desktop (Electron) or server mode required');
};

/** Decodes tweet ID from Flight client reference (VHdlZXQ6… == base64("Tweet:<id>")) */
export function decodeTweetRef(ref: string): string | null {
  try {
    const decoded = atob(ref);
    const match = decoded.match(/^Tweet:(\d+)$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/* ============ Authenticated GraphQL Path ============ */

/** Fallback queryId (tested 2026-09; queryId rotates with x.com releases, re-extracted on cache miss) */
const FALLBACK_X_QUERY_IDS: Record<string, string> = {
  UserTweets: 'OeFjWKHutsuyWXZGmLr02A',
  UserByScreenName: 'KybxDj9RrADIITXlGG8kpw',
};
const X_GRAPHQL_OPERATIONS = ['UserTweets', 'UserByScreenName'] as const;
/** Number of tweets requested per page (matching official web client) */
const USER_TWEETS_PAGE_SIZE = 20;

const X_GRAPHQL_FEATURES = JSON.stringify({
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_metadata_extensions_enabled: true,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
});

/**
 * Authenticated path transport layer: GET an x.com GraphQL / static asset URL, returning response body.
 * Auth Cookies are only passed via desktop IPC arguments or server POST body (no sensitive info in URL).
 * Throws on non-2xx (message includes status code for upstream mapping of "auth expired / rate limited").
 * auth allows null (unauthenticated guest flow): when authenticated Cookie requests receive x.com edge WAF
 * 403 (intercepting Node network stack by TLS fingerprint), automatically degrades to guest and retries same URL—public
 * accounts can fetch timelines without Cookie; other errors (e.g. 401 auth expired) do not degrade.
 */
export type XGraphQLTransport = (url: string, auth: XTweetAuth | null) => Promise<string>;

export const defaultXGraphQLTransport: XGraphQLTransport = async (url, auth) => {
  let desktopError: unknown = null;
  if (typeof window !== 'undefined' && window.electronAPI?.xFetchGraphQL) {
    try {
      const body = await fetchXGraphQLViaDesktop(url, auth);
      if (body !== null) return body;
    } catch (error) {
      if (auth && error instanceof Error && error.message.includes('403')) {
        // Auth request blocked by x.com edge WAF 403: degrade to unauthenticated guest flow and retry same URL;
        // if guest also fails, preserve its error (closer to root cause than 403) and proceed to server fallback
        try {
          const guestBody = await fetchXGraphQLViaDesktop(url, null);
          if (guestBody !== null) return guestBody;
        } catch (guestError) {
          desktopError = guestError;
        }
      } else {
        desktopError = error;
      }
    }
  }
  const backendUrl = backend.backendUrl;
  if (backendUrl) {
    const response = await fetch(`${backendUrl}/xtweet/graphql`, {
      method: 'POST',
      headers: getBackendAuthHeaders(),
      body: JSON.stringify({ url, auth }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      let upstreamStatus: number | undefined;
      try {
        const payload = await response.clone().json() as { upstreamStatus?: unknown };
        if (typeof payload?.upstreamStatus === 'number') upstreamStatus = payload.upstreamStatus;
      } catch {
        // Non-JSON error body: report outer status only
      }
      const reported = upstreamStatus ?? response.status;
      throw new Error(`Failed to execute server-side X GraphQL request (${reported})`);
    }
    const data = await response.json();
    if (typeof data?.body === 'string') return data.body;
    throw new Error('Invalid data returned from server');
  }
  if (desktopError) throw desktopError;
  throw new Error('Current runtime mode does not support authenticated X scraping: desktop (Electron) or server mode required');
};

const compactJson = (value: Record<string, unknown>): string => JSON.stringify(value);

/** UserTweets request URL (empty cursor means page 1) */
export const buildUserTweetsUrl = (
  userId: string,
  cursor: string | null | undefined,
  queryId: string,
): string =>
  `https://x.com/i/api/graphql/${queryId}/UserTweets?variables=${encodeURIComponent(compactJson({
    userId,
    count: USER_TWEETS_PAGE_SIZE,
    ...(cursor ? { cursor } : {}),
    includePromotedContent: false,
    withQuickPromoteEligibilityTweetFields: false,
    withVoice: false,
  }))}&features=${encodeURIComponent(X_GRAPHQL_FEATURES)}`;

/** UserByScreenName request URL (handle -> rest_id) */
export const buildUserByScreenNameUrl = (handle: string, queryId: string): string =>
  `https://x.com/i/api/graphql/${queryId}/UserByScreenName?variables=${encodeURIComponent(compactJson({
    screen_name: handle,
    withGrokTranslatedBio: false,
  }))}`;

/**
 * Extracts current queryId from main.<hash>.js bundle referenced on authenticated homepage
 * (queryId rotates with x.com releases; only authenticated home references bundle containing all operations).
 */
export async function extractXGraphQLQueryIds(
  auth: XTweetAuth,
  graphQL: XGraphQLTransport,
): Promise<Record<string, string>> {
  const homeHtml = await graphQL('https://x.com/home', auth);
  const mainJsUrl = homeHtml.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/main\.[a-zA-Z0-9_-]+\.js/)?.[0];
  if (!mainJsUrl) throw new Error('Could not locate x.com main script (page structure may have changed)');
  const mainJs = await graphQL(mainJsUrl, auth);
  const ids: Record<string, string> = {};
  for (const operation of X_GRAPHQL_OPERATIONS) {
    const id = mainJs.match(new RegExp(`queryId:"([A-Za-z0-9_-]+)",operationName:"${operation}"`))?.[1]
      || mainJs.match(new RegExp(`operationName:"${operation}"[^{}]*?queryId:"([A-Za-z0-9_-]+)"`))?.[1];
    if (id) ids[operation] = id;
  }
  if (!ids.UserTweets || !ids.UserByScreenName) {
    throw new Error('Could not extract GraphQL queryId from x.com main script');
  }
  return ids;
}

/** queryId resolution: meta cache -> online bundle extraction (caches on success) -> built-in fallback. */
async function resolveXQueryIds(
  meta: XTweetSyncMeta,
  auth: XTweetAuth,
  graphQL: XGraphQLTransport,
): Promise<Record<string, string>> {
  if (meta.queryIds.UserTweets && meta.queryIds.UserByScreenName) return meta.queryIds;
  try {
    const ids = await extractXGraphQLQueryIds(auth, graphQL);
    meta.queryIds = { ...meta.queryIds, ...ids };
    void xTweetStorage.saveSyncMeta(meta);
    return meta.queryIds;
  } catch (error) {
    logger.warn('xTweet', 'queryId bundle extraction failed, using fallback', error);
    return { ...FALLBACK_X_QUERY_IDS, ...meta.queryIds };
  }
}

/** User ID resolution: meta cache -> UserByScreenName. On queryId 404, invalidates cache and retries once after re-extraction. */
async function resolveXUserId(
  handle: string,
  meta: XTweetSyncMeta,
  auth: XTweetAuth,
  graphQL: XGraphQLTransport,
): Promise<string> {
  const cached = meta.userIds[handle.toLowerCase()];
  if (cached) return cached;
  const ids = await resolveXQueryIds(meta, auth, graphQL);
  let body: string;
  try {
    body = await graphQL(buildUserByScreenNameUrl(handle, ids.UserByScreenName), auth);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('401')) {
      throw new Error('X authentication expired (auth_token/ct0 invalid or expired). Please update or clear authentication in settings.');
    }
    if (message.includes('403')) {
      throw new Error('X request rejected (HTTP 403: may have triggered Cloudflare firewall block, IP rate limit, or account restriction)');
    }
    if (!isUpstreamNotFound(error)) throw error;
    logger.warn('xTweet', 'UserByScreenName queryId stale, re-extracting from bundle');
    delete meta.queryIds.UserByScreenName;
    const fresh = await resolveXQueryIds(meta, auth, graphQL);
    body = await graphQL(buildUserByScreenNameUrl(handle, fresh.UserByScreenName), auth);
  }
  const restId = JSON.parse(body)?.data?.user?.result?.rest_id;
  if (typeof restId !== 'string' || !restId) {
    throw new Error(`Could not resolve user ID for @${handle} (account may not exist or be restricted)`);
  }
  meta.userIds[handle.toLowerCase()] = restId;
  return restId;
}

/** Tweet timestamp ("Sun Sep 13 06:17:25 +0000 2026") -> ISO; falls back to epoch if unparseable. */
export function tweetDateToIso(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date(0).toISOString();
}

const escapeHtmlText = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * full_text + url entities -> display HTML fragment: replaces t.co short links
 * with anchors pointing to expanded_url based on entity indices, escapes the rest
 * of the text, and converts newlines to <br/>. Indices slice segments by UTF-16 code units
 * (consistent with Twitter's indices semantics).
 */
export function buildTweetContentHtml(
  fullText: string,
  urls: Array<{ url?: string; expanded_url?: string; indices?: [number, number] }>,
): string {
  const sorted = [...urls]
    .filter((u) => Array.isArray(u.indices) && u.indices.length === 2)
    .sort((a, b) => a.indices![0] - b.indices![0]);
  const parts: string[] = [];
  let pos = 0;
  for (const entity of sorted) {
    const [start, end] = entity.indices!;
    if (start < pos || start >= end || end > fullText.length) continue;
    parts.push(escapeHtmlText(fullText.slice(pos, start)));
    const href = entity.expanded_url || entity.url || '';
    parts.push(`<a href="${escapeHtmlText(href)}">${escapeHtmlText(fullText.slice(start, end))}</a>`);
    pos = end;
  }
  parts.push(escapeHtmlText(fullText.slice(pos)));
  return parts.join('').replace(/\n/g, '<br/>');
}

interface TweetLegacyCore {
  full_text?: string;
  created_at?: string;
  entities?: { urls?: Array<{ url?: string; expanded_url?: string; indices?: [number, number] }> };
}

/**
 * Parses UserTweets response JSON: timeline entries -> tweets (including retweets, attributed to the author).
 * Throws readable errors on expired authentication (code 32/239); errors for non-existent/restricted accounts are skipped by the caller.
 * cursor-bottom is the next page cursor; absence indicates the timeline is exhausted.
 */
export function parseXUserTweetsJson(
  body: string,
  handle: string,
): { tweets: XStoredTweet[]; nextCursor: string | null; exhausted: boolean } {
  let data: {
    errors?: Array<{ code?: number; message?: string }>;
    data?: {
      user?: {
        result?: {
          __typename?: string;
          core?: { name?: string };
          timeline_v2?: XTimelinePayload;
          timeline?: XTimelinePayload;
        };
      };
    };
  };
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error('X GraphQL response is not valid JSON');
  }
  if (!data?.data && Array.isArray(data?.errors) && data.errors.length > 0) {
    const code = data.errors[0]?.code;
    if (code === 32 || code === 239 || code === 89 || code === 326) {
      throw new Error('X authentication expired (auth_token/ct0 invalid or expired). Please update or clear authentication in settings.');
    }
    throw new Error(`X GraphQL error: ${data.errors[0]?.message ?? 'unknown'}`);
  }
  const userResult = data?.data?.user?.result;
  if (!userResult || userResult.__typename === 'UserUnavailable') {
    throw new Error(`Failed to fetch timeline for @${handle} (account may not exist, be restricted, or be deactivated)`);
  }
  const displayName = userResult.core?.name || handle;
  const instructions = (userResult.timeline_v2 ?? userResult.timeline)?.timeline?.instructions ?? [];
  const entries = (instructions.find((instruction) => instruction.type === 'TimelineAddEntries')?.entries ?? []) as Array<{
    entryId?: string;
    content?: {
      entryType?: string;
      value?: string;
      itemContent?: {
        tweet_results?: {
          result?: {
            __typename?: string;
            rest_id?: string;
            legacy?: TweetLegacyCore;
            tweet?: { rest_id?: string; legacy?: TweetLegacyCore };
          };
        };
      };
    };
  }>;

  const tweets: XStoredTweet[] = [];
  let nextCursor: string | null = null;
  for (const entry of entries) {
    const entryId = entry.entryId ?? '';
    if (entryId.startsWith('cursor-bottom') && entry.content?.value) {
      nextCursor = entry.content.value;
      continue;
    }
    if (!entryId.startsWith('tweet-') || entry.content?.entryType !== 'TimelineTimelineItem') continue;
    const result = entry.content?.itemContent?.tweet_results?.result;
    if (!result || result.__typename === 'TweetTombstone') continue;
    const tweetId = result.rest_id ?? result.tweet?.rest_id ?? entryId.slice('tweet-'.length);
    const legacy = result.legacy ?? result.tweet?.legacy;
    if (!tweetId || !legacy?.full_text) continue;
    const urls = legacy.entities?.urls ?? [];
    tweets.push({
      tweetId,
      handle,
      displayName,
      content: buildTweetContentHtml(legacy.full_text, urls),
      htmlUrl: `https://x.com/${handle}/status/${tweetId}`,
      createdAt: tweetDateToIso(legacy.created_at ?? ''),
      repoFullNames: [...new Set(
        extractRepoFullNames([
          ...urls.map((u) => u.expanded_url ?? ''),
          legacy.full_text,
        ].join('\n')),
      )].map((fullName) => fullName.toLowerCase()),
    });
  }
  return { tweets, nextCursor, exhausted: nextCursor === null };
}

interface XTimelinePayload {
  timeline?: { instructions?: Array<{ type?: string; entries?: unknown }> };
}

/** Authenticated fetch for a single author's page: invalidates cached queryId on 404, re-extracts, and retries once. */
async function fetchXUserTimelinePage(
  userId: string,
  cursor: string | null | undefined,
  meta: XTweetSyncMeta,
  auth: XTweetAuth,
  graphQL: XGraphQLTransport,
): Promise<string> {
  const ids = await resolveXQueryIds(meta, auth, graphQL);
  try {
    return await graphQL(buildUserTweetsUrl(userId, cursor, ids.UserTweets), auth);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('401')) {
      throw new Error('X authentication expired (auth_token/ct0 invalid or expired). Please update or clear authentication in settings.');
    }
    if (message.includes('403')) {
      throw new Error('X request rejected (HTTP 403: may have triggered Cloudflare firewall block, IP rate limit, or account restriction)');
    }
    if (!isUpstreamNotFound(error)) throw error;
    logger.warn('xTweet', 'UserTweets queryId stale, re-extracting from bundle');
    delete meta.queryIds.UserTweets;
    const fresh = await resolveXQueryIds(meta, auth, graphQL);
    return graphQL(buildUserTweetsUrl(userId, cursor, fresh.UserTweets), auth);
  }
}

/** Authors who still have history pages to fetch (no entry in pages means unpaginated) */
const handlesWithMore = (meta: XTweetSyncMeta, handles: string[]): string[] =>
  handles.filter((handle) => {
    const state = meta.pages[handle.toLowerCase()];
    return !state || !state.exhausted;
  });

/**
 * Single author page fetch-parse-persist (tweets + repos + cursor/userId/queryId in the same transaction),
 * returning repo keys touched in this round. Fetch/parse failures are thrown upward for the caller to skip
 * that author. When cursor is null/undefined (page 1 or the author has never been paginated), the latest page
 * is fetched and written only if the cursor was never initialized—never rolling back an advanced cursor position.
 */
async function fetchAndIngestXUserPage(
  handle: string,
  page: number,
  meta: XTweetSyncMeta,
  auth: XTweetAuth,
  tweets: Map<string, XStoredTweet>,
  repos: Map<string, XStoredRepo>,
  graphQL: XGraphQLTransport,
  signal: AbortSignal,
): Promise<Set<string>> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const userId = await resolveXUserId(handle, meta, auth, graphQL);
  const key = handle.toLowerCase();
  const known = meta.pages[key];
  const cursor = page <= 1
    ? null
    : (meta.pages[key]?.cursor ?? null);
  const body = await fetchXUserTimelinePage(userId, cursor, meta, auth, graphQL);
  const parsed = parseXUserTweetsJson(body, handle);
  if (cursor === null || cursor === undefined) {
    // Latest page: cursor is initialized only when never paginated, never rolling back an advanced position
    if (!known) {
      meta.pages[key] = { cursor: parsed.nextCursor, exhausted: parsed.exhausted };
    }
  } else {
    // If request cursor matches next cursor and is non-empty: upstream did not advance; persisting would keep hasMore permanently true
    if (cursor && parsed.nextCursor === cursor) {
      throw markStalledCursorError(new Error(`X pagination cursor did not advance (@${handle})`));
    }
    meta.pages[key] = { cursor: parsed.nextCursor, exhausted: parsed.exhausted };
  }
  const { newTweets, pendingRepoKeys } = ingestFeedTweets(parsed.tweets, tweets, repos);
  // Atomic per-author persistence (tweets + repos + meta in the same transaction; watermark is not advanced yet).
  // Write failures are marked and thrown to abort the entire round (identified via isPersistenceError by caller).
  try {
    await xTweetStorage.saveSyncBatch({
      tweets: newTweets,
      repos: [...pendingRepoKeys]
        .map((repoKey) => repos.get(repoKey))
        .filter((repo): repo is XStoredRepo => Boolean(repo)),
      meta,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw markPersistenceError(error);
  }
  return pendingRepoKeys;
}

/** Snowflake ID -> creation time (Twitter epoch 1288834974657). ID exceeds safe Number range, so BigInt is required. */
export function tweetSnowflakeToDate(tweetId: string): string {
  try {
    const ms = (BigInt(tweetId) >> 22n) + 1288834974657n;
    return new Date(Number(ms)).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/** Flight embedded strings are JS string literals (with \n \" escapes), restored following JSON string semantics. */
const unescapeFlightString = (raw: string): string => {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
};

const TWEET_MARK_PATTERN = /client:(VHdlZXQ6[A-Za-z0-9+/=]+):(legacy|details|counts|views)/g;
/** Top-level timeline entry: TimelineTimelineEntry:tweet-<ID>:content (nested quotes/retweets are excluded) */
const TIMELINE_ENTRY_PATTERN = /TimelineTimelineEntry:tweet-(\d+):content/g;

/**
 * Parses tweets from the unauthenticated x.com home HTML. Only accepts tweets listed
 * in top-level timeline entries—nested quoted tweets belong to other authors, and including
 * them would misattribute them to the followed author. Each tweet's `:details` block contains
 * full_text and link entities. References to the same tweet can appear multiple times in the
 * Flight graph and are deduplicated by ID.
 */
export function parseXTimelineHtml(html: string, handle: string): XStoredTweet[] {
  const timelineIds = new Set([...html.matchAll(TIMELINE_ENTRY_PATTERN)].map((m) => m[1]));
  const tweets = new Map<string, XStoredTweet>();
  const marks = [...html.matchAll(TWEET_MARK_PATTERN)];
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    if (mark[2] !== 'details') continue;
    const tweetId = decodeTweetRef(mark[1]);
    if (!tweetId || !timelineIds.has(tweetId) || tweets.has(tweetId)) continue;
    const blockStart = (mark.index ?? 0) + mark[0].length;
    const blockEnd = i + 1 < marks.length ? (marks[i + 1].index ?? blockStart) : blockStart + 8000;
    const body = html.slice(blockStart, blockEnd);
    const fullText = body.match(/full_text:"((?:[^"\\]|\\.)*)"/);
    if (!fullText) continue;
    const content = unescapeFlightString(fullText[1]);
    const repoFullNames = [...new Set(
      [...body.matchAll(/expanded_url:"(https:\/\/github\.com\/[^"]+)"/g)]
        .map((m) => extractRepoFullNames(unescapeFlightString(m[1])))
        .flat(),
    )].map((fullName) => fullName.toLowerCase());
    tweets.set(tweetId, {
      tweetId,
      handle,
      displayName: handle,
      content,
      htmlUrl: `https://x.com/${handle}/status/${tweetId}`,
      createdAt: tweetSnowflakeToDate(tweetId),
      repoFullNames,
    });
  }
  return [...tweets.values()];
}

/**
 * Processes one round of parsing results: adds new tweets to in-memory maps,
 * upserts referenced repos (original post points to the latest tweet by creation time),
 * and returns repo keys needing detail enrichment in this round.
 */
export function ingestFeedTweets(
  feed: XStoredTweet[],
  tweets: Map<string, XStoredTweet>,
  repos: Map<string, XStoredRepo>,
): { newTweets: XStoredTweet[]; pendingRepoKeys: Set<string> } {
  const newTweets: XStoredTweet[] = [];
  const pendingRepoKeys = new Set<string>();
  for (const tweet of feed) {
    if (tweets.has(tweet.tweetId)) continue;
    tweets.set(tweet.tweetId, tweet);
    newTweets.push(tweet);

    for (const key of tweet.repoFullNames) {
      const repo = repos.get(key);
      if (!repo) {
        repos.set(key, {
          fullName: key,
          detail: null,
          lastFetchedAt: '',
          sourceTweetId: tweet.tweetId,
          tweetCreatedAt: tweet.createdAt,
        });
      } else if (tweet.createdAt > repo.tweetCreatedAt) {
        repo.sourceTweetId = tweet.tweetId;
        repo.tweetCreatedAt = tweet.createdAt;
      }
      pendingRepoKeys.add(key);
    }
  }
  return { newTweets, pendingRepoKeys };
}

/** Repos needing detail enrichment/maintenance: newly discovered (never fetched), expired snapshots, and unavailable repos due for retry. */
export function reposNeedingDetail(
  repos: Map<string, XStoredRepo>,
  touchedKeys: Set<string>,
  nowMs: number,
): XStoredRepo[] {
  const targets: XStoredRepo[] = [];
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

/** Fallback REST per-repo enrichment path (when GraphQL is unavailable); rate-limit/auth errors are rethrown directly to abort this round. */
async function enrichReposViaRest(
  api: GitHubApiService,
  targets: XStoredRepo[],
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
      // 404/410/other 4xx: mark as unavailable and retry after expiry (makeRequest already performed network/5xx retries)
      logger.warn('xTweet', `Repo details unavailable: ${repo.fullName}`, error);
      repo.lastFetchedAt = new Date().toISOString();
    }
    onStatus?.({ phase: 'enriching', current: i + 1, total: targets.length });
    await sleep(REST_ENRICH_THROTTLE_MS);
  }
}

/** Batch enrichment via GraphQL; falls back to REST only for repos that failed when partial batches error. */
async function enrichRepos(
  api: GitHubApiService,
  targets: XStoredRepo[],
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
    logger.warn('xTweet', 'GraphQL batch enrichment failed, falling back to REST', error);
  }
  const restTargets = targets.filter((repo) => !appliedKeys.has(repo.fullName.toLowerCase()));
  if (restTargets.length > 0) {
    await enrichReposViaRest(api, restTargets, onStatus, signal);
  }
}

/** Builds channel discovery cards from repos with enriched details (entries without details are hidden for now). */
export function buildXTweetDiscoveryRepos(
  tweets: Map<string, XStoredTweet>,
  repos: Map<string, XStoredRepo>,
  handles: string[],
): DiscoveryRepo[] {
  const handleSet = new Set(handles.map((handle) => handle.toLowerCase()));
  const list: DiscoveryRepo[] = [];
  for (const repo of repos.values()) {
    if (!repo.detail) continue;
    const tweet = tweets.get(repo.sourceTweetId);
    if (!tweet || !handleSet.has(tweet.handle.toLowerCase())) continue;
    list.push({
      ...repo.detail,
      rank: 0,
      channel: X_TWEET_CHANNEL,
      platform: 'All',
      xTweet: {
        tweetId: tweet.tweetId,
        handle: tweet.handle,
        displayName: tweet.displayName,
        content: tweet.content,
        html_url: tweet.htmlUrl,
        createdAt: tweet.createdAt,
      },
    });
  }
  list.sort((a, b) => (b.xTweet?.createdAt ?? '').localeCompare(a.xTweet?.createdAt ?? ''));
  list.forEach((repo, index) => { repo.rank = index + 1; });
  return list;
}

let syncAbortController: AbortController | null = null;
let syncInFlight: Promise<void> | null = null;

/**
 * Aborts and waits for any currently running X tweet sync to finish.
 * Primarily called before clearing cache in the data management panel to prevent
 * concurrent writes from persisting stale data right after cleanup.
 */
export async function abortXTweetSync(): Promise<void> {
  syncAbortController?.abort();
  if (syncInFlight) {
    await syncInFlight.catch(() => {});
  }
}

/** Mutex execution: registers the new round before waiting for the previous one to avoid concurrent body execution on overlapping requests. */
async function runExclusiveSync(
  body: (signal: AbortSignal) => Promise<void>,
  onStatus: StatusCallback,
): Promise<void> {
  const controller = new AbortController();
  const prev = syncInFlight;
  const prevController = syncAbortController;
  let resolveSlot: () => void = () => {};
  const slot = new Promise<void>((resolve) => { resolveSlot = resolve; });
  // Register first: subsequent requests will wait on this round's slot and will not enter body concurrently
  syncAbortController = controller;
  syncInFlight = slot;
  prevController?.abort();
  if (prev) await prev.catch(() => {});
  // May have been superseded by a newer request during the wait: exit immediately without running body
  if (syncAbortController !== controller) {
    resolveSlot();
    return;
  }
  const run = body(controller.signal);
  try {
    await run;
  } finally {
    resolveSlot();
    if (syncAbortController === controller) {
      syncAbortController = null;
      syncInFlight = null;
      onStatus?.(null);
    }
  }
}

/**
 * The 60-second watermark requires both: time within the window + identical follows signature.
 * Checking only timestamps would cause newly followed authors added within 60s of a sync to be skipped until the window expires.
 */
const isRecentlySynced = (meta: { lastSyncedAt: string | null; followsSignature: string }, signature: string): boolean =>
  meta.followsSignature === signature
  && meta.lastSyncedAt !== null
  && Number.isFinite(Date.parse(meta.lastSyncedAt))
  && Date.now() - Date.parse(meta.lastSyncedAt) < RECENT_SYNC_SKIP_MS;

/** Follows list signature: normalized, sorted, concatenated handles (case-insensitive deduplicated set identity). */
const followsSignatureOf = (handles: string[]): string =>
  [...new Set(handles.map((handle) => handle.toLowerCase()))].sort().join(',');

/**
 * Authentication identity fingerprint (non-sensitive): stable for the same cookie pair, distinct across different cookies.
 * Uses a djb2 hash to partition cached data; raw cookies are never written to signatures or persistent metadata.
 */
export const xTweetAuthFingerprint = (auth: XTweetAuth | null): string => {
  if (!auth) return 'anon';
  const input = `${auth.authToken}\u0000${auth.ct0}`;
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return `auth:${hash.toString(16)}`;
};

/**
 * Channel sync entry point (called by refreshChannel):
 * - With auth configured (authenticated GraphQL path): uses syncXTweetChannelWithAuth—true
 *   server-side pagination, fetching the next page for each unexhausted author on every "load more" click;
 * - Without auth (default unauthenticated path):
 *   - page 1 (manual refresh / initial visit): fetches the latest batch per author if more than 60s
 *     have passed since last sync (incremental, skipping known tweets by ID), batch-enriching details for newly reached repos;
 *   - page N (load more): triggers a refresh only if cache is insufficient for the page window and >60s
 *     have passed since last sync; otherwise slices directly from cache;
 *   Each page returns an accumulated prefix (first page * 20 cards, replaced as a whole by caller),
 *   because cards added during refresh can fall within earlier windows that append-slicing would miss.
 */
export async function syncXTweetChannel(
  api: GitHubApiService,
  page: number,
  follows: XTweetFollow[],
  onStatus: StatusCallback,
  transport: XTimelineTransport = defaultXTimelineTransport,
  auth: XTweetAuth | null = null,
  graphQL: XGraphQLTransport = defaultXGraphQLTransport,
): Promise<PaginatedDiscoveryRepositories> {
  const handles = [...new Set(
    follows.map((follow) => follow.handle).filter((handle) => isValidXTweetHandle(handle)),
  )];
  if (handles.length === 0) {
    return { repos: [], hasMore: false, nextPageIndex: page + 1, totalCount: 0 };
  }
  if (auth) {
    return syncXTweetChannelWithAuth(api, page, handles, auth, onStatus, graphQL);
  }

  const windowEnd = page * X_TWEET_CARD_PAGE_SIZE;
  const signature = followsSignatureOf(handles);
  const meta0 = await xTweetStorage.getSyncMeta();
  const recent = isRecentlySynced(meta0, signature);
  // Pre-read snapshot: reuse directly for settlement when skipping network to avoid repeated full scans in the same call
  let snapshot: { tweets: Map<string, XStoredTweet>; repos: Map<string, XStoredRepo> } | null = null;
  let needsSync = page <= 1 && !recent;
  if (!needsSync) {
    const [tweets, repos] = await Promise.all([
      xTweetStorage.getAllTweets(),
      xTweetStorage.getAllRepos(),
    ]);
    snapshot = { tweets, repos };
    if (page > 1) {
      needsSync = buildXTweetDiscoveryRepos(tweets, repos, handles).length < windowEnd;
    }
  }

  if (needsSync) {
    await runExclusiveSync(async (signal) => {
      // Previous round may have written new data; reread latest state
      const meta = await xTweetStorage.getSyncMeta();
      if (isRecentlySynced(meta, signature)) return;
      meta.followsSignature = signature;
      const tweets = await xTweetStorage.getAllTweets();
      const repos = await xTweetStorage.getAllRepos();

      const touchedRepoKeys = new Set<string>();
      let succeeded = 0;
      let firstError: unknown = null;
      for (const handle of handles) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        onStatus?.({ phase: 'syncing', current: succeeded, total: handles.length });
        // Fetch/parse failure only skips this author (missing account or network jitter does not break the entire round)
        let parsed: XStoredTweet[];
        try {
          const html = await transport(handle);
          parsed = parseXTimelineHtml(html, handle);
        } catch (error) {
          if (isAbortError(error)) throw error;
          logger.warn('xTweet', `Timeline fetch failed for @${handle}`, error);
          firstError = firstError ?? error;
          await sleep(HANDLE_THROTTLE_MS);
          continue;
        }
        const { newTweets, pendingRepoKeys } = ingestFeedTweets(parsed, tweets, repos);
        for (const key of pendingRepoKeys) touchedRepoKeys.add(key);
        // Atomic per-author persistence (tweets + repos in the same transaction; watermark is not advanced yet).
        // Write failure must be thrown to abort the round: in-memory merged state (tweets/source tweet pointers) cannot safely
        // roll back, and continuing with dirty state would leak unpersisted merges into final rounds.
        await xTweetStorage.saveSyncBatch({
          tweets: newTweets,
          repos: [...touchedRepoKeys]
            .map((key) => repos.get(key))
            .filter((repo): repo is XStoredRepo => Boolean(repo)),
          meta,
        });
        succeeded++;
        await sleep(HANDLE_THROTTLE_MS);
      }
      if (succeeded === 0 && handles.length > 0) {
        throw firstError instanceof Error
          ? firstError
          : new Error('Failed to fetch X tweets: timelines for all accounts are unreachable');
      }

      const enrichTargets = reposNeedingDetail(repos, touchedRepoKeys, Date.now());
      const touchedRepos = () => [...touchedRepoKeys]
        .map((key) => repos.get(key))
        .filter((repo): repo is XStoredRepo => Boolean(repo));
      try {
        await enrichRepos(api, enrichTargets, onStatus, signal);
        // Success path: repo details and watermark committed in the same transaction—if rolled back on failure,
        // the next round retries instead of skipping with a new watermark and leaving missing details until TTL expires.
        meta.lastSyncedAt = new Date().toISOString();
        await xTweetStorage.saveSyncBatch({ tweets: [], repos: touchedRepos(), meta });
      } catch (error) {
        if (isAbortError(error)) {
          // Cancelled: retain fetched details without advancing watermark (next round continues enrichment)
          await xTweetStorage.saveSyncBatch({ tweets: [], repos: touchedRepos(), meta });
        }
        // Rate limit / token error: do not commit partial or degraded details, nor advance watermark
        throw error;
      }
    }, onStatus);
  }

  // Network rounds have atomic writes internally, so read latest for settlement; non-network rounds reuse pre-read snapshot
  const settled = needsSync
    ? {
        tweets: await xTweetStorage.getAllTweets(),
        repos: await xTweetStorage.getAllRepos(),
      }
    : snapshot!;
  const accumulated = buildXTweetDiscoveryRepos(settled.tweets, settled.repos, handles);
  return {
    repos: accumulated.slice(0, windowEnd),
    hasMore: accumulated.length > windowEnd,
    nextPageIndex: page + 1,
    totalCount: accumulated.length,
  };
}

/**
 * Authenticated GraphQL sync (true server-side pagination, isomorphic to Telegram channel):
 * - page 1: fetches latest page per author when last sync was >60s ago (incremental);
 * - page N: fetches next page for each unexhausted author using persisted cursor (one click advances one page,
 *   unblocked by watermarks), then rebuilds slices across the set;
 * - Cursors/userIds/queryIds persist atomically with tweets across sessions; page 1 refresh never rolls back
 *   advanced cursors; once all authors are exhausted, slices pure cache until exhausted.
 */
async function syncXTweetChannelWithAuth(
  api: GitHubApiService,
  page: number,
  handles: string[],
  auth: XTweetAuth,
  onStatus: StatusCallback,
  graphQL: XGraphQLTransport,
): Promise<PaginatedDiscoveryRepositories> {
  const windowEnd = page * X_TWEET_CARD_PAGE_SIZE;
  // Signature includes auth fingerprint: switching between cookies immediately invalidates the 60s watermark,
  // triggering a fresh fetch to avoid reusing IndexedDB snapshots from a previous account (fingerprint is a hash, no raw cookies).
  const currentFingerprint = xTweetAuthFingerprint(auth);
  const signature = `${followsSignatureOf(handles)}|${currentFingerprint}`;

  let snapshot: { tweets: Map<string, XStoredTweet>; repos: Map<string, XStoredRepo> } | null = null;
  let settledMeta: XTweetSyncMeta | null = null;

  await runExclusiveSync(async (signal) => {
    // Auth fingerprint check must happen before needsSync evaluation and cache snapshot reading;
    // upon detecting a change, clearAll() is called first; any error immediately aborts the round to ensure no upstream requests or commits.
    let meta = await xTweetStorage.getSyncMeta();
    const prevFingerprint = meta.authFingerprint || (meta.followsSignature.includes('|') ? meta.followsSignature.split('|')[1] : '');
    const authChanged = Boolean(prevFingerprint && prevFingerprint !== currentFingerprint);

    if (authChanged) {
      await xTweetStorage.clearAll();
      meta = await xTweetStorage.getSyncMeta();
    }

    const recent = isRecentlySynced(meta, signature);
    let needsSync = page <= 1 && !recent;
    if (!needsSync && page > 1) {
      needsSync = handlesWithMore(meta, handles).length > 0;
    }

    if (!needsSync) {
      const [tweets, repos] = await Promise.all([
        xTweetStorage.getAllTweets(),
        xTweetStorage.getAllRepos(),
      ]);
      snapshot = { tweets, repos };
      settledMeta = meta;
      return;
    }

    meta.followsSignature = signature;
    meta.authFingerprint = currentFingerprint;
    const tweets = await xTweetStorage.getAllTweets();
    const repos = await xTweetStorage.getAllRepos();

    const touchedRepoKeys = new Set<string>();
    let succeeded = 0;
    let firstError: unknown = null;
    // page N only advances unexhausted authors; page 1 always refetches latest page for all authors
    const targets = page <= 1 ? handles : handlesWithMore(meta, handles);
    for (const handle of targets) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      onStatus?.({ phase: 'syncing', current: succeeded, total: targets.length });
      try {
        const pendingKeys = await fetchAndIngestXUserPage(
          handle, page, meta, auth, tweets, repos, graphQL, signal,
        );
        for (const key of pendingKeys) touchedRepoKeys.add(key);
      } catch (error) {
        if (isAbortError(error) || isPersistenceError(error) || isStalledCursorError(error)) throw error;
        // Fetch/parse failure only skips this author (missing account or network jitter does not break the entire round)
        logger.warn('xTweet', `Authenticated timeline fetch failed for @${handle}`, error);
        firstError = firstError ?? error;
        await sleep(HANDLE_THROTTLE_MS);
        continue;
      }
      succeeded++;
      await sleep(HANDLE_THROTTLE_MS);
    }
    if (succeeded === 0 && targets.length > 0) {
      throw firstError instanceof Error
        ? firstError
        : new Error('Failed to fetch X tweets: timelines for all accounts are unreachable');
    }

    const enrichTargets = reposNeedingDetail(repos, touchedRepoKeys, Date.now());
    const touchedRepos = () => [...touchedRepoKeys]
      .map((key) => repos.get(key))
      .filter((repo): repo is XStoredRepo => Boolean(repo));
    try {
      await enrichRepos(api, enrichTargets, onStatus, signal);
      meta.lastSyncedAt = new Date().toISOString();
      await xTweetStorage.saveSyncBatch({ tweets: [], repos: touchedRepos(), meta });
    } catch (error) {
      if (isAbortError(error)) {
        // Cancelled: retain fetched details without advancing watermark (next round continues enrichment)
        await xTweetStorage.saveSyncBatch({ tweets: [], repos: touchedRepos(), meta });
      }
      throw error;
    }

    snapshot = {
      tweets: await xTweetStorage.getAllTweets(),
      repos: await xTweetStorage.getAllRepos(),
    };
    settledMeta = meta;
  }, onStatus);

  if (!snapshot || !settledMeta) {
    snapshot = {
      tweets: await xTweetStorage.getAllTweets(),
      repos: await xTweetStorage.getAllRepos(),
    };
    settledMeta = await xTweetStorage.getSyncMeta();
  }

  const accumulated = buildXTweetDiscoveryRepos(snapshot.tweets, snapshot.repos, handles);
  const allExhausted = handlesWithMore(settledMeta, handles).length === 0;
  return {
    repos: accumulated.slice(0, windowEnd),
    hasMore: allExhausted ? accumulated.length > windowEnd : true,
    nextPageIndex: page + 1,
    totalCount: accumulated.length,
  };
}

/** Settings modal "Test Connection": fetches and parses an author's profile, returning verifiable results.
 *  Uses GraphQL UserTweets (~20 items per page) when auth is configured; falls back to unauthenticated HTML otherwise. */
export async function probeXTweetSource(
  handle: string,
  transport: XTimelineTransport = defaultXTimelineTransport,
  auth: XTweetAuth | null = null,
  graphQL: XGraphQLTransport = defaultXGraphQLTransport,
): Promise<{ ok: boolean; tweetCount?: number; repoCount?: number; error?: string }> {
  if (!isValidXTweetHandle(handle)) {
    return { ok: false, error: 'Invalid username' };
  }
  try {
    if (auth) {
      const meta = await xTweetStorage.getSyncMeta();
      const userId = await resolveXUserId(handle, meta, auth, graphQL);
      const body = await fetchXUserTimelinePage(userId, null, meta, auth, graphQL);
      const parsed = parseXUserTweetsJson(body, handle);
      return {
        ok: true,
        tweetCount: parsed.tweets.length,
        repoCount: parsed.tweets.reduce((sum, tweet) => sum + tweet.repoFullNames.length, 0),
      };
    }
    const html = await transport(handle);
    const parsed = parseXTimelineHtml(html, handle);
    return {
      ok: true,
      tweetCount: parsed.length,
      repoCount: parsed.reduce((sum, tweet) => sum + tweet.repoFullNames.length, 0),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
