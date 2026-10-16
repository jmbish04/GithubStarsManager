/**
 * Installable Asset Detection — Determines which assets in a release can be installed on the current device.
 *
 * Reuse vs. new code boundaries:
 * - Reuse: Platform detection directly calls `detectAssetPlatform` and its exported `OS_TOKEN_PLATFORM` from `./releaseAssets.ts` rather than duplicating the platform vocabulary.
 * - New additions: Architecture dictionary, package type table, exclusion rules, and confidence model. The only other architecture vocabulary in the repo is in `examples/plugins/smart-release-recommender/worker.js`, which is a sandboxed third-party plugin reference implementation that `src/` cannot import (plugins also cannot depend inversely on Core). Therefore, a host-side implementation must live here, with references noted below.
 * - Non-reuse: `PRESET_FILTERS` (../constants/presetFilters.ts) is not reused because it classifies `zip` / `tar.gz` under Source and uses naive substring matching (`win` matching `darwin`), conflicting with installable software detection goals.
 *
 * Boundaries (roadmap §5.3): Detection only, no execution; does not assert package safety; lists multiple candidates when uncertain; users can always manually choose other assets in the asset sheet.
 */
import type { ReleaseAsset } from '../types';
import type {
  InstallableArchitecture,
  InstallableAsset,
  InstallableAssetDetectionOptions,
  InstallableAssetDetectionResult,
  InstallableConfidence,
  InstallablePackageType,
  InstallablePlatform,
} from '../types/installableAsset';
import { detectAssetPlatform, OS_TOKEN_PLATFORM, type AssetPlatform } from './releaseAssets';

/** Supported target platforms for this stage; 'ios' and 'docker' do not fall within "installable on the current device". */
const INSTALLABLE_PLATFORMS: readonly InstallablePlatform[] = ['windows', 'macos', 'linux', 'android'];

function toInstallablePlatform(platform: AssetPlatform | null): InstallablePlatform | null {
  return platform && (INSTALLABLE_PLATFORMS as readonly string[]).includes(platform)
    ? (platform as InstallablePlatform)
    : null;
}

/**
 * Package type table: extension -> package type + whether this extension decisively determines the platform.
 *
 * Matches extensions in descending length order (the layered comments in `detectAssetPlatform` explain why longer extensions must precede shorter ones).
 * Container formats (zip/7z/tar.gz) with `decisivePlatform: null` only describe how to install, not where to install; platform resolution is delegated to OS tokens in the filename.
 */
interface PackageTypeEntry {
  suffix: string;
  packageType: InstallablePackageType;
  decisivePlatform: InstallablePlatform | null;
  /** Android App Bundles can only be detected, not recommended for direct installation. */
  detectOnly?: boolean;
}

const PACKAGE_TYPE_ENTRIES: PackageTypeEntry[] = [
  { suffix: '.appimage', packageType: 'appimage', decisivePlatform: 'linux' },
  { suffix: '.tar.gz', packageType: 'tar.gz', decisivePlatform: null },
  { suffix: '.msi', packageType: 'msi', decisivePlatform: 'windows' },
  { suffix: '.exe', packageType: 'exe', decisivePlatform: 'windows' },
  { suffix: '.dmg', packageType: 'dmg', decisivePlatform: 'macos' },
  { suffix: '.pkg', packageType: 'pkg', decisivePlatform: 'macos' },
  { suffix: '.deb', packageType: 'deb', decisivePlatform: 'linux' },
  { suffix: '.rpm', packageType: 'rpm', decisivePlatform: 'linux' },
  { suffix: '.apk', packageType: 'apk', decisivePlatform: 'android' },
  { suffix: '.aab', packageType: 'aab', decisivePlatform: 'android', detectOnly: true },
  { suffix: '.zip', packageType: 'zip', decisivePlatform: null },
  { suffix: '.7z', packageType: '7z', decisivePlatform: null },
];

/** Longer extensions have priority to avoid `.pkg` matching ahead of `.tar.gz`, etc. */
const PACKAGE_TYPES: PackageTypeEntry[] = [...PACKAGE_TYPE_ENTRIES].sort(
  (left, right) => right.suffix.length - left.suffix.length,
);

