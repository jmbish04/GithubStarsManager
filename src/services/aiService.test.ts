import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Repository } from '../types';
import {
  AIService,
  AIRequestError,
  isRateLimitedError,
  getRetryAfterMsFromError,
  isAIToolCallUnsupportedError,
  supportsChatToolCalls,
  type AIToolLoopMessage,
} from './aiService';
import { isToolCallCapableApiType } from '../constants/aiCapabilities';
import { logger } from './logger';

// Minimal AIConfig that lets AIService construct without a real token.
const makeConfig = () => ({
  id: 'test',
  name: 'test',
  apiType: 'openai' as const,
  baseUrl: 'http://localhost:0',
  apiKey: '',
  model: 'gpt-test',
  isActive: true,
});

it('redacts plugin AI request details from debug logs', () => {
  const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
  const isDebugMode = vi.spyOn(logger, 'isDebugMode').mockReturnValue(true);
  try {
    const service = new AIService(makeConfig() as never, 'en', true);
    const logRequest = service as unknown as { logAIRequestDebug: (
      startTime: number,
      context: { apiType: string; model: string; configId: string },
      result: { responseLength: number },
      details: Record<string, unknown>,
    ) => void };
    logRequest.logAIRequestDebug(Date.now(), { apiType: 'openai', model: 'example', configId: 'test' },
      { responseLength: 5 }, { url: 'https://secret.example/key', requestBody: 'private prompt', responseBody: 'private answer', status: 200 });
    expect(debug).toHaveBeenCalledOnce();
    const metadata = debug.mock.calls[0][2];
    expect(metadata).toEqual(expect.objectContaining({ status: 200, responseLength: 5 }));
    expect(JSON.stringify(metadata)).not.toContain('private');
    expect(JSON.stringify(metadata)).not.toContain('secret.example');
  } finally {
    debug.mockRestore();
    isDebugMode.mockRestore();
  }
});

function makeRepo(partial: Partial<Repository> & Pick<Repository, 'id' | 'name' | 'full_name'>): Repository {
  return {
    description: null,
    html_url: `https://github.com/${partial.full_name}`,
    stargazers_count: 0,
    forks_count: 0,
    forks: 0,
    language: 'TypeScript',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-06-01T00:00:00Z',
    pushed_at: '2024-06-01T00:00:00Z',
    owner: { login: 'owner', avatar_url: '' },
    topics: [],
    ...partial,
  };
}

