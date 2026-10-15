import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { GitHubApiService, GitHubRepoDetailRead } from './githubApi';
import {
  decodeTweetRef,
  parseXTimelineHtml,
  tweetSnowflakeToDate,
  tweetDateToIso,
  buildTweetContentHtml,
  buildUserTweetsUrl,
  buildUserByScreenNameUrl,
  parseXUserTweetsJson,
  extractXGraphQLQueryIds,
  defaultXGraphQLTransport,
  ingestFeedTweets,
  reposNeedingDetail,
  buildXTweetDiscoveryRepos,
  syncXTweetChannel,
  probeXTweetSource,
  X_TWEET_CARD_PAGE_SIZE,
  type XTimelineTransport,
  type XGraphQLTransport,
} from './xTweetService';
import { xTweetStorage, type XStoredRepo, type XStoredTweet, type XTweetSyncMeta } from './xTweetStorage';
import type { XTweetAuth, XTweetFollow } from '../types';

/**
 * Fixture is a Flight data snippet intercepted from real unauthenticated x.com/geekbb responses
 * (containing real tweets and expanded_url entities); parser tests directly against real upstream format.
 */
const REAL_TIMELINE_HTML = readFileSync(
  path.join(__dirname, '__fixtures__', 'x-timeline-geekbb.html'),
  'utf-8',
);
/** Authenticated path fixture: real UserTweets GraphQL response with login session (geekbb latest page). */
const REAL_USER_TWEETS_JSON = readFileSync(
  path.join(__dirname, '__fixtures__', 'x-usertweets-geekbb-auth.json'),
  'utf-8',
);

// In-memory storage stub (no IndexedDB in jsdom; deep copies meta on every read to emulate IDB semantics)
const storage = vi.hoisted(() => {
  const tweetsStore = new Map<string, unknown>();
  const reposStore = new Map<string, unknown>();
  const metaRef = {
    current: {
      lastSyncedAt: null as string | null,
      followsSignature: '',
      authFingerprint: '',
      pages: {} as Record<string, { cursor: string | null; exhausted: boolean }>,
      userIds: {} as Record<string, string>,
      queryIds: {} as Record<string, string>,
    },
  };
  const copyMeta = (): XTweetSyncMeta => ({
    ...metaRef.current,
    pages: Object.fromEntries(Object.entries(metaRef.current.pages).map(([k, v]) => [k, { ...v }])),
    userIds: { ...metaRef.current.userIds },
    queryIds: { ...metaRef.current.queryIds },
  });
  let failSyncBatchOnRepo: string | null = null;
  return {
    tweetsStore,
    reposStore,
    metaRef,
    setFailSyncBatchOnRepo(fullName: string | null) {
      failSyncBatchOnRepo = fullName;
    },
    failSyncBatchOnRepoNow: () => failSyncBatchOnRepo,
    reset() {
      tweetsStore.clear();
      reposStore.clear();
      metaRef.current = {
        lastSyncedAt: null,
        followsSignature: '',
        authFingerprint: '',
        pages: {},
        userIds: {},
        queryIds: {},
      };
      failSyncBatchOnRepo = null;
    },
    copyMeta,
  };
});

vi.mock('./xTweetStorage', () => ({
  xTweetStorage: {
    saveTweets: async (tweets: XStoredTweet[]) => {
      for (const tweet of tweets) storage.tweetsStore.set(tweet.tweetId, tweet);
    },
    getAllTweets: async () => new Map(storage.tweetsStore) as Map<string, XStoredTweet>,
    saveRepos: async (repos: XStoredRepo[]) => {
      for (const repo of repos) storage.reposStore.set(repo.fullName.toLowerCase(), repo);
    },
    getAllRepos: async () => new Map(storage.reposStore) as Map<string, XStoredRepo>,
    getSyncMeta: async () => storage.copyMeta(),
    saveSyncMeta: async (meta: XTweetSyncMeta) => {
      storage.metaRef.current = JSON.parse(JSON.stringify(meta));
    },
    saveSyncBatch: async (payload: { tweets: XStoredTweet[]; repos: XStoredRepo[]; meta: XTweetSyncMeta }) => {
      // Atomic semantics are guaranteed by a single transaction in real implementation; stub simulates rollback by throwing before applying
      if (storage.failSyncBatchOnRepoNow()
        && payload.repos.some((repo) => repo.fullName.toLowerCase() === storage.failSyncBatchOnRepoNow())) {
        throw new Error('sync batch tx failed');
      }
      for (const tweet of payload.tweets) storage.tweetsStore.set(tweet.tweetId, tweet);
      for (const repo of payload.repos) storage.reposStore.set(repo.fullName.toLowerCase(), repo);
      storage.metaRef.current = JSON.parse(JSON.stringify(payload.meta));
    },
    clearAll: async () => storage.reset(),
  },
}));

const makeDetail = (fullName: string): GitHubRepoDetailRead => ({
  id: fullName.length,
  name: fullName.split('/')[1],
  full_name: fullName,
  description: `desc of ${fullName}`,
  html_url: `https://github.com/${fullName}`,
  stargazers_count: 100,
  forks_count: 10,
  forks: 10,
  language: 'TypeScript',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  pushed_at: '2026-01-01T00:00:00Z',
  owner: { login: fullName.split('/')[0], avatar_url: `https://github.com/${fullName.split('/')[0]}.png` },
  topics: [],
} as unknown as GitHubRepoDetailRead);

const makeApi = (
  details: Map<string, GitHubRepoDetailRead | null>,
  graphqlError: Error | null = null,
): GitHubApiService => ({
  graphqlFetchRepositories: vi.fn(async (fullNames: string[]) => {
    if (graphqlError) throw graphqlError;
    const result = new Map<string, GitHubRepoDetailRead | null>();
    // Matches real GraphQL semantics: non-existent repos emit no keys (rather than explicit null),
    // so the REST fallback branch (restTargets) can be exercised
    for (const fullName of fullNames) {
      const key = fullName.toLowerCase();
      if (details.has(key)) result.set(key, details.get(key) ?? null);
    }
    return result;
  }),
  getRepositoryDetails: vi.fn(async (owner: string, name: string) => {
    const detail = details.get(`${owner}/${name}`.toLowerCase());
    if (!detail) throw new Error(`404: ${owner}/${name}`);
    return detail;
  }),
} as unknown as GitHubApiService);

