
import { Category, CategoryMatchMode, Repository } from '../types';
import { builtinCategoryNameVariants, isBuiltinCategoryDisplayName } from '../constants/categoryI18n';

export type CategoryNameTranslator = (zh: string, en: string) => string;

export type CategoryNameValidation =
  | { value: string; error: null }
  | { value: null; error: string };

export const isReservedCategoryName = (name: string): boolean => name.trim().toLowerCase() === 'none';

export const validateCategoryName = (
  name: string,
  t: (key: string, params?: Record<string, unknown>) => string,
  emptyMessageKey: string = 'categoryUtils.empty-name'
): CategoryNameValidation => {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return { value: null, error: t(emptyMessageKey) };
  }
  if (isReservedCategoryName(trimmedName)) {
    return {
      value: null,
      error: t('categoryUtils.the-name-none-is-reserved-please-choose-another'),
    };
  }
  return { value: trimmedName, error: null };
};

/**
 * Normalizes an array of tags: trims whitespace and filters out empty items to prevent blank tags from matching arbitrary categories.
 */
const normalizeTags = (tags: string[] | undefined): string[] => {
  return (tags || []).map(tag => tag.trim()).filter(tag => tag.length > 0);
};

/**
 * Gets effective tags for category matching.
 * Priority matches card display: custom tags > AI tags > topics.
 * Explicitly cleared custom tags (empty array) are not considered a match and fall back to AI tags/topics.
 */
export const getEffectiveTags = (repo: Repository): string[] => {
  const customTags = normalizeTags(repo.custom_tags);
  if (customTags.length > 0) {
    return customTags;
  }
  const aiTags = normalizeTags(repo.ai_tags);
  if (aiTags.length > 0) {
    return aiTags;
  }
  return normalizeTags(repo.topics);
};

/**
 * Gets the AI-inferred category.
 * Matches category keywords against AI tags.
 */
export const getAICategory = (repo: Repository, allCategories: Category[]): string => {
  if (!repo.ai_tags || repo.ai_tags.length === 0) return '';

  for (const category of allCategories) {
    if (category.id === 'all') continue;

    const hasMatch = repo.ai_tags.some(tag =>
      category.keywords.some(keyword =>
        tag.toLowerCase().includes(keyword.toLowerCase())
      )
    );

    if (hasMatch) {
      return category.name;
    }
  }
  return '';
};

/**
 * Gets the default category (traditional matching based on repository info).
 */
export const getDefaultCategory = (repo: Repository, allCategories: Category[]): string => {
  for (const category of allCategories) {
    if (category.id === 'all') continue;

    const repoText = [
      repo.name,
      repo.description || '',
      repo.language || '',
      ...(repo.topics || []),
      repo.ai_summary || ''
    ].join(' ').toLowerCase();

    const hasMatch = category.keywords.some(keyword =>
      repoText.includes(keyword.toLowerCase())
    );

    if (hasMatch) {
      return category.name;
    }
  }
  return '';
};

/**
 * Computes the custom category value that should be saved.
 * Core logic: clear the custom category flag when the specified category matches the AI-inferred or default category.
 *
 * @param categoryName - Category name to set
 * @param aiCategory - AI-inferred category name
 * @param defaultCategory - Default matched category name
 * @returns Custom category value to save: undefined (clears custom tag), empty string (explicitly cleared), or category name
 */
export const computeCustomCategory = (
  categoryName: string,
  aiCategory: string | undefined,
  defaultCategory: string | undefined
): string | undefined => {
  // If the category is empty, save as empty string (explicitly cleared)
  if (categoryName === '') {
    return '';
  }
  // If identical to AI category, clear custom category (remove custom flag)
  if (categoryName === aiCategory) {
    return undefined;
  }
  // If identical to default category, clear custom category (remove custom flag)
  if (categoryName === defaultCategory) {
    return undefined;
  }
  // Otherwise save as custom category
  return categoryName;
};

/**
 * Normalizes category keywords: trims whitespace and filters empty strings to prevent blank keywords from matching any repository.
 */
const getCategoryKeywords = (category: Category): string[] => {
  return (category.keywords || []).map(k => k.trim()).filter(k => k.length > 0);
};

/**
 * Determines whether a given tag matches a category.
 * @param matchCategoryName - Whether to match against category name (enabled in 'effective' mode to ensure custom tags matching the category name match)
 */
const tagMatchesCategory = (
  tag: string,
  category: Category,
  matchCategoryName: boolean
): boolean => {
  const tagLower = tag.toLowerCase();
  const keywordMatch = getCategoryKeywords(category).some(keyword =>
    tagLower.includes(keyword.toLowerCase())
  );
  if (keywordMatch) return true;

  if (matchCategoryName) {
    const nameLower = category.name.toLowerCase();
    return nameLower === tagLower ||
      nameLower.includes(tagLower) ||
      tagLower.includes(nameLower);
  }

  return false;
};

export const matchesCategory = (
  repo: Repository,
  category: Category,
  mode: CategoryMatchMode = 'legacy'
): boolean => {
  if (category.id === 'all') return true;

  // Only locked manual categories (or explicitly cleared ones) participate in exact matching;
  // unlocked custom_category is populated by AI analysis and should be re-matched against tags.
  if (repo.custom_category === '') {
    return false;
  }
  if (repo.category_locked && repo.custom_category != null) {
    if (repo.custom_category === category.name) return true;
    // Builtin categories cross-locale: custom_category may be a historical display name locked in another locale
    if (!category.isCustom) {
      return builtinCategoryNameVariants(category.name).includes(repo.custom_category);
    }
    return false;
  }

  const tags = mode === 'effective' ? getEffectiveTags(repo) : normalizeTags(repo.ai_tags);
  if (tags.length > 0) {
    return tags.some(tag => tagMatchesCategory(tag, category, mode === 'effective' && !!category.isCustom));
  }

  const repoText = [
    repo.name,
    repo.description || '',
    repo.language || '',
    ...(repo.topics || []),
    repo.ai_summary || ''
  ].join(' ').toLowerCase();

  return getCategoryKeywords(category).some(keyword =>
    repoText.includes(keyword.toLowerCase())
  );
};

