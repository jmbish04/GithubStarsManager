import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultDiscoveryChannels } from '../store/schema';
import { useAppStore } from '../store/useAppStore';
import { DiscoveryChannelMenu } from './DiscoveryChannelMenu';

const storeMock = vi.mocked(useAppStore);

beforeEach(() => {
  storeMock.mockImplementation((selector) => {
    const state = {
      language: 'en',
      githubToken: null,
      setReadmeModalOpen: vi.fn(),
      addExternalDiscoveryChannel: vi.fn().mockReturnValue('external:example'),
      removeExternalDiscoveryChannel: vi.fn(),
    };
    return selector ? selector(state) : state;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DiscoveryChannelMenu', () => {
  it('lets the user hide an unwanted channel', async () => {
    const onToggleChannel = vi.fn();
    const user = userEvent.setup();
    render(<DiscoveryChannelMenu channels={defaultDiscoveryChannels} language="en"
      onToggleChannel={onToggleChannel} />);

    await user.click(screen.getByRole('button', { name: 'Manage discovery channels' }));
    const telegram = screen.getByRole('menuitemcheckbox', { name: 'Telegram Channels' });
    expect(telegram).toHaveAttribute('aria-checked', 'true');
    await user.click(telegram);

    expect(onToggleChannel).toHaveBeenCalledWith('telegram');
  });

  it('keeps the last visible channel enabled', async () => {
    const user = userEvent.setup();
    const channels = defaultDiscoveryChannels.map(channel => ({
      ...channel,
      enabled: channel.id === 'trending',
    }));
    render(<DiscoveryChannelMenu channels={channels} language="en"
      onToggleChannel={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Manage discovery channels' }));
    expect(screen.getByRole('menuitemcheckbox', { name: 'Trending' })).toHaveAttribute('data-disabled');
  });

  it('adds a readable JSON feed as a separate discovery channel', async () => {
    const addChannel = vi.fn().mockReturnValue('external:example');
    storeMock.mockImplementation((selector) => selector({
      language: 'en', addExternalDiscoveryChannel: addChannel,
      removeExternalDiscoveryChannel: vi.fn(),
    } as never));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      repositories: ['https://github.com/owner/repo'],
    }), { status: 200 })));
    const user = userEvent.setup();
    render(<DiscoveryChannelMenu channels={defaultDiscoveryChannels} language="en" onToggleChannel={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Manage discovery channels' }));
    await user.click(screen.getByRole('menuitem', { name: 'External discovery feeds' }));
    await user.type(screen.getByRole('textbox', { name: 'Channel name' }), 'My Source');
    await user.type(screen.getByRole('textbox', { name: 'HTTPS feed URL' }), 'https://example.com/feed.json');
    await user.click(screen.getByRole('button', { name: 'Add feed' }));
    await waitFor(() => expect(addChannel).toHaveBeenCalledWith('My Source', 'https://example.com/feed.json', 'json'));
  });
});
