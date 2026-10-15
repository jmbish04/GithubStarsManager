



import { useT } from '../../../i18n/useT';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Release, ReleaseAsset, Repository } from '../../../types';
import { backend } from '../../../services/backendAdapter';
import { createGitHubApiService } from '../../../services/githubApiFactory';
import { shouldBypassBackend } from '../../../services/routeMode';
import { useAppStore } from '../../../store/useAppStore';
import { useDialog } from '../../../hooks/useDialog';
import { computeRpcDownloadKey, useReleaseArtifactActions } from '../../../hooks/useReleaseArtifactActions';
import type { ReleaseDownloadLink } from '../../../utils/releaseDownloadLinks';

const REMOTE_RELEASE_PAGE_SIZE = 100;
const MAX_LIVE_RELEASES = 200;

const isAbortError = (error: unknown): boolean => (
  error instanceof DOMException && error.name === 'AbortError'
) || (
  error instanceof Error && error.name === 'AbortError'
);

const asString = (value: unknown): string | null => typeof value === 'string' ? value : null;
const asNumber = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

const mapBackendAsset = (value: unknown): ReleaseAsset | null => {
  if (!value || typeof value !== 'object') return null;
  const asset = value as Record<string, unknown>;
  const id = asNumber(asset.id);
  const name = asString(asset.name);
  const size = asNumber(asset.size);
  const browserDownloadUrl = asString(asset.browser_download_url);
  if (id === null || name === null || size === null || browserDownloadUrl === null) return null;

  return {
    id,
    name,
    size,
    browser_download_url: browserDownloadUrl,
    download_count: asNumber(asset.download_count) ?? 0,
    content_type: asString(asset.content_type) ?? '',
    created_at: asString(asset.created_at) ?? '',
    updated_at: asString(asset.updated_at) ?? '',
  };
};

const mapBackendRelease = (value: Record<string, unknown>, repository: Repository): Release => {
  const id = asNumber(value.id);
  const tagName = asString(value.tag_name);
  const publishedAt = asString(value.published_at);
  const htmlUrl = asString(value.html_url);
  if (id === null || tagName === null || publishedAt === null || htmlUrl === null) {
    throw new Error('Backend proxy returned an invalid release');
  }

  const rawAssets = Array.isArray(value.assets) ? value.assets : [];
  return {
    id,
    tag_name: tagName,
    name: asString(value.name),
    body: asString(value.body),
    published_at: publishedAt,
    html_url: htmlUrl,
    assets: rawAssets.map(mapBackendAsset).filter((asset): asset is ReleaseAsset => asset !== null),
    zipball_url: asString(value.zipball_url) ?? undefined,
    tarball_url: asString(value.tarball_url) ?? undefined,
    prerelease: value.prerelease === true,
    repository: {
      id: repository.id,
      full_name: repository.full_name,
      name: repository.name,
    },
  };
};

const withRepositoryIdentity = (release: Release, repository: Repository): Release => ({
  ...release,
  repository: {
    id: repository.id,
    full_name: repository.full_name,
    name: repository.name,
  },
});

const getRepositoryCoordinates = (fullName: string): { owner: string; name: string } => {
  const [owner, ...nameParts] = fullName.split('/');
  const name = nameParts.join('/');
  if (!owner || !name) throw new Error('Invalid repository full name');
  return { owner, name };
};

const getErrorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

const isPublishedReleaseRecord = (value: Record<string, unknown>): boolean => (
  value.draft !== true && typeof value.published_at === 'string'
);

const downloadBrowserBlob = (blob: Blob, fileName: string) => {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
};

