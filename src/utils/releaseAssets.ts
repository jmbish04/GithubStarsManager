import type { Release, ReleaseAsset } from '../types';

/**
 * Computes a fingerprint for a single asset.
 * Asset fingerprints are used to detect whether release asset content has changed.
 * Rationale: when GitHub assets are replaced or re-uploaded, `updated_at` updates; `size` acts as fallback
 * covering the edge case where size changes within the same timestamp.
 * Note: `download_count` is volatile metadata (+1 with each download); including it would cause
 * the fingerprint to change between refreshes, breaking the incremental "short-circuit on no change" logic.
 */
export function assetFingerprint(asset: ReleaseAsset): string {
  return [asset.id, asset.updated_at, asset.size].join(':');
}

/**
 * Computes a stable fingerprint for a list of assets.
 * Sorts assets stably (by id) before serializing each to ensure idempotency:
 * - Same set of assets yields identical fingerprint regardless of ordering;
 * - Unchanged assets keep fingerprint unchanged, allowing short-circuiting (avoiding store/backend writes).
 */
export function assetsFingerprint(assets: ReleaseAsset[] | undefined): string {
  if (!Array.isArray(assets) || assets.length === 0) return '';
  const sorted = [...assets].sort((a, b) => a.id - b.id);
  return sorted.map(assetFingerprint).join('|');
}

/**
 * Determines whether the fingerprints of two asset lists match (i.e. whether assets changed).
 * Used during incremental refresh to determine if existing release assets need updating.
 */
export function hasAssetsChanged(
  current: ReleaseAsset[] | undefined,
  incoming: ReleaseAsset[] | undefined
): boolean {
  return assetsFingerprint(current) !== assetsFingerprint(incoming);
}

/**
 * Returns IDs of assets that are newly added or changed relative to the local asset set.
 * Deleted assets have no visible row to render, so they are not included in the return value;
 * deletions are still detected by hasAssetsChanged to trigger a full release update.
 */
export function changedAssetIds(
  current: ReleaseAsset[] | undefined,
  incoming: ReleaseAsset[] | undefined,
): number[] {
  const currentById = new Map((current || []).map(asset => [asset.id, asset]));
  return (incoming || [])
    .filter(asset => {
      const previous = currentById.get(asset.id);
      return !previous || assetFingerprint(previous) !== assetFingerprint(asset);
    })
    .map(asset => asset.id);
}

/**
 * Filters freshly fetched releases to find entries changed relative to local state.
 * Only compares releases whose IDs already exist locally (new entries are handled by caller's addReleases);
 * triggers when asset fingerprint changes OR release metadata (body/name/tag_name) changes:
 * incremental sync only fetches new releases by published_at watermark. If an existing release had an empty body
 * during initial sync (or upstream added release notes later), it would never update, causing missing changelog/summary buttons.
 * The full object of the latest release is re-fetched on every refresh, so checking body here allows backfilling empty logs.
 * Skips unchanged entries to guarantee idempotency and avoid duplicate store/backend writes.
 * Reused by refresh entry points (ReleaseTimeline.handleRefresh) and tests.
 */
export function findReleasesWithChangedAssets(
  latestReleases: Release[] | undefined,
  currentReleases: Release[]
): Release[] {
  const byId = new Map(currentReleases.map(r => [r.id, r]));
  return (latestReleases || []).flatMap((latest) => {
    const local = byId.get(latest.id);
    if (!local) return [];
    const assetsChanged = hasAssetsChanged(local.assets, latest.assets);
    // body can be null/'': normalize to empty string comparison to avoid null vs '' churn;
    // name follows the same display rule as the API layer (`name || tag_name`): legacy backend data
    // may store null for name, while remote objects fall back to tag_name after mapping.
    // Direct raw value comparison would misidentify all null-name records on first refresh after upgrade,
    // triggering upserts and resetting read status.
    const bodyChanged = (local.body ?? '') !== (latest.body ?? '');
    const localDisplayName = local.name || local.tag_name;
    const latestDisplayName = latest.name || latest.tag_name;
    const metaChanged =
      localDisplayName !== latestDisplayName || local.tag_name !== latest.tag_name;
    if (!assetsChanged && !bodyChanged && !metaChanged) return [];

    return [{
      ...latest,
      updated_asset_ids: changedAssetIds(local.assets, latest.assets),
    }];
  });
}

