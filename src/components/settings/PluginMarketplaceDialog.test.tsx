import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginMarketplaceDialog } from './PluginMarketplaceDialog';
import { makeT } from '../../i18n/useT';
import type { InstalledPlugin, MarketplaceState } from '../../plugins/types';

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let snapshot = { plugins: [] as InstalledPlugin[], invalidPlugins: [] };
  return {
    isAvailable: vi.fn(() => true),
    getState: vi.fn(),
    refresh: vi.fn(),
    install: vi.fn(),
    addSource: vi.fn(),
    updateSource: vi.fn(),
    removeSource: vi.fn(),
    loadOfficialRegistry: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    uninstall: vi.fn(),
    refreshInstalled: vi.fn(),
    toast: vi.fn(),
    confirm: vi.fn(),
    setStoreSnapshot(next: { plugins: InstalledPlugin[]; invalidPlugins: never[] }) {
      snapshot = next;
      for (const listener of listeners) listener();
    },
    store: {
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSnapshot() {
        return snapshot;
      },
    },
  };
});

vi.mock('../../services/pluginMarketplaceService', () => ({
  pluginMarketplaceService: {
    isAvailable: mocks.isAvailable,
    getState: mocks.getState,
    refresh: mocks.refresh,
    install: mocks.install,
    addSource: mocks.addSource,
    updateSource: mocks.updateSource,
    removeSource: mocks.removeSource,
  },
}));

vi.mock('../../services/pluginRegistryService', () => ({
  pluginRegistryService: {
    load: mocks.loadOfficialRegistry,
  },
}));

vi.mock('../../plugins/pluginRegistry', () => ({
  pluginRegistry: {
    subscribe: mocks.store.subscribe,
    getSnapshot: mocks.store.getSnapshot,
    enable: mocks.enable,
    disable: mocks.disable,
    uninstall: mocks.uninstall,
    refresh: mocks.refreshInstalled,
  },
}));

vi.mock('../../hooks/useDialog', () => ({
  useDialog: () => ({ toast: mocks.toast, confirm: mocks.confirm }),
}));

const t = makeT('en', 'app');

const sourceEntry = (sourceId: string, url: string, name?: string) => ({
  source: { id: sourceId, url, ...(name ? { name } : {}), addedAt: '2026-10-01T00:00:00.000Z' },
});

const entryManifest = (overrides: Record<string, unknown> = {}) => ({
  manifestVersion: 1,
  id: 'com.example.fixture',
  name: 'Fixture',
  version: '1.0.0',
  apiVersion: '1',
  permissions: ['storage'],
  contributes: {},
  ...overrides,
});

const marketplaceState = (): MarketplaceState => ({
  sources: [{ id: 'src-1', url: 'https://github.com/owner/repo/tree/main/plugins', name: 'owner/repo', addedAt: '2026-10-01T00:00:00.000Z' }],
  entries: [{
    ...sourceEntry('src-1', 'https://github.com/owner/repo/tree/main/plugins', 'owner/repo'),
    status: 'ok',
    plugins: [
      { directoryName: 'fixture', manifest: entryManifest() },
      { directoryName: 'next-version', manifest: entryManifest({ id: 'com.example.updatable', name: 'Updatable', version: '2.0.0' }) },
    ],
    warnings: [],
    error: null,
    fetchedAt: '2026-10-01T00:00:00.000Z',
  }],
});

const installedPlugin = (overrides: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
  directoryName: 'com.example.fixture',
  enabled: false,
  status: 'disabled',
  grantedPermissions: ['storage'],
  manifest: entryManifest(),
  ...overrides,
} as InstalledPlugin);

const renderDialog = () => render(<PluginMarketplaceDialog isOpen onClose={() => {}} t={t} />);

/** Wait until catalog data renders the first plugin row (the list container is always present and cannot serve as the ready signal). */
const waitForCatalog = async () => {
  await waitFor(() => expect(screen.getByTestId('marketplace-plugin-com.example.fixture')).toBeInTheDocument());
};