describe('AIService.searchRepositoriesWithSelection — lexical fallback', () => {
  beforeEach(() => {
    // Force the AI request path to fail so we fall back to performEnhancedBasicSearch.
    (window.fetch as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('network disabled in test');
    });
  });

  it('ranks a license-matching repo above a higher-star non-matching repo when the query mixes license + other terms', async () => {
    // A matches both the name term ("react") and the license term ("mit").
    const repoA = makeRepo({
      id: 1,
      name: 'react-app',
      full_name: 'acme/react-app',
      stargazers_count: 500,
      license: 'MIT',
    });
    // B has far more stars and matches the name term, but NOT the license term.
    const repoB = makeRepo({
      id: 2,
      name: 'react-lib',
      full_name: 'acme/react-lib',
      stargazers_count: 1000,
      license: 'Apache-2.0',
    });

    const service = new AIService(makeConfig() as never, 'en');
    const results = await service.searchRepositoriesWithSelection([repoA, repoB], 'react mit');

    const ids = results.map((r) => r.id);
    // With the license weight, A's license match outweighs B's popularity edge.
    expect(ids).toEqual([1, 2]);
    expect(results).toHaveLength(2);
  });

  it('does not crash when a repo carries a raw GitHub license object (toLowerCase defensive)', async () => {
    // Regression for "e.toLowerCase is not a function": a repo whose license never passed
    // through toLicenseSpdxId (legacy persisted store / third-party import) keeps a raw
    // GitHub object `{ key, spdx_id, ... }`. performEnhancedBasicSearch must reduce it via
    // normalizeLicense rather than (repo.license || '').toLowerCase().
    const repoA = makeRepo({
      id: 3,
      name: 'react-legacy',
      full_name: 'acme/react-legacy',
      stargazers_count: 10,
      license: { spdx_id: 'MIT', key: 'MIT', name: 'MIT License', url: 'https://api.github.com/licenses/mit' } as never,
    });

    const service = new AIService(makeConfig() as never, 'en');
    // Should resolve the license object to 'MIT' and rank the repo — not throw.
    const results = await service.searchRepositoriesWithSelection([repoA], 'mit');
    expect(results.map((r) => r.id)).toEqual([3]);
  });

  it('finds a repo by its custom tag via static fallback search', async () => {
    const repo = makeRepo({
      id: 4,
      name: 'skill-pack',
      full_name: 'acme/skill-pack',
      description: 'A collection of prompts',
      ai_tags: ['\u6548\u7387\u5de5\u5177'], // Chinese for "productivity tools"
      custom_tags: ['\u6280\u80fd'], // Chinese for "skill"
    });

    const results = await AIService.searchRepositories([repo], '\u6280\u80fd');
    expect(results.map((r) => r.id)).toEqual([4]);
  });

  it('finds a repo matching only through custom_tags via enhanced search', async () => {
    const repo = makeRepo({
      id: 6,
      name: 'skill-pack',
      full_name: 'acme/skill-pack',
      description: 'A collection of prompts',
      ai_tags: ['\u6548\u7387\u5de5\u5177'], // Chinese for "productivity tools"
      custom_tags: ['\u6280\u80fd'], // Chinese for "skill"
    });

    const service = new AIService(makeConfig() as never, 'zh');
    const results = service['performEnhancedBasicSearch']([repo], '\u6280\u80fd', ['\u6280\u80fd']);
    expect(results.map((r) => r.id)).toEqual([6]);
  });

  it('does not duplicate scoring when expanded terms match query terms (token-level deduplication)', async () => {
    const repo = makeRepo({ id: 20, name: 'markdown', full_name: 'acme/markdown' });

    const service = new AIService(makeConfig() as never, 'zh');
    const scored = service['scoreRepositoriesByKeywords']([repo], 'markdown editor', ['Markdown', 'acme']);

    // 'Markdown' equals query term 'markdown', pruned so name/fullName are not scored twice;
    // 'acme' (fullName hit) still scores normally: name 0.4 + fullName 0.35 + expansion term 0.2 = 0.95
    // (would be 1.4 if token-level pruning failed)
    expect(scored[0].score).toBeCloseTo(0.95, 10);
  });

  it('recalls via CJK bigrams when Chinese query has no AI expansion terms, preventing zero hits on full-string fallback', async () => {
    const repo = makeRepo({
      id: 30,
      name: 'stars-manager',
      full_name: 'acme/stars-manager',
      description: '\u7ba1\u7406 GitHub \u661f\u6807\u4ed3\u5e93\u7684\u5de5\u5177', // Chinese for "tool for managing GitHub starred repositories"
    });

    const service = new AIService(makeConfig() as never, 'zh');
    // Query "\u661f\u6807\u4ed3\u5e93" (starred repositories) has no space boundaries to tokenize and the full string is absent in the description; bigrams match the description
    const scored = service['scoreRepositoriesByKeywords']([repo], '\u661f\u6807\u4ed3\u5e93', []);
    expect(scored).toHaveLength(1);
    expect(scored[0].score).toBeGreaterThan(0);
  });
});

