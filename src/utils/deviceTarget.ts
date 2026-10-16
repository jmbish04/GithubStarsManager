/**
 * Platform and architecture detection for the current device.
 *
 * Purpose: Installable Asset Detection needs to know what this device is to determine
 * which release assets can be installed. The detection result is only a recommendation
 * signal, not an unchangeable hard filter (roadmap §7).
 *
 * Why we do not use Electron IPC to retrieve `process.platform` / `process.arch`:
 * - The Web build lacks an Electron process and requires a browser-compatible implementation;
 * - Introducing an IPC just to read platform/arch expands the host-side surface, whereas
 *   `navigator.userAgentData` reports the host OS/CPU architecture in the Electron renderer process as well.
 * Therefore, we unify on Web APIs here, leaving the host plugin runtime's `hostEnvironment`
 * (process.platform/arch) independent and untouched.
 *
 * Architecture detection is best-effort only: `navigator.userAgentData` architecture values
 * are high-entropy hints and can only be obtained asynchronously. When unavailable, it returns
 * undefined; callers should skip architecture filtering and present candidates side-by-side rather than guessing.
 */
import type { InstallableArchitecture, InstallablePlatform } from '../types/installableAsset';

/** Minimal type for `navigator.userAgentData` (TS DOM lib does not built-in getHighEntropyValues). */
interface UADataLike {
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{
    architecture?: string;
    bitness?: string;
    platform?: string;
  }>;
}

function readUserAgentData(): UADataLike | null {
  if (typeof navigator === 'undefined') return null;
  const data = (navigator as Navigator & { userAgentData?: UADataLike }).userAgentData;
  return data ?? null;
}

/**
 * Normalizes `userAgentData.platform` / `navigator.platform` / UA string to a target platform.
 *
 * The evaluation order is intentional:
 * 1. Exclude unsupported platforms first. Neither iOS nor ChromeOS distributes installation
 *    packages in this repository. Treating them as macOS / Linux would cause the recommendation
 *    component to recommend `.dmg` to iOS users or `.deb` / `.rpm` / AppImage to ChromeOS users.
 *    Returning null here allows callers to treat the platform as unknown (presenting candidates without claiming compatibility).
 * 2. macOS must come before Windows: `darwin` contains `win`; reversing the order would mistakenly
 *    classify Safari's UA (`… Darwin …`) as Windows.
 */
function normalizePlatformToken(value: string | undefined | null): InstallablePlatform | null {
  if (!value) return null;
  const token = value.toLowerCase();

  // Unsupported platforms: must explicitly identify and discard rather than falling back to a desktop platform
  if (token.includes('iphone') || token.includes('ipad') || token.includes('ipod') || token.includes('ios')) {
    return null;
  }
  if (token.includes('cros') || token.includes('crkey') || token.includes('chromeos')) {
    return null;
  }

  if (token.includes('android')) return 'android';
  if (token.includes('mac') || token.includes('darwin') || token.includes('osx')) {
    return 'macos';
  }
  if (token.includes('windows') || token.includes('win32') || token.includes('win64') || token.includes('win')) {
    return 'windows';
  }
  if (token.includes('linux') || token.includes('x11') || token.includes('ubuntu')) {
    return 'linux';
  }
  return null;
}

/**
 * Returns true if any device signal indicates an unsupported platform (iOS / ChromeOS).
 *
 * Checking `navigator.platform` alone is insufficient: on ChromeOS it is `Linux x86_64`, which would be misidentified as Linux;
 * iPads might also report `MacIntel`. Therefore, we evaluate all three signals together; if any indicates an unsupported
 * platform, we discard detection rather than falling back to a desktop platform.
 */
function isUnsupportedPlatform(): boolean {
  const signals = [readUserAgentData()?.platform, navigator.platform, navigator.userAgent];
  const looksLikeTouchCapableMac = navigator.maxTouchPoints > 1
    && signals.some((signal) => normalizePlatformToken(signal) === 'macos');
  if (looksLikeTouchCapableMac) return true;
  return signals.some((signal) => {
    const token = (signal ?? '').toLowerCase();
    if (/(?:^|[^a-z])(?:iphone|ipad|ipod|ios)(?:$|[^a-z])/.test(token)) return true;
    return token.includes('cros') || token.includes('crkey') || token.includes('chromeos');
  });
}

/**
 * Synchronously detects the current device platform.
 * Prefers `userAgentData.platform` (Chromium/Electron), falls back to `navigator.platform`,
 * and finally falls back to the user agent string. Returns null if unidentifiable, requiring callers to not filter by platform.
 */
export function detectDevicePlatformSync(): InstallablePlatform | null {
  if (typeof navigator === 'undefined') return null;
  if (isUnsupportedPlatform()) return null;
  const fromUserAgent = normalizePlatformToken(navigator.userAgent);
  // Firefox on Android reports navigator.platform as Linux armv8l. Prefer the
  // explicit Android marker over that generic Linux fallback.
  if (fromUserAgent === 'android') return fromUserAgent;
  const fromUAData = normalizePlatformToken(readUserAgentData()?.platform);
  if (fromUAData) return fromUAData;
  const fromPlatform = normalizePlatformToken(navigator.platform);
  if (fromPlatform) return fromPlatform;
  return fromUserAgent;
}

/** Normalizes high-entropy `architecture` + `bitness` combinations into a target architecture. */
function normalizeArchitecture(
  architecture: string | undefined,
  bitness: string | undefined,
): InstallableArchitecture | undefined {
  const arch = (architecture ?? '').toLowerCase();
  const bits = (bitness ?? '').toLowerCase();
  if (arch === 'x86') return bits === '64' ? 'x64' : bits === '32' ? 'x86' : undefined;
  if (arch === 'arm') return bits === '64' ? 'arm64' : undefined;
  if (arch === 'arm64' || arch === 'aarch64') return 'arm64';
  if (arch === 'x86_64' || arch === 'amd64' || arch === 'x64') return 'x64';
  return undefined;
}

/** In-process cache: architecture does not change within a session, avoiding repeated async probes. */
let architectureCache: InstallableArchitecture | undefined;
let architectureProbe: Promise<InstallableArchitecture | undefined> | null = null;
let architectureProbeComplete = false;

/**
 * Best-effort resolution of the current device architecture.
 * Returns undefined when high-entropy hints cannot be obtained (e.g. Firefox/Safari, or API rejected);
 * callers should discard architecture filtering rather than assuming x64.
 */
export function resolveDeviceArchitecture(): Promise<InstallableArchitecture | undefined> {
  if (architectureProbeComplete) return Promise.resolve(architectureCache);
  if (architectureProbe) return architectureProbe;
  const data = readUserAgentData();
  if (!data?.getHighEntropyValues) {
    architectureProbeComplete = true;
    return Promise.resolve(undefined);
  }

  architectureProbe = data
    .getHighEntropyValues(['architecture', 'bitness'])
    .then((values) => {
      architectureCache = normalizeArchitecture(values?.architecture, values?.bitness);
      architectureProbeComplete = true;
      return architectureCache;
    })
    .catch(() => {
      architectureProbeComplete = true;
      return undefined;
    })
    .finally(() => {
      architectureProbe = null;
    });

  return architectureProbe;
}

/** Test only: resets the architecture cache. */
export function resetDeviceTargetCacheForTests(): void {
  architectureCache = undefined;
  architectureProbe = null;
  architectureProbeComplete = false;
}
