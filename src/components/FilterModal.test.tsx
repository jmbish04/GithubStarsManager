import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilterModal } from './FilterModal';
import { TooltipProvider } from './ui/tooltip';
import { useAppStore } from '../store/useAppStore';
import { defaultReleaseSourceSettings } from '../types';
import type { AssetFilter, Repository } from '../types';

vi.mock('../store/useAppStore', () => ({
  useAppStore: vi.fn(),
}));

const repository: Repository = {
  id: 7,
  name: 'repo',
  full_name: 'owner/repo',
  description: null,
  html_url: 'https://github.com/owner/repo',
  stargazers_count: 1,
  forks_count: 0,
  forks: 0,
  language: 'TypeScript',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  pushed_at: '2026-08-01T00:00:00.000Z',
  topics: [],
  owner: { login: 'owner', avatar_url: 'https://github.com/owner.png' },
};

const storeState = {
  repositories: [repository],
  releaseSubscriptions: new Set<number>([repository.id]),
  releaseSourceSettings: defaultReleaseSourceSettings,
  language: 'en' as const,
};

const mockUseAppStore = vi.mocked(useAppStore);

beforeEach(() => {
  vi.clearAllMocks();
  mockUseAppStore.mockImplementation(((selector?: (s: typeof storeState) => unknown) =>
    selector ? selector(storeState) : storeState) as unknown as typeof useAppStore);
});

const renderModal = (props: Partial<Parameters<typeof FilterModal>[0]> = {}) => {
  const onClose = vi.fn();
  const onSave = vi.fn();
  render(
    <TooltipProvider>
      <FilterModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        {...props}
      />
    </TooltipProvider>,
  );
  return { onClose, onSave };
};

describe('FilterModal tabs', () => {
  it('defaults to the assets tab with rule counts for new and edited filters', async () => {
    const { onSave } = renderModal();
    expect(screen.getByRole('tab', { name: 'Assets · 0' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Repositories · 0' })).toHaveAttribute('aria-selected', 'false');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows per-kind rule counts when editing an existing filter', () => {
    const filter: AssetFilter = {
      id: 'f1',
      name: 'Portable',
      keywords: ['portable', 'zip'],
      excludeKeywords: ['setup'],
      includeRepos: ['owner/beta'],
      alwaysExcludeRepos: ['owner/noise'],
    };
    renderModal({ filter });

    expect(screen.getByRole('tab', { name: 'Assets · 3' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Repositories · 2' })).toBeInTheDocument();
  });

  it('keeps the assets tab draft when switching to repositories and back', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText('Include keywords (optional)'), 'mac');
    // Asset tab has same text for include/exclude Add buttons; select the first one (include block comes first)
    await user.click(screen.getAllByRole('button', { name: 'Add' })[0]);
    expect(screen.getByText('mac')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Repositories · 0' }));
    await user.click(screen.getByRole('tab', { name: 'Assets · 1' }));

    expect(screen.getByText('mac')).toBeInTheDocument();
  });

  it('reopens on the assets tab and restores saved values, including cleared arrays', async () => {
    const user = userEvent.setup();
    const filter: AssetFilter = {
      id: 'f1',
      name: 'Portable',
      keywords: [],
      excludeKeywords: ['setup'],
      includeRepos: [],
      alwaysExcludeRepos: [],
    };
    const { rerender } = render(
      <TooltipProvider>
        <FilterModal isOpen onClose={vi.fn()} onSave={vi.fn()} filter={filter} />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole('tab', { name: 'Repositories · 0' }));

    // Reset when edited object changes: always return to "Assets" tab and reflect current value
    rerender(
      <TooltipProvider>
        <FilterModal isOpen onClose={vi.fn()} onSave={vi.fn()} filter={{ ...filter, name: 'Renamed' }} />
      </TooltipProvider>,
    );

    expect(screen.getByRole('tab', { name: 'Assets · 1' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Filter name')).toHaveValue('Renamed');
    expect(screen.getByText('setup')).toBeInTheDocument();
  });
});

describe('FilterModal save rules', () => {
  it('disables saving with a hint when only the name is configured', async () => {
    const user = userEvent.setup();
    const { onSave } = renderModal();

    await user.type(screen.getByLabelText('Filter name'), 'My filter');

    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    expect(
      screen.getByText('Configure at least one rule (asset keywords or repository rules) to save.'),
    ).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves a repository-only filter with all four arrays written', async () => {
    const user = userEvent.setup();
    const { onSave } = renderModal();

    await user.type(screen.getByLabelText('Filter name'), 'Beta only');
    await user.click(screen.getByRole('tab', { name: 'Repositories · 0' }));
    await user.click(screen.getByRole('button', { name: 'Add always-included repositories' }));
    await user.click(screen.getByRole('option', { name: 'owner/repo' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Beta only',
        keywords: [],
        excludeKeywords: [],
        includeRepos: ['owner/repo'],
        alwaysExcludeRepos: [],
      }));
    });
  });

  it('saves an exclude-keywords-only filter with empty include keywords', async () => {
    const user = userEvent.setup();
    const { onSave } = renderModal();

    await user.type(screen.getByLabelText('Filter name'), 'No setup');
    await user.type(screen.getByLabelText('Exclude keywords (optional)'), 'setup');
    // Add button in exclude keywords block (the second "Add")
    await user.click(screen.getAllByRole('button', { name: 'Add' })[1]);
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
        keywords: [],
        excludeKeywords: ['setup'],
        includeRepos: [],
        alwaysExcludeRepos: [],
      }));
    });
  });

  it('keeps the filter id when saving an edited filter', async () => {
    const user = userEvent.setup();
    const filter: AssetFilter = { id: 'f1', name: 'Old', keywords: ['old'], alwaysExcludeRepos: [] };
    const { onSave } = renderModal({ filter });

    await user.type(screen.getByLabelText('Include keywords (optional)'), 'new');
    await user.click(screen.getAllByRole('button', { name: 'Add' })[0]);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
        id: 'f1',
        keywords: ['old', 'new'],
        alwaysExcludeRepos: [],
      }));
    });
  });
});

