



import { makeT, useT } from '../../../i18n/useT';
import type { AppLanguage } from '../../../i18n/languages';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import type { Repository } from '../../../types';
import type {
  RepositoryChatMessage,
  RepositoryChatSession,
  RepositoryChatToolEvent,
  ToolEvidence,
} from '../../../types/repositoryChat';
import { runRepositoryChatTurn } from '../../../services/repositoryChatRunner';
import { repositoryChatStorage } from '../../../services/repositoryChatStorage';
import { DEFAULT_CHAT_TITLES } from './useRepositoryChatSessions';
import { createSecureId } from '../../../utils/cryptoRandom';

/**
 * Generates a unique repository chat entity ID with the specified prefix.
 *
 * @param prefix - The prefix indicating the entity type (e.g. 'message', 'tool-event').
 * @returns A cryptographically secure unique identifier string.
 */
const createId = (prefix: string): string => createSecureId(prefix);

export const repositoryChatErrorMessage = (unknownError: unknown, language: AppLanguage): string => {
  const t = makeT(language, 'chat');
  const rawMessage = unknownError instanceof Error ? unknownError.message : String(unknownError ?? '');
  const isTemporaryServiceFailure = /\b(?:5\d\d|429)\b|upstream|timeout|timed?\s*out|network|fetch|do_request_failed|temporarily unavailable/i.test(rawMessage);
  if (isTemporaryServiceFailure) {
    return t('useRepositoryChat.the-ai-service-is-temporarily-unavailable-your-q');
  }
  return t('useRepositoryChat.answer-generation-failed-check-the-ai-configurat');
};

interface UseRepositoryChatOptions {
  repository: Repository | null;
  session: RepositoryChatSession | null;
  messages: RepositoryChatMessage[];
  onMessagesChange: (messages: RepositoryChatMessage[]) => void;
  onSessionChange: (session: RepositoryChatSession) => Promise<void>;
}

