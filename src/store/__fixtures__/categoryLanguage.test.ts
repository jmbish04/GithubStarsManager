import { describe, expect, it } from 'vitest';
import type { Category, Repository } from '../../types';
import { defaultCategories } from '../schema';
import { getAllCategories, getCategoryNameVariants, translateCategoryName } from '../helpers/categoryHelpers';
import { computeCustomCategory, matchesCategory, resolveCategoryAssignment } from '../../utils/categoryUtils';
import { fixturePath, readFixture, shouldUpdateFixtures, writeFixture } from '../../test/fixtureIo';

/**
 * i18n migration safety net: solidifies built-in category display names, variant sets,
 * and category matching behavior under language=zh/en.
 * After migration, the zh/en columns must match value-for-value; the locked category
 * cross-language matching baseline records the current status (switching languages loses category),
 * which is **intentionally updated** as behavior improves when variant matching is introduced.
 * Regenerate: UPDATE_I18N_FIXTURES=1 npx vitest run src/store/__fixtures__/categoryLanguage.test.ts
 */
const FIXTURE_FILE = fixturePath(import.meta.url, 'category-language.snapshot.json');

const makeRepo = (partial: Partial<Repository>): Repository => ({
  id: 1,
  name: 'sample-app',
  full_name: 'acme/sample-app',
  description: 'A sample repository',
  html_url: 'https://github.com/acme/sample-app',
  stargazers_count: 1,
  forks_count: 0,
  forks: 0,
  language: 'TypeScript',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-06-01T00:00:00Z',
  pushed_at: '2024-06-01T00:00:00Z',
  owner: { login: 'acme', avatar_url: '' },
  topics: [],
  ...partial,
}) as Repository;

const categoryIn = (language: 'zh' | 'en', id: string): Category => {
  const found = getAllCategories([], language).find((category) => category.id === id);
  if (!found) throw new Error(`category ${id} not found`);
  return found;
};

const customDeploymentCategory: Category = {
  id: 'custom-deploy',
  name: '\u90e8\u7f72', // Chinese for "deploy"
  icon: '🚀',
  keywords: ['deploy', '\u90e8\u7f72'], // Chinese for "deploy"
  isCustom: true,
};

