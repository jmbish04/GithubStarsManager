



import { useT } from '../../../i18n/useT';
import { useCallback, useState } from 'react';
import { useAppStore } from '../../../store/useAppStore';
import { createGitHubApiService } from '../../../services/githubApiFactory';
import { useDialog } from '../../../hooks/useDialog';
import {
  normalizeRepoKey,
  repositoryToCustomReleaseRepository,
  WATCH_CUSTOM_RELEASE_SOURCE_ID,
} from '../../../utils/releaseSources';

/**
 * Syncs watched repositories as release sources (formerly ReleaseSourceSettingsModal →
 * WatchCustomReleaseSyncPanel.handleSync): no confirm, no forceSync, no Abort.
 * A narrow-subscription hook independent of useReleaseTimelineActions: the settings modal
 * only needs these two items and should not re-render with the entire release timeline state.
 */
export const useWatchedSourcesSync = () => {
  const githubToken = useAppStore((s) => s.githubToken);
  const setReleaseSourceRepositories = useAppStore((s) => s.setReleaseSourceRepositories);
  const { toast } = useDialog();
  const [isSyncingWatchedSources, setIsSyncingWatchedSources] = useState(false);
  const t = useT('releases');

  const syncWatchedSources = useCallback(async () => {
    if (!githubToken || isSyncingWatchedSources) return;

    setIsSyncingWatchedSources(true);
    try {
      const githubApi = createGitHubApiService(githubToken);
      // Only fetch /user/subscriptions (includes private repos). /users/{login}/subscriptions was
      // changed by GitHub to consistently return 204 No Content, and its results were already a public subset
      // of the former; merging them in parallel would only drag down the entire sync.
      const watchedRepos = await githubApi.getAllWatchedRepositories();
      // Read hiddenByRepo from the latest state after await: the user can still toggle
      // release_hidden in the settings panel during sync, and a stale snapshot would overwrite those edits on setReleaseSourceRepositories.
      const hiddenByRepo = new Map(
        useAppStore.getState().releaseSourceSettings.watchCustomReleaseRepos.map(repo => [normalizeRepoKey(repo.full_name), repo.release_hidden]),
      );
      const sourceRepos = watchedRepos.map(repo => ({
        ...repositoryToCustomReleaseRepository(repo, WATCH_CUSTOM_RELEASE_SOURCE_ID),
        release_hidden: hiddenByRepo.get(normalizeRepoKey(repo.full_name)) || undefined,
      }));
      setReleaseSourceRepositories(WATCH_CUSTOM_RELEASE_SOURCE_ID, sourceRepos);
      toast(
        t('useWatchedSourcesSync.synced-v1-watch-repositories', { v1: sourceRepos.length }),
        'success'
      );
    } catch (error) {
      console.error('Failed to sync watched repositories:', error);
      toast(t('useWatchedSourcesSync.failed-to-sync-watch-repositories-check-network'), 'error');
    } finally {
      setIsSyncingWatchedSources(false);
    }
  }, [githubToken, isSyncingWatchedSources, setReleaseSourceRepositories, t, toast]);

  return { syncWatchedSources, isSyncingWatchedSources };
};
