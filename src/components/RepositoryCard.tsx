
import { getDateFnsLocale, getIntlLocale } from '../i18n/format';
import { useT, type TranslateFn } from '../i18n/useT';
import type { AppLanguage } from '../i18n/languages';
import React, { Suspense, useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  getPlatformDisplayName,
  getPlatformIcon,
} from './platformMeta';
import { useRepositoryPlatforms } from '../hooks/useRepositoryPlatforms';
import { GripVertical, Star, StarOff, ExternalLink, Calendar, Bell, BellOff, Bot, Sparkles, Terminal, Edit3, BookOpen, Square, CheckSquare, Loader2, HelpCircle, Search, Scale, MoreHorizontal, PackageOpen, MessageSquareText, Plug } from 'lucide-react';
import { Repository, Category } from '../types';
import { useAppStore } from '../store/useAppStore';
import { isRepositoryCardFieldVisible } from '../utils/repositoryCardFields';
import { normalizeRepositoryCardActions } from '../utils/repositoryCardActions';
import type { RepositoryCardActionId, RepositoryCardActionPreference } from '../types/repositoryCardActions';
import { useRepositoryDragStore } from '../store/useRepositoryDragStore';
import { getAICategory, getDefaultCategory } from '../utils/categoryUtils';
import { formatDistanceToNow } from 'date-fns';
import { RepositoryEditModal } from './RepositoryEditModal';
import { ErrorBoundary } from './ErrorBoundary';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { NO_LICENSE_SENTINEL, normalizeLicense } from '../utils/licenseFilter';
import { useRepositoryCardActions } from '../features/repositories/hooks/useRepositoryCardActions';
import { useTranslatedDescription } from '../hooks/useTranslatedDescription';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';
import { usePluginActions } from '../plugins/hooks/usePluginActions';
import { applyPluginActionResult } from '../plugins/applyPluginActionResult';
import { useDialog } from '../hooks/useDialog';
import { pluginClient } from '../plugins/pluginClient';
import { pluginPageSession } from '../plugins/pluginPageSession';
import type { RegisteredPluginAction } from '../plugins/types';

type DialogContentPointerDownOutsideHandler = NonNullable<
  React.ComponentProps<typeof DialogContent>['onPointerDownOutside']
>;

const LazyReadmeModal = React.lazy(() =>
  import('./ReadmeModal').then((module) => ({ default: module.ReadmeModal }))
);

const LazyRepositoryReleaseSheet = React.lazy(() =>
  import('./RepositoryReleaseSheet').then((module) => ({ default: module.RepositoryReleaseSheet }))
);

const ReadmeModalLoadingFallback: React.FC<{
  onClose: () => void;
  onCloseAutoFocus: () => void;
}> = ({ onClose, onCloseAutoFocus }) => (
  <Dialog open onOpenChange={(open) => !open && onClose()}>
    <DialogContent
      aria-describedby={undefined}
      className="flex h-[calc(100vh_-_2rem)] max-h-[calc(100vh_-_2rem)] w-[calc(100vw_-_2rem)] max-w-none flex-col overflow-hidden p-6"
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        onCloseAutoFocus();
      }}
    >
      <DialogTitle className="sr-only">Loading README</DialogTitle>
      <div className="flex flex-1 flex-col items-center justify-center gap-4" role="status" aria-live="polite">
        <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
        <p className="text-muted-foreground">Loading README…</p>
      </div>
    </DialogContent>
  </Dialog>
);

const ReleaseSheetLoadingFallback: React.FC<{
  onClose: () => void;
  onCloseAutoFocus: () => void;
  onPointerDownOutside: DialogContentPointerDownOutsideHandler;
}> = ({ onClose, onCloseAutoFocus, onPointerDownOutside }) => (
  <Dialog open onOpenChange={(open) => !open && onClose()}>
    <DialogContent
      aria-describedby={undefined}
      className="w-[calc(100%_-_2rem)] max-w-sm p-6"
      onPointerDownOutside={onPointerDownOutside}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        onCloseAutoFocus();
      }}
    >
      <DialogTitle className="sr-only">Loading releases</DialogTitle>
      <div className="flex min-h-40 flex-col items-center justify-center gap-4" role="status" aria-live="polite">
        <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
        <p className="text-muted-foreground">Loading releases…</p>
      </div>
    </DialogContent>
  </Dialog>
);

// Selection-aware button component to centralize selectionMode disable logic
interface SelectionAwareButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  selectionMode?: boolean;
  children: React.ReactNode;
  variant?: 'default' | 'ai' | 'subscribe' | 'edit' | 'unstar';
}

const SelectionAwareButton: React.FC<SelectionAwareButtonProps> = ({
  selectionMode,
  children,
  variant = 'default',
  className = '',
  disabled,
  onClick,
  ...props
}) => {
  const baseClasses = 'h-8 w-8 p-0 rounded-md transition-colors disabled:opacity-50';
  const selectionClasses = selectionMode ? 'pointer-events-none' : '';

  const variantClasses = {
    default: '',
    ai: '', // AI variant uses dynamic classes based on state
    subscribe: '', // Subscribe variant uses dynamic classes based on state
    edit: 'bg-muted text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
    unstar: 'bg-muted text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed',
  };

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    // Stop event propagation to prevent triggering card click event
    e.stopPropagation();
    onClick?.(e);
  };

  return (
    <Button
      {...props}
      size="icon"
      onClick={handleClick}
      disabled={disabled || selectionMode}
      className={`${baseClasses} ${variantClasses[variant]} ${selectionClasses} ${className}`}
    >
      {children}
    </Button>
  );
};

interface RepositoryCardProps {
  repository: Repository;
  showAISummary?: boolean;
  searchQuery?: string;
  isSelected?: boolean;
  onSelect?: (id: number) => void;
  selectionMode?: boolean;
  isExitingSelection?: boolean;
  allCategories: Category[];
  viewMode?: 'grid' | 'list';
  onAskRepository?: (repository: Repository) => void;
}

const PluginRepositoryActionItems: React.FC<{
  actions: RegisteredPluginAction[];
  repository: Repository;
  language: AppLanguage;
}> = ({ actions, repository, language }) => {
  const { toast } = useDialog();
  const t = useT('repositories');

  const run = async (action: RegisteredPluginAction) => {
    try {
      const operation = await pluginClient.runAction({
        pluginId: action.pluginId,
        actionId: action.id,
        repositories: [repository],
      });
      if (!operation.success) {
        toast(operation.error.message, 'error');
        return;
      }
      await applyPluginActionResult(operation.result, toast, language);
    } catch {
      toast(t('repositoryCard.failed-to-apply-plugin-result'), 'error');
    }
  };

  return actions.map((action) => (
    <DropdownMenuItem
      key={`${action.pluginId}:${action.id}`}
      onSelect={() => (action.opensPage
        // The modal is rendered by PluginPageHost on the app root, so closing the menu will not unmount it.
        ? pluginPageSession.open({
          pluginId: action.pluginId,
          pluginName: action.pluginName,
          pageId: action.opensPage,
          pageTitle: action.title,
          repository,
        })
        : void run(action))}
    >
      <Plug className="mr-2 h-3.5 w-3.5" />
      {action.title}
    </DropdownMenuItem>
  ));
};

const MAX_CACHE_SIZE = 500;
const ACTION_SLOT_WIDTH = 32;
const ACTION_SLOT_GAP = 6;
const ACTION_SLOT_STRIDE = ACTION_SLOT_WIDTH + ACTION_SLOT_GAP;

const highlightCache = new Map<string, React.ReactNode>();

