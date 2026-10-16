import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadmeModal } from './ReadmeModal';
import { backend } from '../services/backendAdapter';
import { GitHubApiService } from '../services/githubApi';
import { useAppStore } from '../store/useAppStore';
import type { Repository, RouteMode } from '../types';

vi.mock('./BilingualMarkdownRenderer', async () => {
  const React = await import('react');
  return {
    default: React.forwardRef(({ markdown }: { markdown: string }, ref) => {
      void ref;
      return <div>{markdown}</div>;
    }),
  };
});

vi.mock('../services/backendAdapter', () => ({
  backend: {
    isAvailable: true,
    getRepositoryReadme: vi.fn(),
    getRepositoryReadmeByPath: vi.fn(),
    listRepositoryReadmeCandidates: vi.fn(),
  },
}));

vi.mock('../services/githubApi', () => ({
  GitHubApiService: vi.fn(),
}));

let mockStoreState: { language: 'zh' | 'en'; githubToken: string | null; routeMode: RouteMode; setReadmeModalOpen: () => void } = {
  language: 'en',
  githubToken: null,
  routeMode: 'auto',
  setReadmeModalOpen: vi.fn(),
};

vi.mock('../store/useAppStore', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: () => mockStoreState }),
}));

const mockGitHubApi = {
  getRepositoryReadme: vi.fn(),
  getRepositoryReadmeByPath: vi.fn(),
  listRepositoryReadmeCandidates: vi.fn(),
};

const setMockStore = (githubToken: string | null = null) => {
  mockStoreState = {
    language: 'en',
    githubToken,
    routeMode: 'auto' as RouteMode,
    setReadmeModalOpen: vi.fn(),
  };
  (useAppStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector?: (state: unknown) => unknown) => selector ? selector(mockStoreState) : mockStoreState);
};

const mockedGitHubApiService = GitHubApiService as unknown as ReturnType<typeof vi.fn>;

const mockRepository: Repository = {
  id: 1,
  name: 'demo',
  full_name: 'owner/demo',
  description: 'Demo repository',
  html_url: 'https://github.com/owner/demo',
  stargazers_count: 10,
  forks_count: 2,
  forks: 2,
  language: 'TypeScript',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  pushed_at: '2026-01-03T00:00:00Z',
  owner: {
    login: 'owner',
    avatar_url: 'https://example.com/avatar.png',
  },
  topics: [],
};

