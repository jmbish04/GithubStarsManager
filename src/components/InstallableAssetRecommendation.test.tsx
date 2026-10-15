import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Release, ReleaseAsset } from '../types';
import { InstallableAssetRecommendation } from './InstallableAssetRecommendation';
import { resolveDeviceArchitecture } from '../utils/deviceTarget';

// Only replace architecture detection; platform detection keeps real implementation (reads navigator, controlled in tests by stubDevicePlatform).
vi.mock('../utils/deviceTarget', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/deviceTarget')>();
  return { ...actual, resolveDeviceArchitecture: vi.fn() };
});

function asset(id: number, name: string, contentType = 'application/octet-stream'): ReleaseAsset {
  return {
    id,
    name,
    size: 1024 * id,
    download_count: 0,
    browser_download_url: `https://github.com/acme/alpha/releases/download/v1/${name}`,
    content_type: contentType,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function makeRelease(assets: ReleaseAsset[]): Release {
  return {
    id: 1,
    tag_name: 'v1.2.0',
    name: 'v1.2.0',
    body: null,
    published_at: '2026-08-01T00:00:00.000Z',
    html_url: 'https://github.com/acme/alpha/releases/tag/v1.2.0',
    assets,
    repository: { id: 1, full_name: 'acme/alpha', name: 'alpha' },
  };
}

/** Fix "current device" as Windows to avoid depending on jsdom UA string. */
function stubDevicePlatform(platform: string): void {
  Object.defineProperty(navigator, 'userAgentData', {
    value: { platform },
    configurable: true,
    writable: true,
  });
}

/** Clear all platform hints for "unknown platform" test cases. */
function stubUnknownDevice(): void {
  Object.defineProperty(navigator, 'userAgentData', { value: undefined, configurable: true });
  Object.defineProperty(navigator, 'platform', { value: 'Unknown', configurable: true });
  Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Unknown)', configurable: true });
}

beforeEach(() => {
  // Default: architecture detection immediately resolves to undefined ("unavailable")
  vi.mocked(resolveDeviceArchitecture).mockResolvedValue(undefined);
});

afterEach(() => {
  Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'userAgentData');
  vi.restoreAllMocks();
});

