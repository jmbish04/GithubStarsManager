/**
 * Registry of supported application languages. Language codes serve both as i18next language keys and
 * as `src/locales/{code}/` directory names.
 *
 * `zh` and `zh-TW` stay in the `AppLanguage` type because older code paths still compare against them,
 * but they are no longer selectable: they are left out of `APP_LANGUAGES`, so `isAppLanguage` rejects a
 * persisted `zh` / `zh-TW` value and the store falls back to the detected language (English for a
 * Chinese browser). There are no Chinese locale files.
 */
export type AppLanguage = 'zh' | 'en' | 'ja' | 'es' | 'pt-BR' | 'ru' | 'zh-TW' | 'fr' | 'de' | 'ko';

export interface LanguageDefinition {
  code: AppLanguage;
  /** Native language name, used for display in language picker */
  nativeName: string;
  /** English name, used for scenarios like AI output language directives */
  englishName: string;
  /** BCP 47 tag, used for <html lang> and Intl formatting */
  intlLocale: string;
}

export const APP_LANGUAGES: LanguageDefinition[] = [
  { code: 'en', nativeName: 'English', englishName: 'English', intlLocale: 'en' },
  { code: 'ja', nativeName: '日本語', englishName: 'Japanese', intlLocale: 'ja' },
  { code: 'es', nativeName: 'Español', englishName: 'Spanish', intlLocale: 'es' },
  { code: 'pt-BR', nativeName: 'Português (Brasil)', englishName: 'Brazilian Portuguese', intlLocale: 'pt-BR' },
  { code: 'ru', nativeName: 'Русский', englishName: 'Russian', intlLocale: 'ru' },
  { code: 'fr', nativeName: 'Français', englishName: 'French', intlLocale: 'fr' },
  { code: 'de', nativeName: 'Deutsch', englishName: 'German', intlLocale: 'de' },
  { code: 'ko', nativeName: '한국어', englishName: 'Korean', intlLocale: 'ko' },
];

export const DEFAULT_LANGUAGE: AppLanguage = 'en';
export const FALLBACK_LANGUAGE: AppLanguage = 'en';

const LANGUAGE_BY_CODE = new Map(APP_LANGUAGES.map((definition) => [definition.code, definition]));

export const isAppLanguage = (value: unknown): value is AppLanguage =>
  typeof value === 'string' && LANGUAGE_BY_CODE.has(value as AppLanguage);

export const languageDefinition = (code: AppLanguage): LanguageDefinition =>
  LANGUAGE_BY_CODE.get(code) ?? LANGUAGE_BY_CODE.get(DEFAULT_LANGUAGE)!;

/**
 * Default language detection on first installation (no persisted language). Affects new installs only;
 * existing users always read their persisted value. Matched in supported list -> that language; unmatched
 * (e.g. it-IT/sv-SE) -> English fallback, making initial screen readable for non-Chinese/English users.
 * Environments without navigator fall back to English. A Chinese browser locale also gets English.
 */
const LANGUAGE_MATCHERS: Array<[AppLanguage, RegExp]> = [
  ['ja', /^ja\b/i],
  ['ko', /^ko\b/i],
  ['ru', /^ru\b/i],
  ['fr', /^fr\b/i],
  ['de', /^de\b/i],
  ['es', /^es\b/i],
  ['pt-BR', /^pt\b/i],
  ['en', /^en\b/i],
];

export const detectInitialLanguage = (): AppLanguage => {
  if (typeof navigator === 'undefined') return DEFAULT_LANGUAGE;
  const candidates = [
    navigator.language,
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const matched = LANGUAGE_MATCHERS.find(([, pattern]) => pattern.test(candidate));
    if (matched) return matched[0];
  }
  return FALLBACK_LANGUAGE;
};
