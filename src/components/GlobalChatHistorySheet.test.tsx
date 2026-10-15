import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalChatHistorySheet } from './GlobalChatHistorySheet';
import { repositoryChatStorage } from '../services/repositoryChatStorage';
import type { Repository } from '../types';
import type { RepositoryChatSession } from '../types/repositoryChat';

vi.mock('../store/useAppStore', () => ({
  useAppStore: (selector: (state: { language: 'en' }) => unknown) => selector({ language: 'en' }),
}));

const createRepository = (id: number, fullName: string): Repository => ({
  id,
  name: fullName.split('/')[1],
  full_name: fullName,
  owner: { login: fullName.split('/')[0], avatar_url: 'https://example.com/avatar.png' },
} as unknown as Repository);

const createSession = (id: string, repoId: number, repoFullName: string, updatedAt: string): RepositoryChatSession => ({
  id,
  repoId,
  repoFullName,
  sourceRefSha: 'abcdef1234567890',
  title: `title-${id}`,
  createdAt: updatedAt,
  updatedAt,
});

const repositories = [createRepository(1, 'owner/repo-one'), createRepository(2, 'owner/repo-two')];

describe('GlobalChatHistorySheet', () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
  });

  it('lists cross-repository sessions in reverse chronological order', async () => {
    await repositoryChatStorage.saveSession(createSession('older', 1, 'owner/repo-one', '2026-08-24T00:00:00.000Z'));
    await repositoryChatStorage.saveSession(createSession('newer', 2, 'owner/repo-two', '2026-08-26T00:00:00.000Z'));

    render(<GlobalChatHistorySheet isOpen repositories={repositories} onClose={() => {}} onSelectSession={() => {}} />);

    const items = await screen.findAllByTitle(/Open conversation in owner\//);
    expect(screen.getByRole('heading', { name: 'Chat history (2)' })).toBeInTheDocument();
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('title-newer'),
      expect.stringContaining('title-older'),
    ]);
  });

  it('filters by title or repo name and navigates to the session', async () => {
    await repositoryChatStorage.saveSession(createSession('s1', 1, 'owner/repo-one', '2026-08-24T00:00:00.000Z'));
    await repositoryChatStorage.saveSession(createSession('s2', 2, 'owner/repo-two', '2026-08-26T00:00:00.000Z'));
    const onSelectSession = vi.fn();

    render(<GlobalChatHistorySheet isOpen repositories={repositories} onClose={() => {}} onSelectSession={onSelectSession} />);
    await screen.findByTitle('Open conversation in owner/repo-one');

    fireEvent.change(screen.getByLabelText('Search chat history'), { target: { value: 'repo-two' } });
    expect(screen.queryByTitle('Open conversation in owner/repo-one')).toBeNull();

    fireEvent.click(screen.getByTitle('Open conversation in owner/repo-two'));
    expect(onSelectSession).toHaveBeenCalledWith(repositories[1], 's2');
  });

  it('removes session from list after deletion', async () => {
    await repositoryChatStorage.saveSession(createSession('doomed', 1, 'owner/repo-one', '2026-08-26T00:00:00.000Z'));

    render(<GlobalChatHistorySheet isOpen repositories={repositories} onClose={() => {}} onSelectSession={() => {}} />);
    await screen.findByTitle('Open conversation in owner/repo-one');

    const item = screen.getByTitle('Open conversation in owner/repo-one').closest('li') as HTMLElement;
    fireEvent.click(within(item).getByRole('button', { name: /Delete conversation/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete conversation' }));

    expect(await screen.findByText('No saved conversations yet.')).toBeTruthy();
  });

  it('shows error and retry button on load failure, and reloads after recovery', async () => {
    const listSpy = vi.spyOn(repositoryChatStorage, 'listRecentSessions');
    listSpy.mockRejectedValueOnce(new Error('IndexedDB unavailable'));

    render(<GlobalChatHistorySheet isOpen repositories={repositories} onClose={() => {}} onSelectSession={() => {}} />);
    expect(await screen.findByText('Failed to load history. Please retry.')).toBeTruthy();

    listSpy.mockResolvedValueOnce([createSession('recovered', 1, 'owner/repo-one', '2026-08-26T00:00:00.000Z')]);
    const retryButtons = await screen.findAllByRole('button', { name: 'Retry' });
    fireEvent.click(retryButtons[0]);

    expect(await screen.findByTitle('Open conversation in owner/repo-one')).toBeTruthy();
    listSpy.mockRestore();
  });
});