/**
 * Exclusion rules: assets that are not installable software must be filtered out before candidate selection.
 * This ruleset shares the same intent as `SOURCE_ARCHIVE` / checksum regexes in `examples/plugins/smart-release-recommender/worker.js`,
 * but with more complete coverage (that reference implementation only covers source, checksum, and signature).
 */
const EXCLUSION_RULES: ReadonlyArray<{ reason: string; pattern: RegExp }> = [
  // Chinese for "source code" (\u6e90\u7801)
  { reason: 'source code archive', pattern: /(?:^|[^a-z0-9])(?:source|src)(?:[^a-z0-9]?(?:code|archive))?(?=$|[^a-z0-9])|\u6e90\u7801/ },
  { reason: 'checksum file', pattern: /(?:checksum|sha256sum|sha512sum|\.(?:sha256|sha512|md5)(?:\.(?:zip|7z|tar\.gz)|$)|(?:^|[^a-z0-9])md5(?=$|[^a-z0-9]))/ },
  { reason: 'signature file', pattern: /\.(?:sig|asc|minisig|p7s)(?:\.(?:zip|7z|tar\.gz)|$)|(?:^|[^a-z0-9])sigstore(?=$|[^a-z0-9])/ },
  { reason: 'debug symbols', pattern: /\.(?:pdb|dsym)(?:\.(?:zip|7z|tar\.gz)|$)|(?:^|[^a-z0-9])(?:symbols?|dsym)(?=$|[^a-z0-9])/ },
  { reason: 'electron blockmap', pattern: /\.blockmap(?:\.(?:zip|7z|tar\.gz)|$)/ },
  { reason: 'software bill of materials', pattern: /(?:^|[^a-z0-9])(?:sbom|spdx|cyclonedx)(?=$|[^a-z0-9])/ },
];

/**
 * Architecture vocabulary.
 * Intentionally differs from the reference implementation (worker.js L11-16) in two ways:
 * - Accepts `ia32` / `i386…i686` (Electron 32-bit naming) in addition to bare `x86`;
 *   `win32` is a Windows platform name rather than a 32-bit indicator (as noted in the reference implementation comments) and is not treated as an architecture here.
 * - Adds `universal` (macOS universal binary / multi-architecture single asset). The reference implementation never outputs this value, so `project-macos-universal.dmg` would only win on platform score; here we recognize it as a first-class architecture.
 */
const ARCH_RULES: ReadonlyArray<{ architecture: InstallableArchitecture; pattern: RegExp }> = [
  { architecture: 'universal', pattern: /(?:^|[^a-z0-9])(?:universal2?|multiarch)(?=$|[^a-z0-9])/ },
  { architecture: 'x64', pattern: /(?:^|[^a-z0-9])(?:x86[_-]?64|amd64|x64|win64)(?=$|[^a-z0-9])/ },
  { architecture: 'arm64', pattern: /(?:^|[^a-z0-9])(?:aarch64|arm64|arm64e)(?=$|[^a-z0-9])/ },
  { architecture: 'x86', pattern: /(?:^|[^a-z0-9])(?:ia32|i[3-6]86|x86(?![_-]?64))(?=$|[^a-z0-9])/ },
];

/** Weights used for confidence sorting (highest first). */
const CONFIDENCE_ORDER: Record<InstallableConfidence, number> = { high: 0, medium: 1, low: 2 };

/** Architecture fit relative to the current device: exact match is best, followed by universal builds, and finally unknown. */
function architectureRank(
  architecture: InstallableArchitecture | undefined,
  deviceArchitecture: InstallableArchitecture | undefined,
): number {
  if (architecture === undefined) return 2;
  if (architecture === 'universal') return 1;
  return architecture === deviceArchitecture ? 0 : 1;
}

/** Detects package type from file name (extension match, longer extension prioritized). */
function detectPackageType(fileName: string) {
  const name = fileName.toLowerCase();
  return PACKAGE_TYPES.find((entry) => name.endsWith(entry.suffix)) ?? null;
}

