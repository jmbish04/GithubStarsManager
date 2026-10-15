import { describe, it, expect } from 'vitest';
import type { ReleaseAsset } from '../types';
import {
  detectInstallableAssets,
  hasInstallableAsset,
} from './installableAssets';

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

const WINDOWS_DEVICE = { platform: 'windows', architecture: 'x64' } as const;

describe('detectInstallableAssets — platform and package type', () => {
  it('identifies a Windows installer with its architecture as high confidence', () => {
    const result = detectInstallableAssets([asset(1, 'App-1.2.0-x64-setup.exe')], WINDOWS_DEVICE);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      assetId: 1,
      platform: 'windows',
      architecture: 'x64',
      packageType: 'exe',
      confidence: 'high',
    });
    expect(result.matches[0].downloadUrl).toContain('App-1.2.0-x64-setup.exe');
    expect(result.matches[0].reason).toContain('Windows');
  });

  it('downgrades confidence when the installer does not declare an architecture', () => {
    // Decisive extension establishes the platform, but architecture is omitted -> medium confidence without guessing.
    const result = detectInstallableAssets([asset(1, 'App-1.2.0-setup.exe')], WINDOWS_DEVICE);

    expect(result.matches[0]).toMatchObject({
      platform: 'windows',
      packageType: 'exe',
      confidence: 'medium',
    });
    expect(result.matches[0].architecture).toBeUndefined();
    expect(result.matches[0].reason).toContain('architecture not declared');
  });

  it('recognises a macOS universal build', () => {
    const result = detectInstallableAssets(
      [asset(1, 'App-1.2.0-universal.dmg', 'application/x-apple-diskimage')],
      { platform: 'macos', architecture: 'arm64' },
    );

    expect(result.matches[0]).toMatchObject({
      platform: 'macos',
      architecture: 'universal',
      packageType: 'dmg',
      confidence: 'high',
    });
  });

  it('recognises a Linux AppImage built for x86_64', () => {
    const result = detectInstallableAssets([asset(1, 'app-1.2.0-linux-x86_64.AppImage')], {
      platform: 'linux',
      architecture: 'x64',
    });

    expect(result.matches[0]).toMatchObject({
      platform: 'linux',
      architecture: 'x64',
      packageType: 'appimage',
      confidence: 'high',
    });
  });

  it('recognises a Windows portable 7z by filename platform token', () => {
    const result = detectInstallableAssets([asset(1, 'App_win64_portable.7z')], WINDOWS_DEVICE);

    expect(result.matches[0]).toMatchObject({
      platform: 'windows',
      architecture: 'x64',
      packageType: '7z',
      confidence: 'medium',
    });
  });

  it('recognises an Android APK from the decisive extension', () => {
    const result = detectInstallableAssets([asset(1, 'app-1.2.0.apk')], { platform: 'android' });
    expect(result.matches[0]).toMatchObject({ platform: 'android', packageType: 'apk' });
  });

  it('never treats win32 as a 32-bit architecture marker', () => {
    // Electron uses win32 for Windows builds; it is a platform name, not an x86 indicator.
    const result = detectInstallableAssets([asset(1, 'app-win32.zip')], WINDOWS_DEVICE);
    expect(result.matches[0].architecture).toBeUndefined();
  });

  it('keeps a 32-bit Windows installer as a lower-confidence compatibility fallback', () => {
    const result = detectInstallableAssets([asset(1, 'App-1.2.0-x86-setup.exe')], WINDOWS_DEVICE);

    expect(result.matches[0]).toMatchObject({
      architecture: 'x86',
      confidence: 'medium',
    });
  });
});

