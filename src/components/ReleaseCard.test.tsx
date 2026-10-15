import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ReleaseCard from './ReleaseCard';
import type { Release } from '../types';

const storeState: Record<string, unknown> = {
  rpcDownloadConfig: { enabled: true, host: '', port: 6800 },
  backendApiSecret: null,
  aiConfigs: [],
  activeAIConfig: null,
  language: 'zh',
};

vi.mock('../store/useAppStore', () => ({
  useAppStore: vi.fn((selector?: (state: Record<string, unknown>) => unknown) =>
    selector ? selector(storeState) : storeState),
}));

vi.mock('../hooks/useDialog', () => ({
  useDialog: () => ({ toast: vi.fn(), confirm: vi.fn() }),
}));

vi.mock('../services/rpcDownloadService', () => ({
  // Never resolves, avoiding async setState act() warnings; click handling itself is synchronous
  sendToRpcDownload: vi.fn(() => new Promise(() => {})),
}));

vi.mock('./MarkdownRenderer', () => ({
  default: () => null,
}));

vi.mock('../services/aiService', () => ({
  AIService: vi.fn(),
}));

const makeRelease = (id: number, overrides: Partial<Release> = {}): Release => ({
  id,
  tag_name: `v${id}`,
  name: `Release ${id}`,
  body: null,
  published_at: '2026-01-01T00:00:00.000Z',
  html_url: `https://github.com/owner/repo/releases/tag/v${id}`,
  assets: [
    {
      id: 101,
      name: 'app.dmg',
      size: 1000,
      download_count: 5,
      browser_download_url: 'https://example.com/app.dmg',
      content_type: 'application/octet-stream',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    },
  ],
  repository: { id: 1, full_name: 'owner/repo', name: 'repo' },
  ...overrides,
});

const buildCardProps = (props: Partial<Parameters<typeof ReleaseCard>[0]> = {}): Parameters<typeof ReleaseCard>[0] => ({
  release: makeRelease(1, { updated_asset_ids: [101] }),
  downloadLinks: [
    { name: 'app.dmg', url: 'https://example.com/app.dmg', size: 1000, downloadCount: 5, assetId: 101 },
  ],
  isUnread: true,
  isAssetsExpanded: true,
  isReleaseNotesExpanded: false,
  isFullContent: false,
  truncatedBody: '',
  onToggleAssets: () => {},
  onToggleReleaseNotes: () => {},
  onToggleFullContent: () => {},
  onUnsubscribe: () => {},
  onMarkAsRead: () => {},
  onMarkAssetAsRead: () => {},
  language: 'zh',
  formatFileSize: (bytes: number) => `${bytes} B`,
  ...props,
});

const renderCard = (props: Partial<Parameters<typeof ReleaseCard>[0]> = {}) => {
  return render(<ReleaseCard {...buildCardProps(props)} />);
};

