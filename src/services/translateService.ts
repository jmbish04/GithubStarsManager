import queryString from 'query-string';
import { createCombinedAbortController } from '../utils/abortUtils';
import { useAppStore } from '../store/useAppStore';
import { AIService } from './aiService';
import type { TranslationEngine } from '../types';

export interface TranslateResult {
  translatedText: string;
  detectedLanguage: string;
}

export interface TranslateOptions {
  from?: string;
  to: string;
  text: string;
  signal?: AbortSignal;
  textType?: 'html' | 'plain';
}

/** Microsoft Edge Translate (free, no authentication required). Legacy Bearer token auth endpoint is defunct (404). */
const MS_TRANSLATE_URL = 'https://edge.microsoft.com/translate/translatetext';
/** Google Translate free API (same as Chrome extension, fully CORS permissive). */
const GOOGLE_TRANSLATE_URL = 'https://clients5.google.com/translate_a/t';

/** Translation request timeout: max 50k characters per batch, relaxed to 20s on slow networks; timeout also covers reading response body. */
const TRANSLATE_TIMEOUT_MS = 20_000;
/** AI translation single request timeout: LLM generation is slower, allow ample headroom. */
const AI_TRANSLATE_TIMEOUT_MS = 90_000;

/** Per-HTTP-request chunking parameters: request count × character limit (Microsoft engine follows outer translateBatch limit of 100 items / 50k characters). */
const GOOGLE_BATCH_LIMITS = { texts: 20, chars: 1_800 };
const AI_BATCH_LIMITS = { texts: 10 };

/** App language code -> engine language code mapping ('zh' is not a valid target code in either engine). */
const MICROSOFT_LANG: Record<string, string> = { zh: 'zh-Hans', 'zh-TW': 'zh-Hant' };
const GOOGLE_LANG: Record<string, string> = { zh: 'zh-CN', 'zh-TW': 'zh-TW' };

/** Matches inline <code>…</code> tags (optionally with attributes). Note: lastIndex must be reset before use with /g. */
const CODE_TAG_PATTERN = /<code(?:\s+[^>]*)?>[\s\S]*?<\/code>/g;

interface MsTranslateItem {
  translations?: { text?: string }[];
}

/**
 * Request with timeout: both fetch and response body consumption (response.json(), etc.) are governed by the timeout;
 * slow body reads will also be aborted by timeout. Timeouts are converted to standard Errors (no status ->
 * isTransientError treats as transient, and outer withTranslateRetry will retry);
 * caller-initiated aborts still throw as AbortError (no retry).
 */
const fetchWithTimeout = async <T>(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  consume: (response: Response) => Promise<T>
): Promise<T> => {
  const controller = createCombinedAbortController(signal, timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return await consume(response);
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError' && !signal?.aborted) {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
};

/**
 * Replaces <code>…</code> in a single text with {0}, {1} placeholders (machine translation engines preserve
 * .NET style placeholders as-is), restoring them after translation. If any placeholder is lost in translation,
 * falls back to the entire original text to avoid outputting broken code tags to the renderer.
 */
const protectInlineCode = (text: string): { payload: string; restore: (translated: string) => string } => {
  const codes: string[] = [];
  const payload = text.replace(CODE_TAG_PATTERN, (match) => {
    codes.push(match);
    return `{${codes.length - 1}}`;
  });
  CODE_TAG_PATTERN.lastIndex = 0;
  return {
    payload,
    restore: (translated) => {
      let result = translated;
      for (let i = 0; i < codes.length; i++) {
        const token = `{${i}}`;
        if (!result.includes(token)) return text;
        const code = codes[i];
        // Insert using replacement function to avoid $& / $` / $' / $1 in code being interpreted as replacement patterns
        result = result.replace(token, () => code);
      }
      return result;
    },
  };
};

/**
 * Batch wrapper: enables placeholder protection only for html type (paragraphs containing inline code);
 * when text already contains {digits} (e.g. format string documentation), placeholders cannot be safely distinguished,
 * falling back to sending original text directly.
 */
const protectBatch = (
  texts: string[],
  textType?: 'html' | 'plain'
): { payload: string[]; restore: (translated: string[]) => string[] } => {
  if (textType !== 'html') {
    return { payload: texts, restore: (translated) => translated };
  }
  const items = texts.map((text) =>
    /\{\d+\}/.test(text) ? { payload: text, restore: (t: string) => t } : protectInlineCode(text)
  );
  return {
    payload: items.map((item) => item.payload),
    restore: (translated) => translated.map((t, i) => items[i].restore(t)),
  };
};

/**
 * Extracts HTTP status code from error object: prefers status/response.status fields
 * (e.g. AIRequestError), otherwise matches fragments like "failed: 429" from message.
 */
const extractHttpStatus = (err: unknown): number | null => {
  const anyErr = err as Record<string, unknown>;
  const response = anyErr?.response as Record<string, unknown> | undefined;
  const status = response?.status ?? anyErr?.status;
  if (typeof status === 'number') return status;

  if (err instanceof Error) {
    const match = err.message.match(/(?:status|failed)[:\s]*(\d{3})/i);
    if (match) {
      return parseInt(match[1], 10);
    }
  }

  return null;
};

/** Determines if error is retryable: auth expiration, missing status code (network/timeout/format), 429 and 5xx are treated as transient. */
const isTransientError = (err: unknown): boolean => {
  const status = extractHttpStatus(err);
  if (status === null) return true;
  return status === 429 || status >= 500;
};

/**
 * Exponential backoff retry wrapper. AbortError / CanceledError (caller cancellation) are rethrown directly;
 * non-transient errors (such as 4xx) are not retried. Responds to caller cancellation during sleep as well.
 */
const withTranslateRetry = async <T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
  maxRetries = 3,
  baseDelay = 1000
): Promise<T> => {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      const name = (err as { name?: string })?.name;
      if (name === 'AbortError' || name === 'CanceledError') {
        throw err;
      }

      if (attempt >= maxRetries) break;

      if (!isTransientError(err)) {
        throw err;
      }

      await sleep(baseDelay * Math.pow(2, attempt - 1), signal);
    }
  }

  throw lastError!;
};

