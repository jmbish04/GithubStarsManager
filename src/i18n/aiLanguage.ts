import { FALLBACK_LANGUAGE, isAppLanguage, languageDefinition, type AppLanguage } from './languages';

/**
 * AI prompt language policy (business constraint: AI generated content matches the user's UI language setting).
 *
 * - zh always uses the zh template; all other languages use the en template: zh/en prompt bytes remain identical,
 *   so new languages behave identically to today's en users (locked by fixture snapshots).
 * - Generative prompts (repo analysis/Gist/Release/repo chat responses) append an output language directive
 *   in non-zh/en languages so AI output follows the UI language.
 * - Internal retrieval and structured prompts like HyDE/rerank/featured search/tool loops do not inject directives—
 *   enforcing a target language would alter embedding queries and search ranking behavior.
 */
export type PromptTemplateLanguage = 'zh' | 'en';

export const resolvePromptTemplateLang = (language: AppLanguage | string): PromptTemplateLanguage =>
  language === 'zh' ? 'zh' : 'en';

/** Output language directive for user-facing content; returns empty string for zh/en (keeps existing prompts byte-for-byte identical). */
export const getOutputLanguageDirective = (language: AppLanguage | string): string => {
  // Normalize first: aiService language is a freeform string; invalid values (e.g. legacy data) fall back to English
  const normalized = isAppLanguage(language) ? language : FALLBACK_LANGUAGE;
  if (normalized === 'zh' || normalized === 'en') return '';
  const definition = languageDefinition(normalized);
  return `IMPORTANT: Write ALL user-facing output in ${definition.englishName} (${definition.nativeName}). Keep code, identifiers, and technical terms in their original form.`;
};
