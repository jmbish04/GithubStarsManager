import { makeT, useT } from "../../../i18n/useT";
import { useCallback, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Gist } from '../../../types';
import type { GistCreateInput, GistUpdateInput } from '../../../services/githubApi';
import { useAppStore } from '../../../store/useAppStore';
import { selectGistViewState } from '../../../store/selectors';
import { createGitHubApiService } from '../../../services/githubApiFactory';
import { AIService } from '../../../services/aiService';
import { useDialog } from '../../../hooks/useDialog';
import { filterAndSortGists } from '../../../utils/gistUtils';

export type { GistCreateInput, GistUpdateInput };

// Pure patch helper for single GistCard analysis (success and failure states).
export const applyGistAnalysisSuccess = (detail: Gist, summary: string, now: string): Gist => ({
  ...detail,
  ai_summary: summary.trim(),
  analyzed_at: now,
  analysis_failed: false,
  analysis_error: undefined,
});

export const applyGistAnalysisFailure = (gist: Gist, error: string, now: string): Gist => ({
  ...gist,
  analyzed_at: now,
  analysis_failed: true,
  analysis_error: error,
});

export const useGistActions = () => {
  const state = useAppStore(useShallow(selectGistViewState));
  const { toast, confirm } = useDialog();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isAnalyzingAll, setIsAnalyzingAll] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  // The rendered value of isAnalyzingGist(id) strictly equals the store set: the original GistCard's local
  // isAnalyzingLocal was set and cleared in tandem with setAnalyzingGist, making it equivalent to the set.
  // This hook therefore only manipulates the store set and avoids maintaining redundant local flags.
  const analyzingGistIds = useAppStore((s) => s.analyzingGistIds);
  const isAnalyzingGist = useCallback(
    (gistId: string) => analyzingGistIds.has(gistId),
    [analyzingGistIds],
  );
  const t = useT('gists');

  const refreshGists = useCallback(async () => {
    if (!state.githubToken) {
      toast(t('useGistActions.github-token-not-found-please-login-again'), 'error');
      return;
    }
    setIsRefreshing(true);
    try {
      const api = createGitHubApiService(state.githubToken);
      const [mine, starred] = await Promise.all([
        api.getAllGists(state.gists),
        api.getAllStarredGists([...state.gists, ...state.starredGists]),
      ]);
      const starredIds = new Set(starred.map(gist => gist.id));
      state.setGists(mine.map(gist => ({ ...gist, starred: starredIds.has(gist.id) || gist.starred })));
      state.setStarredGists(starred);
      toast(t('useGistActions.gists-synced'), 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : t('useGistActions.failed-to-sync-gists'), 'error');
    } finally {
      setIsRefreshing(false);
    }
  }, [state, t, toast]);

  const aiSearch = useCallback(async (
    query: string,
    categoryItems: Gist[],
    onReranked: () => void,
  ) => {
    if (!query.trim()) return;
    const activeConfig = state.aiConfigs.find(config => config.id === state.activeAIConfig);
    if (!activeConfig) {
      state.setGistSearchFilters({ query });
      return;
    }
    setIsSearching(true);
    try {
      const aiService = new AIService(activeConfig, state.language);
      const ranked = await aiService.searchGistsWithReranking(
        filterAndSortGists(categoryItems, { ...state.gistSearchFilters, query: '' }),
        query,
      );
      onReranked();
      state.setGistSearchFilters({ query });
      state.setGistSearchResults(ranked);
    } catch {
      state.setGistSearchFilters({ query });
    } finally {
      setIsSearching(false);
    }
  }, [state]);

  const analyzeVisibleGists = useCallback(async () => {
    if (!state.githubToken) {
      toast(t('useGistActions.github-token-not-found-please-login-again'), 'error');
      return;
    }
    const activeConfig = state.aiConfigs.find(config => config.id === state.activeAIConfig);
    if (!activeConfig) {
      toast(t('useGistActions.please-configure-ai-service-in-settings-first'), 'error');
      return;
    }
    if (!activeConfig.baseUrl || !activeConfig.apiKey || !activeConfig.model || activeConfig.apiKeyStatus === 'decrypt_failed' || activeConfig.apiKeyStatus === 'empty') {
      toast(t('useGistActions.ai-service-configuration-is-incomplete-please-ch'), 'error');
      return;
    }
    const targets = state.gistSearchResults.filter(gist => !gist.analyzed_at || gist.analysis_failed);
    if (targets.length === 0) {
      toast(t('useGistActions.no-gists-need-analysis-in-the-current-list'), 'info');
      return;
    }
    const confirmed = await confirm(t('useGistActions.batch-ai-analysis'), t('useGistActions.analyze-v1-gists-continue', { v1: targets.length }), { type: 'warning' });
    if (!confirmed) return;

    setIsAnalyzingAll(true);
    const api = createGitHubApiService(state.githubToken);
    const aiService = new AIService(activeConfig, state.language);
    let success = 0;
    let failed = 0;
    const concurrency = activeConfig.concurrency && activeConfig.concurrency > 1 ? activeConfig.concurrency : 1;
    const analyzeOne = async (gist: Gist) => {
      state.setAnalyzingGist(gist.id, true);
      try {
        const detail = await api.getGistForAnalysis(gist.id, gist);
        const summary = await aiService.analyzeGist(detail, api.getGistContentPreview(detail));
        state.updateGist({ ...detail, ai_summary: summary.trim(), analyzed_at: new Date().toISOString(), analysis_failed: false, analysis_error: undefined });
        success++;
      } catch (error) {
        state.updateGist({ ...gist, analyzed_at: new Date().toISOString(), analysis_failed: true, analysis_error: error instanceof Error ? error.message : String(error) });
        failed++;
      } finally {
        state.setAnalyzingGist(gist.id, false);
      }
    };
    try {
      for (let index = 0; index < targets.length; index += concurrency) {
        await Promise.all(targets.slice(index, index + concurrency).map(analyzeOne));
      }
      toast(t('useGistActions.ai-analysis-done-success-succeeded-failed-failed', { success: success, failed: failed }), failed > 0 ? 'error' : 'success');
    } finally {
      setIsAnalyzingAll(false);
    }
  }, [state, t, toast, confirm]);

  const fetchGistDetail = useCallback(async (gist: Gist): Promise<Gist | null> => {
    if (!state.githubToken) return null;
    try {
      const detail = await createGitHubApiService(state.githubToken).getGist(gist.id, gist);
      state.updateGist(detail);
      return detail;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/5\d{2}/.test(message)) {
        toast(t('useGistActions.github-gist-api-is-temporarily-unavailable-openi'), 'warning');
        return null;
      }
      toast(t(message ? 'useGistActions.failed-to-load-gist-details' : 'useGistActions.failed-to-load-gist-details-empty', { message }), 'error');
      return null;
    }
  }, [state, t, toast]);

  const submitGist = useCallback(async (input: GistCreateInput | GistUpdateInput, editingGist: Gist | null) => {
    if (!state.githubToken) return;
    const api = createGitHubApiService(state.githubToken);
    try {
      if (editingGist) {
        const updated = await api.updateGist(editingGist.id, input as GistUpdateInput, editingGist);
        state.updateGist({ ...updated, last_edited: new Date().toISOString() });
        toast(t('useGistActions.gist-updated'), 'success');
        return;
      }
      const created = await api.createGist(input as GistCreateInput);
      state.updateGist({ ...created, last_edited: new Date().toISOString() });
      toast(t('useGistActions.gist-created'), 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const isPermission = /403|404|forbidden|scope|permission/i.test(message);
      toast(
        t(editingGist ? 'useGistActions.gist-update-failed' : 'useGistActions.gist-create-failed', {
          message: message || t('useGistActions.unknown-error'),
          permissionNote: isPermission ? t('useGistActions.gist-permission-note') : '',
        }),
        'error',
      );
    }
  }, [state, t, toast]);

  // Single-card AI analysis (formerly GistCard.handleAnalyze): no Abort, no forceSync;
  // re-analysis overwrite confirmation is handled inside this hook (the View only handles stopPropagation).
  const analyzeOne = useCallback(async (gist: Gist) => {
    if (!state.githubToken) {
      toast(t('useGistActions.github-token-not-found-please-login-again'), 'error');
      return;
    }
    const activeConfig = state.aiConfigs.find(config => config.id === state.activeAIConfig);
    if (!activeConfig) {
      toast(t('useGistActions.please-configure-ai-service-in-settings-first'), 'error');
      return;
    }
    if (!activeConfig.baseUrl || !activeConfig.apiKey || !activeConfig.model || activeConfig.apiKeyStatus === 'decrypt_failed' || activeConfig.apiKeyStatus === 'empty') {
      toast(t('useGistActions.ai-service-configuration-is-incomplete-please-ch'), 'error');
      return;
    }

    if (gist.analyzed_at) {
      const shouldContinue = await confirm(
        t('useGistActions.re-analyze-confirmation'),
        t('useGistActions.this-gist-has-already-been-analyzed-overwrite-th'),
        { type: 'warning' }
      );
      if (!shouldContinue) return;
    }

    state.setAnalyzingGist(gist.id, true);
    try {
      const githubApi = createGitHubApiService(state.githubToken);
      const detail = await githubApi.getGistForAnalysis(gist.id, gist);
      const aiService = new AIService(activeConfig, state.language);
      const summary = await aiService.analyzeGist(detail, githubApi.getGistContentPreview(detail));
      state.updateGist(applyGistAnalysisSuccess(detail, summary, new Date().toISOString()));
      toast(t('useGistActions.gist-ai-analysis-completed'), 'success');
    } catch (error) {
      state.updateGist(applyGistAnalysisFailure(gist, error instanceof Error ? error.message : String(error), new Date().toISOString()));
      toast(t('useGistActions.gist-ai-analysis-failed'), 'error');
    } finally {
      state.setAnalyzingGist(gist.id, false);
    }
  }, [state, t, toast, confirm]);

  const unstarGist = useCallback(async (gist: Gist, onUnstarred?: (gistId: string) => void) => {
    if (!state.githubToken) return;
    const confirmed = await confirm(
      t('useGistActions.unstar-gist'),
      t('useGistActions.are-you-sure-you-want-to-unstar-this-gist'),
      { type: 'warning', confirmText: t('useGistActions.unstar') }
    );
    if (!confirmed) return;

    setIsMutating(true);
    try {
      await createGitHubApiService(state.githubToken).unstarGist(gist.id);
      onUnstarred?.(gist.id);
      state.updateGist({ ...gist, starred: false });
      toast(t('useGistActions.unstarred'), 'success');
    } catch {
      toast(t('useGistActions.failed-to-unstar'), 'error');
    } finally {
      setIsMutating(false);
    }
  }, [state, t, toast, confirm]);

  // 注意：本方法有意遮蔽经由 ...state 展开的同名 store action（签名不同：
  // 接收 Gist 对象并内置确认/报错）。需要原始 store action 的调用方应自行
  // 从 useAppStore 订阅（GistView 的 onDeleted 即如此）。
  const deleteGist = useCallback(async (gist: Gist, onDeleted?: (gistId: string) => void) => {
    if (!state.githubToken || gist.owner?.login !== state.user?.login) return;
    const confirmed = await confirm(
      t('useGistActions.delete-gist'),
      t('useGistActions.are-you-sure-you-want-to-delete-this-gist-this-c'),
      { type: 'danger', confirmText: t('useGistActions.delete') }
    );
    if (!confirmed) return;

    setIsMutating(true);
    try {
      await createGitHubApiService(state.githubToken).deleteGist(gist.id);
      state.deleteGist(gist.id);
      onDeleted?.(gist.id);
      toast(t('useGistActions.gist-deleted'), 'success');
    } catch (error) {
      const msg = error instanceof Error ? error.message : '';
      const isPermission = /403|404|forbidden|scope|permission/i.test(msg);
      toast(
        t(msg ? 'useGistActions.failed-to-delete-gist' : 'useGistActions.failed-to-delete-gist-empty', {
          message: msg,
          permissionNote: isPermission ? t('useGistActions.gist-permission-note') : '',
        }),
        'error'
      );
    } finally {
      setIsMutating(false);
    }
  }, [state, t, toast, confirm]);

  // 大文件按需拉取（原 GistDetailModal.HighlightedCode effect 的服务调用部分）。
  // 无 token 时抛出的错误文案与原 setRawError 直写逐字一致，由 View catch 落 rawError。
  // Abort/retry/局部缓存归 View：signal 由调用方传入。
  // 依赖只含 token：语言切换不得换引用（否则 View 的拉取 effect 会随 language 变化
  // 重新发起网络请求），无 token 文案在抛错时经 getState() 读取当前语言。
  const fetchGistFileRaw = useCallback(async (rawUrl: string, signal?: AbortSignal): Promise<string> => {
    if (!state.githubToken) {
      const currentLanguage = useAppStore.getState().language;
      throw new Error(makeT(currentLanguage, 'gists')('useGistActions.github-token-not-configured'));
    }
    return createGitHubApiService(state.githubToken).getGistFileRaw(rawUrl, signal);
  }, [state.githubToken]);

  return {
    ...state,
    isRefreshing,
    isSearching,
    isAnalyzingAll,
    isMutating,
    refreshGists,
    aiSearch,
    analyzeVisibleGists,
    fetchGistDetail,
    submitGist,
    analyzeOne,
    unstarGist,
    deleteGist,
    fetchGistFileRaw,
    isAnalyzingGist,
  };
};