/** Cancellable sleep: rejects immediately with AbortError if signal is already aborted or becomes aborted. */
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(id);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Reads currently active translation engine (switchable in settings, evaluated on every translation request). */
const getTranslationEngine = (): TranslationEngine =>
  useAppStore.getState().translationEngine ?? 'microsoft';

/**
 * Microsoft Edge translation engine: POST JSON string array to translatetext endpoint,
 * no authentication required. Response format is [{ translations: [{ text }] }].
 */
const translateWithMicrosoft = async (
  texts: string[],
  to: string,
  from: string | undefined,
  signal: AbortSignal | undefined,
  textType?: 'html' | 'plain'
): Promise<string[]> => {
  const { payload, restore } = protectBatch(texts, textType);
  const url = `${MS_TRANSLATE_URL}?${queryString.stringify({
    from: from ? MICROSOFT_LANG[from] || from : '',
    to: MICROSOFT_LANG[to] || to,
    isEnterpriseClient: 'false',
  })}`;

  const data = await fetchWithTimeout<MsTranslateItem[]>(
    url,
    {
      method: 'POST',
      headers: { 'Content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
    signal,
    TRANSLATE_TIMEOUT_MS,
    async (response) => {
      if (!response.ok) {
        throw new Error(`Translation failed: ${response.status}`);
      }
      return (await response.json()) as MsTranslateItem[];
    }
  );

  if (!Array.isArray(data) || data.length !== payload.length) {
    throw new Error('Invalid translation response');
  }
  return restore(data.map((item) => item?.translations?.[0]?.text ?? ''));
};

/**
 * Google free translation engine (clients5 dict-chrome-ex): POST form q=… (repeatable);
 * response has two shapes depending on sl param: [translatedText, sourceLang] tuples or bare strings, normalized uniformly.
 * Single HTTP request is chunked by item count and character count to avoid rejection of oversized requests.
 */
const translateWithGoogle = async (
  texts: string[],
  to: string,
  from: string | undefined,
  signal: AbortSignal | undefined,
  textType?: 'html' | 'plain'
): Promise<string[]> => {
  const { payload, restore } = protectBatch(texts, textType);
  const url = `${GOOGLE_TRANSLATE_URL}?${queryString.stringify({
    client: 'dict-chrome-ex',
    sl: from ? GOOGLE_LANG[from] || from : 'auto',
    tl: GOOGLE_LANG[to] || to,
  })}`;

  const results: string[] = [];
  let batch: string[] = [];
  let batchChars = 0;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const body = new URLSearchParams();
    batch.forEach((text) => body.append('q', text));

    const data = await fetchWithTimeout<unknown>(
      url,
      { method: 'POST', body },
      signal,
      TRANSLATE_TIMEOUT_MS,
      async (response) => {
        if (!response.ok) {
          throw new Error(`Translation failed: ${response.status}`);
        }
        return await response.json();
      }
    );

    if (!Array.isArray(data) || data.length !== batch.length) {
      throw new Error('Invalid translation response');
    }
    data.forEach((item) => {
      results.push(Array.isArray(item) ? String(item[0] ?? '') : String(item ?? ''));
    });
    batch = [];
    batchChars = 0;
  };

  for (const text of payload) {
    if (
      batch.length >= GOOGLE_BATCH_LIMITS.texts ||
      (batchChars + text.length > GOOGLE_BATCH_LIMITS.chars && batch.length > 0)
    ) {
      await flush();
    }
    batch.push(text);
    batchChars += text.length;
  }
  await flush();

  return restore(results);
};

/**
 * AI translation engine: reuses active AI configuration from settings (AIService.translateTexts),
 * translating in small request batches with independent timeouts per request (LLM generation is slower than direct MT APIs).
 */
const translateWithAI = async (
  texts: string[],
  to: string,
  from: string | undefined,
  signal: AbortSignal | undefined
): Promise<string[]> => {
  const { aiConfigs, activeAIConfig, language } = useAppStore.getState();
  const config = aiConfigs.find((item) => item.id === activeAIConfig);
  if (!config) {
    throw new Error('AI translation engine is not ready: please add and activate an AI configuration in Settings → AI Service Configuration first');
  }

  const aiService = new AIService(config, language);
  const results: string[] = [];

  for (let i = 0; i < texts.length; i += AI_BATCH_LIMITS.texts) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const chunk = texts.slice(i, i + AI_BATCH_LIMITS.texts);
    const controller = createCombinedAbortController(signal, AI_TRANSLATE_TIMEOUT_MS);
    try {
      const translated = await aiService.translateTexts(chunk, to, from, controller.signal);
      results.push(...translated);
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError' && !signal?.aborted) {
        throw new Error(`AI translation timed out after ${AI_TRANSLATE_TIMEOUT_MS}ms`);
      }
      throw err;
    }
  }

  return results;
};

