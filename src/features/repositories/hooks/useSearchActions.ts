import { useT } from "../../../i18n/useT";
import { useCallback, useMemo, useState, type MutableRefObject, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Category, Repository } from '../../../types';
import { useAppStore, getAllCategories } from '../../../store/useAppStore';
import { AIService, isAbortError } from '../../../services/aiService';
import { EmbeddingClient, VectorSearchService } from '../../../services/vectorSearchService';
import { createGitHubApiService, createGitHubListsApiService } from '../../../services/githubApiFactory';
import { forceSyncToBackend } from '../../../services/autoSync';
import { useDialog } from '../../../hooks/useDialog';
import type { GitHubList } from '../../../services/githubListsApi';
import type { VectorQueryResult } from '../../../services/vectorSearchService';
import { isReservedCategoryName } from '../../../utils/categoryUtils';
import { performBasicTextSearch } from '../../../utils/repoSearch';
import { assignIdentityMatches } from '../../../utils/repositoryIdentity';

// ===== Pure Helper Functions (Source corresponds line-by-line to SearchBar baseline line numbers) =====

// SearchBar 446-459: Lightweight keyword boosting + scoreMap construction.
export const buildSearchPatch = (
  query: string,
  vectorResults: VectorQueryResult[],
): Map<string, number> => {
  const queryLower = query.toLowerCase();
  const boostedResults = vectorResults.map(r => {
    let bonus = 0;
    const name = (r.metadata?.full_name || '').toLowerCase();
    const desc = (r.metadata?.description || '').toLowerCase();
    const tags = (r.metadata?.tags || []).map(tag => tag.toLowerCase());
    if (name.includes(queryLower)) bonus += 0.05;
    if (desc.includes(queryLower)) bonus += 0.03;
    if (tags.some(tag => tag.includes(queryLower))) bonus += 0.02;
    return { ...r, score: r.score + bonus };
  });
  return new Map(boostedResults.map(r => [r.id, r.score]));
};

/**
 * Star sync assignment results: 1-to-1 aligned with `newRepos` (`undefined` = newly added).
 *
 * The core rule resides in `utils/repositoryIdentity` (id takes priority, followed by synthetic id name fallback),
 * sharing the same implementation as `addRepository` to prevent discrepancy between the two.
 */
const assignStarredRepositories = (
  newRepos: Repository[],
  storeRepos: Repository[],
): Array<Repository | undefined> => assignIdentityMatches(newRepos, storeRepos);

/** Counts the number of truly newly added repositories in this sync (matching the merge criteria). */
export const countNewStarredRepositories = (
  newRepos: Repository[],
  storeRepos: Repository[],
): number => assignStarredRepositories(newRepos, storeRepos)
  .filter(assignment => assignment === undefined).length;

// SearchBar 725-750: Field-by-field merge of star sync results with local repositories (backfilling license `?? null`).
export const mergeStarredRepositories = (
  newRepos: Repository[],
  storeRepos: Repository[],
): Repository[] => {
  // Shares the same assignment results with countNewStarredRepositories to ensure "merge"
  // and "new count" criteria are identical, and name fallback does not reuse the same local record.
  const assignments = assignStarredRepositories(newRepos, storeRepos);
  return newRepos.map((newRepo, index) => {
    const existing = assignments[index];
    if (existing) {
      return {
        ...existing,
        name: newRepo.name,
        full_name: newRepo.full_name,
        description: newRepo.description,
        html_url: newRepo.html_url,
        stargazers_count: newRepo.stargazers_count,
        forks_count: newRepo.forks_count,
        forks: newRepo.forks,
        language: newRepo.language,
        updated_at: newRepo.updated_at,
        pushed_at: newRepo.pushed_at,
        starred_at: newRepo.starred_at,
        owner: newRepo.owner,
        topics: newRepo.topics,
        // Backfill missing license field for historical repositories (GitHub source metadata, follows newRepo)
        license: newRepo.license ?? null,
        // GitHub native status fields: refreshed from newRepo (archived/disabled status follows upstream changes).
        // Preserves locally acquired value when source is missing, avoiding demoting known Health facts to "unknown".
        archived: newRepo.archived ?? existing.archived,
        disabled: newRepo.disabled ?? existing.disabled,
        fork: newRepo.fork ?? existing.fork,
        is_template: newRepo.is_template ?? existing.is_template,
        open_issues_count: newRepo.open_issues_count ?? existing.open_issues_count,
        default_branch: newRepo.default_branch ?? existing.default_branch,
      };
    }
    return newRepo;
  });
};

