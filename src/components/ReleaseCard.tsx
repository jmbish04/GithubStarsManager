import { getDateFnsLocale, getIntlLocale } from '../i18n/format';
import { useT } from "../i18n/useT";
import type { AppLanguage } from '../i18n/languages';
import React, { memo, useCallback, useMemo, useState, useEffect } from 'react';
import { ExternalLink, GitBranch, Calendar, Download, ChevronDown, ChevronUp, BookOpen, ArrowUpRight, FolderOpen, Folder, BellOff, FileArchive, Code2, Loader2, CheckCircle2, Sparkles } from 'lucide-react';
import { Release } from '../types';
import { formatDistanceToNow } from 'date-fns';
import MarkdownRenderer from './MarkdownRenderer';
import AssetLeadingIcon from './AssetLeadingIcon';
import { useAppStore } from '../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { computeRpcDownloadKey, useReleaseArtifactActions } from '../hooks/useReleaseArtifactActions';
import {
  effectiveReleaseTime,
  shouldShowAssetsUpdatedIndicator,
} from '../utils/releaseAssets';
import { Button } from './ui/button';
import { ReleasePluginRecommendations } from './ReleasePluginRecommendations';

interface DownloadLink {
  name: string;
  url: string;
  size: number;
  downloadCount: number;
  isSourceCode?: boolean;
  assetId?: number;
  updatedAt?: string;
  contentType?: string;
}

/** Relative asset time: omit rendering when updated_at is invalid to avoid date-fns throwing on Invalid Date; uses zhCN in Chinese UI. */
const AssetUpdatedTime = ({ updatedAt, language }: { updatedAt?: string; language: AppLanguage }) => {
  if (!updatedAt) return null;
  const time = new Date(updatedAt).getTime();
  if (Number.isNaN(time)) return null;
  return (
    <span title={new Date(time).toLocaleString()}>
      {formatDistanceToNow(new Date(time), {
        addSuffix: true,
        locale: getDateFnsLocale(language),
      })}
    </span>
  );
};

interface ReleaseCardProps {
  release: Release;
  /** Default download links to display: only assets matching active filters when filtering is enabled. */
  downloadLinks: DownloadLink[];
  /** All download links for this release (untrimmed); defaults to downloadLinks when omitted. */
  allDownloadLinks?: DownloadLink[];
  isUnread: boolean;
  isAssetsExpanded: boolean;
  isReleaseNotesExpanded: boolean;
  isFullContent: boolean;
  truncatedBody: string;
  onToggleAssets: () => void;
  onToggleReleaseNotes: () => void;
  onToggleFullContent: (e: React.MouseEvent) => void;
  onUnsubscribe: () => void;
  onMarkAsRead: () => void;
  onMarkAssetAsRead: (assetId: number) => void;
  language: AppLanguage;
  formatFileSize: (bytes: number) => string;
}

