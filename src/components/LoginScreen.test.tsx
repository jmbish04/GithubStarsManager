import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from './ui/tooltip';

const mocks = vi.hoisted(() => ({
  safeReadText: vi.fn(),
  restoreBackendSession: vi.fn(),
  setupBackendGitHubToken: vi.fn(),
  syncBackendData: vi.fn(),
  configuredBackendUrl: null as string | null,
  store: {
    setUser: vi.fn(),
    setGitHubToken: vi.fn(),
    setBackendApiSecret: vi.fn(),
    backendApiSecret: null as string | null,
    accountWorkspaces: {} as Record<string, unknown>,
  },
}));

vi.mock('../utils/clipboardUtils', () => ({ safeReadText: mocks.safeReadText }));
vi.mock('../features/lifecycle/hooks/useLoginActions', () => ({
  useLoginActions: () => ({
    authenticateWithGitHub: vi.fn(),
    syncTokenToBackend: vi.fn().mockResolvedValue({ ok: true }),
    configuredBackendUrl: mocks.configuredBackendUrl,
    restoreBackendSession: mocks.restoreBackendSession,
    setupBackendGitHubToken: mocks.setupBackendGitHubToken,
    syncBackendData: mocks.syncBackendData,
  }),
}));
vi.mock('../store/useAppStore', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      setUser: mocks.store.setUser,
      setGitHubToken: mocks.store.setGitHubToken,
      setBackendApiSecret: mocks.store.setBackendApiSecret,
      backendApiSecret: mocks.store.backendApiSecret,
      repositories: [],
      gists: [],
      starredGists: [],
      releases: [],
      forks: [],
      customCategories: [],
      categoryOrder: [],
      hiddenDefaultCategoryIds: [],
      defaultCategoryOverrides: {},
      categoryListIdMap: {},
      lastSync: null,
      accountWorkspaces: mocks.store.accountWorkspaces,
      language: 'zh',
      setLanguage: vi.fn(),
      theme: 'light',
      setTheme: vi.fn(),
    }),
}));

import { LoginScreen } from './LoginScreen';

const enterBackendMode = async () => {
  render(
    <TooltipProvider>
      <LoginScreen />
    </TooltipProvider>
  );
  fireEvent.click(screen.getByRole('button', { name: /已有后端数据/ }));
  return {
    urlInput: await screen.findByLabelText('后端 URL'),
    apiKeyInput: screen.getByLabelText('API Key'),
  };
};

describe('LoginScreen token guidance', () => {
  it('explains Star permissions before sign-in', () => {
    render(<TooltipProvider><LoginScreen /></TooltipProvider>);
    expect(screen.getByText('GitHub Token 权限')).toBeVisible();
    expect(screen.getByText('Starring')).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: '经典 Token' }));
    expect(screen.getByText('public_repo')).toBeVisible();
  });
});

