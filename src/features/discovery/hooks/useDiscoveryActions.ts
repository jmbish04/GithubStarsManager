import { useT } from "../../../i18n/useT";
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { DiscoveryChannelId, DiscoveryRepo, PaginatedDiscoveryRepositories } from '../../../types';
import { useAppStore } from '../../../store/useAppStore';
import { selectDiscoveryViewState } from '../../../store/selectors';
import { createGitHubApiService } from '../../../services/githubApiFactory';
import { syncWeeklyChannel } from '../../../services/weeklyIssuesService';
import { syncXTweetChannel } from '../../../services/xTweetService';
import { syncTelegramChannel } from '../../../services/telegramService';
import { loadExternalDiscoveryFeed } from '../../../services/externalDiscoveryFeed';
import { isExternalDiscoveryChannelId } from '../../../utils/discoveryFeeds';
import { AIService } from '../../../services/aiService';
import { AIAnalysisOptimizer } from '../../../services/aiAnalysisOptimizer';
import { discoveryAnalysisStorage } from '../../../services/discoveryAnalysisStorage';
import { buildCategoryHints, resolveCategoryAssignment } from '../../../utils/categoryUtils';
import { getAllCategories } from '../../../store/useAppStore';
import { useDialog } from '../../../hooks/useDialog';
import { useAuthSessionGeneration } from '../../../hooks/useAuthSessionGeneration';

const getChannelRequestSignature = (state: ReturnType<typeof selectDiscoveryViewState>, channelId: DiscoveryChannelId) => {
  const common = [state.githubToken, state.discoveryPlatform];
  if (isExternalDiscoveryChannelId(channelId)) {
    return JSON.stringify([...common, state.discoveryChannels.find(channel => channel.id === channelId)?.sourceUrl]);
  }
  switch (channelId) {
    case 'trending': return JSON.stringify([...common, state.trendingTimeRange]);
    case 'topic': return JSON.stringify([...common, state.discoverySelectedTopic]);
    case 'search': return JSON.stringify([...common, state.discoverySearchQuery, state.discoveryLanguage, state.discoverySortBy, state.discoverySortOrder]);
    // Weekly filtering is client-side behavior, but weeklyOnlyCollected is included in the signature so changing filters triggers rebuilding the slice
    case 'weekly': return JSON.stringify([...common, state.weeklyOnlyCollected]);
    // Changes to follow lists or auth change the fetch scope; include them in the signature to invalidate stale requests
    // (A revision number distinguishes between switches across different cookies, which a boolean cannot do)
    case 'x-tweet': return JSON.stringify([...common, state.xTweetFollows, state.xTweetAuth !== null, state.xTweetAuthRevision]);
    case 'telegram': return JSON.stringify([...common, state.telegramFollows]);
    default: return JSON.stringify(common);
  }
};

/**
 * Owns network-backed Discovery loading and AI analysis. UI scrolling and view
 * composition remain in DiscoveryView, while stale topic response protection
 * and all service construction stay in this feature boundary.
 */
