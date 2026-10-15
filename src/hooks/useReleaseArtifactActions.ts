import { useT } from "../i18n/useT";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Release } from '../types';
import { sendToRpcDownload } from '../services/rpcDownloadService';
import { AIService } from '../services/aiService';
import { useAppStore } from '../store/useAppStore';
import { useDialog } from '../hooks/useDialog';

export type ReleaseArtifactSummaryState = {
  status: 'idle' | 'loading' | 'done' | 'error';
  content?: string;
  error?: string;
};

export type RpcDownloadState = 'idle' | 'sending' | 'sent';

export interface RpcDownloadLink {
  url: string;
  name: string;
  updatedAt?: string;
}

// When an asset is updated, its URL remains the same but updatedAt changes; include the version in the key,
// otherwise the old version's "Sent ✓" will erroneously linger on the new version.
export const computeRpcDownloadKey = (link: { url: string; updatedAt?: string }): string =>
  `${link.url}@${link.updatedAt ?? ''}`;

export interface ReleaseArtifactActions {
  summaries: Record<number, ReleaseArtifactSummaryState>;
  rpcDownloadStates: Record<string, RpcDownloadState>;
  sendRpcDownload: (link: RpcDownloadLink) => Promise<void>;
  generateSummary: (release: Release) => Promise<void>;
  cancelSummaryRequests: () => void;
  /** Clears summaries and RPC download states (reset by sheet during loadReleases, originally clearing its local state). */
  reset: () => void;
}

/**
 * Release artifact actions (RPC download + AI summary), with canonical semantics from the ReleaseCard version;
 * useRepositoryReleaseSheet delegates to this hook (ADR 0001: no third copy of the same logic).
 */
