/**
 * Formats byte counts for display.
 *
 * Extracted from the local implementation inside `RepositoryReleaseSheet` so that the release asset table
 * and the installable asset recommendation block share the same sizing standard (the same data should not display as different sizes in different places).
 */

/**
 * Formats a byte count into a human-readable string.
 *
 * @param bytes Byte count; `null` returns a dash (representing unknown, e.g., Source code items).
 * @returns E.g. `0 B`, `1.5 KB`, `12.0 MB`.
 */
export function formatFileSize(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
