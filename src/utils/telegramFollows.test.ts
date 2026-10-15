import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TELEGRAM_FOLLOWS,
  normalizeTelegramChannelInput,
  normalizeTelegramFollows,
} from './telegramFollows';

describe('normalizeTelegramChannelInput', () => {
  it('accepts t.me channel links (including public preview /s/, message IDs, and query params)', () => {
    expect(normalizeTelegramChannelInput('https://t.me/geekhub23')).toBe('geekhub23');
    expect(normalizeTelegramChannelInput('https://t.me/s/geekhub23')).toBe('geekhub23');
    expect(normalizeTelegramChannelInput('https://t.me/geekhub23/589')).toBe('geekhub23');
    expect(normalizeTelegramChannelInput('https://t.me/geekhub23?before=589')).toBe('geekhub23');
    expect(normalizeTelegramChannelInput('http://www.t.me/geekhub23')).toBe('geekhub23');
  });

  it('accepts @channel and bare channel names', () => {
    expect(normalizeTelegramChannelInput('@geekhub23')).toBe('geekhub23');
    expect(normalizeTelegramChannelInput('geekhub23')).toBe('geekhub23');
    expect(normalizeTelegramChannelInput('  geekhub23  ')).toBe('geekhub23');
  });

  it('rejects invalid input', () => {
    expect(normalizeTelegramChannelInput('')).toBeNull();
    expect(normalizeTelegramChannelInput('   ')).toBeNull();
    expect(normalizeTelegramChannelInput('ab')).toBeNull();
    expect(normalizeTelegramChannelInput('bad name!')).toBeNull();
    expect(normalizeTelegramChannelInput('https://x.com/geekbb')).toBeNull();
    expect(normalizeTelegramChannelInput('https://t.me/')).toBeNull();
  });
});

describe('normalizeTelegramFollows', () => {
  it('defaults to following geekhub23 (users can remove/add)', () => {
    expect(DEFAULT_TELEGRAM_FOLLOWS).toEqual([
      { channel: 'geekhub23', addedAt: expect.any(String) },
    ]);
    expect(normalizeTelegramFollows(undefined)).toEqual(DEFAULT_TELEGRAM_FOLLOWS);
  });

  it('deduplicates case-insensitively and preserves the earliest added record', () => {
    const result = normalizeTelegramFollows([
      { channel: 'GeekHub23', addedAt: '2026-09-13T02:00:00.000Z' },
      { channel: 'geekhub23', addedAt: '2026-09-13T01:00:00.000Z' },
      { channel: 'https://t.me/geekhub23', addedAt: '2026-09-13T03:00:00.000Z' },
    ]);
    expect(result).toEqual([{ channel: 'geekhub23', addedAt: '2026-09-13T01:00:00.000Z' }]);
  });

  it('discards invalid entries and falls back to unix epoch when addedAt is missing or invalid', () => {
    const result = normalizeTelegramFollows([
      { channel: 'goodname', addedAt: 'not-a-date' },
      { channel: 'bad name!', addedAt: '2026-09-13T00:00:00.000Z' },
      { channel: 'goodname2' },
    ]);
    expect(result).toEqual([
      { channel: 'goodname', addedAt: '1970-01-01T00:00:00.000Z' },
      { channel: 'goodname2', addedAt: '1970-01-01T00:00:00.000Z' },
    ]);
  });
});
