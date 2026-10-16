import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TooltipProvider } from './ui/tooltip';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RepositoryCard } from './RepositoryCard';
import { PluginPageHost } from './PluginPageHost';
import { useAppStore } from '../store/useAppStore';
import { useRepositoryDragStore } from '../store/useRepositoryDragStore';
import { pluginPageSession } from '../plugins/pluginPageSession';
import { pluginRegistry } from '../plugins/pluginRegistry';
import { DialogProvider } from '../hooks/useDialog';
import type { Repository } from '../types';
import { DEFAULT_REPOSITORY_CARD_ACTIONS } from '../types/repositoryCardActions';

const actionMocks = vi.hoisted(() => ({
  releaseSheet: {
    suspend: null as Promise<void> | null,
  },
  actions: {
    analyze: vi.fn(),
    findSimilar: vi.fn(),
    unstar: vi.fn(),
    toggleReleaseSubscription: vi.fn(),
    isSubscribed: true,
    isAnalyzing: false,
    isFindingSimilar: false,
    isUnstarring: false,
    vectorSearchAvailable: true,
  },
}));

vi.mock('../store/useAppStore', () => ({
  useAppStore: vi.fn(),
}));

vi.mock('../features/repositories/hooks/useRepositoryCardActions', () => ({
  useRepositoryCardActions: () => actionMocks.actions,
}));

vi.mock('./FloatingTooltip', () => ({
  FloatingTooltip: () => null,
}));

vi.mock('./RepositoryEditModal', () => ({
  RepositoryEditModal: ({
    isOpen,
    onOutsideDismiss,
  }: {
    isOpen: boolean;
    onOutsideDismiss?: () => void;
  }) => (
    isOpen ? <div data-testid="repository-edit-modal" onPointerDown={onOutsideDismiss} /> : null
  ),
}));

vi.mock('./ReadmeModal', () => ({
  ReadmeModal: ({ isOpen }: { isOpen: boolean }) => (
    isOpen ? <div data-testid="readme-modal" /> : null
  ),
}));

vi.mock('./RepositoryReleaseSheet', () => ({
  RepositoryReleaseSheet: ({ isOpen }: { isOpen: boolean }) => {
    if (actionMocks.releaseSheet.suspend) throw actionMocks.releaseSheet.suspend;
    return isOpen ? <div data-testid="repository-release-sheet" /> : null;
  },
}));

vi.mock('./PluginPageModal', () => ({
  PluginPageModal: ({ pageTitle }: { pageTitle: string }) => (
    <div role="dialog" aria-label={pageTitle} />
  ),
}));

const pluginClientMocks = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock('../plugins/pluginClient', () => ({
  pluginClient: {
    isSupported: () => true,
    list: pluginClientMocks.list,
  },
}));

const repository: Repository = {
  id: 1,
  name: 'example-repository',
  full_name: 'owner/example-repository',
  description: 'Repository description',
  html_url: 'https://github.com/owner/example-repository',
  stargazers_count: 128,
  forks_count: 3,
  forks: 3,
  language: 'TypeScript',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  pushed_at: '2026-01-03T00:00:00.000Z',
  owner: {
    login: 'owner',
    avatar_url: 'https://example.com/avatar.png',
  },
  topics: ['test'],
  ai_platforms: ['web', 'cli'],
};

const storeState = {
  releaseSubscriptions: new Set<number>([1]),
  analyzingRepositoryIds: new Set<number>(),
  toggleReleaseSubscription: vi.fn(),
  githubToken: null,
  activeAIConfig: null,
  setAnalyzingRepository: vi.fn(),
  language: 'zh' as const,
  // Card visible fields (Dev Guide §14): all enabled by default, modify as needed per test case
  repositoryCardFields: { description: true, tags: true, language: true, stars: true, license: true, lastUpdated: true },
  repositoryCardActions: DEFAULT_REPOSITORY_CARD_ACTIONS.map((item) => ({ ...item })),
  updateRepository: vi.fn(),
  deleteRepository: vi.fn(),
  vectorSearchConfig: {
    enabled: true,
    workerUrl: 'https://worker.example.com',
    authToken: 'token',
    embeddingConfigId: 'embedding',
    indexMode: 'readme' as const,
    readmeMaxChars: 6000,
  },
  vectorSearchStatus: { connected: true, vectorCount: 1, dimensions: 1536 },
  embeddingConfigs: [{
    id: 'embedding',
    name: 'Test embedding',
    apiType: 'openai-compatible' as const,
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    model: 'test-model',
    dimensions: 1536,
    isActive: true,
  }],
  activeEmbeddingConfig: 'embedding',
  repositories: [repository],
  enterSimilarView: vi.fn(),
  aiConfigs: [],
};

