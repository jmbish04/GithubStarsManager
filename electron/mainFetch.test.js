const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractCauseChain,
  summarizeFetchError,
  fetchAcrossStacks,
  timeoutSignalFromBudget,
  followRedirectsManually,
  toFailureResult,
} = require('./mainFetch');

describe('summarizeFetchError: unwraps undici "fetch failed" cause chain', () => {
  it('extracts code and message from deepest cause', () => {
    // undici shape: TypeError('fetch failed') -> cause: Error(code=ECONNREFUSED)
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:5006');
    cause.code = 'ECONNREFUSED';
    const err = new TypeError('fetch failed', { cause });

    const summary = summarizeFetchError(err);

    assert.equal(summary.causeCode, 'ECONNREFUSED');
    assert.equal(summary.causeMessage, 'connect ECONNREFUSED 127.0.0.1:5006');
    assert.match(summary.message, /fetch failed/);
    assert.match(summary.message, /ECONNREFUSED: connect ECONNREFUSED 127\.0\.0\.1:5006/);
    assert.equal(summary.timedOut, false);
  });

  it('deduplicates cause chain (identical text kept once)', () => {
    const cause = new Error('getaddrinfo ENOTFOUND dav.lan');
    cause.code = 'ENOTFOUND';
    const err = new TypeError('fetch failed', { cause });

    const summary = summarizeFetchError(err);

    assert.equal(
      summary.message,
      'fetch failed <- ENOTFOUND: getaddrinfo ENOTFOUND dav.lan',
    );
  });

  it('AggregateError (Happy Eyeballs) unpacks sub-errors', () => {
    const a = new Error('connect ETIMEDOUT 203.0.113.1:443');
    a.code = 'ETIMEDOUT';
    const b = new Error('connect ENETUNREACH 2001:db8::1:443');
    b.code = 'ENETUNREACH';
    const agg = new AggregateError([a, b], 'fetch failed');

    const summary = summarizeFetchError(agg);

    const codes = extractCauseChain(agg).filter((c) => c.code).map((c) => c.code);
    assert.deepEqual(codes, ['ETIMEDOUT', 'ENETUNREACH']);
    assert.equal(summary.timedOut, true);
  });

  it('preserves AggregateError own cause', () => {
    const own = new Error('aggregate own cause');
    own.code = 'EOWN';
    const sub = new Error('sub');
    sub.code = 'ESUB';
    const agg = new AggregateError([sub], 'agg', { cause: own });

    const codes = extractCauseChain(agg).filter((c) => c.code).map((c) => c.code);

    assert.ok(codes.includes('ESUB'));
    assert.ok(codes.includes('EOWN'));
  });

  it('does not overflow stack on circular causes across recursion boundaries', () => {
    const agg = new AggregateError([], 'agg');
    const sub = new Error('loopy');
    agg.errors.push(sub);
    sub.cause = agg; // Sub-error circularly references parent error

    const chain = extractCauseChain(agg);

    assert.ok(chain.length >= 2);
    assert.ok(chain.length < 10);
  });

  it('normalizes TimeoutError / AbortError as timedOut', () => {
    assert.equal(summarizeFetchError(new DOMException('signal timed out', 'TimeoutError')).timedOut, true);
    assert.equal(summarizeFetchError(new DOMException('aborted', 'AbortError')).timedOut, true);
  });

  it('treats UND_ERR_*_TIMEOUT on cause as timedOut', () => {
    const cause = new Error('connect timeout');
    cause.code = 'UND_ERR_CONNECT_TIMEOUT';
    const err = new TypeError('fetch failed', { cause });
    assert.equal(summarizeFetchError(err).timedOut, true);
  });
});

