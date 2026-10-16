import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * i18n migration safety net: solidifies pre-migration behavior into JSON fixtures.
 * Regenerate using UPDATE_I18N_FIXTURES=1; by default, performs strict comparison and fails on any byte-level difference.
 */
export const fixturePath = (importMetaUrl: string, relative: string): string =>
  path.join(path.dirname(fileURLToPath(importMetaUrl)), relative);

export const readFixture = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

export const writeFixture = (file: string, data: unknown): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};

export const shouldUpdateFixtures = (): boolean => process.env.UPDATE_I18N_FIXTURES === '1';