const mockUseAppStore = vi.mocked(useAppStore);

const renderRepositoryCard = (
  viewMode: 'list' | 'grid',
  options: { onAskRepository?: (repository: Repository) => void; selectionMode?: boolean } = {},
) => render(
  <DialogProvider>
    <TooltipProvider>
      <RepositoryCard repository={repository} allCategories={[]} viewMode={viewMode} {...options} />
    </TooltipProvider>
  </DialogProvider>
);

beforeEach(() => {
  vi.clearAllMocks();
  pluginClientMocks.list.mockResolvedValue({ plugins: [], invalidPlugins: [] });
  pluginRegistry.resetForTests();
  pluginPageSession.close();
  actionMocks.releaseSheet.suspend = null;
  useRepositoryDragStore.getState().endDrag();
  storeState.releaseSubscriptions = new Set<number>([1]);
  storeState.repositoryCardFields = {
    description: true,
    tags: true,
    language: true,
    stars: true,
    license: true,
    lastUpdated: true,
  };
  storeState.repositoryCardActions = DEFAULT_REPOSITORY_CARD_ACTIONS.map((item) => ({ ...item }));
  storeState.vectorSearchConfig.enabled = true;
  Object.assign(actionMocks.actions, {
    isSubscribed: true,
    isAnalyzing: false,
    isFindingSimilar: false,
    isUnstarring: false,
    vectorSearchAvailable: true,
  });
  mockUseAppStore.mockImplementation(((selector?: (state: typeof storeState) => unknown) => (
    selector ? selector(storeState) : storeState
  )) as typeof useAppStore);
});