/**
 * Aggregates repository metadata text for custom category metadata fallback matching.
 * Consistent with matchesCategory's repoText fallback; matches repositories lacking AI tags or where tags don't cover keywords.
 */
const getRepoText = (repo: Pick<Repository, 'name' | 'description' | 'language' | 'topics' | 'ai_summary' | 'full_name'>): string => {
  return [
    repo.name,
    repo.full_name,
    repo.description || '',
    repo.language || '',
    ...(repo.topics || []),
    repo.ai_summary || '',
  ].join(' ').toLowerCase();
};

/**
 * Builds custom category keyword hint lines for AI prompts.
 * Format: `skills（Skills,skills）\ncli-tools（cli,CLI）`
 * Allows the model to recognize custom categories even when a repository has no topics.
 */
export const buildCategoryHints = (customCategories: Category[]): string => {
  const lines = customCategories
    .filter(category => category.id !== 'all' && category.isCustom)
    .map(category => {
      const keywords = getCategoryKeywords(category);
      const kwText = keywords.length > 0 ? keywords.join(',') : `(no keywords, match by name: ${category.name})`;
      return `${category.name}（${kwText}）`;
    });
  return lines.join('\n');
};

/**
 * Matches custom categories against repository metadata (name/description/language/topics/AI summary).
 * Applies only to custom categories; returns immediately when keywords match.
 * Falls back to category name containment matching when keywords are empty.
 */
const matchCustomCategoryByMetadata = (
  customCategories: Category[],
  repository: Pick<Repository, 'name' | 'description' | 'language' | 'topics' | 'ai_summary' | 'full_name'>
): Category | undefined => {
  if (customCategories.length === 0) return undefined;
  const repoText = getRepoText(repository);
  return customCategories.find(category => {
    const keywords = getCategoryKeywords(category);
    const keywordMatch = keywords.length > 0 && keywords.some(keyword => repoText.includes(keyword.toLowerCase()));
    // Fall back to category name substring match only when there are no valid keywords, preserving existing semantics
    const nameFallback = keywordMatch === false && keywords.length === 0 && repoText.includes(category.name.toLowerCase());
    return keywordMatch || nameFallback;
  });
};

export const resolveCategoryAssignment = (
  repository: Repository,
  aiTags: string[] | undefined,
  allCategories: Category[]
): string | undefined => {
  // Validate whether the category is still valid (exists in the current category list)
  const isValidCategory = (name: string | undefined): boolean => {
    if (!name) return false;
    if (allCategories.some(cat => cat.name === name)) return true;
    // Historical localized display names for builtin categories are still valid (preserving cross-language lock)
    return isBuiltinCategoryDisplayName(name);
  };

  // If the category is locked and the custom category is still valid, retain current category
  if (repository.category_locked && isValidCategory(repository.custom_category)) {
    return repository.custom_category;
  }

  // Preserve explicitly cleared category assignment (''), preventing overwrite by AI analysis
  if (repository.custom_category === '') {
    return repository.custom_category;
  }

  const normalizedTags = Array.isArray(aiTags) ? normalizeTags(aiTags) : [];

  const customCategories = allCategories.filter(category => category.id !== 'all' && category.isCustom);
  const defaultCategories = allCategories.filter(category => category.id !== 'all' && !category.isCustom);

  // When there are no AI tags: fall back to repository metadata matching for custom categories
  if (normalizedTags.length === 0) {
    const customMetaMatch = matchCustomCategoryByMetadata(customCategories, repository);
    if (customMetaMatch) return customMetaMatch.name;
    // If there are no AI tags, but category is locked and custom category is valid, retain current category
    return (repository.category_locked && isValidCategory(repository.custom_category))
      ? repository.custom_category
      : undefined;
  }

  const matchCustomCategory = (categories: Category[]) => categories.find(category => {
    const keywords = getCategoryKeywords(category);
    return normalizedTags.some(tag =>
      category.name.toLowerCase() === tag.toLowerCase() ||
      category.name.toLowerCase().includes(tag.toLowerCase()) ||
      tag.toLowerCase().includes(category.name.toLowerCase()) ||
      keywords.some(keyword =>
        tag.toLowerCase().includes(keyword.toLowerCase())
      )
    );
  });

  const matchDefaultCategory = (categories: Category[]) => categories.find(category => {
    const keywords = getCategoryKeywords(category);
    return normalizedTags.some(tag =>
      category.name.toLowerCase() === tag.toLowerCase() ||
      keywords.some(keyword =>
        tag.toLowerCase().includes(keyword.toLowerCase())
      )
    );
  });

  const customMatch = matchCustomCategory(customCategories);
  if (customMatch) return customMatch.name;

  // Metadata fallback: when AI tags do not directly match custom categories, match custom categories using repo metadata
  // (Custom categories take priority over default categories)
  const customMetaMatch = matchCustomCategoryByMetadata(customCategories, repository);
  if (customMetaMatch) return customMetaMatch.name;

  const defaultMatch = matchDefaultCategory(defaultCategories);
  if (defaultMatch) return undefined;

  // If no category matched, but category is locked and custom category is valid, retain current category
  return (repository.category_locked && isValidCategory(repository.custom_category))
    ? repository.custom_category
    : undefined;
};
