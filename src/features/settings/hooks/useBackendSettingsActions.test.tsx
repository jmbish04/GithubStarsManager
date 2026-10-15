import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../../store/useAppStore';
import { useBackendSettingsActions } from './useBackendSettingsActions';

const mocks = vi.hoisted(() => ({
  backendInit: vi.fn(),
  backendCheckHealth: vi.fn(),
  backendVerifyAuth: vi.fn(),
  backendRememberActiveUrl: vi.fn(),
  setBackendApiSecret: vi.fn(),
  toast: vi.fn(),
  confirm: vi.fn(),
  syncLocalGitHubTokenToBackend: vi.fn(),
  tryRestoreAuthFromBackend: vi.fn(),
  useAppStore: Object.assign(vi.fn(), { setState: vi.fn() }),
}));

vi.mock('../../../store/useAppStore', () => ({ useAppStore: mocks.useAppStore }));
vi.mock('../../../services/backendAdapter', () => ({
  backend: {
    configuredUrl: 'https://stored.example/api',
    backendUrl: 'https://stored.example/api',
    isAvailable: false,
    init: mocks.backendInit,
    checkHealth: mocks.backendCheckHealth,
    verifyAuth: mocks.backendVerifyAuth,
    rememberActiveUrl: mocks.backendRememberActiveUrl,
  },
}));
vi.mock('../../../services/autoSync', () => ({
  syncLocalGitHubTokenToBackend: mocks.syncLocalGitHubTokenToBackend,
  tryRestoreAuthFromBackend: mocks.tryRestoreAuthFromBackend,
}));
vi.mock('../../../hooks/useDialog', () => ({
  useDialog: () => ({ toast: mocks.toast, confirm: mocks.confirm }),
}));

const storeState = {
  language: 'en',
  repositories: [],
  releases: [],
  aiConfigs: [],
  webdavConfigs: [],
  activeAIConfig: null,
  activeWebDAVConfig: null,
  hiddenDefaultCategoryIds: [] as string[],
  categoryOrder: [] as string[],
  customCategories: [],
  assetFilters: [],
  defaultCategoryOverrides: {},
  collapsedSidebarCategoryCount: 0,
  backendApiSecret: null as string | null,
  setBackendApiSecret: mocks.setBackendApiSecret,
  setRepositories: vi.fn(),
  setReleases: vi.fn(),
  setAIConfigs: vi.fn(),
  setWebDAVConfigs: vi.fn(),
  showDefaultCategory: vi.fn(),
  hideDefaultCategory: vi.fn(),
};

const mockUseAppStore = vi.mocked(useAppStore);

describe('useBackendSettingsActions backend URL configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.backendApiSecret = null;
    mocks.backendInit.mockResolvedValue(undefined);
    mocks.backendCheckHealth.mockResolvedValue({ version: '1.0.0', timestamp: '2026-09-05T00:00:00Z' });
    mocks.backendVerifyAuth.mockResolvedValue(true);
    mockUseAppStore.mockImplementation(((selector?: (state: typeof storeState) => unknown) => (
      selector ? selector(storeState) : storeState
    )) as never);
  });

  const render = () => renderHook(() => useBackendSettingsActions());

  it('pre-fills urlInput with remembered backend address and automatically strips /api', () => {
    const { result } = render();
    expect(result.current.urlInput).toBe('https://stored.example');
  });

  it('shows an error for invalid URL without probing or saving the secret', async () => {
    const { result } = render();
    act(() => result.current.setUrlInput('http://127.example.com'));

    await act(async () => {
      await result.current.testConnection();
    });

    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('Invalid backend URL'), 'error');
    expect(mocks.backendInit.mock.calls.every((call) => call[0] === undefined)).toBe(true);
    expect(mocks.setBackendApiSecret).not.toHaveBeenCalled();
  });

  it('probes a valid address, remembers it on success, and shows a success toast', async () => {
    const { result } = render();
    act(() => {
      result.current.setUrlInput('https://new.example.com');
      result.current.setSecretInput('secret-1');
    });

    await act(async () => {
      await result.current.testConnection();
    });

    expect(mocks.backendInit).toHaveBeenCalledWith('https://new.example.com');
    expect(mocks.setBackendApiSecret).toHaveBeenCalledWith('secret-1');
    expect(mocks.backendVerifyAuth).toHaveBeenCalledOnce();
    expect(mocks.backendRememberActiveUrl).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledWith('Backend connection successful!', 'success');
  });

  it('restores previous backend connection and does not remember candidate address on auth failure', async () => {
    const { result } = render();
    act(() => {
      result.current.setUrlInput('https://new.example.com');
      result.current.setSecretInput('wrong-key');
    });
    mocks.backendVerifyAuth.mockResolvedValue(false);

    await act(async () => {
      await result.current.testConnection();
    });

    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('Backend connection failed'), 'error');
    expect(mocks.backendInit).toHaveBeenLastCalledWith('https://stored.example/api');
    expect(mocks.backendRememberActiveUrl).not.toHaveBeenCalled();
  });

  it('retains auto-detection when address is left blank (no preferredUrl)', async () => {
    const { result } = render();
    act(() => result.current.setUrlInput('  '));

    await act(async () => {
      await result.current.testConnection();
    });

    expect(mocks.backendInit.mock.calls.every((call) => call[0] === undefined)).toBe(true);
    expect(mocks.toast).toHaveBeenCalledWith('Backend connection successful!', 'success');
  });
});
