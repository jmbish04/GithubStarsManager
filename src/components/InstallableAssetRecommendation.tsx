import { useT } from "../i18n/useT";
import React, { useEffect, useMemo, useState } from 'react';
import { Download, Info, ShieldQuestion } from 'lucide-react';
import type { Release } from '../types';
import type { InstallableArchitecture, InstallablePlatform } from '../types/installableAsset';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { getPlatformDisplayName, getPlatformIcon } from './platformMeta';
import { buildReleaseDownloadLinks, type ReleaseDownloadLink } from '../utils/releaseDownloadLinks';
import { detectInstallableAssets } from '../utils/installableAssets';
import { detectDevicePlatformSync, resolveDeviceArchitecture } from '../utils/deviceTarget';
import { formatFileSize } from '../utils/formatBytes';
import { computeRpcDownloadKey } from '../hooks/useReleaseArtifactActions';

/**
 * Built-in recommendation block for "which asset can this device install".
 *
 * Relationship with `ReleasePluginRecommendations` provided by plugins: That is a plugin capability
 * (requires user click to analyze, results are provided by the plugin), whereas this is Core's
 * deterministic recognition, requiring no plugins, no network requests, and is ready on every render.
 * Neither replaces the other and both can appear simultaneously—plugins can provide their own subjective recommendations
 * based on Health / asset facts.
 *
 * Explicit non-goals (roadmap §5.3):
 * - Does not automatically download or run installers; user must click.
 * - Does not claim installer packages are safe—only states "identified by filename as matching the current device".
 * - Does not hide other assets: unrecognized or platform-mismatched assets can still be downloaded manually from the asset table below.
 */
interface InstallableAssetRecommendationProps {
  release: Release;
  downloadStates?: Record<string, 'idle' | 'sending' | 'sent'>;
  /** Reuses the same download pipeline as the Release asset table (RPC / authenticated download / backend proxy). */
  onDownload: (link: ReleaseDownloadLink) => void;
}

const ARCHITECTURE_LABELS: Record<InstallableArchitecture, string> = {
  x64: 'x64',
  arm64: 'arm64',
  x86: 'x86',
  universal: 'Universal',
};