const buildSnapshot = () => {
  const zhNames = getAllCategories([], 'zh').map((category) => category.name);
  const zhCategories = getAllCategories([], 'zh');
  const enCategories = getAllCategories([], 'en');
  const catsWithCustom = [...zhCategories, customDeploymentCategory];

  return {
    defaultCategoryIds: defaultCategories.map((category) => category.id),
    getAllCategories: {
      zh: zhCategories,
      en: enCategories,
    },
    translateCategoryName: {
      inputs: zhNames,
      outputs: zhNames.map((name) => translateCategoryName(name)),
    },
    categoryNameVariants: {
      devtools: getCategoryNameVariants('\u5f00\u53d1\u5de5\u5177'), // Chinese for "Development Tools"
      web: getCategoryNameVariants('Web\u5e94\u7528'), // Chinese for "Web Apps"
      untouchedCustomName: getCategoryNameVariants('My Tools'),
      withOverride: getCategoryNameVariants('\u5f00\u53d1\u5de5\u5177', 'My Tools'), // Chinese for "Development Tools"
    },
    matchesCategory: {
      lockedZhName_vs_zhWeb: matchesCategory(makeRepo({ custom_category: 'Web\u5e94\u7528', category_locked: true }), categoryIn('zh', 'web'), 'effective'), // Chinese for "Web Apps"
      lockedZhName_vs_enWeb: matchesCategory(makeRepo({ custom_category: 'Web\u5e94\u7528', category_locked: true }), categoryIn('en', 'web'), 'effective'), // Chinese for "Web Apps"
      lockedEnName_vs_enWeb: matchesCategory(makeRepo({ custom_category: 'Web Apps', category_locked: true }), categoryIn('en', 'web'), 'effective'),
      lockedEnName_vs_zhWeb: matchesCategory(makeRepo({ custom_category: 'Web Apps', category_locked: true }), categoryIn('zh', 'web'), 'effective'),
      lockedCustomExactName: matchesCategory(makeRepo({ custom_category: 'My Tools', category_locked: true }), { id: 'c1', name: 'My Tools', icon: 'x', keywords: [], isCustom: true }, 'effective'),
      emptyCustomCategory_vs_zhWeb: matchesCategory(makeRepo({ custom_category: '', category_locked: true }), categoryIn('zh', 'web'), 'effective'),
      zhAiTags_vs_zhDevtools: matchesCategory(makeRepo({ ai_tags: ['\u5f00\u53d1\u5de5\u5177', 'cli'] }), categoryIn('zh', 'devtools')), // Chinese for "Development Tools"
      enAiTags_vs_enDevtools: matchesCategory(makeRepo({ ai_tags: ['development tools'] }), categoryIn('en', 'devtools')),
      enAiTags_vs_zhDevtools: matchesCategory(makeRepo({ ai_tags: ['development tools'] }), categoryIn('zh', 'devtools')),
      effectiveCustomTagsBeatAiTags: matchesCategory(makeRepo({ custom_tags: ['database'], ai_tags: ['game'] }), categoryIn('zh', 'database'), 'effective'),
      repoTextFallback_vs_enDesktop: matchesCategory(makeRepo({ ai_tags: [], description: 'A desktop app built with electron' }), categoryIn('en', 'desktop')),
    },
    resolveCategoryAssignment: {
      zhDefaultHit_returnsUndefined: resolveCategoryAssignment(makeRepo({ ai_tags: ['\u5f00\u53d1\u5de5\u5177', 'cli'] }), ['\u5f00\u53d1\u5de5\u5177', 'cli'], zhCategories), // Chinese for "Development Tools"
      enDefaultHit_returnsUndefined: resolveCategoryAssignment(makeRepo({ ai_tags: ['development tools'] }), ['development tools'], enCategories),
      customHit_returnsName: resolveCategoryAssignment(makeRepo({ ai_tags: ['deploy'] }), ['deploy'], catsWithCustom),
      lockedKept_whenValid: resolveCategoryAssignment(makeRepo({ ai_tags: ['game'], custom_category: '\u90e8\u7f72', category_locked: true }), ['game'], catsWithCustom), // Chinese for "deploy"
      emptyCleared_kept: resolveCategoryAssignment(makeRepo({ ai_tags: ['game'], custom_category: '' }), ['game'], zhCategories),
      noMatch_returnsUndefined: resolveCategoryAssignment(makeRepo({ ai_tags: ['zzzunmatched'] }), ['zzzunmatched'], zhCategories),
    },
    computeCustomCategory: {
      empty: computeCustomCategory('', 'Web\u5e94\u7528', 'Web\u5e94\u7528'), // Chinese for "Web Apps"
      equalsAiCategory: computeCustomCategory('Web\u5e94\u7528', 'Web\u5e94\u7528', undefined), // Chinese for "Web Apps"
      equalsDefaultCategory: computeCustomCategory('Web\u5e94\u7528', undefined, 'Web\u5e94\u7528'), // Chinese for "Web Apps"
      otherwise: computeCustomCategory('My Tools', 'Web\u5e94\u7528', 'Web\u5e94\u7528'), // Chinese for "Web Apps"
    },
  };
};

describe('built-in category language behavior fixture (zh/en baseline)', () => {
  it('matches the frozen category fixture', () => {
    const snapshot = buildSnapshot();
    if (shouldUpdateFixtures()) {
      writeFixture(FIXTURE_FILE, snapshot);
      return;
    }
    expect(snapshot).toEqual(readFixture(FIXTURE_FILE));
  });
});
