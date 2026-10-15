import { useT } from "../../../i18n/useT";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { DiscoveryRepo, Repository } from '../../../types';
import { useAppStore, getAllCategories } from '../../../store/useAppStore';
import { analyzeRepository, createFailedAnalysisResult } from '../../../services/aiAnalysisHelper';
import { forceSyncToBackend } from '../../../services/autoSync';
import { createGitHubApiService } from '../../../services/githubApiFactory';
import { useDialog } from '../../../hooks/useDialog';
import { applyDiscoveryAnalysisFailure, applyDiscoveryAnalysisSuccess } from '../../repositories/application/discoveryRepoPatches';
import { findIdentityMatch } from '../../../utils/repositoryIdentity';

export interface UseDiscoveryRepoActionsOptions {
  repo: DiscoveryRepo;
}

export interface DiscoveryRepoActions {
  analyze: (onAnalyzed?: (repo: DiscoveryRepo) => void) => Promise<void>;
  star: (onStar?: (repo: DiscoveryRepo) => void) => Promise<void>;
  executeUnstar: () => Promise<void>;
  isAnalyzing: boolean;
  isStarring: boolean;
  isStarred: boolean;
  optimisticStarred: boolean | null;
}

// Extracted repositoryToAdd literal from SubscriptionRepoCard.handleStar:
// Clears discovery-specific fields (keys retained with undefined values) and adds starred_at timestamp.
// The cast is necessary — Repository does not have rank/channel/platform keys; runtime shape matches the original implementation exactly.
export const discoveryRepoToRepository = (repo: DiscoveryRepo, starredAt: string): Repository => ({
  ...repo,
  rank: undefined,
  channel: undefined,
  platform: undefined,
  starred_at: starredAt,
} as Repository);

