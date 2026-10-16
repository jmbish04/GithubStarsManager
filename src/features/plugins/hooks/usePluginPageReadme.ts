
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { createGitHubApiService } from '../../../services/githubApiFactory';
import { useAppStore } from '../../../store/useAppStore';
import type { Repository } from '../../../types';

export interface PluginPageRepositoryContext {
  readme: string | null;
}

/**
 * Fetches the repository README when the modal action (V1.4 opensPage) opens, delivering it
 * once to the plugin page via plugin-page:init. Returns null on fetch failure; plugins must
 * be able to function using metadata alone.
 */
export function usePluginPageReadme(repository: Repository): PluginPageRepositoryContext {
  const githubToken = useAppStore(useShallow((state) => state.githubToken));
  const [readme, setReadme] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    setReadme(null);
    try {
      const api = createGitHubApiService(githubToken ?? '');
      void api.getRepositoryReadme(repository.owner.login, repository.name, controller.signal)
        .then((content) => { if (!disposed) setReadme(content); })
        .catch(() => { if (!disposed) setReadme(null); });
    } catch {
      if (!disposed) setReadme(null);
    }
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [githubToken, repository.id, repository.owner.login, repository.name]);

  return { readme };
}
