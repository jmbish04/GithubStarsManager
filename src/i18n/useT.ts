import { useEffect, useMemo, useReducer } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/useAppStore';
import { i18n } from './index';
import type { I18nNamespace } from './index';

export type TranslateFn = (key: string, params?: Record<string, unknown>) => string;

/**
 * Component-level translation function: tracks zustand's `language` (single source of truth).
 * Replaces custom local `t(zh, en)` functions across components; see src/locales for key semantics.
 */
export function useT(namespace?: I18nNamespace): TranslateFn {
  const language = useAppStore(useShallow((state) => state.language));
  // Language bundle lazy-loading is async: when store switches languages, components re-render immediately,
  // at which point the target bundle may not yet be loaded (temporarily falling back to English).
  // Subscribe to i18next resource load/language switch events and force a re-render once ready
  // to avoid the UI getting stuck in the fallback language.
  const [, forceUpdate] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    const handler = () => forceUpdate();
    i18n.on('languageChanged', handler);
    i18n.store.on('added', handler);
    return () => {
      i18n.off('languageChanged', handler);
      i18n.store.off('added', handler);
    };
  }, []);
  return useMemo(
    () => (key: string, params?: Record<string, unknown>) =>
      i18n.getFixedT(language, namespace ?? 'common')(key, params) as string,
    [language, namespace],
  );
}

/**
 * Constructs a translation function for a specified language in non-component environments (outside services/hooks).
 * Language source is determined by the caller (typically store.getState().language or a local language variable).
 */
export function makeT(language: string, namespace?: I18nNamespace): TranslateFn {
  return (key: string, params?: Record<string, unknown>) =>
    i18n.getFixedT(language, namespace ?? 'common')(key, params) as string;
}

export type PairTranslateFn = (zh: string, en: string) => string;

/**
 * Transitional compatibility bridge: data-driven bilingual label pairs (e.g. labelZh/labelEn fields, runtime assembled
 * messages) cannot easily be keyed yet. tPair preserves zh/en behavior, with non-zh languages falling back to English.
 * Will be removed once these label constants are migrated into dictionaries.
 */
export function useTPair(): PairTranslateFn {
  const language = useAppStore(useShallow((state) => state.language));
  return useMemo(() => (zh: string, en: string) => (language === 'zh' ? zh : en), [language]);
}

export function makeTPair(language: string): PairTranslateFn {
  return (zh: string, en: string) => (language === 'zh' ? zh : en);
}
