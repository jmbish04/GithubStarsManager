import { useAppStore } from '../store/useAppStore';
import { backend } from './backendAdapter';
import { GitHubApiService } from './githubApi';
import { GitHubListsApiService } from './githubListsApi';
import { shouldBypassBackend } from './routeMode';

/**
  * Decides whether a newly created service should attach the backend proxy.
  * Returns true only when the backend is available and the current routeMode is not 'browser'.
  * routeMode is read once at construction; existing services are not re-routed on the fly after routeMode changes,
  * only newly created services follow the current preference.
 */
function shouldAttachBackend(): boolean {
  return backend.backendUrl != null && !shouldBypassBackend();
}

export interface CreateGitHubApiServiceOptions {
  /**
      * Connect directly to api.github.com even when the backend is available.
      * For fetch helpers that "wear two hats": the primary path in browser mode / with no backend,
      * and the fallback path after a backend request fails — falling back through the backend that just failed would be pointless
      * (consistent with the sticky direct-connect fallback convention in githubListsApi).
   */
  direct?: boolean;
}

export function createGitHubApiService(
  token: string,
  options: CreateGitHubApiServiceOptions = {},
): GitHubApiService {
  const api = new GitHubApiService(token);

  if (!options.direct && shouldAttachBackend()) {
    api.setBackendUrl(backend.backendUrl);
    api.setBackendAuthToken(useAppStore.getState().backendApiSecret || null);
  }

  return api;
}

export function createGitHubListsApiService(token: string): GitHubListsApiService {
  const api = new GitHubListsApiService(token);

  if (shouldAttachBackend()) {
    api.setBackendUrl(backend.backendUrl);
    api.setBackendAuthToken(useAppStore.getState().backendApiSecret || null);
  }

  return api;
}
