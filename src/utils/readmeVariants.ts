import type { AppLanguage } from '../i18n/languages';

export interface GitHubReadmeCandidateItem {
  name?: string;
  path: string;
  type?: string;
}

export interface ReadmeVariant {
  key: string;
  name: string;
  path: string | null;
  label: string;
  languageCode?: string;
  isDefault: boolean;
}

const README_FILE_REGEX = /^README(?:[._-]([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)?))?\.(md|markdown|mdown|mkdn)$/i;

const LANGUAGE_LABELS: Record<string, { zh: string; en: string }> = {
  ar: { zh: 'Arabic', en: 'Arabic' },
  bg: { zh: 'Bulgarian', en: 'Bulgarian' },
  cs: { zh: 'Czech', en: 'Czech' },
  da: { zh: 'Danish', en: 'Danish' },
  de: { zh: 'German', en: 'German' },
  el: { zh: 'Greek', en: 'Greek' },
  en: { zh: 'English', en: 'English' },
  es: { zh: 'Spanish', en: 'Spanish' },
  fi: { zh: 'Finnish', en: 'Finnish' },
  fr: { zh: 'French', en: 'French' },
  he: { zh: 'Hebrew', en: 'Hebrew' },
  hi: { zh: 'Hindi', en: 'Hindi' },
  hu: { zh: 'Hungarian', en: 'Hungarian' },
  id: { zh: 'Indonesian', en: 'Indonesian' },
  it: { zh: 'Italian', en: 'Italian' },
  ja: { zh: 'Japanese', en: 'Japanese' },
  ko: { zh: 'Korean', en: 'Korean' },
  nl: { zh: 'Dutch', en: 'Dutch' },
  no: { zh: 'Norwegian', en: 'Norwegian' },
  pl: { zh: 'Polish', en: 'Polish' },
  pt: { zh: 'Portuguese', en: 'Portuguese' },
  'pt-br': { zh: 'Portuguese (Brazil)', en: 'Portuguese (Brazil)' },
  ro: { zh: 'Romanian', en: 'Romanian' },
  ru: { zh: 'Russian', en: 'Russian' },
  sv: { zh: 'Swedish', en: 'Swedish' },
  th: { zh: 'Thai', en: 'Thai' },
  tr: { zh: 'Turkish', en: 'Turkish' },
  uk: { zh: 'Ukrainian', en: 'Ukrainian' },
  vi: { zh: 'Vietnamese', en: 'Vietnamese' },
  zh: { zh: 'Chinese', en: 'Chinese' },
  cn: { zh: 'Chinese', en: 'Chinese' },
  'zh-cn': { zh: 'Simplified Chinese', en: 'Simplified Chinese' },
  'zh-hans': { zh: 'Simplified Chinese', en: 'Simplified Chinese' },
  'zh-tw': { zh: 'Traditional Chinese', en: 'Traditional Chinese' },
  'zh-hant': { zh: 'Traditional Chinese', en: 'Traditional Chinese' },
};

const COMMON_LANGUAGE_ORDER = [
  'en', 'zh', 'zh-cn', 'zh-hans', 'zh-tw', 'zh-hant', 'ja', 'ko', 'de', 'fr', 'es', 'pt', 'pt-br', 'ru', 'it', 'tr', 'vi', 'id',
];

export const DEFAULT_README_VARIANT: ReadmeVariant = {
  key: 'default',
  name: 'README',
  path: null,
  label: 'Default README',
  isDefault: true,
};

const getFileName = (path: string, fallback?: string): string => {
  if (fallback) return fallback;
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
};

const normalizeLanguageCode = (code: string): string => code.toLowerCase().replace(/_/g, '-');

const getLanguageLabel = (languageCode: string, uiLanguage: AppLanguage): string => {
  const labelFor = (record: { zh: string; en: string } & Partial<Record<AppLanguage, string>>): string =>
    record[uiLanguage] ?? record.en;
  const normalized = normalizeLanguageCode(languageCode);
  const exact = LANGUAGE_LABELS[normalized];
  if (exact) return labelFor(exact);

  const baseCode = normalized.split('-')[0];
  const base = LANGUAGE_LABELS[baseCode];
  if (base) {
    const region = normalized.split('-').slice(1).join('-').toUpperCase();
    return region ? `${labelFor(base)} (${region})` : labelFor(base);
  }

  return normalized;
};

