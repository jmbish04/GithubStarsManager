/**
 * Pure utilities for Telegram channel follow configurations: default follows and input normalization.
 * Shared between the store (hydration/migrate) and the settings modal, without depending on React or the store.
 */

import type { TelegramFollow } from '../types';

/** Default follow list (users can delete/add) */
export const DEFAULT_TELEGRAM_FOLLOWS: TelegramFollow[] = [
  { channel: 'geekhub23', addedAt: '2026-09-13T00:00:00.000Z' },
];

/**
 * Permissive semantics for Telegram channel usernames: 3-64 alphanumeric characters or underscores.
 * The public preview page t.me/s/<name> is the sole source of truth; this is relaxed here to avoid false rejections,
 * while invalid names will error during the fetch stage.
 */
const CHANNEL_PATTERN = /^[A-Za-z0-9_]{3,64}$/;

/**
 * Normalizes user input into a channel name (without @). Accepts multiple formats:
 * `@name`, bare `name`, `https://t.me/name` (including /s/name preview links, trailing message IDs,
 * and query parameters). Returns null if unrecognized.
 */
export const normalizeTelegramChannelInput = (input: string): string | null => {
  const raw = input.trim();
  if (!raw) return null;

  let candidate = raw;
  const urlMatch = raw.match(/^https?:\/\/(?:www\.)?t\.me\/(?:s\/)?([A-Za-z0-9_]+)(?:[/?#].*)?$/i);
  if (urlMatch) {
    candidate = urlMatch[1];
  } else {
    candidate = raw.replace(/^@+/, '');
  }

  return CHANNEL_PATTERN.test(candidate) ? candidate : null;
};

/** Sort key: retains the earliest-added record when deduplicating by channel name (compares real timestamps, supporting offsets like +08:00) */
const byAddedAtAsc = (a: TelegramFollow, b: TelegramFollow) => Date.parse(a.addedAt) - Date.parse(b.addedAt);

/** Cleans up persisted or external follow lists: deduplicates (case-insensitively) and discards invalid entries. */
export const normalizeTelegramFollows = (value: unknown): TelegramFollow[] => {
  if (!Array.isArray(value)) return DEFAULT_TELEGRAM_FOLLOWS.map((follow) => ({ ...follow }));

  const byKey = new Map<string, TelegramFollow>();
  for (const item of value) {
    const channel = typeof (item as { channel?: unknown })?.channel === 'string'
      ? normalizeTelegramChannelInput((item as { channel: string }).channel)
      : null;
    if (!channel) continue;
    const addedAt = typeof (item as { addedAt?: unknown })?.addedAt === 'string'
      && Number.isFinite(Date.parse((item as { addedAt: string }).addedAt))
      ? (item as { addedAt: string }).addedAt
      : '1970-01-01T00:00:00.000Z';
    const key = channel.toLowerCase();
    const existing = byKey.get(key);
    if (!existing || byAddedAtAsc({ channel, addedAt }, existing) < 0) {
      byKey.set(key, { channel, addedAt });
    }
  }
  return [...byKey.values()];
};
