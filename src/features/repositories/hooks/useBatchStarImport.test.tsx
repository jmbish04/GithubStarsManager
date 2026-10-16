import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBatchStarImport } from './useBatchStarImport';
import { GitHubTokenPermissionError } from '../../../services/githubApi';

const mocks = vi.hoisted(() => ({
  token: 'token',
  language: 'zh',
  addRepository: vi.fn(),
  getRepositoryDetails: vi.fn(),
  isRepositoryStarred: vi.fn(),
  starRepository: vi.fn(),
  forceSyncToBackend: vi.fn(),
  translateBatch: vi.fn(),
}));
vi.mock('../../../store/useAppStore', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({
    githubToken: mocks.token, language: mocks.language, addRepository: mocks.addRepository,
  }),
}));
vi.mock('../../../services/githubApiFactory', () => ({ createGitHubApiService: () => mocks }));
vi.mock('../../../services/autoSync', () => ({ forceSyncToBackend: mocks.forceSyncToBackend }));
vi.mock('../../../services/translateService', () => ({ translateBatch: mocks.translateBatch }));

const detail = (owner: string, name: string) => ({
  id: 1, name, full_name: `${owner}/${name}`, description: 'A repository',
  html_url: `https://github.com/${owner}/${name}`, stargazers_count: 10,
  forks_count: 0, forks: 0, language: 'TypeScript', topics: [], license: 'MIT',
  owner: { login: owner, avatar_url: '' },
  created_at: '', updated_at: '', pushed_at: '',
});

