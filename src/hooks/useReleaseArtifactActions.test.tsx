import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Release } from '../types';
import { computeRpcDownloadKey, useReleaseArtifactActions } from './useReleaseArtifactActions';

const mocks = vi.hoisted(() => ({
  useAppStore: vi.fn(),
  toast: vi.fn(),
  sendToRpcDownload: vi.fn(),
  analyzeReleaseSummary: vi.fn(),
}));

vi.mock('../store/useAppStore', () => ({
  useAppStore: mocks.useAppStore,
}));

vi.mock('../hooks/useDialog', () => ({
  useDialog: () => ({ toast: mocks.toast, confirm: vi.fn() }),
}));

vi.mock('../services/rpcDownloadService', () => ({
  sendToRpcDownload: mocks.sendToRpcDownload,
}));

vi.mock('../services/aiService', () => ({
  AIService: class {
    analyzeReleaseSummary = mocks.analyzeReleaseSummary;
  },
}));

const createStoreState = () => ({
  language: 'en' as const,
  backendApiSecret: 'secret-1' as string | null,
  aiConfigs: [{
    id: 'ai-config',
    name: 'Test AI',
    baseUrl: 'https://example.com/v1',
    apiKey: 'ai-key',
    model: 'ai-model',
  }],
  activeAIConfig: 'ai-config' as string | null,
});

let storeState = createStoreState();
const mockUseAppStore = vi.mocked(mocks.useAppStore);
mockUseAppStore.mockImplementation((selector?: (state: typeof storeState) => unknown) =>
  selector ? selector(storeState) : storeState);
(mockUseAppStore as unknown as { getState: () => typeof storeState }).getState = () => storeState;

const release: Release = {
  id: 100,
  tag_name: 'v1.0.0',
  name: 'Version 1.0.0',
  body: 'Notes body',
  published_at: '2026-01-02T00:00:00.000Z',
  html_url: 'https://github.com/owner/repo/releases/tag/v1.0.0',
  assets: [],
  prerelease: false,
  repository: { id: 9, full_name: 'owner/repo', name: 'repo' },
};

describe('computeRpcDownloadKey', () => {
  it('versions the key with updatedAt', () => {
    expect(computeRpcDownloadKey({ url: 'https://x/a.zip', updatedAt: '2026-01-01T00:00:00.000Z' }))
      .toBe('https://x/a.zip@2026-01-01T00:00:00.000Z');
    expect(computeRpcDownloadKey({ url: 'https://x/a.zip' })).toBe('https://x/a.zip@');
    expect(computeRpcDownloadKey({ url: 'https://x/a.zip', updatedAt: undefined })).toBe('https://x/a.zip@');
  });
});