export const useRepositoryReleaseSheet = (repository: Repository) => {
  const {

    githubToken,
    rpcDownloadConfig,
  } = useAppStore(useShallow((state) => ({
    language: state.language,
    githubToken: state.githubToken,
    rpcDownloadConfig: state.rpcDownloadConfig,
  })));
  const { toast } = useDialog();
  // RPC sending and AI summary actions are delegated to the shared hook (avoiding a third copy);
  // summaries/downloadStates external shapes are supplied by the hook, and downloadStates keys
  // are versioned via computeRpcDownloadKey(link).
  const artifactActions = useReleaseArtifactActions();
  // The artifactActions object returned by the shared hook changes reference when summaries/RPC
  // state updates — dependencies must only attach to its destructured, reference-stable members
  // (useCallback with zero dependencies or depending only on store values); otherwise every state
  // update would change the identity of cancel effect / loadReleases / sendAssetToRpc.
  const { cancelSummaryRequests, reset: resetArtifactStates, sendRpcDownload } = artifactActions;
  const [releases, setReleases] = useState<Release[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Inline sending state for non-RPC (browser) download path is outside RPC delegation scope,
  // retained in this hook; also uses versioned keys, exposed externally merged with RPC state.
  const [browserDownloadStates, setBrowserDownloadStates] = useState<Record<string, 'idle' | 'sending'>>({});
  const fetchAbortRef = useRef<AbortController | null>(null);
  const t = useT('repositories');

  const cancelPendingRequests = useCallback(() => {
    fetchAbortRef.current?.abort();
    fetchAbortRef.current = null;
    cancelSummaryRequests();
  }, [cancelSummaryRequests]);

  useEffect(() => cancelPendingRequests, [cancelPendingRequests]);

  const fetchAllPages = useCallback(async (
    getPage: (page: number, signal: AbortSignal) => Promise<{ releases: Release[]; hasMore: boolean }>,
    signal: AbortSignal,
  ): Promise<Release[]> => {
    const collected: Release[] = [];
    let page = 1;

    while (collected.length < MAX_LIVE_RELEASES) {
      const { releases, hasMore } = await getPage(page, signal);
      collected.push(...releases.slice(0, MAX_LIVE_RELEASES - collected.length));
      if (!hasMore || collected.length >= MAX_LIVE_RELEASES) break;
      page += 1;
    }

    return collected;
  }, []);

  const loadReleases = useCallback(async () => {
    fetchAbortRef.current?.abort();
    const controller = new AbortController();
    fetchAbortRef.current = controller;
    setIsLoading(true);
    setError(null);
    setBrowserDownloadStates({});
    resetArtifactStates();

    try {
      const { owner, name } = getRepositoryCoordinates(repository.full_name);
      let liveReleases: Release[] | null = null;
      let backendError: unknown;

      if (!shouldBypassBackend() && backend.isAvailable) {
        try {
          liveReleases = await fetchAllPages(async (page, signal) => {
            const records = await backend.getRepositoryReleases(owner, name, page, REMOTE_RELEASE_PAGE_SIZE, signal);
            return {
              releases: records
                .filter(isPublishedReleaseRecord)
                .map((record) => mapBackendRelease(record, repository)),
              hasMore: records.length === REMOTE_RELEASE_PAGE_SIZE,
            };
          }, controller.signal);
        } catch (requestError) {
          if (isAbortError(requestError)) throw requestError;
          backendError = requestError;
        }
      }

      if (liveReleases === null) {
        if (!githubToken) {
          throw backendError || new Error(t('useRepositoryReleaseSheet.configure-a-github-token-in-settings-or-connect'));
        }
        const githubApi = createGitHubApiService(githubToken, { direct: true });
        liveReleases = await fetchAllPages(
          (page, signal) => githubApi.getRepositoryReleasesPage(owner, name, page, REMOTE_RELEASE_PAGE_SIZE, signal),
          controller.signal,
        );
      }

      if (controller.signal.aborted) return;
      setReleases(liveReleases.map((release) => withRepositoryIdentity(release, repository)));
    } catch (requestError) {
      if (isAbortError(requestError) || controller.signal.aborted) return;
      setReleases([]);
      setError(getErrorMessage(requestError));
    } finally {
      if (fetchAbortRef.current === controller) {
        fetchAbortRef.current = null;
        setIsLoading(false);
      }
    }
  }, [resetArtifactStates, fetchAllPages, githubToken, repository, t]);

  const sendAssetToRpc = useCallback(async (link: ReleaseDownloadLink) => {
    // The enabled guard stays in sheet: on the ReleaseCard side, button visibility handles it (shared hook does not re-check)
    if (!rpcDownloadConfig.enabled) return;
    await sendRpcDownload(link);
  }, [sendRpcDownload, rpcDownloadConfig.enabled]);

  const downloadAsset = useCallback(async (link: ReleaseDownloadLink) => {
    if (rpcDownloadConfig.enabled) {
      await sendAssetToRpc(link);
      return;
    }

    const downloadKey = computeRpcDownloadKey(link);
    if (browserDownloadStates[downloadKey] === 'sending') return;
    setBrowserDownloadStates((previous) => ({ ...previous, [downloadKey]: 'sending' }));

    try {
      let blob: Blob;
      if (githubToken && link.authenticatedUrl) {
        const response = await fetch(link.authenticatedUrl, {
          headers: {
            Accept: 'application/octet-stream',
            Authorization: `Bearer ${githubToken}`,
          },
        });
        if (!response.ok) {
          throw new Error(`${t('useRepositoryReleaseSheet.download-failed')} (${response.status})`);
        }
        blob = await response.blob();
      } else if (!shouldBypassBackend() && backend.isAvailable && link.authenticatedPath) {
        blob = await backend.downloadGitHubResource(link.authenticatedPath);
      } else {
        window.open(link.url, '_blank', 'noopener,noreferrer');
        setBrowserDownloadStates((previous) => ({ ...previous, [downloadKey]: 'idle' }));
        return;
      }
      downloadBrowserBlob(blob, link.name);
      setBrowserDownloadStates((previous) => ({ ...previous, [downloadKey]: 'idle' }));
    } catch (downloadError) {
      setBrowserDownloadStates((previous) => ({ ...previous, [downloadKey]: 'idle' }));
      toast(`${t('useRepositoryReleaseSheet.download-failed')}: ${getErrorMessage(downloadError)}`, 'error');
    }
  }, [browserDownloadStates, githubToken, rpcDownloadConfig.enabled, sendAssetToRpc, t, toast]);

  const generateSummary = artifactActions.generateSummary;

  return {
    releases,
    isLoading,
    error,
    summaries: artifactActions.summaries,
    downloadStates: useMemo(
      () => ({ ...browserDownloadStates, ...artifactActions.rpcDownloadStates }),
      [browserDownloadStates, artifactActions.rpcDownloadStates],
    ),
    isRpcEnabled: rpcDownloadConfig.enabled,
    loadReleases,
    sendAssetToRpc,
    downloadAsset,
    generateSummary,
    cancelPendingRequests,
  };
};