describe('RepositoryCard view modes', () => {
  it('follows the saved quick-action order and keeps hidden actions in the menu', async () => {
    const user = userEvent.setup();
    storeState.repositoryCardActions = [
      { id: 'github', visible: true },
      { id: 'ask', visible: false },
      ...DEFAULT_REPOSITORY_CARD_ACTIONS.filter((item) => item.id !== 'github' && item.id !== 'ask'),
    ];
    renderRepositoryCard('grid', { onAskRepository: vi.fn() });

    const actionRow = screen.getByTestId('grid-action-row');
    expect(actionRow.firstElementChild).toHaveAttribute('title', '\u5728GitHub\u4e0a\u67e5\u770b'); // Chinese for "View on GitHub"
    expect(screen.queryByRole('button', { name: '\u95ee\u7b54\u6b64\u4ed3\u5e93' })).not.toBeInTheDocument(); // Chinese for "Chat with this repository"
    await user.click(screen.getByRole('button', { name: '\u66f4\u591a\u4ed3\u5e93\u64cd\u4f5c' })); // Chinese for "More repository actions"
    expect(screen.getByRole('menuitem', { name: '\u95ee\u7b54\u6b64\u4ed3\u5e93' })).toBeInTheDocument(); // Chinese for "Chat with this repository"
  });

  it('folds quick actions in preference order when the card is narrow', async () => {
    const user = userEvent.setup();
    storeState.repositoryCardActions = [
      { id: 'edit', visible: true },
      { id: 'github', visible: true },
      { id: 'analyze', visible: true },
      { id: 'ask', visible: true },
      { id: 'releases', visible: true },
      { id: 'subscribe', visible: true },
      { id: 'docs', visible: true },
    ];
    renderRepositoryCard('grid', { onAskRepository: vi.fn() });
    const actionRow = screen.getByTestId('grid-action-row');
    Object.defineProperty(actionRow, 'clientWidth', { configurable: true, value: 190 });

    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });

    expect(Array.from(actionRow.children).slice(0, 4).map((element) => element.getAttribute('title'))).toEqual([
      '\u7f16\u8f91\u4ed3\u5e93\u4fe1\u606f', '\u5728GitHub\u4e0a\u67e5\u770b', 'AI\u5206\u6790\u6b64\u4ed3\u5e93', '\u95ee\u7b54\u6b64\u4ed3\u5e93', // Chinese action titles
    ]);
    await user.click(screen.getByRole('button', { name: '\u66f4\u591a\u4ed3\u5e93\u64cd\u4f5c' })); // Chinese for "More repository actions"
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent?.trim())).toEqual([
      '\u67e5\u770b Release', '\u53d6\u6d88\u8ba2\u9605 Release', '\u5728 Zread \u4e2d\u67e5\u770b', '\u53d6\u6d88 Star', // Chinese menuitem texts
    ]);
  });

  it('keeps list actions on the same row as edit and only folds overflow into a more-actions menu', async () => {
    const user = userEvent.setup();
    renderRepositoryCard('list', { onAskRepository: vi.fn() });

    const lastPushed = screen.getByText(/\u6700\u8fd1\u63d0\u4ea4/); // Chinese for "Latest commit"
    expect(lastPushed).toBeInTheDocument();
    expect(lastPushed).not.toHaveClass('group-hover:opacity-0');
    expect(screen.getByTestId('list-action-row')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '\u7f16\u8f91\u4ed3\u5e93\u4fe1\u606f' })).toBeInTheDocument(); // Chinese for "Edit repository info"
    expect(screen.getByTitle('AI\u5206\u6790\u6b64\u4ed3\u5e93')).toBeInTheDocument(); // Chinese for "AI analyze this repository"
    expect(screen.getByTitle('\u53d6\u6d88\u8ba2\u9605\u53d1\u5e03')).toBeInTheDocument(); // Chinese for "Unsubscribe release"
    expect(screen.getByText('test')).toBeInTheDocument();
    expect(screen.getByText('TypeScript')).toBeInTheDocument();

    const moreActions = screen.getByRole('button', { name: '\u66f4\u591a\u4ed3\u5e93\u64cd\u4f5c' }); // Chinese for "More repository actions"
    await user.click(moreActions);
    expect(screen.getByRole('menuitem', { name: '\u67e5\u627e\u540c\u7c7b\u4ed3\u5e93' })).toBeInTheDocument(); // Chinese for "Find similar repositories"
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: '\u67e5\u627e\u540c\u7c7b\u4ed3\u5e93' })).not.toBeInTheDocument()); // Chinese for "Find similar repositories"
  });

  it('only exposes similar-repository search in the menu when vector search is available', async () => {
    const originalVectorSearchAvailable = actionMocks.actions.vectorSearchAvailable;
    try {
      actionMocks.actions.vectorSearchAvailable = false;
      renderRepositoryCard('list');

      expect(screen.getByRole('button', { name: '\u66f4\u591a\u4ed3\u5e93\u64cd\u4f5c' })).toBeInTheDocument(); // Chinese for "More repository actions"
      expect(screen.queryByRole('menuitem', { name: '\u67e5\u627e\u540c\u7c7b\u4ed3\u5e93' })).not.toBeInTheDocument(); // Chinese for "Find similar repositories"
      expect(screen.queryByText('\u67e5\u627e\u540c\u7c7b')).not.toBeInTheDocument(); // Chinese for "Find similar"
    } finally {
      actionMocks.actions.vectorSearchAvailable = originalVectorSearchAvailable;
    }
  });

  it('delegates the list similar-search menu action to the domain Hook', async () => {
    const user = userEvent.setup();
    renderRepositoryCard('list');

    await user.click(screen.getByRole('button', { name: '\u66f4\u591a\u4ed3\u5e93\u64cd\u4f5c' })); // Chinese for "More repository actions"
    await user.click(screen.getByRole('menuitem', { name: '\u67e5\u627e\u540c\u7c7b\u4ed3\u5e93' })); // Chinese for "Find similar repositories"

    expect(actionMocks.actions.findSimilar).toHaveBeenCalledOnce();
  });

  it('closes the list action menu from card whitespace, page whitespace, or Escape', async () => {
    const user = userEvent.setup();
    const { container } = renderRepositoryCard('list');
    const moreActions = screen.getByRole('button', { name: '\u66f4\u591a\u4ed3\u5e93\u64cd\u4f5c' }); // Chinese for "More repository actions"
    const card = container.firstElementChild as HTMLElement;

    await user.click(moreActions);
    expect(screen.getByRole('menuitem', { name: '\u67e5\u627e\u540c\u7c7b\u4ed3\u5e93' })).toBeInTheDocument(); // Chinese for "Find similar repositories"
    await act(async () => {
      fireEvent.pointerDown(card);
      fireEvent.click(card);
    });
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: '\u67e5\u627e\u540c\u7c7b\u4ed3\u5e93' })).not.toBeInTheDocument()); // Chinese for "Find similar repositories"
    expect(screen.queryByTestId('readme-modal')).not.toBeInTheDocument();

    await user.click(moreActions);
    await act(async () => {
      fireEvent.pointerDown(document.body);
    });
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: '\u67e5\u627e\u540c\u7c7b\u4ed3\u5e93' })).not.toBeInTheDocument()); // Chinese for "Find similar repositories"

    await user.click(moreActions);
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: '\u67e5\u627e\u540c\u7c7b\u4ed3\u5e93' })).not.toBeInTheDocument()); // Chinese for "Find similar repositories"
  });


  it('does not let the card keyboard handler intercept list menu or direct edit activation', async () => {
    const user = userEvent.setup();
    renderRepositoryCard('list');

    const moreActions = screen.getByRole('button', { name: '\u66f4\u591a\u4ed3\u5e93\u64cd\u4f5c' }); // Chinese for "More repository actions"
    moreActions.focus();
    await user.keyboard('{Enter}');
    expect(screen.queryByTestId('readme-modal')).not.toBeInTheDocument();
    expect(await screen.findByRole('menuitem', { name: '\u67e5\u627e\u540c\u7c7b\u4ed3\u5e93' })).toBeInTheDocument(); // Chinese for "Find similar repositories"
    await user.keyboard('{Escape}');

    const unsubscribe = screen.getByRole('button', { name: '\u53d6\u6d88\u8ba2\u9605\u53d1\u5e03' }); // Chinese for "Unsubscribe release"
    unsubscribe.focus();
    await user.keyboard('{Enter}');
    expect(actionMocks.actions.toggleReleaseSubscription).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('readme-modal')).not.toBeInTheDocument();

    const editAction = screen.getByRole('button', { name: '\u7f16\u8f91\u4ed3\u5e93\u4fe1\u606f' }); // Chinese for "Edit repository info"
    editAction.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('repository-edit-modal')).toBeInTheDocument();
  });

  it('keeps Unstar at the bottom of the grid menu and delegates it to the domain Hook', async () => {
    const user = userEvent.setup();
    renderRepositoryCard('grid');

    await user.click(screen.getByTitle('AI\u5206\u6790\u6b64\u4ed3\u5e93')); // Chinese for "AI analyze this repository"
    expect(screen.queryByTitle('\u53d6\u6d88 Star')).not.toBeInTheDocument(); // Chinese for "Unstar"
    await user.click(screen.getByRole('button', { name: '\u66f4\u591a\u4ed3\u5e93\u64cd\u4f5c' })); // Chinese for "More repository actions"
    expect(screen.getAllByRole('menuitem').at(-1)).toHaveTextContent('\u53d6\u6d88 Star'); // Chinese for "Unstar"
    await user.click(screen.getByRole('menuitem', { name: '\u53d6\u6d88 Star' })); // Chinese for "Unstar"

    expect(actionMocks.actions.analyze).toHaveBeenCalledOnce();
    expect(actionMocks.actions.unstar).toHaveBeenCalledOnce();
  });

  it('does not show a separator above Unstar when it is the only grid menu item', async () => {
    const user = userEvent.setup();
    renderRepositoryCard('grid');

    await user.click(screen.getByRole('button', { name: '\u66f4\u591a\u4ed3\u5e93\u64cd\u4f5c' })); // Chinese for "More repository actions"
    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });

  it('closes the grid action menu without opening README when card whitespace is clicked', async () => {
    const user = userEvent.setup();
    const { container } = renderRepositoryCard('grid');
    const card = container.firstElementChild as HTMLElement;

    await user.click(screen.getByRole('button', { name: '\u66f4\u591a\u4ed3\u5e93\u64cd\u4f5c' })); // Chinese for "More repository actions"
    expect(screen.getByRole('menuitem', { name: '\u53d6\u6d88 Star' })).toBeInTheDocument(); // Chinese for "Unstar"
    await act(async () => {
      fireEvent.pointerDown(card);
      fireEvent.click(card);
    });

    await waitFor(() => expect(screen.queryByRole('menuitem', { name: '\u53d6\u6d88 Star' })).not.toBeInTheDocument()); // Chinese for "Unstar"
    expect(screen.queryByTestId('readme-modal')).not.toBeInTheDocument();
  });

  it('shows the customized edit tooltip in grid mode', () => {
    render(
      <DialogProvider>
        <TooltipProvider>
          <RepositoryCard repository={{ ...repository, custom_description: 'My summary' }} allCategories={[]} viewMode="grid" />
        </TooltipProvider>
      </DialogProvider>,
    );

    expect(screen.getByTitle('\u5df2\u81ea\u5b9a\u4e49\uff0c\u7f16\u8f91\u4ed3\u5e93\u4fe1\u606f')).toBeInTheDocument(); // Chinese for "Customized, edit repository info"
  });

  it('emits a repository-chat intent from both grid and list controls without invoking a service', async () => {
    const user = userEvent.setup();
    const onAskRepository = vi.fn();
    const { unmount } = renderRepositoryCard('grid', { onAskRepository });

    await user.click(screen.getByRole('button', { name: '\u95ee\u7b54\u6b64\u4ed3\u5e93' })); // Chinese for "Chat with this repository"
    expect(onAskRepository).toHaveBeenCalledWith(repository);
    unmount();

    renderRepositoryCard('list', { onAskRepository });
    await user.click(screen.getByRole('button', { name: '\u95ee\u7b54\u6b64\u4ed3\u5e93' })); // Chinese for "Chat with this repository"
    expect(onAskRepository).toHaveBeenCalledTimes(2);
  });

  it('opens the release sheet from the grid action immediately before the DeepWiki/Zread action', async () => {
    const user = userEvent.setup();
    renderRepositoryCard('grid');

    const releaseButton = screen.getByRole('button', { name: '\u67e5\u770b Release' }); // Chinese for "View Release"
    const zreadLink = screen.getByTitle('\u5728Zread\u4e2d\u67e5\u770b'); // Chinese for "View in Zread"
    expect(releaseButton.compareDocumentPosition(zreadLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(releaseButton);
    expect(await screen.findByTestId('repository-release-sheet')).toBeInTheDocument();
  });

  it('opens the release sheet from the list action menu without opening README', async () => {
    const user = userEvent.setup();
    renderRepositoryCard('list');

    await user.click(screen.getByRole('button', { name: '\u67e5\u770b Release' })); // Chinese for "View Release"

    expect(screen.getByTestId('repository-release-sheet')).toBeInTheDocument();
    expect(screen.queryByTestId('readme-modal')).not.toBeInTheDocument();
  });

  it('does not open README when an outside click closes the lazy release-sheet fallback', async () => {
    const user = userEvent.setup();
    actionMocks.releaseSheet.suspend = new Promise(() => undefined);
    const { container } = renderRepositoryCard('grid');
    const card = container.firstElementChild as HTMLElement;

    await user.click(screen.getByRole('button', { name: '\u67e5\u770b Release' })); // Chinese for "View Release"
    expect(await screen.findByText('Loading releases…')).toBeInTheDocument();

    await act(async () => {
      fireEvent.pointerDown(document.body);
      fireEvent.click(card);
    });

    expect(screen.queryByTestId('readme-modal')).not.toBeInTheDocument();
  });

  it('does not open README when an outside click closes the edit modal', async () => {
    const user = userEvent.setup();
    const { container } = renderRepositoryCard('grid');
    const card = container.firstElementChild as HTMLElement;

    await user.click(screen.getByTitle('\u7f16\u8f91\u4ed3\u5e93\u4fe1\u606f')); // Chinese for "Edit repository info"
    const editModal = screen.getByTestId('repository-edit-modal');

    await act(async () => {
      fireEvent.pointerDown(editModal);
      fireEvent.click(card);
    });

    expect(screen.queryByTestId('readme-modal')).not.toBeInTheDocument();
  });

  it('retains the other quick actions in grid mode', () => {
    renderRepositoryCard('grid', { onAskRepository: vi.fn() });

    expect(screen.getByRole('button', { name: '\u66f4\u591a\u4ed3\u5e93\u64cd\u4f5c' })).toBeInTheDocument(); // Chinese for "More repository actions"
    expect(screen.getByTitle('AI\u5206\u6790\u6b64\u4ed3\u5e93')).toBeInTheDocument(); // Chinese for "AI analyze this repository"
    expect(screen.getByTitle('\u95ee\u7b54\u6b64\u4ed3\u5e93')).toBeInTheDocument(); // Chinese for "Chat with this repository"
    expect(screen.getByTitle('\u53d6\u6d88\u8ba2\u9605\u53d1\u5e03')).toBeInTheDocument(); // Chinese for "Unsubscribe release"
    expect(screen.getByTitle('\u7f16\u8f91\u4ed3\u5e93\u4fe1\u606f')).toBeInTheDocument(); // Chinese for "Edit repository info"

    const actionRow = screen.getByTestId('grid-action-row');
    expect(actionRow).toHaveClass('w-full', 'justify-start', 'overflow-hidden');

    const footer = screen.getByText(/\u6700\u8fd1\u63d0\u4ea4/).closest('.border-t'); // Chinese for "Latest commit"
    expect(footer?.parentElement).toHaveClass('mt-4');
  });

  it('collapses trailing grid actions into a more-actions menu when the card is narrow', async () => {
    const user = userEvent.setup();
    renderRepositoryCard('grid', { onAskRepository: vi.fn() });
    const actionRow = screen.getByTestId('grid-action-row');
    Object.defineProperty(actionRow, 'clientWidth', { configurable: true, value: 190 });

    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });

    expect(screen.queryByTitle('\u5728Zread\u4e2d\u67e5\u770b')).not.toBeInTheDocument(); // Chinese for "View in Zread"
    const moreActions = screen.getByRole('button', { name: '\u66f4\u591a\u4ed3\u5e93\u64cd\u4f5c' }); // Chinese for "More repository actions"
    await user.click(moreActions);

    expect(screen.getByRole('menuitem', { name: '\u5728 Zread \u4e2d\u67e5\u770b' })).toBeInTheDocument(); // Chinese for "View in Zread"
    expect(screen.getByRole('menuitem', { name: '\u5728 GitHub \u4e2d\u67e5\u770b' })).toBeInTheDocument(); // Chinese for "View on GitHub"
    expect(screen.getByRole('menuitem', { name: '\u53d6\u6d88 Star' })).toBeInTheDocument(); // Chinese for "Unstar"

    Object.defineProperty(actionRow, 'clientWidth', { configurable: true, value: 76 });
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(screen.getByRole('menuitem', { name: '\u95ee\u7b54\u6b64\u4ed3\u5e93' })).toBeInTheDocument(); // Chinese for "Chat with this repository"
  });

  it('collapses trailing list actions into a more-actions menu when the row is narrow', async () => {
    const user = userEvent.setup();
    renderRepositoryCard('list', { onAskRepository: vi.fn() });
    const actionRow = screen.getByTestId('list-action-row');
    Object.defineProperty(actionRow, 'clientWidth', { configurable: true, value: 190 });

    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });

    expect(screen.queryByTitle('\u5728Zread\u4e2d\u67e5\u770b')).not.toBeInTheDocument(); // Chinese for "View in Zread"
    const moreActions = screen.getByRole('button', { name: '\u66f4\u591a\u4ed3\u5e93\u64cd\u4f5c' }); // Chinese for "More repository actions"
    await user.click(moreActions);

    expect(screen.getByRole('menuitem', { name: '\u5728 Zread \u4e2d\u67e5\u770b' })).toBeInTheDocument(); // Chinese for "View in Zread"
    expect(screen.getByRole('menuitem', { name: '\u5728 GitHub \u4e2d\u67e5\u770b' })).toBeInTheDocument(); // Chinese for "View on GitHub"
    expect(screen.getByRole('menuitem', { name: '\u53d6\u6d88 Star' })).toBeInTheDocument(); // Chinese for "Unstar"
    expect(screen.getByRole('menuitem', { name: '\u67e5\u627e\u540c\u7c7b\u4ed3\u5e93' })).toBeInTheDocument(); // Chinese for "Find similar repositories"
  });

  it('keeps the persistent list more-actions menu visible when eight primary slots would otherwise fill the row', async () => {
    renderRepositoryCard('list', { onAskRepository: vi.fn() });
    const actionRow = screen.getByTestId('list-action-row');
    Object.defineProperty(actionRow, 'clientWidth', { configurable: true, value: 298 });

    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });

    expect(screen.getByRole('button', { name: '\u66f4\u591a\u4ed3\u5e93\u64cd\u4f5c' })).toBeInTheDocument(); // Chinese for "More repository actions"
    expect(screen.queryByTitle('\u53d6\u6d88 Star')).not.toBeInTheDocument(); // Chinese for "Unstar"
  });

  it('keeps the plugin page dialog after the card menu closes', async () => {
    const user = userEvent.setup();
    pluginClientMocks.list.mockResolvedValue({
      plugins: [{
        directoryName: 'repo-info-card',
        manifest: {
          manifestVersion: 1,
          id: 'com.githubstarsmanager.repo-info-card',
          name: 'Repository Info Card',
          version: '0.1.0',
          apiVersion: '1',
          permissions: ['repositories:read'],
          contributes: {
            repositoryActions: [{
              id: 'generate-info-card',
              title: 'Generate Repository Info Card',
              placement: 'repository-card',
              opensPage: 'info-card',
            }],
            pages: [{ id: 'info-card', title: 'Repository Info Card', entry: 'ui/index.html' }],
          },
        },
        enabled: true,
        status: 'active',
        grantedPermissions: ['repositories:read'],
      }],
      invalidPlugins: [],
    });
    const { unmount } = render(
      <DialogProvider>
        <TooltipProvider>
          <RepositoryCard repository={repository} allCategories={[]} viewMode="list" />
          <PluginPageHost />
        </TooltipProvider>
      </DialogProvider>,
    );
    await user.click(screen.getByRole('button', { name: '\u66f4\u591a\u4ed3\u5e93\u64cd\u4f5c' })); // Chinese for "More repository actions"
    await user.click(await screen.findByRole('menuitem', { name: 'Generate Repository Info Card' }));
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(await screen.findByRole('dialog', { name: 'Generate Repository Info Card' })).toBeInTheDocument();

    // The modal is mounted on the app root: it remains present after card unmounts.
    unmount();
    render(<PluginPageHost />);
    expect(screen.getByRole('dialog', { name: 'Generate Repository Info Card' })).toBeInTheDocument();
  });
});

