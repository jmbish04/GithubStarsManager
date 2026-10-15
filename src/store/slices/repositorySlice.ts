import { i18n } from '../../i18n';
import type { Repository } from '../../types';
import { logger } from '../../services/logger';
import { matchesCategory } from '../../utils/categoryUtils';
import type { AppStoreSlice } from '../types';
import { initialSearchFilters } from '../schema';
import { getAllCategories } from '../helpers/categoryHelpers';
import { buildListsPushPlan, validateListsPushPlan, GITHUB_LISTS_MAX_COUNT, GITHUB_LISTS_NAME_MAX_LENGTH } from '../helpers/listsPushPlan';
import { hasActiveSearchFilters } from '../../utils/repoSearch';
import { areRepositoryRecordsEqual, replaceRepositoryInList } from '../helpers/repositoryRecords';
import { shouldPreserveExisting } from '../helpers/accountWorkspace';
import { findIdentityMatch, isValidGitHubRepositoryId } from '../../utils/repositoryIdentity';

/** Synthesize a local id that does not collide with existing records (timestamp + random, avoiding concurrency races). */
const generateFallbackRepositoryId = (existingRepositories: Repository[]): number => {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 10000);
  const maxExistingId = existingRepositories.length > 0
    ? Math.max(...existingRepositories.map((r) => r.id))
    : 0;
  return Math.max(timestamp, maxExistingId + 1) + random;
};

export const createRepositorySlice: AppStoreSlice<Pick<import('../types').AppActions,
  | 'setRepositories'
  | 'updateRepository'
  | 'updateRepositoriesMetadata'
  | 'addRepository'
  | 'setLoading'
  | 'setSyncingStars'
  | 'setLastSync'
  | 'setSyncMode'
  | 'setSyncModeConfigured'
  | 'pushCategoriesToLists'
  | 'resetListsPush'
  | 'setListsPushError'
  | 'setCategoryListIdMap'
  | 'deleteRepository'
  | 'setAnalyzingRepository'
  | 'enterSimilarView'
  | 'resetSimilarView'
  | 'exitSimilarView'
  | 'setSearchFilters'
  | 'setSearchResults'