describe('useReleaseArtifactActions.sendRpcDownload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState = createStoreState();
  });

  it('passes url, name and the backend secret through and records the sent state', async () => {
    mocks.sendToRpcDownload.mockResolvedValue({ success: true });
    const { result } = renderHook(() => useReleaseArtifactActions());
    await act(async () => {
      await result.current.sendRpcDownload({ url: 'https://x/a.zip', name: 'a.zip', updatedAt: '2026-01-01T00:00:00.000Z' });
    });
    expect(mocks.sendToRpcDownload).toHaveBeenCalledWith('https://x/a.zip', 'a.zip', 'secret-1');
    expect(result.current.rpcDownloadStates['https://x/a.zip@2026-01-01T00:00:00.000Z']).toBe('sent');
    expect(mocks.toast).toHaveBeenCalledWith('Sent to remote downloader', 'success');
  });

  it('omits the secret when the store has none', async () => {
    storeState.backendApiSecret = null;
    mocks.sendToRpcDownload.mockResolvedValue({ success: true });
    const { result } = renderHook(() => useReleaseArtifactActions());
    await act(async () => {
      await result.current.sendRpcDownload({ url: 'https://x/a.zip', name: 'a.zip' });
    });
    expect(mocks.sendToRpcDownload).toHaveBeenCalledWith('https://x/a.zip', 'a.zip', undefined);
  });

  it('shows the dedicated toast when the RPC service is not running and resets the state', async () => {
    mocks.sendToRpcDownload.mockResolvedValue({ success: false, error: 'RPC service not running' });
    const { result } = renderHook(() => useReleaseArtifactActions());
    await act(async () => {
      await result.current.sendRpcDownload({ url: 'https://x/a.zip', name: 'a.zip' });
    });
    expect(mocks.toast).toHaveBeenCalledWith('Remote download service not running, please check config', 'error');
    expect(result.current.rpcDownloadStates['https://x/a.zip@']).toBe('idle');
  });

  it('falls back to the raw error or a generic message on other failures', async () => {
    mocks.sendToRpcDownload.mockResolvedValue({ success: false, error: 'quota exceeded' });
    const { result } = renderHook(() => useReleaseArtifactActions());
    await act(async () => {
      await result.current.sendRpcDownload({ url: 'https://x/a.zip', name: 'a.zip' });
    });
    expect(mocks.toast).toHaveBeenCalledWith('quota exceeded', 'error');

    mocks.sendToRpcDownload.mockResolvedValue({ success: false });
    await act(async () => {
      await result.current.sendRpcDownload({ url: 'https://x/b.zip', name: 'b.zip' });
    });
    expect(mocks.toast).toHaveBeenLastCalledWith('Send failed', 'error');
  });

  it('toasts the not-running message on a thrown error', async () => {
    mocks.sendToRpcDownload.mockRejectedValue(new Error('socket hang up'));
    const { result } = renderHook(() => useReleaseArtifactActions());
    await act(async () => {
      await result.current.sendRpcDownload({ url: 'https://x/a.zip', name: 'a.zip' });
    });
    expect(mocks.toast).toHaveBeenCalledWith('Remote download service not running, please check config', 'error');
    expect(result.current.rpcDownloadStates['https://x/a.zip@']).toBe('idle');
  });

  it('short-circuits while sending and clears the sent state on retry', async () => {
    let resolveSend!: (value: { success: boolean }) => void;
    mocks.sendToRpcDownload.mockImplementation(() => new Promise<{ success: boolean }>((resolve) => {
      resolveSend = resolve;
    }));

    const { result } = renderHook(() => useReleaseArtifactActions());
    const link = { url: 'https://x/a.zip', name: 'a.zip' };
    let first!: Promise<void>;
    act(() => {
      first = result.current.sendRpcDownload(link);
    });
    expect(result.current.rpcDownloadStates['https://x/a.zip@']).toBe('sending');

    // Consecutive clicks while sending are short-circuited: second call does not initiate a new request
    await act(async () => {
      await result.current.sendRpcDownload(link);
    });
    expect(mocks.sendToRpcDownload).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSend({ success: true });
      await first;
    });
    expect(result.current.rpcDownloadStates['https://x/a.zip@']).toBe('sent');

    // Retry: clear old success state before sending again
    mocks.sendToRpcDownload.mockResolvedValue({ success: true });
    await act(async () => {
      await result.current.sendRpcDownload(link);
    });
    expect(mocks.sendToRpcDownload).toHaveBeenCalledTimes(2);
    expect(result.current.rpcDownloadStates['https://x/a.zip@']).toBe('sent');
  });
});