describe('FilterModal repository pickers', () => {
  it('expands one picker at a time inside the repositories tab', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText('Filter name'), 'Repos');
    await user.click(screen.getByRole('tab', { name: 'Repositories · 0' }));

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add always-included repositories' }));
    expect(screen.getByText('Select repositories to always include')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add always-excluded repositories' }));
    expect(screen.queryByText('Select repositories to always include')).not.toBeInTheDocument();
    expect(screen.getByText('Select repositories to always exclude')).toBeInTheDocument();
  });

  it('supports search and removal in both pickers', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText('Filter name'), 'Repos');
    await user.click(screen.getByRole('tab', { name: 'Repositories · 0' }));

    // Exclude repos: search + multiselect + remove
    await user.click(screen.getByRole('button', { name: 'Add always-excluded repositories' }));
    await user.type(screen.getByPlaceholderText('Search repositories'), 'owner');
    await user.click(screen.getByRole('option', { name: 'owner/repo' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByText('owner/repo')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Repositories · 1' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove always-excluded repository owner/repo' }));
    expect(screen.queryByText('owner/repo')).not.toBeInTheDocument();
    expect(screen.getByText('No always-excluded repositories')).toBeInTheDocument();
  });

  it('flags a repository present in both lists without removing the user’s picks', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText('Filter name'), 'Conflict');
    await user.click(screen.getByRole('tab', { name: 'Repositories · 0' }));

    await user.click(screen.getByRole('button', { name: 'Add always-included repositories' }));
    await user.click(screen.getByRole('option', { name: 'owner/repo' }));
    await user.click(screen.getByRole('button', { name: 'Add always-excluded repositories' }));
    await user.click(screen.getByRole('option', { name: 'owner/repo' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));

    // Do not silently clean up: keep selections in both groups and show "exclusion takes precedence" conflict notice
    expect(screen.getAllByText('owner/repo')).toHaveLength(2);
    expect(screen.getAllByText('This repository is in both lists; the exclusion takes precedence').length).toBeGreaterThan(0);
  });
});
