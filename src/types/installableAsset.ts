/**
 * Installable Asset Detection Model.
 *
 * Goal: Consistently determine which asset in a Release can be installed on the current device,
 * allowing Release views, Discovery, My Apps, AI, MCP, and plugins to reuse the same result.
 *
 * Boundaries (roadmap §5.3):
 * - Detection only. Does not execute after download and does not auto-select unknown third-party mirrors.
 * - Does not assume software safety merely because a file extension resembles an installer.
 * - Provides multiple candidates when uncertain, rather than presenting a single false certainty.
 * - Users can always manually choose other Release assets.
 */

/** Currently supported target platforms for detection. */
export type InstallablePlatform = 'windows' | 'macos' | 'linux' | 'android';

/** Device/asset CPU architecture; `universal` indicates a single artifact covering multiple architectures. */
export type InstallableArchitecture = 'x64' | 'arm64' | 'x86' | 'universal';

/** Supported installer package types for detection. */
export type InstallablePackageType =
  | 'exe'
  | 'msi'
  | 'zip'
  | '7z'
  | 'dmg'
  | 'pkg'
  | 'deb'
  | 'rpm'
  | 'appimage'
  | 'tar.gz'
  | 'apk'
  | 'aab';

/**
 * Detection confidence.
 * - `high`: Package type and platform are determined by definitive extensions, and platform matches the target.
 * - `medium`: Package type is certain, but platform is inferred from filename semantics or architecture cannot be determined.
 * - `low`: Can only serve as a candidate (e.g. generic `.zip`, bare archive missing platform markers).
 */
export type InstallableConfidence = 'high' | 'medium' | 'low';

export interface InstallableAsset {
  assetId: number;
  fileName: string;
  downloadUrl: string;
  size: number;

  platform: InstallablePlatform;
  architecture?: InstallableArchitecture;
  packageType: InstallablePackageType;

  confidence: InstallableConfidence;
  /** Human-readable rationale explaining to the user why this was recommended. */
  reason: string;
}

/** Detection result: candidates stably sorted by confidence and asset order. */
export interface InstallableAssetDetectionResult {
  /** Candidates matching target platform (may be multiple—shown side-by-side when uncertain). */
  matches: InstallableAsset[];
  /**
   * Explicitly excluded assets and reasons (source code, checksum, signature, symbols, debug,
   * source archive, blockmap, non-target platform, etc.). Used to explain why an asset was omitted.
   */
  excluded: Array<{ assetId: number; fileName: string; reason: string }>;
}

/** Detection context. Defaults to the current device; tests can inject explicitly. */
export interface InstallableAssetDetectionOptions {
  /** Target platform; when omitted, means "do not filter by platform", returning candidates for all platforms. */
  platform?: InstallablePlatform;
  /** Target architecture; when omitted, no architecture filtering is applied (architecture info is still resolved). */
  architecture?: InstallableArchitecture;
  /** AAB is detected only and not recommended as directly installable (Android). */
  includeDetectOnly?: boolean;
}
