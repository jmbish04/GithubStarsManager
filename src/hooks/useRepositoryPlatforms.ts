import { useMemo } from 'react';
import { useAppStore } from '../store/useAppStore';
import type { Repository } from '../types';
import { resolveRepositoryPlatforms } from '../utils/repoPlatformDetection';

/**
 * Platform list for repository display: prioritizes deterministic detection from release assets
 * and repository metadata, falling back to ai_platforms when no deterministic signals exist.
 * See utils/repoPlatformDetection.ts for details.
 * The global releases array is filtered by repository ID inside resolveRepositoryPlatforms,
 * so assets from other repositories do not affect this repository's platform list.
 * Only subscribes to the releases array reference, preventing card re-renders when releases are unchanged.
 */
export function useRepositoryPlatforms(repository: Repository): string[] {
  const releases = useAppStore((state) => state.releases);
  return useMemo(
    () => resolveRepositoryPlatforms(repository, releases ?? []),
    [repository, releases],
  );
}