>> = (set, get) => ({
      // Repository actions
      setRepositories: (repositories, options) => set((state) => {
        if (shouldPreserveExisting(repositories, state.repositories, options?.allowEmpty)) {
          logger.warn('store.setRepositories', 'Refusing empty overwrite of local repositories');
          return state;
        }
        return {
          repositories,
          // Background sync must not wipe an active search result set: replacing
          // it with the full list shrinks the visible slice and unmounts the card
          // being edited (closing its edit modal). SearchBar recomputes results
          // from the new repositories on its own effect.
          searchResults: hasActiveSearchFilters(state.searchFilters) ? state.searchResults : repositories,
        };
      }),
      updateRepository: (repo) => set((state) => {
        const repositoriesResult = replaceRepositoryInList(state.repositories, repo);
        const searchResultsResult = state.searchResults === state.repositories
          ? repositoriesResult
          : replaceRepositoryInList(state.searchResults, repo);
        const similarResultsResult = state.similarView
          ? replaceRepositoryInList(state.similarView.similarResults, repo)
          : null;

        if (!repositoriesResult.changed && !searchResultsResult.changed && !similarResultsResult?.changed) {
          return state;
        }

        return {
          repositories: repositoriesResult.repositories,
          searchResults: searchResultsResult.repositories,
          similarView: similarResultsResult
            ? { ...state.similarView!, similarResults: similarResultsResult.repositories }
            : state.similarView,
        };
      }),
      updateRepositoriesMetadata: (updates) => set((state) => {
        if (!updates.length) return state;
        const patchMap = new Map(updates.map((u) => [u.id, u.patch]));

        const applyPatches = (list: Repository[]): { repositories: Repository[]; changed: boolean } => {
          let changed = false;
          // Index by Map to avoid repeated findIndex lookups
          const indexById = new Map(list.map((r, i) => [r.id, i]));
          const next = list.slice();
          for (const [id, patch] of patchMap) {
            const idx = indexById.get(id);
            if (idx === undefined) continue;
            const merged = { ...next[idx], ...patch };
            if (!areRepositoryRecordsEqual(next[idx], merged)) {
              next[idx] = merged;
              changed = true;
            }
          }
          return { repositories: next, changed };
        };

        const repositoriesResult = applyPatches(state.repositories);
        const searchResultsResult = state.searchResults === state.repositories
          ? repositoriesResult
          : applyPatches(state.searchResults);
        const similarResultsResult = state.similarView
          ? applyPatches(state.similarView.similarResults)
          : { repositories: [], changed: false };

        if (!repositoriesResult.changed && !searchResultsResult.changed && !similarResultsResult.changed) {
          return state;
        }

        return {
          repositories: repositoriesResult.repositories,
          searchResults: searchResultsResult.repositories,
          similarView: state.similarView
            ? { ...state.similarView, similarResults: similarResultsResult.repositories }
            : state.similarView,
        };
      }),
      addRepository: (repo) => set((state) => {
        // Identity matching uniformly delegates to findIdentityMatch (id first, synthesized id name fallback second)—
        // sharing the exact same rules with star sync mergeStarredRepositories to prevent discrepancy drift.
        const existing = findIdentityMatch(repo, state.repositories);
        let updatedRepositories;

        if (existing) {
          // Same GitHub identity: update existing repository (reuse its ID, preserve AI analysis and custom fields).
          // Input contains full GitHub data, refreshing source fields such as full_name (renames take effect here).
          const existingRepoIndex = state.repositories.indexOf(existing);
          updatedRepositories = [...state.repositories];
          updatedRepositories[existingRepoIndex] = {
            ...repo,
            id: existing.id,
            // Preserve custom-edited fields
            custom_description: existing.custom_description,
            custom_tags: existing.custom_tags,
            custom_category: existing.custom_category,
            category_locked: existing.category_locked,
            last_edited: existing.last_edited,
            subscribed_to_releases: existing.subscribed_to_releases,
            // Preserve completed AI analysis: input comes from GitHub details / discovery page data
            // which lacks these fields; blindly spreading would clear existing AI summary and tags.
            // Use '?? existing.x' instead of unconditional backfill so explicitly provided new values are kept.
            ai_summary: repo.ai_summary ?? existing.ai_summary,
            ai_tags: repo.ai_tags ?? existing.ai_tags,
            ai_platforms: repo.ai_platforms ?? existing.ai_platforms,
            analyzed_at: repo.analyzed_at ?? existing.analyzed_at,
            analysis_failed: repo.analysis_failed ?? existing.analysis_failed,
            analysis_error: repo.analysis_error ?? existing.analysis_error,
          };
        } else {
          // Add as standalone record: repo does not exist locally, or shares the name of a *different* GitHub repository.
          // At this point we must NEVER reuse existing.id—otherwise the new repository would be stored under the old repo's ID:
          // After the user runs AI analysis on the new repo, the next sync matching by GitHub ID won't find the local record
          // (different IDs, and name fallback only claims synthesized id records), losing analysis results again;
          // if the old repo is still starred, analysis of the new repo would be erroneously attributed to the old one.
          // Prefer the input's genuine GitHub id; only fall back to a synthesized id when id is unavailable
          // (timestamp + random, ensuring uniqueness and avoiding concurrency races).
          updatedRepositories = isValidGitHubRepositoryId(repo.id)
            ? [...state.repositories, { ...repo, id: repo.id }]
            : [...state.repositories, { ...repo, id: generateFallbackRepositoryId(state.repositories) }];
        }

        return {
          repositories: updatedRepositories,
          // Same guard as setRepositories: while search filters are active the
          // visible list is searchResults, and swapping in the full list would
          // unmount filtered cards (closing their edit modal). SearchBar
          // recomputes results from the updated repositories on its own effect.
          searchResults: hasActiveSearchFilters(state.searchFilters)
            ? state.searchResults
            : updatedRepositories
        };
      }),
      setLoading: (isLoading) => set({ isLoading }),
      setSyncingStars: (isSyncingStars) => set({ isSyncingStars }),
      setLastSync: (lastSync) => set({ lastSync }),
      setSyncMode: (syncMode) => set({ syncMode }),
      setSyncModeConfigured: (syncModeConfigured) => set({ syncModeConfigured }),
      resetListsPush: () => set({ listsPush: { isRunning: false, total: 0, done: 0, currentLabel: null, message: null, error: null } }),
      setListsPushError: (error) => set({ listsPush: { isRunning: false, total: 0, done: 0, currentLabel: null, message: null, error } }),
      setCategoryListIdMap: (categoryId, listId) => set((state) => ({ categoryListIdMap: { ...state.categoryListIdMap, [categoryId]: listId } })),
      pushCategoriesToLists: async (api, categoryIds) => {
        const state = get();
        const t = i18n.getFixedT(state.language, 'app');
        // Reentrancy guard: return immediately if a push is already running to avoid concurrent duplicate lists and overwriting members
        if (state.listsPush.isRunning) return;
        if (!state.githubToken) {
          set({ listsPush: { isRunning: false, total: 0, done: 0, currentLabel: null, message: null, error: t('repositorySlice.not-connected-to-github-yet') } });
          return;
        }
        if (!state.user) {
          set({ listsPush: { isRunning: false, total: 0, done: 0, currentLabel: null, message: null, error: t('repositorySlice.missing-user-info-reconnect') } });
          return;
        }
        if (state.repositories.length === 0) {
          set({ listsPush: { isRunning: false, total: 0, done: 0, currentLabel: null, message: null, error: t('repositorySlice.no-repositories-to-push') } });
          return;
        }

        set({ listsPush: { isRunning: true, total: 0, done: 0, currentLabel: null, message: null, error: null } });

        try {
          const { user, repositories, customCategories, language, hiddenDefaultCategoryIds, defaultCategoryOverrides, categoryListIdMap } = get();

          const allCategoriesForPush = getAllCategories(
            customCategories,
            language,
            hiddenDefaultCategoryIds,
            defaultCategoryOverrides
          ).filter(cat => cat.id !== 'all');
          const allCategories = allCategoriesForPush
            .filter(cat => !categoryIds || categoryIds.includes(cat.id));

          // When only pushing selected categories: error immediately with no requests if the selected set is empty (including unknown/hidden IDs)
          if (categoryIds && allCategories.length === 0) {
            set({ listsPush: { isRunning: false, total: 0, done: 0, currentLabel: null, message: null, error: t('repositorySlice.no-categories-selected') } });
            return;
          }

          // 1. Fetch all current lists (including members)
          const currentLists = await api.getUserLists(user!.login);

          // 2. Build "managed lists" mapping plan: each local category -> list id.
          //    Use stable category identities (canonical name + persisted id mapping) rather than translated cat.name:
          //    otherwise alternating pushes between Chinese and English would create duplicate parallel lists (e.g. Chinese and English versions of "Web Apps").
          //    - Prefer reusing already persisted categoryListIdMap[cat.id] (stable across languages)
          //    - Otherwise find existing lists by canonical name and its localized variants (migrates legacy lists, avoids duplicates)
          //    - Only create a new list named with the canonical name when still not found, then record to mapping
          //    Plan construction is a pure local calculation, facilitating atomic pre-validation of GitHub Lists hard limits before writing.
          const plan = buildListsPushPlan(allCategories, currentLists, categoryListIdMap, defaultCategoryOverrides);

          // When pushing only a subset of categories, unselected categories might resolve to the same existing list as selected categories
          // (categories with the same name matching via name variants, or overlapping historical mappings). Such lists simultaneously
          // host memberships for unselected categories, so step 9 cannot blindly treat them as empty "managed" lists when cleaning stale members,
          // which would erroneously remove unselected category repo members. Resolve existing lists occupied by unselected categories
          // against the full category set and preserve them in step 9.
          const unselectedListIds = categoryIds
            ? new Set(
                buildListsPushPlan(
                  allCategoriesForPush.filter(cat => !categoryIds.includes(cat.id)),
                  currentLists,
                  categoryListIdMap,
                  defaultCategoryOverrides
                )
                  .filter(entry => entry.kind !== 'create')
                  .map(entry => entry.listId)
              )
            : new Set<string>();

          // 3. Pre-validate hard limits (max 32 lists, max 32 characters per list name):
          //    Triggering either aborts the entire push with zero writes and details errors to guide the user
          //    to hide/delete/rename in category management before retrying (hidden categories do not participate in push).
          const planIssue = validateListsPushPlan(plan, currentLists.length);
          if (planIssue) {
            const parts: string[] = [];
            if (planIssue.tooLongNames.length > 0) {
              const items = planIssue.tooLongNames
                .map(({ name, length }) => t('repositorySlice.lists-push-limit-name-item', { name, length, max: GITHUB_LISTS_NAME_MAX_LENGTH }))
                .join('\n');
              parts.push(t('repositorySlice.lists-push-limit-name-too-long', { max: GITHUB_LISTS_NAME_MAX_LENGTH, items }));
            }
            if (planIssue.countExceeded) {
              parts.push(t('repositorySlice.lists-push-limit-count-exceeded', {
                max: GITHUB_LISTS_MAX_COUNT,
                existing: planIssue.countExceeded.existing,
                needed: planIssue.countExceeded.needed,
              }));
            }
            set({ listsPush: { isRunning: false, total: 0, done: 0, currentLabel: null, message: null, error: parts.join('\n\n') } });
            return;
          }

          // 4. Execute plan (rename is best-effort: keep mapping on failure, naturally retrying on next push)
          const listIdByCategoryId = new Map<string, string>();
          const managedListIds = new Set<string>();
          const nextCategoryListIdMap = { ...categoryListIdMap };
          const renameFailures: string[] = [];
          const categoryById = new Map(allCategories.map(cat => [cat.id, cat]));
          for (const entry of plan) {
            const cat = categoryById.get(entry.categoryId)!;
            if (entry.kind === 'create') {
              const id = await api.createUserList(entry.name, true);
              listIdByCategoryId.set(entry.categoryId, id);
              nextCategoryListIdMap[entry.categoryId] = id;
              managedListIds.add(id);
              continue;
            }
            // auto-migrate name on language switch
            if (entry.remoteName !== cat.name) {
              try {
                await api.updateUserList(entry.listId, cat.name);
              } catch (e) {
                console.warn('rename list failed', entry.listId, entry.remoteName, '->', cat.name, e);
                renameFailures.push(`${entry.remoteName} -> ${cat.name}`);
              }
            }
            listIdByCategoryId.set(entry.categoryId, entry.listId);
            managedListIds.add(entry.listId);
            if (entry.kind === 'matched') {
              nextCategoryListIdMap[entry.categoryId] = entry.listId;
            }
          }
          if (renameFailures.length > 0) {
            logger.warn('githubLists', 'Some lists failed to rename, will retry next push', { failures: renameFailures });
          }
          // 5. Current list members per repository (lowercase full_name -> set of list IDs)
          const repoCurrentListIds = new Map<string, Set<string>>();
          const lowerToOriginal = new Map<string, string>();
          for (const list of currentLists) {
            for (const fullName of list.items) {
              const key = fullName.toLowerCase();
              lowerToOriginal.set(key, fullName);
              if (!repoCurrentListIds.has(key)) repoCurrentListIds.set(key, new Set());
              repoCurrentListIds.get(key)!.add(list.id);
            }
          }

          // 6. Target managed lists hit per repository (effective tag matching)
          const repoTargetListIds = new Map<string, Set<string>>();
          for (const repo of repositories) {
            const ownerLogin = repo.owner?.login;
            const original = repo.full_name || (ownerLogin && repo.name ? `${ownerLogin}/${repo.name}` : '');
            // Skip repos missing valid owner/name (including empty full_name) to avoid generating unparseable keys
            if (!original.includes('/')) continue;
            const key = original.toLowerCase();
            lowerToOriginal.set(key, original);
            const matched: string[] = [];
            for (const cat of allCategories) {
              if (matchesCategory(repo, cat, 'effective')) {
                const id = listIdByCategoryId.get(cat.id);
                if (id) matched.push(id);
              }
            }
            if (matched.length > 0) {
              repoTargetListIds.set(key, new Set(matched));
            }
          }

          // 7. Repositories requiring updates: those hitting managed lists, or currently in managed lists (for cleaning stale members)
          const reposToUpdate = new Map<string, Set<string>>();
          for (const [key, targetIds] of repoTargetListIds) {
            reposToUpdate.set(key, targetIds);
          }
          for (const [key, currentIds] of repoCurrentListIds) {
            const hasManagedCurrent = [...currentIds].some(id => managedListIds.has(id));
            if (hasManagedCurrent && !reposToUpdate.has(key)) {
              reposToUpdate.set(key, new Set());
            }
          }

          if (reposToUpdate.size === 0) {
            set({ listsPush: { isRunning: false, total: 0, done: 0, currentLabel: null, message: t('repositorySlice.no-repos-matched-any-category'), error: null } });
            return;
          }

          // 8. Resolve repository node IDs
          const ownerNamePairs = [...reposToUpdate.keys()].map(key => {
            const original = lowerToOriginal.get(key) || key;
            const idx = original.indexOf('/');
            return { owner: original.slice(0, idx), name: original.slice(idx + 1) };
          });
          const nodeIdMap = await api.resolveRepositoryNodeIds(ownerNamePairs);

          // 9. Overwrite writes (preserving unmanaged list memberships), updating progress per repository
          let updatedCount = 0;
          let done = 0;
          const total = reposToUpdate.size;
          for (const [key, targetIds] of reposToUpdate) {
            done++;
            set({ listsPush: { isRunning: true, total, done, currentLabel: key, message: null, error: null } });
            const itemId = nodeIdMap.get(key);
            if (!itemId) continue;
            const currentIds = repoCurrentListIds.get(key) || new Set<string>();
            // Lists shared with unselected categories are preserved as "unselected", even if simultaneously managed by selected categories
            const preservedIds = [...currentIds].filter(
              id => !managedListIds.has(id) || unselectedListIds.has(id)
            );
            const finalListIds = [...new Set([...preservedIds, ...targetIds])];
            if (finalListIds.length === currentIds.size && finalListIds.every(id => currentIds.has(id))) {
              continue;
            }
            await api.updateUserListsForItem(itemId, finalListIds);
            updatedCount++;
          }

          set({ listsPush: { isRunning: false, total, done, currentLabel: null, message: t('repositorySlice.pushed-v1-lists-updated-updatedcount-repos', { v1: listIdByCategoryId.size, updatedCount: updatedCount }), error: null }, categoryListIdMap: nextCategoryListIdMap });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error('Push categories to lists failed:', error);
          set({ listsPush: { isRunning: false, total: 0, done: 0, currentLabel: null, message: null, error: t('repositorySlice.push-failed-detail', { message }) } });
        }
      },
      deleteRepository: (repoId) => set((state) => {
        const nextReleaseSubscriptions = new Set(state.releaseSubscriptions);
        nextReleaseSubscriptions.delete(repoId);

        const filteredReleases = state.releases.filter(release => release.repository.id !== repoId);
        const remainingReleaseIds = new Set(filteredReleases.map(release => release.id));
        const nextReadReleases = new Set(
          Array.from(state.readReleases).filter(releaseId => remainingReleaseIds.has(releaseId))
        );

        return {
          repositories: state.repositories.filter(r => r.id !== repoId),
          searchResults: state.searchResults.filter(r => r.id !== repoId),
          similarView: state.similarView
            ? { ...state.similarView, similarResults: state.similarView.similarResults.filter(r => r.id !== repoId) }
            : state.similarView,
          releases: filteredReleases,
          releaseSubscriptions: nextReleaseSubscriptions,
          readReleases: nextReadReleases,
        };
      }),
      setAnalyzingRepository: (repoId, isAnalyzing) => set((state) => {
        const alreadyAnalyzing = state.analyzingRepositoryIds.has(repoId);
        if (alreadyAnalyzing === isAnalyzing) {
          return state;
        }

        const nextAnalyzingIds = new Set(state.analyzingRepositoryIds);
        if (isAnalyzing) {
          nextAnalyzingIds.add(repoId);
        } else {
          nextAnalyzingIds.delete(repoId);
        }
        return { analyzingRepositoryIds: nextAnalyzingIds };
      }),

      // Similar repositories view actions
      /**
       * Enters "find similar repositories" view: stores current similar results, anchor repository, and snapshots pre-entry
       * searchResults/searchFilters for restoration on reset (preserving first snapshot during chained searches).
       */
      enterSimilarView: (repos, anchor) => set((state) => ({
        similarView: {
          active: true,
          anchorRepoFullName: anchor.full_name,
          anchorRepoName: anchor.name,
          similarResults: repos,
          // Preserve snapshot from first entry during chained lookups to avoid overwriting reset target
          originalSearchResults: state.similarView?.originalSearchResults ?? state.searchResults,
          originalSearchFilters: state.similarView?.originalSearchFilters ?? state.searchFilters,
        },
        // Clear search filters upon entering similar view to avoid confusion with search results (similar view replaces list view)
        searchFilters: { ...initialSearchFilters },
      })),
      /**
       * Resets similar view: restores pre-entry search results and filters (returning to state before finding similar).
       */
      resetSimilarView: () => set((state) => ({
        // Restores pre-entry search results and filters (returning to state before finding similar)
        searchResults: state.similarView?.originalSearchResults ?? state.repositories,
        searchFilters: state.similarView?.originalSearchFilters ?? { ...initialSearchFilters },
        similarView: null,
      })),
      /**
       * Exits similar view (without restoring pre-entry search state): used when user initiates a new search or switches category,
       * avoiding overwriting new search/category results with stale snapshot.
       */
      exitSimilarView: () => set({ similarView: null }),

      // Search actions
      setSearchFilters: (filters) => set((state) => {
        const newFilters = { ...state.searchFilters, ...filters };

        // Handle mutually exclusive filters: isAnalyzed and analysisFailed cannot be set simultaneously
        if (filters.isAnalyzed !== undefined && filters.isAnalyzed !== null) {
          // If isAnalyzed is set, clear analysisFailed
          newFilters.analysisFailed = undefined;
        }
        if (filters.analysisFailed !== undefined && filters.analysisFailed !== null) {
          // If analysisFailed is set, clear isAnalyzed
          newFilters.isAnalyzed = undefined;
        }

        return { searchFilters: newFilters };
      }),
      setSearchResults: (searchResults) => set({ searchResults }),

});
