import i18next, { type i18n as I18nInstance } from 'i18next';
import {
  APP_LANGUAGES,
  FALLBACK_LANGUAGE,
  isAppLanguage,
  languageDefinition,
  type AppLanguage,
} from './languages';

/**
 * i18next initialization. Language bundles are lazy-loaded via import.meta.glob
 * (each language in a separate chunk, keeping main bundle size lean); zustand's `language`
 * is the single source of truth, and this module handles resource loading and language-switch side effects.
 */
export const I18N_NAMESPACES = [
  'common',
  'app',
  'login',
  'repositories',
  'gists',
  'releases',
  'discovery',
  'chat',
  'search',
  'plugins',
  'settings',
  'ai',
  'services',
  'errors',
] as const;

export type I18nNamespace = (typeof I18N_NAMESPACES)[number];

const localeModules = import.meta.glob<{ default: Record<string, unknown> }>('../locales/*/*.json');

const loadedLanguages = new Set<AppLanguage>();

void i18next.init({
  lng: FALLBACK_LANGUAGE,
  fallbackLng: FALLBACK_LANGUAGE,
  resources: {},
  partialBundledLanguages: true,
  interpolation: { escapeValue: false },
  returnEmptyString: false,
});

/** Loads all namespace resources for a language (idempotent). */
export async function ensureLanguageLoaded(language: AppLanguage): Promise<void> {
  if (loadedLanguages.has(language)) return;
  const prefix = `/locales/${language}/`;
  const entries = Object.entries(localeModules).filter(([filePath]) => filePath.includes(prefix));
  await Promise.all(
    entries.map(async ([filePath, loader]) => {
      const namespace = filePath.slice(filePath.lastIndexOf('/') + 1).replace(/\.json$/, '');
      if (!(I18N_NAMESPACES as readonly string[]).includes(namespace)) return;
      const module = await loader();
      i18next.addResourceBundle(language, namespace, module.default, true, true);
    }),
  );
  loadedLanguages.add(language);
}

/** Synchronously reads currently loaded language (for callers outside React). */
export function getCurrentAppLanguage(): AppLanguage {
  const current = i18next.language;
  return isAppLanguage(current) ? current : FALLBACK_LANGUAGE;
}

/**
 * Switches application language: loads target and fallback bundles -> switches i18next -> updates <html lang>.
 * Called by App's language side-effect; zustand remains the single source of truth.
 */
let languageSwitchSeq = 0;

export async function changeAppLanguage(language: AppLanguage): Promise<void> {
  const requestId = ++languageSwitchSeq;
  await Promise.all([ensureLanguageLoaded(language), ensureLanguageLoaded(FALLBACK_LANGUAGE)]);
  // During rapid consecutive switches, only apply the latest request to prevent stale requests from overwriting newer language choices
  if (requestId !== languageSwitchSeq) return;
  await i18next.changeLanguage(language);
  if (requestId !== languageSwitchSeq) return;
  document.documentElement.lang = languageDefinition(language).intlLocale;
}

export const i18n: I18nInstance = i18next;

export { APP_LANGUAGES };
export * from './languages';