describe('LoginScreen backend login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.safeReadText.mockResolvedValue({ success: false, error: 'empty' });
    mocks.syncBackendData.mockReset().mockResolvedValue(undefined);
    mocks.store.backendApiSecret = null;
    mocks.store.accountWorkspaces = {};
  });

  it('writes only to currently focused input on Ctrl+V paste', async () => {
    mocks.safeReadText.mockResolvedValue({ success: true, text: 'https://backend.example.com' });
    const { urlInput, apiKeyInput } = await enterBackendMode();

    fireEvent.keyDown(urlInput, { key: 'v', ctrlKey: true });

    await waitFor(() => expect(urlInput).toHaveValue('https://backend.example.com'));
    expect(apiKeyInput).toHaveValue('');
    expect(mocks.safeReadText).toHaveBeenCalledOnce();
  });

  it('rejects remote HTTP backend address without initiating backend request', async () => {
    const { urlInput, apiKeyInput } = await enterBackendMode();

    fireEvent.change(urlInput, { target: { value: 'http://backend.example.com' } });
    fireEvent.change(apiKeyInput, { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: '连接并恢复数据' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('后端地址无效');
    expect(mocks.restoreBackendSession).not.toHaveBeenCalled();
  });

  it('guides to token configuration step when backend saved GitHub Token is invalid', async () => {
    mocks.restoreBackendSession.mockResolvedValue({ status: 'restored-token-invalid' });
    const { urlInput, apiKeyInput } = await enterBackendMode();

    fireEvent.change(urlInput, { target: { value: 'https://backend.example.com' } });
    fireEvent.change(apiKeyInput, { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: '连接并恢复数据' }));

    expect(await screen.findByText('后端保存的 GitHub Token 无法使用，请重新配置')).toBeInTheDocument();
    expect(screen.getByLabelText('GitHub Personal Access Token')).toHaveAttribute('id', 'backend-github-token');
  });

  it('pulls backend data before logging in upon successfully connecting to existing backend', async () => {
    mocks.restoreBackendSession.mockResolvedValue({
      status: 'connected',
      githubToken: 'ghp_restored',
      user: { id: 1, login: 'octocat' },
    });
    const { urlInput, apiKeyInput } = await enterBackendMode();

    fireEvent.change(urlInput, { target: { value: 'https://backend.example.com' } });
    fireEvent.change(apiKeyInput, { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: '连接并恢复数据' }));

    await waitFor(() => expect(mocks.store.setUser).toHaveBeenCalledWith({ id: 1, login: 'octocat' }));
    expect(mocks.syncBackendData).toHaveBeenCalledOnce();
    expect(mocks.store.setGitHubToken).toHaveBeenCalledWith('ghp_restored');
    expect(mocks.syncBackendData.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.store.setUser.mock.invocationCallOrder[0],
    );
  });

  it('does not commit login state when backend data sync fails', async () => {
    mocks.restoreBackendSession.mockResolvedValue({
      status: 'connected',
      githubToken: 'ghp_restored',
      user: { id: 1, login: 'octocat' },
    });
    mocks.syncBackendData.mockRejectedValueOnce(new Error('sync failed'));
    const { urlInput, apiKeyInput } = await enterBackendMode();

    fireEvent.change(urlInput, { target: { value: 'https://backend.example.com' } });
    fireEvent.change(apiKeyInput, { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: '连接并恢复数据' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('sync failed');
    expect(mocks.store.setUser).not.toHaveBeenCalled();
    expect(mocks.store.setGitHubToken).not.toHaveBeenCalled();
    expect(mocks.store.setBackendApiSecret).toHaveBeenLastCalledWith(null);
  });

  it('does not commit login state when token configuration flow sync fails', async () => {
    mocks.restoreBackendSession.mockResolvedValue({ status: 'github-token-required' });
    mocks.setupBackendGitHubToken.mockResolvedValue({ id: 1, login: 'octocat' });
    mocks.syncBackendData.mockRejectedValueOnce(new Error('sync failed'));
    const { urlInput, apiKeyInput } = await enterBackendMode();

    fireEvent.change(urlInput, { target: { value: 'https://backend.example.com' } });
    fireEvent.change(apiKeyInput, { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: '连接并恢复数据' }));

    const tokenInput = await screen.findByLabelText('GitHub Personal Access Token');
    fireEvent.change(tokenInput, { target: { value: 'ghp_new' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并继续' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('sync failed');
    expect(mocks.store.setUser).not.toHaveBeenCalled();
    expect(mocks.store.setGitHubToken).not.toHaveBeenCalled();
  });

  it('displays conflict confirmation dialog and confirms overwrite when local archived custom categories exist', async () => {
    mocks.store.accountWorkspaces = {
      '1': {
        repositories: [],
        customCategories: [{ id: 'cat-1', name: 'Cat', icon: '', isCustom: true, keywords: [] }],
      },
    };
    mocks.restoreBackendSession.mockResolvedValue({
      status: 'connected',
      githubToken: 'ghp_restored',
      user: { id: 1, login: 'octocat' },
    });
    const { urlInput, apiKeyInput } = await enterBackendMode();

    fireEvent.change(urlInput, { target: { value: 'https://backend.example.com' } });
    fireEvent.change(apiKeyInput, { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: '连接并恢复数据' }));

    expect(await screen.findByText('本地数据冲突')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '使用后端数据' }));

    await waitFor(() => expect(mocks.store.setUser).toHaveBeenCalledWith({ id: 1, login: 'octocat' }));
    expect(mocks.syncBackendData).toHaveBeenCalledOnce();
    expect(mocks.store.setGitHubToken).toHaveBeenCalledWith('ghp_restored');
  });
});

describe('LoginScreen backend URL prefill', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mocks.configuredBackendUrl = null;
  });

  it('does not prefill invalid address on desktop file:// origin', async () => {
    vi.stubGlobal('location', { protocol: 'file:', origin: 'file://' } as unknown as Location);

    const { urlInput } = await enterBackendMode();

    expect(urlInput).toHaveValue('');
  });

  it('prefills same-origin address on Web deployment', async () => {
    vi.stubGlobal('location', { protocol: 'https:', origin: 'https://app.example.com' } as unknown as Location);

    const { urlInput } = await enterBackendMode();

    expect(urlInput).toHaveValue('https://app.example.com');
  });

  it('prioritizes remembered backend address over same-origin address', async () => {
    mocks.configuredBackendUrl = 'https://stored.example/api';

    const { urlInput } = await enterBackendMode();

    expect(urlInput).toHaveValue('https://stored.example');
  });
});
