import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockStoreState } = vi.hoisted(() => ({
  mockStoreState: {
    translationEngine: 'microsoft' as 'microsoft' | 'google' | 'ai',
    aiConfigs: [] as Array<{ id: string; name: string }>,
    activeAIConfig: null as string | null,
    language: 'zh' as 'zh' | 'en',
  },
}));

vi.mock('../store/useAppStore', () => ({
  useAppStore: { getState: () => mockStoreState },
}));

vi.mock('./aiService', () => ({
  AIService: vi.fn(),
}));

import { translateText, translateBatch } from './translateService';

interface MockFetchOptions {
  /** Mock response body: return value of json() (for Microsoft engine). */
  msBody?: Array<{ translations?: Array<{ text?: string }> }>;
  /** Mock response body: return value of json() (for Google engine, passed directly). */
  rawBody?: unknown;
  /** json() hangs until signal is aborted (simulating slow body read). */
  hangBody?: boolean;
  status?: number;
}

const createMockResponse = (init: RequestInit, options: MockFetchOptions) => {
  const signal = init.signal as AbortSignal;
  const ok = (options.status ?? 200) < 400;
  const json = (): Promise<unknown> => {
    if (options.hangBody) {
      // Simulate real fetch behavior: aborting signal while reading body rejects with AbortError
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }
    return Promise.resolve(options.msBody ?? options.rawBody ?? []);
  };
  return { ok, status: options.status ?? 200, json } as unknown as Response;
};

