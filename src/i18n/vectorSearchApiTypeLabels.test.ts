import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_LANGUAGES } from './languages';
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  EMBEDDING_API_TYPES,
  embeddingApiTypeLabelKey,
} from '../constants/embeddingApiTypes';

/**
 * Settings page "Model provider" button labels use dynamic keys (`vectorSearchSettings.api-type-*`).
 * scripts/check-i18n.cjs only validates literal t('key') calls, so template keys are not covered.
 * This test provides that safeguard: if any language is missing a translation, raw keys would be exposed,
 * and newly added providers are caught here as well.
 */
const localesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'locales');

const loadLabelStrings = (language: string): Record<string, unknown> => {
  const content = JSON.parse(
    readFileSync(path.join(localesDir, language, 'app.json'), 'utf8'),
  ) as { vectorSearchSettings?: Record<string, unknown> };
  return content.vectorSearchSettings ?? {};
};

const localLabelKey = (apiType: (typeof EMBEDDING_API_TYPES)[number]): string =>
  embeddingApiTypeLabelKey(apiType).replace(/^vectorSearchSettings\./, '');

describe('vector search model provider label coverage', () => {
  it.each(APP_LANGUAGES)('$code covers all EmbeddingApiTypes and is not a raw key', (language) => {
    const strings = loadLabelStrings(language.code);
    const missing = EMBEDDING_API_TYPES.map(localLabelKey).filter(
      (key) => typeof strings[key] !== 'string' || (strings[key] as string).trim() === '',
    );
    expect(missing).toEqual([]);
    const rawKeyValues = EMBEDDING_API_TYPES.map(localLabelKey).filter(
      (key) => strings[key] === `vectorSearchSettings.${key}`,
    );
    expect(rawKeyValues).toEqual([]);
  });

  it('has no duplicate providers and maps 1:1 with the default dimensions table', () => {
    expect([...EMBEDDING_API_TYPES].sort()).toEqual(
      Object.keys(DEFAULT_EMBEDDING_DIMENSIONS).sort(),
    );
    expect(new Set(EMBEDDING_API_TYPES).size).toBe(EMBEDDING_API_TYPES.length);
  });
});