export const useReleaseArtifactActions = (): ReleaseArtifactActions => {
  const { language, backendApiSecret, aiConfigs, activeAIConfig } = useAppStore(useShallow((state) => ({
    language: state.language,
    backendApiSecret: state.backendApiSecret,
    aiConfigs: state.aiConfigs,
    activeAIConfig: state.activeAIConfig,
  })));
  const { toast } = useDialog();
  const t = useT('app');

  const [summaries, setSummaries] = useState<Record<number, ReleaseArtifactSummaryState>>({});
  // Render state uses a useState Record replacing the original ReleaseCard refs + forceUpdate (render equivalent);
  // synchronous mirror ref retains synchronous short-circuit semantics: rapid consecutive clicks within the same event
  // loop are not slipped through by async setState batching, avoiding duplicate sends.
  const rpcDownloadStatesRef = useRef<Record<string, RpcDownloadState>>({});
  const [rpcDownloadStates, setRpcDownloadStates] = useState<Record<string, RpcDownloadState>>({});
  const applyRpcDownloadState = useCallback((key: string, state: RpcDownloadState) => {
    rpcDownloadStatesRef.current = { ...rpcDownloadStatesRef.current, [key]: state };
    setRpcDownloadStates(rpcDownloadStatesRef.current);
  }, []);

  const summaryAbortRefs = useRef<Record<number, AbortController | undefined>>({});

  const cancelSummaryRequests = useCallback(() => {
    Object.values(summaryAbortRefs.current).forEach((controller) => controller?.abort());
    summaryAbortRefs.current = {};
  }, []);

  useEffect(() => cancelSummaryRequests, [cancelSummaryRequests]);

  const reset = useCallback(() => {
    // Cancel in-flight summary requests before clearing: otherwise after a refresh (sheet's loadReleases),
    // late completions would write stale results back into the freshly cleared state.
    cancelSummaryRequests();
    setSummaries({});
    rpcDownloadStatesRef.current = {};
    setRpcDownloadStates({});
  }, [cancelSummaryRequests]);

  const sendRpcDownload = useCallback(async (link: RpcDownloadLink) => {
    const key = computeRpcDownloadKey(link);
    // Only short-circuit while sending is in flight, allowing users to re-send once completed
    if (rpcDownloadStatesRef.current[key] === 'sending') return;

    // Clear old success state when retry begins: if this attempt fails or throws, ✓ must not remain inline,
    // otherwise the card would report a failed retry as success.
    applyRpcDownloadState(key, 'sending');
    try {
      const result = await sendToRpcDownload(link.url, link.name, backendApiSecret || undefined);
      if (result.success) {
        applyRpcDownloadState(key, 'sent');
        toast(t('useReleaseArtifactActions.sent-to-remote-downloader'), 'success');
      } else {
        applyRpcDownloadState(key, 'idle');
        toast(
          result.error === 'RPC service not running'
            ? t('useReleaseArtifactActions.remote-download-service-not-running-please-check')
            : result.error || t('useReleaseArtifactActions.send-failed'),
          'error'
        );
      }
    } catch {
      applyRpcDownloadState(key, 'idle');
      toast(t('useReleaseArtifactActions.remote-download-service-not-running-please-check'), 'error');
    }
  }, [applyRpcDownloadState, backendApiSecret, t, toast]);

  const generateSummary = useCallback(async (release: Release) => {
    const existing = summaries[release.id];
    // Pre-guard: do not re-run if loading or already finished. The ReleaseCard button is already
    // disabled during loading (making the original "cancel previous request" unreachable; guarded here and compatible with sheet delegation).
    if (existing?.status === 'loading' || (existing?.status === 'done' && existing.content)) return;

    const activeConfig = aiConfigs.find((config) => config.id === activeAIConfig);
    if (!activeConfig) {
      toast(
        t('useReleaseArtifactActions.please-configure-ai-service-in-settings-first'),
        'error'
      );
      return;
    }

    // Synchronous guard: the loading guard reads a render snapshot, so consecutive invocations in the same event loop (double-click/retrigger)
    // would both see the stale snapshot and pass; summaryAbortRefs updates synchronously to block concurrent duplicate requests.
    if (summaryAbortRefs.current[release.id]) return;

    // Request cancellation only goes through cancelSummaryRequests (unmount / reset); synchronous guard + loading guard
    // make concurrent requests with the same ID unreachable, removing the need to "cancel previous request".
    const controller = new AbortController();
    summaryAbortRefs.current[release.id] = controller;

    const config = activeConfig;
    setSummaries((previous) => ({ ...previous, [release.id]: { status: 'loading' } }));
    try {
      const aiService = new AIService(config, language);
      const content = await aiService.analyzeReleaseSummary(
        release.body || '',
        {
          repoName: release.repository.full_name,
          tagName: release.tag_name,
          releaseName: release.name && release.name !== release.tag_name ? release.name : undefined,
        },
        controller.signal
      );
      // Aligns with original sheet's post-await guard: if the service ignores signal and resolves late
      // (e.g. after reset()/unmount), discard stale results and do not overwrite the freshly cleared state.
      if (controller.signal.aborted) return;
      setSummaries((previous) => ({ ...previous, [release.id]: { status: 'done', content } }));
    } catch (error) {
      // Silently handle intentional cancellations (unmount/reset) without updating state or showing errors
      if ((error instanceof Error && error.name === 'AbortError') || controller.signal.aborted) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      setSummaries((previous) => ({ ...previous, [release.id]: { status: 'error', error: message } }));
      toast(
        t('useReleaseArtifactActions.summary-failed-message', { message: message }),
        'error'
      );
    } finally {
      if (summaryAbortRefs.current[release.id] === controller) {
        delete summaryAbortRefs.current[release.id];
      }
    }
  }, [activeAIConfig, aiConfigs, language, summaries, toast, t]);

  return useMemo(() => ({
    summaries,
    rpcDownloadStates,
    sendRpcDownload,
    generateSummary,
    cancelSummaryRequests,
    reset,
  }), [summaries, rpcDownloadStates, sendRpcDownload, generateSummary, cancelSummaryRequests, reset]);
};
