import type { PluginRegistry, PluginRegistryEntry, PluginRemovalEntry } from '../services/pluginRegistryService';

export type PluginRegistryStatus =
  | 'update-available'
  | 'up-to-date'
  | 'revoked'
  | 'blocked'
  | 'version-unknown'
  | 'not-in-registry';

export interface PluginPermissionDiff {
  /** Permissions required by the target version that are not currently granted — these require re-prompting for user consent. */
  added: string[];
  removed: string[];
}

export interface PluginRegistryAssessment {
  pluginId: string;
  installedVersion: string;
  status: PluginRegistryStatus;
  latestVersion: string | null;
  permissionDiff: PluginPermissionDiff;
  /** Reason when revoked or blocked. */
  reason: string | null;
  /** Data usage description of the target version (written during review). */
  dataUsage: string | null;
  removedAction: PluginRemovalEntry['action'] | null;
}

export interface InstalledPluginForRegistry {
  id: string;
  version: string;
  /** Currently effective permissions; falls back to manifest-declared permissions if missing. */
  grantedPermissions?: string[];
  declaredPermissions?: string[];
}

const compareNumericIdentifiers = (left: string, right: string): number => {
  const a = left.replace(/^0+(?=\d)/, '');
  const b = right.replace(/^0+(?=\d)/, '');
  if (a.length !== b.length) return a.length > b.length ? 1 : -1;
  return a === b ? 0 : (a > b ? 1 : -1);
};

/** Semver comparison; returns NaN when unparseable, callers must handle separately. */
export const comparePluginVersions = (left: string, right: string): number => {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value).trim());
    return match ? { numbers: [match[1], match[2], match[3]], prerelease: match[4] ?? null } : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return NaN;
  for (let index = 0; index < 3; index += 1) {
    const comparison = compareNumericIdentifiers(a.numbers[index], b.numbers[index]);
    if (comparison !== 0) return comparison;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  const leftParts = a.prerelease.split('.');
  const rightParts = b.prerelease.split('.');
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const x = leftParts[index];
    const y = rightParts[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const comparison = compareNumericIdentifiers(x, y);
      if (comparison !== 0) return comparison;
      continue;
    }
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
};

const computePermissionDiff = (next: string[], current: string[]): PluginPermissionDiff => {
  const currentSet = new Set(current);
  const nextSet = new Set(next);
  return {
    added: next.filter((permission) => !currentSet.has(permission)),
    removed: current.filter((permission) => !nextSet.has(permission)),
  };
};

const REMOVAL_ACTION_PRIORITY: Record<PluginRemovalEntry['action'], number> = {
  revoke: 2,
  block: 1,
};

const findRemoval = (removed: PluginRemovalEntry[], pluginId: string, version: string): PluginRemovalEntry | null => (
  removed
    .filter((candidate) => (
      candidate.id === pluginId
      && (candidate.versions.length === 0 || candidate.versions.includes(version))
    ))
    .sort((left, right) => (
      REMOVAL_ACTION_PRIORITY[right.action] - REMOVAL_ACTION_PRIORITY[left.action]
      || right.date.localeCompare(left.date)
    ))[0] ?? null
);

/**
 * Finds matching (pluginId, version) records in the revoked/blocked table.
 * When multiple records match, revoke takes priority, followed by newer dates.
 * Shared between the marketplace modal and installed plugin comparisons.
 */
export const findPluginRemoval = findRemoval;

/** Plugin API versions supported by the client; registry entries declaring any other version are ignored. */
export const SUPPORTED_API_VERSIONS = new Set(['1']);

/** Selects the highest version supported by the client — not necessarily the newest version in the registry. */
export const pickInstallableEntry = (versions: PluginRegistryEntry[]): PluginRegistryEntry | null => {
  const compatible = versions
    .filter((entry) => SUPPORTED_API_VERSIONS.has(entry.apiVersion) && !Number.isNaN(comparePluginVersions(entry.version, entry.version)))
    .sort((left, right) => comparePluginVersions(right.version, left.version));
  return compatible[0] ?? null;
};

/**
 * Compares installed plugins against the registry to determine each plugin's status.
 *
 * Pure evaluation without triggering actions: revoke/block status serves as notification and rationale; disabling is up to the user.
 * Permission diff computes permissions in the target version beyond what is currently granted — the exact portion requiring re-consent.
 */
export const assessInstalledPlugins = (
  installed: InstalledPluginForRegistry[],
  registry: PluginRegistry | null,
): PluginRegistryAssessment[] => {
  return installed.map((plugin) => {
    const base: PluginRegistryAssessment = {
      pluginId: plugin.id,
      installedVersion: plugin.version,
      status: 'not-in-registry',
      latestVersion: null,
      permissionDiff: { added: [], removed: [] },
      reason: null,
      dataUsage: null,
      removedAction: null,
    };
    if (!registry) return base;

    const removal = findRemoval(registry.removed, plugin.id, plugin.version);
    if (removal) {
      return {
        ...base,
        status: removal.action === 'revoke' ? 'revoked' : 'blocked',
        reason: removal.reason,
        removedAction: removal.action,
      };
    }

    const group = registry.plugins.find((candidate) => candidate.id === plugin.id);
    if (!group) return base;

    const entry = pickInstallableEntry(group.versions);
    if (!entry) return base;

    const current = plugin.grantedPermissions ?? plugin.declaredPermissions ?? [];
    const permissionDiff = computePermissionDiff(entry.permissions, current);
    const versionComparison = comparePluginVersions(entry.version, plugin.version);
    if (Number.isNaN(versionComparison)) {
      return { ...base, status: 'version-unknown', latestVersion: entry.version, dataUsage: entry.dataUsage };
    }
    const hasUpdate = versionComparison > 0;

    return {
      ...base,
      status: hasUpdate ? 'update-available' : 'up-to-date',
      latestVersion: entry.version,
      permissionDiff,
      dataUsage: entry.dataUsage,
    };
  });
};
