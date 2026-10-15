/**
 * Pure utilities for X tweet channel follow configuration: default follows and input normalization.
 * Shared between store (hydration/migration) and settings modals without depending on React or Store.
 */

import type { XTweetAuth, XTweetFollow } from '../types';

/** Initial follow list (users can remove or append items). */
export const DEFAULT_XTWEET_FOLLOWS: XTweetFollow[] = [
  { handle: 'geekbb', addedAt: '2026-09-12T00:00:00.000Z' },
];

/** X handle semantics: 1-15 alphanumeric characters or underscores (leniently allowing transitional formats). */
const HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

/**
 * Normalizes user input into a handle (without '@'). Accepts three formats:
 * `@handle`, bare `handle`, and `https://x.com/handle` (including /twitter.com/, trailing paths, and query parameters).
 * Returns null if unrecognized.
 */
export const normalizeXTweetHandleInput = (input: string): string | null => {
  const raw = input.trim();
  if (!raw) return null;

  let candidate = raw;
  const urlMatch = raw.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:[/?#].*)?$/i);
  if (urlMatch) {
    candidate = urlMatch[1];
  } else {
    candidate = raw.replace(/^@+/, '');
  }

  return HANDLE_PATTERN.test(candidate) ? candidate : null;
};

/** Sort comparator: preserves earliest added record when deduplicating by handle (compares actual timestamps, accommodating +08:00 and other offsets). */
const byAddedAtAsc = (a: XTweetFollow, b: XTweetFollow) => Date.parse(a.addedAt) - Date.parse(b.addedAt);

/** Sanitizes persisted or external follow lists: deduplicates (case-insensitive handle) and removes invalid items. */
export const normalizeXTweetFollows = (value: unknown): XTweetFollow[] => {
  if (!Array.isArray(value)) return DEFAULT_XTWEET_FOLLOWS.map((follow) => ({ ...follow }));

  const byKey = new Map<string, XTweetFollow>();
  for (const item of value) {
    const handle = typeof (item as { handle?: unknown })?.handle === 'string'
      ? normalizeXTweetHandleInput((item as { handle: string }).handle)
      : null;
    if (!handle) continue;
    const addedAt = typeof (item as { addedAt?: unknown })?.addedAt === 'string'
      && Number.isFinite(Date.parse((item as { addedAt: string }).addedAt))
      ? (item as { addedAt: string }).addedAt
      : '1970-01-01T00:00:00.000Z';
    const key = handle.toLowerCase();
    const existing = byKey.get(key);
    if (!existing || byAddedAtAsc({ handle, addedAt }, existing) < 0) {
      byKey.set(key, { handle, addedAt });
    }
  }
  return [...byKey.values()];
};

/**
 * Sanitizes auth cookies: trims whitespace and surrounding quotes (such as quotes copied directly from JSON strings).
 * If either field is empty after sanitization, the auth object is treated as unconfigured (null).
 * Cookie values themselves are not filtered for specific formats (validated by x.com); invalid values report "authentication failed" during sync.
 */
export const normalizeXTweetAuth = (value: unknown): XTweetAuth | null => {
  if (!value || typeof value !== 'object') return null;
  const cleanField = (val: unknown): string => {
    if (typeof val !== 'string') return '';
    return val.trim().replace(/^["']|["']$/g, '').trim();
  };
  const authToken = cleanField((value as { authToken?: unknown }).authToken);
  const ct0 = cleanField((value as { ct0?: unknown }).ct0);
  if (!authToken || !ct0) return null;
  return { authToken, ct0 };
};
