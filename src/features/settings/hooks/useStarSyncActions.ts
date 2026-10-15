
import { useT } from '../../../i18n/useT';
import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../../store/useAppStore';
import { useDialog } from '../../../hooks/useDialog';
import { createGitHubListsApiService } from '../../../services/githubApiFactory';

export interface StarSyncActions {
  pushCategoriesToLists: (categoryIds?: string[]) => Promise<void>;
}

/** Encapsulates the confirmed GitHub Lists synchronization workflow. */
export const useStarSyncActions = (): StarSyncActions => {
  // This hook's strings are in the settings namespace; the panel passes t bound to the app namespace,
  // where missing keys would render verbatim (historical bug), so bind to settings directly.
  const t = useT('settings');
  const { githubToken, pushCategoriesToLists, setListsPushError } = useAppStore(useShallow((state) => ({
    githubToken: state.githubToken,
    pushCategoriesToLists: state.pushCategoriesToLists,
    setListsPushError: state.setListsPushError,
  })));
  const { confirm } = useDialog();

  const push = useCallback(async (categoryIds?: string[]) => {

    if (!githubToken) {
      setListsPushError(t('useStarSyncActions.not-connected-to-github-yet'));
      return;
    }
    const confirmed = await confirm(
      t('useStarSyncActions.push-categories-to-github-lists'),
      categoryIds
        ? t('useStarSyncActions.push-confirm-body-selected', { count: categoryIds.length })
        : t('useStarSyncActions.push-confirm-body'),
      { type: 'warning' },
    );
    if (!confirmed) return;
    await pushCategoriesToLists(createGitHubListsApiService(githubToken), categoryIds);
  }, [confirm, githubToken, pushCategoriesToLists, setListsPushError, t]);

  return { pushCategoriesToLists: push };
};