/** Architectures declared in the file name; empty set means none declared. */
function declaredArchitectures(fileName: string): Set<InstallableArchitecture> {
  const name = fileName.toLowerCase();
  const found = new Set<InstallableArchitecture>();
  for (const { architecture, pattern } of ARCH_RULES) {
    if (pattern.test(name)) found.add(architecture);
  }
  return found;
}

/** Platforms declared in the file name (reuses releaseAssets vocabulary without duplicate maintenance). */
function declaredPlatforms(fileName: string): Set<InstallablePlatform> {
  const found = new Set<InstallablePlatform>();
  for (const token of fileName.toLowerCase().split(/[^a-z0-9]+/)) {
    const platform = toInstallablePlatform(OS_TOKEN_PLATFORM[token] ?? null);
    if (platform) found.add(platform);
  }
  return found;
}

/**
 * Resolves asset architecture.
 * Returning `ambiguous` indicates the filename declared multiple architectures concurrently (e.g. `app-x64-arm64.zip`).
 * In this case, we avoid guessing: architecture is left unset and confidence is downgraded.
 */
function resolveArchitecture(fileName: string): {
  architecture?: InstallableArchitecture;
  ambiguous: boolean;
} {
  const declared = declaredArchitectures(fileName);
  if (declared.size === 0) return { ambiguous: false };
  // Universal builds cover all architectures; when appearing alongside a specific architecture, universal takes precedence (no contradiction).
  if (declared.has('universal')) return { architecture: 'universal', ambiguous: false };
  if (declared.size === 1) return { architecture: [...declared][0], ambiguous: false };
  return { ambiguous: true };
}

/** Assembles human-readable rationale. The UI has separate localized labels; this provides explanation for AI/MCP/plugins as well. */
function buildReason(input: {
  platform: InstallablePlatform;
  packageType: InstallablePackageType;
  architecture?: InstallableArchitecture;
  ambiguousArchitecture: boolean;
  platformFromExtension: boolean;
  detectOnly: boolean;
}): string {
  const platformLabel = input.platform === 'macos' ? 'macOS' : input.platform[0].toUpperCase() + input.platform.slice(1);
  const parts = [`${platformLabel} ${input.packageType} package`];
  if (input.architecture) parts.push(`declares ${input.architecture}`);
  if (input.ambiguousArchitecture) parts.push('declares multiple architectures');
  if (!input.architecture && !input.ambiguousArchitecture) parts.push('architecture not declared');
  parts.push(
    input.platformFromExtension
      ? 'platform from package extension'
      : 'platform inferred from filename',
  );
  if (input.detectOnly) parts.push('detect only — not directly installable');
  return parts.join('; ');
}

/**
 * Detects installable assets from a release asset collection.
 *
 * @param assets Release assets (`Release.assets`).
 * @param options Target device and filter options; omitting `platform` disables platform filtering and returns all candidates.
 * @returns Candidates (stably sorted by confidence, architecture fit, and asset ID) and excluded assets with reasons.
 */