// SearchBar 774-799: Construct "list name (lowercase) -> local category" mapping and plan missing custom categories for cloud lists.
// makeCategoryId is injected by the hook (original implementation inlined `custom-sync-${Date.now()}-${idx}`), maintaining testability.
export const planListCategories = (
  lists: GitHubList[],
  localCategories: Category[],
  makeCategoryId: (idx: number) => string,
): { toCreate: Category[]; categoryByLowerName: Map<string, string> } => {
  // Values use the original name of local categories (preserving their casing), rather than the list name:
  // locked category filtering uses strict equality; if directly storing GitHub side casing,
  // the repository would disappear from category results (e.g., list name "web apps" vs category "Web Apps").
  const categoryByLowerName = new Map(
    localCategories
      .filter(c => c.id !== 'all' && !isReservedCategoryName(c.name))
      .map(c => [c.name.toLowerCase(), c.name])
  );
  const toCreate: Category[] = [];
  lists.forEach((list, idx) => {
    const lower = list.name.toLowerCase();
    if (isReservedCategoryName(list.name) || categoryByLowerName.has(lower)) return;
    toCreate.push({
      id: makeCategoryId(idx),
      name: list.name,
      icon: ' 📋',
      isCustom: true,
      keywords: [],
    });
    // Add to the mapping used in this run, allowing subsequent listMatchesCategory hits to set category and lock
    categoryByLowerName.set(lower, list.name);
  });
  return { toCreate, categoryByLowerName };
};

// SearchBar 807-868: preExistingLocked set + tagging/category assignment/locking loop + last_edited.
export const applyListsToRepositories = (
  repositories: Repository[],
  lists: GitHubList[],
  categoryByLowerName: Map<string, string>,
): { repositories: Repository[]; appliedTagsCount: Record<string, number> } => {
  const listRepoMap = new Map(repositories.map(repo => [repo.full_name.toLowerCase(), repo]));
  const appliedTagsCount: Record<string, number> = {};

  // DEC-4: Only evaluate locked status.
  // Distinguish between locks that "existed before this sync started" and locks "newly created in this run":
  // - Pre-existing locks: do not overwrite their category and lock state, but still append matched list names
  //   as custom_tags (fixes #273: otherwise once a repo was locked, subsequent cloud list changes were skipped,
  //   causing "unable to pull cloud lists to local").
  // - Newly locked by an earlier list in this run: retain assigned category/lock state, continue appending tags for subsequent lists
  const preExistingLocked = new Set(
    repositories
      .filter(r => r.category_locked)
      .map(r => r.full_name.toLowerCase())
  );

  for (const list of lists) {
    let appliedCount = 0;
    for (const fullName of list.items) {
      const key = fullName.toLowerCase();
      const repo = listRepoMap.get(key);
      if (!repo) continue;

      const customTags = repo.custom_tags ? [...repo.custom_tags] : [];
      if (!customTags.includes(list.name)) {
        customTags.push(list.name);
      }

      // Pre-existing lock: do not overwrite category and lock; only append list name as tag
      // so cloud list relationships are reflected locally (fixes #273).
      if (preExistingLocked.has(key)) {
        // Only write back when tags actually change, avoiding unnecessary last_edited jitter
        if (customTags.length !== (repo.custom_tags?.length ?? 0)) {
          listRepoMap.set(key, { ...repo, custom_tags: customTags });
        }
        appliedCount++;
        continue;
      }

      // Repository just locked in this run: retain assigned category and lock, only append tag
      if (repo.category_locked) {
        listRepoMap.set(key, { ...repo, custom_tags: customTags });
        appliedCount++;
        continue;
      }

      // If list name matches a local category: set category and lock; otherwise only add tag (multiple categories matched via tags)
      const listMatchesCategory = categoryByLowerName.has(list.name.toLowerCase());
      const updatedRepo: Repository = listMatchesCategory
        ? {
            ...repo,
            custom_tags: customTags,
            custom_category: categoryByLowerName.get(list.name.toLowerCase()),
            category_locked: true,
            last_edited: new Date().toISOString(),
          }
        : {
            ...repo,
            custom_tags: customTags,
          };

      listRepoMap.set(key, updatedRepo);
      appliedCount++;
    }
    if (appliedCount > 0) {
      appliedTagsCount[list.name] = appliedCount;
    }
  }

  return {
    repositories: repositories.map(repo =>
      listRepoMap.get(repo.full_name.toLowerCase()) || repo
    ),
    appliedTagsCount,
  };
};

