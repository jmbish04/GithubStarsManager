import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_LANGUAGES } from './languages';

/**
 * Translation key set consistency check: built-in languages must strictly match the en key set.
 * Missing keys expose raw keys or fall back to English; orphaned keys indicate renamed keys not cleaned up in source dictionaries.
 * Whether values are translated individually is checked by scripts/check-i18n.cjs on PR diffs.
 */
const localesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'locales');

const collectKeys = (value: unknown, prefix = ''): string[] => {
  if (value === null || typeof value !== 'object') return prefix ? [prefix] : [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    collectKeys(child, prefix ? `${prefix}.${key}` : key),
  );
};

const loadLanguageKeys = (): Record<string, Set<string>> => {
  const result: Record<string, Set<string>> = {};
  for (const language of APP_LANGUAGES) {
    const dir = path.join(localesDir, language.code);
    const keys = new Set<string>();
    if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.json')) continue;
        const namespace = file.replace(/\.json$/, '');
        const content = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as Record<string, unknown>;
        for (const key of collectKeys(content)) keys.add(`${namespace}:${key}`);
      }
    }
    result[language.code] = keys;
  }
  return result;
};

describe('i18n dictionary key set consistency', () => {
  const keys = loadLanguageKeys();

  it.each(APP_LANGUAGES)('strictly matches the en key set for $code', (language) => {
    const enKeys = [...keys.en].sort();
    const current = [...keys[language.code]].sort();
    expect(current).toEqual(enKeys);
  });
});
