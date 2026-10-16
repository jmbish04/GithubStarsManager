import { describe, it, expect } from 'vitest';
import {
  DEFAULT_XTWEET_FOLLOWS,
  normalizeXTweetFollows,
  normalizeXTweetHandleInput,
  normalizeXTweetAuth,
} from './xTweetFollows';

describe('normalizeXTweetHandleInput', () => {
  it('accepts @handle, bare handle, and x.com/twitter.com profile URLs', () => {
    expect(normalizeXTweetHandleInput('@geekbb')).toBe('geekbb');
    expect(normalizeXTweetHandleInput('geekbb')).toBe('geekbb');
    expect(normalizeXTweetHandleInput('https://x.com/geekbb')).toBe('geekbb');
    expect(normalizeXTweetHandleInput('https://twitter.com/geekbb')).toBe('geekbb');
    expect(normalizeXTweetHandleInput('https://x.com/geekbb?foo=1')).toBe('geekbb');
    expect(normalizeXTweetHandleInput('  @geekbb  ')).toBe('geekbb');
  });

  it('rejects empty input, oversized strings, and invalid characters', () => {
    expect(normalizeXTweetHandleInput('')).toBeNull();
    expect(normalizeXTweetHandleInput('   ')).toBeNull();
    expect(normalizeXTweetHandleInput('this-handle-is-way-too-long-for-x')).toBeNull();
    expect(normalizeXTweetHandleInput('bad handle!')).toBeNull();
    expect(normalizeXTweetHandleInput('https://example.com/geekbb')).toBeNull();
  });
});

describe('normalizeXTweetFollows', () => {
  it('falls back to default follows (geekbb) for non-array input', () => {
    expect(normalizeXTweetFollows(undefined)).toEqual(DEFAULT_XTWEET_FOLLOWS);
    expect(normalizeXTweetFollows('nope')).toEqual(DEFAULT_XTWEET_FOLLOWS);
  });

  it('preserves empty arrays when user clears all follows', () => {
    expect(normalizeXTweetFollows([])).toEqual([]);
  });

  it('removes invalid entries and deduplicates by handle (case-insensitive, keeping earliest added)', () => {
    const result = normalizeXTweetFollows([
      { handle: 'geekbb', addedAt: '2026-09-12T00:00:00.000Z' },
      { handle: '@GeekBB', addedAt: '2026-09-13T00:00:00.000Z' },
      { handle: 'not a handle!', addedAt: '2026-09-13T00:00:00.000Z' },
      { handle: 'ruanyf', addedAt: 'invalid-date' },
    ]);
    expect(result).toEqual([
      { handle: 'geekbb', addedAt: '2026-09-12T00:00:00.000Z' },
      { handle: 'ruanyf', addedAt: '1970-01-01T00:00:00.000Z' },
    ]);
  });
});

describe('normalizeXTweetAuth', () => {
  it('trims whitespace and stores pairs together; treats auth as unconfigured if either is empty', () => {
    expect(normalizeXTweetAuth({ authToken: '  abc  ', ct0: ' def ' })).toEqual({ authToken: 'abc', ct0: 'def' });
    expect(normalizeXTweetAuth({ authToken: 'abc', ct0: '' })).toBeNull();
    expect(normalizeXTweetAuth({ authToken: '', ct0: 'def' })).toBeNull();
    expect(normalizeXTweetAuth(null)).toBeNull();
    expect(normalizeXTweetAuth('junk')).toBeNull();
    expect(normalizeXTweetAuth({ authToken: 1, ct0: 2 })).toBeNull();
  });

  it('strips enclosing quotes; treats quote-only input as invalid and returns null', () => {
    expect(normalizeXTweetAuth({ authToken: '"my_token"', ct0: "'my_ct0'" })).toEqual({
      authToken: 'my_token',
      ct0: 'my_ct0',
    });
    expect(normalizeXTweetAuth({ authToken: '""', ct0: 'valid_ct0' })).toBeNull();
    expect(normalizeXTweetAuth({ authToken: 'valid_token', ct0: "''" })).toBeNull();
    expect(normalizeXTweetAuth({ authToken: '  "  "  ', ct0: 'valid_ct0' })).toBeNull();
  });
});