// ===== Hook =====

export interface SearchActions {
  isSearching: boolean;
  searchPhase: string | null;
  // Rendering-related refs: View's filtering effect still needs to read/write them, hence exposed as RefObject.
  // The entity lives in the hook and is exposed to View as RefObject for unchanged read/write — write point in aiSearch (this hook),
  // read point in View's filtering effect (depends on View's local applyFilters closure). Moving everything into the hook
  // would widen the blast radius and introduce drift risks; under the "move only, don't change semantics" constraint, this is the lowest-risk approach.
  vectorScoreMapRef: MutableRefObject<{ query: string; scores: Map<string, number> } | null>;
  skipNextTextSearchRef: MutableRefObject<boolean>;
  aiSearch: (query: string, applyFilters: (repos: Repository[]) => Repository[]) => Promise<void>;
  keywordSearch: (
    query: string,
    applyFilters: (repos: Repository[]) => Repository[],
    options?: { signal?: AbortSignal },
  ) => Promise<void>;
  syncStars: (mode?: 'auto' | 'stars-only' | 'stars-and-lists') => Promise<void>;
}

export const useSearchActions = (): SearchActions => {
  const {
    repositories,
    aiConfigs,
    activeAIConfig,
    language,
    setSearchFilters,
    setSearchResults,
    githubToken,
    setRepositories,
    setLastSync,
    setSyncingStars,
    syncMode,
    user,
    addCustomCategory,
    customCategories,
    hiddenDefaultCategoryIds,
    defaultCategoryOverrides,
  } = useAppStore(useShallow((state) => ({
    repositories: state.repositories,
    aiConfigs: state.aiConfigs,
    activeAIConfig: state.activeAIConfig,
    language: state.language,
    setSearchFilters: state.setSearchFilters,
    setSearchResults: state.setSearchResults,
    githubToken: state.githubToken,
    setRepositories: state.setRepositories,
    setLastSync: state.setLastSync,
    setSyncingStars: state.setSyncingStars,
    syncMode: state.syncMode,
    user: state.user,
    addCustomCategory: state.addCustomCategory,
    customCategories: state.customCategories,
    hiddenDefaultCategoryIds: state.hiddenDefaultCategoryIds,
    defaultCategoryOverrides: state.defaultCategoryOverrides,
  })));

  const { toast } = useDialog();
  const [isSearching, setIsSearching] = useState(false);
  const [searchPhase, setSearchPhase] = useState<string | null>(null);
  const vectorScoreMapRef = useRef<{ query: string; scores: Map<string, number> } | null>(null);
  const skipNextTextSearchRef = useRef(false);
  // Controller for current in-flight AI search: aborts previous request when a new search starts (superseding semantics)
  const aiSearchAbortRef = useRef<AbortController | null>(null);
  const t = useT('repositories');

  const keywordSearch = useCallback(async (
    query: string,
    applyFilters: (repos: Repository[]) => Repository[],
    options?: { signal?: AbortSignal },
  ): Promise<void> => {
    const activeConfig = aiConfigs.find(config => config.id === activeAIConfig);

    let filtered = repositories;
    let aiOrdered = false;
    if (activeConfig) {
      try {
        // Non-vector fallback chain: query expansion + intent rewriting -> lexical candidate retrieval -> LLM curated ranking
        setSearchPhase(t('useSearchActions.ai-semantic-analysis'));
        const aiService = new AIService(activeConfig, language);
        const aiResults = await aiService.searchRepositoriesWithSelection(repositories, query, {
          signal: options?.signal,
          onPhase: (phase) => {
            setSearchPhase(phase === 'selecting'
              ? t('useSearchActions.ai-selecting-relevant-repositories')
              : t('useSearchActions.ai-semantic-analysis'));
          },
          onFallback: (reason) => {
            // On endpoint jitter/configuration issues, users shouldn't just see "empty results": clearly inform about fallback
            if (reason === 'ai_failed') {
              toast(t('useSearchActions.ai-request-failed-fell-back-to-local-lexical-sea'), 'warning');
            }
          },
        });
        console.log('✅ AI selection search completed, results:', aiResults.length);
        filtered = aiResults;
        aiOrdered = true;
      } catch (error) {
        // Cancellation is not a failure: propagate up to aiSearch to finish silently without producing fallback results
        if (isAbortError(error)) throw error;
        console.warn('❌ AI search failed, falling back to basic search:', error);
        toast(t('useSearchActions.ai-request-failed-fell-back-to-local-lexical-sea'), 'warning');
        filtered = performBasicTextSearch(repositories, query);
      }
    } else {
      console.log('⚠️ No AI config found, using basic text search');
      // Basic text search if no AI config
      filtered = performBasicTextSearch(repositories, query);
    }

    // Apply other filters and update results
    const finalFiltered = applyFilters(filtered);
    if (aiOrdered) {
      // The order returned by AI (LLM curated order or lexical fallback order) is the relevance order; applyFilters
      // will re-sort according to UI sorting controls (default star descending). Here we restore the AI order — isomorphic
      // to the rerankOrder restoration logic in the vector path.
      const aiOrder = new Map(filtered.map((repo, index) => [String(repo.id), index]));
      finalFiltered.sort((a, b) =>
        (aiOrder.get(String(a.id)) ?? Number.MAX_SAFE_INTEGER)
        - (aiOrder.get(String(b.id)) ?? Number.MAX_SAFE_INTEGER));
      // setSearchFilters({ query }) below will trigger SearchBar's filtering effect, resetting results with basic
      // text search + star sorting — overriding LLM curated order, subset, and explicit empty state.
      // Shared with vector path: use skipNextTextSearchRef to block this effect (including empty result cases).
      skipNextTextSearchRef.current = true;
    }
    setSearchResults(finalFiltered);

    // Update search filters to mark that AI search was performed
    setSearchFilters({ query });
  }, [repositories, aiConfigs, activeAIConfig, language, setSearchResults, setSearchFilters, toast, t]);

  const aiSearch = useCallback(async (
    query: string,
    applyFilters: (repos: Repository[]) => Repository[],
  ): Promise<void> => {
    if (!query.trim()) return;

    // New search takes over: abort previous in-flight AI request (pressing Enter during an ongoing search can re-trigger),
    // preventing stale results from writing to storage and overwriting new results. Superseded searches do not reset search state in finally.
    aiSearchAbortRef.current?.abort();
    const controller = new AbortController();
    aiSearchAbortRef.current = controller;

    setIsSearching(true);
    setSearchPhase(null);
    vectorScoreMapRef.current = null;
    console.log('🔍 Starting AI search for query:', query);

    try {
      // ====== Vector Search Branch ======
      // Preserve original timing: non-reactive getState() read (original file behaves this way; do not change to reactive selector)
      const vsConfig = useAppStore.getState().vectorSearchConfig;
      const embConfigs = useAppStore.getState().embeddingConfigs;
      const activeEmbConfig = embConfigs.find(c => c.id === vsConfig?.embeddingConfigId);

      if (vsConfig?.enabled && vsConfig?.workerUrl && activeEmbConfig) {
        try {
          const embeddingClient = new EmbeddingClient(activeEmbConfig);
          const vectorService = new VectorSearchService(vsConfig);

          // 1. HyDE query preprocessing: use LLM to generate hypothetical repo description then embed (optional, 5-second timeout fallback)
          let embeddingQuery = query;
          const hydeConfig = aiConfigs.find(config => config.id === activeAIConfig);
          if (vsConfig.enableHyDE !== false && hydeConfig) {
            const hydeAbort = new AbortController();
            let hydeTimer: ReturnType<typeof setTimeout> | null = null;
            try {
              setSearchPhase(t('useSearchActions.ai-analyzing-query'));
              const hydeService = new AIService(hydeConfig, language);
              embeddingQuery = await Promise.race([
                hydeService.generateHyDEQuery(query, hydeAbort.signal).catch(() => query),
                new Promise<string>((resolve) => {
                  hydeTimer = setTimeout(() => {
                    hydeAbort.abort();
                    resolve(query);
                  }, 5000);
                }),
              ]);
              if (embeddingQuery !== query) {
                console.log('🔮 HyDE generated:', embeddingQuery.slice(0, 100));
              }
            } catch (hydeError) {
              console.warn('HyDE failed, using raw query:', hydeError);
              embeddingQuery = query;
            } finally {
              if (hydeTimer) clearTimeout(hydeTimer);
            }
          }

          // 2. Frontend calls Embedding API to generate query vector
          setSearchPhase(t('useSearchActions.generating-query-vector'));
          const queryVectors = await embeddingClient.embed([embeddingQuery], 'query');
          if (queryVectors && queryVectors.length > 0) {
            // 2. Frontend sends query vector to Worker
            setSearchPhase(t('useSearchActions.searching-vector-index'));
            const vectorResults = await vectorService.query(queryVectors[0], {
              topK: vsConfig.searchTopK ?? 30,
              threshold: vsConfig.searchThreshold ?? 0.35,
            });

            if (vectorResults.length > 0) {
              // 3. Lightweight keyword boosting: fine-tune scores for exact matching fields
              const scoreMap = buildSearchPatch(query, vectorResults);

              // 4. Fetch matched results from local repo data, sorted by similarity
              const scoredRepos = repositories
                .filter(repo => scoreMap.has(String(repo.id)))
                .map(repo => ({
                  repo,
                  score: scoreMap.get(String(repo.id)) || 0,
                }))
                .sort((a, b) => b.score - a.score)
                .map(item => item.repo);

              if (scoredRepos.length > 0) {
                // 4. AI semantic reranking: use LLM for true semantic ranking of vector search results
                let reranked = scoredRepos;
                let rerankSucceeded = false;
                const rerankConfig = aiConfigs.find(config => config.id === activeAIConfig);
                if (rerankConfig && vsConfig.enableReranking !== false) {
                  try {
                    setSearchPhase(t('useSearchActions.ai-semantic-reranking'));
                    const rerankService = new AIService(rerankConfig, language);
                    reranked = await rerankService.searchRepositoriesWithSemanticReranking(scoredRepos, query);
                    rerankSucceeded = true;
                    console.log('🤖 AI semantically reranked results:', reranked.length);
                  } catch (rerankError) {
                    console.warn('AI semantic reranking failed, using vector order:', rerankError);
                  }
                }

                // Save LLM reranking order; applyFilters may override it based on UI sort
                const rerankOrder = rerankSucceeded
                  ? new Map(reranked.map((repo, index) => [String(repo.id), index]))
                  : null;
                const finalFiltered = applyFilters([...reranked]);
                if (rerankOrder) {
                  // Restore LLM semantic ranking order
                  finalFiltered.sort((a, b) =>
                    (rerankOrder.get(String(a.id)) ?? Number.MAX_SAFE_INTEGER)
                    - (rerankOrder.get(String(b.id)) ?? Number.MAX_SAFE_INTEGER)
                  );
                } else {
                  finalFiltered.sort((a, b) => (scoreMap.get(String(b.id)) ?? 0) - (scoreMap.get(String(a.id)) ?? 0));
                }
                console.log('🎯 Vector search results:', finalFiltered.length);
                vectorScoreMapRef.current = { query, scores: scoreMap };
                skipNextTextSearchRef.current = true;
                setSearchResults(finalFiltered);
                setSearchFilters({ query });
                return;
              }
            }
          }
          // Vector search returned no results -> continue to keyword search
          console.log('⚠️ Vector search returned no results, falling back to keyword search');
        } catch (vectorError) {
          console.warn('❌ Vector search failed, falling back to keyword search:', vectorError);
        }
      }
      // ====== Vector Search Branch End ======

      await keywordSearch(query, applyFilters, { signal: controller.signal });
    } catch (error) {
      // Cancellation is not a failure: silently end current search (without producing results), do not treat as recoverable AI failure
      if (isAbortError(error)) {
        console.log('🚫 AI search cancelled');
        return;
      }
      console.error('💥 Search failed:', error);
    } finally {
      // Only reset state if this search is still the "current search": an old search superseded by a new search
      // should not clear the new search's isSearching/searchPhase state
      if (aiSearchAbortRef.current === controller) {
        aiSearchAbortRef.current = null;
        setIsSearching(false);
        setSearchPhase(null);
      }
    }
  }, [repositories, aiConfigs, activeAIConfig, language, setSearchResults, setSearchFilters, keywordSearch, t]);

  const syncStars = useCallback(async (mode: 'auto' | 'stars-only' | 'stars-and-lists' = 'auto') => {
    if (!githubToken) {
      toast(t('useSearchActions.github-token-not-found-please-login-again'), 'error');
      return;
    }

    setSyncingStars(true);
    try {
      const githubApi = createGitHubApiService(githubToken);
      const newRepositories = await githubApi.getAllStarredRepositories();

      const storeRepos = useAppStore.getState().repositories;
      const mergedRepositories = mergeStarredRepositories(newRepositories, storeRepos);

      // Parse current sync scope:
      // - 'auto': follows persistent config syncMode
      // - 'stars-only': force stars only (ignores syncMode, for explicit dropdown selection)
      // - 'stars-and-lists': force stars and lists (for explicit dropdown selection)
      const syncLists = mode === 'stars-and-lists' || (mode === 'auto' && syncMode === 'stars-and-lists');
      let finalRepositories = mergedRepositories;

      if (syncLists) {
        const appliedTagsCount: Record<string, number> = {};
        try {
          const listsApi = createGitHubListsApiService(githubToken);
          const login = user?.login;
          if (!login) {
            throw new Error(t('useSearchActions.failed-to-get-github-username-please-login-again'));
          }
          const lists = await listsApi.getUserLists(login);

          // allCategories shares the same source and values as View's useMemo (getAllCategories 4-param scope)
          const allCategories = getAllCategories(customCategories, language, hiddenDefaultCategoryIds, defaultCategoryOverrides);
          // Automatically create custom categories for cloud lists that do not have matching local categories.
          // Fixes "GitHub lists have many new categories but local never pulled them" — original logic only added custom_tags
          // and did not create categories, causing the left category tree to only ever display historical categories.
          // Use incrementing index per list as id suffix to prevent duplicate ids across multiple lists within the same millisecond.
          const { toCreate, categoryByLowerName } = planListCategories(
            lists,
            allCategories,
            (idx) => `custom-sync-${Date.now()}-${idx}`,
          );
          toCreate.forEach((category) => addCustomCategory(category));
          const createdCategoriesCount = toCreate.length;

          const { repositories: listAppliedRepositories, appliedTagsCount: counts } =
            applyListsToRepositories(finalRepositories, lists, categoryByLowerName);
          finalRepositories = listAppliedRepositories;
          Object.assign(appliedTagsCount, counts);

          if (Object.keys(appliedTagsCount).length > 0) {
            const appliedTotal = Object.values(appliedTagsCount).reduce((a, b) => a + b, 0);
            const listSummary = Object.entries(appliedTagsCount)
              .map(([name, count]) => `${name}(${count})`)
              .join(', ');
            const createdHint = createdCategoriesCount > 0
              ? t('useSearchActions.list-sync-new-categories', { count: createdCategoriesCount })
              : '';
            toast(t('useSearchActions.synced-v1-lists-applied-to-appliedtotal-unlocked', { v1: lists.length, appliedTotal: appliedTotal, listSummary: listSummary, createdHint: createdHint }), 'info');
          } else if (createdCategoriesCount > 0) {
            // 0 matches, but new categories were created in this run (cloud lists had no overlapping repos but created named categories)
            toast(t('useSearchActions.list-sync-complete', { lists: lists.length, newCount: createdCategoriesCount }), 'info');
          }
        } catch (listError) {
          console.error('List sync failed:', listError);
          toast(t('useSearchActions.list-sync-failed-starred-repositories-were-synce'), 'error');
          // Do not interrupt: star sync results still take effect
        }
      }

      // "New repositories" count must use the same matching scope as mergeStarredRepositories
      // (id first, full_name fallback): otherwise existing repositories rescued by full_name fallback
      // would be falsely reported as new, triggering an erroneous "Found N new repositories" notification.
      const newRepoCount = countNewStarredRepositories(newRepositories, storeRepos);

      setRepositories(finalRepositories);
      await forceSyncToBackend();

      setLastSync(new Date().toISOString());

      if (newRepoCount > 0) {
        toast(t('useSearchActions.sync-completed-found-newrepocount-new-repositori', { newRepoCount: newRepoCount }), 'success');
      } else {
        toast(t('useSearchActions.sync-completed-all-repositories-are-up-to-date'), 'info');
      }

    } catch (error) {
      console.error('Sync failed:', error);
      if (error instanceof Error && error.message.includes('token')) {
        toast(t('useSearchActions.github-token-has-expired-or-is-invalid-please-lo'), 'error');
      } else {
        toast(t('useSearchActions.sync-failed-please-check-your-network-connection'), 'error');
      }
    } finally {
      setSyncingStars(false);
    }
  }, [githubToken, setSyncingStars, syncMode, user, t, toast, addCustomCategory, customCategories, language, hiddenDefaultCategoryIds, defaultCategoryOverrides, setRepositories, setLastSync]);

  return useMemo(() => ({
    isSearching,
    searchPhase,
    vectorScoreMapRef,
    skipNextTextSearchRef,
    aiSearch,
    keywordSearch,
    syncStars,
  }), [isSearching, searchPhase, aiSearch, keywordSearch, syncStars]);
};
