import { Router } from 'express';
import { logger } from '../services/logger.js';

/**
 * X tweet channel: server-side scraping of logged-out x.com profile HTML,
 * as well as authenticated GraphQL and static asset proxying.
 * Browser renderers cannot directly connect to x.com due to CORS, desktop uses
 * Electron main process IPC, and server (fullstack) deployments use this route.
 * Only fetches fixed https://x.com/<handle>; handle is strictly validated,
 * and arbitrary URLs are not proxied.
 *
 * Authenticated path (POST /api/xtweet/graphql): users enter their own
 * auth_token/ct0 cookies in settings, which this route forwards per-request
 * (never stored in DB), sending GET requests with public Web Bearer and cookies;
 * only x.com and abs.twimg.com hostnames are allowed.
 */
const X_HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
// Authenticated proxying allows only URLs corresponding to controlled operations (callers cannot specify arbitrary x.com paths):
// Home page (queryId extraction entry point), abs.twimg.com main script (never includes X cookies),
// and GraphQL UserTweets / UserByScreenName (dynamic queryId, fixed operation name).
const X_HOME_URL = 'https://x.com/home';
const X_MAIN_JS_PATTERN = /^https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/main\.[a-zA-Z0-9_-]+\.js$/;
const X_GRAPHQL_API_PATTERN = /^https:\/\/x\.com\/i\/api\/graphql\/[A-Za-z0-9_-]+\/(UserTweets|UserByScreenName)(\?.*)?$/;
const isAllowedXProxyUrl = (url: string): boolean =>
  url === X_HOME_URL || X_MAIN_JS_PATTERN.test(url) || X_GRAPHQL_API_PATTERN.test(url);
const X_COOKIE_VALUE_PATTERN = /^[\w%+/=.~-]+$/;
const X_WEB_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const FETCH_TIMEOUT_MS = 20_000;
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const router: Router = Router();

router.get('/api/xtweet/profile/:handle', async (req, res) => {
  const { handle } = req.params;
  if (typeof handle !== 'string' || !X_HANDLE_PATTERN.test(handle)) {
    res.status(400).json({ error: 'invalid handle', code: 'INVALID_HANDLE' });
    return;
  }
  try {
    const response = await fetch(`https://x.com/${handle}`, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!response.ok) {
      logger.warn('xtweet', `x.com responded ${response.status} for @${handle}`);
      res.status(502).json({ error: `x.com responded ${response.status}`, code: 'UPSTREAM_ERROR' });
      return;
    }
    const html = await response.text();
    res.json({ html });
  } catch (error) {
    logger.warn('xtweet', `fetch failed for @${handle}`, error);
    res.status(502).json({
      error: error instanceof Error ? error.message : 'fetch failed',
      code: 'UPSTREAM_ERROR',
    });
  }
});

router.post('/api/xtweet/graphql', async (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url : '';
  const authToken = typeof req.body?.auth?.authToken === 'string' ? req.body.auth.authToken.trim().replace(/^["']|["']$/g, '').trim() : '';
  const ct0 = typeof req.body?.auth?.ct0 === 'string' ? req.body.auth.ct0.trim().replace(/^["']|["']$/g, '').trim() : '';
  if (!isAllowedXProxyUrl(url)) {
    res.status(400).json({ error: 'invalid url', code: 'INVALID_URL' });
    return;
  }
  if (!authToken || !ct0 || !X_COOKIE_VALUE_PATTERN.test(authToken) || !X_COOKIE_VALUE_PATTERN.test(ct0)) {
    res.status(400).json({ error: 'invalid auth cookies', code: 'INVALID_AUTH' });
    return;
  }
  try {
    // GraphQL API requests send specialized headers such as Bearer/CSRF; sending these headers
    // with HTML pages or static assets causes x.com to return 401 (verified), so only send UA + Cookie
    const isApiCall = url.startsWith('https://x.com/i/api/');
    const headers: Record<string, string> = isApiCall
      ? {
          'User-Agent': BROWSER_UA,
          'Accept': '*/*',
          'Authorization': `Bearer ${X_WEB_BEARER}`,
          'X-CSRF-Token': ct0,
          'X-Twitter-Auth-Type': 'OAuth2Session',
          'X-Twitter-Active-User': 'yes',
          'Cookie': `auth_token=${authToken}; ct0=${ct0}`,
        }
      : {
          'User-Agent': BROWSER_UA,
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
          ...(url.startsWith('https://x.com/') ? { 'Cookie': `auth_token=${authToken}; ct0=${ct0}` } : {}),
        };
    // redirect: 'error' — reject cross-origin redirects to prevent cookies from leaking outside allowed domains
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'error',
    });
    if (typeof response.url === 'string' && response.url && !isAllowedXProxyUrl(response.url)) {
      res.status(400).json({ error: 'redirect blocked', code: 'INVALID_URL' });
      return;
    }
    if (!response.ok) {
      logger.warn('xtweet', `x.com graphql responded ${response.status} for ${new URL(url).hostname}`);
      res.status(502).json({
        error: `x.com responded ${response.status}`,
        code: 'UPSTREAM_ERROR',
        upstreamStatus: response.status,
      });
      return;
    }
    const body = await response.text();
    res.json({ body });
  } catch (error) {
    logger.warn('xtweet', 'graphql proxy fetch failed', error);
    res.status(502).json({
      error: error instanceof Error ? error.message : 'fetch failed',
      code: 'UPSTREAM_ERROR',
    });
  }
});

export default router;
