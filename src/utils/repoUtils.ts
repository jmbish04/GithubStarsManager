import { Repository, Category } from '../types';
import { getAICategory, getDefaultCategory } from './categoryUtils';

/**
 * Determines whether a repository has been customized by the user.
 * Matches edit page logic: modification of description, tags, or category is treated as edited.
 * Note: Category lock does not count as edited.
 */
export function isRepoCustomized(repo: Repository, allCategories: Category[]): boolean {
  // Description: has custom description flag (including explicit clear) and content differs from AI/original
  const hasCustomDesc = repo.custom_description !== undefined;
  const repoDesc = (repo.description || '').trim();
  const aiDesc = (repo.ai_summary || '').trim();
  const customDesc = (repo.custom_description || '').trim();
  const isDescEdited = hasCustomDesc &&
    (customDesc === '' || (customDesc !== repoDesc && customDesc !== aiDesc));

  // Tags: has custom tags flag (including explicit clear) and content differs from AI/Topics
  const hasCustomTags = repo.custom_tags !== undefined;
  const aiTags = repo.ai_tags || [];
  const topics = repo.topics || [];
  const customTags = repo.custom_tags || [];
  const isTagsEdited = hasCustomTags &&
    (customTags.length === 0 || (
      JSON.stringify([...customTags].sort()) !== JSON.stringify([...aiTags].sort()) &&
      JSON.stringify([...customTags].sort()) !== JSON.stringify([...topics].sort())
    ));

  // Category: has custom category flag (including explicit clear) and differs from AI/default
  const aiCat = getAICategory(repo, allCategories);
  const defaultCat = getDefaultCategory(repo, allCategories);
  const customCat = repo.custom_category;
  const isCategoryEdited = customCat !== undefined &&
    (customCat === '' || (customCat !== aiCat && customCat !== defaultCat));

  return isDescEdited || isTagsEdited || isCategoryEdited;
}
