'use strict';

/**
 * Regression gate: Outbound requests in the main process mixing Node's built-in fetch with
 * npm undici@8 dispatchers (getFetchDispatcher's ProxyAgent) throw
 * UND_ERR_INVALID_ARG: invalid onRequestStart method before dialing (Electron 44 = Node 24;
 * built-in undici and npm undici@8 handler protocols are incompatible; verified in reproduction).
 *
 * Convention: The top of main.js imports { fetch: undiciFetch, ProxyAgent } from the same version;
 * outbound calls carrying dispatchers must use undiciFetch; proxy-free paths allow falling back to
 * built-in fetch (x.com edge permits built-in undici based on TLS fingerprint, 403ing npm undici@8),
 * but bare calls to global fetch are prohibited—this gate asserts no direct `fetch(` calls exist in main.js.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_JS = path.join(__dirname, 'main.js');

/** Matches bare global fetch( calls — excludes net.fetch / globalThis.fetch / undiciFetch etc. */
const BARE_FETCH_CALL = /(?<![.\w$])fetch\s*\(/g;

describe('outbound fetch gate (UND_ERR_INVALID_ARG regression)', () => {
  it('imports fetch and ProxyAgent from the same npm undici version in main.js', () => {
    const source = fs.readFileSync(MAIN_JS, 'utf8');
    assert.match(
      source,
      /require\('undici'\)/,
      'main.js must import from npm undici (ProxyAgent from getFetchDispatcher and fetch must share origin)',
    );
    assert.match(
      source,
      /\{\s*fetch:\s*undiciFetch\s*,\s*ProxyAgent\s*\}\s*=\s*require\('undici'\)/,
      'main.js must destructure undiciFetch and ProxyAgent from the same version',
    );
  });

  it('does not make bare global fetch calls in main.js (routes via undiciFetch/net.fetch)', () => {
    const source = fs.readFileSync(MAIN_JS, 'utf8');
    const offending = [];
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      BARE_FETCH_CALL.lastIndex = 0;
      if (BARE_FETCH_CALL.test(line)) offending.push(`${index + 1}: ${line.trim()}`);
    });
    assert.deepEqual(
      offending,
      [],
      'Found bare global fetch calls in outbound requests (will conflict with undici@8 ProxyAgent handler protocol):\n' + offending.join('\n'),
    );
  });

  it('End-to-end shape: fetch and ProxyAgent from the same undici module reach the network layer', async () => {
    // Does not rely on external networks: ProxyAgent points to an unreachable address; when versions match,
    // errors should occur during dialing (ECONNREFUSED) rather than handler protocol validation (UND_ERR_INVALID_ARG).
    const { fetch: undiciFetch, ProxyAgent } = require('undici');
    const agent = new ProxyAgent('http://127.0.0.1:9');
    // Settle as data before asserting: assertion failures must never be swallowed by catch blocks handling request errors
    const outcome = await undiciFetch('https://localhost.invalid/', {
      dispatcher: agent,
      signal: AbortSignal.timeout(5000),
    }).then(
      (response) => ({ response }),
      (error) => ({ error }),
    );
    assert.ok(
      outcome.error,
      `Request must fail (unreachable target), but returned HTTP ${outcome.response?.status}`,
    );
    const causeCode = outcome.error && outcome.error.cause && outcome.error.cause.code;
    assert.notEqual(causeCode, 'UND_ERR_INVALID_ARG', 'undici fetch and ProxyAgent version mismatch');
  });
});