describe('useReleaseArtifactActions.generateSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState = createStoreState();
  });

  it('toasts without writing state when no AI config is active', async () => {
    storeState.aiConfigs = [];
    const { result } = renderHook(() => useReleaseArtifactActions());
    await act(async () => { await result.current.generateSummary(release); });
    expect(mocks.toast).toHaveBeenCalledWith('Please configure AI service in settings first.', 'error');
    expect(result.current.summaries[100]).toBeUndefined();
    expect(mocks.analyzeReleaseSummary).not.toHaveBeenCalled();
  });

  it('stores loading → done with the generated content', async () => {
    mocks.analyzeReleaseSummary.mockResolvedValue('# Summary');
    const { result } = renderHook(() => useReleaseArtifactActions());
    await act(async () => { await result.current.generateSummary(release); });
    expect(mocks.analyzeReleaseSummary).toHaveBeenCalledWith(
      'Notes body',
      { repoName: 'owner/repo', tagName: 'v1.0.0', releaseName: 'Version 1.0.0' },
      expect.any(AbortSignal),
    );
    expect(result.current.summaries[100]).toEqual({ status: 'done', content: '# Summary' });
  });

  it('skips regeneration while loading or when a done summary exists', async () => {
    mocks.analyzeReleaseSummary.mockResolvedValue('# Summary');
    const { result } = renderHook(() => useReleaseArtifactActions());
    await act(async () => { await result.current.generateSummary(release); });

    await act(async () => { await result.current.generateSummary(release); });
    expect(mocks.analyzeReleaseSummary).toHaveBeenCalledTimes(1);

    // loading state also short-circuits
    let resolveSummary!: (value: string) => void;
    mocks.analyzeReleaseSummary.mockImplementation(() => new Promise<string>((resolve) => {
      resolveSummary = resolve;
    }));
    const second: Release = { ...release, id: 101 };
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.generateSummary(second);
    });
    await act(async () => { await result.current.generateSummary(second); });
    expect(result.current.summaries[101]?.status).toBe('loading');
    resolveSummary('# late');
    await act(async () => { await pending; });
  });

  it('collapses same-tick consecutive generateSummary calls into a single request', async () => {
    // loading guard reads render snapshot: a second synchronous invocation in the same event loop still sees the old snapshot;
    // relies on summaryAbortRefs synchronous guard for deduplication.
    mocks.analyzeReleaseSummary.mockImplementation(() => new Promise<string>(() => undefined));
    const { result } = renderHook(() => useReleaseArtifactActions());
    act(() => {
      void result.current.generateSummary(release);
      void result.current.generateSummary(release);
    });
    expect(mocks.analyzeReleaseSummary).toHaveBeenCalledTimes(1);
    expect(result.current.summaries[100]?.status).toBe('loading');
  });

  it('stores the error state and toasts on failure', async () => {
    mocks.analyzeReleaseSummary.mockRejectedValue(new Error('model offline'));
    const { result } = renderHook(() => useReleaseArtifactActions());
    await act(async () => { await result.current.generateSummary(release); });
    expect(result.current.summaries[100]).toEqual({ status: 'error', error: 'model offline' });
    expect(mocks.toast).toHaveBeenCalledWith('Summary failed: model offline', 'error');
  });

  it('stays silent on AbortError', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    mocks.analyzeReleaseSummary.mockRejectedValue(abortError);
    const { result } = renderHook(() => useReleaseArtifactActions());
    await act(async () => { await result.current.generateSummary(release); });
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(result.current.summaries[100]).toEqual({ status: 'loading' });
  });

  it('aborts all in-flight summary requests on unmount', async () => {
    const signals: AbortSignal[] = [];
    mocks.analyzeReleaseSummary.mockImplementation((_body: string, _meta: unknown, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<string>(() => undefined);
    });
    const { result, unmount } = renderHook(() => useReleaseArtifactActions());
    act(() => {
      void result.current.generateSummary(release);
    });
    expect(signals[0].aborted).toBe(false);
    unmount();
    expect(signals[0].aborted).toBe(true);
  });

  it('cancelSummaryRequests aborts in-flight requests without unmounting', async () => {
    const signals: AbortSignal[] = [];
    mocks.analyzeReleaseSummary.mockImplementation((_body: string, _meta: unknown, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<string>(() => undefined);
    });
    const { result } = renderHook(() => useReleaseArtifactActions());
    act(() => {
      void result.current.generateSummary(release);
    });
    act(() => {
      result.current.cancelSummaryRequests();
    });
    expect(signals[0].aborted).toBe(true);
  });

  it('reset cancels in-flight summaries so they cannot write back after clearing', async () => {
    // abort-aware mock: real fetch rejects with AbortError when signal is aborted
    const resolvers: Array<(value: string) => void> = [];
    mocks.analyzeReleaseSummary.mockImplementation((_b: string, _m: unknown, signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        resolvers.push((value: string) => {
          if (signal.aborted) {
            const abortError = new Error('Aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          } else {
            resolve(value);
          }
        });
      }));
    const { result } = renderHook(() => useReleaseArtifactActions());

    act(() => {
      void result.current.generateSummary(release);
    });
    expect(result.current.summaries[100]?.status).toBe('loading');

    act(() => {
      result.current.reset();
    });
    expect(result.current.summaries).toEqual({});

    // Simulate late completion: request was cancelled by reset, result must not be written back
    resolvers[0]('# stale');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(result.current.summaries).toEqual({});
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('reset discards late results even when the service ignores the abort signal', async () => {
    // H1 regression: resolving mock (ignores signal, does not throw AbortError) - before fix, late
    // done would write back into freshly cleared state; after fix, discarded by post-await aborted guard.
    let resolveSummary!: (value: string) => void;
    mocks.analyzeReleaseSummary.mockImplementation(() => new Promise<string>((resolve) => {
      resolveSummary = resolve;
    }));
    const { result } = renderHook(() => useReleaseArtifactActions());

    act(() => {
      void result.current.generateSummary(release);
    });
    expect(result.current.summaries[100]?.status).toBe('loading');

    act(() => {
      result.current.reset();
    });
    expect(result.current.summaries).toEqual({});

    resolveSummary('# stale');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(result.current.summaries).toEqual({});
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('reset clears summaries and rpc download states', async () => {
    mocks.sendToRpcDownload.mockResolvedValue({ success: true });
    mocks.analyzeReleaseSummary.mockResolvedValue('# Summary');
    const { result } = renderHook(() => useReleaseArtifactActions());
    await act(async () => {
      await result.current.sendRpcDownload({ url: 'https://x/a.zip', name: 'a.zip' });
      await result.current.generateSummary(release);
    });
    expect(result.current.summaries[100]).toEqual({ status: 'done', content: '# Summary' });
    act(() => {
      result.current.reset();
    });
    expect(result.current.summaries).toEqual({});
    expect(result.current.rpcDownloadStates).toEqual({});
  });
});