export const useDiscoveryActions = (scrollContainerRef: RefObject<HTMLDivElement | null>) => {
  const state = useAppStore(useShallow(selectDiscoveryViewState));
  const { toast } = useDialog();
  const { setAnalysisProgress } = state;
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const optimizerRef = useRef<AIAnalysisOptimizer | null>(null);
  const channelRequestVersionRef = useRef<Partial<Record<DiscoveryChannelId, number>>>({});
  const channelLoadingVersionRef = useRef<Record<string, number>>({});
  const channelRequestControllersRef = useRef<Partial<Record<DiscoveryChannelId, AbortController>>>({});
  const latestStateRef = useRef(state);
  const authSessionIdentity = useAppStore(current => `${current.githubToken ?? ''}\u0000${current.user?.id ?? ''}\u0000${current.user?.login ?? ''}`);
  const { captureSession, isCurrentSession } = useAuthSessionGeneration(authSessionIdentity);
  useEffect(() => {
    latestStateRef.current = state;
  }, [state]);
  useEffect(() => {
    setIsAnalyzing(false);
    setAnalysisProgress({ current: 0, total: 0 });
    // Clear sync progress from previous session for weekly/tweet/channel after account switch
    useAppStore.getState().setWeeklySyncStatus(null);
    useAppStore.getState().setXTweetSyncStatus(null);
    useAppStore.getState().setTelegramSyncStatus(null);
    return () => {
      optimizerRef.current?.abort();
      optimizerRef.current = null;
      // Abort in-flight GitHub details requests for external channels when switching accounts or unmounting
      for (const controller of Object.values(channelRequestControllersRef.current)) controller?.abort();
      channelRequestControllersRef.current = {};
    };
  }, [authSessionIdentity, setAnalysisProgress]);
  const t = useT('discovery');
  const tRef = useRef(t);
  useEffect(() => {
    // Synchronize reference after commit to avoid render-phase side effects
    tRef.current = t;
  }, [t]);

  const refreshChannel = useCallback(async (channelId: DiscoveryChannelId, page = 1, append = false) => {
    const currentState = latestStateRef.current;
    if (!currentState.githubToken) {
      toast(tRef.current('useDiscoveryActions.github-token-not-found-please-login-again'), 'error');
      return;
    }
    const requestVersion = (channelRequestVersionRef.current[channelId] ?? 0) + 1;
    channelRequestVersionRef.current[channelId] = requestVersion;
    const loadingKey = `${channelId}:${append ? 'append' : 'initial'}`;
    channelLoadingVersionRef.current[loadingKey] = requestVersion;
    const requestSession = captureSession();
    const requestSignature = getChannelRequestSignature(currentState, channelId);
    const isCurrentRequest = () => channelRequestVersionRef.current[channelId] === requestVersion
      && isCurrentSession(requestSession)
      && getChannelRequestSignature(useAppStore.getState(), channelId) === requestSignature;
    const ownsLoading = () => channelLoadingVersionRef.current[loadingKey] === requestVersion;

    if (append) {
      currentState.setDiscoveryLoadingMore(channelId, true);
      currentState.setDiscoveryLoadMoreError(channelId, null);
    } else {
      currentState.setDiscoveryLoading(channelId, true);
    }
    let externalFeedController: AbortController | null = null;
    try {
      const api = createGitHubApiService(currentState.githubToken);
      let result: PaginatedDiscoveryRepositories;
      if (isExternalDiscoveryChannelId(channelId)) {
        // When a new request supersedes the old one, abort any in-flight GitHub details requests from the old request
        channelRequestControllersRef.current[channelId]?.abort();
        externalFeedController = new AbortController();
        channelRequestControllersRef.current[channelId] = externalFeedController;
        const channel = currentState.discoveryChannels.find(item => item.id === channelId);
        const sourceUrl = channel?.sourceUrl;
        if (!sourceUrl) throw new Error('External discovery feed is not configured');
        result = await loadExternalDiscoveryFeed(sourceUrl, channelId, api, channel?.sourceKind ?? 'json', externalFeedController.signal);
      } else switch (channelId) {
        case 'trending':
          result = await api.getTrendingRepositories(currentState.discoveryPlatform, page, 20, currentState.trendingTimeRange);
          break;
        case 'hot-release':
          result = await api.getHotReleaseRepositories(currentState.discoveryPlatform, page);
          break;
        case 'most-popular':
          result = await api.getMostPopular(currentState.discoveryPlatform, page);
          break;
        case 'topic':
          result = currentState.discoverySelectedTopic
            ? await api.getTopicRepositories(currentState.discoverySelectedTopic, currentState.discoveryPlatform, page)
            : await api.getTrendingRepositories(currentState.discoveryPlatform, page);
          break;
        case 'search':
          result = currentState.discoverySearchQuery.trim()
            ? await api.searchRepositories(currentState.discoverySearchQuery, currentState.discoveryPlatform, currentState.discoveryLanguage, currentState.discoverySortBy, currentState.discoverySortOrder, page)
            : { repos: [], hasMore: false, nextPageIndex: page + 1, totalCount: 0 };
          break;
        case 'weekly':
          // Clear old status as soon as a new request starts: syncWeeklyChannel will not call onStatus on cache hits,
          // so without clearing, progress text from the previous run would linger
          useAppStore.getState().setWeeklySyncStatus(null);
          result = await syncWeeklyChannel(
            api,
            page,
            currentState.weeklyOnlyCollected,
            // Only the current request has permission to update progress, preventing stale tasks from overwriting status after switching accounts or filters
            (status) => {
              if (isCurrentRequest()) {
                useAppStore.getState().setWeeklySyncStatus(status);
              }
            },
          );
          break;
        case 'x-tweet':
          useAppStore.getState().setXTweetSyncStatus(null);
          result = await syncXTweetChannel(
            api,
            page,
            currentState.xTweetFollows,
            (status) => {
              if (isCurrentRequest()) {
                useAppStore.getState().setXTweetSyncStatus(status);
              }
            },
            undefined,
            currentState.xTweetAuth,
          );
          break;
        case 'telegram':
          useAppStore.getState().setTelegramSyncStatus(null);
          result = await syncTelegramChannel(
            api,
            page,
            currentState.telegramFollows,
            (status) => {
              if (isCurrentRequest()) {
                useAppStore.getState().setTelegramSyncStatus(status);
              }
            },
          );
          break;
        default:
          result = { repos: [], hasMore: false, nextPageIndex: page + 1, totalCount: 0 };
      }
      if (!isCurrentRequest()) return;
      const current = useAppStore.getState();
      const previousCount = current.discoveryRepos[channelId]?.length ?? 0;
      const currentRepos = current.discoveryRepos[channelId] || [];
      const persistedAnalyses = await discoveryAnalysisStorage.loadAllAnalyses();
      if (!isCurrentRequest()) return;
      const mergedRepos = result.repos.map((newRepo) => {
        const existing = currentRepos.find(item => item.id === newRepo.id);
        const analysis = existing?.analyzed_at ? existing : persistedAnalyses.get(newRepo.id);
        return analysis?.analyzed_at ? {
          ...newRepo,
          ai_summary: analysis.ai_summary,
          ai_tags: analysis.ai_tags,
          ai_platforms: analysis.ai_platforms,
          analyzed_at: analysis.analyzed_at,
          analysis_failed: analysis.analysis_failed,
          analysis_error: analysis.analysis_error,
        } : newRepo;
      });
      // x-tweet/telegram returns cumulative prefix slices per page (the service reconstructs the window on each page).
      // Write with replacement semantics when loading more, otherwise newly fetched cards falling into the consumed window would never be populated
      const replacesOnAppend = channelId === 'x-tweet' || channelId === 'telegram';
      if (append && !replacesOnAppend) currentState.appendDiscoveryRepos(channelId, mergedRepos);
      else currentState.setDiscoveryRepos(channelId, mergedRepos);
      currentState.setDiscoveryHasMore(channelId, result.hasMore);
      currentState.setDiscoveryNextPage(channelId, result.nextPageIndex);
      if (result.totalCount !== undefined) currentState.setDiscoveryTotalCount(channelId, result.totalCount);
      currentState.setDiscoveryLastRefresh(channelId, new Date().toISOString());
      if (append && !replacesOnAppend && scrollContainerRef.current) {
        requestAnimationFrame(() => {
          const cards = scrollContainerRef.current?.querySelectorAll('[data-repo-index]');
          const target = cards?.[previousCount] as HTMLElement | undefined;
          target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
    } catch (error) {
      if (!isCurrentRequest()) return;
      console.error(`Failed to refresh channel ${channelId}:`, error);
      if (append) {
        currentState.setDiscoveryLoadMoreError(channelId, tRef.current('useDiscoveryActions.failed-to-load-more-please-retry'));
      } else {
        const errorMsg = error instanceof Error ? error.message : '';
        if (channelId === 'x-tweet') {
          toast(errorMsg ? `${tRef.current('useDiscoveryActions.failed-to-fetch-x-tweets')}: ${errorMsg}` : tRef.current('useDiscoveryActions.failed-to-fetch-x-tweets-please-check-your-netwo'), 'error');
        } else if (channelId === 'telegram') {
          toast(errorMsg ? `${tRef.current('useDiscoveryActions.failed-to-fetch-telegram-messages')}: ${errorMsg}` : tRef.current('useDiscoveryActions.failed-to-fetch-telegram-messages-please-check-y'), 'error');
        } else {
          toast(errorMsg || tRef.current('useDiscoveryActions.failed-to-fetch-data-please-check-your-network-c'), 'error');
        }
      }
    } finally {
      if (channelId === 'weekly' && isCurrentRequest()) {
        useAppStore.getState().setWeeklySyncStatus(null);
      }
      if (channelId === 'x-tweet' && isCurrentRequest()) {
        useAppStore.getState().setXTweetSyncStatus(null);
      }
      if (channelId === 'telegram' && isCurrentRequest()) {
        useAppStore.getState().setTelegramSyncStatus(null);
      }
      if (ownsLoading()) {
        if (append) currentState.setDiscoveryLoadingMore(channelId, false);
        else currentState.setDiscoveryLoading(channelId, false);
      }
      if (externalFeedController && channelRequestControllersRef.current[channelId] === externalFeedController) {
        delete channelRequestControllersRef.current[channelId];
      }
    }
  }, [captureSession, isCurrentSession, scrollContainerRef, toast]);

  const handleAnalyzePage = useCallback(async () => {
    const analysisState = latestStateRef.current;
    if (!analysisState.githubToken) return;
    const activeConfig = analysisState.aiConfigs.find(config => config.id === analysisState.activeAIConfig);
    if (!activeConfig) {
      toast(t('useDiscoveryActions.please-configure-ai-service-in-settings-first'), 'error');
      return;
    }
    if (activeConfig.apiKeyStatus === 'decrypt_failed' || activeConfig.apiKeyStatus === 'empty' || !activeConfig.baseUrl || !activeConfig.apiKey || !activeConfig.model) {
      toast(t('useDiscoveryActions.ai-service-configuration-is-incomplete-please-ch'), 'error');
      return;
    }
    const pageRepos = analysisState.discoveryRepos[analysisState.selectedDiscoveryChannel] || [];
    const unanalyzed = pageRepos.filter(repo => !repo.analyzed_at || repo.analysis_failed);
    if (unanalyzed.length === 0) {
      toast(t('useDiscoveryActions.all-loaded-projects-have-been-analyzed'), 'info');
      return;
    }

    const analysisSession = captureSession();
    setIsAnalyzing(true);
    const current = useAppStore.getState();
    const categories = getAllCategories(current.customCategories, current.language, current.hiddenDefaultCategoryIds, current.defaultCategoryOverrides);
    const categoryNames = [
      ...current.customCategories.map(category => category.name),
      ...(analysisState.language === 'zh'
        ? ['All', 'Web Apps', 'Mobile Apps', 'Desktop Apps', 'Database', 'AI/ML', 'Dev Tools', 'Security Tools', 'Games', 'Design Tools', 'Productivity', 'Education', 'Social Networks', 'Data Analysis']
        : ['All', 'Web Apps', 'Mobile Apps', 'Desktop Apps', 'Database', 'AI/ML', 'Dev Tools', 'Security Tools', 'Games', 'Design Tools', 'Productivity', 'Education', 'Social Networks', 'Data Analysis']),
    ];
    const optimizer = new AIAnalysisOptimizer({
      initialConcurrency: activeConfig.concurrency || 3,
      rateLimiter: { maxConcurrency: 0, requestsPerMinute: activeConfig.requestsPerMinute || 0 },
    });
    optimizerRef.current = optimizer;
    analysisState.setAnalysisProgress({ current: 0, total: unanalyzed.length });
    try {
      const api = createGitHubApiService(analysisState.githubToken);
      const service = new AIService(activeConfig, analysisState.language);
      const readmeCache = await optimizer.prefetchReadmes(unanalyzed, api);
      if (optimizer.isAborted() || !isCurrentSession(analysisSession)) return;
      const results = await optimizer.analyzeRepositories(
        unanalyzed,
        readmeCache,
        service,
        categoryNames,
        buildCategoryHints(current.customCategories),
        (progressCurrent, total) => {
          if (!optimizer.isAborted() && isCurrentSession(analysisSession)) {
            analysisState.setAnalysisProgress({ current: progressCurrent, total });
          }
        },
        result => {
          if (optimizer.isAborted() || !isCurrentSession(analysisSession) || !result.repo) return;
          const analyzedAt = new Date().toISOString();
          if (result.success) {
            const updatedRepo: DiscoveryRepo = {
              ...result.repo,
              rank: 0,
              channel: analysisState.selectedDiscoveryChannel,
              platform: analysisState.discoveryPlatform,
              ai_summary: result.summary,
              ai_tags: result.tags,
              ai_platforms: result.platforms,
              custom_category: resolveCategoryAssignment({ ...result.repo, ai_summary: result.summary }, result.tags || [], categories),
              category_locked: !!result.repo.category_locked,
              analyzed_at: analyzedAt,
              analysis_failed: false,
              analysis_error: undefined,
            };
            analysisState.updateDiscoveryRepo(updatedRepo);
            void discoveryAnalysisStorage.saveAnalysis(updatedRepo.id, { ai_summary: result.summary, ai_tags: result.tags, ai_platforms: result.platforms, analyzed_at: analyzedAt, analysis_failed: false, analysis_error: undefined });
          } else {
            const failedRepo: DiscoveryRepo = { ...result.repo, rank: 0, channel: analysisState.selectedDiscoveryChannel, platform: analysisState.discoveryPlatform, analyzed_at: analyzedAt, analysis_failed: true, analysis_error: result.error?.message || undefined };
            analysisState.updateDiscoveryRepo(failedRepo);
            void discoveryAnalysisStorage.saveAnalysis(failedRepo.id, { analyzed_at: analyzedAt, analysis_failed: true, analysis_error: failedRepo.analysis_error });
          }
        },
      );
      if (optimizer.isAborted() || !isCurrentSession(analysisSession)) return;
      const successCount = results.filter(result => result.success).length;
      const failCount = results.length - successCount;
      toast(t(failCount > 0 ? 'useDiscoveryActions.ai-analysis-complete-with-failures' : 'useDiscoveryActions.ai-analysis-complete', { successCount: successCount, failCount: failCount }), successCount === 0 ? 'error' : failCount > 0 ? 'info' : 'success');
    } catch (error) {
      if (optimizer.isAborted() || !isCurrentSession(analysisSession)) return;
      console.error('AI analysis error:', error);
      toast(t('useDiscoveryActions.ai-analysis-failed-please-check-your-ai-configur'), 'error');
    } finally {
      if (optimizerRef.current === optimizer) optimizerRef.current = null;
      if (isCurrentSession(analysisSession)) {
        setIsAnalyzing(false);
        analysisState.setAnalysisProgress({ current: 0, total: 0 });
      }
    }
  }, [captureSession, isCurrentSession, t, toast]);

  const handleAbortAnalysis = useCallback(() => {
    optimizerRef.current?.abort();
  }, []);

  return { ...state, t, isAnalyzing, refreshChannel, handleAnalyzePage, handleAbortAnalysis };
};
