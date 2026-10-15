
import type { AppStoreSlice } from '../types';
import { REQUIRED_HEADER_MENU_IDS } from '../schema';
import { normalizeThemeTokens } from '../../utils/themeTokens';
import { normalizeRepositoryCardFields } from '../../utils/repositoryCardFields';
import { normalizeRepositoryCardActions } from '../../utils/repositoryCardActions';

export const createPreferenceSlice: AppStoreSlice<Pick<import('../types').AppActions,
  | 'setTheme'
  | 'setThemePreset'
  | 'updateThemeTokens'
  | 'setCurrentView'
  | 'setSelectedCategory'
  | 'setLanguage'
  | 'setTranslationEngine'
  | 'setAutoTranslateRepoDescription'
  | 'setSidebarCollapsed'
  | 'setReadmeModalOpen'
  | 'setHeaderMenuConfig'
  | 'setHasHydrated'
  | 'setUpdateNotification'
  | 'dismissUpdateNotification'
  | 'setAnalysisProgress'
  | 'setProxyConfig'
  | 'setRouteMode'
  | 'setRpcDownloadConfig'
  | 'setRepositoryViewMode'
  | 'setRepositoryCardField'
  | 'setRepositoryCardActions'
  | 'setReleaseViewMode'
  | 'setReleaseShowMode'
  | 'setReleaseLatestMode'
  | 'setReleaseSelectedFilters'
  | 'toggleReleaseSelectedFilter'
  | 'clearReleaseSelectedFilters'
  | 'setReleaseSearchQuery'
  | 'toggleReleaseExpandedRepository'
  | 'setReleaseExpandedRepositories'
  | 'setReleaseIsRefreshing'
  | 'setIncludePreRelease'
  | 'setIncludeKeysInBackup'
>> = (set) => ({
      // UI actions
      setTheme: (theme) => set({ theme }),
      setThemePreset: (themePreset) => set({ themePreset }),
      // Theme tokens store only declarative preferences; side effects writing CSS variables reside in App effects.
      // Merge with current values before normalizing: callers can pass partial patches, and dirty values won't leak into the root.
      updateThemeTokens: (patch) => set((state) => ({
        themeTokens: normalizeThemeTokens({ ...state.themeTokens, ...patch }),
      })),
      setCurrentView: (currentView) => set({ currentView }),
      setSelectedCategory: (selectedCategory) => set({ selectedCategory }),
      setLanguage: (language) => set({ language }),
      setTranslationEngine: (translationEngine) => set({ translationEngine }),
      setAutoTranslateRepoDescription: (autoTranslateRepoDescription) => set({ autoTranslateRepoDescription }),
      setSidebarCollapsed: (isSidebarCollapsed) => set({ isSidebarCollapsed }),
      setReadmeModalOpen: (readmeModalOpen) => set({ readmeModalOpen }),
      setHeaderMenuConfig: (config) => set({
        headerMenuConfig: config.map(item =>
          REQUIRED_HEADER_MENU_IDS.has(item.id) ? { ...item, visible: true } : item
        ),
      }),

      // Hydration state
      setHasHydrated: (hasHydrated) => set({ hasHydrated }),

      // Update actions
      setUpdateNotification: (notification) => set({ updateNotification: notification }),
      dismissUpdateNotification: () => set({ updateNotification: null }),
      setAnalysisProgress: (newProgress) => set({ analysisProgress: newProgress }),
      setProxyConfig: (updates) => set((state) => ({
        proxyConfig: { ...state.proxyConfig, ...updates }
      })),
      setRouteMode: (routeMode) => set({ routeMode }),
      setRpcDownloadConfig: (updates) => set((state) => ({
        rpcDownloadConfig: { ...state.rpcDownloadConfig, ...updates }
      })),

      // Repository list view actions
      // Repository card field toggles: merge with current values then normalize; missing fields are automatically assigned defaults
      setRepositoryCardField: (id, visible) => set((state) => ({
        repositoryCardFields: normalizeRepositoryCardFields({ ...state.repositoryCardFields, [id]: visible }),
      })),
      setRepositoryCardActions: (actions) => set({ repositoryCardActions: normalizeRepositoryCardActions(actions) }),
      setRepositoryViewMode: (repositoryViewMode) => set({ repositoryViewMode }),

      // Release Timeline View actions
      setReleaseViewMode: (releaseViewMode) => set({ releaseViewMode }),
      setReleaseShowMode: (releaseShowMode) => set({ releaseShowMode }),
      setReleaseLatestMode: (releaseLatestMode) => set({ releaseLatestMode }),
      setReleaseSelectedFilters: (releaseSelectedFilters) => set({ releaseSelectedFilters }),
      toggleReleaseSelectedFilter: (filterId) => set((state) => ({
        releaseSelectedFilters: state.releaseSelectedFilters.includes(filterId)
          ? state.releaseSelectedFilters.filter(id => id !== filterId)
          : [...state.releaseSelectedFilters, filterId]
      })),
      clearReleaseSelectedFilters: () => set({ releaseSelectedFilters: [] }),
      setReleaseSearchQuery: (releaseSearchQuery) => set({ releaseSearchQuery }),
      toggleReleaseExpandedRepository: (repoId) => set((state) => {
        const newSet = new Set(state.releaseExpandedRepositories);
        if (newSet.has(repoId)) {
          newSet.delete(repoId);
        } else {
          newSet.add(repoId);
        }
        return { releaseExpandedRepositories: newSet };
      }),
      setReleaseExpandedRepositories: (releaseExpandedRepositories) => set({ releaseExpandedRepositories }),
      setReleaseIsRefreshing: (releaseIsRefreshing) => set({ releaseIsRefreshing }),
      setIncludePreRelease: (includePreRelease) => set({ includePreRelease }),
      setIncludeKeysInBackup: (includeKeysInBackup) => set({ includeKeysInBackup }),

});
