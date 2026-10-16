import type { AppLanguage } from '../i18n/languages';

/**
 * Lightweight heuristic check for whether text is likely already in the target language.
 *
 * Runs a rough check before automatically translating repository descriptions: obviously same-language
 * text is skipped directly, avoiding redundant translation requests across entire pages of cards
 * (especially since AI translation engines bill per quota). Only inspects writing systems
 * and common stop words; does not attempt to be exact:
 * - False negatives ("different language") only cost one harmless translation request.
 * - False positives ("same language") primarily occur when Romance/Germanic stop words tie,
 *   falling back to English (technical descriptions are predominantly English), which merely skips
 *   translating an edge case.
 */
const countMatches = (text: string, pattern: RegExp): number =>
  (text.match(pattern) ?? []).length;

// Character ranges for major writing systems (covering extended ranges).
const HAN_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;
const KANA_PATTERN = /[\u3040-\u309F\u30A0-\u30FF\u31F0-\u31FF]/g;
const HANGUL_PATTERN = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/g;
const CYRILLIC_PATTERN = /[\u0400-\u04FF]/g;
// Latin letters: basic range + extended ranges (accented letters in French, German, Spanish, Portuguese).
const LATIN_PATTERN = /[A-Za-z\u00C0-\u024F]/g;
// Latin extended range (Polish, Czech, Turkish, Vietnamese, etc.): not used by any of the 5 supported Latin languages.
const LATIN_EXTENDED_PATTERN = /[\u0100-\u024F\u1E00-\u1EFF]/g;
// Accented Latin characters (including French Œ/œ ligatures): never used in English, used in French, German, Spanish, and Portuguese.
const ACCENTED_LATIN_PATTERN = /[\u00C0-\u00FF\u0152\u0153]/g;

// Common stop words across Latin languages (whole-word matching). French, German, Spanish, Portuguese,
// and English stop words overlap heavily (de/la/in etc. are shared); only credited when one language
// strictly wins, falling back to English on ties.
const LATIN_STOPWORD_PATTERNS: Array<{ lang: 'en' | 'fr' | 'de' | 'es' | 'pt-BR'; pattern: RegExp }> = [
  { lang: 'en', pattern: /\b(?:the|and|for|with|your|from|this|that|are|into|not|you|can|will)\b/gi },
  { lang: 'fr', pattern: /\b(?:les|des|une|pour|avec|dans|est|sur|aux|cette|votre|sont)\b/gi },
  { lang: 'de', pattern: /\b(?:der|die|das|und|für|mit|von|den|dem|ein|eine|ist|sich|auf)\b/gi },
  { lang: 'es', pattern: /\b(?:los|las|una|del|que|más|como|pero|sus|son|este)\b/gi },
  { lang: 'pt-BR', pattern: /\b(?:dos|das|uma|não|você|vocês|então|também|pelo|pelos|são)\b/gi },
];

/**
 * Determines whether text is "likely" already in the target language (true = skip translation).
 * Any complex or indeterminate scenario returns false to delegate to the translation engine.
 */
export const isLikelySameLanguage = (text: string, target: AppLanguage): boolean => {
  const trimmed = text.trim();
  if (!trimmed) return true;

  const han = countMatches(trimmed, HAN_PATTERN);
  const kana = countMatches(trimmed, KANA_PATTERN);
  const hangul = countMatches(trimmed, HANGUL_PATTERN);
  const cyrillic = countMatches(trimmed, CYRILLIC_PATTERN);
  const latin = countMatches(trimmed, LATIN_PATTERN);
  const nonLatin = han + kana + hangul + cyrillic;

  // CJK / Cyrillic target languages are judged by dominant writing system.
  if (target === 'ja') return kana > 0;
  // Simplified vs. Traditional variants are not differentiated: Chinese descriptions are readable to both zh and zh-TW users and not worth re-translating.
  if (target === 'zh' || target === 'zh-TW') return han > 0 && kana === 0 && hangul === 0;
  if (target === 'ko') return hangul > 0;
  if (target === 'ru') return cyrillic > 0 && cyrillic >= latin;

  // Latin-script target languages (en/fr/de/es/pt-BR): delegate to translation if non-Latin predominates.
  if (latin === 0 || latin < nonLatin) return false;
  // Any extended Latin characters indicate an unsupported or different language (see LATIN_EXTENDED_PATTERN).
  if (countMatches(trimmed, LATIN_EXTENDED_PATTERN) > 0) return false;
  // English does not use accented letters: accented Latin text is always sent for translation when target is en,
  // preventing stop-word-free French/German/Spanish descriptions from being misclassified as English and skipped.
  if (target === 'en' && countMatches(trimmed, ACCENTED_LATIN_PATTERN) > 0) return false;

  const scores = LATIN_STOPWORD_PATTERNS.map(({ lang, pattern }) => ({
    lang,
    score: countMatches(trimmed, pattern),
  }));
  scores.sort((a, b) => b.score - a.score);
  const top = scores[0];
  const second = scores[1]?.score ?? 0;

  // No stop-word signal or a tie for first place: cannot reliably differentiate, fall back to English.
  if (!top || top.score === 0 || second === top.score) {
    return target === 'en';
  }
  return top.lang === target;
};
