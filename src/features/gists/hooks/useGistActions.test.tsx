import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Gist } from '../../../types';
import { applyGistAnalysisFailure, applyGistAnalysisSuccess, useGistActions } from './useGistActions';

const mocks = vi.hoisted(() => ({
  useAppStore: vi.fn(),
  toast: vi.fn(),
  confirm: vi.fn(),
  forceSyncToBackend: vi.fn(),
  getGistForAnalysis: vi.fn(),
  getGistContentPreview: vi.fn(),
  unstarGist: vi.fn(),
  deleteGist: vi.fn(),
  getGistFileRaw: vi.fn(),
  analyzeGist: vi.fn(),
}));

vi.mock('../../../store/useAppStore', () => ({
  useAppStore: mocks.useAppStore,
}));

vi.mock('../../../hooks/useDialog', () => ({
  useDialog: () => ({ toast: mocks.toast, confirm: mocks.confirm }),
}));

vi.mock('../../../services/autoSync', () => ({
  forceSyncToBackend: mocks.forceSyncToBackend,
}));

vi.mock('../../../services/githubApiFactory', () => ({
  createGitHubApiService: () => ({
    getGistForAnalysis: mocks.getGistForAnalysis,
    getGistContentPreview: mocks.getGistContentPreview,
    unstarGist: mocks.unstarGist,
    deleteGist: mocks.deleteGist,
    getGistFileRaw: mocks.getGistFileRaw,
  }),
}));

vi.mock('../../../services/aiService', () => ({
  AIService: class {
    analyzeGist = mocks.analyzeGist;
  },
}));

const createStoreState = () => ({
  user: { login: 'me', avatar_url: 'https://example.com/me.png' },
  githubToken: 'github-token' as string | null,
  gists: [],
  starredGists: [],
  gistSearchFilters: { query: '' },
  gistSearchResults: [],
  selectedGistCategory: 'all' as const,
  aiConfigs: [{
    id: 'ai-config',
    name: 'Test AI',
    baseUrl: 'https://example.com/v1',
    apiKey: 'ai-key',
    model: 'ai-model',
  }],
  activeAIConfig: 'ai-config',
  language: 'en' as const,
  setGists: vi.fn(),
  setStarredGists: vi.fn(),
  updateGist: vi.fn(),
  deleteGist: vi.fn(),
  setGistSearchFilters: vi.fn(),
  setGistSearchResults: vi.fn(),
  setSelectedGistCategory: vi.fn(),
  setAnalyzingGist: vi.fn(),
  analyzingGistIds: new Set<string>(),
});

let storeState = createStoreState();
const mockUseAppStore = vi.mocked(mocks.useAppStore);
mockUseAppStore.mockImplementation((selector?: (state: typeof storeState) => unknown) =>
  selector ? selector(storeState) : storeState);
(mockUseAppStore as unknown as { getState: () => typeof storeState }).getState = () => storeState;

const gist: Gist = {
  id: 'gist-1',
  description: 'A gist',
  public: true,
  html_url: 'https://gist.github.com/me/gist-1',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  comments: 0,
  owner: { login: 'me', avatar_url: 'https://example.com/me.png' },
  files: {
    'a.ts': { filename: 'a.ts', type: 'text/plain', language: 'TypeScript', size: 10, content: 'const a = 1;' },
  },
};

const gistDetail: Gist = {
  ...gist,
  files: {
    'a.ts': { filename: 'a.ts', type: 'text/plain', language: 'TypeScript', size: 20, content: 'const a = 1; // full' },
  },
};