/** README variant priority by UI language: native source first, then English, then fallback to Chinese */
const UI_LANGUAGE_README_PRIORITY: Record<AppLanguage, string[]> = {
  zh: ['zh', 'zh-cn', 'zh-hans', 'zh-tw', 'zh-hant', 'cn', 'en'],
  'zh-TW': ['zh-tw', 'zh-hant', 'zh-hk', 'zh', 'zh-cn', 'zh-hans', 'en'],
  en: ['en', 'zh', 'zh-cn', 'zh-hans', 'zh-tw', 'zh-hant', 'cn'],
  ja: ['ja', 'en', 'zh', 'zh-cn', 'zh-hans', 'zh-tw', 'zh-hant', 'cn'],
  ko: ['ko', 'en', 'zh', 'zh-cn', 'zh-hans', 'zh-tw', 'zh-hant', 'cn'],
  ru: ['ru', 'en', 'zh', 'zh-cn', 'zh-hans', 'zh-tw', 'zh-hant', 'cn'],
  fr: ['fr', 'en', 'zh', 'zh-cn', 'zh-hans', 'zh-tw', 'zh-hant', 'cn'],
  de: ['de', 'en', 'zh', 'zh-cn', 'zh-hans', 'zh-tw', 'zh-hant', 'cn'],
  es: ['es', 'en', 'zh', 'zh-cn', 'zh-hans', 'zh-tw', 'zh-hant', 'cn'],
  'pt-BR': ['pt-br', 'pt', 'en', 'zh', 'zh-cn', 'zh-hans', 'zh-tw', 'zh-hant', 'cn'],
};

const getLanguagePriority = (languageCode: string | undefined, uiLanguage: AppLanguage): number => {
  if (!languageCode) return 999;
  const normalized = normalizeLanguageCode(languageCode);
  const currentLanguagePriority = UI_LANGUAGE_README_PRIORITY[uiLanguage] ?? UI_LANGUAGE_README_PRIORITY.en;

  const currentIndex = currentLanguagePriority.indexOf(normalized);
  if (currentIndex >= 0) return currentIndex;

  const commonIndex = COMMON_LANGUAGE_ORDER.indexOf(normalized);
  if (commonIndex >= 0) return currentLanguagePriority.length + commonIndex;

  const baseIndex = COMMON_LANGUAGE_ORDER.indexOf(normalized.split('-')[0]);
  if (baseIndex >= 0) return currentLanguagePriority.length + COMMON_LANGUAGE_ORDER.length + baseIndex;

  return 998;
};

export const isReadmeCandidateItem = (item: GitHubReadmeCandidateItem): boolean => {
  const type = item.type?.toLowerCase();
  if (type && type !== 'file' && type !== 'blob') return false;
  return README_FILE_REGEX.test(getFileName(item.path, item.name));
};

export const buildReadmeVariants = (
  items: GitHubReadmeCandidateItem[],
  uiLanguage: AppLanguage
): ReadmeVariant[] => {
  const defaultVariant: ReadmeVariant = {
    ...DEFAULT_README_VARIANT,
    label: uiLanguage === 'zh' ? 'Default README' : 'Default README',
  };

  const seenPaths = new Set<string>();
  const variants = items
    .filter(isReadmeCandidateItem)
    .map((item): ReadmeVariant | null => {
      const name = getFileName(item.path, item.name);
      const match = name.match(README_FILE_REGEX);
      const languageCode = match?.[1] ? normalizeLanguageCode(match[1]) : undefined;

      if (!languageCode) return null;

      const path = item.path;
      const pathKey = path.toLowerCase();
      if (seenPaths.has(pathKey)) return null;
      seenPaths.add(pathKey);

      const languageLabel = getLanguageLabel(languageCode, uiLanguage);
      return {
        key: path,
        name,
        path,
        label: `${languageLabel} · ${path}`,
        languageCode,
        isDefault: false,
      };
    })
    .filter((variant): variant is ReadmeVariant => variant !== null)
    .sort((a, b) => {
      const priorityDiff = getLanguagePriority(a.languageCode, uiLanguage) - getLanguagePriority(b.languageCode, uiLanguage);
      if (priorityDiff !== 0) return priorityDiff;
      return a.path!.localeCompare(b.path!, undefined, { sensitivity: 'base' });
    });

  return [defaultVariant, ...variants];
};