/**
 * Counts quick actions that fit beside the persistent More actions button.
 * A zero width means the row has not been measured yet, so all primary actions
 * remain visible until layout supplies a usable width.
 *
 * @param width - Available action-row width in pixels.
 * @param primaryActionCount - Number of primary quick actions.
 * @returns Number of primary actions to render outside the menu.
 */
const countVisibleOverflowActions = (
  width: number,
  primaryActionCount: number,
): number => {
  if (width === 0) return primaryActionCount;
  const capacity = Math.max(1, Math.floor((width + ACTION_SLOT_GAP) / ACTION_SLOT_STRIDE));
  return Math.max(0, Math.min(primaryActionCount, capacity - 1));
};

const mutedIconButtonClass =
  'bg-muted text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground';

interface OverflowActionRowProps {
  actionRowRef: React.Ref<HTMLDivElement>;
  testId: string;
  className: string;
  visibleActionCount: number;
  primaryActionCount: number;
  actionPreferences: RepositoryCardActionPreference[];
  selectionMode: boolean;
  onAskRepository?: (repository: Repository) => void;
  repository: Repository;
  language: AppLanguage;
  docsUrl: string;
  githubUrl: string;
  aiButtonTitle: string;
  isAnalyzing: boolean;
  isSubscribed: boolean;
  unstarring: boolean;
  vectorSearchAvailable?: boolean;
  isFindingSimilar?: boolean;
  onFindSimilar?: () => void;
  persistFindSimilarInMenu?: boolean;
  pluginActions: RegisteredPluginAction[];
  isActionsMenuOpen?: boolean;
  onActionsMenuOpenChange?: (open: boolean) => void;
  onAnalyze: () => void;
  onAsk?: () => void;
  onToggleReleaseSubscription: () => void;
  onEdit: () => void;
  editButtonTitle: string;
  onViewReleases: () => void;
  onUnstar: () => void;
  menuAlign?: 'start' | 'end';
  onMenuPointerDownOutside?: (target: Node) => void;
  t: TranslateFn;
}