/** Transport stub: returns preset HTML (or throws) by handle, recording each call */
const stubTransport = (pages: Record<string, string | Error>): { transport: XTimelineTransport; calls: string[] } => {
  const calls: string[] = [];
  const transport: XTimelineTransport = async (handle) => {
    calls.push(handle);
    const page = pages[handle];
    if (page instanceof Error) throw page;
    return page ?? '<html></html>';
  };
  return { transport, calls };
};

const follows: XTweetFollow[] = [
  { handle: 'geekbb', addedAt: '2026-09-12T00:00:00.000Z' },
  { handle: 'ghost', addedAt: '2026-09-12T00:00:00.000Z' },
];

beforeEach(() => {
  storage.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('decodeTweetRef', () => {
  it('decodes Flight client reference into tweet ID', () => {
    // base64("Tweet:2098629676495159496")
    expect(decodeTweetRef('VHdlZXQ6MjA5ODYyOTY3NjQ5NTE1OTQ5Ng==')).toBe('2098629676495159496');
    expect(decodeTweetRef('bm90LWEtdHdlZXQ=')).toBeNull();
    expect(decodeTweetRef('!!!not-base64!!!')).toBeNull();
  });
});

describe('tweetSnowflakeToDate', () => {
  it('derives creation time from snowflake ID (lossless precision beyond safe Number range)', () => {
    // Known sample: 2098678373753225483 = 2026-09-12T07:41:30.518Z (Twitter epoch 1288834974657)
    expect(tweetSnowflakeToDate('2098678373753225483')).toBe('2026-09-12T07:41:30.518Z');
    // Time delta aligns directionally with ID delta for adjacent snowflakes
    const later = tweetSnowflakeToDate('2098678373753225484');
    expect(Date.parse(later)).toBeGreaterThanOrEqual(Date.parse('2026-09-12T07:41:30.518Z'));
  });
});

describe('parseXTimelineHtml (real unauthenticated x.com profile fixture)', () => {
  const tweets = () => parseXTimelineHtml(REAL_TIMELINE_HTML, 'geekbb');

  it('parses 5 real top-level timeline tweets (exact IDs), excluding nested quoted tweets', () => {
    const parsed = tweets();
    // 5 top-level TimelineTimelineEntry items in fixture; 2097971881596916185 is a nested
    // quoted tweet (different author) and must not be attributed to geekbb
    expect(new Set(parsed.map((t) => t.tweetId))).toEqual(new Set([
      '2098678373753225483',
      '2098629676495159496',
      '2098604072572162341',
      '2098581405253189796',
      '2098310980103200951',
    ]));
    expect(parsed.some((t) => t.tweetId === '2097971881596916185')).toBe(false);
    expect(parsed.every((t) => t.handle === 'geekbb')).toBe(true);
    expect(parsed.every((t) => t.htmlUrl.startsWith('https://x.com/geekbb/status/'))).toBe(true);
  });

  it('sorts descending by snowflake timestamp (independent of parsing order)', () => {
    const parsed = tweets();
    const times = parsed.map((t) => Date.parse(t.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('extracts GitHub repository links from expanded_url entities (repos actually shared by geekbb)', () => {
    const parsed = tweets();
    const allRepos = parsed.flatMap((t) => t.repoFullNames);
    expect(allRepos).toContain('obsidianmd/knap');
    expect(allRepos).toContain('zhihui-hu/one-ip');
    expect(allRepos).toContain('sumimakito/mac-duo');
  });

  it('restores \\n escapes in content (Flight string literals)', () => {
    const parsed = tweets();
    const withNewline = parsed.find((t) => t.content.includes('\n\n'));
    expect(withNewline).toBeDefined();
  });

  it('returns empty array for non-tweet pages (empty HTML)', () => {
    expect(parseXTimelineHtml('<html><body>login wall</body></html>', 'geekbb')).toEqual([]);
  });
});

describe('ingestFeedTweets', () => {
  it('deduplicates by tweetId; points source tweet to the newest tweet when a repo has multiple tweets', () => {
    const tweets = new Map<string, XStoredTweet>();
    const repos = new Map<string, XStoredRepo>();
    const make = (id: string, daysAgo: number) => ({
      tweetId: id,
      handle: 'geekbb',
      displayName: 'geekbb',
      content: 'repo https://github.com/a/one',
      htmlUrl: `https://x.com/geekbb/status/${id}`,
      createdAt: new Date(Date.now() - daysAgo * 86400_000).toISOString(),
      repoFullNames: ['a/one'],
    });
    const first = ingestFeedTweets([make('1', 5)], tweets, repos);
    expect(first.newTweets).toHaveLength(1);
    expect(ingestFeedTweets([make('1', 5)], tweets, repos).newTweets).toHaveLength(0);
    ingestFeedTweets([make('2', 1)], tweets, repos);
    expect(repos.get('a/one')!.sourceTweetId).toBe('2');
  });
});

describe('reposNeedingDetail', () => {
  it('enriches newly reached repos, skips fresh snapshots, retries stale snapshots and expired unavailable repos', () => {
    const now = Date.now();
    const repos = new Map<string, XStoredRepo>();
    repos.set('a/new', { fullName: 'a/new', detail: null, lastFetchedAt: '', sourceTweetId: '1', tweetCreatedAt: '' });
    repos.set('a/fresh', { fullName: 'a/fresh', detail: makeDetail('a/fresh'), lastFetchedAt: new Date(now - 10 * 86400_000).toISOString(), sourceTweetId: '1', tweetCreatedAt: '' });
    repos.set('a/stale', { fullName: 'a/stale', detail: makeDetail('a/stale'), lastFetchedAt: new Date(now - 40 * 86400_000).toISOString(), sourceTweetId: '1', tweetCreatedAt: '' });
    repos.set('a/dead', { fullName: 'a/dead', detail: null, lastFetchedAt: new Date(now - 8 * 86400_000).toISOString(), sourceTweetId: '1', tweetCreatedAt: '' });
    const targets = reposNeedingDetail(repos, new Set(['a/new', 'a/fresh', 'a/stale', 'a/dead']), now);
    expect(targets.map((repo) => repo.fullName)).toEqual(['a/new', 'a/stale', 'a/dead']);
  });
});

describe('buildXTweetDiscoveryRepos', () => {
  it('only displays currently followed + enriched repos, sorted descending by tweet date with rank assigned', () => {
    const tweets = new Map<string, XStoredTweet>();
    const repos = new Map<string, XStoredRepo>();
    const make = (id: string, handle: string, daysAgo: number, repo: string) => ({
      tweetId: id,
      handle,
      displayName: handle,
      content: 'x',
      htmlUrl: `https://x.com/${handle}/status/${id}`,
      createdAt: new Date(Date.now() - daysAgo * 86400_000).toISOString(),
      repoFullNames: [repo],
    });
    ingestFeedTweets([make('1', 'alice', 1, 'a/one'), make('2', 'alice', 3, 'a/two')], tweets, repos);
    ingestFeedTweets([make('3', 'bob', 2, 'b/three')], tweets, repos);
    ingestFeedTweets([make('4', 'carol', 0, 'c/four')], tweets, repos);
    repos.set('a/two', { ...repos.get('a/two')!, detail: null });
    repos.set('b/three', { ...repos.get('b/three')!, detail: makeDetail('b/three') });
    repos.set('a/one', { ...repos.get('a/one')!, detail: makeDetail('a/one') });
    repos.set('c/four', { ...repos.get('c/four')!, detail: makeDetail('c/four') });

    const list = buildXTweetDiscoveryRepos(tweets, repos, ['alice', 'bob']);
    expect(list.map((repo) => repo.full_name)).toEqual(['a/one', 'b/three']);
    expect(list[0].rank).toBe(1);
    expect(list[0].channel).toBe('x-tweet');
    expect(list[0].xTweet?.handle).toBe('alice');
  });
});

describe('syncXTweetChannel', () => {
  it('fetches authors on home page: parses tweets, enriches repo details, returns prefix slice', async () => {
    const { transport, calls } = stubTransport({ geekbb: REAL_TIMELINE_HTML, ghost: '<html></html>' });
    const api = makeApi(new Map([
      ['obsidianmd/knap', makeDetail('obsidianmd/knap')],
      ['zhihui-hu/one-ip', makeDetail('zhihui-hu/one-ip')],
      ['sumimakito/mac-duo', makeDetail('sumimakito/mac-duo')],
    ]));

    const result = await syncXTweetChannel(api, 1, follows.slice(0, 1), undefined, transport);
    expect(calls).toEqual(['geekbb']);
    // Three tweets from geekbb in fixture each contain a GitHub repo link -> 3 cards
    expect(result.repos.map((repo) => repo.full_name).sort())
      .toEqual(['obsidianmd/knap', 'sumimakito/mac-duo', 'zhihui-hu/one-ip']);
    expect(result.hasMore).toBe(false);
    expect(storage.metaRef.current.lastSyncedAt).not.toBeNull();
  });

  it('serves from cache when refreshed within 60s without calling transport', async () => {
    const { transport, calls } = stubTransport({ geekbb: REAL_TIMELINE_HTML });
    const api = makeApi(new Map());
    await syncXTweetChannel(api, 1, follows.slice(0, 1), undefined, transport);
    const callsAfterFirst = calls.length;
    await syncXTweetChannel(api, 1, follows.slice(0, 1), undefined, transport);
    expect(calls.length).toBe(callsAfterFirst);
  });

  it('single author failure does not fail the entire round; only throws transport error when all fail', async () => {
    const { transport } = stubTransport({
      geekbb: REAL_TIMELINE_HTML,
      ghost: new Error('x.com responded 404'),
    });
    const api = makeApi(new Map([['obsidianmd/knap', makeDetail('obsidianmd/knap')]]));
    const result = await syncXTweetChannel(api, 1, follows, undefined, transport);
    expect(result.repos.length).toBeGreaterThan(0);

    // Clear 60s watermark written by first sync round so all-fail round actually hits transport
    storage.metaRef.current.lastSyncedAt = null;
    const allFail = stubTransport({ geekbb: new Error('x.com responded 503'), ghost: new Error('offline') });
    await expect(
      syncXTweetChannel(makeApi(new Map()), 1, follows, undefined, allFail.transport),
    ).rejects.toThrow('x.com responded 503');
  });

  it('filters out invalid follow handles without sending requests', async () => {
    const { transport, calls } = stubTransport({});
    const api = makeApi(new Map());
    const result = await syncXTweetChannel(
      api, 1,
      [{ handle: 'not a handle!', addedAt: '2026-09-12T00:00:00.000Z' }],
      undefined, transport,
    );
    expect(calls).toEqual([]);
    expect(result.repos).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it('excludes repositories from list after unfollowing', async () => {
    const { transport } = stubTransport({ geekbb: REAL_TIMELINE_HTML });
    const api = makeApi(new Map([['obsidianmd/knap', makeDetail('obsidianmd/knap')]]));
    await syncXTweetChannel(api, 1, follows.slice(0, 1), undefined, transport);
    const afterUnfollow = await syncXTweetChannel(api, 1, [], undefined, transport);
    expect(afterUnfollow.repos).toHaveLength(0);
    expect(afterUnfollow.hasMore).toBe(false);
  });

  it('returns cumulative prefix on pagination; avoids network when cache is insufficient but recently synced', async () => {
    // Append 25 tweets with repo links after real fixture to populate cache beyond one page window
    const extra = Array.from({ length: 25 }, (_, i) => {
      // base64("Tweet:<id>") already has VHdlZXQ6 prefix, concatenated directly after client:;
      // parser only recognizes top-level TimelineTimelineEntry, synthetic blocks must include it
      const id = (9000000000000000000n + BigInt(i)).toString();
      const ref = Buffer.from(`Tweet:${id}`).toString('base64');
      return `client:urt:server:TimelineTimelineEntry:tweet-${id}:content client:${ref}:details full_text:"repo https://github.com/alice/repo${i}" expanded_url:"https://github.com/alice/repo${i}"`;
    }).join(' ');
    const { transport } = stubTransport({ geekbb: REAL_TIMELINE_HTML + ' ' + extra });
    const details = new Map<string, GitHubRepoDetailRead | null>([
      ['obsidianmd/knap', makeDetail('obsidianmd/knap')],
      ...Array.from({ length: 25 }, (_, i) => [`alice/repo${i}`, makeDetail(`alice/repo${i}`)] as const),
    ]);
    const api = makeApi(new Map(details));

    await syncXTweetChannel(api, 1, follows.slice(0, 1), undefined, transport);
    // Within 60s watermark: pagination slices purely from cache, prefix = min(cache, 40)
    const page2 = await syncXTweetChannel(api, 2, follows.slice(0, 1), undefined, transport);
    expect(page2.repos.length).toBeGreaterThan(X_TWEET_CARD_PAGE_SIZE);
    expect(page2.hasMore).toBe(false);
  });
});

describe('persistence failure propagation', () => {
  it('aborts entire round when second author write fails after first succeeds: does not persist orphaned repos or advance watermark', async () => {
    const ghostHtml = [
      'client:urt:server:TimelineTimelineEntry:tweet-8888888888888888888:content',
      'client:VHdlZXQ6' + Buffer.from('Tweet:8888888888888888888').toString('base64').slice(8) + ':details',
      'full_text:"repo https://github.com/ghost/repo"',
      'expanded_url:"https://github.com/ghost/repo"',
    ].join(' ');
    const { transport } = stubTransport({ geekbb: REAL_TIMELINE_HTML, ghost: ghostHtml });
    const api = makeApi(new Map([['obsidianmd/knap', makeDetail('obsidianmd/knap')]]));
    // Second batch (persistence containing ghost/repo) fails
    storage.setFailSyncBatchOnRepo('ghost/repo');

    await expect(
      syncXTweetChannel(api, 1, follows, undefined, transport),
    ).rejects.toThrow('sync batch tx failed');

    // First batch (geekbb) atomically persisted with complete source tweets; ghost dirty merges not mixed in
    expect(storage.reposStore.has('ghost/repo')).toBe(false);
    for (const [key, repo] of storage.reposStore) {
      expect(storage.tweetsStore.has((repo as XStoredRepo).sourceTweetId)).toBe(true);
      expect(key.length).toBeGreaterThan(0);
    }
    expect(storage.metaRef.current.lastSyncedAt).toBeNull();
  });
});

describe('REST fallback', () => {
  it('falls back to per-repo REST enrichment when GraphQL batch fails', async () => {
    const { transport } = stubTransport({ geekbb: REAL_TIMELINE_HTML });
    const api = makeApi(
      new Map([['obsidianmd/knap', makeDetail('obsidianmd/knap')]]),
      new Error('GraphQL batch failed: bad gateway'),
    );
    const result = await syncXTweetChannel(api, 1, follows.slice(0, 1), undefined, transport);
    // knap succeeds via REST; one-ip/mac-duo not in details map -> REST 404 -> marked unavailable with no card
    expect(result.repos.map((repo) => repo.full_name)).toEqual(['obsidianmd/knap']);
    expect(api.getRepositoryDetails).toHaveBeenCalledWith('obsidianmd', 'knap', expect.anything());
    expect(api.getRepositoryDetails).toHaveBeenCalledWith('zhihui-hu', 'one-ip', expect.anything());
  });
});

describe('probeXTweetSource', () => {
  it('parses real content and returns tweet count and repo count', async () => {
    const { transport } = stubTransport({ geekbb: REAL_TIMELINE_HTML });
    const result = await probeXTweetSource('geekbb', transport);
    expect(result.ok).toBe(true);
    expect(result.tweetCount!).toBe(5);
    expect(result.repoCount!).toBe(3);
  });

  it('returns displayable errors on invalid usernames and fetch failures', async () => {
    expect((await probeXTweetSource('bad handle!', stubTransport({}).transport)).ok).toBe(false);
    const fail = stubTransport({ geekbb: new Error('timeout') });
    const result = await probeXTweetSource('geekbb', fail.transport);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('timeout');
  });
});

/* ============ Authenticated GraphQL Path ============ */

const AUTH: XTweetAuth = { authToken: '4e61test', ct0: 'a3ddtest' };
const authFollows: XTweetFollow[] = [{ handle: 'geekbb', addedAt: '2026-09-13T00:00:00.000Z' }];

const makeUserByScreenNameBody = (restId: string): string => JSON.stringify({
  data: { user: { result: { __typename: 'User', rest_id: restId } } },
});

const makeUserTweetsBody = (
  entries: Array<Record<string, unknown>>,
  cursor: string | null,
): string => JSON.stringify({
  data: {
    user: {
      result: {
        __typename: 'User',
        timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: cursor ? [...entries, { entryId: 'cursor-bottom-1', content: { entryType: 'TimelineTimelineCursor', value: cursor } }] : entries }] } },
      },
    },
  },
});

const tweetEntry = (
  id: number,
  fullText: string,
  createdAt: string,
  urls: Array<{ url: string; expanded_url: string; indices: [number, number] }> = [],
): Record<string, unknown> => ({
  entryId: `tweet-${id}`,
  content: {
    entryType: 'TimelineTimelineItem',
    itemContent: {
      tweet_results: {
        result: { __typename: 'Tweet', rest_id: String(id), legacy: { full_text: fullText, created_at: createdAt, entities: { urls } } },
      },
    },
  },
});

/** Authenticated transport stub: returns preset responses (or throws) by URL regex, recording each call */
const stubGraphQL = (
  handlers: Array<{ match: RegExp; body: string | Error }>,
): { graphQL: XGraphQLTransport; calls: string[] } => {
  const calls: string[] = [];
  const graphQL: XGraphQLTransport = async (url) => {
    calls.push(url);
    const handler = handlers.find((h) => h.match.test(url));
    if (!handler) throw new Error(`unexpected url: ${url.slice(0, 120)}`);
    if (handler.body instanceof Error) throw handler.body;
    return handler.body;
  };
  return { graphQL, calls };
};

describe('tweetDateToIso', () => {
  it('parses Twitter date format and falls back to epoch', () => {
    expect(tweetDateToIso('Sun Sep 13 06:17:25 +0000 2026')).toBe('2026-09-13T06:17:25.000Z');
    expect(tweetDateToIso('not-a-date')).toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('buildTweetContentHtml', () => {
  it('replaces t.co short links with expanded_url anchors based on entity indices', () => {
    const html = buildTweetContentHtml('look https://t.co/xyz end', [
      { url: 'https://t.co/xyz', expanded_url: 'https://github.com/foo/bar', indices: [5, 21] },
    ]);
    expect(html).toBe('look <a href="https://github.com/foo/bar">https://t.co/xyz</a> end');
  });

  it('escapes body HTML, converts newlines to <br/>, and skips invalid indices', () => {
    const html = buildTweetContentHtml('a <b>\nc', [
      { url: 'https://t.co/x', expanded_url: 'https://x.com/x', indices: [10, 12] },
    ]);
    expect(html).toBe('a &lt;b&gt;<br/>c');
  });
});

describe('buildUserTweetsUrl / buildUserByScreenNameUrl', () => {
  it('includes userId in variables; only includes cursor parameter when cursor is passed', () => {
    const p1 = buildUserTweetsUrl('123', null, 'QID');
    expect(p1).toContain('/i/api/graphql/QID/UserTweets');
    expect(decodeURIComponent(p1)).toContain('"userId":"123"');
    expect(decodeURIComponent(p1)).not.toContain('"cursor"');
    const p2 = buildUserTweetsUrl('123', 'CUR', 'QID');
    expect(decodeURIComponent(p2)).toContain('"cursor":"CUR"');
    expect(decodeURIComponent(buildUserByScreenNameUrl('geekbb', 'QID2'))).toContain('"screen_name":"geekbb"');
  });
});

describe('parseXUserTweetsJson (real UserTweets fixture)', () => {
  it('parses 19 real tweets; falls back displayName to handle when core.name is missing', () => {
    const parsed = parseXUserTweetsJson(REAL_USER_TWEETS_JSON, 'geekbb');
    expect(parsed.tweets).toHaveLength(19);
    expect(parsed.exhausted).toBe(false);
    expect(parsed.nextCursor).toBeTruthy();
    expect(new Set(parsed.tweets.map((t) => t.displayName))).toEqual(new Set(['geekbb']));
    const ids = parsed.tweets.map((t) => t.tweetId);
    expect(ids).toContain('2098629676495159496');
    const knap = parsed.tweets.find((t) => t.tweetId === '2098629676495159496');
    expect(knap?.createdAt).toBe('2026-09-12T04:28:00.000Z');
    expect(knap?.htmlUrl).toBe('https://x.com/geekbb/status/2098629676495159496');
    expect(knap?.repoFullNames).toContain('obsidianmd/knap');
    expect(knap?.content).toContain('<a href="https://github.com/obsidianmd/knap"');
  });

  it('throws readable error on expired authentication (code 32); throws when account is unavailable', () => {
    const authInvalid = JSON.stringify({ errors: [{ code: 32, message: 'Could not authenticate you' }] });
    expect(() => parseXUserTweetsJson(authInvalid, 'geekbb')).toThrow('authentication expired');
    const unavailable = JSON.stringify({ data: { user: { result: { __typename: 'UserUnavailable' } } } });
    expect(() => parseXUserTweetsJson(unavailable, 'geekbb')).toThrow('Failed to fetch timeline');
  });

  it('skips Tombstone; supports TweetWithVisibilityResults wrapper (result.tweet); marks exhausted when cursor is missing', () => {
    const body = JSON.stringify({
      data: {
        user: {
          result: {
            __typename: 'User',
            timeline: {
              timeline: {
                instructions: [{
                  type: 'TimelineAddEntries',
                  entries: [
                    { entryId: 'tweet-1', content: { entryType: 'TimelineTimelineItem', itemContent: { tweet_results: { result: { __typename: 'TweetTombstone' } } } } },
                    { entryId: 'tweet-2', content: { entryType: 'TimelineTimelineItem', itemContent: { tweet_results: { result: { __typename: 'TweetWithVisibilityResults', tweet: { rest_id: '2', legacy: { full_text: 'wrapped https://github.com/a/b', created_at: 'Sun Sep 13 00:00:00 +0000 2026', entities: { urls: [{ url: 'https://t.co/x', expanded_url: 'https://github.com/a/b', indices: [8, 22] }] } } } } } } } },
                  ],
                }],
              },
            },
          },
        },
      },
    });
    const parsed = parseXUserTweetsJson(body, 'geekbb');
    expect(parsed.tweets).toHaveLength(1);
    expect(parsed.tweets[0].tweetId).toBe('2');
    expect(parsed.tweets[0].repoFullNames).toEqual(['a/b']);
    expect(parsed.exhausted).toBe(true);
  });
});

describe('extractXGraphQLQueryIds', () => {
  it('extracts UserTweets/UserByScreenName queryIds from main bundle referenced by authenticated home page', async () => {
    const { graphQL } = stubGraphQL([
      { match: /^https:\/\/x\.com\/home$/, body: '<html><script src="https://abs.twimg.com/responsive-web/client-web/main.abc123def.js"></script></html>' },
      { match: /main\.abc123def\.js$/, body: 'queryId:"QIDTWEETS",operationName:"UserTweets" ... queryId:"QIDUSER",operationName:"UserByScreenName"' },
    ]);
    const ids = await extractXGraphQLQueryIds(AUTH, graphQL);
    expect(ids).toEqual({ UserTweets: 'QIDTWEETS', UserByScreenName: 'QIDUSER' });
  });

  it('throws error when main script or operation cannot be located', async () => {
    const { graphQL } = stubGraphQL([{ match: /^https:\/\/x\.com\/home$/, body: '<html></html>' }]);
    await expect(extractXGraphQLQueryIds(AUTH, graphQL)).rejects.toThrow('Could not locate');
  });
});

describe('defaultXGraphQLTransport (auto-downgrade to guest on edge 403)', () => {
  const setElectronAPI = (impl: unknown) => {
    (window as unknown as { electronAPI?: unknown }).electronAPI = impl;
  };

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  const USER_TWEETS_URL = 'https://x.com/i/api/graphql/QID/UserTweets?variables=%7B%7D';

  it('automatically downgrades to guest and retries same URL when auth cookie request hits edge 403', async () => {
    const calls: Array<XTweetAuth | null> = [];
    setElectronAPI({
      xFetchGraphQL: vi.fn(async (_url: string, auth: XTweetAuth | null) => {
        calls.push(auth);
        if (auth) return { success: false, error: 'x.com responded 403' };
        return { success: true, body: '{"guest":true}' };
      }),
    });
    await expect(defaultXGraphQLTransport(USER_TWEETS_URL, AUTH)).resolves.toBe('{"guest":true}');
    expect(calls).toEqual([AUTH, null]);
  });

  it('rethrows guest error when guest request also fails', async () => {
    const calls: Array<XTweetAuth | null> = [];
    setElectronAPI({
      xFetchGraphQL: vi.fn(async (_url: string, auth: XTweetAuth | null) => {
        calls.push(auth);
        // Two requests return distinct errors to ensure the rethrown error is indeed from the guest request
        return auth
          ? { success: false, error: 'x.com responded 403' }
          : { success: false, error: 'x.com guest token activate failed (429)' };
      }),
    });
    await expect(defaultXGraphQLTransport(USER_TWEETS_URL, AUTH))
      .rejects.toThrow('x.com guest token activate failed (429)');
    expect(calls).toEqual([AUTH, null]);
  });

  it('does not downgrade to guest on 401 (auth expired), rethrowing original error directly', async () => {
    const xFetchGraphQL = vi.fn(async () => ({ success: false, error: 'x.com responded 401' }));
    setElectronAPI({ xFetchGraphQL });
    await expect(defaultXGraphQLTransport(USER_TWEETS_URL, AUTH)).rejects.toThrow('x.com responded 401');
    expect(xFetchGraphQL).toHaveBeenCalledTimes(1);
  });
});

describe('syncXTweetChannel (authenticated path)', () => {
  const getFixtureCursor = (): string => {
    const d = JSON.parse(REAL_USER_TWEETS_JSON);
    const instructions = d.data.user.result.timeline.timeline.instructions;
    const entries = instructions.find((i: { type?: string }) => i.type === 'TimelineAddEntries').entries;
    return entries.find((e: { entryId?: string }) => e.entryId?.startsWith('cursor-bottom')).content.value;
  };

  it('fetches authors on home page: resolves userId, initializes cursor, enriches repo details, returns prefix slice', async () => {
    const fixtureCursor = getFixtureCursor();
    const { graphQL, calls } = stubGraphQL([
      { match: /UserByScreenName/, body: makeUserByScreenNameBody('168139512') },
      { match: /UserTweets/, body: REAL_USER_TWEETS_JSON },
    ]);
    const details = new Map<string, GitHubRepoDetailRead | null>([['obsidianmd/knap', makeDetail('obsidianmd/knap')]]);
    const result = await syncXTweetChannel(makeApi(details), 1, authFollows, undefined, undefined, AUTH, graphQL);

    expect(calls.some((url) => url.includes('/UserByScreenName'))).toBe(true);
    expect(calls.some((url) => url.includes('/UserTweets'))).toBe(true);
    expect(result.repos.length).toBeGreaterThan(0);
    expect(result.repos[0].xTweet).toBeDefined();
    expect(result.hasMore).toBe(true);
    const meta = await xTweetStorage.getSyncMeta();
    expect(meta.userIds['geekbb']).toBe('168139512');
    expect(meta.pages['geekbb']).toEqual({ cursor: fixtureCursor, exhausted: false });
    expect(meta.lastSyncedAt).not.toBeNull();
  });

  it('fetches next page on load more using persisted cursor (one page per click), bypassing 60s watermark', async () => {
    const fixtureCursor = getFixtureCursor();
    const p2Cursor = 'CURSOR_PAGE_3';
    const p2Body = makeUserTweetsBody([
      tweetEntry(1, 'older https://github.com/eee/fff', 'Sun Sep 06 00:00:00 +0000 2026', [
        { url: 'https://t.co/fff', expanded_url: 'https://github.com/eee/fff', indices: [6, 20] },
      ]),
    ], p2Cursor);
    const { graphQL, calls } = stubGraphQL([
      { match: /UserByScreenName/, body: makeUserByScreenNameBody('168139512') },
      { match: /UserTweets/, body: p2Body },
    ]);
    const details = new Map<string, GitHubRepoDetailRead | null>([
      ['obsidianmd/knap', makeDetail('obsidianmd/knap')],
      ['eee/fff', makeDetail('eee/fff')],
    ]);
    const api = makeApi(details);
    // Preset page 1 state (cursor from fixture latest page), watermark just advanced
    await syncXTweetChannel(makeApi(details), 1, authFollows, undefined, undefined, AUTH, stubGraphQL([
      { match: /UserByScreenName/, body: makeUserByScreenNameBody('168139512') },
      { match: /UserTweets/, body: REAL_USER_TWEETS_JSON },
    ]).graphQL);
    // Must paginate even when recently synced (within 60s watermark)
    const page2 = await syncXTweetChannel(api, 2, authFollows, undefined, undefined, AUTH, graphQL);

    const tweetsCall = calls.find((url) => url.includes('/UserTweets'));
    expect(tweetsCall).toBeDefined();
    expect(decodeURIComponent(tweetsCall!)).toContain(`"cursor":"${fixtureCursor}"`);
    expect(page2.hasMore).toBe(true);
    const meta = await xTweetStorage.getSyncMeta();
    expect(meta.pages['geekbb']).toEqual({ cursor: p2Cursor, exhausted: false });
    expect(page2.totalCount).toBeGreaterThanOrEqual(2);
  });

  it('page 1 refresh refetches latest page without rolling back advanced cursor', async () => {
    const p2Cursor = 'CURSOR_PAGE_3';
    const { graphQL } = stubGraphQL([
      { match: /UserByScreenName/, body: makeUserByScreenNameBody('168139512') },
      { match: /UserTweets/, body: makeUserTweetsBody([tweetEntry(1, 'older', 'Sun Sep 06 00:00:00 +0000 2026')], p2Cursor) },
    ]);
    const api = makeApi(new Map([['obsidianmd/knap', makeDetail('obsidianmd/knap')]]));
    await syncXTweetChannel(api, 1, authFollows, undefined, undefined, AUTH, stubGraphQL([
      { match: /UserByScreenName/, body: makeUserByScreenNameBody('168139512') },
      { match: /UserTweets/, body: REAL_USER_TWEETS_JSON },
    ]).graphQL);
    await syncXTweetChannel(api, 2, authFollows, undefined, undefined, AUTH, graphQL);
    expect((await xTweetStorage.getSyncMeta()).pages['geekbb']).toEqual({ cursor: p2Cursor, exhausted: false });

    // Invalidate watermark to force page 1 to hit network (using new stub to assert latest page call)
    const meta = await xTweetStorage.getSyncMeta();
    meta.lastSyncedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await xTweetStorage.saveSyncMeta(meta);
    const { graphQL: refreshGraphQL, calls } = stubGraphQL([
      { match: /UserByScreenName/, body: makeUserByScreenNameBody('168139512') },
      { match: /UserTweets/, body: REAL_USER_TWEETS_JSON },
    ]);
    await syncXTweetChannel(api, 1, authFollows, undefined, undefined, AUTH, refreshGraphQL);
    const tweetsCall = calls.find((url) => url.includes('/UserTweets'))!;
    expect(decodeURIComponent(tweetsCall)).not.toContain('"cursor"');
    expect((await xTweetStorage.getSyncMeta()).pages['geekbb']).toEqual({ cursor: p2Cursor, exhausted: false });
  });

  it('after timeline is exhausted: slices purely from cache without network; hasMore=false once cache runs out', async () => {
    const { graphQL, calls } = stubGraphQL([
      { match: /UserByScreenName/, body: makeUserByScreenNameBody('168139512') },
      { match: /UserTweets/, body: makeUserTweetsBody([tweetEntry(1, 'end https://github.com/gg/hh', 'Sun Sep 06 00:00:00 +0000 2026', [{ url: 'https://t.co/h', expanded_url: 'https://github.com/gg/hh', indices: [4, 18] }])], null) },
    ]);
    const api = makeApi(new Map([['gg/hh', makeDetail('gg/hh')]]));
    await syncXTweetChannel(api, 1, authFollows, undefined, undefined, AUTH, graphQL);
    const page2 = await syncXTweetChannel(api, 2, authFollows, undefined, undefined, AUTH, graphQL);
    expect((await xTweetStorage.getSyncMeta()).pages['geekbb']).toEqual({ cursor: null, exhausted: true });

    const callsBefore = calls.length;
    const page3 = await syncXTweetChannel(api, 3, authFollows, undefined, undefined, AUTH, graphQL);
    expect(calls.length).toBe(callsBefore);
    expect(page3.totalCount).toBe(page2.totalCount);
    expect(page3.hasMore).toBe(false);
  });

  it('propagates readable error upward on expired authentication (HTTP 401 / GraphQL code 32)', async () => {
    const { graphQL } = stubGraphQL([
      { match: /UserByScreenName/, body: makeUserByScreenNameBody('168139512') },
      { match: /UserTweets/, body: JSON.stringify({ errors: [{ code: 32, message: 'Could not authenticate you' }] }) },
    ]);
    await expect(syncXTweetChannel(makeApi(new Map()), 1, authFollows, undefined, undefined, AUTH, graphQL))
      .rejects.toThrow('authentication expired');

    const { graphQL: httpGraphQL } = stubGraphQL([
      { match: /UserByScreenName/, body: makeUserByScreenNameBody('168139512') },
      { match: /UserTweets/, body: new Error('x.com responded 401') },
    ]);
    await expect(syncXTweetChannel(makeApi(new Map()), 1, authFollows, undefined, undefined, AUTH, httpGraphQL))
      .rejects.toThrow('authentication expired');
  });

  it('automatically re-extracts from bundle and retries when cached queryId expires (404)', async () => {
    const { graphQL: fullGraphQL, calls: fullCalls } = stubGraphQL([
      { match: /UserByScreenName/, body: makeUserByScreenNameBody('168139512') },
      { match: /^https:\/\/x\.com\/home$/, body: '<html><script src="https://abs.twimg.com/responsive-web/client-web/main.deadbeef.js"></script></html>' },
      { match: /main\.deadbeef\.js$/, body: 'queryId:"FRESHQID",operationName:"UserTweets" queryId:"FRESHUSER",operationName:"UserByScreenName"' },
      { match: /STALEQID/, body: new Error('x.com responded 404') },
      { match: /FRESHQID/, body: REAL_USER_TWEETS_JSON },
    ]);
    // Preset stale cached queryId so the first UserTweets hits 404
    storage.metaRef.current.queryIds = { UserTweets: 'STALEQID', UserByScreenName: 'FRESHUSER' };
    const details = new Map<string, GitHubRepoDetailRead | null>([['obsidianmd/knap', makeDetail('obsidianmd/knap')]]);
    const result = await syncXTweetChannel(makeApi(details), 1, authFollows, undefined, undefined, AUTH, fullGraphQL);
    expect(result.repos.length).toBeGreaterThan(0);
    expect((await xTweetStorage.getSyncMeta()).queryIds.UserTweets).toBe('FRESHQID');
    // home + main bundle + two UserTweets calls (expired + retry)
    expect(fullCalls.some((url) => url.includes('x.com/home'))).toBe(true);
    expect(fullCalls.filter((url) => url.includes('/UserTweets')).length).toBe(2);
  });

  it('automatically re-extracts from bundle and retries when UserByScreenName queryId expires (404)', async () => {
    const { graphQL, calls } = stubGraphQL([
      { match: /STALEUSER/, body: new Error('x.com responded 404') },
      { match: /^https:\/\/x\.com\/home$/, body: '<html><script src="https://abs.twimg.com/responsive-web/client-web/main.deadbeef.js"></script></html>' },
      { match: /main\.deadbeef\.js$/, body: 'queryId:"FRESHQID",operationName:"UserTweets" queryId:"FRESHUSER",operationName:"UserByScreenName"' },
      { match: /FRESHUSER/, body: makeUserByScreenNameBody('168139512') },
      { match: /UserTweets/, body: REAL_USER_TWEETS_JSON },
    ]);
    storage.metaRef.current.queryIds = { UserTweets: 'FRESHQID', UserByScreenName: 'STALEUSER' };
    const details = new Map<string, GitHubRepoDetailRead | null>([['obsidianmd/knap', makeDetail('obsidianmd/knap')]]);
    const result = await syncXTweetChannel(makeApi(details), 1, authFollows, undefined, undefined, AUTH, graphQL);
    expect(result.repos.length).toBeGreaterThan(0);
    expect((await xTweetStorage.getSyncMeta()).queryIds.UserByScreenName).toBe('FRESHUSER');
    expect(calls.filter((url) => url.includes('/UserByScreenName')).length).toBe(2);
    expect(calls.some((url) => url.includes('x.com/home'))).toBe(true);
  });

  it('throws when cursor does not advance on load more, refusing to persist stalled cursor', async () => {
    const fixtureCursor = getFixtureCursor();
    const api = makeApi(new Map([['obsidianmd/knap', makeDetail('obsidianmd/knap')]]));
    await syncXTweetChannel(api, 1, authFollows, undefined, undefined, AUTH, stubGraphQL([
      { match: /UserByScreenName/, body: makeUserByScreenNameBody('168139512') },
      { match: /UserTweets/, body: REAL_USER_TWEETS_JSON },
    ]).graphQL);
    const { graphQL } = stubGraphQL([
      { match: /UserByScreenName/, body: makeUserByScreenNameBody('168139512') },
      { match: /UserTweets/, body: REAL_USER_TWEETS_JSON },
    ]);
    await expect(syncXTweetChannel(api, 2, authFollows, undefined, undefined, AUTH, graphQL))
      .rejects.toThrow('pagination cursor did not advance');
    expect((await xTweetStorage.getSyncMeta()).pages['geekbb']).toEqual({ cursor: fixtureCursor, exhausted: false });
  });

  it('isolates cache for the same handle across different cookie identities: second identity does not see cached records from first identity', async () => {
    const AUTH1: XTweetAuth = { authToken: 'token_user1', ct0: 'ct0_user1' };
    const AUTH2: XTweetAuth = { authToken: 'token_user2', ct0: 'ct0_user2' };

    const tweets1 = makeUserTweetsBody([
      tweetEntry(1001, 'check this https://t.co/user1', 'Sun Sep 13 01:00:00 +0000 2026', [
        { url: 'https://t.co/user1', expanded_url: 'https://github.com/user1/repo1', indices: [11, 34] },
      ]),
    ], null);

    const tweets2 = makeUserTweetsBody([
      tweetEntry(2001, 'check this https://t.co/user2', 'Sun Sep 13 02:00:00 +0000 2026', [
        { url: 'https://t.co/user2', expanded_url: 'https://github.com/user2/repo2', indices: [11, 34] },
      ]),
    ], null);

    const api1 = makeApi(new Map([['user1/repo1', makeDetail('user1/repo1')]]));
    const { graphQL: graphQL1 } = stubGraphQL([
      { match: /UserByScreenName/, body: makeUserByScreenNameBody('168139512') },
      { match: /UserTweets/, body: tweets1 },
    ]);

    const result1 = await syncXTweetChannel(api1, 1, authFollows, undefined, undefined, AUTH1, graphQL1);
    expect(result1.repos.some((r) => r.full_name === 'user1/repo1')).toBe(true);

    const api2 = makeApi(new Map([['user2/repo2', makeDetail('user2/repo2')]]));
    const { graphQL: graphQL2 } = stubGraphQL([
      { match: /UserByScreenName/, body: makeUserByScreenNameBody('168139512') },
      { match: /UserTweets/, body: tweets2 },
    ]);

    const result2 = await syncXTweetChannel(api2, 1, authFollows, undefined, undefined, AUTH2, graphQL2);
    expect(result2.repos.some((r) => r.full_name === 'user2/repo2')).toBe(true);
    expect(result2.repos.some((r) => r.full_name === 'user1/repo1')).toBe(false);

    const storedTweets = await xTweetStorage.getAllTweets();
    expect(storedTweets.has('1001')).toBe(false);
    expect(storedTweets.has('2001')).toBe(true);
  });

  it('fails sync immediately without sending upstream GraphQL requests when clearAll() fails', async () => {
    const AUTH1: XTweetAuth = { authToken: 'token_user1', ct0: 'ct0_user1' };
    const AUTH2: XTweetAuth = { authToken: 'token_user2', ct0: 'ct0_user2' };

    const api1 = makeApi(new Map([['obsidianmd/knap', makeDetail('obsidianmd/knap')]]));
    await syncXTweetChannel(api1, 1, authFollows, undefined, undefined, AUTH1, stubGraphQL([
      { match: /UserByScreenName/, body: makeUserByScreenNameBody('168139512') },
      { match: /UserTweets/, body: REAL_USER_TWEETS_JSON },
    ]).graphQL);

    const clearAllSpy = vi.spyOn(xTweetStorage, 'clearAll').mockRejectedValueOnce(new Error('clearAll failure'));
    const { graphQL: graphQL2, calls: calls2 } = stubGraphQL([
      { match: /UserByScreenName/, body: makeUserByScreenNameBody('168139512') },
      { match: /UserTweets/, body: REAL_USER_TWEETS_JSON },
    ]);

    await expect(syncXTweetChannel(api1, 1, authFollows, undefined, undefined, AUTH2, graphQL2))
      .rejects.toThrow('clearAll failure');
    expect(calls2.length).toBe(0);
    clearAllSpy.mockRestore();
  });
});

describe('probeXTweetSource (authenticated path)', () => {
  it('parses via GraphQL and returns tweet count and repo count', async () => {
    const { graphQL } = stubGraphQL([
      { match: /UserByScreenName/, body: makeUserByScreenNameBody('168139512') },
      { match: /UserTweets/, body: REAL_USER_TWEETS_JSON },
    ]);
    const result = await probeXTweetSource('geekbb', undefined, AUTH, graphQL);
    expect(result).toMatchObject({ ok: true, tweetCount: 19 });
    expect(result.repoCount).toBeGreaterThan(0);
  });
});
