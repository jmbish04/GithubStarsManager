import type { Release, ReleaseAsset, Repository } from '../types';
import { detectAssetPlatform, OS_TOKEN_PLATFORM } from './releaseAssets';

/**
 * Deterministic detection of repository "supported platforms" (P1 + P2).
 *
 * Background: ai_platforms originates from AI analysis and is not always accurate. Here we re-infer
 * using two categories of free, deterministic signals, prioritized for card display, falling back to ai_platforms
 * only when all signals are absent:
 *
 * P1 release-assets — Release asset filenames. Reuses detectAssetPlatform, aggregating across the last N releases:
 * same platform within a single release counts once (multiple architecture builds for one release should not stack weights);
 * each matching release adds WEIGHT_PER_RELEASE. Release subscription sync already pulls all assets, so this layer requires zero extra network requests.
 *
 * P2 repository-metadata — topics / description / primary language.
 * Topics map directly to the OS semantic dictionary ('macos'/'android'/'cli'..., including composite words like 'cross-platform');
 * description uses the exact same word-boundary OS tokenizer as asset filenames; primary language applies weak mapping (Swift -> Apple ecosystem, Kotlin -> Android...).
 *
 * Each signal carries weight; only platforms with total scores reaching PLATFORM_DISPLAY_THRESHOLD participate in display:
 * language(2) or description(2) alone is insufficient; they must corroborate each other or combine with topic(4) or assets(10).
 */

export type PlatformSignalSource = 'release-assets' | 'topics' | 'description' | 'languages';

export interface PlatformSignal {
  platform: string;
  weight: number;
  source: PlatformSignalSource;
}

/** Aggregates the most recent N releases; old platform artifacts should not continue voting after a project pivot. */
const MAX_RELEASES = 10;
/** Weight added each time a release's assets match this platform. */
const WEIGHT_PER_RELEASE = 10;
export const PLATFORM_DISPLAY_THRESHOLD = 4;

/** Display order: corresponds 1:1 with brand icons in platformMeta; unknown keys sort last. */
const PLATFORM_DISPLAY_ORDER = ['macos', 'windows', 'linux', 'ios', 'android', 'docker', 'web', 'cli'];

const TOPIC_PLATFORM: Record<string, string[]> = {
  macos: ['macos'], mac: ['macos'], apple: ['macos'], swift: ['macos', 'ios'], swiftui: ['macos', 'ios'],
  ios: ['ios'], ipados: ['ios'], iphone: ['ios'],
  watchos: ['ios'], tvos: ['ios'],
  android: ['android'],
  windows: ['windows'], uwp: ['windows'], winui: ['windows'], dotnet: ['windows'],
  linux: ['linux'], unix: ['linux'],
  docker: ['docker'], container: ['docker'], containers: ['docker'], kubernetes: ['docker'],
  web: ['web'], webapp: ['web'],
  cli: ['cli'], terminal: ['cli'], tui: ['cli'],
  crossplatform: ['macos', 'windows', 'linux'],
};

/** Primary language -> weak platform signal. For corroboration only; never reaches display threshold on its own. */
const LANGUAGE_PLATFORM: Record<string, string[]> = {
  swift: ['macos', 'ios'],
  'objective-c': ['macos', 'ios'],
  kotlin: ['android'],
  dart: ['android', 'ios'],
  'c#': ['windows'],
};

const addSignals = (map: Map<string, number>, platforms: string[], weight: number) => {
  for (const platform of platforms) {
    map.set(platform, (map.get(platform) ?? 0) + weight);
  }
};

/**
 * P1: Infers platform signals from release assets.
 * Deduplicates platforms within the same release before assigning WEIGHT_PER_RELEASE;
 * considers only the most recent MAX_RELEASES (descending by published_at).
 */