describe('RepositoryCard interactive-element click exemption (issue #353)', () => {
  it('keeps the GitHub link navigable while the drag flag is stuck', () => {
    renderRepositoryCard('grid');

    act(() => {
      useRepositoryDragStore.getState().startDrag();
    });

    // fireEvent.click returning false indicates the event was cancelled by preventDefault
    expect(fireEvent.click(screen.getByTitle('\u5728GitHub\u4e0a\u67e5\u770b'))).toBe(true); // Chinese for "View on GitHub"
    expect(screen.queryByTestId('readme-modal')).not.toBeInTheDocument();

    act(() => {
      useRepositoryDragStore.getState().endDrag();
    });
  });

  it('still swallows blank-area card clicks while dragging', () => {
    const { container } = renderRepositoryCard('grid');
    const card = container.firstElementChild as HTMLElement;

    act(() => {
      useRepositoryDragStore.getState().startDrag();
    });

    expect(fireEvent.click(card)).toBe(false);

    act(() => {
      useRepositoryDragStore.getState().endDrag();
    });
  });

  it('keeps the GitHub link navigable right after an edit-modal outside dismiss', async () => {
    const user = userEvent.setup();
    renderRepositoryCard('grid');

    await user.click(screen.getByTitle('\u7f16\u8f91\u4ed3\u5e93\u4fe1\u606f')); // Chinese for "Edit repository info"
    const editModal = screen.getByTestId('repository-edit-modal');

    // After onOutsideDismiss records dismiss timestamp, link clicks within the 250ms window are not swallowed
    // (real modal is closed by Radix; mock lacks close mechanism, which does not affect window semantics)
    await act(async () => {
      fireEvent.pointerDown(editModal);
      expect(fireEvent.click(screen.getByTitle('\u5728GitHub\u4e0a\u67e5\u770b'))).toBe(true); // Chinese for "View on GitHub"
    });
  });
});


