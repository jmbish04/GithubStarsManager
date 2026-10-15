
import { useT } from '../i18n/useT';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { createGitHubApiService } from '../services/githubApiFactory';
import { backend } from '../services/backendAdapter';
import { shouldBypassBackend } from '../services/routeMode';
import { useAppStore } from '../store/useAppStore';
import type { GitHubReadmeCandidateItem, ReadmeVariant } from '../utils/readmeVariants';

const isAbortError = (error: unknown, signal?: AbortSignal): boolean => {
  return Boolean(signal?.aborted || (error as { name?: string })?.name === 'AbortError');
};

// When a controller is aborted by the hook itself (superseded by a new request or via cancel()),
// reject with an AbortError. Callers discard stale results without updating loading state—
// equivalent to the previous View-owned signal check after resolve (View no longer holds the controller).
const abortOperation = (): Error => new DOMException('Aborted', 'AbortError');

export interface UseReadmeFetchOptions {
  owner: string;
  name: string;
}

export interface ReadmeFetchActions {
  fetchReadmeContent: (variant: ReadmeVariant) => Promise<string>;
  fetchReadmeCandidates: (defaultBranch: string | undefined) => Promise<GitHubReadmeCandidateItem[]>;
  /** Aborts both controllers and nulls them out; called when the View closes the modal, and automatically on hook unmount. */
  cancel: () => void;
}

export const useReadmeFetch = ({ owner, name }: UseReadmeFetchOptions): ReadmeFetchActions => {
  const { githubToken } = useAppStore(useShallow((state) => ({
    githubToken: state.githubToken,
  })));

  const contentAbortRef = useRef<AbortController | null>(null);
  const t = useT('app');
  const candidatesAbortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    if (contentAbortRef.current) {
      contentAbortRef.current.abort();
      contentAbortRef.current = null;
    }
    if (candidatesAbortRef.current) {
      candidatesAbortRef.current.abort();
      candidatesAbortRef.current = null;
    }
  }, []);

  useEffect(() => cancel, [cancel]);

  const fetchReadmeContent = useCallback(async (variant: ReadmeVariant): Promise<string> => {
    if (contentAbortRef.current) {
      contentAbortRef.current.abort();
    }
    const controller = new AbortController();
    contentAbortRef.current = controller;
    const signal = controller.signal;

    const fetchFromGitHubApi = async (): Promise<string> => {
      if (!githubToken) {
        throw new Error(t('useReadmeFetch.not-logged-in-and-backend-unavailable-cannot-loa'));
      }
      const githubApi = createGitHubApiService(githubToken, { direct: true });
      return variant.isDefault || !variant.path
        ? githubApi.getRepositoryReadme(owner, name, signal)
        : githubApi.getRepositoryReadmeByPath(owner, name, variant.path, signal);
    };

    if (shouldBypassBackend() || !backend.isAvailable) {
      const directContent = await fetchFromGitHubApi();
      if (signal.aborted) throw abortOperation();
      return directContent;
    }

    try {
      const content = variant.isDefault || !variant.path
        ? await backend.getRepositoryReadme(owner, name, signal)
        : await backend.getRepositoryReadmeByPath(owner, name, variant.path, signal);
      if (signal.aborted) throw abortOperation();
      return content;
    } catch (backendError) {
      if (signal.aborted) throw abortOperation();
      if (isAbortError(backendError, signal) || !githubToken) {
        throw backendError;
      }

      console.warn('Falling back to direct GitHub README fetch after backend failure:', backendError);
      const content = await fetchFromGitHubApi();
      if (signal.aborted) throw abortOperation();
      return content;
    }
  }, [owner, name, githubToken, t]);

  const fetchReadmeCandidates = useCallback(async (defaultBranch: string | undefined): Promise<GitHubReadmeCandidateItem[]> => {
    if (candidatesAbortRef.current) {
      candidatesAbortRef.current.abort();
    }
    const controller = new AbortController();
    candidatesAbortRef.current = controller;
    const signal = controller.signal;

    const fetchFromGitHubApi = async (): Promise<GitHubReadmeCandidateItem[]> => {
      if (!githubToken) return [];
      const githubApi = createGitHubApiService(githubToken, { direct: true });
      return githubApi.listRepositoryReadmeCandidates(owner, name, defaultBranch, signal);
    };

    if (shouldBypassBackend() || !backend.isAvailable) {
      const directCandidates = await fetchFromGitHubApi();
      if (signal.aborted) throw abortOperation();
      return directCandidates;
    }

    try {
      const candidates = await backend.listRepositoryReadmeCandidates(owner, name, defaultBranch, signal);
      if (signal.aborted) throw abortOperation();
      return candidates;
    } catch (backendError) {
      if (signal.aborted) throw abortOperation();
      if (isAbortError(backendError, signal) || !githubToken) {
        throw backendError;
      }

      console.warn('Falling back to direct GitHub README variant detection after backend failure:', backendError);
      const candidates = await fetchFromGitHubApi();
      if (signal.aborted) throw abortOperation();
      return candidates;
    }
  }, [owner, name, githubToken]);

  return useMemo(() => ({
    fetchReadmeContent,
    fetchReadmeCandidates,
    cancel,
  }), [fetchReadmeContent, fetchReadmeCandidates, cancel]);
};

// Extracted variant selection logic (find(...) || default) originally in ReadmeModal.
export const pickReadmeCandidate = (
  variants: ReadmeVariant[],
  selectedKey: string | undefined,
  defaultVariant: ReadmeVariant,
): ReadmeVariant => variants.find(variant => variant.key === selectedKey) || defaultVariant;
