export interface RepositoryChatSession {
  id: string;
  repoId: number;
  repoFullName: string;
  sourceRefSha: string;
  title: string;
  summary?: string;
  modelConfigId?: string | null;
  modelLabelAtTime?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface RepositoryChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  status: 'complete' | 'streaming' | 'error' | 'aborted';
  evidenceIds: string[];
  createdAt: string;
}

export type RepositoryChatExecutionStage =
  | 'understanding'
  | 'context'
  | 'planning'
  | 'retrieval'
  | 'verification'
  | 'replanning'
  | 'escalation'
  | 'answer';

export interface RepositoryChatToolEvent {
  id: string;
  sessionId: string;
  messageId: string;
  toolName: string;
  status: 'pending' | 'running' | 'success' | 'error';
  paramSummary: string;
  stage?: RepositoryChatExecutionStage;
  round?: number;
  detail?: string;
  durationMs?: number;
  resultSize?: number;
  evidenceId?: string;
  createdAt: string;
}

export interface ToolEvidence {
  id: string;
  source: 'github' | 'existing-vector' | 'web';
  repoFullName: string;
  refSha?: string;
  path?: string;
  lineStart?: number;
  lineEnd?: number;
  url: string;
  contentHash?: string;
  excerpt: string;
  retrievedAt: string;
}

export interface RepositoryChatAgentBudget {
  maxTurns: number;
  maxToolCalls: number;
  maxReadFiles: number;
  maxCodeReads: number;
  /** Consecutive rounds that add no new cited evidence before bounded stop. */
  maxNoProgressRounds: number;
  maxDurationMs: number;
}

/**
 * Task depth tiers in the chat view. 'default' follows the agentBudget configured
 * on the settings page; other tiers override the budget with fixed presets (see TASK_DEPTH_PRESETS).
 */
export type RepositoryChatTaskDepth = 'default' | 'quick' | 'deep' | 'unlimited';

export interface RepositoryChatTaskDepthPreset {
  budget: RepositoryChatAgentBudget;
  answerMaxTokens: number;
}

/** Budget presets for non-default tiers; maxTurns is at least 2 for all (testing showed 1 retrieval turn is insufficient for answers). */
export const TASK_DEPTH_PRESETS: Record<Exclude<RepositoryChatTaskDepth, 'default'>, RepositoryChatTaskDepthPreset> = {
  quick: {
    budget: { maxTurns: 2, maxToolCalls: 8, maxReadFiles: 4, maxCodeReads: 1, maxNoProgressRounds: 1, maxDurationMs: 60_000 },
    answerMaxTokens: 2_000,
  },
  deep: {
    budget: { maxTurns: 5, maxToolCalls: 32, maxReadFiles: 12, maxCodeReads: 6, maxNoProgressRounds: 3, maxDurationMs: 180_000 },
    answerMaxTokens: 6_000,
  },
  unlimited: {
    budget: { maxTurns: 8, maxToolCalls: 96, maxReadFiles: 24, maxCodeReads: 16, maxNoProgressRounds: 4, maxDurationMs: 600_000 },
    answerMaxTokens: 8_000,
  },
};

/** Default max_tokens for the answer phase (used by the 'default' tier). */
export const DEFAULT_ANSWER_MAX_TOKENS = 4_000;

export interface RepositoryChatSettings {
  enabled: boolean;
  chatConfigId: string | null;
  streamingMode: 'auto' | 'off';
  taskDepth: RepositoryChatTaskDepth;
  enableWebTools: boolean;
  retainSessionDays: number;
  /**
   * Experimental: uses a controlled tool loop with model-native function calling for Q&A evidence retrieval.
   * Only takes effect when the Q&A model's AI configuration has "supports tool calls" checked; otherwise
   * automatically falls back to the orchestrated loop. Off by default.
   */
  enableAgentToolLoop: boolean;
  /**
   * Kept for persisted configurations created before the evidence-driven loop.
   * New callers should use agentBudget.maxToolCalls.
   */
  maxToolsPerTurn: number;
  agentBudget: RepositoryChatAgentBudget;
}

export const defaultRepositoryChatAgentBudget: RepositoryChatAgentBudget = {
  maxTurns: 4,
  maxToolCalls: 20,
  maxReadFiles: 8,
  maxCodeReads: 3,
  maxNoProgressRounds: 2,
  maxDurationMs: 90_000,
};

export const defaultRepositoryChatSettings: RepositoryChatSettings = {
  enabled: true,
  chatConfigId: null,
  streamingMode: 'auto',
  taskDepth: 'default',
  enableWebTools: false,
  enableAgentToolLoop: false,
  retainSessionDays: 90,
  maxToolsPerTurn: defaultRepositoryChatAgentBudget.maxToolCalls,
  agentBudget: { ...defaultRepositoryChatAgentBudget },
};