const OverflowActionRow: React.FC<OverflowActionRowProps> = ({
  actionRowRef,
  testId,
  className,
  visibleActionCount,
  primaryActionCount,
  actionPreferences,
  selectionMode,
  onAskRepository,
  repository,
  language,
  docsUrl,
  githubUrl,
  aiButtonTitle,
  isAnalyzing,
  isSubscribed,
  unstarring,
  vectorSearchAvailable = false,
  isFindingSimilar = false,
  onFindSimilar,
  persistFindSimilarInMenu = false,
  pluginActions,
  isActionsMenuOpen,
  onActionsMenuOpenChange,
  onAnalyze,
  onAsk,
  onToggleReleaseSubscription,
  onEdit,
  editButtonTitle,
  onViewReleases,
  onUnstar,
  menuAlign = 'start',
  onMenuPointerDownOutside,
  t,
}) => {
  const availableActions = actionPreferences.filter((item) => item.id !== 'ask' || onAskRepository);
  const inlineCandidates = availableActions.filter((item) => item.visible);
  const inlineActionIds = inlineCandidates.slice(0, visibleActionCount).map((item) => item.id);
  const inlineActionSet = new Set(inlineActionIds);
  const overflowActionIds = availableActions.filter((item) => !inlineActionSet.has(item.id)).map((item) => item.id);
  const showFindSimilarInMenu = Boolean(vectorSearchAvailable && onFindSimilar && (persistFindSimilarInMenu || visibleActionCount < primaryActionCount));
  const hasActionsAbovePlugins = overflowActionIds.length > 0 || showFindSimilarInMenu;
  const hasActionsAboveUnstar = hasActionsAbovePlugins || pluginActions.length > 0;
  const menuOpenProps = onActionsMenuOpenChange
    ? { open: isActionsMenuOpen, onOpenChange: onActionsMenuOpenChange }
    : {};

  const inlineActionNodes: Record<RepositoryCardActionId, React.ReactNode> = {
    analyze: (
      <SelectionAwareButton onClick={onAnalyze} disabled={isAnalyzing} selectionMode={selectionMode}
        className={mutedIconButtonClass} title={aiButtonTitle} aria-label={aiButtonTitle}>
        {isAnalyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bot className="w-4 h-4" />}
      </SelectionAwareButton>
    ),
    ask: (
      <SelectionAwareButton onClick={onAsk} selectionMode={selectionMode} className={mutedIconButtonClass}
        title={t('repositoryCard.ask-this-repository')} aria-label={t('repositoryCard.ask-this-repository')}>
        <MessageSquareText className="w-4 h-4" />
      </SelectionAwareButton>
    ),
    subscribe: (
      <SelectionAwareButton onClick={onToggleReleaseSubscription} selectionMode={selectionMode}
        className={isSubscribed ? 'bg-primary text-primary-foreground shadow-sm' : mutedIconButtonClass}
        title={isSubscribed ? t('repositoryCard.unsubscribe-from-releases-2') : t('repositoryCard.subscribe-to-releases-2')}
        aria-label={isSubscribed ? t('repositoryCard.unsubscribe-from-releases-2') : t('repositoryCard.subscribe-to-releases-2')}
        aria-pressed={isSubscribed}>
        {isSubscribed ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
      </SelectionAwareButton>
    ),
    edit: (
      <SelectionAwareButton onClick={onEdit} selectionMode={selectionMode} variant="edit"
        title={editButtonTitle} aria-label={t('repositoryCard.edit-repository-info')}>
        <Edit3 className="w-4 h-4" />
      </SelectionAwareButton>
    ),
    releases: (
      <SelectionAwareButton onClick={onViewReleases} selectionMode={selectionMode} className={mutedIconButtonClass}
        title={t('repositoryCard.view-releases')} aria-label={t('repositoryCard.view-releases')}>
        <PackageOpen className="w-4 h-4" />
      </SelectionAwareButton>
    ),
    docs: (
      <a href={docsUrl} target="_blank" rel="noopener noreferrer"
        onClick={(event) => selectionMode && event.preventDefault()}
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${mutedIconButtonClass} ${selectionMode ? 'pointer-events-none opacity-50' : ''}`}
        title={t('repositoryCard.view-on-deepwiki-2')}>
        <BookOpen className="w-4 h-4" />
      </a>
    ),
    github: (
      <a href={githubUrl} target="_blank" rel="noopener noreferrer"
        onClick={(event) => selectionMode && event.preventDefault()}
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${mutedIconButtonClass} ${selectionMode ? 'pointer-events-none opacity-50' : ''}`}
        title={t('repositoryCard.view-on-github-2')}>
        <ExternalLink className="w-4 h-4" />
      </a>
    ),
  };
  const menuActionNodes: Record<RepositoryCardActionId, React.ReactNode> = {
    analyze: (
      <DropdownMenuItem disabled={isAnalyzing} onSelect={() => void onAnalyze()}>
        {isAnalyzing ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Bot className="mr-2 h-3.5 w-3.5" />}
        {t('repositoryCard.analyze-with-ai-2')}
      </DropdownMenuItem>
    ),
    ask: (
      <DropdownMenuItem onSelect={() => onAsk?.()}>
        <MessageSquareText className="mr-2 h-3.5 w-3.5" />
        {t('repositoryCard.ask-this-repository')}
      </DropdownMenuItem>
    ),
    subscribe: (
      <DropdownMenuItem onSelect={onToggleReleaseSubscription}>
        {isSubscribed ? <Bell className="mr-2 h-3.5 w-3.5" /> : <BellOff className="mr-2 h-3.5 w-3.5" />}
        {isSubscribed ? t('repositoryCard.unsubscribe-from-releases') : t('repositoryCard.subscribe-to-releases')}
      </DropdownMenuItem>
    ),
    edit: (
      <DropdownMenuItem onSelect={onEdit}>
        <Edit3 className="mr-2 h-3.5 w-3.5" />
        {t('repositoryCard.edit-repository-info')}
      </DropdownMenuItem>
    ),
    releases: (
      <DropdownMenuItem onSelect={onViewReleases}>
        <PackageOpen className="mr-2 h-3.5 w-3.5" />
        {t('repositoryCard.view-releases')}
      </DropdownMenuItem>
    ),
    docs: (
      <DropdownMenuItem asChild>
        <a href={docsUrl} target="_blank" rel="noopener noreferrer">
          <BookOpen className="mr-2 h-3.5 w-3.5" />
          {t('repositoryCard.view-on-deepwiki')}
        </a>
      </DropdownMenuItem>
    ),
    github: (
      <DropdownMenuItem asChild>
        <a href={githubUrl} target="_blank" rel="noopener noreferrer">
          <ExternalLink className="mr-2 h-3.5 w-3.5" />
          {t('repositoryCard.view-on-github')}
        </a>
      </DropdownMenuItem>
    ),
  };

  return (
    <div ref={actionRowRef} data-testid={testId} className={className}>
      {inlineActionIds.map((id) => <React.Fragment key={id}>{inlineActionNodes[id]}</React.Fragment>)}
      <DropdownMenu {...menuOpenProps}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={selectionMode}
              className={`h-8 w-8 shrink-0 rounded-md ${mutedIconButtonClass}`}
              aria-label={t('repositoryCard.more-repository-actions')}
              title={t('repositoryCard.more-repository-actions')}
              onClick={(event) => event.stopPropagation()}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align={menuAlign}
            className="w-52"
            onClick={(event) => event.stopPropagation()}
            onPointerDownOutside={(event) => {
              if (onMenuPointerDownOutside) {
                onMenuPointerDownOutside(event.target as Node);
              }
            }}
          >
            {overflowActionIds.map((id) => <React.Fragment key={id}>{menuActionNodes[id]}</React.Fragment>)}
            {showFindSimilarInMenu ? (
              <DropdownMenuItem disabled={isFindingSimilar} onSelect={() => onFindSimilar?.()}>
                {isFindingSimilar ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Search className="mr-2 h-3.5 w-3.5" />}
                {t('repositoryCard.find-similar-repositories')}
              </DropdownMenuItem>
            ) : null}
            {pluginActions.length > 0 ? (
              <>
                {hasActionsAbovePlugins ? <DropdownMenuSeparator /> : null}
                <DropdownMenuLabel>{t('repositoryCard.plugin-actions')}</DropdownMenuLabel>
                <PluginRepositoryActionItems actions={pluginActions} repository={repository} language={language} />
              </>
            ) : null}
            {hasActionsAboveUnstar ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem className="text-destructive focus:text-destructive" disabled={unstarring} onSelect={() => void onUnstar()}>
              <StarOff className={`mr-2 h-3.5 w-3.5 ${unstarring ? 'animate-pulse' : ''}`} />
              {t('repositoryCard.unstar')}
            </DropdownMenuItem>
          </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

const escapeRegExp = (string: string): string => {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const RepositoryCardComponent: React.FC<RepositoryCardProps> = ({
  repository,
  showAISummary = true,
  searchQuery = '',
  isSelected = false,
  onSelect,
  selectionMode = false,
  isExitingSelection = false,
  allCategories,
  viewMode = 'grid',
  onAskRepository,
}) => {
    const t = useT('repositories');
  const language = useAppStore((state) => state.language);
  // Card visible fields (Dev Guide §14): treat as default (visible) when not provided
  const cardFields = useAppStore((state) => state.repositoryCardFields);
  const savedActionPreferences = useAppStore((state) => state.repositoryCardActions);
  const actionPreferences = useMemo(() => normalizeRepositoryCardActions(savedActionPreferences), [savedActionPreferences]);
  const showDescription = isRepositoryCardFieldVisible(cardFields, 'description');
  // "Auto-translate repository description": translate only when the card actually displays the original description
  // (not triggered if field visibility is disabled, or custom description / AI summary takes precedence); falls back to original on pending/failure.
  const showsOriginalDescription =
    showDescription &&
    !!repository.description &&
    repository.custom_description === undefined &&
    !(showAISummary && repository.ai_summary && !repository.analysis_failed);
  const translatedDescription = useTranslatedDescription(
    showsOriginalDescription ? repository.description : null
  );
  const pluginActions = usePluginActions('repository-card');
  const {
    analyze: handleAIAnalyze,
    findSimilar: handleFindSimilar,
    unstar: handleUnstar,
    toggleReleaseSubscription,
    isSubscribed,
    isAnalyzing,
    isFindingSimilar,
    isUnstarring: unstarring,
    vectorSearchAvailable,
  } = useRepositoryCardActions({ repository, allCategories });

  const [editModalOpen, setEditModalOpen] = useState(false);
  const [readmeModalOpen, setReadmeModalOpen] = useState(false);
  const [releaseSheetOpen, setReleaseSheetOpen] = useState(false);
  const [showDragHint, setShowDragHint] = useState(false);
  const dragHintTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isActionsMenuOpen, setIsActionsMenuOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const menuDismissedByPointerDownRef = useRef(false);
  const releaseSheetOutsideDismissedAtRef = useRef<number | null>(null);
  const editModalOutsideDismissedAtRef = useRef<number | null>(null);
  const overflowActionRowRef = useRef<HTMLDivElement>(null);
  const availableActionPreferences = actionPreferences.filter((item) => item.id !== 'ask' || onAskRepository);
  const primaryOverflowActionCount = availableActionPreferences.filter((item) => item.visible).length;
  const [visibleOverflowActionCount, setVisibleOverflowActionCount] = useState(primaryOverflowActionCount);

  const restoreReadmeTriggerFocus = useCallback(() => {
    cardRef.current?.focus();
  }, []);

  useEffect(() => {
    setIsActionsMenuOpen(false);
  }, [viewMode, selectionMode]);

  useEffect(() => {
    const updateVisibleActionCount = () => {
      const width = overflowActionRowRef.current?.clientWidth ?? 0;
      // A zero width occurs during hidden/JSDOM rendering; retain all actions
      // until a real layout measurement is available.
      if (width === 0) {
        setVisibleOverflowActionCount(primaryOverflowActionCount);
        return;
      }
      setVisibleOverflowActionCount(
        countVisibleOverflowActions(width, primaryOverflowActionCount),
      );
    };

    updateVisibleActionCount();
    const observer = new ResizeObserver(updateVisibleActionCount);
    if (overflowActionRowRef.current) observer.observe(overflowActionRowRef.current);
    window.addEventListener('resize', updateVisibleActionCount);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateVisibleActionCount);
    };
  }, [viewMode, primaryOverflowActionCount, selectionMode]);

  // Utility to highlight search keywords - optimized with cache
  const highlightSearchTerm = useCallback((text: string, searchTerm: string): React.ReactNode => {
    if (!searchTerm.trim() || !text) return text;

    const cacheKey = `${text}::${searchTerm}`;
    const cached = highlightCache.get(cacheKey);
    if (cached) return cached;

    const escapedTerm = escapeRegExp(searchTerm);
    const regex = new RegExp(`(${escapedTerm})`, 'gi');
    const parts = text.split(regex);

    const result = parts.map((part, index) => {
      if (part.toLowerCase() === searchTerm.toLowerCase()) {
        return (
          <mark
            key={index}
            className="search-result-highlight px-1"
          >
            {part}
          </mark>
        );
      }
      return part;
    });

    if (highlightCache.size > MAX_CACHE_SIZE) {
      const firstKey = highlightCache.keys().next().value;
      if (firstKey) highlightCache.delete(firstKey);
    }
    highlightCache.set(cacheKey, result);
    return result;
  }, []);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (dragHintTimeoutRef.current) {
        clearTimeout(dragHintTimeoutRef.current);
      }
      if (touchSuppressTimeoutRef.current) {
        clearTimeout(touchSuppressTimeoutRef.current);
      }
    };
  }, []);

  const formatNumber = (num: number) => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toString();
  };

  // Cache language color mapping
  const languageColors = useMemo(() => ({
    JavaScript: '#f1e05a',
    TypeScript: '#3178c6',
    Python: '#3572A5',
    Java: '#b07219',
    'C++': '#f34b7d',
    C: '#555555',
    'C#': '#239120',
    Go: '#00ADD8',
    Rust: '#dea584',
    PHP: '#4F5D95',
    Ruby: '#701516',
    Swift: '#fa7343',
    Kotlin: '#A97BFF',
    Dart: '#00B4AB',
    Shell: '#89e051',
    HTML: '#e34c26',
    CSS: '#1572B6',
    Vue: '#4FC08D',
    React: '#61DAFB',
  }), []);

  const getLanguageColor = useCallback((language: string | null) => {
    return languageColors[language as keyof typeof languageColors] || '#6b7280';
  }, [languageColors]);

  // Display platforms: prioritize deterministic recognition from release assets/repo metadata; fall back to ai_platforms when no signal
  const displayPlatforms = useRepositoryPlatforms(repository);

  // Convert GitHub URL to DeepWiki URL
  const getDeepWikiUrl = (githubUrl: string) => {
    return githubUrl.replace('github.com', 'deepwiki.com');
  };

  // Convert GitHub URL to Zread URL
  const getZreadUrl = (fullName: string) => {
    return `https://zread.ai/${fullName}`;
  };

  // Use useMemo to cache display content computation
  // Option 1: separate content and status indicators, displaying multiple status badges simultaneously
  const displayContent = useMemo(() => {
    // Determine displayed content (by priority)
    // custom_description === '' indicates user explicitly cleared it, should display as empty
    // custom_description === undefined indicates no custom content, falls back to AI/original
    let content: string;
    let contentSource: 'custom' | 'ai' | 'original' | 'empty';

    // Check whether there is an explicit custom description (including empty marker)
    const hasExplicitCustomDesc = repository.custom_description !== undefined;
    const isExplicitlyCleared = repository.custom_description === '';

    if (isExplicitlyCleared) {
      // User explicitly cleared description
      content = t('repositoryCard.no-description');
      contentSource = 'empty';
    } else if (repository.custom_description) {
      // Has custom description
      content = repository.custom_description;
      contentSource = 'custom';
    } else if (showAISummary && repository.ai_summary) {
      // Show AI summary
      content = repository.ai_summary;
      contentSource = 'ai';
    } else if (repository.description) {
      // Show original description (translated if auto-translation enabled, falls back to original if pending/failed)
      content = translatedDescription ?? repository.description;
      contentSource = 'original';
    } else {
      // No description available
      content = t('repositoryCard.no-description-available');
      contentSource = 'empty';
    }

    if (showAISummary && repository.analysis_failed) {
      if (isExplicitlyCleared) {
        content = t('repositoryCard.no-description');
        contentSource = 'empty';
      } else if (repository.custom_description) {
        content = repository.custom_description;
        contentSource = 'custom';
      } else if (repository.description) {
        content = translatedDescription ?? repository.description;
        contentSource = 'original';
      } else {
        content = t('repositoryCard.no-description-available');
        contentSource = 'empty';
      }
    }

    // Determine whether repo has any custom actions (consistent with filter logic)
    // Description: marked with custom description (including explicitly cleared) and differs from AI/original
    const hasCustomDesc = repository.custom_description !== undefined;
    const repoDesc = (repository.description || '').trim();
    const aiDesc = (repository.ai_summary || '').trim();
    const customDesc = (repository.custom_description || '').trim();
    const isDescEdited = hasCustomDesc &&
      (customDesc === '' || (customDesc !== repoDesc && customDesc !== aiDesc));

    // Tags: marked with custom tags (including explicitly cleared) and differs from AI/topics
    const hasCustomTags = repository.custom_tags !== undefined;
    const aiTags = repository.ai_tags || [];
    const topics = repository.topics || [];
    const customTags = repository.custom_tags || [];
    const isTagsEdited = hasCustomTags &&
      (customTags.length === 0 || (
        JSON.stringify([...customTags].sort()) !== JSON.stringify([...aiTags].sort()) &&
        JSON.stringify([...customTags].sort()) !== JSON.stringify([...topics].sort())
      ));

    // Category: marked with custom category (including explicitly cleared) and differs from AI/default
    const aiCat = getAICategory(repository, allCategories);
    const defaultCat = getDefaultCategory(repository, allCategories);
    const customCat = repository.custom_category;
    const isCategoryEdited = customCat !== undefined &&
      (customCat === '' || (customCat !== aiCat && customCat !== defaultCat));

    // If any is true, display as customized (note: category locking is not considered customization)
    const isCustomized = isDescEdited || isTagsEdited || isCategoryEdited;

    return {
      content,
      contentSource,
      hasCustomDescription: hasExplicitCustomDesc,
      hasAISummary: !!repository.ai_summary,
      isAnalysisFailed: !!repository.analysis_failed,
      isAnalyzed: !!repository.analyzed_at,
      analyzedAt: repository.analyzed_at,
      isExplicitlyCleared,
      isCustomized
    };
  }, [repository, showAISummary, allCategories, t, translatedDescription]);

  // Use useMemo to cache tag computation
  // Logic: prioritize custom tags; if none, show AI tags or topics according to AI analysis state
  const displayTags = useMemo(() => {
    // Check whether there are explicit custom tags set (including empty array)
    const hasExplicitCustomTags = repository.custom_tags !== undefined;
    const isExplicitlyCleared = hasExplicitCustomTags && repository.custom_tags!.length === 0;

    // Prioritize custom tags (if non-empty)
    if (repository.custom_tags && repository.custom_tags.length > 0) {
      return {
        tags: repository.custom_tags.map(tag => ({ tag, source: 'custom' as const })),
        tagType: 'custom' as const,
        hasExplicitCustomTags,
        isExplicitlyCleared
      };
    }

    // If user explicitly cleared tags, show empty state
    if (isExplicitlyCleared) {
      return {
        tags: [],
        tagType: 'empty' as const,
        hasExplicitCustomTags,
        isExplicitlyCleared
      };
    }

    // When no custom tags, show based on AI analysis state
    const isAnalyzed = !!repository.analyzed_at && !repository.analysis_failed;
    if (isAnalyzed && repository.ai_tags && repository.ai_tags.length > 0) {
      return {
        tags: repository.ai_tags.map(tag => ({ tag, source: 'ai' as const })),
        tagType: 'ai' as const,
        hasExplicitCustomTags,
        isExplicitlyCleared
      };
    } else {
      const topics = repository.topics || [];
      return {
        tags: topics.map(tag => ({ tag, source: 'topic' as const })),
        tagType: 'topic' as const,
        hasExplicitCustomTags,
        isExplicitlyCleared
      };
    }
  }, [repository.custom_tags, repository.analyzed_at, repository.analysis_failed, repository.ai_tags, repository.topics]);

  // Use useMemo to cache AI analysis button tooltip text
  const aiButtonTitle = useMemo(() => {
    if (repository.analysis_failed) {
      const analyzeTime = new Date(repository.analyzed_at!).toLocaleString();
      return t('repositoryCard.analysis-failed-on-analyzetime-click-to-retry', { analyzeTime: analyzeTime });
    } else if (repository.analyzed_at) {
      const analyzeTime = new Date(repository.analyzed_at).toLocaleString();
      return t('repositoryCard.analyzed-on-analyzetime-click-to-re-analyze', { analyzeTime: analyzeTime });
    } else {
      return t('repositoryCard.analyze-with-ai');
    }
  }, [repository.analysis_failed, repository.analyzed_at, t]);

  const dragStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const isDraggingRef = useRef(false);
  const dragHandleRef = useRef<HTMLDivElement>(null);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const isTouchDraggingRef = useRef(false);
  const touchSuppressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleDragStart = (event: React.DragEvent<HTMLDivElement>) => {
    event.dataTransfer.setData('application/x-gsm-repository-id', String(repository.id));
    event.dataTransfer.effectAllowed = 'move';

    // Set drag image to entire card
    const cardElement = event.currentTarget.closest('.repository-card') as HTMLElement;
    if (cardElement) {
      const rect = cardElement.getBoundingClientRect();
      // offsetX/Y centers drag image on mouse position
      event.dataTransfer.setDragImage(cardElement, event.clientX - rect.left, event.clientY - rect.top);
    }

    event.stopPropagation();
    isDraggingRef.current = true;
    // Mark dragging to prevent triggering card click
    // Global state uses dragStore: document-level fallback listener ensures drag state
    // is reliably cleared even if source card unmounts upon drop (e.g., category view toggle) (issue #353)
    useRepositoryDragStore.getState().startDrag();
  };

  const handleDragEnd = () => {
    isDraggingRef.current = false;
    // document fallback listener has usually reset already; synchronous call here ensures idempotent consistency
    useRepositoryDragStore.getState().endDrag();
  };

  const handleDragHandleMouseDown = (event: React.MouseEvent) => {
    dragStartPosRef.current = { x: event.clientX, y: event.clientY };
    event.stopPropagation();
  };

  const handleDragHandleClick = (event: React.MouseEvent) => {
    // If dragging occurred, prevent click event
    if (isDraggingRef.current || useRepositoryDragStore.getState().isDragging) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  // Mobile touch drag handling
  const handleTouchStart = (event: React.TouchEvent) => {
    const touch = event.touches[0];
    touchStartPosRef.current = { x: touch.clientX, y: touch.clientY };
    isTouchDraggingRef.current = false;
    // Cancel previous drag suppression timer to avoid premature clearing within current suppression window
    if (touchSuppressTimeoutRef.current) {
      clearTimeout(touchSuppressTimeoutRef.current);
      touchSuppressTimeoutRef.current = null;
    }
  };

  const handleTouchMove = (event: React.TouchEvent) => {
    if (!touchStartPosRef.current) return;
    
    const touch = event.touches[0];
    const deltaX = Math.abs(touch.clientX - touchStartPosRef.current.x);
    const deltaY = Math.abs(touch.clientY - touchStartPosRef.current.y);
    
    // If movement distance exceeds threshold, treat as drag
    if (deltaX > 10 || deltaY > 10) {
      isTouchDraggingRef.current = true;
    }
  };

  const handleTouchEnd = () => {
    if (isTouchDraggingRef.current) {
      // Compatible mouse event sequence after touch drag (touchend -> mousemove -> click) would cause
      // dragStore's document-level mousemove fallback to clear immediately, so touch dragging cannot
      // use global drag state; use instance-level flag to independently suppress click emitted within 200ms.
      // Cancel previous timer before restarting window to prevent early clearing on rapid successive drags.
      if (touchSuppressTimeoutRef.current) {
        clearTimeout(touchSuppressTimeoutRef.current);
      }
      touchSuppressTimeoutRef.current = setTimeout(() => {
        isTouchDraggingRef.current = false;
        touchSuppressTimeoutRef.current = null;
      }, 200);
    }
    touchStartPosRef.current = null;
  };

  // Use ref to record current selection state, avoiding closure issues
  const isSelectedRef = useRef(isSelected);
  useEffect(() => {
    isSelectedRef.current = isSelected;
  }, [isSelected]);

  // Use ref to track whether click has already been processed
  const isProcessingClickRef = useRef(false);

  const handleReleaseSheetOutsideDismiss = useCallback<DialogContentPointerDownOutsideHandler>((event) => {
    // Keep the fallback overlay mounted through the current click sequence.
    // Otherwise, closing it on pointerdown can retarget the browser click to this card.
    event.preventDefault();
    releaseSheetOutsideDismissedAtRef.current = Date.now();
    window.setTimeout(() => setReleaseSheetOpen(false), 0);
  }, []);

  const handleEditModalOutsideDismiss = useCallback(() => {
    editModalOutsideDismissedAtRef.current = Date.now();
  }, []);

  // Optimize event handler with useCallback
  const handleCardClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    // Never intercept when click target is an interactive element (link/button, etc.): link navigation and button actions must preserve
    // default behavior; time-window accidental click prevention (modal close debounce / drag flag) should only apply to blank card areas.
    // Interactive element check must precede all interception branches; otherwise if modal close debounce or drag flag lingers,
    // links like "View on GitHub" will be swallowed by preventDefault (issue #353).
    const target = event.target as HTMLElement;
    // Exclude card's own role="button", check interactive elements on child elements only
    if (target.closest('button, a, input, textarea, select, [draggable="true"]')) return;

    const releaseSheetDismissedAt = releaseSheetOutsideDismissedAtRef.current;
    if (releaseSheetDismissedAt !== null) {
      releaseSheetOutsideDismissedAtRef.current = null;
      if (Date.now() - releaseSheetDismissedAt < 250) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }

    const editModalDismissedAt = editModalOutsideDismissedAtRef.current;
    if (editModalDismissedAt !== null) {
      editModalOutsideDismissedAtRef.current = null;
      if (Date.now() - editModalDismissedAt < 250) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }

    // Prevent duplicate processing
    if (isProcessingClickRef.current) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // If currently dragging, ignore click (including compatible click suppression window after touch drag)
    if (isDraggingRef.current || isTouchDraggingRef.current || useRepositoryDragStore.getState().isDragging) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const dismissedByPointerDown = menuDismissedByPointerDownRef.current;
    menuDismissedByPointerDownRef.current = false;
    if (dismissedByPointerDown) return;

    // When menu is expanded, clicking blank area of card only collapses menu without triggering details or selection
    if (isActionsMenuOpen) {
      setIsActionsMenuOpen(false);
      return;
    }

    // In selection mode, clicking card toggles selection state
    if (selectionMode && onSelect) {
      // Prevent default behavior to prevent page scroll caused by focus change
      event.preventDefault();
      event.stopPropagation();
      // Set flag to prevent duplicate processing
      isProcessingClickRef.current = true;
      // Immediately perform selection
      onSelect(repository.id);
      // Reset flag
      setTimeout(() => {
        isProcessingClickRef.current = false;
      }, 50);
      return;
    }

    setReadmeModalOpen(true);
  }, [selectionMode, onSelect, repository.id, isActionsMenuOpen]);

  // Handle mousedown event to prevent page scrolling caused by focus change
  const handleMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    // In selection mode, prevent default behavior to stop focus change
    if (selectionMode && onSelect) {
      event.preventDefault();
    }
  }, [selectionMode, onSelect]);

  // Handle keyboard events to make card keyboard-accessible
  // When edit modal or README modal is open, disable card keyboard events
  const isModalOpen = editModalOpen || readmeModalOpen || releaseSheetOpen;
  
  const handleCardKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    // Process only when card itself receives focus to avoid intercepting native keyboard behavior on child controls like the three-dot menu.
    if (event.target !== event.currentTarget) return;

    // If any modal is open, do not handle keyboard events
    if (isModalOpen) return;
    
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (selectionMode && onSelect) {
        onSelect(repository.id);
      } else {
        setReadmeModalOpen(true);
      }
    }
  }, [selectionMode, onSelect, repository.id, isModalOpen]);

  // Use useMemo to cache card class name, avoiding redundant computation
  const cardClassName = useMemo(() => {
    const baseClasses = viewMode === 'list'
      ? 'repository-card repository-card--list ui-card group relative px-6 pt-5 pb-0 transition-[color,background-color,border-color,box-shadow] duration-200 cursor-pointer'
      : 'repository-card ui-card group p-5 transition-[color,background-color,border-color,box-shadow] duration-200 flex flex-col h-full cursor-pointer';
    const selectedClasses = isSelected
      ? 'linear-card-selected'
      : '';
    const exitingClasses = isExitingSelection && isSelected ? 'animate-selection-exit' : '';
    return `${baseClasses} ${selectedClasses} ${exitingClasses}`.trim();
  }, [isSelected, isExitingSelection, viewMode]);

  return (
    <div
      ref={cardRef}
      className={cardClassName}
      onClick={handleCardClick}
      onPointerDown={() => {
        if (!isActionsMenuOpen) {
          menuDismissedByPointerDownRef.current = false;
        }
      }}
      onMouseDown={handleMouseDown}
      onKeyDown={handleCardKeyDown}
      tabIndex={isModalOpen ? -1 : 0}
      role="button"
      aria-label={showDescription
        ? `${repository.full_name} - ${repository.description || 'No description'}`
        : repository.full_name}
      data-selection-mode={selectionMode}
      aria-disabled={isModalOpen}
    >
      {/* Header - Repository Info */}
      <div className="flex items-start space-x-3 mb-3">
        <img
          src={repository.owner.avatar_url}
          alt={repository.owner.login}
          className={`${viewMode === 'list' ? 'w-10 h-10' : 'w-8 h-8'} rounded-full flex-shrink-0`}
        />
        <div className="min-w-0 flex-1">
          <h3 className={`${viewMode === 'list' ? 'text-base' : ''} font-semibold text-foreground dark:text-foreground truncate`}>
            {highlightSearchTerm(repository.name, searchQuery)}
          </h3>
          <p className="text-sm text-muted-foreground dark:text-muted-foreground truncate">
            {repository.owner.login}
          </p>
        </div>
        
        {/* Drag button - top right - hidden on mobile and tablet */}
        {viewMode === 'list' && (
          <div className="ml-auto flex min-w-0 flex-1 items-start justify-end gap-1.5">
            {displayContent.isCustomized && (
              <span className="inline-flex shrink-0 items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium bg-muted dark:bg-muted/40 text-muted-foreground dark:text-muted-foreground">
                <Edit3 className="w-3 h-3" />
                {t('repositoryCard.customized')}
              </span>
            )}
            {displayContent.isAnalysisFailed ? (
                <span className="inline-flex shrink-0 items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium bg-destructive/10 text-destructive">
                  <Bot className="w-3 h-3" />
                  {t('repositoryCard.analysis-failed')}
                </span>
            ) : displayContent.isAnalyzed ? (
              <span className="inline-flex shrink-0 items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium bg-primary/10 dark:bg-primary/20 text-primary">
                <Sparkles className="w-3 h-3" />
                {t('repositoryCard.analyzed')}
              </span>
            ) : (
              <span className="inline-flex shrink-0 items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium bg-muted dark:bg-muted/40 text-muted-foreground dark:text-muted-foreground">
                <Bot className="w-3 h-3" />
                {t('repositoryCard.not-analyzed')}
              </span>
            )}
            {!selectionMode ? (
              <OverflowActionRow
                actionRowRef={overflowActionRowRef}
                testId="list-action-row"
                className="flex min-w-0 flex-1 items-center justify-end gap-1.5 overflow-hidden"
                visibleActionCount={visibleOverflowActionCount}
                primaryActionCount={primaryOverflowActionCount}
                actionPreferences={actionPreferences}
                selectionMode={selectionMode}
                onAskRepository={onAskRepository}
                repository={repository}
                language={language}
                docsUrl={language === 'zh' ? getZreadUrl(repository.full_name) : getDeepWikiUrl(repository.html_url)}
                githubUrl={repository.html_url}
                aiButtonTitle={aiButtonTitle}
                isAnalyzing={isAnalyzing}
                isSubscribed={isSubscribed}
                unstarring={unstarring}
                vectorSearchAvailable={vectorSearchAvailable}
                isFindingSimilar={isFindingSimilar}
                onFindSimilar={handleFindSimilar}
                persistFindSimilarInMenu
                pluginActions={pluginActions.actions}
                isActionsMenuOpen={isActionsMenuOpen}
                onActionsMenuOpenChange={setIsActionsMenuOpen}
                onAnalyze={handleAIAnalyze}
                onAsk={onAskRepository ? () => onAskRepository(repository) : undefined}
                onToggleReleaseSubscription={toggleReleaseSubscription}
                onEdit={() => setEditModalOpen(true)}
                editButtonTitle={displayContent.isCustomized ? t('repositoryCard.customized-edit-repository-info') : t('repositoryCard.edit-repository-info')}
                onViewReleases={() => setReleaseSheetOpen(true)}
                onUnstar={handleUnstar}
                menuAlign="end"
                onMenuPointerDownOutside={(target) => {
                  if (cardRef.current?.contains(target)) {
                    menuDismissedByPointerDownRef.current = true;
                  }
                }}
                t={t}
              />
            ) : null}
          </div>
        )}

        {viewMode === 'grid' && !selectionMode && (
          <div className="hidden lg:block relative flex-shrink-0 mt-[-4px] opacity-0 hover:opacity-100 transition-opacity duration-200 group-hover:opacity-100">
            <div
              ref={dragHandleRef}
              draggable
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onMouseDown={handleDragHandleMouseDown}
              onClick={(e) => {
                handleDragHandleClick(e);
                // Show subtle toast tooltip
                setShowDragHint(true);
                if (dragHintTimeoutRef.current) {
                  clearTimeout(dragHintTimeoutRef.current);
                }
                dragHintTimeoutRef.current = setTimeout(() => {
                  setShowDragHint(false);
                }, 2000);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  // Keyboard-equivalent categorization: open edit modal to complete categorization,
                  // rather than only showing drag tooltip bubble (drag has no direct keyboard equivalent).
                  setEditModalOpen(true);
                }
              }}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              tabIndex={0}
              role="button"
              aria-label={t('repositoryCard.edit-repository-category')}
              className="linear-icon-button flex items-center justify-center w-8 h-8 cursor-grab active:cursor-grabbing touch-manipulation"
              title={t('repositoryCard.drag-me-to-sidebar-to-categorize')}
            >
              <GripVertical className="w-4 h-4" />
            </div>
            {/* Subtle toast tooltip */}
            {showDragHint && (
              <div className="absolute top-full right-0 z-50 mt-2 whitespace-nowrap rounded-lg border border-border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-dialog animate-fade-in">
                {t('repositoryCard.drag-me-to-left-sidebar')}
                {/* Tooltip arrow */}
                <div className="absolute bottom-full right-3 h-0 w-0 border-x-4 border-b-4 border-l-transparent border-r-transparent border-b-popover"></div>
              </div>
            )}
          </div>
        )}
      </div>

      {viewMode === 'grid' ? (
        <OverflowActionRow
          actionRowRef={overflowActionRowRef}
          testId="grid-action-row"
          className="mb-4 flex w-full items-center justify-start gap-1.5 overflow-hidden"
          visibleActionCount={visibleOverflowActionCount}
          primaryActionCount={primaryOverflowActionCount}
          actionPreferences={actionPreferences}
          selectionMode={selectionMode}
          onAskRepository={onAskRepository}
          repository={repository}
          language={language}
          docsUrl={language === 'zh' ? getZreadUrl(repository.full_name) : getDeepWikiUrl(repository.html_url)}
          githubUrl={repository.html_url}
          aiButtonTitle={aiButtonTitle}
          isAnalyzing={isAnalyzing}
          isSubscribed={isSubscribed}
          unstarring={unstarring}
          pluginActions={pluginActions.actions}
          isActionsMenuOpen={isActionsMenuOpen}
          onActionsMenuOpenChange={setIsActionsMenuOpen}
          onAnalyze={handleAIAnalyze}
          onAsk={onAskRepository ? () => onAskRepository(repository) : undefined}
          onToggleReleaseSubscription={toggleReleaseSubscription}
          onEdit={() => setEditModalOpen(true)}
          editButtonTitle={displayContent.isCustomized ? t('repositoryCard.customized-edit-repository-info') : t('repositoryCard.edit-repository-info')}
          onViewReleases={() => setReleaseSheetOpen(true)}
          onUnstar={handleUnstar}
          menuAlign="start"
          onMenuPointerDownOutside={(target) => {
            if (cardRef.current?.contains(target)) {
              menuDismissedByPointerDownRef.current = true;
            }
          }}
          t={t}
        />
      ) : null}

      {/* Description with shared Tooltip. Keep analysis status visible independently. */}
      {(showDescription || (
        viewMode === 'grid'
        && (displayContent.isCustomized || displayContent.isAnalysisFailed || displayContent.isAnalyzed)
      )) && (
      <div className={viewMode === 'list' ? 'mb-3' : 'mb-4 flex-1'}>
        {showDescription && (
        <Tooltip>
          <TooltipTrigger asChild>
            <p
              tabIndex={0}
              className={viewMode === 'list'
                ? 'text-sm leading-6 text-muted-foreground dark:text-muted-foreground line-clamp-2 transition-colors duration-200 [text-wrap:pretty] hover:text-foreground dark:hover:text-foreground'
                : 'text-foreground dark:text-muted-foreground text-[13px] leading-[1.625] line-clamp-3 mb-2 transition-colors duration-200 [text-wrap:pretty] hover:text-foreground dark:hover:text-foreground rounded-md px-1 -mx-1 hover:bg-muted dark:hover:bg-card/[0.02]'}
            >
              {highlightSearchTerm(displayContent.content, searchQuery)}
            </p>
          </TooltipTrigger>
          <TooltipContent side="top" align="start" className="max-w-lg whitespace-pre-wrap break-words">
            {displayContent.content}
          </TooltipContent>
        </Tooltip>
        )}

        {/* Option 1: display multiple status badges simultaneously */}
        {viewMode === 'grid' && (
        <div className="flex items-center space-x-2 flex-wrap gap-y-1">
          {/* Customized badge - consistent with filter logic */}
          {displayContent.isCustomized && (
            <div className="flex items-center space-x-1 text-xs text-muted-foreground dark:text-muted-foreground" title={t('repositoryCard.this-repository-has-been-customized-description')}>
              <Edit3 className="w-3 h-3" />
              <span>{t('repositoryCard.customized')}</span>
            </div>
          )}
          {/* AI analysis status badge (combined display) */}
          {displayContent.isAnalysisFailed ? (
            <div className="flex items-center space-x-1 text-xs text-destructive dark:text-destructive" title={t('repositoryCard.ai-analysis-failed-click-ai-button-to-retry')}>
              <Bot className="w-3 h-3" />
              <span>{t('repositoryCard.failed')}</span>
              <div className="group relative">
                <HelpCircle className="w-3 h-3 text-destructive/70 dark:text-destructive/70 cursor-help" />
                <div className="absolute left-0 top-full z-[9999] mt-2 w-72 max-w-xs rounded-lg border border-border bg-popover p-3 text-xs text-popover-foreground opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-[opacity,visibility] whitespace-normal break-words shadow-lg">
                  <p className="text-muted-foreground dark:text-muted-foreground leading-relaxed">
                    {repository.analysis_error || (t('repositoryCard.ai-analysis-failed-please-check-ai-configuration'))}
                  </p>
                  <div className="absolute top-[-4px] left-3 h-2 w-2 rotate-45 transform border-l border-t border-border bg-popover"></div>
                </div>
              </div>
            </div>
          ) : displayContent.isAnalyzed ? (
            <div
              className="flex items-center space-x-1 px-2 py-0.5 rounded-full text-xs font-medium bg-primary/10 dark:bg-primary/20 text-primary border border-primary/20 dark:border-primary/20"
              title={displayContent.analyzedAt ? t('repositoryCard.analyzed-on-date', { date: new Date(displayContent.analyzedAt).toLocaleString(getIntlLocale(language)) }) : ''}
            >
              <Sparkles className="w-3 h-3" />
              <span>{t('repositoryCard.ai-analyzed')}</span>
            </div>
          ) : null}
        </div>
        )}
      </div>
      )}

      {/* List mode keeps tags and repository metadata on one wrapping information row. */}
      <div className={viewMode === 'list' ? 'flex flex-wrap items-center gap-x-3 gap-y-2' : 'contents'}>
      {/* Tags - shows topics before AI analysis, AI tags after analysis */}
      {isRepositoryCardFieldVisible(cardFields, 'tags') && displayTags.tags.length > 0 && (
        <div className={`flex flex-wrap ${viewMode === 'list' ? 'gap-1' : 'gap-2 mb-4'}`}>
          {displayTags.tags.map((tagItem, index) => (
            <span
              key={`tag-${index}`}
              className={`linear-card-tag font-medium ${viewMode === 'list' ? 'px-1.5 py-0.5 text-xs' : 'px-2 py-1 text-xs'}`}
            >
              {highlightSearchTerm(tagItem.tag, searchQuery)}
            </span>
          ))}
        </div>
      )}

      {/* Platform Icons */}
      {viewMode === 'grid' && displayPlatforms.length > 0 && (
        <div className="flex items-center space-x-2 mb-4">
          <span className="text-xs text-muted-foreground dark:text-muted-foreground">
            {t('repositoryCard.platforms')}
          </span>
          <div className="flex space-x-1">
            {displayPlatforms.slice(0, 6).map((platform, index) => {
              const IconComponent = getPlatformIcon(platform);
              const displayName = getPlatformDisplayName(platform);

              return (
                <div
                  key={index}
                  className="linear-platform-icon w-6 h-6 flex items-center justify-center cursor-default"
                  title={displayName}
                >
                  <IconComponent className="w-3 h-3" />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Stats */}
      <div className={viewMode === 'list' ? 'contents' : 'space-y-3 mt-auto'}>
        {/* Language and Stars */}
        <div className={`flex items-center ${viewMode === 'list' ? 'space-x-3 flex-wrap gap-y-1' : 'space-x-4'} text-xs text-muted-foreground dark:text-muted-foreground`}>
          {isRepositoryCardFieldVisible(cardFields, 'language') && repository.language && (
            <div className="flex items-center space-x-1 min-w-0">
              <div
                className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: getLanguageColor(repository.language) }}
              />
              <span className="truncate max-w-20">{repository.language}</span>
            </div>
          )}
          {isRepositoryCardFieldVisible(cardFields, 'stars') && (
          <div className="flex items-center space-x-1 flex-shrink-0">
            <Star className="w-3.5 h-3.5" />
            <span className="truncate max-w-16">{formatNumber(repository.stargazers_count)}</span>
          </div>
          )}
          {viewMode === 'list' && displayPlatforms.length > 0 && (
            <div className="flex items-center space-x-1 min-w-0">
              <Terminal className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="truncate max-w-40">{displayPlatforms.slice(0, 3).map(getPlatformDisplayName).join(' · ')}</span>
            </div>
          )}
          {isRepositoryCardFieldVisible(cardFields, 'license') && (() => {
            // license: display SPDX id after normalization; do not render if no license
            const lic = normalizeLicense(repository.license);
            if (lic === NO_LICENSE_SENTINEL) return null;
            return (
              <div className="flex items-center space-x-1 min-w-0">
                <Scale className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="truncate max-w-24">{lic}</span>
              </div>
            );
          })()}
        </div>

        {/* Update time is a compact footer in list mode and stays centered between divider and card edge. */}
        <div className={viewMode === 'list' ? 'basis-full flex-none' : 'mt-4'}>
        <div className={`flex items-center justify-between text-muted-foreground dark:text-muted-foreground border-t ui-divider ${viewMode === 'list' ? 'w-full h-14 mt-4 text-sm leading-5' : 'pt-2 text-sm'}`}>
          <div className="relative flex min-w-0 items-center gap-1.5 leading-none">
            {isRepositoryCardFieldVisible(cardFields, 'lastUpdated') && (
            <>
            <Calendar className={`w-4 h-4 flex-shrink-0 transition-opacity duration-150 ${viewMode === 'grid' && vectorSearchAvailable && !selectionMode ? 'group-hover:opacity-0' : ''}`} />
            <span className={`truncate transition-opacity duration-150 ${viewMode === 'grid' && vectorSearchAvailable && !selectionMode ? 'group-hover:opacity-0' : ''}`}>
              {t('repositoryCard.last-pushed-time', { time: formatDistanceToNow(new Date(repository.pushed_at || repository.updated_at), { addSuffix: true, locale: getDateFnsLocale(language) }) })}
            </span>
            </>
            )}

            {viewMode === 'grid' && vectorSearchAvailable && !selectionMode && (
              <Button
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  handleFindSimilar();
                }}
                disabled={isFindingSimilar}
                className="absolute -inset-y-1 left-0 flex h-auto items-center space-x-1 text-primary dark:text-primary font-medium opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-events-none group-hover:pointer-events-auto focus-visible:pointer-events-auto transition-opacity duration-150 hover:underline disabled:cursor-not-allowed disabled:hover:no-underline"
                title={t('repositoryCard.find-similar-repositories-2')}
              >
                {isFindingSimilar ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                <span>{t('repositoryCard.find-similar')}</span>
              </Button>
            )}
          </div>


          {/* Selection button */}
          {onSelect && (
            <Button
              variant="ghost"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(repository.id);
              }}
              className={`flex items-center justify-center w-7 h-7 rounded-md p-0 transition-colors ${
                isSelected
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
              }`}
              title={isSelected ? (t('repositoryCard.deselect')) : (t('repositoryCard.select'))}
              aria-label={isSelected ? (t('repositoryCard.deselect')) : (t('repositoryCard.select'))}
              aria-pressed={isSelected}
            >
              {isSelected ? <CheckSquare className="w-5 h-5" /> : <Square className="w-5 h-5" />}
            </Button>
          )}
        </div>
        </div>
      </div>
      </div>

      {/* Repository Edit Modal - Using portal to render outside card container */}
      {editModalOpen && createPortal(
        <RepositoryEditModal
          isOpen={editModalOpen}
          onClose={() => setEditModalOpen(false)}
          onOutsideDismiss={handleEditModalOutsideDismiss}
          repository={repository}
        />,
        document.body
      )}

      {/* README Modal - lazily loaded and rendered outside the card container */}
      {readmeModalOpen && createPortal(
        <ErrorBoundary>
          <Suspense
            fallback={
              <ReadmeModalLoadingFallback
                onClose={() => setReadmeModalOpen(false)}
                onCloseAutoFocus={restoreReadmeTriggerFocus}
              />
            }
          >
            <LazyReadmeModal
              isOpen={readmeModalOpen}
              onClose={() => setReadmeModalOpen(false)}
              onCloseAutoFocus={restoreReadmeTriggerFocus}
              repository={repository}
            />
          </Suspense>
        </ErrorBoundary>,
        document.body
      )}

      {releaseSheetOpen && createPortal(
        <ErrorBoundary>
          <Suspense
            fallback={
              <ReleaseSheetLoadingFallback
                onClose={() => setReleaseSheetOpen(false)}
                onCloseAutoFocus={restoreReadmeTriggerFocus}
                onPointerDownOutside={handleReleaseSheetOutsideDismiss}
              />
            }
          >
            <LazyRepositoryReleaseSheet
              isOpen={releaseSheetOpen}
              onClose={() => setReleaseSheetOpen(false)}
              onCloseAutoFocus={restoreReadmeTriggerFocus}
              repository={repository}
            />
          </Suspense>
        </ErrorBoundary>,
        document.body
      )}
    </div>
  );
};