describe('ReadmeModal multilingual README switching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (backend as { isAvailable: boolean }).isAvailable = true;
    setMockStore();
    mockGitHubApi.getRepositoryReadme.mockResolvedValue('Direct README content');
    mockGitHubApi.getRepositoryReadmeByPath.mockResolvedValue('Direct localized README content');
    mockGitHubApi.listRepositoryReadmeCandidates.mockResolvedValue([
      { path: 'README.md', type: 'blob' },
      { path: 'README_zh.md', type: 'blob' },
    ]);
    mockedGitHubApiService.mockImplementation(function () { return mockGitHubApi; });
    (backend.getRepositoryReadme as ReturnType<typeof vi.fn>).mockResolvedValue('Default README content');
    (backend.getRepositoryReadmeByPath as ReturnType<typeof vi.fn>).mockResolvedValue('Chinese README content');
    (backend.listRepositoryReadmeCandidates as ReturnType<typeof vi.fn>).mockResolvedValue([
      { path: 'README.md', type: 'blob' },
      { path: 'README_zh.md', type: 'blob' },
      { path: 'docs/README.ja.md', type: 'blob' },
    ]);
  });

  it('loads the default README first and then shows all detected README variants', async () => {
    render(<ReadmeModal isOpen onClose={vi.fn()} repository={mockRepository} />);

    expect(await screen.findByText('Default README content')).toBeInTheDocument();
    expect(backend.getRepositoryReadme).toHaveBeenCalledWith('owner', 'demo', expect.any(AbortSignal));

    const user = userEvent.setup();
    const selector = await screen.findByRole('combobox', { name: 'Switch README language' });
    expect(selector).toBeInTheDocument();
    await user.click(selector);
    expect(await screen.findByRole('option', { name: 'Default README' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Chinese · README_zh.md' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Japanese · docs/README.ja.md' })).toBeInTheDocument();
  });

  it('loads the selected README variant by path', async () => {
    render(<ReadmeModal isOpen onClose={vi.fn()} repository={mockRepository} />);

    await screen.findByText('Default README content');
    const user = userEvent.setup();
    const selector = await screen.findByRole('combobox', { name: 'Switch README language' });

    await user.click(selector);
    await user.click(await screen.findByRole('option', { name: 'Chinese · README_zh.md' }));

    await waitFor(() => {
      expect(backend.getRepositoryReadmeByPath).toHaveBeenCalledWith('owner', 'demo', 'README_zh.md', expect.any(AbortSignal));
    });
    expect(await screen.findByText('Chinese README content')).toBeInTheDocument();
  });

  it('does not show the selector when no localized README exists', async () => {
    (backend.listRepositoryReadmeCandidates as ReturnType<typeof vi.fn>).mockResolvedValue([
      { path: 'README.md', type: 'blob' },
    ]);

    render(<ReadmeModal isOpen onClose={vi.fn()} repository={mockRepository} />);

    expect(await screen.findByText('Default README content')).toBeInTheDocument();
    await waitFor(() => {
      expect(backend.listRepositoryReadmeCandidates).toHaveBeenCalled();
    });
    expect(screen.queryByLabelText('Switch README language')).not.toBeInTheDocument();
  });

  it('shows backend README errors instead of treating them as missing README', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      (backend.getRepositoryReadme as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('GitHub token not configured'));

      render(<ReadmeModal isOpen onClose={vi.fn()} repository={mockRepository} />);

      expect(await screen.findByText('GitHub token not configured')).toBeInTheDocument();
      expect(mockGitHubApi.getRepositoryReadme).not.toHaveBeenCalled();
      expect(screen.queryByText('This repository has no README file')).not.toBeInTheDocument();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('falls back to the direct GitHub API when backend README proxy fails and a token exists', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      setMockStore('github-token');
      (backend.getRepositoryReadme as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('GitHub token not configured'));
      mockGitHubApi.getRepositoryReadme.mockResolvedValue('Direct README content');

      render(<ReadmeModal isOpen onClose={vi.fn()} repository={mockRepository} />);

      expect(await screen.findByText('Direct README content')).toBeInTheDocument();
      expect(mockedGitHubApiService).toHaveBeenCalledWith('github-token');
      expect(mockGitHubApi.getRepositoryReadme).toHaveBeenCalledWith('owner', 'demo', expect.any(AbortSignal));
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('does not use direct fallback when the backend reports README is missing', async () => {
    setMockStore('github-token');
    (backend.getRepositoryReadme as ReturnType<typeof vi.fn>).mockResolvedValue('');

    render(<ReadmeModal isOpen onClose={vi.fn()} repository={mockRepository} />);

    expect(await screen.findByText('This repository has no README file')).toBeInTheDocument();
    expect(mockGitHubApi.getRepositoryReadme).not.toHaveBeenCalled();
  });

  it('falls back to the direct GitHub API when a selected README path fails through backend', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      setMockStore('github-token');
      (backend.getRepositoryReadmeByPath as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('GitHub token not configured'));
      mockGitHubApi.getRepositoryReadmeByPath.mockResolvedValue('Direct Chinese README content');

      render(<ReadmeModal isOpen onClose={vi.fn()} repository={mockRepository} />);

      await screen.findByText('Default README content');
      const user = userEvent.setup();
      const selector = await screen.findByRole('combobox', { name: 'Switch README language' });
      await user.click(selector);
      await user.click(await screen.findByRole('option', { name: 'Chinese · README_zh.md' }));

      expect(await screen.findByText('Direct Chinese README content')).toBeInTheDocument();
      expect(mockGitHubApi.getRepositoryReadmeByPath).toHaveBeenCalledWith('owner', 'demo', 'README_zh.md', expect.any(AbortSignal));
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('falls back to direct README variant detection when backend candidate listing fails', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      setMockStore('github-token');
      (backend.listRepositoryReadmeCandidates as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('GitHub token not configured'));
      mockGitHubApi.listRepositoryReadmeCandidates.mockResolvedValue([
        { path: 'README.md', type: 'blob' },
        { path: 'README_zh.md', type: 'blob' },
      ]);

      render(<ReadmeModal isOpen onClose={vi.fn()} repository={mockRepository} />);

      expect(await screen.findByText('Default README content')).toBeInTheDocument();
      const user = userEvent.setup();
      const selector = await screen.findByRole('combobox', { name: 'Switch README language' });
      expect(selector).toBeInTheDocument();
      await user.click(selector);
      expect(await screen.findByRole('option', { name: 'Chinese · README_zh.md' })).toBeInTheDocument();
      expect(mockGitHubApi.listRepositoryReadmeCandidates).toHaveBeenCalledWith('owner', 'demo', undefined, expect.any(AbortSignal));
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });
});