export const useRepositoryChat = ({
  repository,
  session,
  messages,
  onMessagesChange,
  onSessionChange,
}: UseRepositoryChatOptions) => {
  const t = useT('chat');
  const {
    language,
    githubToken,
    aiConfigs,
    activeAIConfig,
    repositoryChatSettings,
  } = useAppStore(useShallow((state) => ({
    language: state.language,
    githubToken: state.githubToken,
    aiConfigs: state.aiConfigs,
    activeAIConfig: state.activeAIConfig,
    repositoryChatSettings: state.repositoryChatSettings,
  })));
  const abortControllerRef = useRef<AbortController | null>(null);
  const retryInFlightRef = useRef(false);
  const toolEventIdsRef = useRef<Map<string, { id: string; createdAt: string }>>(new Map());
  const toolEventWriteChainsRef = useRef<Map<string, Promise<void>>>(new Map());
  const timelineTimestampRef = useRef(0);
  const nextTimelineTimestamp = (): string => {
    const timestamp = Math.max(Date.now(), timelineTimestampRef.current + 1);
    timelineTimestampRef.current = timestamp;
    return new Date(timestamp).toISOString();
  };
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toolEvents, setToolEvents] = useState<RepositoryChatToolEvent[]>([]);
  const [evidenceById, setEvidenceById] = useState<Record<string, ToolEvidence>>({});

  const loadedEvidenceKeyRef = useRef('');
  useEffect(() => {
    // Streaming responses cause messages to change every ~60ms, but evidence collections only change when a turn completes;
    // deduplicate using a key to avoid repeatedly querying IndexedDB during streaming.
    const evidenceKey = messages.map((message) => message.evidenceIds.join('|')).join(',');
    if (evidenceKey === loadedEvidenceKeyRef.current) return;
    loadedEvidenceKeyRef.current = evidenceKey;
    const evidenceIds = Array.from(new Set(messages.flatMap((message) => message.evidenceIds)));
    if (evidenceIds.length === 0) {
      setEvidenceById({});
      return;
    }
    let active = true;
    void repositoryChatStorage.listEvidence(evidenceIds).then((evidences) => {
      if (!active) return;
      setEvidenceById(Object.fromEntries(evidences.map((evidence) => [evidence.id, evidence])));
    });
    return () => { active = false; };
  }, [messages]);

  useEffect(() => {
    if (!session) {
      setToolEvents([]);
      return;
    }
    let active = true;
    void repositoryChatStorage.listToolEvents(session.id).then((events) => {
      if (active) setToolEvents(events);
    });
    return () => { active = false; };
  }, [session]);

  const resolvedConfigId = repositoryChatSettings.chatConfigId ?? activeAIConfig;
  const aiConfig = aiConfigs.find((config) => config.id === resolvedConfigId) ?? null;
  const unavailableReason = !repositoryChatSettings.enabled
    ? (t('useRepositoryChat.repository-chat-is-disabled-in-ai-settings'))
    : !githubToken
      ? (t('useRepositoryChat.configure-a-github-token-first'))
      : !aiConfig
        ? (t('useRepositoryChat.configure-an-active-ai-service-first'))
        : null;

  const persistToolEvent = useCallback(async (event: Omit<RepositoryChatToolEvent, 'id' | 'sessionId' | 'messageId' | 'createdAt'> & { toolName: string }, activeMessageId: string) => {
    if (!session) return;
    // A tool's running and terminal event share one identity, while repeated
    // actions in later Agent rounds must remain distinct timeline entries.
    const eventKey = `${activeMessageId}:${event.stage ?? 'other'}:${event.round ?? 'global'}:${event.toolName}:${event.paramSummary}`;
    const existing = toolEventIdsRef.current.get(eventKey);
    const createdAt = existing?.createdAt ?? nextTimelineTimestamp();
    const toolEvent: RepositoryChatToolEvent = {
      id: existing?.id ?? createId('tool-event'),
      sessionId: session.id,
      messageId: activeMessageId,
      toolName: event.toolName,
      status: event.status,
      paramSummary: event.paramSummary,
      stage: event.stage,
      round: event.round,
      detail: event.detail,
      durationMs: event.durationMs,
      resultSize: event.resultSize,
      evidenceId: event.evidenceId,
      createdAt,
    };
    toolEventIdsRef.current.set(eventKey, { id: toolEvent.id, createdAt });
    setToolEvents((previous) => existing
      ? previous.map((item) => item.id === existing.id ? toolEvent : item)
      : [...previous, toolEvent]);
    // Running and terminal states arrive asynchronously. Serialize writes for
    // one event ID so an older delayed running write cannot overwrite success.
    const previousWrite = toolEventWriteChainsRef.current.get(toolEvent.id) ?? Promise.resolve();
    const write = previousWrite.catch(() => undefined).then(async () => {
      await repositoryChatStorage.saveToolEvent(toolEvent);
    });
    toolEventWriteChainsRef.current.set(toolEvent.id, write);
    try {
      await write;
    } finally {
      if (toolEventWriteChainsRef.current.get(toolEvent.id) === write) {
        toolEventWriteChainsRef.current.delete(toolEvent.id);
      }
    }
  }, [session]);

  const send = useCallback(async (question: string, baseMessages = messages, isRetry = false) => {
    if (!repository || !session || !aiConfig || unavailableReason || isSending || (!isRetry && retryInFlightRef.current)) {
      if (unavailableReason) setError(unavailableReason);
      return;
    }
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) return;

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsSending(true);
    setError(null);
    toolEventIdsRef.current.clear();
    toolEventWriteChainsRef.current.clear();
    setToolEvents([]);
    const userCreatedAt = nextTimelineTimestamp();
    const assistantCreatedAt = nextTimelineTimestamp();
    const userMessage: RepositoryChatMessage = {
      id: createId('message'),
      sessionId: session.id,
      role: 'user',
      content: normalizedQuestion,
      status: 'complete',
      evidenceIds: [],
      // Keep a strict chronological order even after a persistence reload.
      createdAt: userCreatedAt,
    };
    const assistantMessage: RepositoryChatMessage = {
      id: createId('message'),
      sessionId: session.id,
      role: 'assistant',
      content: '',
      status: 'streaming',
      evidenceIds: [],
      createdAt: assistantCreatedAt,
    };
    const nextMessages = [...baseMessages, userMessage, assistantMessage];
    onMessagesChange(nextMessages);

    // Streaming render: incremental callback throttles updates of the latest assistant message at ~60ms intervals;
    // the final result still adheres to citation-validated result.content. Declared in outer scope to preserve partial answer upon abort.
    let streamedContent = '';
    try {
      await Promise.all([
        repositoryChatStorage.saveMessage(userMessage),
        repositoryChatStorage.saveMessage(assistantMessage),
      ]);
      let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
      const flushStreamedContent = (content: string) => {
        if (streamFlushTimer) {
          globalThis.clearTimeout(streamFlushTimer);
          streamFlushTimer = null;
        }
        onMessagesChange([...baseMessages, userMessage, { ...assistantMessage, content }]);
      };
      const scheduleStreamedFlush = () => {
        if (streamFlushTimer) return;
        streamFlushTimer = globalThis.setTimeout(() => {
          streamFlushTimer = null;
          onMessagesChange([...baseMessages, userMessage, { ...assistantMessage, content: streamedContent }]);
        }, 60);
      };
      try {
        const result = await runRepositoryChatTurn({
          repository,
          session,
          messages: [...baseMessages, userMessage],
          question: normalizedQuestion,
          githubToken: githubToken ?? '',
          aiConfig,
          language,
          maxToolsPerTurn: repositoryChatSettings.maxToolsPerTurn,
          agentBudget: repositoryChatSettings.agentBudget,
          enableAgentToolLoop: repositoryChatSettings.enableAgentToolLoop,
          taskDepth: repositoryChatSettings.taskDepth,
          streaming: repositoryChatSettings.streamingMode !== 'off',
          signal: controller.signal,
          onToolEvent: (event) => {
            void persistToolEvent(event, assistantMessage.id);
          },
          onAnswerChunk: (fullText) => {
            streamedContent = fullText;
            if (fullText.length === 0) {
              // Streaming degradation: immediately clear invalid content that has already streamed out.
              flushStreamedContent('');
              return;
            }
            scheduleStreamedFlush();
          },
        });
        // Cancel pending throttled flush immediately upon receiving final result: otherwise if the last chunk arrives
        // less than 60ms before persistence awaits like saveEvidence/saveMessage, the pending
        // timer would overwrite the completed answer back to streaming state (status: streaming and no evidence).
        if (streamFlushTimer) {
          globalThis.clearTimeout(streamFlushTimer);
          streamFlushTimer = null;
        }
        await Promise.all(result.evidences.map((evidence) => repositoryChatStorage.saveEvidence(evidence)));
        const completedAssistant: RepositoryChatMessage = {
          ...assistantMessage,
          content: result.content,
          status: 'complete',
          evidenceIds: result.evidences.map((evidence) => evidence.id),
        };
        await repositoryChatStorage.saveMessage(completedAssistant);
        onMessagesChange([...baseMessages, userMessage, completedAssistant]);
        await onSessionChange({
          ...session,
          title: DEFAULT_CHAT_TITLES.has(session.title)
            ? normalizedQuestion.slice(0, 72)
            : session.title,
          modelConfigId: aiConfig.id,
          modelLabelAtTime: `${aiConfig.name} · ${aiConfig.model}`,
          updatedAt: new Date().toISOString(),
        });
      } finally {
        if (streamFlushTimer) globalThis.clearTimeout(streamFlushTimer);
      }
    } catch (unknownError) {
      const aborted = controller.signal.aborted;
      const failedAssistant: RepositoryChatMessage = {
        ...assistantMessage,
        content: aborted
          ? (streamedContent || (t('useRepositoryChat.generation-stopped')))
          : (t('useRepositoryChat.answer-generation-failed-please-retry')),
        status: aborted ? 'aborted' : 'error',
      };
      // The visible transcript must always settle, even if the persistence backend
      // is unavailable and cannot record the terminal failure state.
      onMessagesChange([...baseMessages, userMessage, failedAssistant]);
      try {
        await repositoryChatStorage.saveMessage(failedAssistant);
      } catch {
        // The original error is already represented in the transcript and banner.
      }
      if (!aborted) setError(repositoryChatErrorMessage(unknownError, language));
    } finally {
      abortControllerRef.current = null;
      setIsSending(false);
    }
  }, [aiConfig, githubToken, isSending, language, messages, onMessagesChange, onSessionChange, persistToolEvent, repository, repositoryChatSettings.agentBudget, repositoryChatSettings.enableAgentToolLoop, repositoryChatSettings.maxToolsPerTurn, repositoryChatSettings.streamingMode, repositoryChatSettings.taskDepth, session, unavailableReason, t]);

  const stop = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  const resendLastPair = useCallback(async (requireFailedStatus: boolean) => {
    if (retryInFlightRef.current || isSending) return;
    if (messages.length < 2) return;
    const lastAssistant = messages[messages.length - 1];
    const lastUser = messages[messages.length - 2];
    if (lastAssistant.role !== 'assistant' || lastUser.role !== 'user') return;
    if (requireFailedStatus && lastAssistant.status !== 'error' && lastAssistant.status !== 'aborted') return;
    const baseMessages = messages.slice(0, messages.length - 2);
    retryInFlightRef.current = true;
    try {
      await repositoryChatStorage.permanentlyDeleteMessages([lastUser.id, lastAssistant.id]);
      onMessagesChange(baseMessages);
      await send(lastUser.content, baseMessages, true);
    } finally {
      retryInFlightRef.current = false;
    }
  }, [isSending, messages, onMessagesChange, send]);

  const retry = useCallback(() => resendLastPair(true), [resendLastPair]);

  /** Re-runs the last turn with the same question and current depth (ChatGPT-style "Regenerate"). */
  const regenerate = useCallback(() => resendLastPair(false), [resendLastPair]);

  return {
    canChat: !unavailableReason,
    unavailableReason,
    isSending,
    error,
    toolEvents,
    evidenceById,
    send,
    stop,
    retry,
    regenerate,
  };
};