/** Dispatches to corresponding translation engine based on current settings, returning an array of translations matching input length. */
const dispatchTranslation = async (
  texts: string[],
  to: string,
  from: string | undefined,
  signal: AbortSignal | undefined,
  textType?: 'html' | 'plain'
): Promise<string[]> => {
  const engine = getTranslationEngine();
  switch (engine) {
    case 'google':
      return translateWithGoogle(texts, to, from, signal, textType);
    case 'ai':
      return translateWithAI(texts, to, from, signal);
    default:
      return translateWithMicrosoft(texts, to, from, signal, textType);
  }
};

/** Single-batch translation + retry (AI engine retries 2 times, direct engines 3 times), results mapped to TranslateResult. */
const translateBatchInternal = async (
  texts: string[],
  to: string,
  from?: string,
  signal?: AbortSignal,
  textType?: 'html' | 'plain'
): Promise<TranslateResult[]> => {
  const maxRetries = getTranslationEngine() === 'ai' ? 2 : 3;
  return withTranslateRetry(async () => {
    const translated = await dispatchTranslation(texts, to, from, signal, textType);
    return translated.map((text) => ({ translatedText: text, detectedLanguage: '' }));
  }, signal, maxRetries);
};

/** Translates single text (empty text returned as-is without making requests). */
export const translateText = async (options: TranslateOptions): Promise<TranslateResult> => {
  const { from, to, text, signal, textType } = options;

  if (!text || text.trim() === '') {
    return { translatedText: text, detectedLanguage: '' };
  }

  const results = await translateBatchInternal([text], to, from, signal, textType);
  return results[0];
};

/** Splits oversized text into multiple segments by paragraphs and character limits (only used for text exceeding engine per-item limit). */
function splitTextIntoChunks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split('\n');
  let current = '';

  for (const para of paragraphs) {
    if (current.length + para.length + 1 > maxChars && current.length > 0) {
      chunks.push(current);
      current = para;
    } else if (current.length > 0) {
      current += '\n' + para;
    } else {
      current = para;
    }

    while (current.length > maxChars) {
      const splitPoint = current.lastIndexOf(' ', maxChars);
      if (splitPoint <= 0) {
        chunks.push(current.slice(0, maxChars));
        current = current.slice(maxChars);
      } else {
        chunks.push(current.slice(0, splitPoint));
        current = current.slice(splitPoint + 1);
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

/**
 * Batch translation entry point: merges multiple texts into as few requests as possible (bounded by engine per-request limits);
 * oversized texts are sliced first and translated per slice, with final results matching input order 1:1.
 */
export const translateBatch = async (
  texts: string[],
  to: string,
  from?: string,
  signal?: AbortSignal,
  textType?: 'html' | 'plain'
): Promise<TranslateResult[]> => {
  if (texts.length === 0) return [];

  if (texts.length === 1) {
    const result = await translateText({ text: texts[0], to, from, signal, textType });
    return [result];
  }

  const results: TranslateResult[] = [];
  const batchSize = 100;
  const maxChars = 50000;

  for (let i = 0; i < texts.length; i += batchSize) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const batch = texts.slice(i, i + batchSize);
    let currentBatch: string[] = [];
    let currentLength = 0;

    for (const text of batch) {
      // Always flush accumulated batch before handling an oversized item.
      if (text.length > maxChars) {
        if (currentBatch.length > 0) {
          const batchResults = await translateBatchInternal(currentBatch, to, from, signal, textType);
          results.push(...batchResults);
          currentBatch = [];
          currentLength = 0;
        }
        const chunks = splitTextIntoChunks(text, maxChars);
        for (const chunk of chunks) {
          const batchResults = await translateBatchInternal([chunk], to, from, signal, textType);
          results.push(...batchResults);
        }
        continue;
      }

      if (currentLength + text.length > maxChars && currentBatch.length > 0) {
        // (this branch is now only reached for non-oversized items)
        const batchResults = await translateBatchInternal(currentBatch, to, from, signal, textType);
        results.push(...batchResults);
        currentBatch = [];
        currentLength = 0;
      }
      currentBatch.push(text);
      currentLength += text.length;
    }

    if (currentBatch.length > 0) {
      const batchResults = await translateBatchInternal(currentBatch, to, from, signal, textType);
      results.push(...batchResults);
    }
  }

  return results;
};
