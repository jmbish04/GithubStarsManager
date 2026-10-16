import { Repository, Gist, AIConfig, AIApiType } from '../types';
import { isToolCallCapableApiType } from '../constants/aiCapabilities';
import { backend } from './backendAdapter';
import { buildApiUrl, buildFinalApiUrl } from '../utils/apiUrlBuilder';
import { NO_LICENSE_SENTINEL, normalizeLicense } from '../utils/licenseFilter';
import { deriveRepositoryHealthSnapshot } from '../utils/repositoryHealth';
import { isLocalOrLanHost } from '../utils/lanAddress';
import { logger } from './logger';
import { getOutputLanguageDirective } from '../i18n/aiLanguage';

interface OpenAIResponseContentPart {
  text?: string;
}

interface OpenAIResponseOutputItem {
  content?: OpenAIResponseContentPart[];
}

interface OpenAIResponseMessage {
  content?: string;
  reasoning_content?: string;
}

interface OpenAIResponseChoice {
  message?: OpenAIResponseMessage;
}

interface OpenAIResponse {
  output_text?: string;
  output?: OpenAIResponseOutputItem[];
  choices?: OpenAIResponseChoice[];
}

export interface ConnectionTestResult {
  success: boolean;
  statusCode?: number;
  statusText?: string;
  errorType?: 'network' | 'auth' | 'timeout' | 'server' | 'unknown';
  message: string;
}

type RepositoryAnalysisResult = {
  summary: string;
  tags: string[];
  platforms: string[];
};

type ParsedAIResponse = RepositoryAnalysisResult & {
  isValid: boolean;
  invalidReason?: string;
};

/**
 * Unified AI request error carrying the HTTP status code and an optional server-recommended retry delay.
 * Higher-level callers (rate limiters, optimizers) rely on status and retryAfterMs to determine backoff strategies.
 */
export class AIRequestError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;
  readonly isRateLimit: boolean;

  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = 'AIRequestError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.isRateLimit = status === 429;
  }
}

/** Checks whether an error indicates AI rate limiting (HTTP 429 or proxy rate-limit errors). */
export function isRateLimitedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { statusCode?: unknown; status?: unknown; isRateLimit?: unknown; message?: unknown };
  if (e.isRateLimit === true) return true;
  if (typeof e.statusCode === 'number' && e.statusCode === 429) return true;
  if (typeof e.status === 'number' && e.status === 429) return true;
  const msg = typeof e.message === 'string' ? e.message : '';
  return /429|rate\s*limit|too many requests/i.test(msg);
}

/** Reads the server-recommended wait time in milliseconds from a rate-limit error (Retry-After / retry-after-ms). */
export function getRetryAfterMsFromError(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as { retryAfterMs?: unknown; retryAfter?: unknown };
  const ms = typeof e.retryAfterMs === 'number' ? e.retryAfterMs : undefined;
  if (ms !== undefined && Number.isFinite(ms) && ms > 0) return ms;
  return undefined;
}

/** Parses Retry-After from response headers (retry-after-ms -> retry-after seconds -> HTTP date). */
function parseRetryAfterMs(response: Response): number | undefined {
  const msHeader = response.headers.get('retry-after-ms');
  if (msHeader) {
    const v = Number(msHeader);
    if (Number.isFinite(v) && v > 0) return Math.round(v);
  }
  const secHeader = response.headers.get('retry-after');
  if (secHeader) {
    const v = Number(secHeader);
    if (Number.isFinite(v) && v > 0) return Math.round(v * 1000);
    const parsed = Date.parse(secHeader);
    if (!Number.isNaN(parsed)) {
      const remaining = parsed - Date.now();
      if (remaining > 0) return remaining;
    }
  }
  return undefined;
}

/** Streaming requests are unsupported on this transport (e.g. backend proxies supporting only full JSON responses). Callers should fall back to non-streaming. */
export class AIStreamUnsupportedError extends Error {
  constructor(message = 'Streaming is not supported on this transport') {
    super(message);
    this.name = 'AIStreamUnsupportedError';
  }
}

export function isAIStreamUnsupportedError(error: unknown): boolean {
  return error instanceof AIStreamUnsupportedError;
}

/** Checks whether an error is a request cancellation (AbortError). Cancellation is not a failure: callers should halt instead of falling back. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** The current AI configuration/endpoint does not support native model tool calling (function calling). Callers should fall back to an orchestrated loop. */
export class AIToolCallUnsupportedError extends Error {
  constructor(message = 'Tool calling is not supported on this AI configuration') {
    super(message);
    this.name = 'AIToolCallUnsupportedError';
  }
}

export function isAIToolCallUnsupportedError(error: unknown): boolean {
  return error instanceof AIToolCallUnsupportedError;
}

export interface AIToolDefinition {
  name: string;
  description: string;
  /** Parameter definition in JSON Schema format. */
  parameters: Record<string, unknown>;
}

export interface AIToolCall {
  id: string;
  name: string;
  /** Raw JSON argument string (parsed by the caller; treated as an empty object if parsing fails). */
  arguments: string;
}

export type AIToolLoopMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls: AIToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

/**
 * Whether the configuration actually enables native tool calling: the protocol family must support it
 * and the user must have explicitly checked "supports tool calling" in this AI config.
 * Both are required to prevent unverified endpoints from defaulting into tool loops.
 * Any capability shortfall at the endpoint falls back gracefully on request failure.
 */
export function supportsChatToolCalls(config: Pick<AIConfig, 'apiType' | 'supportsToolCalls'>): boolean {
  return isToolCallCapableApiType(config.apiType) && config.supportsToolCalls === true;
}

/** Consumes an SSE byte stream event-by-event, passing each data: payload to the callback (automatically buffering incomplete lines across chunks). */
export async function consumeSseStream(body: ReadableStream<Uint8Array>, onData: (payload: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  const flush = () => {
    if (dataLines.length > 0) {
      onData(dataLines.join('\n'));
      dataLines = [];
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separatorIndex: number;
      // SSE line delimiters accept CRLF / LF / bare CR per specification.
      while ((separatorIndex = buffer.search(/[\r\n]/)) >= 0) {
        // A trailing \r might form a CRLF with a leading \n in the next chunk; wait for more data.
        if (buffer[separatorIndex] === '\r' && separatorIndex === buffer.length - 1) break;
        const separatorLength = buffer[separatorIndex] === '\r' && buffer[separatorIndex + 1] === '\n' ? 2 : 1;
        const line = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + separatorLength);
        if (line === '') {
          flush();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        // event:/id:/comment lines are irrelevant to these APIs and are ignored.
      }
    }
    // Flush remaining multibyte sequences in the decoder, splitting EOF remnants with the same rules:
    // covers the final line without a newline, bare CR separators, and a trailing dangling \r.
    buffer += decoder.decode();
    const residualLines = buffer.split(/\r\n|\r|\n/);
    buffer = '';
    for (const line of residualLines) {
      if (line === '') {
        flush();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    flush();
  } finally {
    reader.releaseLock();
  }
}

export function extractOpenAiChatDelta(payload: string): string {
  if (!payload || payload === '[DONE]') return '';
  try {
    const json = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string | null } }> };
    const delta = json.choices?.[0]?.delta?.content;
    return typeof delta === 'string' ? delta : '';
  } catch {
    return '';
  }
}

export function extractOpenAiResponsesDelta(payload: string): string {
  try {
    const json = JSON.parse(payload) as { type?: string; delta?: unknown };
    if (json.type === 'response.output_text.delta' && typeof json.delta === 'string') return json.delta;
    return '';
  } catch {
    return '';
  }
}

export function extractClaudeDelta(payload: string): string {
  try {
    const json = JSON.parse(payload) as { type?: string; delta?: { type?: string; text?: string } };
    if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta' && typeof json.delta.text === 'string') {
      return json.delta.text;
    }
    return '';
  } catch {
    return '';
  }
}

export function extractGeminiDelta(payload: string): string {
  try {
    const json = JSON.parse(payload) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> };
    const parts = json.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return '';
    return parts
      .filter((p) => p && !p.thought && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('');
  } catch {
    return '';
  }
}

/** When the server does not respond with SSE, extracts text from the complete JSON response (consistent with requestText parsing). */
function extractFullTextFromResponse(apiType: AIApiType, data: unknown): string {
  if (apiType === 'openai-responses') {
    const typed = data as OpenAIResponse;
    if (typeof typed.output_text === 'string' && typed.output_text) return typed.output_text;
    if (Array.isArray(typed.output)) {
      return typed.output
        .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
        .map((part) => part?.text || '')
        .join('');
    }
    return '';
  }
  if (apiType === 'claude') {
    const blocks = (data as { content?: unknown }).content;
    if (!Array.isArray(blocks)) return '';
    return blocks
      .map((b) => {
        if (!b || typeof b !== 'object') return '';
        const block = b as { type?: unknown; text?: unknown };
        return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
      })
      .join('');
  }
  if (apiType === 'gemini') {
    const candidates = (data as { candidates?: unknown }).candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) return '';
    const parts = (candidates[0] as { content?: { parts?: unknown } }).content?.parts;
    if (!Array.isArray(parts)) return '';
    return parts
      .filter((p) => p && typeof p === 'object' && !(p as { thought?: boolean }).thought)
      .map((p) => {
        if (!p || typeof p !== 'object') return '';
        const part = p as { text?: unknown };
        return typeof part.text === 'string' ? part.text : '';
      })
      .join('');
  }
  const content = (data as { choices?: OpenAIResponseChoice[] }).choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

function getStatusCodeMeaning(statusCode: number, language: string): string {
  const meanings: Record<number, { zh: string; en: string }> = {
    400: { zh: 'Bad Request', en: 'Bad Request' },
    401: { zh: 'Invalid or expired API key', en: 'Invalid or expired API key' },
    403: { zh: 'Forbidden - no permission', en: 'Forbidden - no permission' },
    404: { zh: 'API endpoint or model not found', en: 'API endpoint or model not found' },
    408: { zh: 'Request timeout', en: 'Request timeout' },
    429: { zh: 'Rate limit exceeded', en: 'Rate limit exceeded' },
    500: { zh: 'Internal server error', en: 'Internal server error' },
    502: { zh: 'Bad Gateway', en: 'Bad Gateway' },
    503: { zh: 'Service unavailable', en: 'Service unavailable' },
    504: { zh: 'Gateway timeout', en: 'Gateway timeout' },
  };
  return meanings[statusCode]?.[language as 'zh' | 'en'] || (language === 'zh' ? 'Unknown error' : 'Unknown error');
}

function getErrorTypeFromStatus(statusCode: number): ConnectionTestResult['errorType'] {
  if (statusCode === 401 || statusCode === 403) return 'auth';
  if (statusCode === 408 || statusCode === 504) return 'timeout';
  if (statusCode >= 500) return 'server';
  if (statusCode >= 400) return 'unknown';
  return 'unknown';
}

export class AIService {
  private config: AIConfig;
  private language: string;
  private static readonly ANALYSIS_MAX_ATTEMPTS = 3;
  private static readonly ANALYSIS_MAX_TOKENS = 4096;
  private static readonly RERANKING_MAX_TOKENS = 4096;
  /** When library size does not exceed this threshold, skip lexical recall and pass the full library directly to the LLM for selection. */
  private static readonly SELECTION_FULL_LIBRARY_LIMIT = 150;
  /** Candidate limit sent to the LLM for large libraries: essential for decoupling token costs from total library size. */
  private static readonly SELECTION_CANDIDATE_LIMIT = 100;
  /** When lexical candidates fall below this threshold, backfill using star ranking to ensure the LLM always has sufficient candidates. */
  private static readonly SELECTION_MIN_CANDIDATES = 15;
  /** Maximum number of relevant repositories returned by LLM selection. */
  private static readonly SELECTION_MAX_RESULTS = 20;
  private static readonly SELECTION_MAX_TOKENS = 800;

  constructor(config: AIConfig, language: string = 'zh', private readonly redactDebugPayload = false) {
    this.config = config;
    this.language = language;
  }

  /**
   * Log AI request details at debug level (only logged when debug mode is on).
   */
  private logAIRequestDebug(
    startTime: number,
    context: { apiType: string; model: string; configId: string },
    result: { responseLength: number } | { error: string },
    httpDetails?: {
      url?: string;
      requestHeaders?: Record<string, string>;
      requestBody?: unknown;
      responseHeaders?: Record<string, string>;
      responseBody?: string;
      status?: number;
      /** Whether the response was streamed via SSE (used by streaming debug logs). */
      streamed?: boolean;
    }
  ): void {
    if (logger.isDebugMode()) {
      logger.debug('ai', 'AI request', {
        ...context,
        durationMs: Date.now() - startTime,
        ...result,
        ...(this.redactDebugPayload ? { status: httpDetails?.status } : (httpDetails || {})),
      });
    }
  }