// Optimize with React.memo to prevent unnecessary re-renders
export const RepositoryCard = React.memo(RepositoryCardComponent, (prevProps, nextProps) => {
  const allCategoriesEqual = 
    prevProps.allCategories.length === nextProps.allCategories.length &&
    prevProps.allCategories.every((cat, i) => {
      const nextCat = nextProps.allCategories[i];
      return nextCat && 
             cat.id === nextCat.id && 
             cat.name === nextCat.name && 
             JSON.stringify(cat.keywords) === JSON.stringify(nextCat.keywords);
    });

  return (
    prevProps.repository.id === nextProps.repository.id &&
    prevProps.repository.analyzed_at === nextProps.repository.analyzed_at &&
    prevProps.repository.analysis_failed === nextProps.repository.analysis_failed &&
    prevProps.repository.analysis_error === nextProps.repository.analysis_error &&
    prevProps.repository.ai_summary === nextProps.repository.ai_summary &&
    prevProps.repository.ai_tags === nextProps.repository.ai_tags &&
    prevProps.repository.ai_platforms === nextProps.repository.ai_platforms &&
    prevProps.repository.custom_description === nextProps.repository.custom_description &&
    prevProps.repository.custom_tags === nextProps.repository.custom_tags &&
    prevProps.repository.custom_category === nextProps.repository.custom_category &&
    prevProps.repository.category_locked === nextProps.repository.category_locked &&
    prevProps.repository.description === nextProps.repository.description &&
    prevProps.repository.topics === nextProps.repository.topics &&
    prevProps.repository.license === nextProps.repository.license &&
    prevProps.repository.stargazers_count === nextProps.repository.stargazers_count &&
    prevProps.repository.pushed_at === nextProps.repository.pushed_at &&
    prevProps.repository.language === nextProps.repository.language &&
    prevProps.repository.updated_at === nextProps.repository.updated_at &&
    prevProps.showAISummary === nextProps.showAISummary &&
    prevProps.searchQuery === nextProps.searchQuery &&
    prevProps.isSelected === nextProps.isSelected &&
    prevProps.selectionMode === nextProps.selectionMode &&
    prevProps.isExitingSelection === nextProps.isExitingSelection &&
    prevProps.viewMode === nextProps.viewMode &&
    prevProps.onAskRepository === nextProps.onAskRepository &&
    allCategoriesEqual
  );
});
