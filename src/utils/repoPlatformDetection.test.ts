import { describe, expect, it } from 'vitest';
import { inferPlatformsFromReleases, inferPlatformsFromRepositoryMetadata, resolveRepositoryPlatforms } from './repoPlatformDetection';
import type { Release, Repository } from '../types';

const makeAsset = (name: string, contentType = 'application/octet-stream') => ({
  id: 1,
  name,
  size: 1000,
  download_count: 0,
  browser_download_url: `https://example.com/${name}`,
  content_type: contentType,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
});

const makeRelease = (
  assets: string[],
  publishedAt = '2026-01-01T00:00:00.000Z',
): Pick<Release, 'repository' | 'assets' | 'published_at'> => ({
  repository: { id: 1, full_name: 'owner/app', name: 'app' },
  published_at: publishedAt,
  assets: assets.map((name) => makeAsset(name)),
});

const makeRepo = (overrides: Partial<Repository> = {}): Repository => ({
  id: 1,
  name: 'app',
  full_name: 'owner/app',
  description: null,
  html_url: 'https://github.com/owner/app',
  stargazers_count: 1,
  forks_count: 0,
  forks: 0,
  language: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  pushed_at: '2026-01-01T00:00:00.000Z',
  owner: { login: 'owner', avatar_url: '' },
  topics: [],
  ...overrides,
});

describe('inferPlatformsFromReleases', () => {
  it('counts each platform once per release and weights by release count', () => {
    const signals = inferPlatformsFromReleases([
      makeRelease(['app-arm64.dmg', 'app-x64.dmg', 'setup.exe']), // macos + windows
      makeRelease(['app.tar.gz', 'app-linux.tar.gz'], '2025-12-01T00:00:00.000Z'), // linux only (.tar.gz without OS token does not count as macos)
    ]);
    const byPlatform = Object.fromEntries(signals.map(s => [s.platform, s.weight]));
    expect(byPlatform.macos).toBe(10); // Multiple dmgs in a single release count only once
    expect(byPlatform.windows).toBe(10);
    expect(byPlatform.linux).toBe(10);
    expect(signals.every(s => s.source === 'release-assets')).toBe(true);
  });

  it('only considers the most recent releases', () => {
    const oldRelease = makeRelease(['app.exe'], '2020-01-01T00:00:00.000Z');
    const newReleases = Array.from({ length: 10 }, (_, i) =>
      makeRelease(['app.dmg'], `2026-${String(i + 1).padStart(2, '0')}-01T00:00:00.000Z`));
    const signals = inferPlatformsFromReleases([oldRelease, ...newReleases]);
    // 10 new releases are all macos; the oldest windows release is truncated
    expect(signals).toHaveLength(1);
    expect(signals[0].platform).toBe('macos');
    expect(signals[0].weight).toBe(100);
  });

  it('returns nothing when assets carry no platform signal', () => {
    expect(inferPlatformsFromReleases([makeRelease(['checksums.txt', 'Source code (v1.0).zip'])])).toEqual([]);
  });
});

describe('inferPlatformsFromRepositoryMetadata', () => {
  it('maps topics to platforms at topic weight', () => {
    const signals = inferPlatformsFromRepositoryMetadata(makeRepo({ topics: ['cross-platform', 'terminal'] }));
    const byPlatform = Object.fromEntries(signals.map(s => [s.platform, s.weight]));
    expect(byPlatform.macos).toBe(4);
    expect(byPlatform.windows).toBe(4);
    expect(byPlatform.linux).toBe(4);
    expect(byPlatform.cli).toBe(4);
  });

  it('matches the first OS word in the description without substring false positives', () => {
    const signals = inferPlatformsFromRepositoryMetadata(
      makeRepo({ description: 'A fast terminal emulator with a search-friendly UI for macOS' }),
    );
    expect(signals).toEqual([{ platform: 'macos', weight: 2, source: 'description' }]);
    expect(inferPlatformsFromRepositoryMetadata(makeRepo({ description: 'Search and archive anything' }))).toEqual([]);
  });

  it('maps the primary language as a weak signal', () => {
    const signals = inferPlatformsFromRepositoryMetadata(makeRepo({ language: 'Swift' }));
    expect(signals).toEqual([
      { platform: 'macos', weight: 2, source: 'languages' },
      { platform: 'ios', weight: 2, source: 'languages' },
    ]);
  });
});

describe('resolveRepositoryPlatforms', () => {
  it('prefers deterministic signals and orders them canonically', () => {
    const platforms = resolveRepositoryPlatforms(
      makeRepo({ language: 'Kotlin' }),
      [makeRelease(['app.apk', 'setup.exe'])],
    );
    expect(platforms).toEqual(['windows', 'android']);
  });

  it('combines weak signals to cross the display threshold', () => {
    // language(2) + description(2) = 4, exactly meeting the threshold
    const platforms = resolveRepositoryPlatforms(
      makeRepo({ language: 'Kotlin', description: 'An Android toolkit' }),
      [],
    );
    expect(platforms).toEqual(['android']);
  });

  it('keeps language-only hints below the threshold and falls back to ai_platforms', () => {
    const platforms = resolveRepositoryPlatforms(
      makeRepo({ language: 'Kotlin', ai_platforms: ['mac'] }),
      [],
    );
    expect(platforms).toEqual(['mac']);
  });

  it('returns an empty list when there is no signal at all', () => {
    expect(resolveRepositoryPlatforms(makeRepo(), [])).toEqual([]);
  });

  it('regression: only counts releases of the same repository (no cross-repo bleed)', () => {
    const repoA = makeRepo({ id: 1, full_name: 'owner/a', name: 'a' });
    const repoB = makeRepo({ id: 2, full_name: 'owner/b', name: 'b' });
    const releaseFor = (repo: Repository, names: string[]) => ({
      ...makeRelease(names),
      repository: { id: repo.id, full_name: repo.full_name, name: repo.name },
    });

    const releases = [
      releaseFor(repoA, ['app.dmg']),
      releaseFor(repoB, ['setup.exe', 'app.apk']),
    ];

    // Repo A's list comes only from A's assets; Repo B's windows/android must not bleed over
    expect(resolveRepositoryPlatforms(repoA, releases)).toEqual(['macos']);
    expect(resolveRepositoryPlatforms(repoB, releases)).toEqual(['windows', 'android']);
  });
});