describe('fetchAcrossStacks: multiple network stack fallback', () => {
  const fakeResponse = (status) => ({ status, ok: status < 400 });

  it('falls back to next stack when primary stack throws exception', async () => {
    const calls = [];
    const { response, stack } = await fetchAcrossStacks([
      {
        name: 'undici',
        run: async () => { calls.push('undici'); throw new TypeError('fetch failed'); },
      },
      {
        name: 'chromium',
        run: async () => { calls.push('chromium'); return fakeResponse(200); },
      },
    ]);

    assert.deepEqual(calls, ['undici', 'chromium']);
    assert.equal(stack, 'chromium');
    assert.equal(response.status, 200);
  });

  it('treats HTTP error status as success (does not trigger fallback)', async () => {
    let fallbackCalled = false;
    const { response } = await fetchAcrossStacks([
      { name: 'undici', run: async () => fakeResponse(401) },
      { name: 'chromium', run: async () => { fallbackCalled = true; return fakeResponse(200); } },
    ]);

    assert.equal(response.status, 401);
    assert.equal(fallbackCalled, false);
  });

  it('merges failure details across stacks with structured causes on all failures', async () => {
    const cause = new Error('getaddrinfo ENOTFOUND dav.lan');
    cause.code = 'ENOTFOUND';

    const attempt = fetchAcrossStacks([
      { name: 'undici', run: async () => { throw new TypeError('fetch failed', { cause }); } },
      { name: 'chromium', run: async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED'); } },
    ]);
    await assert.rejects(attempt, (err) => {
      assert.match(err.message, /undici: fetch failed <- ENOTFOUND: getaddrinfo ENOTFOUND dav\.lan/);
      assert.match(err.message, /chromium: net::ERR_NAME_NOT_RESOLVED/);
      assert.equal(err.timedOut, false);
      assert.equal(err.causeCode, undefined); // Last stack (chromium) has no code
      assert.equal(err.failures.length, 2);
      assert.equal(err.failures[0].summary.causeCode, 'ENOTFOUND');
      return true;
    });
  });

  it('timedOut is true only when all stacks timed out', async () => {
    await assert.rejects(fetchAcrossStacks([
      { name: 'a', run: async () => { throw new DOMException('t', 'TimeoutError'); } },
      { name: 'b', run: async () => { throw new DOMException('t', 'TimeoutError'); } },
    ]), (err) => err.timedOut === true);

    await assert.rejects(fetchAcrossStacks([
      { name: 'a', run: async () => { throw new DOMException('t', 'TimeoutError'); } },
      { name: 'b', run: async () => { throw new Error('boom'); } },
    ]), (err) => err.timedOut === false);
  });

  it('does not attempt next stack once timeout budget is exhausted', async () => {
    let fallbackCalled = false;
    await assert.rejects(fetchAcrossStacks([
      {
        name: 'undici',
        run: async ({ remainingMs }) => {
          assert.ok(remainingMs <= 300 && remainingMs > 250);
          await new Promise((r) => setTimeout(r, 350)); // Exhaust budget before failing
          throw new TypeError('fetch failed');
        },
      },
      { name: 'chromium', run: async () => { fallbackCalled = true; return fakeResponse(200); } },
    ], { totalTimeoutMs: 300, minStackBudgetMs: 250 }), /undici: fetch failed/);

    assert.equal(fallbackCalled, false);
  });

  it('executes no stacks when total budget is below minimum single-stack budget', async () => {
    const calls = [];
    await assert.rejects(fetchAcrossStacks([
      { name: 'undici', run: async () => { calls.push('undici'); return fakeResponse(200); } },
    ], { totalTimeoutMs: 500 }), /all network stacks failed/);

    assert.deepEqual(calls, []);
  });
});

describe('fetchAcrossStacks: onResponseRetryable response-level delegation', () => {
  const fakeResponse = (status) => ({ status, ok: status < 400 });

  it('delegates to next stack when response matches predicate (e.g. x.com edge 403s undici by TLS fingerprint)', async () => {
    const calls = [];
    const { response, stack } = await fetchAcrossStacks([
      {
        name: 'undici',
        run: async () => { calls.push('undici'); return fakeResponse(403); },
        onResponseRetryable: (r) => r.status === 403 || r.status === 429,
      },
      {
        name: 'chromium',
        run: async () => { calls.push('chromium'); return fakeResponse(200); },
      },
    ]);

    assert.deepEqual(calls, ['undici', 'chromium']);
    assert.equal(stack, 'chromium');
    assert.equal(response.status, 200);
  });

  it('returns non-matching responses directly without triggering fallback', async () => {
    let fallbackCalled = false;
    const { response } = await fetchAcrossStacks([
      {
        name: 'undici',
        run: async () => fakeResponse(200),
        onResponseRetryable: (r) => r.status === 403,
      },
      {
        name: 'chromium',
        run: async () => { fallbackCalled = true; return fakeResponse(200); },
      },
    ]);

    assert.equal(response.status, 200);
    assert.equal(fallbackCalled, false);
  });

  it('returns last response without throwing when all stacks are deemed misses', async () => {
    const { response, stack } = await fetchAcrossStacks([
      {
        name: 'undici',
        run: async () => fakeResponse(403),
        onResponseRetryable: (r) => r.status === 403,
      },
      {
        name: 'chromium',
        run: async () => fakeResponse(403),
        onResponseRetryable: (r) => r.status === 403,
      },
    ]);

    assert.equal(response.status, 403);
    assert.equal(stack, 'chromium');
  });

  it('cancels response bodies of superseded or discarded miss responses (returning undici connections)', async () => {
    const cancels = [];
    const fakeWithBody = (status) => {
      const response = fakeResponse(status);
      response.body = { cancel: async () => { cancels.push(status); } };
      return response;
    };
    const { response } = await fetchAcrossStacks([
      {
        name: 'undici',
        run: async () => fakeWithBody(403),
        onResponseRetryable: (r) => r.status === 403,
      },
      {
        name: 'chromium-1',
        run: async () => fakeWithBody(429),
        onResponseRetryable: (r) => r.status === 429,
      },
      {
        name: 'chromium-2',
        run: async () => fakeWithBody(200),
      },
    ]);

    assert.equal(response.status, 200);
    // 403 cancelled when superseded by 429; 429 cancelled when discarded on 200; 200 returned normally without cancel
    assert.deepEqual(cancels, [403, 429]);
  });
});

describe('timeoutSignalFromBudget', () => {
  it('constructs signal from remaining budget; falls back to fixed value; min 1000ms', () => {
    assert.equal(timeoutSignalFromBudget(5000, 20000).aborted, false);
    assert.equal(timeoutSignalFromBudget(undefined, 20000).aborted, false);
    assert.equal(timeoutSignalFromBudget(-5, 20000).aborted, false); // Negative budget clamped to 1000ms
  });
});

describe('followRedirectsManually: credentials do not leak across origins', () => {
  const respond = (status, location) => ({
    status,
    headers: { get: (k) => (k.toLowerCase() === 'location' ? location ?? null : null) },
  });
  const recorder = (script) => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return script(calls.length - 1, url, options) ?? respond(200);
    };
    return { calls, fetchImpl };
  };

  it('returns 2xx directly without triggering redirect logic', async () => {
    const { calls, fetchImpl } = recorder(() => respond(200));
    const res = await followRedirectsManually(fetchImpl, 'https://dav.example.com/b/f.json', {
      method: 'PUT', headers: { Authorization: 'Basic abc' }, body: 'x',
    });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
  });

  it('preserves method and Authorization on same-origin 307', async () => {
    const { calls, fetchImpl } = recorder((i) =>
      i === 0 ? respond(307, 'https://dav.example.com/backup/') : respond(201));
    const res = await followRedirectsManually(fetchImpl, 'https://dav.example.com/backup', {
      method: 'PUT', headers: { Authorization: 'Basic abc' }, body: 'x',
    });
    assert.equal(res.status, 201);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.method, 'PUT');
    assert.equal(calls[1].options.headers.Authorization, 'Basic abc');
  });

  it('strips Authorization and Cookie on cross-origin 302', async () => {
    const { calls, fetchImpl } = recorder((i) =>
      i === 0 ? respond(302, 'https://evil.example/harvest') : respond(200));
    await followRedirectsManually(fetchImpl, 'https://dav.example.com/f.json', {
      method: 'GET', headers: { Authorization: 'Basic abc', Cookie: 's=1', 'X-Other': 'keep' },
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.headers.Authorization, undefined);
    assert.equal(calls[1].options.headers.Cookie, undefined);
    assert.equal(calls[1].options.headers['X-Other'], 'keep');
  });

  it('rejects redirects to non-http(s) protocols', async () => {
    const { fetchImpl } = recorder(() => respond(302, 'file:///etc/passwd'));
    await assert.rejects(
      followRedirectsManually(fetchImpl, 'https://dav.example.com/f.json', { method: 'GET' }),
      /unsupported protocol/,
    );
  });

  it('throws when exceeding redirect limit', async () => {
    const { fetchImpl } = recorder(() => respond(302, 'https://dav.example.com/loop'));
    await assert.rejects(
      followRedirectsManually(fetchImpl, 'https://dav.example.com/f.json', { method: 'GET' }, { maxRedirects: 3 }),
      /too many redirects/,
    );
  });

  it('returns 3xx response as-is when 302 has no Location header', async () => {
    const { calls, fetchImpl } = recorder(() => respond(302, null));
    const res = await followRedirectsManually(fetchImpl, 'https://dav.example.com/f.json', { method: 'GET' });
    assert.equal(res.status, 302);
    assert.equal(calls.length, 1);
  });

  it('303 degrades PUT to GET, stripping body and Content-* request headers', async () => {
    const { calls, fetchImpl } = recorder((i) =>
      i === 0 ? respond(303, 'https://dav.example.com/done') : respond(200));
    await followRedirectsManually(fetchImpl, 'https://dav.example.com/f.json', {
      method: 'PUT',
      headers: { Authorization: 'Basic abc', 'Content-Type': 'application/json', 'Content-Length': '3' },
      body: '{"a":1}',
    });
    assert.equal(calls[1].options.method, 'GET');
    assert.equal(calls[1].options.body, undefined);
    assert.equal(calls[1].options.headers['Content-Type'], undefined);
    assert.equal(calls[1].options.headers['Content-Length'], undefined);
    assert.equal(calls[1].options.headers.Authorization, 'Basic abc'); // Same-origin preserves credentials
  });
});