  /**
   * Sanitizes characters in user content that could cause JSON serialization issues:
   * - Strips null bytes and control characters (preserving \n \r \t).
   * - Replaces lone surrogates to avoid errors in certain JSON parsers.
   */
  private sanitizeForPrompt(content: string): string {
    // Strip null bytes and control characters (preserving newlines, carriage returns, and tabs).
    // eslint-disable-next-line no-control-regex
    let sanitized = content.replace(/[\0-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    // Replace lone surrogates while preserving valid surrogate pairs (avoid lookbehind for Safari 12+ compatibility).
    sanitized = sanitized.replace(
      /([\uD800-\uDBFF][\uDC00-\uDFFF])|[\uD800-\uDBFF]|[\uDC00-\uDFFF]/g,
      (m, pair) => (pair ? m : '\uFFFD')
    );
    return sanitized;
  }

  private getApiType(): AIApiType {
    return this.config.apiType || 'openai';
  }

  /**
   * Direct-mode security guard: forbids sending Authorization / x-api-key / URL keys over plain
   * HTTP to remote hosts. Only local or LAN addresses (such as localhost, 127.0.0.1, 192.168.x.x, etc.) are exempt
   * (for local inference / LAN device server setups). Backend proxy requests are handled by the proxy and not checked here.
   */
  private requireSecureDirectEndpoint(): void {
    if (backend.isAvailable) return;
    const base = this.config.baseUrl.trim();
    if (!/^http:\/\//i.test(base)) return;
    let host = base.replace(/^http:\/\//i, '').split('/')[0] || '';
    try {
      host = new URL(base).hostname;
    } catch {
      // Keep the string-parsed host fallback
    }
    if (!isLocalOrLanHost(host)) {
      throw new Error(this.language === 'zh'
        ? 'The AI endpoint must use HTTPS: to protect your API key, plain HTTP is only allowed for local or LAN addresses (localhost / 127.0.0.1).'
        : 'The AI endpoint must use HTTPS: to protect your API key, plain HTTP is only allowed for local or LAN addresses (localhost / 127.0.0.1).');
    }
  }

  private getOpenAIReasoningPayload(): { effort: 'none' | 'low' | 'medium' | 'high' | 'xhigh' } | undefined {
    const effort = this.config.reasoningEffort;
    return effort ? { effort } : undefined;
  }

  private isDeepSeekModel(): boolean {
    return this.getApiType() === 'deepseek';
  }

  private isDeepSeekReasonerModel(): boolean {
    return this.isDeepSeekModel() && this.config.model.trim() === 'deepseek-reasoner';
  }

  /**
   * Check if the model is a DeepSeek model with default thinking enabled (e.g. deepseek-v4-pro, deepseek-v4-flash).
   * These models consume max_tokens for reasoning, leaving 0 tokens for content if max_tokens is too low.
   * We need to explicitly disable thinking for these models.
   */
  private isDeepSeekThinkingModel(): boolean {
    return this.isDeepSeekModel() && this.config.model.trim() !== 'deepseek-reasoner';
  }

  private isMiMoModel(): boolean {
    return this.getApiType() === 'mimo';
  }

  private async extractErrorDetail(response: Response): Promise<string> {
    try {
      const text = await response.text();
      try {
        const errorBody = JSON.parse(text);
        return typeof errorBody === 'object' ? JSON.stringify(errorBody) : String(errorBody);
      } catch {
        return text;
      }
    } catch {
      return '';
    }
  }

  private async requestText(options: {
    system: string;
    user: string;
    temperature: number;
    maxTokens: number;
    signal?: AbortSignal;
  }): Promise<string> {
    this.requireSecureDirectEndpoint();
    const startTime = Date.now();
    const apiType = this.getApiType();
    const model = this.config.model;
    const configId = this.config.id;
    const reasoning = this.getOpenAIReasoningPayload();

    if (apiType === 'openai' || apiType === 'openai-responses' || apiType === 'openai-compatible' || apiType === 'deepseek' || apiType === 'mimo') {
      const messages = [
        ...(options.system.trim()
          ? [{ role: 'system', content: options.system }]
          : []),
        { role: 'user', content: options.user },
      ];
      const isDeepSeekReasoner = this.isDeepSeekReasonerModel();
      const isDeepSeekThinking = this.isDeepSeekThinkingModel();
      const isMiMoModel = this.isMiMoModel();

      const requestBody = apiType === 'openai-responses'
        ? {
            model: this.config.model,
            input: messages,
            temperature: options.temperature,
            max_output_tokens: options.maxTokens,
            ...(reasoning ? { reasoning } : {}),
            ...(isMiMoModel || isDeepSeekThinking ? { thinking: { type: 'disabled' } } : {}),
          }
        : {
            model: this.config.model,
            messages,
            max_tokens: options.maxTokens,
            ...(!isDeepSeekReasoner ? { temperature: options.temperature } : {}),
            ...(!isDeepSeekReasoner && !isDeepSeekThinking && !isMiMoModel && reasoning && apiType !== 'openai-compatible' ? { reasoning } : {}),
            ...(isMiMoModel || isDeepSeekThinking ? { thinking: { type: 'disabled' } } : {}),
          };

      let data: Record<string, unknown>;
      // HTTP details captured in debug mode
      const requestUrl = buildFinalApiUrl(this.config.baseUrl, apiType);
      const requestHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': 'Bearer ***',
      };
      let responseHeaders: Record<string, string> | undefined;
      let responseBodyPreview: string | undefined;
      let responseStatus: number | undefined;

      if (backend.isAvailable) {
        // Note: backend proxy does not return HTTP-level details (headers, body preview).
        // httpDetails will contain only url/requestHeaders/requestBody; response fields stay undefined.
        data = await backend.proxyAIRequestWithFallback(this.config.id, this.config, requestBody, options.signal) as Record<string, unknown>;
      } else {
        const response = await fetch(requestUrl, {
          // Direct fetch includes API key; forbid following redirects to prevent credential leakage.
          redirect: 'error',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(requestBody),
          signal: options.signal,
        });
        // Capture response headers
        responseHeaders = {};
        response.headers.forEach((v, k) => { responseHeaders![k] = v; });
        responseStatus = response.status;
        // Capture response body preview (clone to avoid consuming)
        try {
          const cloned = response.clone();
          const text = await cloned.text();
          if (text.length > 0) {
            responseBodyPreview = text.length > 4000 ? text.slice(0, 4000) + '...[truncated]' : text;
          }
        } catch { /* body not readable */ }
        if (!response.ok) {
          const errorDetail = await this.extractErrorDetail(response);
          this.logAIRequestDebug(startTime, { apiType, model, configId }, { error: 'request failed' }, {
            url: requestUrl, requestHeaders, requestBody, responseHeaders, responseBody: responseBodyPreview, status: responseStatus,
          });
          throw new AIRequestError(
            `AI API error: ${response.status} ${response.statusText}${errorDetail ? ` - ${errorDetail}` : ''}`,
            response.status,
            parseRetryAfterMs(response)
          );
        }
        data = await response.json();
      }

      const httpDetails = logger.isDebugMode() ? {
        url: requestUrl, requestHeaders, requestBody, responseHeaders, responseBody: responseBodyPreview, status: responseStatus,
      } : undefined;

      if (apiType === 'openai-responses') {
        const typedData = data as OpenAIResponse;
        const outputText = typedData.output_text;
        if (outputText) {
          this.logAIRequestDebug(startTime, { apiType, model, configId }, { responseLength: outputText.length }, httpDetails);
          return outputText;
        }

        const output = typedData.output;
        if (Array.isArray(output)) {
          const text = output
            .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
            .map((part) => part?.text || '')
            .join('');
          if (text) {
            this.logAIRequestDebug(startTime, { apiType, model, configId }, { responseLength: text.length }, httpDetails);
            return text;
          }
        }
      } else {
        const typedData = data as { choices?: OpenAIResponseChoice[] };
        const choices = typedData.choices;
        const message = choices?.[0]?.message;
        const content = message?.content;
        if (content) {
          this.logAIRequestDebug(startTime, { apiType, model, configId }, { responseLength: content.length }, httpDetails);
          return content;
        }

        // Only fall back to reasoning_content for the dedicated deepseek-reasoner model.
        // Other DeepSeek models (e.g. deepseek-v4-flash, deepseek-v4-pro) may also return
        // reasoning_content (the thinking chain), but we must not use it as the final answer.
        const reasoningContent = message?.reasoning_content;
        if (reasoningContent && isDeepSeekReasoner) {
          this.logAIRequestDebug(startTime, { apiType, model, configId }, { responseLength: reasoningContent.length }, httpDetails);
          return reasoningContent;
        }

        if (!content && reasoningContent) {
          logger.warn('ai', 'Model returned reasoning_content but empty content', { model, configId });
        }
      }

      this.logAIRequestDebug(startTime, { apiType, model, configId }, { error: 'request failed' }, httpDetails);
      throw new Error('No content received from AI service');
    }

    if (apiType === 'claude') {
      const requestBody = {
        model: this.config.model,
        ...(options.system.trim() ? { system: options.system } : {}),
        messages: [{ role: 'user', content: options.user }],
        temperature: options.temperature,
        max_tokens: options.maxTokens,
      };

      let data: unknown;
      // HTTP details captured in debug mode
      const requestUrl = buildApiUrl(this.config.baseUrl, 'v1/messages');
      const requestHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-api-key': '***',
        'anthropic-version': '2023-06-01',
      };
      let responseHeaders: Record<string, string> | undefined;
      let responseBodyPreview: string | undefined;
      let responseStatus: number | undefined;

      if (backend.isAvailable) {
        // Note: backend proxy does not return HTTP-level details (headers, body preview).
        data = await backend.proxyAIRequestWithFallback(this.config.id, this.config, requestBody, options.signal);
      } else {
        const response = await fetch(requestUrl, {
          // Direct fetch includes API key; forbid following redirects to prevent credential leakage.
          redirect: 'error',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'x-api-key': this.config.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(requestBody),
          signal: options.signal,
        });
        // Capture response headers
        responseHeaders = {};
        response.headers.forEach((v, k) => { responseHeaders![k] = v; });
        responseStatus = response.status;
        // Capture response body preview
        try {
          const cloned = response.clone();
          const text = await cloned.text();
          if (text.length > 0) {
            responseBodyPreview = text.length > 4000 ? text.slice(0, 4000) + '...[truncated]' : text;
          }
        } catch { /* body not readable */ }
        if (!response.ok) {
          const errorDetail = await this.extractErrorDetail(response);
          this.logAIRequestDebug(startTime, { apiType, model, configId }, { error: 'request failed' }, {
            url: requestUrl, requestHeaders, requestBody, responseHeaders, responseBody: responseBodyPreview, status: responseStatus,
          });
          throw new AIRequestError(
            `AI API error: ${response.status} ${response.statusText}${errorDetail ? ` - ${errorDetail}` : ''}`,
            response.status,
            parseRetryAfterMs(response)
          );
        }
        data = await response.json();
      }

      const httpDetails = logger.isDebugMode() ? {
        url: requestUrl, requestHeaders, requestBody, responseHeaders, responseBody: responseBodyPreview, status: responseStatus,
      } : undefined;

      const contentBlocks = (data as { content?: unknown }).content;
      if (Array.isArray(contentBlocks)) {
        const text = contentBlocks
          .map((b) => {
            if (!b || typeof b !== 'object') return '';
            const block = b as { type?: unknown; text?: unknown };
            return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
          })
          .join('');
        if (text) {
          this.logAIRequestDebug(startTime, { apiType, model, configId }, { responseLength: text.length }, httpDetails);
          return text;
        }
      }
      this.logAIRequestDebug(startTime, { apiType, model, configId }, { error: 'request failed' }, httpDetails);
      throw new Error('No content received from AI service');
    }

    // gemini
    const rawModel = this.config.model.trim();
    const geminiModel = rawModel.startsWith('models/') ? rawModel.slice('models/'.length) : rawModel;
    const prompt = options.system ? `${options.system}

${options.user}` : options.user;
    const requestBody = {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: options.temperature,
        maxOutputTokens: options.maxTokens,
      },
    };

    let data: unknown;
    // HTTP details captured in debug mode
    const path = `v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`;
    const urlObj = new URL(buildApiUrl(this.config.baseUrl, path));
    urlObj.searchParams.set('key', this.config.apiKey);
    const requestUrl = urlObj.toString();
    // Mask API key in URL for debug logging
    const maskedUrl = requestUrl.replace(/([?&]key=)[^&]+/, '$1***');
    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    let responseHeaders: Record<string, string> | undefined;
    let responseBodyPreview: string | undefined;
    let responseStatus: number | undefined;

    if (backend.isAvailable) {
      // Note: backend proxy does not return HTTP-level details (headers, body preview).
      data = await backend.proxyAIRequestWithFallback(this.config.id, this.config, requestBody, options.signal);
    } else {
      const response = await fetch(requestUrl, {
        // Direct fetch includes API key in URL; forbid following redirects to prevent credential leakage.
        redirect: 'error',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: options.signal,
      });
      // Capture response headers
      responseHeaders = {};
      response.headers.forEach((v, k) => { responseHeaders![k] = v; });
      responseStatus = response.status;
      // Capture response body preview
      try {
        const cloned = response.clone();
        const text = await cloned.text();
        if (text.length > 0) {
          responseBodyPreview = text.length > 4000 ? text.slice(0, 4000) + '...[truncated]' : text;
        }
      } catch { /* body not readable */ }
      if (!response.ok) {
        const errorDetail = await this.extractErrorDetail(response);
        this.logAIRequestDebug(startTime, { apiType, model, configId }, { error: 'request failed' }, {
          url: maskedUrl, requestHeaders, requestBody, responseHeaders, responseBody: responseBodyPreview, status: responseStatus,
        });
        throw new AIRequestError(
          `AI API error: ${response.status} ${response.statusText}${errorDetail ? ` - ${errorDetail}` : ''}`,
          response.status,
          parseRetryAfterMs(response)
        );
      }
      data = await response.json();
    }

    const httpDetails = logger.isDebugMode() ? {
      url: maskedUrl, requestHeaders, requestBody, responseHeaders, responseBody: responseBodyPreview, status: responseStatus,
    } : undefined;

    const candidates = (data as { candidates?: unknown }).candidates;
    if (Array.isArray(candidates) && candidates.length > 0) {
      const candidate = candidates[0] as { content?: { parts?: unknown }; finishReason?: string };
      const parts = candidate.content?.parts;
      if (Array.isArray(parts)) {
        // Skip thought parts emitted by Gemini thinking models (e.g. gemini-2.5-pro)
        const text = parts
          .filter((p) => p && typeof p === 'object' && !(p as { thought?: boolean }).thought)
          .map((p) => {
            if (!p || typeof p !== 'object') return '';
            const part = p as { text?: unknown };
            return typeof part.text === 'string' ? part.text : '';
          })
          .join('');
        if (text) {
          this.logAIRequestDebug(startTime, { apiType, model, configId }, { responseLength: text.length }, httpDetails);
          return text;
        }
      }
    }
    this.logAIRequestDebug(startTime, { apiType, model, configId }, { error: 'request failed' }, httpDetails);
    throw new Error('No content received from AI service');
  }

  /**
   * Streaming text generation (SSE). Only direct-fetch mode is supported; requests via backend proxy
   * throw AIStreamUnsupportedError, letting the caller decide whether to fall back. Returns the full concatenated
   * text, with incremental chunks emitted via the onChunk callback.
   */
  private async requestTextStream(options: {
    system: string;
    user: string;
    temperature: number;
    maxTokens: number;
    signal?: AbortSignal;
    onChunk: (delta: string) => void;
  }): Promise<string> {
    if (backend.isAvailable) {
      // /api/proxy/ai buffers the entire JSON response and cannot forward SSE frames.
      throw new AIStreamUnsupportedError();
    }
    this.requireSecureDirectEndpoint();
    if (this.isDeepSeekReasonerModel()) {
      // For deepseek-reasoner, the final output may reside solely in reasoning_content (chain-of-thought),
      // which the non-streaming path handles specially (and reasoning_content must not be passed to other DeepSeek models).
      // Streaming deltas cannot safely distinguish thinking from output, so route directly to the blocking path to reuse existing semantics.
      throw new AIStreamUnsupportedError();
    }

    const apiType = this.getApiType();
    const model = this.config.model;
    const configId = this.config.id;
    const startTime = Date.now();

    let requestUrl: string;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    };
    let body: unknown;
    let extractDelta: (payload: string) => string;

    if (apiType === 'claude') {
      requestUrl = buildApiUrl(this.config.baseUrl, 'v1/messages');
      headers['x-api-key'] = this.config.apiKey;
      headers['anthropic-version'] = '2023-06-01';
      body = {
        model,
        stream: true,
        ...(options.system.trim() ? { system: options.system } : {}),
        messages: [{ role: 'user', content: options.user }],
        temperature: options.temperature,
        max_tokens: options.maxTokens,
      };
      extractDelta = extractClaudeDelta;
    } else if (apiType === 'gemini') {
      const rawModel = this.config.model.trim();
      const geminiModel = rawModel.startsWith('models/') ? rawModel.slice('models/'.length) : rawModel;
      const prompt = options.system ? `${options.system}\n\n${options.user}` : options.user;
      const urlObj = new URL(buildApiUrl(this.config.baseUrl, `v1beta/models/${encodeURIComponent(geminiModel)}:streamGenerateContent`));
      urlObj.searchParams.set('alt', 'sse');
      urlObj.searchParams.set('key', this.config.apiKey);
      requestUrl = urlObj.toString();
      body = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: options.temperature,
          maxOutputTokens: options.maxTokens,
        },
      };
      extractDelta = extractGeminiDelta;
    } else if (apiType === 'openai' || apiType === 'openai-responses' || apiType === 'openai-compatible' || apiType === 'deepseek' || apiType === 'mimo') {
      const messages = [
        ...(options.system.trim() ? [{ role: 'system', content: options.system }] : []),
        { role: 'user', content: options.user },
      ];
      const isDeepSeekReasoner = this.isDeepSeekReasonerModel();
      const isDeepSeekThinking = this.isDeepSeekThinkingModel();
      const isMiMoModel = this.isMiMoModel();
      const reasoning = this.getOpenAIReasoningPayload();

      body = apiType === 'openai-responses'
        ? {
            model,
            input: messages,
            stream: true,
            temperature: options.temperature,
            max_output_tokens: options.maxTokens,
            ...(reasoning ? { reasoning } : {}),
            ...(isMiMoModel || isDeepSeekThinking ? { thinking: { type: 'disabled' } } : {}),
          }
        : {
            model,
            messages,
            stream: true,
            max_tokens: options.maxTokens,
            ...(!isDeepSeekReasoner ? { temperature: options.temperature } : {}),
            ...(!isDeepSeekReasoner && !isDeepSeekThinking && !isMiMoModel && reasoning && apiType !== 'openai-compatible' ? { reasoning } : {}),
            ...(isMiMoModel || isDeepSeekThinking ? { thinking: { type: 'disabled' } } : {}),
          };
      requestUrl = buildFinalApiUrl(this.config.baseUrl, apiType);
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
      extractDelta = apiType === 'openai-responses' ? extractOpenAiResponsesDelta : extractOpenAiChatDelta;
    } else {
      throw new AIStreamUnsupportedError();
    }

    // Request headers are shown in debug logs only with credentials masked
    const debugHeaders: Record<string, string> = { ...headers };
    if (debugHeaders['Authorization']) debugHeaders['Authorization'] = 'Bearer ***';
    if (debugHeaders['x-api-key']) debugHeaders['x-api-key'] = '***';
    const maskedUrl = requestUrl.replace(/([?&]key=)[^&]+/, '$1***');

    const response = await fetch(requestUrl, {
      // Direct fetch includes API key (URL or headers); forbid following redirects to prevent credential leakage.
      redirect: 'error',
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (!response.ok) {
      const errorDetail = await this.extractErrorDetail(response);
      this.logAIRequestDebug(startTime, { apiType, model, configId }, { error: 'request failed' }, {
        url: maskedUrl, requestHeaders: debugHeaders, status: response.status,
      });
      throw new AIRequestError(
        `AI API error: ${response.status} ${response.statusText}${errorDetail ? ` - ${errorDetail}` : ''}`,
        response.status,
        parseRetryAfterMs(response)
      );
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType) {
      // Sniff content when Content-Type is missing: parse as SSE if body contains data: frames,
      // otherwise fall back to full JSON / plain text (where body is already buffered, invoking callback per chunk).
      const raw = await response.text();
      const ssePayloads: string[] = [];
      let dataLines: string[] = [];
      // SSE line delimiters accept CRLF / LF / bare CR per specification.
      for (const line of raw.split(/\r\n|\r|\n/)) {
        if (line === '') {
          if (dataLines.length > 0) {
            ssePayloads.push(dataLines.join('\n'));
            dataLines = [];
          }
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
      }
      if (dataLines.length > 0) ssePayloads.push(dataLines.join('\n'));

      if (ssePayloads.length > 0) {
        // Treat as SSE only if at least one frame yields a valid delta for the current API;
        // if a plain text response happens to contain lines starting with "data:", continue to JSON/text fallback.
        const deltas = ssePayloads
          .map((payload) => extractDelta(payload))
          .filter((delta) => delta !== '');
        if (deltas.length > 0) {
          let full = '';
          for (const delta of deltas) {
            full += delta;
            options.onChunk(delta);
          }
          this.logAIRequestDebug(startTime, { apiType, model, configId }, { responseLength: full.length }, { url: maskedUrl, streamed: true });
          return full;
        }
      }

      let text = '';
      try {
        text = extractFullTextFromResponse(apiType, JSON.parse(raw));
      } catch {
        text = raw;
      }
      if (!text) {
        this.logAIRequestDebug(startTime, { apiType, model, configId }, { error: 'request failed' }, { url: maskedUrl });
        throw new Error('No content received from AI service');
      }
      options.onChunk(text);
      this.logAIRequestDebug(startTime, { apiType, model, configId }, { responseLength: text.length }, { url: maskedUrl, streamed: false });
      return text;
    }

    if (!contentType.includes('text/event-stream')) {
      // When the server ignores stream:true, it may return a full JSON response (application/json) or plain text:
      // parse as JSON first to extract structured text, falling back to raw text as a single chunk.
      const raw = await response.text();
      let text = '';
      try {
        text = extractFullTextFromResponse(apiType, JSON.parse(raw));
      } catch {
        text = raw;
      }
      if (!text) {
        this.logAIRequestDebug(startTime, { apiType, model, configId }, { error: 'request failed' }, { url: maskedUrl });
        throw new Error('No content received from AI service');
      }
      options.onChunk(text);
      this.logAIRequestDebug(startTime, { apiType, model, configId }, { responseLength: text.length }, { url: maskedUrl, streamed: false });
      return text;
    }

    if (!response.body) {
      this.logAIRequestDebug(startTime, { apiType, model, configId }, { error: 'empty response body' }, { url: maskedUrl });
      throw new Error('No content received from AI service (empty body)');
    }
    let full = '';
    await consumeSseStream(response.body, (payload) => {
      const delta = extractDelta(payload);
      if (delta) {
        full += delta;
        options.onChunk(delta);
      }
    });

    this.logAIRequestDebug(startTime, { apiType, model, configId }, { responseLength: full.length }, { url: maskedUrl, streamed: true });
    if (!full.trim()) {
      throw new Error('No content received from AI service (stream)');
    }
    return full;
  }

  async generateChatText(options: {
    system: string;
    user: string;
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<string> {
    return await this.requestText({
      system: options.system,
      user: options.user,
      temperature: options.temperature ?? 0.2,
      maxTokens: options.maxTokens ?? 4000,
      signal: options.signal,
    });
  }

  /** Streaming version of generateChatText; transports that do not support streaming throw AIStreamUnsupportedError. */
  async generateChatTextStream(options: {
    system: string;
    user: string;
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    onChunk: (delta: string) => void;
  }): Promise<string> {
    return await this.requestTextStream({
      system: options.system,
      user: options.user,
      temperature: options.temperature ?? 0.2,
      maxTokens: options.maxTokens ?? 4000,
      signal: options.signal,
      onChunk: options.onChunk,
    });
  }

  /**
   * Native function calling (OpenAI chat completions wire format). Shares URL/auth/redirect guards
   * with generateChatText; executes a single request—multi-turn loops append returned tool_calls
   * and tool outputs to messages before invoking again. When the endpoint lacks tool support, throws
   * AIToolCallUnsupportedError so callers can fall back to an orchestrated loop.
   */
  async generateWithTools(options: {
    system: string;
    messages: AIToolLoopMessage[];
    tools: AIToolDefinition[];
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<{ content: string; toolCalls: AIToolCall[] }> {
    const apiType = this.getApiType();
    if (!supportsChatToolCalls(this.config)) {
      throw new AIToolCallUnsupportedError(`API type "${apiType}" does not support native tool calling`);
    }
    this.requireSecureDirectEndpoint();
    const startTime = Date.now();
    const model = this.config.model;
    const configId = this.config.id;
    const isDeepSeekReasoner = this.isDeepSeekReasonerModel();
    const isDeepSeekThinking = this.isDeepSeekThinkingModel();
    const isMiMoModel = this.isMiMoModel();
    const reasoning = this.getOpenAIReasoningPayload();

    const messages = [
      ...(options.system.trim() ? [{ role: 'system', content: options.system }] : []),
      ...options.messages.map((message): Record<string, unknown> => {
        if (message.role === 'assistant') {
          return {
            role: 'assistant',
            // Omit content when empty (null/''): explicit null and empty strings are rejected by
            // some gateways and models; omitting content on messages with tool_calls is the most
            // compatible wire format.
            ...(message.content ? { content: message.content } : {}),
            // Empty tool_calls combined with content:null produces payloads rejected by some gateways, so omit it entirely.
            ...(message.toolCalls.length > 0 ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
              })),
            } : {}),
          };
        }
        if (message.role === 'tool') {
          return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
        }
        return { role: message.role, content: message.content };
      }),
    ];

    const requestBody = {
      model: this.config.model,
      messages,
      tools: options.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
      tool_choice: 'auto',
      max_tokens: options.maxTokens ?? 4_000,
      ...(!isDeepSeekReasoner ? { temperature: options.temperature ?? 0 } : {}),
      ...(!isDeepSeekReasoner && !isDeepSeekThinking && !isMiMoModel && reasoning && apiType !== 'openai-compatible' ? { reasoning } : {}),
      ...(isMiMoModel || isDeepSeekThinking ? { thinking: { type: 'disabled' } } : {}),
    };

    const requestUrl = buildFinalApiUrl(this.config.baseUrl, apiType);
    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': 'Bearer ***',
    };
    let responseHeaders: Record<string, string> | undefined;
    let responseBodyPreview: string | undefined;
    let responseStatus: number | undefined;
    let data: Record<string, unknown>;

    if (backend.isAvailable) {
      // Proxy forwards the request body as-is (including tools field); response is still parsed by the client.
      try {
        data = await backend.proxyAIRequestWithFallback(this.config.id, this.config, requestBody, options.signal) as Record<string, unknown>;
      } catch (error) {
        // Proxy errors do not preserve upstream response body: identify endpoint tool rejections by status + message,
        // converting to AIToolCallUnsupportedError like the direct path so callers fall back to the orchestrated loop.
        const carrier = error as { status?: unknown; statusCode?: unknown };
        const status = typeof carrier.status === 'number' ? carrier.status : carrier.statusCode;
        const message = error instanceof Error ? error.message : String(error ?? '');
        if ((status === 400 || status === 404 || status === 422) && /\btools?\b|function/i.test(message)) {
          throw new AIToolCallUnsupportedError(`Endpoint rejected tool calling: ${message.slice(0, 200)}`);
        }
        throw error;
      }
    } else {
      const response = await fetch(requestUrl, {
        // Direct fetch includes API key; forbid following redirects to prevent credential leakage.
        redirect: 'error',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: options.signal,
      });
      responseHeaders = {};
      response.headers.forEach((v, k) => { responseHeaders![k] = v; });
      responseStatus = response.status;
      try {
        const cloned = response.clone();
        const text = await cloned.text();
        if (text.length > 0) {
          responseBodyPreview = text.length > 4000 ? text.slice(0, 4000) + '...[truncated]' : text;
        }
      } catch { /* body not readable */ }
      if (!response.ok) {
        const errorDetail = await this.extractErrorDetail(response);
        this.logAIRequestDebug(startTime, { apiType, model, configId }, { error: 'request failed' }, {
          url: requestUrl, requestHeaders, requestBody, responseHeaders, responseBody: responseBodyPreview, status: responseStatus,
        });
        const error = new AIRequestError(
          `AI API error: ${response.status} ${response.statusText}${errorDetail ? ` - ${errorDetail}` : ''}`,
          response.status,
          parseRetryAfterMs(response),
        );
        // Gateways lacking tool support typically reject with 4xx mentioning tools/function:
        // identify as missing capability rather than transient failure so callers fall back to the orchestrated loop.
        if ((response.status === 400 || response.status === 404 || response.status === 422) && /\btools?\b|function/i.test(errorDetail)) {
          throw new AIToolCallUnsupportedError(`Endpoint rejected tool calling: ${errorDetail.slice(0, 200)}`);
        }
        throw error;
      }
      data = await response.json();
    }

    const httpDetails = logger.isDebugMode() ? {
      url: requestUrl, requestHeaders, requestBody, responseHeaders, responseBody: responseBodyPreview, status: responseStatus,
    } : undefined;

    const message = (data as { choices?: OpenAIResponseChoice[] }).choices?.[0]?.message;
    const rawToolCalls = (message as { tool_calls?: unknown } | undefined)?.tool_calls;
    const toolCalls = Array.isArray(rawToolCalls)
      ? rawToolCalls.flatMap((call): AIToolCall[] => {
          if (!call || typeof call !== 'object') return [];
          const typed = call as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
          const name = typeof typed.function?.name === 'string' ? typed.function.name : '';
          if (!name) return [];
          return [{
            id: typeof typed.id === 'string' ? typed.id : `call_${name}`,
            name,
            arguments: typeof typed.function?.arguments === 'string' ? typed.function.arguments : '{}',
          }];
        })
      : [];
    const content = typeof message?.content === 'string' ? message.content : '';
    if (!content && toolCalls.length === 0) {
      this.logAIRequestDebug(startTime, { apiType, model, configId }, { error: 'request failed' }, httpDetails);
      throw new Error('No content or tool calls received from AI service');
    }
    this.logAIRequestDebug(startTime, { apiType, model, configId }, { responseLength: content.length + toolCalls.length }, httpDetails);
    return { content, toolCalls };
  }

  async analyzeRepository(repository: Repository, readmeContent: string, customCategories?: string[], categoryHints?: string, signal?: AbortSignal): Promise<RepositoryAnalysisResult> {
    const startTime = Date.now();
    const configId = this.config.id;
    const { full_name } = repository;
    const owner = full_name.split('/')[0] || '';
    const repo = full_name.split('/')[1] || full_name;
    logger.info('ai', 'AI analysis started', { owner, repo, configId });

    const prompt = this.config.useCustomPrompt && this.config.customPrompt
      ? this.createCustomAnalysisPrompt(repository, readmeContent, customCategories, categoryHints)
      : this.createAnalysisPrompt(repository, readmeContent, customCategories, categoryHints);

    try {
      const outputLanguageDirective = getOutputLanguageDirective(this.language);
      const system = this.language === 'zh'
        ? 'You are a professional GitHub repository analysis assistant. Please strictly analyze in the language specified by the user, regardless of the original content language. Please analyze repositories concisely in English, providing practical overviews, category tags, and supported platform types. Only output valid JSON. Do not output thinking process, Markdown, code block markers, or any extra text. The summary field must describe repository functionality only; never restate the prompt, output format, or JSON-only requirements.'
        : this.language === 'en'
          ? 'You are a professional GitHub repository analysis assistant. Please strictly analyze in the language specified by the user, regardless of the original content language. Please analyze repositories concisely in English, providing practical overviews, category tags, and supported platform types. Only output valid JSON. Do not output thinking process, Markdown, code block markers, or any extra text. The summary field must describe repository functionality only; never restate the prompt, output format, or JSON-only requirements.'
          : 'You are a professional GitHub repository analysis assistant. Analyze repositories concisely, providing practical overviews, category tags, and supported platform types. Only output valid JSON. Do not output thinking process, Markdown, code block markers, or any extra text. The summary field must describe repository functionality only; never restate the prompt, output format, or JSON-only requirements.'
            + (outputLanguageDirective ? `\n\n${outputLanguageDirective}` : '');

      let lastContent = '';
      let lastInvalidReason = '';

      for (let attempt = 1; attempt <= AIService.ANALYSIS_MAX_ATTEMPTS; attempt++) {
        const content = await this.requestText({
          system,
          user: attempt === 1
            ? prompt
            : this.createAnalysisRetryPrompt(prompt, lastContent, lastInvalidReason),
          temperature: attempt === 1 ? 0.3 : 0.1,
          maxTokens: AIService.ANALYSIS_MAX_TOKENS,
          signal,
        });

        const result = this.parseAIResponse(content);
        if (result.isValid) {
          logger.info('ai', 'AI analysis completed', {
            owner,
            repo,
            configId,
            attempts: attempt,
            durationMs: Date.now() - startTime,
          });
          return {
            summary: result.summary,
            tags: result.tags,
            platforms: result.platforms,
          };
        }

        lastContent = content;
        lastInvalidReason = result.invalidReason || (this.language === 'zh' ? 'Response did not meet requirements' : 'Response did not meet requirements');

        if (attempt < AIService.ANALYSIS_MAX_ATTEMPTS) {
          logger.warn('ai', 'AI analysis response invalid, retrying', {
            owner,
            repo,
            configId,
            attempt,
            invalidReason: lastInvalidReason,
          });
        }
      }

      throw new Error(this.language === 'zh'
        ? `AI response did not meet requirements after ${AIService.ANALYSIS_MAX_ATTEMPTS - 1} retries: ${lastInvalidReason}`
        : `AI response did not meet requirements after ${AIService.ANALYSIS_MAX_ATTEMPTS - 1} retries: ${lastInvalidReason}`);
    } catch (error) {
      logger.errorFromError('ai', 'AI analysis failed', error, { configId, durationMs: Date.now() - startTime });
      // Re-throw the error so callers can handle the failure state
      throw error;
    }
  }

  async analyzeGist(gist: Gist, contentPreview: string, signal?: AbortSignal): Promise<string> {
    const fileList = Object.values(gist.files || {})
      .map(file => `${file.filename}${file.language ? ` (${file.language})` : ''}, ${file.size} bytes`)
      .join('\n');

    const outputLanguageDirective = getOutputLanguageDirective(this.language);
    const system = this.language === 'zh'
      ? 'You are a professional GitHub Gist analysis assistant. Summarize the gist purpose, key content, and likely use case concisely in English. Output summary text only, no Markdown heading.'
      : this.language === 'en'
        ? 'You are a professional GitHub Gist analysis assistant. Summarize the gist purpose, key content, and likely use case concisely in English. Output summary text only, no Markdown heading.'
        : 'You are a professional GitHub Gist analysis assistant. Summarize the gist purpose, key content, and likely use case concisely. Output summary text only, no Markdown heading.'
          + (outputLanguageDirective ? `\n\n${outputLanguageDirective}` : '');

    const user = this.language === 'zh'
      ? `
Analyze this GitHub Gist and output an English summary under 80 words.

Description: ${this.sanitizeForPrompt(gist.description || 'No description')}
Owner: ${gist.owner?.login || 'Unknown'}
Files:
${this.sanitizeForPrompt(fileList || 'No files')}

Content preview:
${this.sanitizeForPrompt(contentPreview).slice(0, 6000)}
      `.trim()
      : this.language === 'en'
        ? `
Analyze this GitHub Gist and output an English summary under 80 words.

Description: ${this.sanitizeForPrompt(gist.description || 'No description')}
Owner: ${gist.owner?.login || 'Unknown'}
Files:
${this.sanitizeForPrompt(fileList || 'No files')}

Content preview:
${this.sanitizeForPrompt(contentPreview).slice(0, 6000)}
        `.trim()
        : `
Analyze this GitHub Gist and output a summary under 80 words.

Description: ${this.sanitizeForPrompt(gist.description || 'No description')}
Owner: ${gist.owner?.login || 'Unknown'}
Files:
${this.sanitizeForPrompt(fileList || 'No files')}

Content preview:
${this.sanitizeForPrompt(contentPreview).slice(0, 6000)}
${outputLanguageDirective ? `\n${outputLanguageDirective}` : ''}
        `.trim();

    return this.requestText({
      system,
      user,
      temperature: 0.25,
      maxTokens: 500,
      signal,
    });
  }

  /**
   * Batch translates text using the current AI configuration (used as the AI translation engine for README bilingual rendering).
   * Takes an array of strings and returns a translated array of equal length; the model outputs a JSON array,
   * throwing an error if parsing fails or counts do not match (callers retry on transient errors).
   * @param texts Input texts to translate (without Markdown block structures, typically paragraphs/headers/list items)
   * @param targetLanguage Target language code ('zh' | 'en', etc.)
   * @param sourceLanguage Optional source language code; auto-detected by the model when omitted
   * @param signal Optional AbortSignal
   */
  async translateTexts(
    texts: string[],
    targetLanguage: string,
    sourceLanguage?: string,
    signal?: AbortSignal
  ): Promise<string[]> {
    if (texts.length === 0) return [];

    const LANGUAGE_NAMES: Record<string, string> = {
      zh: 'Simplified Chinese',
      en: 'English',
      ja: 'Japanese',
      ko: 'Korean',
      'pt-BR': 'Brazilian Portuguese',
      fr: 'French',
      de: 'German',
      es: 'Spanish',
      ru: 'Russian',
      'zh-TW': 'Traditional Chinese',
      pt: 'Portuguese',
    };
    const targetName = LANGUAGE_NAMES[targetLanguage] || targetLanguage;
    const sourceName = sourceLanguage ? (LANGUAGE_NAMES[sourceLanguage] || sourceLanguage) : 'auto-detect';

    const system = this.language === 'zh'
      ? 'You are a professional machine translation engine. Translate each input text into the target language naturally. Rules: keep placeholders (e.g. {0}), inline HTML tags (e.g. <code>), proper nouns and commands untranslated; no explanations; output a JSON array of strings with exactly the same length as the input.'
      : 'You are a professional machine translation engine. Translate each input text into the target language naturally. Rules: keep placeholders (e.g. {0}), inline HTML tags (e.g. <code>), proper nouns and commands untranslated; no explanations; output a JSON array of strings with exactly the same length as the input.';

    const user = this.language === 'zh'
      ? `Target language: ${targetName}\nSource language: ${sourceName}\n\nTexts to translate (JSON array):\n${JSON.stringify(texts)}`
      : `Target language: ${targetName}\nSource language: ${sourceName}\n\nTexts to translate (JSON array):\n${JSON.stringify(texts)}`;

    const totalChars = texts.reduce((sum, t) => sum + t.length, 0);
    const raw = await this.requestText({
      system,
      user,
      temperature: 0.2,
      // Output must accommodate an equal-length translation: estimate from input length with JSON overhead
      maxTokens: Math.min(16000, Math.max(1024, Math.ceil(totalChars * 2) + 512)),
      signal,
    });

    const parsed = this.parseTranslationResponse(raw, texts.length);
    if (!parsed) {
      throw new Error('AI translation returned an invalid format');
    }
    return parsed;
  }

  /** Extracts a JSON string array from model output; tolerates code fences and surrounding text, returning null on failure. */
  private parseTranslationResponse(raw: string, expectedCount: number): string[] | null {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start === -1 || end <= start) return null;
    try {
      const data = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
      if (!Array.isArray(data) || data.length !== expectedCount) return null;
      if (!data.every((item): item is string => typeof item === 'string')) return null;
      return data;
    } catch {
      return null;
    }
  }

  /**
   * Analyzes an individual release's changelog, producing an easy-to-read Markdown summary ordered by importance.
   * Used by the "Summarize" button on Release list items. Returns raw Markdown text directly for caller rendering.
   * @param releaseBody Release body text (Markdown release notes)
   * @param meta Release metadata
   * @param signal Optional AbortSignal
   */
  async analyzeReleaseSummary(
    releaseBody: string,
    meta: { repoName: string; tagName: string; releaseName?: string },
    signal?: AbortSignal
  ): Promise<string> {
    const body = this.sanitizeForPrompt(releaseBody || '').slice(0, 12000);
    if (!body.trim()) {
      throw new Error(this.language === 'zh' ? 'Release body is empty, cannot analyze.' : 'Release body is empty, cannot analyze.');
    }

    const outputLanguageDirective = getOutputLanguageDirective(this.language);
    const system = this.language === 'zh'
      ? 'You are a professional GitHub Release changelog analysis assistant. Summarize this update in plain, easy-to-understand English. Output Markdown directly, without any extra explanation, code fences, or opening remarks such as "Here is the summary". Use a readable layout with lists, ordered from most to least important.'
      : this.language === 'en'
        ? 'You are a professional GitHub Release changelog analysis assistant. Summarize this update in plain, easy-to-understand English. Output Markdown directly, without any extra explanation, code fences, or opening remarks such as "Here is the summary". Use a readable layout with lists, ordered from most to least important.'
        : 'You are a professional GitHub Release changelog analysis assistant. Summarize this update in plain, easy-to-understand language. Output Markdown directly, without any extra explanation, code fences, or opening remarks such as "Here is the summary". Use a readable layout with lists, ordered from most to least important.'
          + (outputLanguageDirective ? `\n\n${outputLanguageDirective}` : '');

    const repoName = this.sanitizeForPrompt(meta.repoName);
    const tagName = this.sanitizeForPrompt(meta.tagName);
    const releaseName = meta.releaseName ? this.sanitizeForPrompt(meta.releaseName) : '';

    const user = this.language === 'zh'
      ? `
Below is the changelog of a GitHub Release for "${repoName}" (tag: ${tagName}${releaseName ? `, name: ${releaseName}` : ''}).

Requirements:
1. Summarize the update in plain language for general users.
2. Separate "New Features" from "Bug Fixes" where applicable (omit a section if empty).
3. Use lists (nested lists are fine), ordered from most to least important.
4. Output only Markdown content, no extra commentary.

Changelog:
${body}
      `.trim()
      : `
Below is the changelog of a GitHub Release for "${repoName}" (tag: ${tagName}${releaseName ? `, name: ${releaseName}` : ''}).

Requirements:
1. Summarize the update in plain language for general users.
2. Separate "New Features" from "Bug Fixes" where applicable (omit a section if empty).
3. Use lists (nested lists are fine), ordered from most to least important.
4. Output only Markdown content, no extra commentary.

Changelog:
${body}
      `.trim();

    const response = await this.requestText({
      system,
      user,
      temperature: 0.3,
      maxTokens: 4096,
      signal,
    });

    // Defensive handling: some models still wrap responses in ```markdown or ```;
    // strip leading/trailing code fence markers to prevent MarkdownRenderer from rendering as a code block.
    return response
      .replace(/^```(?:markdown)?[ \t]*\n?/i, '')
      .replace(/\n?[ \t]*```\s*$/i, '')
      .trim();
  }

  async searchGistsWithReranking(gists: Gist[], query: string): Promise<Gist[]> {
    if (gists.length === 0) return [];

    const gistSummaries = gists.slice(0, 120).map((gist, index) => {
      const files = Object.values(gist.files || {}).map(file => file.filename).join(', ');
      return `${index + 1}. ID: ${gist.id}
Description: ${gist.description || 'No description'}
Owner: ${gist.owner?.login || 'Unknown'}
Files: ${files || 'No files'}
AI Summary: ${gist.ai_summary || 'None'}`;
    }).join('\n\n');

    const system = this.language === 'zh'
      ? 'You are a GitHub Gist search reranking assistant. Return a JSON array of the most relevant gist ids for the user query. Do not output extra text.'
      : 'You are a GitHub Gist search reranking assistant. Return a JSON array of the most relevant gist ids for the user query. Do not output extra text.';

    const content = await this.requestText({
      system,
      user: `Query: ${query}\n\nGists:\n${this.sanitizeForPrompt(gistSummaries)}`,
      temperature: 0.1,
      maxTokens: AIService.RERANKING_MAX_TOKENS,
    });

    try {
      const jsonMatch = content.match(/\[[\s\S]*?\]/);
      const ids = JSON.parse(jsonMatch ? jsonMatch[0] : content);
      if (!Array.isArray(ids)) return gists;
      const gistById = new Map(gists.map(gist => [gist.id, gist]));
      const seen = new Set<string>();
      const ranked = ids
        .map(id => String(id))
        .filter(id => {
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        })
        .map(id => gistById.get(id))
        .filter((gist): gist is Gist => !!gist);
      const rankedIds = new Set(ranked.map(gist => gist.id));
      return [...ranked, ...gists.filter(gist => !rankedIds.has(gist.id))];
    } catch (error) {
      logger.warn('ai', 'Failed to parse gist reranking result', error);
      return gists;
    }
  }

  /**
   * Performs true semantic reranking on repository lists (following the gist reranking pattern).
   * Sends candidate repository summaries to the LLM to return an ID list ordered by relevance.
   * @param repositories Candidate repository list (typically vector search top-K results)
   * @param query User search query
   * @returns Repository list sorted by semantic relevance
   */
  async searchRepositoriesWithSemanticReranking(repositories: Repository[], query: string, signal?: AbortSignal): Promise<Repository[]> {
    if (repositories.length === 0) return [];

    // Limit candidate count to control token usage
    // Note: the searchTopK setting is independent of this limit; candidates beyond 50 will not be reranked
    const candidates = repositories.slice(0, 50);

    const system = this.language === 'zh'
      ? 'You are a GitHub repository search reranking assistant. Given a user query and candidate repositories, return a JSON array of repository IDs ordered from most to least relevant. Output only the JSON array, no extra text.'
      : 'You are a GitHub repository search reranking assistant. Given a user query and candidate repositories, return a JSON array of repository IDs ordered from most to least relevant. Output only the JSON array, no extra text.';

    const content = await this.requestText({
      system,
      user: `Query: ${query}\n\nRepositories:\n${this.sanitizeForPrompt(this.buildCandidateSummaries(candidates))}`,
      temperature: 0.1,
      maxTokens: AIService.RERANKING_MAX_TOKENS,
      signal,
    });

    const ranked = this.resolveRankedRepositories(content, candidates);
    if (ranked === null) {
      logger.warn('ai', 'Failed to parse semantic reranking result');
      return repositories;
    }
    const rankedIds = new Set(ranked.map(r => r.id));
    // Repositories not ranked by the LLM are appended to the end (preserving original order)
    return [...ranked, ...repositories.filter(r => !rankedIds.has(r.id))];
  }

  /**
   * Builds compact summaries of candidate repositories (index. ID | full_name / description / language | ★ | License | Tags).
   * Shared by both semantic reranking and vectorless selection.
   */
  private buildCandidateSummaries(candidates: Repository[]): string {
    return candidates.map((repo, index) => {
      const stars = repo.stargazers_count >= 1000
        ? `${(repo.stargazers_count / 1000).toFixed(0)}k`
        : String(repo.stargazers_count || 0);
      const tags = (repo.ai_tags || []).slice(0, 5).join(', ');
      const desc = (repo.ai_summary || repo.description || '').slice(0, 150);
      const parts = [`${index + 1}. ID: ${repo.id} | ${repo.full_name}`];
      if (desc) parts.push(`   ${desc}`);
      const meta = [repo.language, `★${stars}`];
      // Consistent with embedding: write only normalized, non-sentinel values to avoid raw objects becoming "[object Object]"
      const lic = normalizeLicense(repo.license);
      if (lic !== NO_LICENSE_SENTINEL) meta.push(`License: ${lic}`);
      if (tags) meta.push(`Tags: ${tags}`);
      parts.push(`   ${meta.join(' | ')}`);
      return parts.join('\n');
    }).join('\n\n');
  }

  /**
   * Parses the ranked repository list from model output. Matches by ID first; occasionally models
   * return candidate row indices (1..N) as IDs, which are resolved within candidate bounds to prevent
   * discarding the entire reranked result. Returns null on invalid response (no parseable JSON array,
   * or none of the IDs in a non-empty array could be matched); an empty array is a valid result (model explicitly deemed nothing relevant).
   */
  private resolveRankedRepositories(content: string, candidates: Repository[]): Repository[] | null {
    const jsonMatch = content.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return null;
    let ids: unknown[];
    try {
      const parsed = JSON.parse(jsonMatch[0]) as unknown;
      if (!Array.isArray(parsed)) return null;
      ids = parsed;
    } catch {
      return null;
    }
    const byId = new Map(candidates.map(repo => [String(repo.id), repo]));
    const seen = new Set<string>();
    const ranked: Repository[] = [];
    for (const raw of ids) {
      const key = String(raw).trim();
      let repo = byId.get(key);
      if (!repo) {
        // Real GitHub IDs are large integers and never collide with 1..N row numbers;
        // try ID match first and fall back to row number so both referencing styles resolve correctly.
        const ordinal = Number(key);
        if (Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= candidates.length) {
          repo = candidates[ordinal - 1];
        }
      }
      if (repo) {
        const idKey = String(repo.id);
        if (!seen.has(idKey)) {
          seen.add(idKey);
          ranked.push(repo);
        }
      }
    }
    // Non-empty response where zero IDs resolved: hallucinated IDs / invalid response, not an intentional empty result.
    // Return null to let callers fall back to lexical scores, avoiding presenting an invalid response as "no results".
    if (ids.length > 0 && ranked.length === 0) return null;
    return ranked;
  }

  private createAnalysisRetryPrompt(originalPrompt: string, previousContent: string, invalidReason: string): string {
    const previousOutput = this.sanitizeForPrompt(previousContent).slice(0, 1200);

    if (this.language === 'zh') {
      return `
The previous AI output did not meet the requirements. Reason: ${invalidReason}

Regenerate the result for the same repository information. Output exactly one valid JSON object. Do not output Markdown, code fences, explanations, or any extra text.

Mandatory requirements:
- summary must describe the repository functionality and purpose in no more than 50 words.
- summary must not restate the prompt, output format, field names, or JSON-only requirements.
- tags must be a string array.
- platforms must only use ["mac","windows","linux","ios","android","docker","web","cli"].

Original analysis task:
${originalPrompt}

Previous invalid output for correction only. Do not restate it:
${previousOutput}
      `.trim();
    }

    return `
The previous AI output did not meet the requirements. Reason: ${invalidReason}

Regenerate the result for the same repository information. Output exactly one valid JSON object. Do not output Markdown, code fences, explanations, or any extra text.

Mandatory requirements:
- summary must describe the repository functionality and purpose in no more than 50 words.
- summary must not restate the prompt, output format, field names, or JSON-only requirements.
- tags must be a string array.
- platforms must only use ["mac","windows","linux","ios","android","docker","web","cli"].

Original analysis task:
${originalPrompt}

Previous invalid output for correction only. Do not restate it:
${previousOutput}
    `.trim();
  }

  /**
   * Objective fact summary for Repository Health, reused across AI analysis prompts.
   *
   * Outputs only neutral facts and conservative observations, explicitly noting "not a quality verdict":
   * models should not penalize mature, stable projects simply because they lack recent commits.
   * Subjective scoring belongs to plugins (roadmap §4.3).
   * The analysis pipeline cannot access release lists, so release facts are excluded here—never guessed.
   */
  private formatRepositoryHealthFacts(repository: Repository): string {
    const zh = this.language === 'zh';
    const yes = zh ? 'yes' : 'yes';
    const no = zh ? 'no' : 'no';
    const unknown = zh ? 'unknown' : 'unknown';
    const toDate = (value?: string | null): string => {
      if (!value || !Number.isFinite(Date.parse(value))) return unknown;
      return new Date(value).toISOString().slice(0, 10);
    };

    const snapshot = deriveRepositoryHealthSnapshot(repository);
    // Tri-state rendering: `undefined` indicates "fact unavailable locally" and must output unknown;
    // using truthiness would turn it into "no", which falsifies a fact to the model.
    const tri = (value: boolean | undefined): string =>
      value === undefined ? unknown : value ? yes : no;
    const status = [
      `${zh ? 'archived' : 'archived'}=${tri(snapshot.archived)}`,
      `${zh ? 'disabled' : 'disabled'}=${tri(snapshot.disabled)}`,
      `${zh ? 'fork' : 'fork'}=${tri(snapshot.fork)}`,
      `${zh ? 'template' : 'template'}=${tri(snapshot.isTemplate)}`,
    ].join(', ');
    const observations = snapshot.signals.length
      ? snapshot.signals.map((signal) => signal.id).join(', ')
      : (zh ? 'none' : 'none');

    return [
      `${zh ? 'Status' : 'Status'}: ${status}`,
      `${zh ? 'Created' : 'Created'}: ${toDate(repository.created_at)} | ${zh ? 'Last push' : 'Last push'}: ${toDate(repository.pushed_at)}`,
      `License: ${repository.license || (zh ? 'none' : 'none')} | ${zh ? 'Open issues' : 'Open issues'}: ${repository.open_issues_count ?? unknown}`,
      `${zh ? 'Observations' : 'Observations'}: ${observations}`,
    ].join('\n');
  }

  private createCustomAnalysisPrompt(repository: Repository, readmeContent: string, customCategories?: string[], categoryHints?: string): string {
    const repoInfo = `
${this.language === 'zh' ? 'Repository Name' : 'Repository Name'}: ${repository.full_name}
${this.language === 'zh' ? 'Description' : 'Description'}: ${this.sanitizeForPrompt(repository.description || (this.language === 'zh' ? 'No description' : 'No description'))}
${this.language === 'zh' ? 'Programming Language' : 'Programming Language'}: ${repository.language || (this.language === 'zh' ? 'Unknown' : 'Unknown')}
${this.language === 'zh' ? 'Stars' : 'Stars'}: ${repository.stargazers_count}
${this.language === 'zh' ? 'Topics' : 'Topics'}: ${repository.topics?.join(', ') || (this.language === 'zh' ? 'None' : 'None')}
${this.language === 'zh' ? 'Objective facts (neutral, not a quality verdict)' : 'Objective facts (neutral, not a quality verdict)'}:
${this.sanitizeForPrompt(this.formatRepositoryHealthFacts(repository))}

${this.language === 'zh' ? 'README Content (first 2000 characters)' : 'README Content (first 2000 characters)'}:
${this.sanitizeForPrompt(readmeContent.substring(0, 2000))}
    `.trim();

    const categoriesInfo = customCategories && customCategories.length > 0 
      ? `\n\n${this.language === 'zh' ? 'Available Application Categories' : 'Available Application Categories'}: ${customCategories.join(', ')}`
      : '';

    let customPrompt = this.config.customPrompt || '';
    customPrompt = customPrompt.replace(/\{REPO_INFO\}/g, repoInfo);
    customPrompt = customPrompt.replace(/\{CATEGORIES_INFO\}/g, categoriesInfo);
    customPrompt = customPrompt.replace(/\{LANGUAGE\}/g, this.language);
    const sanitizedHints = this.sanitizeForPrompt(categoryHints || '');
    if (customPrompt.includes('{CATEGORIES_HINT}')) {
      customPrompt = customPrompt.replace(/\{CATEGORIES_HINT\}/g, sanitizedHints);
    } else if (sanitizedHints) {
      customPrompt = `${customPrompt.trim()}\n\n${this.language === 'zh'
        ? 'Custom category hints:\n' + sanitizedHints
        : 'Custom category hints:\n' + sanitizedHints}`;
    }

    const outputLanguageDirective = getOutputLanguageDirective(this.language);
    return outputLanguageDirective ? `${customPrompt.trim()}\n\n${outputLanguageDirective}` : customPrompt;
  }

  private createAnalysisPrompt(repository: Repository, readmeContent: string, customCategories?: string[], categoryHints?: string): string {
    const repoInfo = `
${this.language === 'zh' ? 'Repository Name' : 'Repository Name'}: ${repository.full_name}
${this.language === 'zh' ? 'Description' : 'Description'}: ${this.sanitizeForPrompt(repository.description || (this.language === 'zh' ? 'No description' : 'No description'))}
${this.language === 'zh' ? 'Programming Language' : 'Programming Language'}: ${repository.language || (this.language === 'zh' ? 'Unknown' : 'Unknown')}
${this.language === 'zh' ? 'Stars' : 'Stars'}: ${repository.stargazers_count}
${this.language === 'zh' ? 'Topics' : 'Topics'}: ${repository.topics?.join(', ') || (this.language === 'zh' ? 'None' : 'None')}
${this.language === 'zh' ? 'Objective facts (neutral, not a quality verdict)' : 'Objective facts (neutral, not a quality verdict)'}:
${this.sanitizeForPrompt(this.formatRepositoryHealthFacts(repository))}

${this.language === 'zh' ? 'README Content (first 2000 characters)' : 'README Content (first 2000 characters)'}:
${this.sanitizeForPrompt(readmeContent.substring(0, 2000))}
    `.trim();

    if (this.language === 'zh') {
      const categoriesLine = customCategories && customCategories.length > 0
        ? `\nAvailable categories (tags should prioritize these): ${customCategories.join(', ')}`
        : '';
      const hintLine = categoryHints && categoryHints.length > 0
        ? `\n\nCustom category hint: The following are user-defined custom categories with their keywords. When the repository keywords, description, Topics, or README clearly relate to these keywords, include the custom category name as-is in tags (3-5 tags total).\n${this.sanitizeForPrompt(categoryHints)}`
        : '';
      return `
Please analyze the following GitHub repository information and only output a valid JSON object. Do not output thinking process, Markdown, code block markers, explanations, or any extra text.

Requirements:
- summary: A concise overview explaining the main functionality and purpose, no more than 50 words.
  Do not include prompt restatements such as "asked to", "only output JSON", "based on repository information", or "summary/tags/platforms".
- tags: 3-5 application type tags${customCategories && customCategories.length > 0 ? ', please prioritize from the available categories above' : ', similar to app store categories such as: development tools, web apps, mobile apps, database, AI tools, etc.'}.${categoriesLine}${hintLine}
- platforms: Must only choose from ["mac","windows","linux","ios","android","docker","web","cli"]; use [] if unable to determine.

Output format:
{
  "summary": "overview",
  "tags": ["tag1", "tag2", "tag3"],
  "platforms": ["web", "cli"]
}

Platform hints:
Dockerfile/docker-compose=docker; CLI/command-line/terminal=cli; browser/frontend/API=web; iOS/Swift/Xcode=ios; Android/Kotlin/Gradle=android; macOS/Homebrew=mac; Windows/.exe/MSI=windows; Linux/systemd/apt=linux.

Repository information:
${repoInfo}
      `.trim();
    }

    const categoriesLine = customCategories && customCategories.length > 0
      ? `\nAvailable categories (tags should prioritize these): ${customCategories.join(', ')}`
      : '';
    const hintLine = categoryHints && categoryHints.length > 0
      ? `\n\nCustom category hint: The following are user-defined custom categories with their keywords. When the repository keywords, description, Topics, or README clearly relate to these keywords, include the custom category name as-is in tags (3-5 tags total).\n${this.sanitizeForPrompt(categoryHints)}`
      : '';
    const outputLanguageDirective = getOutputLanguageDirective(this.language);
    const summaryRequirement = this.language === 'en'
      ? 'A concise English overview explaining the main functionality and purpose, no more than 50 words.'
      : 'A concise overview explaining the main functionality and purpose, no more than 50 words.';
    const tagsRequirement = this.language === 'en'
      ? `3-5 English application type tags${customCategories && customCategories.length > 0 ? ', please prioritize from the available categories above' : ', similar to app store categories such as: development tools, web apps, mobile apps, database, AI tools, etc.'}.`
      : `3-5 application type tags${customCategories && customCategories.length > 0 ? ', please prioritize from the available categories above' : ', similar to app store categories such as: development tools, web apps, mobile apps, database, AI tools, etc.'}.`;
    const summaryExample = this.language === 'en' ? 'English overview' : 'overview';

    return `
Please analyze the following GitHub repository information and only output a valid JSON object. Do not output thinking process, Markdown, code block markers, explanations, or any extra text.

Requirements:
- summary: ${summaryRequirement}
  Do not include prompt restatements such as "asked to", "only output JSON", "based on repository information", or "summary/tags/platforms".
- tags: ${tagsRequirement}${categoriesLine}${hintLine}
- platforms: Must only choose from ["mac","windows","linux","ios","android","docker","web","cli"]; use [] if unable to determine.

Output format:
{
  "summary": "${summaryExample}",
  "tags": ["tag1", "tag2", "tag3"],
  "platforms": ["web", "cli"]
}

Platform hints:
Dockerfile/docker-compose=docker; CLI/command-line/terminal=cli; browser/frontend/API=web; iOS/Swift/Xcode=ios; Android/Kotlin/Gradle=android; macOS/Homebrew=mac; Windows/.exe/MSI=windows; Linux/systemd/apt=linux.

Repository information:
${repoInfo}${outputLanguageDirective ? `\n\n${outputLanguageDirective}` : ''}
    `.trim();
  }

  private static readonly VALID_PLATFORMS = ['mac', 'windows', 'linux', 'ios', 'android', 'docker', 'web', 'cli'];

  /**
   * Validates whether summary is a genuine repository overview.
   * If it matches prompt restatement patterns, it is flagged as invalid to trigger regeneration.
   */
  private sanitizeSummary(raw: string): string | null {
    if (!raw) return null;

    const cleaned = raw
      .trim()
      .replace(/^["'“”]+|["'“”]+$/g, '')
      .trim();

    if (cleaned.length < 3) return null;

    if (/^[\s.,;:!?\uff0c\u3002\uff1b\uff1a\uff01\uff1f\u3001]+$/.test(cleaned)) return null;

    const promptRestatementPatterns: RegExp[] = [
      // Chinese for "we/I was asked to output/analyze/summarize/provide/return"
      /^(?:\u6211\u4eec|\u6211)\u88ab\u8981\u6c42(?:\u53ea?\u8f93\u51fa|\u5206\u6790|\u8bc4\u4f30|\u603b\u7ed3|\u6982\u8ff0|\u4ecb\u7ecd|\u63d0\u4f9b|\u751f\u6210|\u8fd4\u56de)/i,
      // Chinese for "based on/according to given request/prompt/instruction"
      /^(?:\u6839\u636e|\u6309\u7167|\u57fa\u4e8e)(?:\u7ed9\u5b9a\u7684?)?(?:\u8981\u6c42|\u63d0\u793a|\u6307\u793a|\u4efb\u52a1|prompt|instruction)[\uff0c,\u3002.\s]/i,
      // Chinese for "based on repository info/description, provide summary/tags/platforms"
      /^(?:\u6839\u636e|\u6309\u7167|\u57fa\u4e8e)(?:\u7ed9\u5b9a\u7684?)?(?:\u4ed3\u5e93|\u9879\u76ee|repo|repository)(?:\u4fe1\u606f|\u63cf\u8ff0)?[\uff0c,\u3002.\s]*(?:\u9700\u8981|\u5e94|\u8981)?(?:\u63d0\u4f9b|\u8f93\u51fa|\u751f\u6210|\u8fd4\u56de)(?:\s*summary|\s*\u6458\u8981|\s*tags?|\s*platforms?)/i,
      // Chinese for "only output a valid JSON object"
      /(?:^|[\u3002\uff01\uff1f.!?]\s*)(?:\u53ea\u8f93\u51fa|\u8f93\u51fa)\s*(?:\u4e00\u4e2a)?(?:\u5408\u6cd5)?\s*JSON(?:\u5bf9\u8c61)?(?:[\uff0c,\u3002.!?]|$)/i,
      // Chinese for "do not output thinking/Markdown/code block/explanation/extra text"
      /(?:\u4e0d\u8981|\u4e0d\u5e94|\u4e0d\u80fd)(?:\u8f93\u51fa)?(?:\u4efb\u4f55)?(?:\u601d\u8003\u8fc7\u7a0b|Markdown|\u4ee3\u7801\u5757|\u89e3\u91ca|\u989d\u5916\u6587\u672c)/i,
      // Chinese for "provide summary, tags, and platforms"
      /(?:\u9700\u8981|\u8981\u6c42)(?:\u63d0\u4f9b|\u8f93\u51fa|\u751f\u6210|\u8fd4\u56de)\s*(?:summary|\u6458\u8981)[\u3001,\uff0c\s]*(?:tags?)[\u3001,\uff0c\s]*(?:\u548c|\u4e0e|and)?\s*platforms?/i,
      /\bsummary\b[\u3001,\uff0c/\s]*(?:tags?)[\u3001,\uff0c/\s]*(?:\u548c|\u4e0e|and)?\s*platforms?\b/i,
      /^(?:I|we)\s*(?:(?:have been|was|were|am)\s*)?(?:asked|instructed|told|requested)\b/i,
      /^(?:based|according)\s+(?:on|to)\s+(?:the\s+)?(?:request|prompt|instruction|task)[.,:;\s]/i,
      /^(?:based|according)\s+(?:on|to)\s+(?:the\s+)?(?:repository|repo|project)\s+(?:information|description)[.,:;\s]*(?:we\s+)?(?:need|should|must|will)?\s*(?:provide|output|generate|return)/i,
      /(?:^|[.!?]\s*)(?:only\s+output|output\s+only)\s+(?:one\s+)?(?:valid\s+)?json(?:\s+object)?(?:[.,!?]|$)/i,
      /(?:do\s+not|don't)\s+output\s+(?:any\s+)?(?:thinking|markdown|code\s+block|explanation|extra\s+text)/i,
      /(?:need|required|asked)\s+to\s+(?:provide|output|generate|return)\s+summary/i,
      /^(?:here|this)\s+(?:is|are)\s+(?:the|my|a)\s+(?:analysis|summary|result|overview)[.,:;\s]/i,
      /^(?:analysis|summary|overview)\s*(?:result|of)?[.:]\s*/i,
    ];

    if (promptRestatementPatterns.some((pattern) => pattern.test(cleaned))) return null;

    return cleaned;
  }

  private parseAIResponse(content: string): ParsedAIResponse {
    try {
      // Strip thinking tags that some models embed in the content field (e.g. <think>...</think>)
      // Also handle truncated tags (dangling <think> without </think>) from token exhaustion
      const cleaned = content
        .trim()
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<think>[\s\S]*$/gi, '')
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

      const parsed = this.extractAndParseAIJson(cleaned);
      if (parsed) {
        const rawSummary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
        const summary = this.sanitizeSummary(rawSummary);
        const tags = Array.isArray(parsed.tags) ? parsed.tags.filter((v) => typeof v === 'string').slice(0, 5) : [];
        const platforms = Array.isArray(parsed.platforms)
          ? Array.from(
              new Set(
                parsed.platforms
                  .filter((v): v is string => typeof v === 'string')
                  .map((v) => v.trim().toLowerCase())
                  .filter((v) => AIService.VALID_PLATFORMS.includes(v))
              )
            ).slice(0, 8)
          : [];

        if (!summary) {
          return {
            summary: '',
            tags,
            platforms,
            isValid: false,
            invalidReason: rawSummary
              ? (this.language === 'zh' ? 'summary contains prompt restatement or is not a repository overview' : 'summary contains prompt restatement or is not a repository overview')
              : (this.language === 'zh' ? 'summary is missing or empty' : 'summary is missing or empty'),
          };
        }

        return {
          summary,
          tags,
          platforms,
          isValid: true,
        };
      }

      return {
        summary: '',
        tags: [],
        platforms: [],
        isValid: false,
        invalidReason: this.language === 'zh' ? 'No valid JSON object returned' : 'No valid JSON object returned',
      };
    } catch (error) {
      logger.errorFromError('ai', 'Failed to parse AI response', error);
      return {
        summary: '',
        tags: [],
        platforms: [],
        isValid: false,
        invalidReason: this.language === 'zh' ? 'Failed to parse AI response' : 'Failed to parse AI response',
      };
    }
  }

  private extractAndParseAIJson(content: string): Record<string, unknown> | null {
    const direct = this.tryParseJsonObject(content);
    if (direct) return direct;

    const start = content.indexOf('{');
    if (start === -1) return null;

    let inString = false;
    let escaped = false;
    let depth = 0;

    for (let i = start; i < content.length; i++) {
      const char = content[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (char === '{') depth++;
      if (char === '}') {
        depth--;
        if (depth === 0) {
          return this.tryParseJsonObject(content.slice(start, i + 1));
        }
      }
    }

    return null;
  }

  private tryParseJsonObject(text: string): Record<string, unknown> | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;

    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const apiType = this.getApiType();
    const timeoutMs = apiType === 'openai-responses' || apiType === 'gemini' || this.config.reasoningEffort ? 30000 : 10000;

    try {
      const base = new URL(this.config.baseUrl);
      if (base.protocol !== 'http:' && base.protocol !== 'https:') {
        return {
          success: false,
          errorType: 'unknown',
          message: this.language === 'zh'
            ? 'Invalid protocol, please use http:// or https://'
            : 'Invalid protocol, please use http:// or https://',
        };
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const content = await this.requestText({
          system: 'You are a connection test assistant.',
          user: 'Reply with exactly one word: OK',
          temperature: 0,
          maxTokens: 2048,
          signal: controller.signal,
        });
        if (content) {
          return {
            success: true,
            message: this.language === 'zh' ? 'Connection successful' : 'Connection successful',
          };
        }
        return {
          success: false,
          errorType: 'unknown',
          message: this.language === 'zh' ? 'No content received' : 'No content received',
        };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      const err = error as Error;
      const errorMessage = err.message || '';

      // Parse status code
      const statusMatch = errorMessage.match(/(\d{3})/);
      const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : undefined;

      // Handle timeout errors
      if (errorMessage.includes('timeout') || errorMessage.includes('abort') || err.name === 'AbortError') {
        return {
          success: false,
          errorType: 'timeout',
          message: this.language === 'zh'
            ? `Connection timeout (${timeoutMs / 1000}s). Please check: 1. Network connection 2. API endpoint 3. Server response time`
            : `Connection timeout (${timeoutMs / 1000}s). Please check: 1. Network connection 2. API endpoint 3. Server response time`,
        };
      }

      // Handle network errors
      if (errorMessage.includes('fetch') || errorMessage.includes('network') || errorMessage.includes('Failed to fetch')) {
        return {
          success: false,
          errorType: 'network',
          message: this.language === 'zh'
            ? 'Network connection failed. Please check: 1. Network connection 2. API endpoint 3. Firewall or proxy settings'
            : 'Network connection failed. Please check: 1. Network connection 2. API endpoint 3. Firewall or proxy settings',
        };
      }

      // If status code is present, provide detailed error information
      if (statusCode) {
        const meaning = getStatusCodeMeaning(statusCode, this.language);
        const errorType = getErrorTypeFromStatus(statusCode) ?? 'unknown';
        const suggestions: Record<string, { zh: string; en: string }> = {
          auth: {
            zh: 'Please check if the API key is correct or expired',
            en: 'Please check if the API key is correct or expired',
          },
          timeout: {
            zh: 'Request timeout, please retry later or check network',
            en: 'Request timeout, please retry later or check network',
          },
          server: {
            zh: 'Server error, please retry later or contact provider',
            en: 'Server error, please retry later or contact provider',
          },
          unknown: {
            zh: 'Please check API endpoint, model name and request parameters',
            en: 'Please check API endpoint, model name and request parameters',
          },
        };

        return {
          success: false,
          statusCode,
          statusText: meaning,
          errorType,
          message: this.language === 'zh'
            ? `HTTP ${statusCode} - ${meaning}\nSuggestion: ${suggestions[errorType].zh}`
            : `HTTP ${statusCode} - ${meaning}\nSuggestion: ${suggestions[errorType].en}`,
        };
      }

      // Default error fallback
      return {
        success: false,
        errorType: 'unknown',
        message: this.language === 'zh'
          ? `Connection failed: ${errorMessage || 'Unknown error'}\nPlease check API endpoint, API key and model name`
          : `Connection failed: ${errorMessage || 'Unknown error'}\nPlease check API endpoint, API key and model name`,
      };
    }
  }

  /**
   * HyDE (Hypothetical Document Embedding) query preprocessing.
   * Generates an "ideal repository description" based on the user query, using it for vector generation instead of the raw query.
   * Significantly improves results for short queries, Chinese queries, and conceptual queries.
   * @param query Raw user query
   * @param signal Optional AbortSignal
   * @returns Generated ideal repository description (for vector embedding)
   */
  async generateHyDEQuery(query: string, signal?: AbortSignal): Promise<string> {
    const system = this.language === 'zh'
      ? 'You are a search assistant. Given a user search query, generate a 2-3 sentence description of the ideal GitHub repository that would perfectly match this query. Include relevant technical terms, programming languages, and use cases. Output only the description, no extra text.'
      : 'You are a search assistant. Given a user search query, generate a 2-3 sentence description of the ideal GitHub repository that would perfectly match this query. Include relevant technical terms, programming languages, and use cases. Output only the description, no extra text.';

    const content = await this.requestText({
      system,
      user: `Search query: "${query}"`,
      temperature: 0.3,
      maxTokens: 200,
      signal,
    });

    // Clean up potential quotes or extra whitespace
    return content.replace(/^["']|["']$/g, '').trim() || query;
  }

  /**
   * Vectorless AI semantic search fallback chain (when vector search is unavailable).
   * Three-phase workflow:
   * ① Query expansion + intent restatement (single chat invocation);
   * ② Local lexical scoring to recall candidates (full library for small repos; top-K for large repos to decouple token cost from library size);
   * ③ LLM selection and reranking (returns only truly relevant repositories, up to 20).
   * Key difference from legacy implementations (LLM keyword expansion + local OR substring filter):
   * the LLM inspects repository summaries directly to determine results and ranking.
   * If LLM calls or parsing fail, falls back to lexical score ranking;
   * when the model explicitly indicates "no relevant results", returns an empty array (UI renders empty state rather than noise).
   */
  async searchRepositoriesWithSelection(
    repositories: Repository[],
    query: string,
    options: {
      signal?: AbortSignal;
      /** Search phase callback for UI progress indicators (query expansion -> candidate selection). */
      onPhase?: (phase: 'expanding' | 'selecting') => void;
      /** Fallback callback when AI selection yields no results, informing the UI of the reason: ai_failed=request/config failure,
       *  unparseable=unparseable response, ai_empty=model determined no repositories are relevant. */
      onFallback?: (reason: 'ai_failed' | 'unparseable' | 'ai_empty') => void;
    } = {}
  ): Promise<Repository[]> {
    const startTime = Date.now();
    if (!query.trim()) return repositories;
    const { signal, onPhase, onFallback } = options;
    let aiTerms: string[] = [];
    let intent = '';

    try {
      logger.info('ai', 'Starting AI selection search', { apiType: this.getApiType(), model: this.config.model, configId: this.config.id, query });

      // ① Query expansion + intent restatement. Reasoning models share token budget between thinking and output;
      //    insufficient budget truncates JSON midway (e.g. 300 tokens is insufficient for GLM reasoning models),
      //    so ample budget is provided; non-reasoning models only charge for actual usage with no overhead.
      onPhase?.('expanding');
      const system = this.language === 'zh'
        ? 'You are an intelligent search assistant. Please analyze user search intent, extract keywords and provide multilingual translations.'
        : 'You are an intelligent search assistant. Please analyze user search intent, extract keywords and provide multilingual translations.';
      const content = await this.requestText({
        system,
        user: this.createSearchPrompt(query),
        temperature: 0.1,
        maxTokens: 2000,
        signal,
      });
      if (content) {
        const parsed = this.parseSearchResponse(content);
        aiTerms = parsed.terms;
        intent = parsed.intent;
      }

      // ② Candidate recall
      let candidates: Repository[];
      if (repositories.length <= AIService.SELECTION_FULL_LIBRARY_LIMIT) {
        // Small library: pass all repositories directly (LLM context is sufficient; recall phase adds no value)
        candidates = [...repositories].sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0));
      } else {
        const scored = this.scoreRepositoriesByKeywords(repositories, query, aiTerms);
        candidates = scored.slice(0, AIService.SELECTION_CANDIDATE_LIMIT).map(item => item.repo);
        if (candidates.length < AIService.SELECTION_MIN_CANDIDATES) {
          // Insufficient lexical matches (e.g. pure semantic query): backfill by star count to ensure sufficient candidates for the LLM
          const have = new Set(candidates.map(repo => repo.id));
          const pad = [...repositories]
            .sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0))
            .filter(repo => !have.has(repo.id));
          candidates = candidates.concat(pad.slice(0, AIService.SELECTION_CANDIDATE_LIMIT - candidates.length));
        }
      }
      if (candidates.length === 0) return [];

      // ③ LLM selection and reranking
      onPhase?.('selecting');
      const ranked = await this.selectRelevantRepositories(candidates, query, intent, signal);
      if (ranked === null) {
        // Missing response or invalid format: fall back to lexical score ranking
        onFallback?.('unparseable');
        logger.warn('ai', 'AI selection returned unparseable result, falling back to lexical ranking', { configId: this.config.id, durationMs: Date.now() - startTime });
        return this.performEnhancedBasicSearch(repositories, query, aiTerms)
          .slice(0, AIService.SELECTION_CANDIDATE_LIMIT);
      }
      if (ranked.length === 0) {
        // Model explicitly determined no relevant repositories: respect decision and return empty state while notifying caller
        onFallback?.('ai_empty');
        logger.info('ai', 'AI selection found no relevant repositories', { configId: this.config.id, durationMs: Date.now() - startTime });
        return [];
      }
      logger.info('ai', 'AI selection completed', {
        apiType: this.getApiType(),
        model: this.config.model,
        configId: this.config.id,
        candidates: candidates.length,
        resultCount: ranked.length,
        durationMs: Date.now() - startTime,
      });
      return ranked;
    } catch (error) {
      // User aborted request: do not produce fallback results; propagate upward for caller handling
      if (signal?.aborted || isAbortError(error)) throw error;
      onFallback?.('ai_failed');
      logger.warn('ai', 'AI selection failed, falling back to lexical ranking', {
        apiType: this.getApiType(),
        model: this.config.model,
        configId: this.config.id,
        durationMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.performEnhancedBasicSearch(repositories, query, aiTerms)
        .slice(0, AIService.SELECTION_CANDIDATE_LIMIT);
    }
  }

  /**
   * Passes candidate repository summaries to the LLM to select truly relevant repositories and rank by relevance.
   * Returning null indicates a missing/unparseable response (caller falls back to lexical ranking);
   * an empty array is a valid result (model determined no repositories satisfy query intent).
   */
  private async selectRelevantRepositories(
    candidates: Repository[],
    query: string,
    intent: string,
    signal?: AbortSignal
  ): Promise<Repository[] | null> {
    const summaries = this.sanitizeForPrompt(this.buildCandidateSummaries(candidates));
    const intentLine = intent
      ? (this.language === 'zh'
        ? `\n\nQuery intent: ${this.sanitizeForPrompt(intent)}`
        : `\n\nQuery intent: ${this.sanitizeForPrompt(intent)}`)
      : '';

    const system = this.language === 'zh'
      ? 'You are a GitHub repository search reranking assistant. Select the repositories that truly match the user query and return their IDs as a JSON array ordered from most to least relevant. The ID is the real repository ID (a long number) from the candidate list; never use ordinals or line numbers. Output only the JSON array, no extra text. If no repository satisfies the query intent, return an empty array [].'
      : 'You are a GitHub repository search reranking assistant. Select the repositories that truly match the user query and return their IDs as a JSON array ordered from most to least relevant. The ID is the real repository ID (a long number) from the candidate list; never use ordinals or line numbers. Output only the JSON array, no extra text. If no repository satisfies the query intent, return an empty array [].';

    const user = this.language === 'zh'
      ? `User query: "${this.sanitizeForPrompt(query)}"${intentLine}\n\nCandidate repositories (${candidates.length} total):\n${summaries}\n\nRequirements:\n- Keep only repositories that satisfy the query intent; if none truly do, return [] instead of padding with loosely related ones.\n- When relevance is similar, prefer higher stars and more active projects.\n- Return at most ${AIService.SELECTION_MAX_RESULTS} IDs.`
      : `User query: "${this.sanitizeForPrompt(query)}"${intentLine}\n\nCandidate repositories (${candidates.length} total):\n${summaries}\n\nRequirements:\n- Keep only repositories that satisfy the query intent; if none truly do, return [] instead of padding with loosely related ones.\n- When relevance is similar, prefer higher stars and more active projects.\n- Return at most ${AIService.SELECTION_MAX_RESULTS} IDs.`;

    const content = await this.requestText({
      system,
      user,
      temperature: 0.1,
      // Reasoning tokens share budget with output (OpenAI reasoning models, Gemini 2.5 thinking models):
      // small budgets get consumed by reasoning resulting in empty content and silent degradation;
      // reuse the 4096 budget from reranking; standard models use 800 tokens, which easily fits ≤20 IDs in a JSON array.
      maxTokens: (this.config.reasoningEffort || this.getApiType() === 'gemini')
        ? AIService.RERANKING_MAX_TOKENS
        : AIService.SELECTION_MAX_TOKENS,
      signal,
    });

    const ranked = this.resolveRankedRepositories(content, candidates);
    if (ranked === null) return null;
    return ranked.slice(0, AIService.SELECTION_MAX_RESULTS);
  }

  /**
   * Lexical weighted scoring (shared between candidate recall and failure fallback).
   * Query terms receive high weights; AI expansion terms are weaker signals used only for recall and bonus points (~60% of query term weight).
   */
  private scoreRepositoriesByKeywords(repositories: Repository[], query: string, aiTerms: string[]): Array<{ repo: Repository; score: number }> {
    const normalizedQuery = query.toLowerCase();
    const queryWords = normalizedQuery.split(/\s+/).filter(word => word.length > 0);
    // Deduplicate and filter out expansion terms identical to any query word:
    // avoids double-counting the same hit across query words and expansion terms (filtered word-by-word, not just exact query string)
    const querySet = new Set([normalizedQuery, ...queryWords]);
    // Chinese queries lack whitespace word segmentation; entire substrings against English metadata almost always yield zero matches
    // (leading to empty results during AI failure fallback): segment continuous CJK runs into bigrams as weak-signal terms for recall
    // and scoring. Used only in AI search's lexical path; performBasicTextSearch in the search input remains unaffected.
    const cjkTerms = AIService.extractCjkBigrams(normalizedQuery).filter(bigram => !querySet.has(bigram));
    const terms = [
      ...new Set([
        ...aiTerms.map(term => term.toLowerCase()).filter(term => term && !querySet.has(term)),
        ...cjkTerms,
      ]),
    ];

    const scoredRepos: Array<{ repo: Repository; score: number }> = [];
    for (const repo of repositories) {
      let score = 0;

      const searchableFields = {
        name: repo.name.toLowerCase(),
        fullName: repo.full_name.toLowerCase(),
        description: (repo.description || '').toLowerCase(),
        language: (repo.language || '').toLowerCase(),
        topics: (repo.topics || []).join(' ').toLowerCase(),
        aiSummary: (repo.ai_summary || '').toLowerCase(),
        aiTags: (repo.ai_tags || []).join(' ').toLowerCase(),
        aiPlatforms: (repo.ai_platforms || []).join(' ').toLowerCase(),
        customDescription: (repo.custom_description || '').toLowerCase(),
        customTags: (repo.custom_tags || []).join(' ').toLowerCase(),
        license: normalizeLicense(repo.license).toLowerCase(),
      };

      // Exclude repositories with zero matches (neither query words nor expansion terms matched)
      const hasMatch = queryWords.some(word => {
        return Object.values(searchableFields).some(fieldValue => {
          return fieldValue.includes(word);
        });
      }) || terms.some(term => {
        return Object.values(searchableFields).some(fieldValue => {
          return fieldValue.includes(term);
        });
      });

      if (!hasMatch) continue;

      // Calculate relevance score
      queryWords.forEach(word => {
        // Name matches (highest weight)
        if (searchableFields.name.includes(word)) score += 0.4;
        if (searchableFields.fullName.includes(word)) score += 0.35;

        // Description matches
        if (searchableFields.description.includes(word)) score += 0.3;
        if (searchableFields.customDescription.includes(word)) score += 0.32;

        // Tags and topics matches
        if (searchableFields.topics.includes(word)) score += 0.25;
        if (searchableFields.aiTags.includes(word)) score += 0.22;
        if (searchableFields.customTags.includes(word)) score += 0.24;

        // AI summary matches
        if (searchableFields.aiSummary.includes(word)) score += 0.15;

        // Platform and language matches
        if (searchableFields.aiPlatforms.includes(word)) score += 0.18;
        if (searchableFields.language.includes(word)) score += 0.12;

        // License matches
        if (searchableFields.license.includes(word)) score += 0.2;
      });

      // AI expansion terms: lower-weighted matches across fields
      terms.forEach(term => {
        if (searchableFields.name.includes(term)) score += 0.25;
        if (searchableFields.fullName.includes(term)) score += 0.2;
        if (searchableFields.customDescription.includes(term)) score += 0.2;
        if (searchableFields.description.includes(term)) score += 0.18;
        if (searchableFields.topics.includes(term)) score += 0.15;
        if (searchableFields.aiTags.includes(term)) score += 0.13;
        if (searchableFields.customTags.includes(term)) score += 0.14;
        if (searchableFields.aiPlatforms.includes(term)) score += 0.1;
        if (searchableFields.aiSummary.includes(term)) score += 0.1;
        if (searchableFields.license.includes(term)) score += 0.12;
        if (searchableFields.language.includes(term)) score += 0.08;
      });

      // Boost for exact matches
      if (searchableFields.name === normalizedQuery) score += 0.5;
      if (searchableFields.name.includes(normalizedQuery)) score += 0.3;

      // Popularity boost (logarithmic to avoid overwhelming other factors)
      const popularityScore = Math.log10(repo.stargazers_count + 1) * 0.05;
      score += popularityScore;

      scoredRepos.push({ repo, score });
    }

    scoredRepos.sort((a, b) => b.score - a.score);
    return scoredRepos;
  }

  /** Lexical score fallback ranking: retains only repositories with score > 0, ordered descending. */
  private performEnhancedBasicSearch(repositories: Repository[], query: string, aiTerms: string[] = []): Repository[] {
    return this.scoreRepositoriesByKeywords(repositories, query, aiTerms)
      .filter(item => item.score > 0)
      .map(item => item.repo);
  }

  /**
   * Segments continuous CJK runs in text into bigrams (e.g. bigrams from continuous CJK runs),
   * deduplicated and capped. Because Chinese lacks space segmentation, full substring matching against English metadata
   * almost always fails; bigrams are the lowest-cost recall mechanism without external dictionary dependencies.
   */
  private static extractCjkBigrams(text: string): string[] {
    const cjkRuns = text.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/g) || [];
    const bigrams: string[] = [];
    for (const run of cjkRuns) {
      if (run.length === 1) {
        bigrams.push(run);
        continue;
      }
      for (let i = 0; i < run.length - 1; i++) {
        bigrams.push(run.slice(i, i + 2));
      }
    }
    return [...new Set(bigrams)].slice(0, 12);
  }

  private createSearchPrompt(query: string): string {
    if (this.language === 'zh') {
      return `
User search query: "${query}"

Please analyze this search query and provide:
1. One sentence restating the user's true search intent (max 30 words)
2. Main keywords (in English and Chinese)
3. Related technical terms and synonyms
4. Possible application types or categories

Reply in JSON format:
{
  "intent": "One sentence restating the user's true search intent",
  "keywords": ["keyword1", "\u5173\u952e\u8bcd1", "keyword2", "\u5173\u952e\u8bcd2"],
  "categories": ["category1", "\u5206\u7c7b1"],
  "synonyms": ["synonym1", "\u540c\u4e49\u8bcd1"]
}
      `.trim();
    } else {
      return `
User search query: "${query}"

Please analyze this search query and provide:
1. One sentence restating the user's true search intent (max 30 words)
2. Main keywords (in English and Chinese)
3. Related technical terms and synonyms
4. Possible application types or categories

Reply in JSON format:
{
  "intent": "One sentence restating the user's true search intent",
  "keywords": ["keyword1", "\u5173\u952e\u8bcd1", "keyword2", "\u5173\u952e\u8bcd2"],
  "categories": ["category1", "\u5206\u7c7b1"],
  "synonyms": ["synonym1", "\u540c\u4e49\u8bcd1"]
}
      `.trim();
    }
  }

  private parseSearchResponse(content: string): { terms: string[]; intent: string } {
    try {
      const parsed = this.extractAndParseAIJson(content);
      if (parsed) {
        const terms = [
          ...(Array.isArray(parsed.keywords) ? parsed.keywords : []),
          ...(Array.isArray(parsed.categories) ? parsed.categories : []),
          ...(Array.isArray(parsed.synonyms) ? parsed.synonyms : []),
        ]
          .filter((term): term is string => typeof term === 'string' && term.trim().length > 0)
          .map(term => term.trim());
        const intent = typeof parsed.intent === 'string' ? parsed.intent.trim() : '';
        return { terms: [...new Set(terms)], intent: intent.slice(0, 100) };
      }
    } catch (error) {
      logger.warn('ai', 'Failed to parse AI search response', { error: String(error) });
    }
    return { terms: [], intent: '' };
  }

  static async searchRepositories(repositories: Repository[], query: string): Promise<Repository[]> {
    // This is a static fallback method for when no AI config is available
    if (!query.trim()) return repositories;

    const normalizedQuery = query.toLowerCase();
    
    return repositories.filter(repo => {
      const searchableText = [
        repo.name,
        repo.full_name,
        repo.description || '',
        repo.language || '',
        ...(repo.topics || []),
        repo.ai_summary || '',
        ...(repo.custom_tags || []),
        ...(repo.ai_tags || []),
        ...(repo.ai_platforms || []),
        normalizeLicense(repo.license),
      ].join(' ').toLowerCase();

      // Split query into words and check if all words are present
      const queryWords = normalizedQuery.split(/\s+/);
      return queryWords.every(word => searchableText.includes(word));
    });
  }
}