export const useDiscoveryRepoActions = ({ repo }: UseDiscoveryRepoActionsOptions): DiscoveryRepoActions => {
  const {
    githubToken,
    aiConfigs,
    activeAIConfig,
    language,
    customCategories,
    repositories,
    updateDiscoveryRepo,
    addRepository,
    deleteRepository,
  } = useAppStore(useShallow((state) => ({
    githubToken: state.githubToken,
    aiConfigs: state.aiConfigs,
    activeAIConfig: state.activeAIConfig,
    language: state.language,
    customCategories: state.customCategories,
    repositories: state.repositories,
    updateDiscoveryRepo: state.updateDiscoveryRepo,
    addRepository: state.addRepository,
    deleteRepository: state.deleteRepository,
  })));

  const { toast } = useDialog();

  const t = useT('discovery');

  const [isStarring, setIsStarring] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  // Local optimistic state used to immediately reflect star operation results
  const [optimisticStarred, setOptimisticStarred] = useState<boolean | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  // Check if repository already exists locally (already starred).
  // Must check by GitHub identity (id preferred, synthetic id fallback from full_name), not full_name alone:
  // if an old repo is renamed or deleted, its old name may be reused by another repo. Comparing name only would
  // misidentify the latter as already starred, blocking the user from starring it.
  const isStarredComputed = useMemo(() => {
    return findIdentityMatch(repo, repositories) !== undefined;
  }, [repositories, repo]);

  // Prefer optimistic state; fall back to computed state
  const isStarred = optimisticStarred !== null ? optimisticStarred : isStarredComputed;

  // Execute unstar operation. No confirm dialog here — confirmation is handled by the view layer's custom modal (B8);
  // the view confirm button clears unstarConfirmOpen/pendingUnstarAction before calling this method.
  const executeUnstar = useCallback(async () => {
    if (!githubToken) return;

    setIsStarring(true);

    try {
      const githubApi = createGitHubApiService(githubToken);
      const [owner, name] = repo.full_name.split('/');

      // Optimistic update: immediately update UI state
      setOptimisticStarred(false);

      await githubApi.unstarRepository(owner, name);

      // Delete locally.
      // Must locate record to delete by GitHub identity: matching name alone could delete the wrong record —
      // if an old repo is renamed or deleted and its old name is reused, matching by name targets the old record,
      // deleting an unrelated entry while leaving the actual unstarred repo in the store.
      const existingRepo = findIdentityMatch(repo, repositories);
      if (existingRepo) {
        deleteRepository(existingRepo.id);
      }

      await forceSyncToBackend();

      // On success, clear optimistic state
      setOptimisticStarred(null);
    } catch (error) {
      // On failure, rollback optimistic state
      setOptimisticStarred(null);
      console.error('Failed to unstar repository:', error);
      const errorMessage = t('useDiscoveryRepoActions.failed-to-unstar-repository-please-check-your-ne');
      toast(errorMessage, 'error');
    } finally {
      setIsStarring(false);
    }
  }, [githubToken, repo, repositories, deleteRepository, t, toast]);

  // Star repository (unstar path is handled by the view confirm modal, not within this method)
  const star = useCallback(async (onStar?: (repo: DiscoveryRepo) => void) => {
    if (!githubToken || isStarring) return;

    setIsStarring(true);

    try {
      const githubApi = createGitHubApiService(githubToken);
      const [owner, name] = repo.full_name.split('/');

      // Optimistic update: immediately update UI state
      setOptimisticStarred(true);

      await githubApi.starRepository(owner, name);

      addRepository(discoveryRepoToRepository(repo, new Date().toISOString()));

      if (onStar) {
        onStar(repo);
      }

      await forceSyncToBackend();

      // On success, clear optimistic state
      setOptimisticStarred(null);

      toast(t('useDiscoveryRepoActions.successfully-starred'), 'success');
    } catch (error) {
      // On failure, rollback optimistic state
      setOptimisticStarred(null);
      console.error('Failed to star repository:', error);
      const errorMessage = t('useDiscoveryRepoActions.failed-to-star-repository-please-check-your-netw');
      toast(errorMessage, 'error');
    } finally {
      setIsStarring(false);
    }
  }, [githubToken, isStarring, repo, t, toast, addRepository]);

  // Single-card AI analysis (no forceSync, no toast on success, no re-analyze confirm — unlike RepositoryCard; do not add them)
  const analyze = useCallback(async (onAnalyzed?: (repo: DiscoveryRepo) => void) => {
    if (!githubToken) {
      toast(t('useDiscoveryRepoActions.github-token-not-found-please-login-again'), 'error');
      return;
    }

    const activeConfig = aiConfigs.find(c => c.id === activeAIConfig);
    if (!activeConfig) {
      toast(t('useDiscoveryRepoActions.please-configure-ai-service-in-settings-first'), 'error');
      return;
    }

    if (activeConfig.apiKeyStatus === 'decrypt_failed' || activeConfig.apiKeyStatus === 'empty') {
      toast(t('useDiscoveryRepoActions.the-ai-service-api-key-could-not-be-decrypted-or'), 'error');
      return;
    }

    if (!activeConfig.baseUrl || !activeConfig.apiKey || !activeConfig.model) {
      toast(t('useDiscoveryRepoActions.ai-service-configuration-is-incomplete-please-ch'), 'error');
      return;
    }

    if (isAnalyzing) return;

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsAnalyzing(true);

    try {
      const allCategories = getAllCategories(customCategories, language);

      const result = await analyzeRepository({
        repository: repo,
        githubToken,
        aiConfig: activeConfig,
        language,
        categories: allCategories,
        signal: controller.signal,
      });

      if (controller.signal.aborted) return;

      const updatedRepo = applyDiscoveryAnalysisSuccess(repo, {
        summary: result.summary,
        tags: result.tags,
        platforms: result.platforms,
        analyzedAt: result.analyzed_at,
        analysisFailed: result.analysis_failed,
      });
      updateDiscoveryRepo(updatedRepo);

      if (onAnalyzed) {
        onAnalyzed(updatedRepo);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error('AI analysis error:', error);
        const errorMsg = error instanceof Error && error.message
          ? error.message
          : t('useDiscoveryRepoActions.ai-analysis-failed-please-check-ai-configuration');
        const failedResult = createFailedAnalysisResult(errorMsg);
        const failedRepo = applyDiscoveryAnalysisFailure(repo, {
          analyzedAt: failedResult.analyzed_at,
          analysisFailed: failedResult.analysis_failed,
          analysisError: failedResult.analysis_error,
        });
        updateDiscoveryRepo(failedRepo);
        toast(t('useDiscoveryRepoActions.ai-analysis-failed-please-check-your-ai-configur'), 'error');
      }
    } finally {
      if (!controller.signal.aborted) {
        setIsAnalyzing(false);
      }
    }
  }, [githubToken, aiConfigs, activeAIConfig, language, repo, isAnalyzing, customCategories, updateDiscoveryRepo, t, toast]);

  return useMemo(() => ({
    analyze,
    star,
    executeUnstar,
    isAnalyzing,
    isStarring,
    isStarred,
    optimisticStarred,
  }), [analyze, star, executeUnstar, isAnalyzing, isStarring, isStarred, optimisticStarred]);
};