export const InstallableAssetRecommendation: React.FC<InstallableAssetRecommendationProps> = ({
  release,
  downloadStates = {},
  onDownload,
}) => {
  const t = useT('app');

  // Platform can be obtained synchronously (Electron/Chromium reports host OS, Web version reports browser device).
  const [platform] = useState<InstallablePlatform | null>(() => detectDevicePlatformSync());
  const [architecture, setArchitecture] = useState<InstallableArchitecture | undefined>(undefined);
  /**
   * Whether architecture probing has completed.
   *
   * Essential state: `architecture === undefined` represents both "still probing" and "genuinely unavailable",
   * conflating the two would keep all architectures on initial render and immediately enable the download button—on arm64 devices,
   * if x64 assets are sorted first, the user might download the wrong architecture package before probing finishes.
   */
  const [architectureSettled, setArchitectureSettled] = useState(false);

  useEffect(() => {
    let active = true;
    void resolveDeviceArchitecture().then((resolved) => {
      if (!active) return;
      setArchitecture(resolved);
      setArchitectureSettled(true);
    });
    return () => {
      active = false;
    };
  }, []);

  // Do not pass architecture when unavailable—skip architecture filtering and display candidates side by side rather than guessing.
  const detection = useMemo(
    () =>
      detectInstallableAssets(release.assets, {
        platform: platform ?? undefined,
        architecture,
      }),
    [release.assets, platform, architecture],
  );

  // Detection results only carry assetId; downloads still use the existing link model to avoid a second download codepath.
  const linksByAssetId = useMemo(() => {
    const map = new Map<number, ReleaseDownloadLink>();
    for (const link of buildReleaseDownloadLinks(release)) {
      if (link.assetId !== undefined) map.set(link.assetId, link);
    }
    return map;
  }, [release]);

  if (detection.matches.length === 0) return null;

  const [best, ...alternatives] = detection.matches;
  const bestLink = linksByAssetId.get(best.assetId);
  const bestDownloadState = bestLink
    ? downloadStates[computeRpcDownloadKey(bestLink)] ?? 'idle'
    : 'idle';
  const PlatformIcon = getPlatformIcon(best.platform);
  // Do not claim "matched to current device" when platform is unknown: candidates are listed across all platforms, not matched to device.
  const platformKnown = platform !== null;
  // Disable download before architecture probing finishes: otherwise the wrong architecture package might be downloaded before probe completion.
  const downloadEnabled = architectureSettled;

  const describe = (match: typeof best) => {
    // Reuse platformMeta for platform display name, avoiding maintaining another platform name table.
    const parts = [getPlatformDisplayName(match.platform)];
    if (match.architecture) parts.push(ARCHITECTURE_LABELS[match.architecture]);
    parts.push(match.packageType);
    return parts.join(' · ');
  };

  let deviceSummary: string;
  if (!platformKnown) {
    deviceSummary = t('installableAssetRecommendation.platform-not-detected');
  } else if (!architectureSettled) {
    deviceSummary = t('installableAssetRecommendation.detecting-architecture');
  } else {
    deviceSummary = `${getPlatformDisplayName(platform)}${architecture ? ` · ${ARCHITECTURE_LABELS[architecture]}` : ''}`;
  }

  return (
    <section
      className="mb-3 rounded-md border border-border bg-muted/20 px-3 py-3"
      data-testid="installable-asset-recommendation"
      aria-label={
        platformKnown
          ? t('installableAssetRecommendation.assets-for-this-device')
          : t('installableAssetRecommendation.installable-candidates')
      }
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold">
          {platformKnown
            ? t('installableAssetRecommendation.matches-this-device')
            : t('installableAssetRecommendation.installable-candidates')}
        </h3>
        <span className="text-[11px] text-muted-foreground">{deviceSummary}</span>
        <Badge variant="outline" className="text-[11px] font-normal">
          {t(`installableAssetRecommendation.confidence-${best.confidence}`)}
        </Badge>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <PlatformIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <p className="truncate text-xs font-medium" title={best.fileName}>{best.fileName}</p>
            <p className="truncate text-[11px] text-muted-foreground">
              {describe(best)} · {formatFileSize(best.size)}
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={!bestLink || !downloadEnabled || bestDownloadState !== 'idle'}
          onClick={() => bestLink && onDownload(bestLink)}
        >
          <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t('installableAssetRecommendation.download-this-build')}
        </Button>
      </div>

      {alternatives.length > 0 && (
        <div className="mt-2 border-t border-border pt-2">
          <p className="mb-1 text-[11px] text-muted-foreground">
            {t('installableAssetRecommendation.other-candidates-v1', { v1: alternatives.length })}
          </p>
          <ul className="space-y-1">
            {alternatives.map((match) => {
              const link = linksByAssetId.get(match.assetId);
              const downloadState = link
                ? downloadStates[computeRpcDownloadKey(link)] ?? 'idle'
                : 'idle';
              return (
                <li key={match.assetId} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-[11px]" title={match.fileName}>
                    {match.fileName}
                    <span className="ml-1 text-muted-foreground">
                      {describe(match)} · {formatFileSize(match.size)}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    disabled={!link || !downloadEnabled || downloadState !== 'idle'}
                    onClick={() => link && onDownload(link)}
                  >
                    {t('installableAssetRecommendation.download')}
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <p className="mt-2 flex items-start gap-1 text-[11px] text-muted-foreground">
        <ShieldQuestion className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
        <span>
          {t('installableAssetRecommendation.detected-from-filenames-and-release-metadata-no')}
        </span>
      </p>

      {detection.excluded.length > 0 && (
        <p className="mt-1 flex items-start gap-1 text-[11px] text-muted-foreground">
          <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>
            {t('installableAssetRecommendation.excluded-v1-asset-s-that-do-not-apply-to-this-de', { v1: detection.excluded.length })}
          </span>
        </p>
      )}
    </section>
  );
};

export default InstallableAssetRecommendation;
