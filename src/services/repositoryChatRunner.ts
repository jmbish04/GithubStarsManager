import { isAIToolCallUnsupportedError, supportsChatToolCalls } from './aiService';
import {
  runEvidenceDrivenRepositoryChatTurn,
  type RepositoryChatTurnInput,
  type RepositoryChatTurnResult,
} from './repositoryChatService';
import { runToolLoopRepositoryChatTurn } from './agentToolLoop';

/**
 * Execution entry point for repository chat: dispatches between two execution loops based on
 * settings and AI configuration capabilities. Split into a separate module to preserve unidirectional
 * dependencies—repositoryChatService (orchestrated loop and shared evidence collection foundation)
 * and agentToolLoop (controlled tool loop) do not reference each other.
 */

/** The backend proxy channel does not preserve the AIToolCallUnsupportedError type; fall back to 4xx configuration status codes to detect endpoint rejections. */
const isEndpointRejectionError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const carrier = error as { status?: unknown; statusCode?: unknown };
  const status = carrier.status ?? carrier.statusCode;
  return status === 400 || status === 404 || status === 422;
};

export const runRepositoryChatTurn = async (input: RepositoryChatTurnInput): Promise<RepositoryChatTurnResult> => {
  // Controlled tool loop (experimental): enabled only when the setting is active, the AI configuration
  // protocol family supports it, and the user explicitly enabled tool calls. Automatically falls back
  // to the orchestrated loop for this turn if the endpoint rejects tool calls.
  if (input.enableAgentToolLoop && supportsChatToolCalls(input.aiConfig)) {
    try {
      return await runToolLoopRepositoryChatTurn(input);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      if (!isAIToolCallUnsupportedError(error) && !isEndpointRejectionError(error)) throw error;
    }
  }
  return await runEvidenceDrivenRepositoryChatTurn(input);
};
