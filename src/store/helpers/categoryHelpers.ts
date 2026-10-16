
import type { AppLanguage } from '../../i18n/languages';
import type { Category } from '../../types';
import { builtinCategoryNameVariants, categoryExtraKeywords, categoryName } from '../../constants/categoryI18n';
import { defaultCategories } from '../schema';

export const sortCategoriesByOrder = (
  categories: Category[],
  categoryOrder: string[]
): Category[] => {
  if (!categoryOrder || categoryOrder.length === 0) {
    return categories;
  }

  const orderMap = new Map(categoryOrder.map((id, index) => [id, index]));

  return [...categories].sort((a, b) => {
    const orderA = orderMap.get(a.id);
    const orderB = orderMap.get(b.id);

    // If both have an order, sort by order
    if (orderA !== undefined && orderB !== undefined) {
      return orderA - orderB;
    }
    // If only a has an order, a comes first
    if (orderA !== undefined) return -1;
    // If only b has an order, b comes first
    if (orderB !== undefined) return 1;
    // If neither has an order, keep original order
    return 0;
  });
};

// Helper function to get all categories (default + custom)
export const getAllCategories = (
  customCategories: Category[],
  language: AppLanguage = 'zh',
  hiddenDefaultCategoryIds: string[] = [],
  defaultCategoryOverrides: Record<string, Partial<Category>> = {}
): Category[] => {
  const translatedDefaults = defaultCategories
    .filter(cat => !hiddenDefaultCategoryIds.includes(cat.id))
    .map(cat => {
      const override = defaultCategoryOverrides[cat.id];
      const baseName = language === 'zh' ? cat.name : categoryName(cat.id, language);
      const baseKeywords = [...(cat.keywords ?? []), ...categoryExtraKeywords(cat.id, language)];
      return {
        ...cat,
        name: baseName,
        keywords: baseKeywords,
        ...(override ? { name: override.name ?? baseName, icon: override.icon ?? cat.icon, keywords: override.keywords ?? baseKeywords } : {})
      };
    });

  return [...translatedDefaults, ...customCategories];
};

// Helper function to translate category names
export const translateCategoryName = (zhName: string): string => {
  const translations: Record<string, string> = {
    '\u5168\u90e8\u5206\u7c7b': 'All Categories', // Chinese for "All Categories"
    'Web\u5e94\u7528': 'Web Apps', // Chinese for "Web Apps"
    '\u79fb\u52a8\u5e94\u7528': 'Mobile Apps', // Chinese for "Mobile Apps"
    '\u684c\u9762\u5e94\u7528': 'Desktop Apps', // Chinese for "Desktop Apps"
    '\u6570\u636e\u5e93': 'Database', // Chinese for "Database"
    'AI/\u673a\u5668\u5b66\u4e60': 'AI/Machine Learning', // Chinese for "AI/Machine Learning"
    '\u5f00\u53d1\u5de5\u5177': 'Development Tools', // Chinese for "Development Tools"
    '\u5b89\u5168\u5de5\u5177': 'Security Tools', // Chinese for "Security Tools"
    '\u6e38\u620f': 'Games', // Chinese for "Games"
    '\u8bbe\u8ba1\u5de5\u5177': 'Design Tools', // Chinese for "Design Tools"
    '\u6548\u7387\u5de5\u5177': 'Productivity Tools', // Chinese for "Productivity Tools"
    '\u6559\u80b2\u5b66\u4e60': 'Education', // Chinese for "Education"
    '\u793e\u4ea4\u7f51\u7edc': 'Social Network', // Chinese for "Social Network"
    '\u6570\u636e\u5206\u6790': 'Data Analytics' // Chinese for "Data Analytics"
  };

  return translations[zhName] || zhName;
};

// Helper function to get all possible name variants for a category (original + translated)
export const getCategoryNameVariants = (originalName: string, overrideName?: string): string[] => {
  const variants = new Set<string>([originalName]);

  // Built-in categories: include display names in all languages (GitHub List names automatically rename on language switch)
  const builtinVariants = builtinCategoryNameVariants(originalName, overrideName);
  for (const variant of builtinVariants) {
    variants.add(variant);
  }

  // Add override name if provided and different
  if (overrideName && overrideName !== originalName) {
    variants.add(overrideName);
  }

  return Array.from(variants);
};