/**
 * Computes effective display timestamp for a release.
 * GitHub release objects lack updated_at, and published_at does not change when assets change;
 * asset update time is included in assets[].updated_at (updated on every replace/re-upload).
 * Takes the later of published_at and any asset updated_at as the user-visible update timestamp.
 * Returns normalized ISO string (toISOString) ensuring stable comparisons across formats.
 */
export function effectiveReleaseTime(release: Pick<Release, 'published_at' | 'assets'>): string {
  let latest = new Date(release.published_at).getTime();
  if (Array.isArray(release.assets)) {
    for (const asset of release.assets) {
      const assetTime = new Date(asset.updated_at).getTime();
      if (!Number.isNaN(assetTime) && assetTime > latest) {
        latest = assetTime;
      }
    }
  }
  return new Date(latest).toISOString();
}

/**
 * Finds the entry with the most recent effective update time in a set of releases.
 *
 * Repository category view displays multiple releases, but the repository container update time
 * should reflect the latest release publish time or asset update time among all visible entries,
 * rather than only looking at the latest published version.
 * Skips entries with invalid publish times to avoid broken records blocking repository grouping render.
 */
export function latestEffectiveRelease<T extends Pick<Release, 'published_at' | 'assets'>>(
  releases: readonly T[],
): T | null {
  let latestRelease: T | null = null;
  let latestTime = -Infinity;

  for (const release of releases) {
    if (Number.isNaN(new Date(release.published_at).getTime())) {
      continue;
    }

    const effectiveTime = new Date(effectiveReleaseTime(release)).getTime();
    if (!Number.isNaN(effectiveTime) && effectiveTime > latestTime) {
      latestRelease = release;
      latestTime = effectiveTime;
    }
  }

  return latestRelease;
}

/**
 * Determines whether a release container should display the "assets updated" badge.
 *
 * The single source of truth is `updated_asset_ids`: it is written by findReleasesWithChangedAssets
 * only when incremental refresh detects asset changes relative to last fetch, and cleared as the user
 * clicks individual assets or the release.
 * Do not infer this from "asset updated_at is later than published_at" — assets on GitHub are almost always
 * uploaded after release creation, making that condition constantly true for most releases, resulting in widespread false positives.
 */
export function shouldShowAssetsUpdatedIndicator(
  release: Pick<Release, 'updated_asset_ids'>
): boolean {
  return (release.updated_asset_ids?.length ?? 0) > 0;
}

/**
 * Target platform for an asset (matches platform keys in platformMeta for direct brand icon retrieval).
 */
export type AssetPlatform = 'macos' | 'windows' | 'linux' | 'android' | 'ios' | 'docker';

/**
 * Platform inference rules (detectAssetPlatform) evaluated across four layers in order:
 *
 * 1. Decisive extension — package/package-manager formats exclusive to a single platform:
 *    .dmg/.pkg/.app.tar.gz (macOS), .exe/.msi/.msix/.appx (Windows),
 *    .AppImage/.deb/.rpm/.snap/.flatpak/.pkg.tar.zst (Arch) (Linux),
 *    .apk/.aab (Android), .ipa (iOS).
 *    Note: extensions match by length descending: '.pkg.tar.zst' must be checked before '.pkg',
 *    otherwise Arch packages would be misidentified as macOS.
 * 2. Filename OS semantic token — covers conventions like GoReleaser ({name}-{os}-{arch}),
 *    Rust target triples (x86_64-pc-windows-msvc, aarch64-apple-darwin), etc.
 *    Tokenizes by non-alphanumeric characters then looks up dictionary, e.g.:
 *    'alist-darwin-arm64.tar.gz' -> [alist, darwin, arm64, tar, gz] -> darwin -> macos.
 *    Applies equally to bare binaries (without extension); when multiple OS tokens appear, takes the earliest
 *    (in naming conventions, OS segment immediately follows product name).
 *    Dictionary uses exact word matches rather than substrings, naturally avoiding 'win' in 'darwin' or 'arch' in 'search/archive'.
 * 3. Architecture tokens (arm64/aarch64/x86_64/amd64/mips…) are cross-platform and excluded from platform detection —
 *    a macOS aarch64 package and a Linux aarch64 package differ only by OS segment.
 * 4. MIME type fallback (GitHub often sets application/octet-stream for binaries;
 *    only takes effect when filename provides no clue and content_type has clear platform semantics).
 *
 * Returns null if all fail: BSD (freebsd etc.) is deliberately not mapped to Linux.
 */