describe('useGistActions card actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState = createStoreState();
  });

  describe('analyzeOne', () => {
    it('validates token, config presence and completeness in order before analyzing', async () => {
      storeState.githubToken = null;
      const { result, rerender } = renderHook(() => useGistActions());
      await act(async () => { await result.current.analyzeOne(gist); });
      expect(mocks.toast).toHaveBeenCalledTimes(1);
      expect(mocks.toast).toHaveBeenCalledWith('GitHub token not found. Please login again.', 'error');

      storeState.githubToken = 'github-token';
      storeState.aiConfigs = [];
      rerender();
      await act(async () => { await result.current.analyzeOne(gist); });
      expect(mocks.toast).toHaveBeenLastCalledWith('Please configure AI service in settings first.', 'error');

      storeState.aiConfigs = [{ id: 'ai-config', name: 'Broken', baseUrl: '', apiKey: '', model: '' }];
      rerender();
      await act(async () => { await result.current.analyzeOne(gist); });
      expect(mocks.toast).toHaveBeenLastCalledWith('AI service configuration is incomplete. Please check settings.', 'error');
      expect(mocks.getGistForAnalysis).not.toHaveBeenCalled();
    });

    it('asks for confirmation when the gist was analyzed before and aborts on cancel', async () => {
      storeState.gists = [];
      const analyzedGist = { ...gist, analyzed_at: '2026-01-03T00:00:00.000Z' };
      mocks.confirm.mockResolvedValue(false);
      const { result } = renderHook(() => useGistActions());
      await act(async () => { await result.current.analyzeOne(analyzedGist); });
      expect(mocks.confirm).toHaveBeenCalledWith(
        'Re-analyze Confirmation',
        'This gist has already been analyzed. Overwrite the existing summary?',
        { type: 'warning' },
      );
      expect(mocks.getGistForAnalysis).not.toHaveBeenCalled();
      expect(storeState.setAnalyzingGist).not.toHaveBeenCalled();
    });

    it('patches the success fields from the fetched detail and does not force sync', async () => {
      mocks.getGistForAnalysis.mockResolvedValue(gistDetail);
      mocks.getGistContentPreview.mockReturnValue('preview');
      mocks.analyzeGist.mockResolvedValue('  summary text  ');
      const { result } = renderHook(() => useGistActions());
      await act(async () => { await result.current.analyzeOne(gist); });

      expect(mocks.confirm).not.toHaveBeenCalled();
      expect(storeState.setAnalyzingGist).toHaveBeenCalledWith('gist-1', true);
      expect(storeState.setAnalyzingGist).toHaveBeenLastCalledWith('gist-1', false);
      expect(storeState.updateGist).toHaveBeenCalledTimes(1);
      const patch = storeState.updateGist.mock.calls[0][0] as Gist;
      expect(patch.ai_summary).toBe('summary text');
      expect(patch.analyzed_at).toEqual(expect.any(String));
      expect(patch.analysis_failed).toBe(false);
      expect(patch.analysis_error).toBeUndefined();
      // Successful patch uses the fetched detail as the base (more complete content than list cache)
      expect(patch.files['a.ts'].content).toBe('const a = 1; // full');
      expect(mocks.toast).toHaveBeenCalledWith('Gist AI analysis completed', 'success');
      expect(mocks.forceSyncToBackend).not.toHaveBeenCalled();
    });

    it('patches failure fields and toasts on analysis error', async () => {
      mocks.getGistForAnalysis.mockRejectedValue(new Error('boom'));
      const { result } = renderHook(() => useGistActions());
      await act(async () => { await result.current.analyzeOne(gist); });

      expect(storeState.updateGist).toHaveBeenCalledTimes(1);
      const patch = storeState.updateGist.mock.calls[0][0] as Gist;
      expect(patch.analyzed_at).toEqual(expect.any(String));
      expect(patch.analysis_failed).toBe(true);
      expect(patch.analysis_error).toBe('boom');
      expect(mocks.toast).toHaveBeenCalledWith('Gist AI analysis failed', 'error');
      expect(storeState.setAnalyzingGist).toHaveBeenLastCalledWith('gist-1', false);
    });
  });

  describe('unstarGist', () => {
    it('aborts silently without token and when confirm is declined', async () => {
      storeState.githubToken = null;
      const { result, rerender } = renderHook(() => useGistActions());
      await act(async () => { await result.current.unstarGist(gist, vi.fn()); });
      expect(mocks.confirm).not.toHaveBeenCalled();
      expect(mocks.unstarGist).not.toHaveBeenCalled();

      storeState.githubToken = 'github-token';
      rerender();
      mocks.confirm.mockResolvedValue(false);
      await act(async () => { await result.current.unstarGist(gist, vi.fn()); });
      expect(mocks.confirm).toHaveBeenCalledTimes(1);
      expect(mocks.unstarGist).not.toHaveBeenCalled();
    });

    it('calls onUnstarred before the store update and toasts success', async () => {
      mocks.confirm.mockResolvedValue(true);
      const onUnstarred = vi.fn();
      const { result } = renderHook(() => useGistActions());
      await act(async () => { await result.current.unstarGist(gist, onUnstarred); });

      expect(mocks.unstarGist).toHaveBeenCalledWith('gist-1');
      const onUnstarredOrder = onUnstarred.mock.invocationCallOrder[0];
      const updateOrder = storeState.updateGist.mock.invocationCallOrder[0];
      expect(onUnstarredOrder).toBeLessThan(updateOrder);
      expect(storeState.updateGist).toHaveBeenCalledWith({ ...gist, starred: false });
      expect(mocks.toast).toHaveBeenCalledWith('Unstarred', 'success');
    });

    it('toasts failure without store update when the api call rejects', async () => {
      mocks.confirm.mockResolvedValue(true);
      mocks.unstarGist.mockRejectedValue(new Error('network'));
      const onUnstarred = vi.fn();
      const { result } = renderHook(() => useGistActions());
      await act(async () => { await result.current.unstarGist(gist, onUnstarred); });

      expect(onUnstarred).not.toHaveBeenCalled();
      expect(storeState.updateGist).not.toHaveBeenCalled();
      expect(mocks.toast).toHaveBeenCalledWith('Failed to unstar', 'error');
    });
  });

  describe('deleteGist', () => {
    it('skips silently without token or when the gist is not owned by the user', async () => {
      storeState.githubToken = null;
      const { result, rerender } = renderHook(() => useGistActions());
      await act(async () => { await result.current.deleteGist(gist, vi.fn()); });
      expect(mocks.deleteGist).not.toHaveBeenCalled();

      storeState.githubToken = 'github-token';
      rerender();
      const foreignGist = { ...gist, owner: { login: 'someone-else', avatar_url: '' } };
      await act(async () => { await result.current.deleteGist(foreignGist, vi.fn()); });
      expect(mocks.confirm).not.toHaveBeenCalled();
      expect(mocks.deleteGist).not.toHaveBeenCalled();
    });

    it('aborts when confirm is declined', async () => {
      mocks.confirm.mockResolvedValue(false);
      const { result } = renderHook(() => useGistActions());
      await act(async () => { await result.current.deleteGist(gist, vi.fn()); });
      expect(mocks.confirm).toHaveBeenCalledWith(
        'Delete Gist',
        'Are you sure you want to delete this gist? This cannot be undone.',
        { type: 'danger', confirmText: 'Delete' },
      );
      expect(mocks.deleteGist).not.toHaveBeenCalled();
    });

    it('removes the store record, then calls onDeleted, then toasts success', async () => {
      mocks.confirm.mockResolvedValue(true);
      const onDeleted = vi.fn();
      const { result } = renderHook(() => useGistActions());
      await act(async () => { await result.current.deleteGist(gist, onDeleted); });

      expect(mocks.deleteGist).toHaveBeenCalledWith('gist-1');
      const storeDeleteOrder = storeState.deleteGist.mock.invocationCallOrder[0];
      const onDeletedOrder = onDeleted.mock.invocationCallOrder[0];
      expect(storeDeleteOrder).toBeLessThan(onDeletedOrder);
      expect(mocks.toast).toHaveBeenCalledWith('Gist deleted', 'success');
    });

    it('maps permission errors into the scoped hint toast', async () => {
      mocks.confirm.mockResolvedValue(true);
      mocks.deleteGist.mockRejectedValue(new Error('403 forbidden'));
      const { result } = renderHook(() => useGistActions());
      await act(async () => { await result.current.deleteGist(gist, vi.fn()); });

      expect(mocks.toast).toHaveBeenCalledWith(
        'Failed to delete gist: 403 forbidden (Please confirm the token has gist scope, then re-enter the token in Settings to log in again)',
        'error',
      );
    });
  });

  describe('fetchGistFileRaw', () => {
    it('throws the verbatim no-token message', async () => {
      storeState.githubToken = null;
      const { result } = renderHook(() => useGistActions());
      await expect(result.current.fetchGistFileRaw('https://raw.example/x')).rejects.toThrow(
        'GitHub token not configured, cannot load file content',
      );
      expect(mocks.getGistFileRaw).not.toHaveBeenCalled();
    });

    it('passes the raw url and signal through to the api service', async () => {
      mocks.getGistFileRaw.mockResolvedValue('file body');
      const { result } = renderHook(() => useGistActions());
      const controller = new AbortController();
      await act(async () => {
        await expect(result.current.fetchGistFileRaw('https://raw.example/x', controller.signal)).resolves.toBe('file body');
      });
      expect(mocks.getGistFileRaw).toHaveBeenCalledWith('https://raw.example/x', controller.signal);
    });
  });

  describe('isAnalyzingGist', () => {
    it('reflects the store analyzing set', () => {
      storeState.analyzingGistIds = new Set(['gist-1']);
      const { result } = renderHook(() => useGistActions());
      expect(result.current.isAnalyzingGist('gist-1')).toBe(true);
      expect(result.current.isAnalyzingGist('gist-2')).toBe(false);
    });
  });
});

describe('gist analysis patch helpers', () => {
  it('applyGistAnalysisSuccess trims the summary and resets failure state on the detail', () => {
    const patched = applyGistAnalysisSuccess(gistDetail, '  trimmed  ', '2026-09-05T00:00:00.000Z');
    expect(patched).toEqual({
      ...gistDetail,
      ai_summary: 'trimmed',
      analyzed_at: '2026-09-05T00:00:00.000Z',
      analysis_failed: false,
      analysis_error: undefined,
    });
  });

  it('applyGistAnalysisFailure marks failure on the original gist', () => {
    const patched = applyGistAnalysisFailure(gist, 'boom', '2026-09-05T00:00:00.000Z');
    expect(patched).toEqual({
      ...gist,
      analyzed_at: '2026-09-05T00:00:00.000Z',
      analysis_failed: true,
      analysis_error: 'boom',
    });
  });
});