describe('RepositoryCard touch-drag click suppression (CodeRabbit #355)', () => {
  it('suppresses the compatibility click after a touch drag even when a compatibility mousemove fires', () => {
    const { container } = renderRepositoryCard('grid');
    const card = container.firstElementChild as HTMLElement;
    const handle = card.querySelector('[draggable="true"]') as HTMLElement;

    fireEvent.touchStart(handle, { touches: [{ clientX: 10, clientY: 10 }] });
    fireEvent.touchMove(handle, { touches: [{ clientX: 60, clientY: 60 }] });
    fireEvent.touchEnd(handle, { touches: [] });

    // Compatible mouse event sequence after touch: mousemove triggers dragStore fallback clearing,
    // but instance-level suppression flag must still intercept the subsequent click
    fireEvent.mouseMove(document.body);
    expect(useRepositoryDragStore.getState().isDragging).toBe(false);
    expect(fireEvent.click(card)).toBe(false);
    expect(screen.queryByTestId('readme-modal')).not.toBeInTheDocument();
  });

  it('keeps the GitHub link navigable after a touch drag with compatibility mouse events', () => {
    const { container } = renderRepositoryCard('grid');
    const card = container.firstElementChild as HTMLElement;
    const handle = card.querySelector('[draggable="true"]') as HTMLElement;

    fireEvent.touchStart(handle, { touches: [{ clientX: 10, clientY: 10 }] });
    fireEvent.touchMove(handle, { touches: [{ clientX: 60, clientY: 60 }] });
    fireEvent.touchEnd(handle, { touches: [] });
    fireEvent.mouseMove(document.body);

    expect(fireEvent.click(screen.getByTitle('\u5728GitHub\u4e0a\u67e5\u770b'))).toBe(true); // Chinese for "View on GitHub"
  });
});

