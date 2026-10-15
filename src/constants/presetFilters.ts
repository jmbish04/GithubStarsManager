/**
 * Preset asset filter constants
 * Used by ReleaseTimeline and AssetFilterManager components
 */

export interface PresetFilter {
  id: string;
  name: string;
  keywords: string[];
}

export const PRESET_FILTERS: PresetFilter[] = [
  { id: 'preset-windows', name: 'Windows', keywords: ['windows', 'win', 'exe', 'msi'] },
  { id: 'preset-macos', name: 'macOS', keywords: ['mac', 'macos', 'darwin', 'dmg', 'pkg'] },
  { id: 'preset-linux', name: 'Linux', keywords: ['linux', 'appimage', 'deb', 'rpm'] },
  { id: 'preset-android', name: 'Android', keywords: ['android', 'apk'] },
  { id: 'preset-source', name: 'Source', keywords: ['source', 'src', 'tar.gz', 'tar.xz', 'zip'] },
];