const installFetch = (options: MockFetchOptions | ((url: string, init: RequestInit) => MockFetchOptions)) => {
  const fetchMock = vi.fn(async (_url: string | URL, init: RequestInit = {}) => {
    const resolved = typeof options === 'function' ? options(String(_url), init) : options;
    return createMockResponse(init, resolved);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

describe('translateService', () => {
  beforeEach(() => {
    mockStoreState.translationEngine = 'microsoft';
    mockStoreState.aiConfigs = [];
    mockStoreState.activeAIConfig = null;
    mockStoreState.language = 'zh';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('microsoft engine: requests the new auth-free endpoint and maps the response', async () => {
    const fetchMock = installFetch({
      // Chinese for "Hello, world"
      msBody: [{ translations: [{ text: '\u4f60\u597d\uff0c\u4e16\u754c' }] }],
    });

    const result = await translateText({ text: 'Hello world', to: 'zh', from: 'en' });

    expect(result.translatedText).toBe('\u4f60\u597d\uff0c\u4e16\u754c');
    const [calledUrl, callInit] = fetchMock.mock.calls[0];
    const init = callInit as RequestInit;
    expect(String(calledUrl)).toContain('https://edge.microsoft.com/translate/translatetext');
    expect(String(calledUrl)).toContain('from=en');
    expect(String(calledUrl)).toContain('to=zh-Hans');
    expect(String(calledUrl)).toContain('isEnterpriseClient=false');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(['Hello world']);
    // New endpoint does not require Authorization header
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('microsoft engine: leaves from empty for auto-detection', async () => {
    // Chinese for "Hello"
    const fetchMock = installFetch({ msBody: [{ translations: [{ text: '\u4f60\u597d' }] }] });

    await translateText({ text: 'Hello', to: 'zh' });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('from=&');
    expect(url).toContain('to=zh-Hans');
  });

  it('google engine: posts to dict-chrome-ex and normalizes both response shapes', async () => {
    mockStoreState.translationEngine = 'google';

    // Chinese for "Hello world"
    const pairs = installFetch({ rawBody: [['\u4f60\u597d\u4e16\u754c', 'en']] });
    const r1 = await translateText({ text: 'Hello world', to: 'zh' });
    expect(r1.translatedText).toBe('\u4f60\u597d\u4e16\u754c');
    expect(String(pairs.mock.calls[0][0])).toContain('client=dict-chrome-ex');
    expect(String(pairs.mock.calls[0][0])).toContain('sl=auto&tl=zh-CN');
    // Body is q=… form
    const googleInit = pairs.mock.calls[0][1] as RequestInit;
    expect(String(googleInit.body)).toBe('q=Hello+world');

    // When sl is explicitly specified, API returns a flat string array; must normalize as well
    const flat = installFetch({ rawBody: ['\u4f60\u597d\u4e16\u754c'] });
    const r2 = await translateText({ text: 'Hello world', to: 'zh', from: 'en' });
    expect(r2.translatedText).toBe('\u4f60\u597d\u4e16\u754c');
    expect(String(flat.mock.calls[0][0])).toContain('sl=en');
  });

  it('google engine: chunks large batches into multiple requests', async () => {
    mockStoreState.translationEngine = 'google';
    const texts = Array.from({ length: 25 }, (_, i) => `text ${i}`);
    const fetchMock = installFetch({
      rawBody: [['translated', 'en']],
    });
    // Each request returns translations matching the count of that request
    fetchMock.mockImplementation(async (_url: string | URL, init: RequestInit = {}) => {
      const count = String(init.body).split('&').filter((p) => p.startsWith('q=')).length;
      return createMockResponse(init, { rawBody: Array.from({ length: count }, () => ['translated', 'en']) });
    });

    const results = await translateBatch(texts, 'zh', 'en');

    expect(results).toHaveLength(25);
    // 20 item limit -> at least 2 requests
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('html textType: protects inline <code> with placeholders and restores them', async () => {
    const fetchMock = installFetch({
      // Chinese for "Run {0} to install dependencies"
      msBody: [{ translations: [{ text: '\u8fd0\u884c {0} \u4ee5\u5b89\u88c5\u4f9d\u8d56' }] }],
    });

    const result = await translateText({
      text: 'Run <code>npm install</code> to install dependencies',
      to: 'zh',
      from: 'en',
      textType: 'html',
    });

    // Placeholders in request instead of code tags
    const protectInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(protectInit.body))).toEqual(['Run {0} to install dependencies']);
    // Placeholders restored back to <code> in translated text
    expect(result.translatedText).toBe('\u8fd0\u884c <code>npm install</code> \u4ee5\u5b89\u88c5\u4f9d\u8d56');
  });

  it('html textType: falls back to the original text when a placeholder is lost', async () => {
    // Chinese for "Run to install dependencies"
    installFetch({ msBody: [{ translations: [{ text: '\u8fd0\u884c \u4ee5\u5b89\u88c5\u4f9d\u8d56' }] }] });

    const original = 'Run <code>npm install</code> to install dependencies';
    const result = await translateText({ text: original, to: 'zh', from: 'en', textType: 'html' });

    expect(result.translatedText).toBe(original);
  });

  it('html textType: inserts code containing $ sequences verbatim on restore', async () => {
    // Chinese for "Run {0} to process text"
    installFetch({ msBody: [{ translations: [{ text: '\u8fd0\u884c {0} \u5904\u7406\u6587\u672c' }] }] });

    const result = await translateText({
      text: "Run <code>sed 's/a/$&/' file</code> to process text",
      to: 'zh',
      from: 'en',
      textType: 'html',
    });

    // $& must not be interpreted as "whole match", must restore verbatim
    expect(result.translatedText).toBe("\u8fd0\u884c <code>sed 's/a/$&/' file</code> \u5904\u7406\u6587\u672c");
  });

  it('timeout during a delayed body read is classified as a transient error and retried, then surfaced as timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = installFetch({ hangBody: true });

    const promise = translateText({ text: 'Hello world', to: 'zh', from: 'en' });
    const assertion = expect(promise).rejects.toThrow('Request timed out after 20000ms');

    // 3 attempts × 20s timeout + two backoff sleeps (1s + 2s)
    await vi.advanceTimersByTimeAsync(3 * 20_000 + 3_000);
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('caller abort is rethrown as AbortError and not retried', async () => {
    const fetchMock = installFetch({ msBody: [{ translations: [{ text: 'x' }] }] });
    fetchMock.mockImplementation(async (_url: string | URL, init: RequestInit = {}) => {
      const signal = init.signal as AbortSignal;
      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      return createMockResponse(init, { msBody: [{ translations: [{ text: 'x' }] }] });
    });

    const controller = new AbortController();
    controller.abort();

    await expect(
      translateText({ text: 'Hello', to: 'zh', from: 'en', signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('transient HTTP errors (5xx) are retried, non-transient (4xx) are not', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchMock = vi.fn(async (_url: string | URL, init: RequestInit = {}) => {
      calls += 1;
      if (calls <= 2) return createMockResponse(init, { status: 500 });
      return createMockResponse(init, { status: 400 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const promise = translateText({ text: 'Hello', to: 'zh', from: 'en' });
    const assertion = expect(promise).rejects.toThrow('Translation failed: 400');
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;

    // 500 -> retry; 400 -> throw immediately
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('ai engine without an active AI config fails with a setup hint', async () => {
    vi.useFakeTimers();
    mockStoreState.translationEngine = 'ai';
    const fetchMock = installFetch({ msBody: [] });

    const promise = translateText({ text: 'Hello', to: 'zh', from: 'en' });
    const assertion = expect(promise).rejects.toThrow('AI translation engine is not ready');
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;

    // AI engine does not use direct connection endpoint
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('empty batch returns immediately without any request', async () => {
    const fetchMock = installFetch({ msBody: [] });
    expect(await translateBatch([], 'zh')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