/** OS semantic dictionary: token -> platform. */
export const OS_TOKEN_PLATFORM: Record<string, AssetPlatform> = {
  // macOS (including legacy osx and kernel name darwin)
  macos: 'macos', mac: 'macos', osx: 'macos', darwin: 'macos', apple: 'macos',
  // Windows (win32/win64 common in C++ ecosystem; mingw is its toolchain)
  windows: 'windows', win: 'windows', win32: 'windows', win64: 'windows', mingw: 'windows',
  // Linux (distributions and libc variants: alpine/musl only appear in Linux ecosystem)
  linux: 'linux', ubuntu: 'linux', debian: 'linux', fedora: 'linux', redhat: 'linux',
  archlinux: 'linux', arch: 'linux', manjaro: 'linux', alpine: 'linux', musl: 'linux',
  raspberrypi: 'linux', raspbian: 'linux', nixos: 'linux',
  // Mobile
  android: 'android',
  ios: 'ios', ipados: 'ios', iphone: 'ios',
  // Container images (tar exported by docker save, etc.)
  docker: 'docker',
};

/** Decisive extensions -> platform; matched with endsWith in descending suffix length order. */
const PLATFORM_EXTENSIONS: ReadonlyArray<readonly [suffix: string, platform: AssetPlatform]> = ([
  ['.app.tar.gz', 'macos'], ['.app.zip', 'macos'],
  ['.dmg', 'macos'], ['.pkg', 'macos'],
  ['.exe', 'windows'], ['.msi', 'windows'], ['.msix', 'windows'],
  ['.appx', 'windows'], ['.appxbundle', 'windows'],
  ['.appinstaller', 'windows'], ['.msibundle', 'windows'],
  ['.appimage', 'linux'], ['.flatpak', 'linux'], ['.snap', 'linux'],
  ['.deb', 'linux'], ['.rpm', 'linux'],
  ['.pkg.tar.zst', 'linux'], ['.pkg.tar.xz', 'linux'],
  ['.apk', 'android'], ['.aab', 'android'], ['.apks', 'android'],
  ['.ipa', 'ios'],
] as Array<[string, AssetPlatform]>).sort((a, b) => b[0].length - a[0].length);

/** Platform semantic fragments in content_type -> platform. */
const CONTENT_TYPE_PLATFORM: ReadonlyArray<readonly [pattern: RegExp, platform: AssetPlatform]> = [
  [/android\.package-archive/, 'android'],
  [/apple-diskimage/, 'macos'],
  [/x-msdownload|x-msi|x-ms-installer/, 'windows'],
  [/x-deb|redhat-package-manager|x-rpm/, 'linux'],
];

/** Splits filename into lowercase semantic tokens, delimited by non-alphanumeric characters. */
function tokenize(name: string): string[] {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Infers target platform based on asset filename (and optional content_type).
 * See AssetPlatform comments above for layered rules. Returns null when unidentifiable;
 * callers should hide platform badges rather than guessing.
 */
export function detectAssetPlatform(fileName: string, contentType?: string): AssetPlatform | null {
  const name = fileName.toLowerCase();

  // Layer 1: Decisive extension (longest suffix prioritized to prevent .pkg consuming .pkg.tar.zst)
  for (const [suffix, platform] of PLATFORM_EXTENSIONS) {
    if (name.endsWith(suffix)) {
      return platform;
    }
  }

  // Layer 2: Filename OS semantic token (applies to bare binaries; multiple OS tokens pick earliest)
  const tokens = tokenize(fileName);
  for (let i = 0; i < tokens.length; i++) {
    const platform = OS_TOKEN_PLATFORM[tokens[i]];
    if (platform) {
      return platform;
    }
  }

  // Layer 3/4: MIME fallback (architecture tokens not considered)
  if (contentType) {
    const type = contentType.toLowerCase();
    for (const [pattern, platform] of CONTENT_TYPE_PLATFORM) {
      if (pattern.test(type)) {
        return platform;
      }
    }
  }

  return null;
}