const ReleaseCard: React.FC<ReleaseCardProps> = memo(({
  release,
  downloadLinks,
  allDownloadLinks,
  isUnread,
  isAssetsExpanded,
  isReleaseNotesExpanded,
  isFullContent,
  truncatedBody,
  onToggleAssets,
  onToggleReleaseNotes,
  onToggleFullContent,
  onUnsubscribe,
  onMarkAsRead,
  onMarkAssetAsRead,
  language,
  formatFileSize,
}) => {
  const t = useT('releases');

  const effectiveTime = effectiveReleaseTime(release);
  const showAssetsUpdatedIndicator = shouldShowAssetsUpdatedIndicator(release);

  // RPC dispatch and AI summary actions are delegated to a shared hook (mirrors useRepositoryReleaseSheet).
  const { rpcDownloadConfig } = useAppStore(useShallow((state) => ({
    rpcDownloadConfig: state.rpcDownloadConfig,
  })));
  const { summaries, rpcDownloadStates, sendRpcDownload, generateSummary } = useReleaseArtifactActions();
  // AI summary state is managed inside the hook (expansion state remains local to the card and is not persisted);
  // request cancellation on unmount is handled by the hook's cleanup effect.
  const [isSummaryExpanded, setIsSummaryExpanded] = useState(false);
  const summary = useMemo(() => summaries[release.id] ?? { status: 'idle' as const }, [summaries, release.id]);

  // Asset list trimming: assets matching enabled filters are displayed by default, while unmatched assets can be expanded on demand.
  // "Expand all" state tracks the **signature of the currently matched asset set** rather than a boolean:
  // switching filters or editing keywords resets to "show matched assets only", preventing stale expansion state
  // from making filters appear broken. Expansion state is local to the card and not persisted, matching assets/changelog/summary expansion behavior.
  const everyDownloadLink = allDownloadLinks ?? downloadLinks;
  const hiddenDownloadCount = Math.max(everyDownloadLink.length - downloadLinks.length, 0);
  const matchedLinksSignature = downloadLinks.map(link => link.name).join('\u0000');
  const [expandedAllSignature, setExpandedAllSignature] = useState<string | null>(null);
  const isShowingAllAssets = hiddenDownloadCount > 0 && expandedAllSignature === matchedLinksSignature;
  const visibleDownloadLinks = isShowingAllAssets ? everyDownloadLink : downloadLinks;

  const handleToggleAllAssets = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedAllSignature(current =>
      current === matchedLinksSignature ? null : matchedLinksSignature
    );
  }, [matchedLinksSignature]);

  // Auto-expand on completion or failure (matches setIsSummaryExpanded(true) in runSummaryAnalysis success/error branches)
  useEffect(() => {
    if (summary.status === 'done' || summary.status === 'error') {
      setIsSummaryExpanded(true);
    }
  }, [summary.status]);

  // Check whether any section is expanded
  const isAnyExpanded = isAssetsExpanded || isReleaseNotesExpanded || isSummaryExpanded;

  const handleRpcDownload = useCallback(async (link: DownloadLink) => {
    await sendRpcDownload(link);
  }, [sendRpcDownload]);

  const handleToggleSummary = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();

    // When already expanded: collapse (collapses error states too; clicking a collapsed error state retries)
    if (isSummaryExpanded) {
      setIsSummaryExpanded(false);
      return;
    }

    // Already summarized and collapsed -> expand directly without re-analyzing
    if (summary.status === 'done' && summary.content) {
      setIsSummaryExpanded(true);
      return;
    }

    // Not yet analyzed or previously failed -> trigger AI analysis (spins button, auto-expands on completion)
    await generateSummary(release);
  }, [isSummaryExpanded, summary, generateSummary, release]);

  return (
    <div
      onClick={onMarkAsRead}
      className={`release-card ui-card transition-all duration-200 ease-in-out cursor-pointer ${
        isAnyExpanded ? 'is-expanded' : ''
      }`}
    >
      {/* Header area - displays metadata only, not clickable for expansion */}
      <div className="p-3 sm:p-4">
        <div className="flex items-stretch justify-between gap-3">
          <div className="flex items-center min-w-0 flex-1">
            {isUnread && (
              <div className="w-1.5 h-1.5 bg-primary rounded-full flex-shrink-0 animate-pulse mr-2"></div>
            )}
            <div className="linear-platform-icon flex items-center justify-center w-8 h-8 flex-shrink-0">
              <GitBranch className="w-4 h-4 text-muted-foreground dark:text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1 ml-3">
              <div className="flex items-center gap-2 min-w-0 flex-wrap">
                  <h4 className="font-semibold text-foreground dark:text-foreground text-sm truncate">
                    {release.repository.name}
                  </h4>
                  <span className="linear-card-tag px-1.5 py-0.5 text-xs font-medium shrink-0">
                    {release.tag_name}
                  </span>
                  {release.name && release.name !== release.tag_name && (
                    <span className="text-xs text-muted-foreground dark:text-muted-foreground truncate max-w-[200px]">
                      {release.name}
                    </span>
                  )}
              </div>
              <p className="text-xs text-muted-foreground dark:text-muted-foreground/70 truncate mt-1">
                {release.repository.full_name}
              </p>
            </div>
          </div>

          {/* Metadata column has no rigid upper width limit: when the "assets updated" badge appears, the row expands to the left (min-w ensures
              140px alignment when no badge is present). Otherwise, 140px cannot fit the badge without wrapping both time and badge text;
              the button area stays pinned to the right at 344px. */}
          <div className="flex items-center gap-6 flex-shrink-0 self-center md:justify-end">
            <div className="hidden md:flex md:min-w-[140px] shrink-0 flex-col justify-center gap-1.5 text-xs text-muted-foreground dark:text-muted-foreground">
              <div className="flex items-center gap-1.5 whitespace-nowrap">
                <Calendar className="w-3.5 h-3.5" />
                <span>
                  {formatDistanceToNow(new Date(effectiveTime), {
                    addSuffix: true,
                    locale: getDateFnsLocale(language),
                  })}
                </span>
                {showAssetsUpdatedIndicator && (
                  <span className="text-xs px-1 py-px rounded bg-primary/10 text-primary font-medium">
                    {t('releaseCard.assets-updated')}
                  </span>
                )}
              </div>
              {downloadLinks.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <Download className="w-3.5 h-3.5" />
                  <span>{visibleDownloadLinks.length}</span>
                </div>
              )}
            </div>
            {/* Fixed width must accommodate five controls in English (Assets/Notes/Summary + 2 icons, ~340px) to prevent button wrapping */}
            <div className="flex items-center justify-end gap-1 flex-shrink-0 md:w-[344px] md:min-w-[344px]">
            {downloadLinks.length > 0 && (
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleAssets();
                }}
                variant={isAssetsExpanded ? 'secondary' : 'ghost'}
                className="h-8 gap-1 px-2 text-xs whitespace-nowrap"
                title={isAssetsExpanded ? t('releaseCard.hide-assets') : t('releaseCard.show-assets')}
                aria-label={isAssetsExpanded ? t('releaseCard.hide-assets') : t('releaseCard.show-assets')}
                aria-expanded={isAssetsExpanded}
              >
                {isAssetsExpanded ? <FolderOpen className="w-3.5 h-3.5" /> : <Folder className="w-3.5 h-3.5" />}
                <span className="text-xs font-medium">{isAssetsExpanded ? t('releaseCard.hide') : t('releaseCard.assets')}</span>
                {isAssetsExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </Button>
            )}

            {release.body && (
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleReleaseNotes();
                }}
                variant={isReleaseNotesExpanded ? 'secondary' : 'ghost'}
                className="h-8 gap-1 px-2 text-xs whitespace-nowrap"
                title={isReleaseNotesExpanded ? t('releaseCard.hide-changelog') : t('releaseCard.show-changelog')}
                aria-label={isReleaseNotesExpanded ? t('releaseCard.hide-changelog') : t('releaseCard.show-changelog')}
                aria-expanded={isReleaseNotesExpanded}
              >
                <BookOpen className="w-3.5 h-3.5" />
                <span className="text-xs font-medium">{isReleaseNotesExpanded ? t('releaseCard.hide') : t('releaseCard.notes')}</span>
                {isReleaseNotesExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </Button>
            )}

            {release.body?.trim() && (
              <Button
                onClick={handleToggleSummary}
                disabled={summary.status === 'loading'}
                variant={isSummaryExpanded ? 'secondary' : 'ghost'}
                className="h-8 gap-1 px-2 text-xs whitespace-nowrap disabled:opacity-70"
                title={isSummaryExpanded ? t('releaseCard.hide-ai-summary') : (summary.status === 'error' ? t('releaseCard.retry-ai-summary') : t('releaseCard.ai-summary-of-this-update'))}
                aria-label={isSummaryExpanded ? t('releaseCard.hide-ai-summary') : (summary.status === 'error' ? t('releaseCard.retry-ai-summary') : t('releaseCard.ai-summary-of-this-update'))}
                aria-expanded={isSummaryExpanded}
              >
                {summary.status === 'loading' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5" />
                )}
                <span className="text-xs font-medium">{t('releaseCard.summary')}</span>
                {summary.status !== 'loading' && (isSummaryExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)}
              </Button>
            )}

            <Button
              onClick={(e) => {
                e.stopPropagation();
                onUnsubscribe();
              }}
              className="h-auto p-1 rounded bg-muted text-muted-foreground dark:bg-muted/40 dark:text-muted-foreground hover:bg-accent hover:text-foreground dark:hover:bg-accent dark:hover:text-foreground transition-colors"
              title={t('releaseCard.unsubscribe-from-releases')}
              aria-label={t('releaseCard.unsubscribe-from-releases')}
            >
              <BellOff className="w-3.5 h-3.5" />
            </Button>
            <a
              href={release.html_url}
              target="_blank"
              rel="noopener noreferrer"
              className="h-auto p-1 rounded bg-muted text-muted-foreground dark:bg-muted/40 dark:text-muted-foreground hover:bg-accent hover:text-foreground dark:hover:bg-accent dark:hover:text-foreground transition-colors"
              title={t('releaseCard.view-on-github')}
              aria-label={t('releaseCard.view-on-github')}
              onClick={(e) => {
                e.stopPropagation();
                onMarkAsRead();
              }}
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
          </div>
        </div>
      </div>

      {/* Expandable content area */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-in-out"
        style={{ gridTemplateRows: (isAssetsExpanded || isReleaseNotesExpanded || isSummaryExpanded) ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden min-h-0">
          <div className="px-3 sm:px-4 pb-3 sm:pb-4 pt-3 sm:pt-4 border-t border-border dark:border-border">
          {isAssetsExpanded && visibleDownloadLinks.length > 0 && (
            <div className="py-2">
              <ReleasePluginRecommendations release={release} language={language} />
              <div className="flex items-center justify-between gap-2 mb-3">
                <div className="flex items-center space-x-2 min-w-0">
                  <FileArchive className="w-3.5 h-3.5 text-muted-foreground dark:text-muted-foreground flex-shrink-0" />
                  <span className="text-xs font-medium text-foreground dark:text-muted-foreground">
                    {t('releaseCard.download-files')}
                  </span>
                  <span className="text-xs text-muted-foreground dark:text-muted-foreground">
                    ({visibleDownloadLinks.length})
                  </span>
                </div>
                {hiddenDownloadCount > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={handleToggleAllAssets}
                    aria-pressed={isShowingAllAssets}
                    className="h-auto flex-shrink-0 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 dark:text-primary dark:hover:bg-primary/20"
                  >
                    {isShowingAllAssets
                      ? t('releaseCard.show-matching-assets-only', { count: downloadLinks.length })
                      : t('releaseCard.show-all-assets', { count: everyDownloadLink.length })}
                  </Button>
                )}
              </div>

              <div className="ui-inset-surface max-h-72 overflow-hidden overflow-y-auto">
                {visibleDownloadLinks.map((link, index) => {
                  const isRpcEnabled = rpcDownloadConfig.enabled;
                  // Uses the same versioned key as sendRpcDownload
                  const rpcKey = computeRpcDownloadKey(link);
                  const isDownloading = rpcDownloadStates[rpcKey] === 'sending';
                  const isDownloaded = rpcDownloadStates[rpcKey] === 'sent';
                  const isAssetUpdated = link.assetId !== undefined
                    && release.updated_asset_ids?.includes(link.assetId) === true;

                  if (isRpcEnabled) {
                    return (
                      <Button
                        key={index}
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (link.assetId !== undefined) onMarkAssetAsRead(link.assetId);
                          handleRpcDownload(link);
                        }}
                        disabled={isDownloading}
                        className={`h-auto flex items-center justify-between rounded-none px-4 py-3 w-full text-left hover:bg-muted dark:hover:bg-accent transition-colors border-b border-border last:border-b-0 disabled:opacity-60 ${
                          link.isSourceCode ? 'bg-accent/60' : ''
                        }`}
                      >
                        <div className="flex items-center space-x-1.5 min-w-0 flex-1">
                          {isDownloading ? (
                            <Loader2 className="w-3.5 h-3.5 text-muted-foreground animate-spin flex-shrink-0" />
                          ) : isDownloaded ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-success flex-shrink-0" />
                          ) : link.isSourceCode ? (
                            <Code2 className="w-3.5 h-3.5 text-muted-foreground dark:text-muted-foreground flex-shrink-0" />
                          ) : (
                            <AssetLeadingIcon name={link.name} contentType={link.contentType} />
                          )}
                          <span className={`text-sm truncate ${link.isSourceCode ? 'text-muted-foreground dark:text-muted-foreground font-medium' : 'text-foreground dark:text-muted-foreground'}`}>
                            {link.name}
                          </span>
                        </div>
                        <div className="flex items-center space-x-2 text-xs text-muted-foreground dark:text-muted-foreground flex-shrink-0">
                          {isAssetUpdated && (
                            <span className="text-xs px-1 py-px rounded bg-primary/10 text-primary font-medium whitespace-nowrap">
                              {t('releaseCard.asset-updated')}
                            </span>
                          )}
                          <AssetUpdatedTime updatedAt={link.updatedAt} language={language} />
                          {link.size > 0 && (
                            <span>{formatFileSize(link.size)}</span>
                          )}
                          {link.downloadCount > 0 && (
                            <span>{t('releaseCard.download-count', { count: link.downloadCount.toLocaleString(getIntlLocale(language)) })}</span>
                          )}
                        </div>
                      </Button>
                    );
                  }

                  return (
                    <a
                      key={index}
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`flex items-center justify-between px-4 py-3 hover:bg-muted dark:hover:bg-accent transition-colors border-b border-border last:border-b-0 ${
                        link.isSourceCode ? 'bg-accent/60' : ''
                      }`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (link.assetId !== undefined) onMarkAssetAsRead(link.assetId);
                      }}
                    >
                      <div className="flex items-center space-x-1.5 min-w-0 flex-1">
                        {link.isSourceCode ? (
                          <Code2 className="w-3.5 h-3.5 text-muted-foreground dark:text-muted-foreground flex-shrink-0" />
                        ) : (
                          <AssetLeadingIcon name={link.name} contentType={link.contentType} />
                        )}
                        <span className={`text-sm truncate ${link.isSourceCode ? 'text-muted-foreground dark:text-muted-foreground font-medium' : 'text-foreground dark:text-muted-foreground'}`}>
                          {link.name}
                        </span>
                      </div>
                      <div className="flex items-center space-x-2 text-xs text-muted-foreground dark:text-muted-foreground flex-shrink-0">
                        {isAssetUpdated && (
                          <span className="text-xs px-1 py-px rounded bg-primary/10 text-primary font-medium whitespace-nowrap">
                            {t('releaseCard.asset-updated')}
                          </span>
                        )}
                        <AssetUpdatedTime updatedAt={link.updatedAt} language={language} />
                        {link.size > 0 && (
                          <span>{formatFileSize(link.size)}</span>
                        )}
                        {link.downloadCount > 0 && (
                          <span>{t('releaseCard.download-count', { count: link.downloadCount.toLocaleString(getIntlLocale(language)) })}</span>
                        )}
                      </div>
                    </a>
                  );
                })}
              </div>
            </div>
          )}

          {isReleaseNotesExpanded && release.body && (
            <div className="py-2">
              <div className="flex items-center space-x-2 mb-3">
                <BookOpen className="w-3.5 h-3.5 text-muted-foreground dark:text-muted-foreground" />
                <span className="text-xs font-medium text-foreground dark:text-muted-foreground">
                  {t('releaseCard.release-notes')}
                </span>
              </div>

              <div className="rounded-md border border-border bg-background px-5 pt-5 pb-4 dark:border-border dark:bg-muted/30">
                <MarkdownRenderer
                  content={isFullContent ? (release.body || '') : truncatedBody}
                  shouldRender={true}
                  fontSize="small"
                  baseUrl={`https://github.com/${release.repository.full_name}`}
                />

                {(release.body || '').length > truncatedBody.length && (
                  <div className="mt-3 flex items-center justify-center space-x-2">
                    <Button
                      variant="default"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleFullContent(e);
                      }}
                      className="h-auto flex items-center justify-center space-x-1 px-3 py-1.5 rounded hover:bg-primary/90 active:bg-primary/80 dark:bg-primary dark:text-primary-foreground dark:hover:bg-primary/90 dark:active:bg-primary/80 transition-all duration-200 text-xs font-medium min-w-[120px]"
                    >
                      <BookOpen className="w-3 h-3" />
                      <span>{isFullContent ? t('releaseCard.collapse') : t('releaseCard.view-full')}</span>
                    </Button>
                    <a
                      href={release.html_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-center space-x-1 px-3 py-1.5 bg-muted text-foreground rounded hover:bg-accent hover:text-accent-foreground active:bg-accent/80 dark:bg-muted/40 dark:text-foreground dark:hover:bg-accent dark:hover:text-accent-foreground dark:active:bg-accent/80 transition-all duration-200 text-xs font-medium whitespace-nowrap"
                      onClick={(e) => {
                        e.stopPropagation();
                        onMarkAsRead();
                      }}
                    >
                      <ArrowUpRight className="w-3.5 h-3.5" />
                      <span>{t('releaseCard.github')}</span>
                    </a>
                  </div>
                )}
              </div>
            </div>
          )}
          {isSummaryExpanded && release.body?.trim() && (
            <div className="py-2">
              <div className="flex items-center space-x-2 mb-3">
                <Sparkles className="w-3.5 h-3.5 text-muted-foreground dark:text-muted-foreground" />
                <span className="text-xs font-medium text-foreground dark:text-muted-foreground">
                  {t('releaseCard.ai-summary')}
                </span>
              </div>

              <div className="relative">
                {summary.status === 'loading' && (
                  <div className="flex items-center justify-center space-x-2 py-6 text-xs text-muted-foreground dark:text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>{t('releaseCard.analyzing-update')}</span>
                  </div>
                )}
                {summary.status === 'done' && summary.content && (
                  <MarkdownRenderer content={summary.content} shouldRender={true} breaks={true} />
                )}
                {summary.status === 'error' && (
                  <div className="py-3 text-xs text-destructive">
                    {t('releaseCard.failed-to-generate-summary-please-try-again')}
                  </div>
                )}
              </div>
            </div>
          )}
          </div>
        </div>
      </div>
    </div>
  );
});

ReleaseCard.displayName = 'ReleaseCard';

export default ReleaseCard;