describe('PluginMarketplaceDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAvailable.mockReturnValue(true);
    mocks.getState.mockResolvedValue(marketplaceState());
    mocks.loadOfficialRegistry.mockResolvedValue({
      success: true,
      registry: { fetchedAt: '', plugins: [], removed: [], rejected: [], error: null },
    });
    mocks.refreshInstalled.mockResolvedValue(undefined);
    mocks.confirm.mockResolvedValue(true);
  });

  it('lists plugins grouped by source with their version and permissions', async () => {
    renderDialog();
    await waitForCatalog();

    expect(screen.getByText('owner/repo')).toBeInTheDocument();
    expect(screen.getByTestId('marketplace-plugin-com.example.fixture')).toHaveTextContent('Fixture');
    expect(screen.getByTestId('marketplace-plugin-com.example.fixture')).toHaveTextContent('v1.0.0');
    expect(screen.getByTestId('marketplace-plugin-com.example.fixture')).toHaveTextContent('storage');
    expect(within(screen.getByTestId('marketplace-plugin-com.example.fixture')).getByRole('button', { name: 'Install' })).toBeInTheDocument();
  });

  it('installs an available plugin and refreshes the installed list', async () => {
    mocks.install.mockResolvedValue({ success: true, pluginId: 'com.example.fixture' });
    const user = userEvent.setup();
    renderDialog();
    await waitForCatalog();

    const row = screen.getByTestId('marketplace-plugin-com.example.fixture');
    await user.click(within(row).getByRole('button', { name: 'Install' }));

    await vi.waitFor(() => expect(mocks.install).toHaveBeenCalledWith({
      sourceId: 'src-1',
      directoryName: 'fixture',
      expectedPluginId: 'com.example.fixture',
      expectedVersion: '1.0.0',
      replace: false,
    }));
    await vi.waitFor(() => expect(mocks.refreshInstalled).toHaveBeenCalled());
    expect(mocks.toast).toHaveBeenCalledWith('Installed Fixture. Review the permissions before enabling it.', 'success');
  });

  it('enables an installed plugin only after the permission confirmation', async () => {
    mocks.setStoreSnapshot({ plugins: [installedPlugin()], invalidPlugins: [] });
    mocks.enable.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderDialog();
    await waitForCatalog();

    await user.click(screen.getByRole('switch', { name: 'Enable Fixture' }));

    expect(mocks.confirm).toHaveBeenCalledWith(
      'Enable Fixture',
      expect.stringContaining('storage'),
      expect.objectContaining({ type: 'warning' }),
    );
    await vi.waitFor(() => expect(mocks.enable).toHaveBeenCalledWith('com.example.fixture', ['storage']));
  });

  it('does not enable when the user declines the confirmation', async () => {
    mocks.setStoreSnapshot({ plugins: [installedPlugin()], invalidPlugins: [] });
    mocks.confirm.mockResolvedValue(false);
    const user = userEvent.setup();
    renderDialog();
    await waitForCatalog();

    await user.click(screen.getByRole('switch', { name: 'Enable Fixture' }));

    expect(mocks.enable).not.toHaveBeenCalled();
  });

  it('shows the update action when the source has a newer version and installs with replace', async () => {
    mocks.setStoreSnapshot({
      plugins: [installedPlugin({
        manifest: entryManifest({ id: 'com.example.updatable', name: 'Updatable', version: '1.0.0' }),
      })],
      invalidPlugins: [],
    });
    mocks.install.mockResolvedValue({ success: true, pluginId: 'com.example.updatable' });
    const user = userEvent.setup();
    renderDialog();
    await waitForCatalog();

    const row = screen.getByTestId('marketplace-plugin-com.example.updatable');
    expect(row).toHaveTextContent('Version 2.0.0 available');

    await user.click(screen.getByRole('button', { name: 'Update' }));
    await vi.waitFor(() => expect(mocks.install).toHaveBeenCalledWith({
      sourceId: 'src-1',
      directoryName: 'next-version',
      expectedPluginId: 'com.example.updatable',
      expectedVersion: '2.0.0',
      replace: true,
    }));
  });

  it('filters plugins by the search query', async () => {
    const user = userEvent.setup();
    renderDialog();
    await waitForCatalog();

    await user.type(screen.getByTestId('marketplace-search'), 'Updatable');

    expect(screen.getByTestId('marketplace-plugin-com.example.updatable')).toBeInTheDocument();
    expect(screen.queryByTestId('marketplace-plugin-com.example.fixture')).not.toBeInTheDocument();
  });

  it('surfaces a source error and retries just that source', async () => {
    mocks.getState.mockResolvedValue({
      sources: [{ id: 'src-1', url: 'https://github.com/owner/repo/tree/main/plugins', name: 'owner/repo', addedAt: '' }],
      entries: [{
        ...sourceEntry('src-1', 'https://github.com/owner/repo/tree/main/plugins'),
        status: 'error',
        plugins: [],
        warnings: [],
        error: { code: 'SOURCE_LIST_TIMEOUT', message: 'Request timed out' },
        fetchedAt: null,
      }],
    });
    mocks.refresh.mockResolvedValue({ success: true, state: marketplaceState() });
    const user = userEvent.setup();
    renderDialog();
    // SOURCE_LIST_TIMEOUT is mapped to a user-readable timeout notice rather than passing through the raw message.
    await waitFor(() => expect(screen.getByTestId('marketplace-plugin-list')).toHaveTextContent('The request timed out'));

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledWith({ sourceId: 'src-1' }));
  });

  it('blocks installing a version that the official registry revoked and shows the reason', async () => {
    mocks.loadOfficialRegistry.mockResolvedValue({
      success: true,
      registry: {
        fetchedAt: '',
        plugins: [],
        removed: [{ id: 'com.example.fixture', versions: ['1.0.0'], reason: 'Sent repository list to third parties', date: '2026-10-01', action: 'revoke' }],
        rejected: [],
        error: null,
      },
    });
    renderDialog();
    await waitForCatalog();

    const row = screen.getByTestId('marketplace-plugin-com.example.fixture');
    expect(row).toHaveTextContent('Revoked');
    expect(row).toHaveTextContent('Sent repository list to third parties');
    expect(screen.getByRole('button', { name: 'Install' })).toBeDisabled();
  });

  it('offers a direct disable for an enabled plugin that was revoked', async () => {
    mocks.setStoreSnapshot({ plugins: [installedPlugin({ enabled: true, status: 'active' })], invalidPlugins: [] });
    mocks.loadOfficialRegistry.mockResolvedValue({
      success: true,
      registry: {
        fetchedAt: '',
        plugins: [],
        removed: [{ id: 'com.example.fixture', versions: [], reason: 'All versions revoked', date: '2026-10-01', action: 'revoke' }],
        rejected: [],
        error: null,
      },
    });
    mocks.disable.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderDialog();
    await waitForCatalog();

    await user.click(screen.getByRole('button', { name: 'Disable now' }));
    await vi.waitFor(() => expect(mocks.disable).toHaveBeenCalledWith('com.example.fixture'));
  });

  it('surfaces a disable-now prompt for a revoked installed plugin even if no source lists it', async () => {
    // The plugin's sole source was deleted: marketplace rows will not render the plugin, but the official revocation notice must appear independently.
    mocks.setStoreSnapshot({ plugins: [installedPlugin({ enabled: true, status: 'active' })], invalidPlugins: [] });
    mocks.getState.mockResolvedValue({ sources: [], entries: [] });
    mocks.loadOfficialRegistry.mockResolvedValue({
      success: true,
      registry: {
        fetchedAt: '',
        plugins: [],
        removed: [{ id: 'com.example.fixture', versions: ['1.0.0'], reason: 'Sent repository list to third parties', date: '2026-10-01', action: 'revoke' }],
        rejected: [],
        error: null,
      },
    });
    mocks.disable.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('marketplace-revoked-com.example.fixture')).toBeInTheDocument());

    expect(screen.getByTestId('marketplace-revoked-section')).toHaveTextContent('Revoked installed plugins');
    expect(screen.getByTestId('marketplace-revoked-com.example.fixture')).toHaveTextContent('Sent repository list to third parties');

    await user.click(within(screen.getByTestId('marketplace-revoked-com.example.fixture')).getByRole('button', { name: 'Disable now' }));
    await vi.waitFor(() => expect(mocks.disable).toHaveBeenCalledWith('com.example.fixture'));
  });

  it('shows the empty state with an add-source action when no sources exist', async () => {
    mocks.getState.mockResolvedValue({ sources: [], entries: [] });
    renderDialog();
    await waitFor(() => expect(screen.getByText('No plugins available yet.')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Add source' })).toBeInTheDocument();
  });

  it('manages sources through the nested dialog', async () => {
    mocks.addSource.mockResolvedValue({ success: true, state: marketplaceState() });
    const user = userEvent.setup();
    renderDialog();
    await waitForCatalog();

    await user.click(screen.getByTestId('marketplace-manage-sources'));
    expect(await screen.findByRole('heading', { name: 'Manage plugin sources' })).toBeInTheDocument();

    await user.click(screen.getByTestId('plugin-sources-add'));
    await user.type(screen.getByLabelText('Source URL'), 'https://github.com/owner/other/tree/main/plugins');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await vi.waitFor(() => expect(mocks.addSource).toHaveBeenCalledWith({
      url: 'https://github.com/owner/other/tree/main/plugins',
    }));
  });

  it('rejects an invalid source URL locally before touching the bridge', async () => {
    const user = userEvent.setup();
    renderDialog();
    await waitForCatalog();

    await user.click(screen.getByTestId('marketplace-manage-sources'));
    await user.click(screen.getByTestId('plugin-sources-add'));
    await user.type(screen.getByLabelText('Source URL'), 'https://gitlab.com/owner/repo');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByTestId('plugin-sources-form-error')).toHaveTextContent('Enter a valid GitHub repository directory URL.');
    expect(mocks.addSource).not.toHaveBeenCalled();
  });
});
