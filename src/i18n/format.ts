import { de, enUS, es, fr, ja, ko, ptBR, ru, zhCN, zhTW } from 'date-fns/locale';
import type { Locale } from 'date-fns';
import { languageDefinition, type AppLanguage } from './languages';

/** date-fns locale mapping: relative date time/formatting follows the UI language on language switch. */
export function getDateFnsLocale(language: AppLanguage): Locale {
  switch (language) {
    case 'zh':
      return zhCN;
    case 'zh-TW':
      return zhTW;
    case 'en':
      return enUS;
    case 'ja':
      return ja;
    case 'es':
      return es;
    case 'pt-BR':
      return ptBR;
    case 'ru':
      return ru;
    case 'fr':
      return fr;
    case 'de':
      return de;
    case 'ko':
      return ko;
  }
}

/** BCP 47 tag for Intl formatting. */
export const getIntlLocale = (language: AppLanguage): string => languageDefinition(language).intlLocale;

/** Formats a number using the current language (replaces bare toLocaleString without locale). */
export const formatNumber = (value: number, language: AppLanguage): string =>
  value.toLocaleString(getIntlLocale(language));

/** Formats a date using the current language (replaces bare toLocaleDateString without locale). */
export const formatDate = (
  date: Date | number,
  language: AppLanguage,
  options?: Intl.DateTimeFormatOptions,
): string =>
  new Intl.DateTimeFormat(getIntlLocale(language), options ?? { dateStyle: 'medium' }).format(date);
