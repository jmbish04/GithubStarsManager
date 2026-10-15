import { makeT } from './useT';
import type { AppLanguage } from './languages';

/**
 * Localized name for Discovery channels/platforms: built-in channels look up translation resources by stable id;
 * custom channels fall back to nameEn (then fall back to canonical Chinese name). zh uses the canonical name directly.
 */
export function discoveryChannelName(
  channel: { id: string; name: string; nameEn?: string },
  language: AppLanguage,
): string {
  if (language === 'zh') return channel.name;
  const key = `discoveryChannel.${channel.id}`;
  const localized = makeT(language, 'discovery')(key);
  if (localized !== key) return localized;
  return channel.nameEn || channel.name;
}

export function discoveryPlatformName(
  platform: { id: string; name: string; nameEn?: string },
  language: AppLanguage,
): string {
  if (language === 'zh') return platform.name;
  const key = `discoveryPlatform.${platform.id}`;
  const localized = makeT(language, 'discovery')(key);
  if (localized !== key) return localized;
  return platform.nameEn || platform.name;
}