describe('toFailureResult: IPC failure return normalization', () => {
  it('passes through structured cause from fetchAcrossStacks combined errors', async () => {
    const cause = new Error('connect ECONNREFUSED 10.0.0.5:5006');
    cause.code = 'ECONNREFUSED';
    let combined;
    try {
      await fetchAcrossStacks([
        { name: 'undici', run: async () => { throw new TypeError('fetch failed', { cause }); } },
      ]);
    } catch (err) {
      combined = err;
    }

    const result = toFailureResult(combined);

    assert.equal(result.success, false);
    assert.equal(result.causeCode, 'ECONNREFUSED');
    assert.equal(result.causeMessage, 'connect ECONNREFUSED 10.0.0.5:5006');
    assert.match(result.error, /undici: fetch failed/);
    assert.equal(result.timedOut, false);
  });

  it('standard exceptions fall back to summarize', () => {
    const result = toFailureResult(new Error('boom'));
    assert.equal(result.success, false);
    assert.equal(result.error, 'boom');
    assert.equal(result.timedOut, false);
    assert.equal(result.causeCode, undefined);
  });

  it('normalizes timedOut when all stacks time out', async () => {
    let combined;
    try {
      await fetchAcrossStacks([
        { name: 'a', run: async () => { throw new DOMException('t', 'TimeoutError'); } },
      ]);
    } catch (err) {
      combined = err;
    }
    assert.equal(toFailureResult(combined).timedOut, true);
  });
});