export function inferPlatformsFromReleases(
  releases: Array<Pick<Release, 'assets' | 'published_at'>>,
): PlatformSignal[] {
  const sorted = [...releases]
    .filter(release => !Number.isNaN(new Date(release.published_at).getTime()))
    .sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime())
    .slice(0, MAX_RELEASES);

  const weights = new Map<string, number>();
  for (const release of sorted) {
    const platforms = new Set<string>();
    for (const asset of (release.assets ?? []) as ReleaseAsset[]) {
      const platform = detectAssetPlatform(asset.name, asset.content_type);
      if (platform) platforms.add(platform);
    }
    addSignals(weights, [...platforms], WEIGHT_PER_RELEASE);
  }

  return [...weights.entries()]
    .map(([platform, weight]): PlatformSignal => ({ platform, weight, source: 'release-assets' }));
}

/**
 * P2: Infers platform signals from repository metadata (topics/description/primary language).
 * Topics match whole words after stripping delimiters ('cross-platform' -> 'crossplatform');
 * description reuses the asset filename OS dictionary with whole-word matching to prevent substring false positives.
 */
export function inferPlatformsFromRepositoryMetadata(
  repository: Pick<Repository, 'topics' | 'description' | 'language'>,
): PlatformSignal[] {
  const signals: PlatformSignal[] = [];

  const topicWeights = new Map<string, number>();
  for (const topic of repository.topics ?? []) {
    const platforms = TOPIC_PLATFORM[topic.toLowerCase().replace(/[^a-z0-9]/g, '')];
    if (platforms) addSignals(topicWeights, platforms, 4);
  }
  signals.push(...[...topicWeights.entries()]
    .map(([platform, weight]): PlatformSignal => ({ platform, weight, source: 'topics' })));

  const description = (repository.description ?? '').toLowerCase();
  if (description) {
    const descriptionWeights = new Map<string, number>();
    for (const token of description.split(/[^a-z0-9]+/)) {
      const platform = OS_TOKEN_PLATFORM[token];
      if (platform) {
        descriptionWeights.set(platform, (descriptionWeights.get(platform) ?? 0) + 2);
        break; // Matching description once suffices; repetitions do not stack
      }
    }
    signals.push(...[...descriptionWeights.entries()]
      .map(([platform, weight]): PlatformSignal => ({ platform, weight, source: 'description' })));
  }

  const language = repository.language?.toLowerCase();
  if (language) {
    for (const platform of LANGUAGE_PLATFORM[language] ?? []) {
      signals.push({ platform, weight: 2, source: 'languages' });
    }
  }

  return signals;
}

/**
 * Aggregates P1+P2 signals and outputs deterministic platform list in display order.
 * Only tallies releases matching `release.repository.id === repository.id` — callers
 * (useRepositoryPlatforms) pass global releases array; without filtering,
 * assets from other repositories would bleed into this repository's platform list.
 * Only platforms reaching PLATFORM_DISPLAY_THRESHOLD are included;
 * falls back to ai_platforms when no platform qualifies (preserving legacy behavior).
 */
export function resolveRepositoryPlatforms(
  repository: Pick<Repository, 'id' | 'topics' | 'description' | 'language' | 'ai_platforms'>,
  releases: Array<Pick<Release, 'repository' | 'assets' | 'published_at'>>,
): string[] {
  const ownReleases = releases.filter(
    release => release.repository?.id === repository.id,
  );

  const totals = new Map<string, number>();
  for (const signal of [
    ...inferPlatformsFromReleases(ownReleases),
    ...inferPlatformsFromRepositoryMetadata(repository),
  ]) {
    totals.set(signal.platform, (totals.get(signal.platform) ?? 0) + signal.weight);
  }

  const detected = [...totals.entries()]
    .filter(([, weight]) => weight >= PLATFORM_DISPLAY_THRESHOLD)
    .map(([platform]) => platform);

  if (detected.length === 0) {
    return repository.ai_platforms ?? [];
  }

  const order = (platform: string) => {
    const index = PLATFORM_DISPLAY_ORDER.indexOf(platform);
    return index === -1 ? PLATFORM_DISPLAY_ORDER.length : index;
  };
  return detected.sort((a, b) => order(a) - order(b));
}