describe('AIService.searchRepositoriesWithSelection — LLM selection', () => {
  const fetchJson = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const chatResponse = (content: string) => fetchJson({ choices: [{ message: { content } }] });
  const mockFetch = () => {
    const fetchMock = window.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockReset();
    return fetchMock;
  };
  const captureBody = async (init?: RequestInit) => JSON.parse(String(init?.body)) as Record<string, unknown>;

  it('submits candidate summaries to LLM selection after query expansion and returns model ordering (with intent description)', async () => {
    const fetchMock = mockFetch();
    const requests: Array<Record<string, unknown>> = [];
    fetchMock.mockImplementationOnce(async (_url, init) => {
      requests.push(await captureBody(init));
      return chatResponse('{"intent":"\\u627e markdown \\u7f16\\u8f91\\u5668","keywords":["markdown","editor"],"synonyms":[]}');
    });
    fetchMock.mockImplementationOnce(async (_url, init) => {
      requests.push(await captureBody(init));
      return chatResponse('[880000002, 880000001]');
    });

    const repoA = makeRepo({ id: 880000001, name: 'quick-md', full_name: 'acme/quick-md', description: 'a markdown editor', stargazers_count: 900 });
    const repoB = makeRepo({ id: 880000002, name: 'random-tool', full_name: 'acme/random-tool', description: 'unrelated', stargazers_count: 5000 });

    const service = new AIService(makeConfig() as never, 'zh');
    const results = await service.searchRepositoriesWithSelection([repoA, repoB], 'markdown \u7f16\u8f91\u5668');

    expect(results.map((r) => r.id)).toEqual([880000002, 880000001]);
    // Expansion request asks model to restate intent; selection request includes intent description and candidate summaries
    expect(String((requests[0].messages as Array<{ content: string }>)[1].content)).toContain('"intent"');
    const selectionPrompt = String((requests[1].messages as Array<{ content: string }>)[1].content);
    expect(selectionPrompt).toContain('Query intent: \u627e markdown \u7f16\u8f91\u5668');
    expect(selectionPrompt).toContain('2 total');
    expect(selectionPrompt).toContain('acme/quick-md');
    // Selection request for standard models keeps a compact token budget
    expect(requests[1].max_tokens).toBe(800);
  });

  it('resolves candidate line numbers as IDs when returned by model, preserving reranked results', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockImplementationOnce(async () => chatResponse('{"intent":"","keywords":[],"synonyms":[]}'));
    fetchMock.mockImplementationOnce(async () => chatResponse('[2, 1]'));

    const repoA = makeRepo({ id: 730000001, name: 'alpha', full_name: 'acme/alpha' });
    const repoB = makeRepo({ id: 730000002, name: 'beta', full_name: 'acme/beta' });

    const service = new AIService(makeConfig() as never, 'zh');
    const results = await service.searchRepositoriesWithSelection([repoA, repoB], 'anything');

    expect(results.map((r) => r.id)).toEqual([730000002, 730000001]);
  });

  it('presents empty results when model explicitly returns an empty array, instead of falling back to lexical noise', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockImplementationOnce(async () => chatResponse('{"intent":"","keywords":["foo"],"synonyms":[]}'));
    fetchMock.mockImplementationOnce(async () => chatResponse('[]'));

    const repoA = makeRepo({ id: 740000001, name: 'foo-tool', full_name: 'acme/foo-tool' });

    const service = new AIService(makeConfig() as never, 'zh');
    const results = await service.searchRepositoriesWithSelection([repoA], '\u4e0d\u5b58\u5728\u7684\u4e1c\u897f' /* Chinese for "non-existent item" */);

    expect(results).toEqual([]);
  });

  it('performs lexical recall on large libraries: truncates candidates at limit before injecting into selection prompt', async () => {
    const fetchMock = mockFetch();
    const requests: Array<Record<string, unknown>> = [];
    fetchMock.mockImplementationOnce(async (_url, init) => {
      requests.push(await captureBody(init));
      return chatResponse('{"intent":"","keywords":["thing"],"synonyms":[]}');
    });
    fetchMock.mockImplementationOnce(async (_url, init) => {
      requests.push(await captureBody(init));
      return chatResponse('[900001]');
    });

    const target = makeRepo({ id: 900001, name: 'target-thing', full_name: 'acme/target-thing', description: 'the thing you want', stargazers_count: 10 });
    const pads = Array.from({ length: 159 }, (_, i) =>
      makeRepo({ id: 900002 + i, name: `junk-${i}`, full_name: `acme/junk-${i}`, stargazers_count: i }));

    const service = new AIService(makeConfig() as never, 'zh');
    const results = await service.searchRepositoriesWithSelection([target, ...pads], 'thing');

    const selectionPrompt = String((requests[1].messages as Array<{ content: string }>)[1].content);
    expect(selectionPrompt).toContain('100 total');
    expect(results.map((r) => r.id)).toEqual([900001]);
  });

  it('does not perform lexical fallback when caller aborts, propagating cancellation error upward', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockImplementationOnce(async () => {
      throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    });
    const controller = new AbortController();

    const repoA = makeRepo({ id: 750000001, name: 'foo-tool', full_name: 'acme/foo-tool' });

    const service = new AIService(makeConfig() as never, 'zh');
    // Aborted !== AI failure: must not return lexical fallback results as search results
    await expect(
      service.searchRepositoriesWithSelection([repoA], 'foo', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reuses larger token budget for reasoning models during selection to prevent silent degradation when reasoning exhausts budget', async () => {
    const fetchMock = mockFetch();
    const requests: Array<Record<string, unknown>> = [];
    fetchMock.mockImplementationOnce(async (_url, init) => {
      requests.push(await captureBody(init));
      return chatResponse('{"intent":"","keywords":[],"synonyms":[]}');
    });
    fetchMock.mockImplementationOnce(async (_url, init) => {
      requests.push(await captureBody(init));
      return chatResponse('[]');
    });

    const repo = makeRepo({ id: 760000001, name: 'foo-tool', full_name: 'acme/foo-tool' });
    const service = new AIService({ ...makeConfig(), reasoningEffort: 'high' } as never, 'zh');
    await service.searchRepositoriesWithSelection([repo], 'foo');

    // Expansion request leaves ample margin for thinking models; selection request reuses the 4096 reranking budget (reasoning tokens share budget)
    expect(requests[0].max_tokens).toBe(2000);
    expect(requests[1].max_tokens).toBe(4096);
  });

  it('notifies caller via onFallback when AI request fails, falling back to lexical score order', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError('Failed to fetch');
    });
    const onFallback = vi.fn();

    const repoA = makeRepo({ id: 770000001, name: 'foo-tool', full_name: 'acme/foo-tool' });

    const service = new AIService(makeConfig() as never, 'zh');
    const results = await service.searchRepositoriesWithSelection([repoA], 'foo', { onFallback });

    // On endpoint jitter / config issues: callback provides reason, results fall back to lexical hits instead of empty
    expect(onFallback).toHaveBeenCalledWith('ai_failed');
    expect(results.map((r) => r.id)).toEqual([770000001]);
  });

  it('preserves empty results when model determines no relevant repositories exist, explaining reason via onFallback', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockImplementationOnce(async () => chatResponse('{"intent":"","keywords":[],"synonyms":[]}'));
    fetchMock.mockImplementationOnce(async () => chatResponse('[]'));
    const onFallback = vi.fn();

    const repo = makeRepo({ id: 780000001, name: 'foo-tool', full_name: 'acme/foo-tool' });

    const service = new AIService(makeConfig() as never, 'zh');
    const results = await service.searchRepositoriesWithSelection([repo], '\u5b8c\u5168\u65e0\u5173\u7684\u67e5\u8be2' /* Chinese for "completely irrelevant query" */, { onFallback });

    expect(onFallback).toHaveBeenCalledWith('ai_empty');
    expect(results).toEqual([]);
  });

  it('treats response as invalid when none of the returned IDs can be resolved, falling back to lexical rather than empty state', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockImplementationOnce(async () => chatResponse('{"intent":"","keywords":["foo"],"synonyms":[]}'));
    fetchMock.mockImplementationOnce(async () => chatResponse('[999999999, 888888888]'));
    const onFallback = vi.fn();

    const repo = makeRepo({ id: 790000001, name: 'foo-tool', full_name: 'acme/foo-tool' });

    const service = new AIService(makeConfig() as never, 'zh');
    const results = await service.searchRepositoriesWithSelection([repo], 'foo', { onFallback });

    // Hallucinated IDs !== model determined empty: must not treat invalid response as "no relevant results" empty state
    expect(onFallback).toHaveBeenCalledWith('unparseable');
    expect(results.map((r) => r.id)).toEqual([790000001]);
  });
});