describe('detectInstallableAssets — excluding non-installable assets', () => {
  it.each([
    ['Source code (v1.2.0).zip', 'source code archive'],
    ['app-1.2.0.exe.sha256', 'checksum file'],
    ['app-1.2.0-setup.exe.sig', 'signature file'],
    ['app-1.2.0.pdb', 'debug symbols'],
    ['App-1.2.0-setup.exe.blockmap', 'electron blockmap'],
    ['App-win-x64.pdb.zip', 'debug symbols'],
    ['App-win-x64.sig.zip', 'signature file'],
    ['App-win-x64.blockmap.zip', 'electron blockmap'],
    ['app-1.2.0.sbom.json', 'software bill of materials'],
  ])('excludes %s', (name, expectedReason) => {
    const result = detectInstallableAssets([asset(1, name)], WINDOWS_DEVICE);

    expect(result.matches).toEqual([]);
    expect(result.excluded).toEqual([{ assetId: 1, fileName: name, reason: expectedReason }]);
  });

  it('does not treat a bare portable archive as installable software', () => {
    const result = detectInstallableAssets([asset(1, 'myapp-1.0.zip')], WINDOWS_DEVICE);

    expect(result.matches).toEqual([]);
    expect(result.excluded[0].reason).toBe('portable archive without a declared target platform');
  });

  it('does not discard an installer merely because its build name contains debug', () => {
    const result = detectInstallableAssets([asset(1, 'App-1.2.0-debug-x64-setup.exe')], WINDOWS_DEVICE);
    expect(result.matches).toHaveLength(1);
  });

  it('keeps unsupported package formats out of the candidates', () => {
    const result = detectInstallableAssets(
      [asset(1, 'app-1.0.pkg.tar.zst'), asset(2, 'app-1.0.nupkg')],
      { platform: 'linux' },
    );

    expect(result.matches).toEqual([]);
    expect(result.excluded.map((entry) => entry.reason)).toEqual([
      'not a supported installable package format',
      'not a supported installable package format',
    ]);
  });

  it('refuses names that declare conflicting platforms', () => {
    const result = detectInstallableAssets([asset(1, 'project-win32-linux-x64.zip')], WINDOWS_DEVICE);

    expect(result.matches).toEqual([]);
    expect(result.excluded[0].reason).toContain('multiple platforms');
  });

  it('refuses an asset whose extension contradicts its filename', () => {
    const result = detectInstallableAssets([asset(1, 'app-1.2.0-linux.dmg')], { platform: 'macos' });

    expect(result.matches).toEqual([]);
    expect(result.excluded[0].reason).toContain('package extension targets macos');
  });

  it('excludes other-platform assets but says why', () => {
    const result = detectInstallableAssets(
      [asset(1, 'app-1.2.0.deb'), asset(2, 'App-1.2.0-setup.exe')],
      WINDOWS_DEVICE,
    );

    expect(result.matches.map((match) => match.assetId)).toEqual([2]);
    expect(result.excluded[0]).toMatchObject({ assetId: 1 });
    expect(result.excluded[0].reason).toBe('targets linux, this device is windows');
  });

  it('excludes a conflicting architecture when the device architecture is known', () => {
    const result = detectInstallableAssets(
      [asset(1, 'App-1.2.0-arm64.dmg'), asset(2, 'App-1.2.0-x64.dmg'), asset(3, 'App-1.2.0.dmg')],
      { platform: 'macos', architecture: 'x64' },
    );

    expect(result.matches.map((match) => match.assetId)).toEqual([2, 3]);
    expect(result.excluded[0]).toMatchObject({ assetId: 1 });
    expect(result.excluded[0].reason).toBe('targets arm64, this device is x64');
  });

  it('keeps universal builds for every device architecture', () => {
    const result = detectInstallableAssets(
      [asset(1, 'App-1.2.0-universal.dmg')],
      { platform: 'macos', architecture: 'x64' },
    );
    expect(result.matches).toHaveLength(1);
  });
});