describe('RepositoryCard rapid touch drags (CodeRabbit round 2)', () => {
  it('keeps suppressing the compatibility click when a second touch drag starts within 200ms', () => {
    vi.useFakeTimers();
    try {
      const { container } = renderRepositoryCard('grid');
      const card = container.firstElementChild as HTMLElement;
      const handle = card.querySelector('[draggable="true"]') as HTMLElement;

      const dragOnce = () => {
        fireEvent.touchStart(handle, { touches: [{ clientX: 10, clientY: 10 }] });
        fireEvent.touchMove(handle, { touches: [{ clientX: 60, clientY: 60 }] });
        fireEvent.touchEnd(handle, { touches: [] });
      };

      dragOnce();
      // When second drag starts, reset timer from first drag has not fired yet
      vi.advanceTimersByTime(100);
      dragOnce();
      // Advance past original trigger point of first timer: must not prematurely clear second suppression flag
      vi.advanceTimersByTime(120);
      expect(fireEvent.click(card)).toBe(false);
      expect(screen.queryByTestId('readme-modal')).not.toBeInTheDocument();

      // Restores after suppression window expires normally
      vi.advanceTimersByTime(200);
      expect(fireEvent.click(card)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honours the per-field visibility switches', () => {
    storeState.repositoryCardFields = {
      description: false,
      tags: false,
      language: false,
      stars: true,
      license: false,
      lastUpdated: false,
    };
    renderRepositoryCard('grid');

    // Disabled fields do not render: repo has no language/license text to assert, assert description and tags disappear here
    expect(screen.queryByText('Repository description')).not.toBeInTheDocument();
    expect(screen.queryByText('TypeScript')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'owner/example-repository' })).toBeInTheDocument();
    // Still-enabled fields display as usual
    expect(screen.getByText('128')).toBeInTheDocument();
  });

  it('keeps analysis status visible when the description is hidden', () => {
    repository.analyzed_at = '2026-01-04T00:00:00.000Z';
    storeState.repositoryCardFields.description = false;

    try {
      renderRepositoryCard('grid');
      expect(screen.queryByText('Repository description')).not.toBeInTheDocument();
      expect(screen.getByText('AI\u5df2\u5206\u6790')).toBeInTheDocument(); // Chinese for "AI analyzed"
    } finally {
      delete repository.analyzed_at;
    }
  });

  it('shows customized status in list view', () => {
    repository.custom_description = 'Customized description';

    try {
      renderRepositoryCard('list');
      expect(screen.getByText('\u5df2\u81ea\u5b9a\u4e49')).toBeInTheDocument(); // Chinese for "Customized"
    } finally {
      delete repository.custom_description;
    }
  });
});