describe('AIService.searchRepositoriesWithSemanticReranking — line number fallback', () => {
  const fetchJson = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  beforeEach(() => {
    (window.fetch as ReturnType<typeof vi.fn>).mockReset();
  });

  it('resolves line numbers as IDs when returned by model, ensuring reranked results are not silently dropped', async () => {
    // Regression: old repoById.get(id) parsing dropped the entire line-number response, silently breaking reranking
    const repoA = makeRepo({ id: 730000001, name: 'alpha', full_name: 'acme/alpha', stargazers_count: 10 });
    const repoB = makeRepo({ id: 730000002, name: 'beta', full_name: 'acme/beta', stargazers_count: 5 });
    (window.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      fetchJson({ choices: [{ message: { content: '[2, 1]' } }] }),
    );

    const service = new AIService(makeConfig() as never, 'zh');
    const results = await service.searchRepositoriesWithSemanticReranking([repoA, repoB], 'anything');

    expect(results.map((r) => r.id)).toEqual([730000002, 730000001]);
  });

  it('prioritizes real IDs over line numbers, appending unranked repositories at the end', async () => {
    const repoA = makeRepo({ id: 730000001, name: 'alpha', full_name: 'acme/alpha' });
    const repoB = makeRepo({ id: 730000002, name: 'beta', full_name: 'acme/beta' });
    const repoC = makeRepo({ id: 730000003, name: 'gamma', full_name: 'acme/gamma' });
    (window.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      fetchJson({ choices: [{ message: { content: '[730000003, 1]' } }] }),
    );

    const service = new AIService(makeConfig() as never, 'zh');
    const results = await service.searchRepositoriesWithSemanticReranking([repoA, repoB, repoC], 'anything');

    // 730000003 matched by real ID; 1 within candidate bounds resolved by line number to repoA; repoB unranked, appended at the end
    expect(results.map((r) => r.id)).toEqual([730000003, 730000001, 730000002]);
  });
});

