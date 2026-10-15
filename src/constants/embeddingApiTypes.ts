import type { EmbeddingApiType } from '../types';

/**
 * Embedding model sources (the "Model source" button group on the settings page). Placed in the
 * constants layer for the same reason as aiCapabilities.ts: the settings view component and the
 * i18n dictionary key coverage test share the same source of truth, so missing display text for a
 * newly added source fails tests immediately, preventing raw keys from appearing in the UI.
 * (ADR 0001: View components do not directly depend on services.)
 */
export const EMBEDDING_API_TYPES: readonly EmbeddingApiType[] = [
  'openai',
  'openai-compatible',
  'siliconflow',
  'gemini',
  'cohere',
  'ollama',
];

/** Default vector dimensions for each source, prefilled when switching sources; must match the Vectorize index dimensions. */
export const DEFAULT_EMBEDDING_DIMENSIONS: Record<EmbeddingApiType, number> = {
  openai: 1536,
  'openai-compatible': 1536,
  siliconflow: 1024,
  gemini: 768,
  cohere: 1024,
  ollama: 768,
};

/**
 * Translation dictionary key for display text (app namespace): suffix maps one-to-one with EmbeddingApiType values,
 * e.g., 'siliconflow' → 'vectorSearchSettings.api-type-siliconflow'.
 */
export const embeddingApiTypeLabelKey = (apiType: EmbeddingApiType): string =>
  `vectorSearchSettings.api-type-${apiType}`;