describe('useBatchStarImport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.token = 'token';
    mocks.language = 'zh';
    mocks.getRepositoryDetails.mockImplementation(async (owner, name) => detail(owner, name));
    mocks.isRepositoryStarred.mockResolvedValue(false);
    mocks.starRepository.mockResolvedValue(undefined);
    mocks.forceSyncToBackend.mockResolvedValue(undefined);
    mocks.translateBatch.mockResolvedValue([]);
  });

  it('extracts seven unique repositories from a video summary without starring on preview', async () => {
    const names = ['hypit-ai/hypit', 'oraen/oraenView', 'Vincentwei1021/anything2explainer',
      'lanxiuyun/Catrace', 'CialloKing/ba-click-fx', 'CialloKing/ba-click-fx-desktop', 'jslxxgyy/EarthQuakeWarning'];
    // Scraped Bilibili video description snippet
    const text = `\u672c\u671f\u89c6\u9891\u4e2d\u63d0\u5230\u7684\u4e00\u4e9b\u5185\u5bb9\uff1a [anything2explainer](https://search.bilibili.com/all?keyword=anything2explainer)\n${
      names.map(name => `\u9879\u76ee\u8bf4\u660e [https://github.com/${name}](https://github.com/${name})`).join('\n')}`;
    const { result } = renderHook(() => useBatchStarImport());
    await act(() => result.current.preview(text));
    expect(result.current.rows.map(row => row.detail?.full_name)).toEqual(names);
    expect(result.current.duplicateCount).toBe(7);
    expect(result.current.rows.every(row => row.selected)).toBe(true);
    expect(mocks.starRepository).not.toHaveBeenCalled();
  });

  it('keeps already-starred and inaccessible repositories out of the selection', async () => {
    mocks.isRepositoryStarred.mockResolvedValue(true);
    mocks.getRepositoryDetails.mockRejectedValueOnce(new Error('GitHub API error: 404 Not Found'));
    const { result } = renderHook(() => useBatchStarImport());
    await act(() => result.current.preview('https://github.com/owner/missing https://github.com/owner/existing'));
    expect(result.current.rows.map(row => row.status)).toEqual(['unavailable', 'already-starred']);
    await act(() => result.current.starSelected());
    expect(mocks.starRepository).not.toHaveBeenCalled();
  });

  it('explains a token permission failure during preview', async () => {
    mocks.isRepositoryStarred.mockRejectedValueOnce(new GitHubTokenPermissionError());
    const { result } = renderHook(() => useBatchStarImport());
    await act(() => result.current.preview('https://github.com/owner/repo'));
    expect(result.current.rows[0].status).toBe('unavailable');
    expect(result.current.rows[0].error).toMatch(/Starring|starring/i);
  });

  it('explains a token permission failure during starring', async () => {
    mocks.starRepository.mockRejectedValueOnce(new GitHubTokenPermissionError());
    const { result } = renderHook(() => useBatchStarImport());
    await act(() => result.current.preview('https://github.com/owner/repo'));
    await act(() => result.current.starSelected());
    expect(result.current.rows[0].status).toBe('failed');
    expect(result.current.rows[0].error).toMatch(/Starring|starring/i);
  });

  it('requires selection for bare names and renamed repositories, and deduplicates canonical names', async () => {
    mocks.getRepositoryDetails.mockImplementation(async (_owner, name) => detail('new-owner', name));
    const { result } = renderHook(() => useBatchStarImport());
    await act(() => result.current.preview('old-owner/repo https://github.com/new-owner/repo'));
    expect(result.current.rows).toHaveLength(1);
    expect(result.current.rows[0].selected).toBe(false);
    expect(result.current.duplicateCount).toBe(1);
    act(() => result.current.toggleRow(0));
    await act(() => result.current.starSelected());
    expect(mocks.starRepository).toHaveBeenCalledWith('new-owner', 'repo');
  });

  it('records partial success and syncs only successfully starred repositories', async () => {
    mocks.starRepository.mockRejectedValueOnce(new Error('Forbidden'));
    const { result } = renderHook(() => useBatchStarImport());
    await act(() => result.current.preview('https://github.com/owner/first https://github.com/owner/second'));
    await act(() => result.current.starSelected());
    expect(result.current.rows.map(row => row.status)).toEqual(['failed', 'starred']);
    expect(mocks.addRepository).toHaveBeenCalledTimes(1);
    expect(mocks.addRepository.mock.calls[0][0].full_name).toBe('owner/second');
    expect(mocks.forceSyncToBackend).toHaveBeenCalledWith({ reportFailures: true });
    expect(mocks.forceSyncToBackend).toHaveBeenCalledTimes(1);
  });

  it('does not report a successful GitHub star as failed when backend sync fails', async () => {
    mocks.forceSyncToBackend.mockRejectedValueOnce(new Error('Offline'));
    const { result } = renderHook(() => useBatchStarImport());
    await act(() => result.current.preview('https://github.com/owner/repo'));
    await act(() => result.current.starSelected());
    expect(result.current.rows[0].status).toBe('starred');
    expect(result.current.syncError).toBe('Offline');
  });

  it('rejects empty extraction and oversized batches before network requests', async () => {
    const { result } = renderHook(() => useBatchStarImport());
    await act(() => result.current.preview('https://search.bilibili.com/all'));
    expect(result.current.inputError).toBe('no-repositories');
    await act(() => result.current.preview(Array.from({ length: 51 }, (_, i) => `https://github.com/owner/repo${i}`).join('\n')));
    expect(result.current.inputError).toBe('too-many-repositories');
    expect(mocks.getRepositoryDetails).not.toHaveBeenCalled();
  });

  it('selects and inverts only repositories that can still be starred', async () => {
    mocks.isRepositoryStarred.mockResolvedValueOnce(true);
    const { result } = renderHook(() => useBatchStarImport());
    await act(() => result.current.preview('https://github.com/owner/first https://github.com/owner/second'));
    expect(result.current.rows.map(row => row.status)).toEqual(['already-starred', 'ready']);

    act(() => result.current.selectAll());
    expect(result.current.rows.map(row => row.selected)).toEqual([false, true]);
    act(() => result.current.invertSelection());
    expect(result.current.rows.map(row => row.selected)).toEqual([false, false]);
    act(() => result.current.invertSelection());
    expect(result.current.rows.map(row => row.selected)).toEqual([false, true]);
  });

  it('translates descriptions into the interface language and reverts by toggling', async () => {
    // Chinese for "A repository"
    mocks.translateBatch.mockResolvedValue([{ translatedText: '\u4e00\u4e2a\u4ed3\u5e93', detectedLanguage: '' }]);
    const { result } = renderHook(() => useBatchStarImport());
    await act(() => result.current.preview('https://github.com/owner/repo'));

    await act(() => result.current.toggleTranslations());
    expect(mocks.translateBatch).toHaveBeenCalledWith(['A repository'], 'zh', undefined, undefined, 'plain');
    expect(result.current.translations).toEqual({ 'owner/repo': '\u4e00\u4e2a\u4ed3\u5e93' });
    expect(result.current.translationsVisible).toBe(true);
    expect(result.current.translationError).toBe('');

    await act(() => result.current.toggleTranslations());
    expect(result.current.translationsVisible).toBe(false);

    await act(() => result.current.toggleTranslations());
    expect(result.current.translationsVisible).toBe(true);
    expect(mocks.translateBatch).toHaveBeenCalledTimes(1);
  });

  it('keeps same-language descriptions original without a translation request', async () => {
    // Chinese for "Chinese description" (language detection test)
    mocks.getRepositoryDetails.mockImplementation(async (owner, name) => ({ ...detail(owner, name), description: '\u4e2d\u6587\u63cf\u8ff0' }));
    const { result } = renderHook(() => useBatchStarImport());
    await act(() => result.current.preview('https://github.com/owner/repo'));

    await act(() => result.current.toggleTranslations());
    expect(mocks.translateBatch).not.toHaveBeenCalled();
    expect(result.current.translations).toEqual({});
    expect(result.current.translationsVisible).toBe(true);
  });

  it('reports translation failures and stays on the original descriptions', async () => {
    mocks.translateBatch.mockRejectedValue(new Error('Translation failed: 429'));
    const { result } = renderHook(() => useBatchStarImport());
    await act(() => result.current.preview('https://github.com/owner/repo'));

    await act(() => result.current.toggleTranslations());
    expect(result.current.translationsVisible).toBe(false);
    expect(result.current.translations).toEqual({});
    expect(result.current.translationError).toBe('Translation failed: 429');
  });

  it('resets translation state when the preview is re-run or cleared', async () => {
    // Chinese for "A repository"
    mocks.translateBatch.mockResolvedValue([{ translatedText: '\u4e00\u4e2a\u4ed3\u5e93', detectedLanguage: '' }]);
    const { result } = renderHook(() => useBatchStarImport());
    await act(() => result.current.preview('https://github.com/owner/repo'));
    await act(() => result.current.toggleTranslations());
    expect(result.current.translationsVisible).toBe(true);

    await act(() => result.current.preview('https://github.com/owner/other'));
    expect(result.current.translations).toEqual({});
    expect(result.current.translationsVisible).toBe(false);

    await act(() => result.current.toggleTranslations());
    act(() => result.current.clearPreview());
    expect(result.current.translations).toEqual({});
    expect(result.current.translationsVisible).toBe(false);
  });
});