export function detectInstallableAssets(
  assets: readonly ReleaseAsset[] | undefined,
  options: InstallableAssetDetectionOptions = {},
): InstallableAssetDetectionResult {
  const matches: InstallableAsset[] = [];
  const excluded: InstallableAssetDetectionResult['excluded'] = [];
  const targetPlatform = options.platform;
  const deviceArchitecture = options.architecture;

  for (const asset of assets ?? []) {
    const fileName = asset?.name ?? '';
    if (!fileName) continue;

    const lowercase = fileName.toLowerCase();
    const exclusion = EXCLUSION_RULES.find((rule) => rule.pattern.test(lowercase));
    if (exclusion) {
      excluded.push({ assetId: asset.id, fileName, reason: exclusion.reason });
      continue;
    }

    const packageInfo = detectPackageType(fileName);
    if (!packageInfo) {
      excluded.push({ assetId: asset.id, fileName, reason: 'not a supported installable package format' });
      continue;
    }
    // AAB is detect-only and not directly installable: omitted from candidates by default (roadmap §5.1).
    if (packageInfo.detectOnly && !options.includeDetectOnly) {
      excluded.push({ assetId: asset.id, fileName, reason: 'Android App Bundle is detect-only and cannot be installed directly' });
      continue;
    }

    const declared = declaredPlatforms(fileName);
    if (declared.size > 1) {
      excluded.push({
        assetId: asset.id,
        fileName,
        reason: `filename declares multiple platforms (${[...declared].join(', ')})`,
      });
      continue;
    }

    // Platform origin precedence: unique filename platform -> decisive extension. When in conflict, exclude rather than guess.
    const fromExtension = packageInfo.decisivePlatform;
    let platform: InstallablePlatform | null = null;
    let platformFromExtension = false;
    if (declared.size === 1) {
      const declaredPlatform = [...declared][0];
      if (fromExtension && fromExtension !== declaredPlatform) {
        excluded.push({
          assetId: asset.id,
          fileName,
          reason: `package extension targets ${fromExtension} but the filename declares ${declaredPlatform}`,
        });
        continue;
      }
      platform = declaredPlatform;
    } else if (fromExtension) {
      platform = fromExtension;
      platformFromExtension = true;
    } else {
      // Container format does not indicate target platform (e.g. `myapp-1.0.zip`).
      // Reuse the final layer of detectAssetPlatform — MIME type fallback from content_type.
      // Only this can still provide platform evidence; otherwise do not guess (roadmap §5.3: "do not treat all ZIPs as installable software"),
      // while still allowing manual download in the asset sheet.
      const fromContentType = toInstallablePlatform(
        detectAssetPlatform(fileName, asset.content_type),
      );
      if (!fromContentType) {
        excluded.push({
          assetId: asset.id,
          fileName,
          reason: 'portable archive without a declared target platform',
        });
        continue;
      }
      platform = fromContentType;
    }

    if (targetPlatform && platform !== targetPlatform) {
      excluded.push({
        assetId: asset.id,
        fileName,
        reason: `targets ${platform}, this device is ${targetPlatform}`,
      });
      continue;
    }

    const { architecture, ambiguous } = resolveArchitecture(fileName);
    if (ambiguous) {
      excluded.push({
        assetId: asset.id,
        fileName,
        reason: 'declares multiple architectures',
      });
      continue;
    }
    const usesWindowsX86Compatibility = platform === 'windows'
      && architecture === 'x86'
      && (deviceArchitecture === 'x64' || deviceArchitecture === 'arm64');
    if (
      deviceArchitecture
      && architecture
      && architecture !== 'universal'
      && architecture !== deviceArchitecture
      && !usesWindowsX86Compatibility
    ) {
      excluded.push({
        assetId: asset.id,
        fileName,
        reason: `targets ${architecture}, this device is ${deviceArchitecture}`,
      });
      continue;
    }

    // Confidence: decisive extension + known architecture = high; container format or unknown architecture downgrades confidence.
    let confidence: InstallableConfidence;
    if (usesWindowsX86Compatibility) confidence = 'medium';
    else if (fromExtension && architecture) confidence = 'high';
    else if (fromExtension) confidence = 'medium';
    else if (architecture) confidence = 'medium';
    else confidence = 'low';

    matches.push({
      assetId: asset.id,
      fileName,
      downloadUrl: asset.browser_download_url,
      size: asset.size,
      platform,
      architecture,
      packageType: packageInfo.packageType,
      confidence,
      reason: buildReason({
        platform,
        packageType: packageInfo.packageType,
        architecture,
        ambiguousArchitecture: false,
        platformFromExtension,
        detectOnly: packageInfo.detectOnly === true,
      }),
    });
  }

  matches.sort(
    (left, right) =>
      CONFIDENCE_ORDER[left.confidence] - CONFIDENCE_ORDER[right.confidence] ||
      architectureRank(left.architecture, deviceArchitecture) -
        architectureRank(right.architecture, deviceArchitecture) ||
      left.assetId - right.assetId,
  );

  return { matches, excluded };
}

/**
 * Repository-level convenience check: whether any asset in the release can be installed on the current device.
 * Reused by Discovery filtering, Repository Health, and batch import previews.
 */
export function hasInstallableAsset(
  assets: readonly ReleaseAsset[] | undefined,
  options: InstallableAssetDetectionOptions = {},
): boolean {
  return detectInstallableAssets(assets, options).matches.length > 0;
}