describe('InstallableAssetRecommendation', () => {
  it('recommends the best asset for current device and only downloads upon click', async () => {
    stubDevicePlatform('Windows');
    const onDownload = vi.fn();
    const user = userEvent.setup();
    render(
      <InstallableAssetRecommendation
        release={makeRelease([
          asset(42, 'App-1.2.0-x64-setup.exe'),
          asset(43, 'App-1.2.0-linux.AppImage'),
        ])}
        onDownload={onDownload}
      />,
    );

    // Never download or execute anything before being clicked
    expect(onDownload).not.toHaveBeenCalled();
    expect(screen.getByText('App-1.2.0-x64-setup.exe')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /下载此版本/ }));

    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onDownload).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: 42, isSourceCode: false }),
    );
  });

  it('does not claim installer is safe and points to manual asset list below', () => {
    stubDevicePlatform('Windows');
    render(
      <InstallableAssetRecommendation
        release={makeRelease([asset(1, 'App-x64-setup.exe')])}
        onDownload={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        '按文件名与 Release 元数据识别，未验证安装包安全性，也不会自动运行。你始终可以在下方资产列表中手动选择其他资产。',
      ),
    ).toBeInTheDocument();
    // Must never contain conclusions like "passed security verification"
    expect(screen.queryByText(/已通过安全|安全可靠|已验证安全/)).not.toBeInTheDocument();
  });

  it('does not render the block when there are no matching assets', () => {
    stubDevicePlatform('Windows');
    const { container } = render(
      <InstallableAssetRecommendation
        release={makeRelease([asset(1, 'App-1.2.0-linux.AppImage')])}
        onDownload={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('installable-asset-recommendation')).not.toBeInTheDocument();
  });

  it('does not render when only source code or metadata assets exist', () => {
    stubDevicePlatform('Windows');
    const { container } = render(
      <InstallableAssetRecommendation
        release={makeRelease([
          asset(1, 'Source code (v1.2.0).zip'),
          asset(2, 'checksums.txt'),
          asset(3, 'myapp-1.0.zip'),
        ])}
        onDownload={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('lists alternative candidates and explains what was excluded', async () => {
    stubDevicePlatform('Windows');
    const onDownload = vi.fn();
    const user = userEvent.setup();
    render(
      <InstallableAssetRecommendation
        release={makeRelease([
          asset(1, 'App-x64-setup.exe'),
          asset(2, 'App-win64-portable.7z'),
          asset(3, 'App-1.2.0.pdb'),
          asset(4, 'App-1.2.0.dmg'),
        ])}
        onDownload={onDownload}
      />,
    );

    expect(screen.getByText('其他可选资产（1）')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '下载' }));
    expect(onDownload).toHaveBeenCalledWith(expect.objectContaining({ assetId: 2 }));

    // Exclusion explanation explicitly names non-installable asset types so users know they did not disappear
    expect(screen.getByText(/调试符号/)).toBeInTheDocument();
    expect(screen.getByText(/其他平台\/架构/)).toBeInTheDocument();
  });

  it('lists candidates side by side without claiming "matches current device" when platform is unknown', () => {
    stubUnknownDevice();
    render(
      <InstallableAssetRecommendation
        release={makeRelease([asset(1, 'App-x64-setup.exe'), asset(2, 'App-universal.dmg')])}
        onDownload={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: '可安装候选' })).toBeInTheDocument();
    expect(screen.getByText('未识别出平台')).toBeInTheDocument();
    // When platform is unknown, candidates come from all platforms, so cannot claim to match current device
    expect(screen.queryByText('适配当前设备')).not.toBeInTheDocument();
    expect(screen.getByText('其他可选资产（1）')).toBeInTheDocument();
  });

  it('does not enable download before architecture detection completes', async () => {
    stubDevicePlatform('Windows');
    // Detection remains pending: simulate high-entropy hints not having returned yet
    vi.mocked(resolveDeviceArchitecture).mockReturnValue(new Promise(() => {}));
    const onDownload = vi.fn();
    const user = userEvent.setup();
    render(
      <InstallableAssetRecommendation
        release={makeRelease([
          asset(1, 'App-x64-setup.exe'),
          asset(2, 'App-win64-portable.7z'),
        ])}
        onDownload={onDownload}
      />,
    );

    // Download cannot be enabled yet; otherwise an arm64 device might download an x64 package before detection finishes
    const primary = screen.getByRole('button', { name: /下载此版本/ });
    expect(primary).toBeDisabled();
    expect(screen.getByRole('button', { name: '下载' })).toBeDisabled();
    expect(screen.getByText('正在识别架构…')).toBeInTheDocument();

    await user.click(primary);
    expect(onDownload).not.toHaveBeenCalled();
  });

  it('re-enables download once architecture detection completes', async () => {
    stubDevicePlatform('Windows');
    vi.mocked(resolveDeviceArchitecture).mockResolvedValue('arm64');
    const onDownload = vi.fn();
    const user = userEvent.setup();
    render(
      <InstallableAssetRecommendation
        release={makeRelease([asset(7, 'App-arm64-setup.exe')])}
        onDownload={onDownload}
      />,
    );

    // Detection is asynchronous: button becomes available only after settlement
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /下载此版本/ })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: /下载此版本/ }));
    expect(onDownload).toHaveBeenCalledWith(expect.objectContaining({ assetId: 7 }));
  });

  it('disables candidate download buttons when download is sending or sent', async () => {
    stubDevicePlatform('Windows');
    const release = makeRelease([
      asset(1, 'App-x64-setup.exe'),
      asset(2, 'App-win64-portable.7z'),
    ]);
    const firstUrl = release.assets[0].browser_download_url;
    const secondUrl = release.assets[1].browser_download_url;

    render(
      <InstallableAssetRecommendation
        release={release}
        downloadStates={{
          [`${firstUrl}@${release.assets[0].updated_at}`]: 'sending',
          [`${secondUrl}@${release.assets[1].updated_at}`]: 'sent',
        }}
        onDownload={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /下载此版本/ })).toBeDisabled(),
    );
    expect(screen.getByRole('button', { name: '下载' })).toBeDisabled();
  });
});
