import { Download } from 'lucide-react';
import { detectAssetPlatform } from '../utils/releaseAssets';
import { getPlatformDisplayName, getPlatformIcon } from './platformMeta';

/**
 * Leading icon for asset rows: infers platform from filename/extension (with MIME fallback) -> square brand badge;
 * falls back to a generic download icon when indeterminate (no guessing).
 * Download status icons (in progress / completed / source code) are rendered preferentially by callers.
 * Shared between Release page (ReleaseCard) and repository Release sidebar (RepositoryReleaseSheet)
 * to ensure consistent platform icons across both surfaces.
 */
const AssetLeadingIcon = ({ name, contentType }: { name: string; contentType?: string }) => {
  const platform = detectAssetPlatform(name, contentType);
  if (!platform) {
    return <Download className="w-3.5 h-3.5 text-muted-foreground dark:text-muted-foreground/70 flex-shrink-0" aria-hidden="true" />;
  }
  const Icon = getPlatformIcon(platform);
  return (
    <span className="asset-platform-badge flex-shrink-0" title={getPlatformDisplayName(platform)}>
      <Icon className="h-[11px] w-[11px]" aria-hidden="true" />
    </span>
  );
};

export default AssetLeadingIcon;