describe('ReleaseCard asset updated indicator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Module-level store state is shared across tests: en set by English tests must not leak into subsequent tests
    storeState.language = 'zh';
  });

  it('shows container-level and per-asset indicators from the same source (updated_asset_ids)', () => {
    renderCard({ isUnread: true });
    // Both container-level and asset-level indicators are shown
    expect(screen.getAllByText('资产已更新')).toHaveLength(2);
  });

  it('shows no indicator once updated_asset_ids is cleared (release marked read)', () => {
    renderCard({
      isUnread: false,
      release: makeRelease(1, { updated_asset_ids: [] }),
    });
    expect(screen.queryByText('资产已更新')).not.toBeInTheDocument();
  });

  it('regression: asset updated_at newer than published_at alone shows no indicator', () => {
    // When makeRelease has an asset updated_at later than published_at, but updated_asset_ids is absent
    // (i.e. the asset has not changed since the last fetch), no "assets updated" indicator should appear.
    renderCard({
      isUnread: true,
      release: makeRelease(1, { updated_asset_ids: undefined }),
    });
    expect(screen.queryByText('资产已更新')).not.toBeInTheDocument();
  });

  it('does not show the indicator for assets without an asset id (source code links)', () => {
    renderCard({
      isUnread: true,
      release: makeRelease(1, { updated_asset_ids: [101] }),
      downloadLinks: [
        { name: 'Source code (v1.zip)', url: 'https://example.com/v1.zip', size: 0, downloadCount: 0 },
      ],
    });
    // Container indicator is still shown (updated_asset_ids is non-empty), but the source code row has no assetId, so no per-asset indicator is shown
    expect(screen.getAllByText('资产已更新')).toHaveLength(1);
  });

  it('marks only the clicked asset as read via onMarkAssetAsRead', () => {
    const onMarkAssetAsRead = vi.fn();
    renderCard({ onMarkAssetAsRead });

    const assetRow = screen.getByRole('button', { name: /app\.dmg/ });
    fireEvent.click(assetRow);

    expect(onMarkAssetAsRead).toHaveBeenCalledTimes(1);
    expect(onMarkAssetAsRead).toHaveBeenCalledWith(101);
  });

  it('regression: an RPC asset can be clicked again after a successful send', async () => {
    const { sendToRpcDownload } = await import('../services/rpcDownloadService');
    vi.mocked(sendToRpcDownload).mockResolvedValue({ success: true });

    renderCard({});
    const assetRow = screen.getByRole('button', { name: /app\.dmg/ });
    fireEvent.click(assetRow);

    await waitFor(() => expect(sendToRpcDownload).toHaveBeenCalledTimes(1));
    // Button must remain clickable after success (disabled only while download is in progress)
    await waitFor(() => expect(assetRow).not.toBeDisabled());

    fireEvent.click(assetRow);
    await waitFor(() => expect(sendToRpcDownload).toHaveBeenCalledTimes(2));
  });

  it('regression: a failed RPC retry clears the previous success check', async () => {
    const { sendToRpcDownload } = await import('../services/rpcDownloadService');
    const mocked = vi.mocked(sendToRpcDownload);
    mocked.mockReset();
    mocked.mockResolvedValueOnce({ success: true });
    mocked.mockResolvedValueOnce({ success: false, error: 'boom' });

    renderCard({});
    const assetRow = screen.getByRole('button', { name: /app\.dmg/ });
    fireEvent.click(assetRow);
    // Displays ✓ (CheckCircle2 with text-success) after initial success
    await waitFor(() => expect(assetRow.querySelector('.text-success')).not.toBeNull());

    fireEvent.click(assetRow);
    await waitFor(() => expect(mocked).toHaveBeenCalledTimes(2));
    // No stale ✓ should remain after a failed retry
    await waitFor(() => expect(assetRow.querySelector('.text-success')).toBeNull());
  });

  it('regression: a new asset version (same URL, new updatedAt) drops the stale success check', async () => {
    const { sendToRpcDownload } = await import('../services/rpcDownloadService');
    const mocked = vi.mocked(sendToRpcDownload);
    mocked.mockReset();
    mocked.mockResolvedValue({ success: true });
    const linkV1 = { name: 'app.dmg', url: 'https://example.com/app.dmg', size: 1000, downloadCount: 5, assetId: 101, updatedAt: '2026-01-02T00:00:00.000Z' };
    const linkV2 = { ...linkV1, updatedAt: '2026-02-01T00:00:00.000Z' };

    const view = renderCard({ downloadLinks: [linkV1] });
    fireEvent.click(screen.getByRole('button', { name: /app\.dmg/ }));
    await waitFor(() => expect(mocked).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /app\.dmg/ }).querySelector('.text-success')).not.toBeNull());

    // Same URL, new version: must not reuse the old key's ✓ and must still be sendable
    view.rerender(<ReleaseCard {...buildCardProps({ downloadLinks: [linkV2] })} />);
    const v2Row = screen.getByRole('button', { name: /app\.dmg/ });
    expect(v2Row.querySelector('.text-success')).toBeNull();

    fireEvent.click(v2Row);
    await waitFor(() => expect(mocked).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: /app\.dmg/ }).querySelector('.text-success')).not.toBeNull());
  });

  it('renders all five English header controls when body and download links exist', () => {
    storeState.language = 'en';
    renderCard({
      language: 'en',
      release: makeRelease(1, { body: 'release notes', updated_asset_ids: [101] }),
    });
    expect(screen.getByRole('button', { name: 'Hide Assets' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show Changelog' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'AI Summary of this update' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unsubscribe from releases' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View on GitHub' })).toBeInTheDocument();
  });

  it('renders relative times in Chinese (release header and asset row) when language is zh', () => {
    // Asset updated_at is 2026-01-02, earlier than current time; same for header effectiveTime.
    // Relative times will end with "... ago"
    renderCard({
      downloadLinks: [
        {
          name: 'app.dmg',
          url: 'https://example.com/app.dmg',
          size: 1000,
          downloadCount: 5,
          assetId: 101,
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
    });
    // Header (effectiveReleaseTime) and asset row each render one Chinese relative time
    expect(screen.getAllByText(/个月前|周前|天前|小时前|分钟前|年前/).length).toBe(2);
    const assetRow = screen.getByRole('button', { name: /app\.dmg/ });
    expect(within(assetRow).getByText(/前$/)).toBeInTheDocument();
  });

  it('hides the asset updated time when updated_at is missing', () => {
    renderCard({
      downloadLinks: [
        { name: 'app.dmg', url: 'https://example.com/app.dmg', size: 1000, downloadCount: 5, assetId: 101 },
      ],
    });
    // Header still contains Chinese relative time, so assert only on the absence within the asset row
    const assetRow = screen.getByRole('button', { name: /app\.dmg/ });
    expect(within(assetRow).queryByText(/前$/)).not.toBeInTheDocument();
  });

  it('hides the asset updated time when updated_at is invalid', () => {
    renderCard({
      downloadLinks: [
        { name: 'app.dmg', url: 'https://example.com/app.dmg', size: 1000, downloadCount: 5, assetId: 101, updatedAt: 'not-a-date' },
      ],
    });
    const assetRow = screen.getByRole('button', { name: /app\.dmg/ });
    expect(within(assetRow).queryByText(/前$/)).not.toBeInTheDocument();
  });

describe('ReleaseCard asset list filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Previous tests switch store language to en (module-level shared state); reset to zh here
    storeState.language = 'zh';
  });

  const links = [
    { name: 'app.dmg', url: 'https://example.com/app.dmg', size: 1000, downloadCount: 5, assetId: 101 },
    { name: 'app.exe', url: 'https://example.com/app.exe', size: 1000, downloadCount: 0, assetId: 102 },
    { name: 'app.AppImage', url: 'https://example.com/app.AppImage', size: 1000, downloadCount: 0, assetId: 103 },
  ];

  it('lists only the filtered assets and can reveal the rest via the show-all toggle', () => {
    renderCard({ downloadLinks: [links[0]], allDownloadLinks: links });

    expect(screen.getByText('app.dmg')).toBeInTheDocument();
    expect(screen.queryByText('app.exe')).not.toBeInTheDocument();
    expect(screen.queryByText('app.AppImage')).not.toBeInTheDocument();
    // Title count tracks visible assets
    expect(screen.getByText('(1)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '显示全部 3 个' }));
    expect(screen.getByText('app.exe')).toBeInTheDocument();
    expect(screen.getByText('app.AppImage')).toBeInTheDocument();
    expect(screen.getByText('(3)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '仅显示命中的 1 个' }));
    expect(screen.queryByText('app.exe')).not.toBeInTheDocument();
    expect(screen.getByText('(1)')).toBeInTheDocument();
  });

  it('falls back to the filtered list when the match set changes (filter switched or edited)', () => {
    const view = renderCard({ downloadLinks: [links[0]], allDownloadLinks: links });

    fireEvent.click(screen.getByRole('button', { name: '显示全部 3 个' }));
    expect(screen.getByText('app.exe')).toBeInTheDocument();

    // Filter switched or keywords edited (match set changed) -> auto-resets to "show matched assets only",
    // preventing stale expanded state from continuing to show unmatched files
    view.rerender(<ReleaseCard {...buildCardProps({ downloadLinks: [links[1]], allDownloadLinks: links })} />);
    expect(screen.queryByText('app.dmg')).not.toBeInTheDocument();
    expect(screen.getByText('app.exe')).toBeInTheDocument();
    expect(screen.queryByText('app.AppImage')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '显示全部 3 个' })).toBeInTheDocument();
  });

  it('renders every asset without a toggle when nothing was filtered out', () => {
    renderCard({ downloadLinks: links });

    expect(screen.getByText('app.dmg')).toBeInTheDocument();
    expect(screen.getByText('app.exe')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /显示全部/ })).not.toBeInTheDocument();
  });
});

});