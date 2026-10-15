
import React, { Suspense, useSyncExternalStore } from 'react';
import { useT } from '../i18n/useT';
import { pluginPageSession } from '../plugins/pluginPageSession';
import { ErrorBoundary } from './ErrorBoundary';

const LazyPluginPageModal = React.lazy(() =>
  import('./PluginPageModal').then((module) => ({ default: module.PluginPageModal }))
);

/**
 * Application-level plugin page modal. Persists at the app root during the session; unmounting cards or menus does not affect it.
 */
export const PluginPageHost: React.FC = () => {
  const session = useSyncExternalStore(
    pluginPageSession.subscribe,
    pluginPageSession.getSnapshot,
    pluginPageSession.getSnapshot,
  );
  // Page copy belongs to the app namespace; card menus use repositories, so do not mix them.
  const t = useT('app');
  if (!session?.repository) return null;

  const { repository, ...page } = session;
  return (
    <ErrorBoundary>
      <Suspense fallback={null}>
        <LazyPluginPageModal
          {...page}
          repository={repository}
          onClose={() => pluginPageSession.close()}
          t={t}
        />
      </Suspense>
    </ErrorBoundary>
  );
};
