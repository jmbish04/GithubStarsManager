import { useEffect, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { translateText } from '../services/translateService';
import { isLikelySameLanguage } from '../utils/textLanguage';
import type { AppLanguage } from '../i18n/languages';

/**
 * Automatic translation of repository card descriptions (Settings -> AI Configuration -> Translation Engine -> Auto-translate repository descriptions).
 *
 * When enabled, translates original descriptions differing from the interface language into the interface language.
 * While translation is in progress, failed, or when the description is already in the interface language, falls back to the original text.
 * Results are cached at the session level by `${targetLanguage}:${originalText}`; identical text is translated only once across the application.
 * When disabled, returns undefined so callers directly fall back to the original text.
 */

/** Maximum concurrent translation requests: avoids overwhelming translation endpoints when dozens of list cards mount simultaneously. */
export const MAX_CONCURRENT_TRANSLATIONS = 4;

let activeTranslations = 0;
const waitingQueue: Array<() => void> = [];

const acquireSlot = (): Promise<void> =>
  new Promise((resolve) => {
    if (activeTranslations < MAX_CONCURRENT_TRANSLATIONS) {
      activeTranslations += 1;
      resolve();
      return;
    }
    // Queue wait: callback only wakes up; slot is handed off directly by releaseSlot without double counting.
    waitingQueue.push(() => {
      resolve();
    });
  });

const releaseSlot = (): void => {
  const next = waitingQueue.shift();
  if (next) {
    // Slot handoff: completing and receiving sides match 1:1, activeTranslations remains unchanged.
    next();
  } else {
    activeTranslations -= 1;
  }
};

/** Session cache: key is `${targetLanguage}:${originalText}`, value is final display text (original text if same language/failed). */
const MAX_RESOLVED_CACHE_ENTRIES = 2000;
const resolvedCache = new Map<string, string>();
/** In-flight request deduplication: concurrently mounting cards with identical text share the same Promise. */
const inflightRequests = new Map<string, Promise<string>>();

const cacheKey = (text: string, language: string): string => `${language}:${text}`;

const requestTranslation = (text: string, language: AppLanguage, key: string): Promise<string> => {
  const promise = (async (): Promise<string> => {
    try {
      await acquireSlot();
      if (isLikelySameLanguage(text, language)) {
        return text;
      }
      const result = await translateText({ text, to: language, textType: 'plain' });
      return result.translatedText?.trim() ? result.translatedText : text;
    } catch {
      // Fall back to original text on translation failure (network / engine unconfigured, etc.); cache to avoid retry loops during scrolling.
      return text;
    } finally {
      releaseSlot();
    }
  })();
  inflightRequests.set(key, promise);
  void promise.then((value) => {
    if (!resolvedCache.has(key) && resolvedCache.size >= MAX_RESOLVED_CACHE_ENTRIES) {
      const oldest = resolvedCache.keys().next().value;
      if (oldest !== undefined) resolvedCache.delete(oldest);
    }
    resolvedCache.set(key, value);
    inflightRequests.delete(key);
  });
  return promise;
};

/** Translation state stored bound to its cache key; verified during render before returning translation. */
interface TranslationState {
  key: string;
  value: string;
}

/**
 * Returns the translation text that should be displayed; `undefined` indicates no translation is available
 * for this render pass and the caller should display the original description.
 */
export const useTranslatedDescription = (
  text: string | null | undefined
): string | undefined => {
  const enabled = useAppStore((state) => state.autoTranslateRepoDescription);
  const language = useAppStore((state) => state.language);

  const shouldTranslate = Boolean(enabled && text && text.trim() !== '');
  const key = shouldTranslate && text ? cacheKey(text, language) : null;

  // Bind translation to key: first render after key changes (before effect re-runs) must not display the old key's
  // translation for the new key (e.g., card recycled for another repo, switching UI language).
  const [translation, setTranslation] = useState<TranslationState | null>(() => {
    if (!key || !text) return null;
    const cached = resolvedCache.get(key);
    return cached !== undefined && cached !== text ? { key, value: cached } : null;
  });

  useEffect(() => {
    if (!key || !text) {
      setTranslation(null);
      return;
    }
    const cached = resolvedCache.get(key);
    if (cached !== undefined) {
      setTranslation(cached !== text ? { key, value: cached } : null);
      return;
    }
    setTranslation(null);
    let cancelled = false;
    const pending = inflightRequests.get(key) ?? requestTranslation(text, language, key);
    void pending.then((value) => {
      if (!cancelled) {
        setTranslation(value !== text ? { key, value } : null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [key, text, language]);

  return translation && translation.key === key ? translation.value : undefined;
};