describe('detectInstallableAssets — concurrent candidates when uncertain', () => {
  it('keeps every architecture when the device architecture is unknown', () => {
    const result = detectInstallableAssets(
      [asset(1, 'App-x64.dmg'), asset(2, 'App-arm64.dmg')],
      { platform: 'macos' },
    );

    expect(result.matches.map((match) => match.assetId)).toEqual([1, 2]);
    expect(result.matches.every((match) => match.confidence === 'high')).toBe(true);
  });

  it('returns candidates for every platform when no target platform is given', () => {
    const result = detectInstallableAssets([
      asset(1, 'App-setup.exe'),
      asset(2, 'App-x86_64.AppImage'),
      asset(3, 'App-universal.dmg'),
    ]);

    expect(result.matches.map((match) => match.platform).sort()).toEqual([
      'linux',
      'macos',
      'windows',
    ]);
  });

  it('orders candidates by confidence, then architecture fit, then asset id', () => {
    const result = detectInstallableAssets(
      [
        asset(5, 'App-win64-portable.7z'), // medium (container + known x64 architecture)
        asset(2, 'App-arm64-setup.exe'), // Excluded: architecture conflict
        asset(3, 'App-setup.exe'), // medium (decisive extension, but architecture undeclared)
        asset(1, 'App-x64-setup.exe'), // high + exact architecture -> first
      ],
      WINDOWS_DEVICE,
    );

    // When both are medium, item 5 (declaring x64) precedes item 3 (unknown architecture).
    expect(result.matches.map((match) => match.assetId)).toEqual([1, 5, 3]);
    expect(result.matches.map((match) => match.confidence)).toEqual(['high', 'medium', 'medium']);
    expect(result.excluded.map((entry) => entry.assetId)).toEqual([2]);
  });

  it('excludes an asset that declares multiple architectures', () => {
    const result = detectInstallableAssets([asset(1, 'App-x64-arm64-setup.exe')], {
      platform: 'windows',
    });

    expect(result.matches).toHaveLength(0);
    expect(result.excluded).toEqual([
      expect.objectContaining({ assetId: 1, reason: 'declares multiple architectures' }),
    ]);
  });
});

describe('detectInstallableAssets — Android AAB detect-only', () => {
  it('excludes AAB from installable candidates by default', () => {
    const result = detectInstallableAssets([asset(1, 'app-1.2.0.aab')], { platform: 'android' });

    expect(result.matches).toEqual([]);
    expect(result.excluded[0].reason).toContain('detect-only');
  });

  it('recognises AAB when explicitly asked to include detect-only assets', () => {
    const result = detectInstallableAssets([asset(1, 'app-1.2.0.aab')], {
      platform: 'android',
      includeDetectOnly: true,
    });

    expect(result.matches[0]).toMatchObject({ platform: 'android', packageType: 'aab' });
    expect(result.matches[0].reason).toContain('detect only');
  });
});

describe('detectInstallableAssets — boundaries and non-goals', () => {
  it('never claims an asset is safe', () => {
    const result = detectInstallableAssets([asset(1, 'App-x64-setup.exe')], WINDOWS_DEVICE);
    expect(result.matches[0].reason.toLowerCase()).not.toContain('safe');
  });

  it('ignores nameless assets instead of throwing', () => {
    const nameless = { ...asset(1, 'App-x64-setup.exe'), name: '' };
    expect(detectInstallableAssets([nameless], WINDOWS_DEVICE).matches).toEqual([]);
  });

  it('handles missing asset lists', () => {
    expect(detectInstallableAssets(undefined, WINDOWS_DEVICE)).toEqual({ matches: [], excluded: [] });
  });

  it('falls back to the MIME type when the filename carries no platform signal', () => {
    const result = detectInstallableAssets([asset(1, 'app-1.2.0.tar.gz', 'application/x-deb')], {
      platform: 'linux',
    });

    expect(result.matches[0]).toMatchObject({ platform: 'linux', packageType: 'tar.gz' });
  });
});

describe('hasInstallableAsset', () => {
  it('answers the repository-level question without exposing candidates', () => {
    expect(hasInstallableAsset([asset(1, 'App-x64-setup.exe')], WINDOWS_DEVICE)).toBe(true);
    expect(hasInstallableAsset([asset(1, 'App-x64-setup.exe')], { platform: 'linux' })).toBe(false);
    expect(hasInstallableAsset([], WINDOWS_DEVICE)).toBe(false);
  });
});