describe('AIRequestError / rate limiting helpers', () => {
  it('constructs error and marks isRateLimit', () => {
    const err = new AIRequestError('rate limited', 429, 5000);
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(5000);
    expect(err.isRateLimit).toBe(true);
    expect(err.name).toBe('AIRequestError');
  });

  it('isRateLimitedError identifies 429 or rate limit messages', () => {
    expect(isRateLimitedError(new AIRequestError('x', 429))).toBe(true);
    expect(isRateLimitedError({ statusCode: 429 })).toBe(true);
    expect(isRateLimitedError(new Error('Too Many Requests'))).toBe(true);
    expect(isRateLimitedError(new Error('network down'))).toBe(false);
    expect(isRateLimitedError(null)).toBe(false);
  });

  it('getRetryAfterMsFromError extracts valid milliseconds', () => {
    expect(getRetryAfterMsFromError(new AIRequestError('x', 429, 1234))).toBe(1234);
    expect(getRetryAfterMsFromError({})).toBeUndefined();
    expect(getRetryAfterMsFromError(undefined)).toBeUndefined();
  });
});


describe('AIService.generateWithTools — native function calling', () => {
  // Both generateWithTools and supportsChatToolCalls require explicitly toggling supportsToolCalls.
  const toolCallConfig = { ...makeConfig(), supportsToolCalls: true as const };
  const tools = [
    { name: 'read_documentation', description: 'Read docs', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  ];
  const messages: AIToolLoopMessage[] = [
    { role: 'user', content: 'Question: What is this repo?' },
    { role: 'assistant', content: null, toolCalls: [{ id: 'call_1', name: 'read_documentation', arguments: '{"path":"README.md"}' }] },
    { role: 'tool', toolCallId: 'call_1', content: 'SOURCE: /README.md - 1-5' },
  ];
  const fetchJson = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  beforeEach(() => {
    (window.fetch as ReturnType<typeof vi.fn>).mockReset();
  });

  it('sends the tools payload with tool results and parses returned tool calls', async () => {
    const service = new AIService(toolCallConfig);
    (window.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(fetchJson({
      choices: [{
        message: {
          content: '',
          tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'ready_to_answer', arguments: '{"missing":[]}' } }],
        },
      }],
    }));

    const result = await service.generateWithTools({ system: 'agent rules', messages, tools, temperature: 0, maxTokens: 1_200 });

    const [, init] = (window.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(Array.isArray(requestBody.tools)).toBe(true);
    expect(requestBody.tool_choice).toBe('auto');
    const sentMessages = requestBody.messages as Array<Record<string, unknown>>;
    expect(sentMessages[0]).toEqual({ role: 'system', content: 'agent rules' });
    expect(sentMessages[2]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_documentation' } }] });
    // Must omit content entirely when empty: explicit null or empty string is rejected by some gateways.
    expect(sentMessages[2]).not.toHaveProperty('content');
    expect(sentMessages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'SOURCE: /README.md - 1-5' });
    expect(result.content).toBe('');
    expect(result.toolCalls).toEqual([{ id: 'call_2', name: 'ready_to_answer', arguments: '{"missing":[]}' }]);
  });

  it('converts endpoint rejection of tools into AIToolCallUnsupportedError', async () => {
    const service = new AIService(toolCallConfig);
    (window.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(fetchJson({ error: { message: 'tools is not supported by this model' } }, 400));

    await expect(service.generateWithTools({ system: 'rules', messages, tools }))
      .rejects.toSatisfy(isAIToolCallUnsupportedError);
  });

  it('throws AIToolCallUnsupportedError for protocol families without tool support', async () => {
    const service = new AIService({ ...makeConfig(), apiType: 'claude' });
    await expect(service.generateWithTools({ system: 'rules', messages, tools }))
      .rejects.toSatisfy(isAIToolCallUnsupportedError);
    expect(window.fetch).not.toHaveBeenCalled();
    // Capability check = protocol family support AND explicit toggle; both are required.
    expect(supportsChatToolCalls({ apiType: 'openai-compatible', supportsToolCalls: true })).toBe(true);
    expect(supportsChatToolCalls({ apiType: 'openai-compatible' })).toBe(false);
    expect(supportsChatToolCalls({ apiType: 'gemini', supportsToolCalls: true })).toBe(false);
    expect(isToolCallCapableApiType('openai-compatible')).toBe(true);
    expect(isToolCallCapableApiType('claude')).toBe(false);
  });
});

describe('AIService.analyzeRepository language following', () => {
  const extractMessages = (body: unknown): Array<{ role: string; content: string }> => {
    const parsed = body as { messages?: Array<{ role: string; content: string }>; input?: Array<{ role: string; content: string }> };
    return parsed.messages ?? parsed.input ?? [];
  };

  const lastMessages = (): Array<{ role: string; content: string }> => {
    const calls = (window.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const lastCall = calls[calls.length - 1] as [string, RequestInit] | undefined;
    return extractMessages(JSON.parse(String(lastCall?.[1]?.body)));
  };

  beforeEach(() => {
    (window.fetch as ReturnType<typeof vi.fn>).mockReset();
    (window.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: '{"summary":"A sample analysis of the repository.","tags":["tool"],"platforms":["web"]}' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
  });

  it('keeps the English user prompt verbatim for en', async () => {
    const service = new AIService(makeConfig() as never, 'en');
    await service.analyzeRepository(makeRepo({ id: 1, name: 'sample', full_name: 'acme/sample' }), '# readme');
    const joined = lastMessages().map((message) => message.content).join('\n');
    expect(joined).toContain('A concise English overview');
    expect(joined).toContain('"summary": "English overview"');
    expect(joined).not.toContain('Write ALL user-facing output');
  });

  it('does not force English output when the UI language is Japanese', async () => {
    const service = new AIService(makeConfig() as never, 'ja');
    await service.analyzeRepository(makeRepo({ id: 1, name: 'sample', full_name: 'acme/sample' }), '# readme');
    const joined = lastMessages().map((message) => message.content).join('\n');
    expect(joined).not.toContain('A concise English overview');
    expect(joined).not.toContain('"summary": "English overview"');
    expect(joined).toContain('Write ALL user-facing output in Japanese (\u65e5\u672c\u8a9e)');
  });
});
