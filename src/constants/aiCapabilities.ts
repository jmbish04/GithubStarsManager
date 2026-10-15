import type { AIApiType } from '../types';

/**
 * Native tool calling currently only covers the OpenAI chat completions wire protocol family
 * (other protocols use an orchestrated loop). Constants are placed in the constants layer:
 * runtime capability checks in aiService and checkbox options in the settings UI share the
 * same source of truth to avoid drift, while adhering to the layering rule that view
 * components must not directly depend on services (ADR 0001).
 */
export const CHAT_TOOL_CALL_API_TYPES: ReadonlySet<AIApiType> = new Set<AIApiType>(['openai', 'deepseek', 'mimo', 'openai-compatible']);

/** Whether the protocol family itself belongs to the tool-calling-capable group (used only for displaying checkbox options in the UI). */
export function isToolCallCapableApiType(apiType?: AIApiType): boolean {
  return CHAT_TOOL_CALL_API_TYPES.has(apiType || 'openai');
}
