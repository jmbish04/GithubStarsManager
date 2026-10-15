import type { ElementType } from 'react';
import { Globe, Monitor, Terminal } from 'lucide-react';
import { SiAndroid, SiApple, SiDocker, SiIos, SiLinux } from '@icons-pack/react-simple-icons';
import { SiWindows } from './SiWindows';

/** Platform identifier -> icon component. CLI/Web lack brand glyphs and use lucide line icons instead. */
export const PLATFORM_ICON_MAP: Record<string, ElementType> = {
  mac: SiApple,
  macos: SiApple,
  ios: SiIos,
  windows: SiWindows,
  win: SiWindows,
  linux: SiLinux,
  android: SiAndroid,
  web: Globe,
  cli: Terminal,
  docker: SiDocker,
};

export const DEFAULT_PLATFORM_ICON: ElementType = Monitor;

export function getPlatformIcon(platform: string): ElementType {
  return PLATFORM_ICON_MAP[platform.toLowerCase()] ?? DEFAULT_PLATFORM_ICON;
}

const PLATFORM_NAME_MAP: Record<string, string> = {
  mac: 'macOS',
  macos: 'macOS',
  windows: 'Windows',
  win: 'Windows',
  linux: 'Linux',
  ios: 'iOS',
  android: 'Android',
  web: 'Web',
  cli: 'CLI',
  docker: 'Docker',
};

export function getPlatformDisplayName(platform: string): string {
  return PLATFORM_NAME_MAP[platform.toLowerCase()] ?? platform;
}
