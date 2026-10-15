import { useT } from "../i18n/useT";
import { Textarea } from './ui/textarea';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Save, X, Plus, Lock, Unlock, RotateCcw, Bot, Edit3, FileText, Tag, FolderOpen, Info, AlertTriangle } from 'lucide-react';
import { Modal } from './Modal';
import { Repository } from '../types';
import { useAppStore, getAllCategories } from '../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { useCategorySyncActions } from '../features/repositories/hooks/useCategorySyncActions';
import { computeCustomCategory, getAICategory, getDefaultCategory } from '../utils/categoryUtils';
import { deferOutsideDismiss } from './modalDismiss';

interface RepositoryEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOutsideDismiss?: () => void;
  repository: Repository | null;
}

/**
 * Data source types:
 * - custom: User-customized content
 * - ai: AI-generated content
 * - original: Original GitHub content
 * - mixed: Mixed sources (tags only)
 * - none: No content (explicitly cleared by user)
 */
type DataSource = 'custom' | 'ai' | 'original' | 'mixed' | 'none';

/**
 * Edit intent type - clarifies the user's intended action:
 * - keep-custom: Retain/save as custom content
 * - reset-to-ai: Reset to AI content (clears custom content)
 * - reset-to-original: Reset to original content (clears custom content)
 * - clear: Clear content (saved as an explicit empty value, displayed as empty)
 */
type EditIntentType = 'keep-custom' | 'reset-to-ai' | 'reset-to-original' | 'clear';

/**
 * Edit intent state - tracks user intent across description, tags, and category
 */
interface EditIntent {
  description: EditIntentType;
  tags: EditIntentType;
  category: EditIntentType;
}

/**
 * Source information display
 */
interface SourceInfo {
  description: DataSource;
  tags: DataSource;
  category: DataSource;
}

export const RepositoryEditModal: React.FC<RepositoryEditModalProps> = ({
  isOpen,
  onClose,
  onOutsideDismiss,
  repository
}) => {
  const { updateRepository, language, customCategories, hiddenDefaultCategoryIds, defaultCategoryOverrides } = useAppStore(useShallow((state) => ({
    updateRepository: state.updateRepository,
    language: state.language,
    customCategories: state.customCategories,
    hiddenDefaultCategoryIds: state.hiddenDefaultCategoryIds,
    defaultCategoryOverrides: state.defaultCategoryOverrides,
  })));
  const { forceSyncToBackend } = useCategorySyncActions();

  const [formData, setFormData] = useState({
    description: '',
    tags: [] as string[],
    category: '',
    categoryLocked: false
  });
  const [newTag, setNewTag] = useState('');

  // Record initial values to detect modifications
  const initialDataRef = useRef({
    description: '',
    tags: [] as string[],
    category: '',
    categoryLocked: false
  });

  /**
   * Edit intent state - key improvement
   * Clarifies user intent to determine save behavior
   */
  const [editIntent, setEditIntent] = useState<EditIntent>({
    description: 'keep-custom',
    tags: 'keep-custom',
    category: 'keep-custom'
  });

  const initialEditIntentRef = useRef<EditIntent>({
    description: 'keep-custom',
    tags: 'keep-custom',
    category: 'keep-custom'
  });
  const initializedRepositoryIdRef = useRef<number | null>(null);

  const allCategories = useMemo(() => getAllCategories(customCategories, language, hiddenDefaultCategoryIds, defaultCategoryOverrides), [customCategories, language, hiddenDefaultCategoryIds, defaultCategoryOverrides]);

  // Get repository's current category
  const getCurrentCategory = useCallback((repo: Repository) => {
    // If there is a custom category, return it directly
    if (repo.custom_category) {
      return repo.custom_category;
    }

    // Otherwise infer current category from AI tags or other information
    const aiCat = getAICategory(repo, allCategories);
    if (aiCat) {
      return aiCat;
    }

    const defaultCat = getDefaultCategory(repo, allCategories);
    if (defaultCat) {
      return defaultCat;
    }

    return '';
  }, [allCategories]);

  // Determine data source (based on actual displayed content, not stored value)
  const determineSource = useCallback((repo: Repository): SourceInfo => {
    // Description source: determine source based on display priority
    // Priority: custom_description (not undefined) > ai_summary > description
    // custom_description === '' indicates user explicitly cleared it, source is 'none'
    let descSource: DataSource;
    if (repo.custom_description !== undefined && repo.custom_description !== null) {
      if (repo.custom_description.trim() !== '') {
        descSource = 'custom';
      } else {
        descSource = 'none';
      }
    } else if (repo.ai_summary && repo.ai_summary.trim() !== '') {
      descSource = 'ai';
    } else if (repo.description && repo.description.trim() !== '') {
      descSource = 'original';
    } else {
      descSource = 'none';
    }

    // Tag source: determine source based on display priority
    // Priority: custom_tags (non-empty array) > custom_tags (empty array = explicitly cleared) > ai_tags > topics
    let tagsSource: DataSource;
    // Check if there are custom tags: distinguish between undefined (no custom) and [] (explicitly cleared)
    if (repo.custom_tags !== undefined) {
      // custom_tags is an array (may be empty or contain tags)
      if (repo.custom_tags.length > 0) {
        tagsSource = 'custom';
      } else {
        // Empty array indicates user explicitly cleared tags
        tagsSource = 'none';
      }
    } else if (repo.ai_tags && repo.ai_tags.length > 0) {
      tagsSource = 'ai';
    } else if (repo.topics && repo.topics.length > 0) {
      tagsSource = 'original';
    } else {
      tagsSource = 'none';
    }

    // Category source
    let categorySource: DataSource;
    if (repo.custom_category && repo.custom_category.trim() !== '') {
      categorySource = 'custom';
    } else if (getAICategory(repo, allCategories) !== '') {
      categorySource = 'ai';
    } else if (getDefaultCategory(repo, allCategories) !== '') {
      categorySource = 'original';
    } else {
      categorySource = 'none';
    }

    return { description: descSource, tags: tagsSource, category: categorySource };
  }, [allCategories]);

  /**
   * Get effective displayed content (consistent with RepositoryCard display logic)
   */
  const getEffectiveDisplayContent = useCallback((repo: Repository) => {
    // Description: priority custom_description (not undefined) > ai_summary > description
    // custom_description === '' indicates explicitly cleared, displayed as empty in form
    // custom_description === undefined indicates no custom, fallback to AI/original
    let effectiveDescription = '';
    if (repo.custom_description !== undefined && repo.custom_description !== null) {
      effectiveDescription = repo.custom_description;
    } else if (repo.ai_summary && repo.ai_summary.trim() !== '') {
      effectiveDescription = repo.ai_summary;
    } else if (repo.description && repo.description.trim() !== '') {
      effectiveDescription = repo.description;
    }

    // Tags: priority custom_tags (non-empty array) > custom_tags (empty array = explicitly cleared) > ai_tags > topics
    let effectiveTags: string[] = [];
    // Check if there are custom tags: distinguish between undefined (no custom) and [] (explicitly cleared)
    if (repo.custom_tags !== undefined) {
      // custom_tags is an array (may be empty or contain tags)
      effectiveTags = repo.custom_tags;
    } else if (repo.ai_tags && repo.ai_tags.length > 0) {
      effectiveTags = repo.ai_tags;
    } else if (repo.topics && repo.topics.length > 0) {
      effectiveTags = repo.topics;
    }

    return { effectiveDescription, effectiveTags };
  }, []);

  /**
   * Initialize form data
   * When modal opens, initialize form based on repository's current state
   */
  useEffect(() => {
    if (!repository || !isOpen) {
      initializedRepositoryIdRef.current = null;
      return;
    }

    // Polling replaces repository object references every few seconds. Preserve the
    // user's in-progress draft when that happens; initialize only once per open.
    if (initializedRepositoryIdRef.current === repository.id) return;
    initializedRepositoryIdRef.current = repository.id;

    const currentCategory = getCurrentCategory(repository);
      const source = determineSource(repository);

      // Get effective displayed content
      const { effectiveDescription, effectiveTags } = getEffectiveDisplayContent(repository);

      /**
       * Determine initial edit intent
       * Decide intent based on source of displayed content
       */
      const initialIntent: EditIntent = {
        description: source.description === 'custom' ? 'keep-custom' :
                     source.description === 'ai' ? 'reset-to-ai' :
                     source.description === 'original' ? 'reset-to-original' : 'clear',
        tags: source.tags === 'custom' ? 'keep-custom' :
              source.tags === 'ai' ? 'reset-to-ai' :
              source.tags === 'original' ? 'reset-to-original' : 'clear',
        category: source.category === 'custom' ? 'keep-custom' :
                  source.category === 'ai' ? 'reset-to-ai' :
                  source.category === 'original' ? 'reset-to-original' : 'clear'
      };
      setEditIntent(initialIntent);
      initialEditIntentRef.current = { ...initialIntent };

      // Initial form values - initialize with actual displayed content
      const initialData = {
        description: effectiveDescription,
        tags: effectiveTags,
        category: currentCategory.trim().toLowerCase() === 'none' ? '' : currentCategory,
        categoryLocked: !!repository.category_locked
      };

      setFormData(initialData);
      initialDataRef.current = JSON.parse(JSON.stringify(initialData));
  }, [repository, isOpen, allCategories, determineSource, getEffectiveDisplayContent, getCurrentCategory]);

  /**
   * Save handler - decide how to save based on edit intent
   * Core improvement: clearly distinguish between "save custom", "reset to source", and "clear"
   * Ensures saved data matches UI display logic
   */
  const handleSave = async () => {
    // Initialization maps the legacy “none” value to an empty category, and save validation rejects it.
    if (!repository || formData.category.trim().toLowerCase() === 'none') return;

    // Build update object
    const updatedRepo = { ...repository };

    /**
     * Description field handling logic
     * Goal: ensure display logic in RepositoryCard correctly displays what the user expects after saving
     */
    switch (editIntent.description) {
      case 'reset-to-ai':
        // Reset to AI summary: clear custom description, let display logic fall back to AI
        updatedRepo.custom_description = undefined;
        break;

      case 'reset-to-original':
        // Reset to original description: clear custom description, let display logic fall back to original
        updatedRepo.custom_description = undefined;
        break;

      case 'clear':
        // Clear description: save empty string to indicate explicit clearing by user
        // undefined indicates no customization (falls back to AI/original), '' indicates explicitly cleared
        updatedRepo.custom_description = '';
        break;

      case 'keep-custom':
      default: {
        // Keep custom: check if content matches original source
        const descTrimmed = (formData.description || '').trim();

        // If content is empty, treat as cleared
        if (descTrimmed === '') {
          updatedRepo.custom_description = '';
        }
        // If it matches AI summary, clear custom description (let display logic fall back to AI)
        else if (descTrimmed === (repository.ai_summary || '').trim()) {
          updatedRepo.custom_description = undefined;
        }
        // If it matches original description, clear custom description (let display logic fall back to original)
        else if (descTrimmed === (repository.description || '').trim()) {
          updatedRepo.custom_description = undefined;
        }
        // Otherwise save as custom
        else {
          updatedRepo.custom_description = descTrimmed;
        }
        break;
      }
    }

    /**
     * Tag field handling logic
     * Goal: ensure display logic in RepositoryCard correctly displays tags expected by user after saving
     */
    switch (editIntent.tags) {
      case 'reset-to-ai':
        // Reset to AI tags: clear custom tags
        updatedRepo.custom_tags = undefined;
        break;

      case 'reset-to-original':
        // Reset to topics: clear custom tags
        updatedRepo.custom_tags = undefined;
        break;

      case 'clear':
        // Clear tags: save empty array as explicit clear marker
        updatedRepo.custom_tags = [];
        break;

      case 'keep-custom':
      default: {
        // Keep custom: check if tags match original source
        const aiTags = repository.ai_tags || [];
        const topics = repository.topics || [];
        const currentTags = formData.tags;

        // If tags array is empty, save as empty array (explicitly cleared)
        if (currentTags.length === 0) {
          updatedRepo.custom_tags = [];
        }
        // If exactly matching AI tags, clear custom tags
        else if (JSON.stringify([...currentTags].sort()) === JSON.stringify([...aiTags].sort())) {
          updatedRepo.custom_tags = undefined;
        }
        // If exactly matching topics, clear custom tags
        else if (JSON.stringify([...currentTags].sort()) === JSON.stringify([...topics].sort())) {
          updatedRepo.custom_tags = undefined;
        }
        // Otherwise save as custom
        else {
          updatedRepo.custom_tags = currentTags;
        }
        break;
      }
    }

    /**
     * Category field handling logic
     * 
     * Core logic:
     * - Custom status display: only checks whether it matches AI/default (determined in RepositoryCard)
     * - Category lock: independent setting; save category value when locked
     */
    const aiCat = getAICategory(repository, allCategories);
    const defaultCat = getDefaultCategory(repository, allCategories);
    const currentCat = formData.category;

    // Lock is an independent setting
    if (formData.categoryLocked && currentCat) {
      // User locked category: save category value so lock takes effect
      updatedRepo.custom_category = currentCat;
      updatedRepo.category_locked = true;
    } else {
      // User did not lock category: calculate using generic function; clear custom flag if matching AI/default
      updatedRepo.custom_category = computeCustomCategory(currentCat, aiCat, defaultCat);

      if (updatedRepo.custom_category === undefined || updatedRepo.custom_category === '') {
        updatedRepo.category_locked = false;
      } else {
        updatedRepo.category_locked = formData.categoryLocked;
      }
    }

    // Update edit timestamp
    updatedRepo.last_edited = new Date().toISOString();

    updateRepository(updatedRepo);
    await forceSyncToBackend();
    onClose();
  };

  const handleClose = () => {
    setFormData({
      description: '',
      tags: [],
      category: '',
      categoryLocked: false
    });
    setNewTag('');
    onClose();
  };

  /**
   * Add tag
   * When user manually modifies tags, set edit intent to 'keep-custom'
   */
  const handleAddTag = () => {
    if (newTag.trim() && !formData.tags.includes(newTag.trim())) {
      setFormData(prev => ({
        ...prev,
        tags: [...prev.tags, newTag.trim()]
      }));
      setNewTag('');
      // User edited manually, intent becomes keep-custom
      setEditIntent(prev => ({ ...prev, tags: 'keep-custom' }));
    }
  };

  /**
   * Remove tag
   * When user manually modifies tags, set edit intent to 'keep-custom'
   */
  const handleRemoveTag = (tagToRemove: string) => {
    setFormData(prev => ({
      ...prev,
      tags: prev.tags.filter(tag => tag !== tagToRemove)
    }));
    // User edited manually, intent becomes keep-custom
    setEditIntent(prev => ({ ...prev, tags: 'keep-custom' }));
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleAddTag();
    }
  };

  const t = useT('repositories');

  /**
   * Detect whether there are changes
   * Considers both form value changes and edit intent changes
   */
  const hasChanges = useMemo(() => {
    const formChanged = formData.description !== initialDataRef.current.description ||
           JSON.stringify(formData.tags) !== JSON.stringify(initialDataRef.current.tags) ||
           formData.category !== initialDataRef.current.category ||
           formData.categoryLocked !== initialDataRef.current.categoryLocked;

    // Compare with initial intent, not just 'keep-custom'
    // Initial intent might be 'reset-to-ai', etc.; counts as changed only when intent actually changed
    const intentChanged = editIntent.description !== initialEditIntentRef.current.description ||
                          editIntent.tags !== initialEditIntentRef.current.tags ||
                          editIntent.category !== initialEditIntentRef.current.category;

    return formChanged || intentChanged;
  }, [formData, editIntent]);

  /**
   * Compute custom status after saving
   * Compares current form values against original values to determine which fields will be marked [custom]
   */
  const customStatus = useMemo(() => {
    if (!repository) return { description: false, tags: false, category: false };

    const isDescCustom = editIntent.description === 'keep-custom' &&
      (formData.description || '').trim() !== '' &&
      (formData.description || '').trim() !== (repository.ai_summary || '').trim() &&
      (formData.description || '').trim() !== (repository.description || '').trim();

    const aiTags = repository.ai_tags || [];
    const topics = repository.topics || [];
    const currentTags = formData.tags;

    const isTagsCustom = editIntent.tags === 'keep-custom' &&
      currentTags.length > 0 &&
      JSON.stringify([...currentTags].sort()) !== JSON.stringify([...aiTags].sort()) &&
      JSON.stringify([...currentTags].sort()) !== JSON.stringify([...topics].sort());

    const aiCategory = getAICategory(repository, allCategories);
    const defaultCategory = getDefaultCategory(repository, allCategories);

    const isCategoryCustom = editIntent.category === 'keep-custom' &&
      formData.category !== '' &&
      formData.category !== aiCategory &&
      formData.category !== defaultCategory;

    return { description: isDescCustom, tags: isTagsCustom, category: isCategoryCustom };
  }, [formData, repository, allCategories, editIntent]);

  /**
   * Reset to AI summary
   * Sets edit intent to 'reset-to-ai'; saving will clear custom_description
   */
  const resetToAI = () => {
    if (!repository) return;
    if (repository.ai_summary) {
      setFormData(prev => ({ ...prev, description: repository.ai_summary! }));
      setEditIntent(prev => ({ ...prev, description: 'reset-to-ai' }));
    }
  };

  /**
   * Reset to original description
   * Sets edit intent to 'reset-to-original'; saving will clear custom_description
   */
  const resetToOriginal = () => {
    if (!repository) return;
    if (repository.description) {
      setFormData(prev => ({ ...prev, description: repository.description! }));
      setEditIntent(prev => ({ ...prev, description: 'reset-to-original' }));
    }
  };

  /**
   * Clear custom description
   * Sets edit intent to 'clear'; saving will store an empty string marker
   */
  const clearDescription = () => {
    setFormData(prev => ({ ...prev, description: '' }));
    setEditIntent(prev => ({ ...prev, description: 'clear' }));
  };

  /**
   * Reset tags to AI tags
   * Sets edit intent to 'reset-to-ai'; saving will clear custom_tags
   */
  const resetTagsToAI = () => {
    if (!repository) return;
    if (repository.ai_tags && repository.ai_tags.length > 0) {
      setFormData(prev => ({ ...prev, tags: repository.ai_tags! }));
      setEditIntent(prev => ({ ...prev, tags: 'reset-to-ai' }));
    }
  };

  /**
   * Reset tags to topics
   * Sets edit intent to 'reset-to-original'; saving will clear custom_tags
   */
  const resetTagsToTopics = () => {
    if (!repository) return;
    if (repository.topics && repository.topics.length > 0) {
      setFormData(prev => ({ ...prev, tags: repository.topics! }));
      setEditIntent(prev => ({ ...prev, tags: 'reset-to-original' }));
    }
  };

  /**
   * Clear custom tags
   * Sets edit intent to 'clear'; saving will store an empty array
   */
  const clearTags = () => {
    setFormData(prev => ({ ...prev, tags: [] }));
    setEditIntent(prev => ({ ...prev, tags: 'clear' }));
  };

  /**
   * Reset category to AI-inferred category
   * Sets edit intent to 'reset-to-ai'; saving will clear custom_category
   */
  const resetCategoryToAI = () => {
    if (!repository) return;
    const aiCat = getAICategory(repository, allCategories);
    if (aiCat) {
      setFormData(prev => ({ ...prev, category: aiCat, categoryLocked: false }));
      setEditIntent(prev => ({ ...prev, category: 'reset-to-ai' }));
    }
  };

  /**
   * Reset category to default category (matched based on repo metadata)
   * Sets edit intent to 'reset-to-original'; saving will clear custom_category
   */
  const resetCategoryToDefault = () => {
    if (!repository) return;
    const defaultCat = getDefaultCategory(repository, allCategories);
    if (defaultCat) {
      setFormData(prev => ({ ...prev, category: defaultCat, categoryLocked: false }));
      setEditIntent(prev => ({ ...prev, category: 'reset-to-original' }));
    }
  };

  /**
   * Clear custom category
   * Sets edit intent to 'clear'; saving will store an empty value
   */
  const clearCategory = () => {
    setFormData(prev => ({ ...prev, category: '', categoryLocked: false }));
    setEditIntent(prev => ({ ...prev, category: 'clear' }));
  };

  // Handle close - close directly without secondary confirmation
  const handleCloseWithConfirm = () => {
    handleClose();
  };

  if (!repository) return null;

  // Unified card styles with enhanced light mode optimization
  const sectionClass = "p-5 bg-card dark:bg-card rounded-xl border border-border dark:border-border shadow-sm";
  const labelClass = "flex items-center space-x-2 text-[13px] font-medium text-foreground dark:text-foreground mb-3";
  const inputClass = "h-auto w-full px-4 py-3 bg-accent/50 dark:bg-muted/40 border border-border dark:border-border rounded-xl text-foreground dark:text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-ring dark:focus:ring-ring/50 dark:focus:border-ring transition-[color,background-color,border-color] duration-200 hover:bg-accent/50 dark:hover:bg-accent hover:border-border dark:hover:border-border-strong text-[13px] leading-[1.625]";
  const textareaClass = `${inputClass} resize-y min-h-[120px] max-h-[400px] overflow-y-auto scrollbar-auto`;
  const buttonSecondaryClass = "h-auto flex items-center space-x-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-all duration-200";
  const tagClass = "inline-flex items-center px-2.5 py-1 bg-muted text-muted-foreground dark:bg-muted/40 dark:text-muted-foreground rounded-md text-sm border border-border dark:border-border";
  const infoBoxClass = "mt-3 p-3.5 border border-border dark:border-border rounded-xl text-[12px] leading-[1.5] transition-all duration-200";
  const infoTextClass = "text-muted-foreground dark:text-muted-foreground flex items-start";

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={t('repositoryEditModal.edit-repository-info')}
      maxWidth="max-w-2xl"
      scrollable
      onOverlayPointerDown={onOutsideDismiss}
      onPointerDownOutside={(event) => {
        // Keep the overlay mounted through this click sequence. Otherwise the
        // follow-up click can be retargeted to the repository card and open README.
        onOutsideDismiss?.();
        deferOutsideDismiss(event, handleClose);
      }}
      footer={(
        <div className="flex justify-end space-x-3">
          <Button
            onClick={handleCloseWithConfirm}
            className="flex items-center space-x-2 px-4 py-2.5 text-muted-foreground dark:text-foreground bg-card dark:bg-muted/40 rounded-xl hover:bg-accent dark:hover:bg-accent border border-border dark:border-border transition-all duration-200 shadow-sm"
          >
            <X className="w-4 h-4" />
            <span className="font-medium">{t('repositoryEditModal.cancel')}</span>
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={!hasChanges}
            className="flex items-center space-x-2 px-5 py-2.5 bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-sm font-medium"
          >
            <Save className="w-4 h-4" />
            <span>{t('repositoryEditModal.save')}</span>
          </Button>
        </div>
      )}
    >
      <div className="space-y-5">
        {/* Repository Info Header */}
        <div className="flex items-center space-x-3 p-4 bg-gradient-to-r from-accent/60 to-background dark:bg-primary/10 dark:from-transparent dark:to-transparent rounded-xl border border-border dark:border-primary/20">
          <img
            src={repository.owner.avatar_url}
            alt={repository.owner.login}
            className="w-10 h-10 rounded-full border-2 border-card dark:border-card shadow-sm"
          />
          <div className="flex-1 min-w-0">
            <h4 className="font-semibold text-foreground dark:text-foreground truncate">
              {repository.name}
            </h4>
            <p className="text-sm text-muted-foreground dark:text-muted-foreground">
              {repository.owner.login}
            </p>
          </div>
          {repository.description && (
            <div className="hidden sm:block text-xs text-muted-foreground dark:text-muted-foreground max-w-xs truncate">
              {repository.description}
            </div>
          )}
        </div>

        {/* Description Section */}
        <div className={sectionClass}>
          <div className={labelClass}>
            <Edit3 className="w-4 h-4 text-primary dark:text-primary" />
            <span>{t('repositoryEditModal.description')}</span>
            {customStatus.description && (
              <span className="ml-2 px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground dark:bg-muted/40 dark:text-muted-foreground rounded-full">
                {t('repositoryEditModal.custom')}
              </span>
            )}
            <span className="ml-auto text-xs text-muted-foreground dark:text-muted-foreground">
              {formData.description.length > 0 ? t('app:repositoryEditModal.char-count', { count: formData.description.length }) : t('repositoryEditModal.empty')}
            </span>
          </div>

          {/* Source Indicator */}
          <div className="flex items-center gap-2 mb-3">
            <span className="text-xs text-muted-foreground dark:text-muted-foreground">{t('repositoryEditModal.source')}</span>
            {editIntent.description === 'keep-custom' && (formData.description || '').trim() !== '' ? (
              <span className="inline-flex items-center px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground dark:bg-muted/40 dark:text-muted-foreground rounded-full">
                <Edit3 className="w-3 h-3 mr-1" />
                {t('repositoryEditModal.custom')}
              </span>
            ) : editIntent.description === 'keep-custom' && (formData.description || '').trim() === '' ? (
              <span className="inline-flex items-center px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground dark:bg-muted/40 dark:text-muted-foreground rounded-full">
                <AlertTriangle className="w-3 h-3 mr-1" />
                {t('repositoryEditModal.will-fallback')}
              </span>
            ) : editIntent.description === 'reset-to-ai' ? (
              <span className="inline-flex items-center px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground dark:bg-muted/40 dark:text-muted-foreground rounded-full">
                <Bot className="w-3 h-3 mr-1" />
                {t('repositoryEditModal.ai-summary')}
              </span>
            ) : editIntent.description === 'reset-to-original' ? (
              <span className="inline-flex items-center px-2 py-0.5 text-xs font-medium bg-muted text-foreground dark:bg-muted/40 dark:text-muted-foreground rounded-full">
                <FileText className="w-3 h-3 mr-1" />
                {t('repositoryEditModal.original')}
              </span>
            ) : editIntent.description === 'clear' ? (
              <span className="inline-flex items-center px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground dark:bg-muted/40 dark:text-muted-foreground rounded-full">
                <X className="w-3 h-3 mr-1" />
                {t('repositoryEditModal.cleared')}
              </span>
            ) : null}
          </div>

          <Textarea
            aria-label={t('repositoryEditModal.custom-description')}
            value={formData.description}
            onChange={(e) => {
              setFormData(prev => ({ ...prev, description: e.target.value }));
              setEditIntent(prev => ({ ...prev, description: 'keep-custom' }));
            }}
            className={textareaClass}
            rows={5}
            placeholder={t('repositoryEditModal.enter-custom-description')}
          />

          {/* Save Effect Info - Enhanced for Light Mode */}
          {editIntent.description === 'clear' ? (
            <div className={infoBoxClass}>
              <p className={`${infoTextClass} text-destructive`}>
                <AlertTriangle className="w-4 h-4 mr-2 mt-0.5 flex-shrink-0" />
                <span>
                  {t('repositoryEditModal.description-cleared-no-description-will-be-shown')}
                </span>
              </p>
            </div>
          ) : editIntent.description === 'reset-to-ai' ? (
            <div className={infoBoxClass}>
              <p className={`${infoTextClass} text-primary`}>
                <Bot className="w-4 h-4 mr-2 mt-0.5 flex-shrink-0" />
                <span>
                  {t('repositoryEditModal.custom-description-will-be-cleared-after-saving')}
                </span>
              </p>
            </div>
          ) : editIntent.description === 'reset-to-original' ? (
            <div className={infoBoxClass}>
              <p className={infoTextClass}>
                <FileText className="w-4 h-4 mr-2 mt-0.5 flex-shrink-0" />
                <span>
                  {t('repositoryEditModal.custom-description-will-be-cleared-after-saving-2')}
                </span>
              </p>
            </div>
          ) : editIntent.description === 'keep-custom' && (formData.description || '').trim() === '' ? (
            <div className={infoBoxClass}>
              <p className={`${infoTextClass} text-warning`}>
                <AlertTriangle className="w-4 h-4 mr-2 mt-0.5 flex-shrink-0" />
                <span>
                  {repository?.ai_summary
                    ? t('repositoryEditModal.currently-empty-ai-summary-will-be-shown-after-s')
                    : repository?.description
                      ? t('repositoryEditModal.currently-empty-original-description-will-be-sho')
                      : t('repositoryEditModal.no-description-source-available')}
                </span>
              </p>
            </div>
          ) : editIntent.description === 'keep-custom' && customStatus.description ? (
            <div className={infoBoxClass}>
              <p className={`${infoTextClass} text-primary`}>
                <Info className="w-4 h-4 mr-2 mt-0.5 flex-shrink-0" />
                <span>
                  {t('repositoryEditModal.this-custom-description-will-be-used-after-savin')}
                </span>
              </p>
            </div>
          ) : editIntent.description === 'keep-custom' && formData.description.trim() !== '' && !customStatus.description ? (
            <div className={infoBoxClass}>
              <p className={infoTextClass}>
                <Info className="w-4 h-4 mr-2 mt-0.5 flex-shrink-0" />
                <span>
                  {t('repositoryEditModal.current-content-matches-ai-summary-or-original-d')}
                </span>
              </p>
            </div>
          ) : null}

          {/* Action Buttons */}
          <div className="flex flex-wrap gap-2 mt-3">
            {repository.ai_summary && (
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  resetToAI();
                }}
                className={`${buttonSecondaryClass} ${
                  editIntent.description === 'reset-to-ai'
                    ? 'bg-muted text-foreground border-transparent dark:bg-accent dark:text-foreground dark:border-transparent'
                    : 'bg-card text-muted-foreground border-border hover:bg-accent dark:bg-transparent dark:text-muted-foreground dark:border-border dark:hover:bg-card dark:hover:text-foreground'
                }`}
              >
                <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                <span>{t('repositoryEditModal.reset-to-ai')}</span>
              </Button>
            )}
            {repository.description && (
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  resetToOriginal();
                }}
                className={`${buttonSecondaryClass} ${
                  editIntent.description === 'reset-to-original'
                    ? 'bg-muted text-foreground border-border dark:bg-accent dark:text-foreground dark:border-border'
                    : 'bg-card text-muted-foreground border-border hover:bg-background dark:bg-muted/40 dark:text-muted-foreground dark:border-border dark:hover:bg-accent dark:hover:text-foreground'
                }`}
              >
                <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                <span>{t('repositoryEditModal.reset-to-original')}</span>
              </Button>
            )}
            <Button
              onClick={(e) => {
                e.stopPropagation();
                clearDescription();
              }}
              className={`${buttonSecondaryClass} ${
                editIntent.description === 'clear'
                  ? 'bg-muted text-foreground border-transparent dark:bg-accent dark:text-foreground dark:border-transparent'
                  : 'bg-card text-muted-foreground border-border hover:bg-accent dark:bg-transparent dark:text-muted-foreground dark:border-border dark:hover:bg-card dark:hover:text-foreground'
              }`}
            >
              <X className="w-3.5 h-3.5 mr-1.5" />
              <span>{t('repositoryEditModal.clear')}</span>
            </Button>
          </div>

          {/* Feature Tip - Enhanced */}
          <div className={`${infoBoxClass} bg-gradient-to-br from-accent/30 to-background/60 dark:from-transparent dark:to-transparent`}>
            <p className="text-xs text-muted-foreground dark:text-muted-foreground flex items-start">
              <Info className="w-3.5 h-3.5 mr-2 mt-0.5 flex-shrink-0 text-muted-foreground dark:text-muted-foreground" />
              <span>
                {t('repositoryEditModal.description-priority-custom-ai-summary-original')}
              </span>
            </p>
          </div>
        </div>

        {/* Category Section */}
        <div className={sectionClass}>
          <div className={labelClass}>
            <FolderOpen className="w-4 h-4 text-success " />
            <span>{t('repositoryEditModal.category')}</span>
            {customStatus.category && (
              <span className="ml-2 px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground dark:bg-muted/40 dark:text-muted-foreground rounded-full">
                {t('repositoryEditModal.custom')}
              </span>
            )}
          </div>

          <Select value={formData.category || 'none'} onValueChange={(newCategory) => {
            if (newCategory !== 'none' && newCategory.trim().toLowerCase() === 'none') return;
            const nextCategory = newCategory === 'none' ? '' : newCategory;
            setFormData(prev => ({ ...prev, category: nextCategory, categoryLocked: nextCategory ? prev.categoryLocked : false }));
            setEditIntent(prev => ({ ...prev, category: 'keep-custom' }));
          }}>
            <SelectTrigger aria-label={t('repositoryEditModal.category')} className={inputClass}><SelectValue placeholder={t('repositoryEditModal.select-category')} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t('repositoryEditModal.select-category')}</SelectItem>
              {allCategories.filter(cat => cat.id !== 'all' && cat.name.trim().toLowerCase() !== 'none').map(category => <SelectItem key={category.id} value={category.name}>{category.icon} {category.name}</SelectItem>)}
            </SelectContent>
          </Select>

          {/* Category Action Buttons */}
          <div className="flex flex-wrap gap-2 mt-3">
            {repository && getAICategory(repository, allCategories) && (
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  resetCategoryToAI();
                }}
                className={`${buttonSecondaryClass} ${
                  editIntent.category === 'reset-to-ai'
                    ? 'bg-muted text-foreground border-transparent dark:bg-accent dark:text-foreground dark:border-transparent'
                    : 'bg-card text-muted-foreground border-border hover:bg-accent dark:bg-transparent dark:text-muted-foreground dark:border-border dark:hover:bg-card dark:hover:text-foreground'
                }`}
              >
                <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                <span>{t('repositoryEditModal.reset-to-ai-category')}</span>
              </Button>
            )}
            {repository && getDefaultCategory(repository, allCategories) && (
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  resetCategoryToDefault();
                }}
                className={`${buttonSecondaryClass} ${
                  editIntent.category === 'reset-to-original'
                    ? 'bg-muted text-foreground border-border dark:bg-accent dark:text-foreground dark:border-border'
                    : 'bg-card text-muted-foreground border-border hover:bg-background dark:bg-muted/40 dark:text-muted-foreground dark:border-border dark:hover:bg-accent'
                }`}
              >
                <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                <span>{t('repositoryEditModal.reset-to-default')}</span>
              </Button>
            )}
            <Button
              onClick={(e) => {
                e.stopPropagation();
                clearCategory();
              }}
              className={`${buttonSecondaryClass} ${
                editIntent.category === 'clear'
                  ? 'bg-muted text-foreground border-transparent dark:bg-accent dark:text-foreground dark:border-transparent'
                  : 'bg-card text-muted-foreground border-border hover:bg-accent dark:bg-transparent dark:text-muted-foreground dark:border-border dark:hover:bg-card dark:hover:text-foreground'
              }`}
            >
              <X className="w-3.5 h-3.5 mr-1.5" />
              <span>{t('repositoryEditModal.clear-category')}</span>
            </Button>
          </div>

          {/* Custom Category Selection Info - Enhanced */}
          {editIntent.category === 'keep-custom' && formData.category && (
            <div className={infoBoxClass}>
              <p className={`${infoTextClass} text-primary`}>
                <Info className="w-4 h-4 mr-2 mt-0.5 flex-shrink-0" />
                <span>
                  {t('repositoryEditModal.custom-category-selected-the-repository-will-be')}
                </span>
              </p>
            </div>
          )}

          {/* Reset Category Info - Enhanced */}
          {editIntent.category === 'reset-to-ai' && (
            <div className={infoBoxClass}>
              <p className={`${infoTextClass} text-primary`}>
                <Info className="w-4 h-4 mr-2 mt-0.5 flex-shrink-0" />
                <span>
                  {t('repositoryEditModal.resetting-to-ai-category-will-clear-custom-categ')}
                </span>
              </p>
            </div>
          )}

          {editIntent.category === 'reset-to-original' && (
            <div className={infoBoxClass}>
              <p className={infoTextClass}>
                <Info className="w-4 h-4 mr-2 mt-0.5 flex-shrink-0" />
                <span>
                  {t('repositoryEditModal.resetting-to-default-category-will-clear-custom')}
                </span>
              </p>
            </div>
          )}

          {/* Clear Category Warning - Enhanced */}
          {editIntent.category === 'clear' && (
            <div className={infoBoxClass}>
              <p className={`${infoTextClass} text-destructive`}>
                <AlertTriangle className="w-4 h-4 mr-2 mt-0.5 flex-shrink-0" />
                <span>
                  {t('repositoryEditModal.after-clearing-the-category-the-repository-will')}
                </span>
              </p>
            </div>
          )}

          {/* Category Lock - Enhanced */}
          <div className="mt-4 p-4 bg-gradient-to-br from-muted to-muted/60 dark:from-foreground/[0.04] dark:to-warning/10 rounded-xl border border-border dark:border-warning/20 shadow-sm">
            <div className="flex items-start space-x-3">
              <div className="flex-shrink-0 mt-0.5">
                {formData.categoryLocked && formData.category ? (
                  <Lock className="w-4 h-4 text-muted-foreground dark:text-warning" />
                ) : (
                  <Unlock className="w-4 h-4 text-muted-foreground dark:text-muted-foreground" />
                )}
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-foreground dark:text-foreground">
                    {t('repositoryEditModal.category-lock')}
                  </span>
                  <Checkbox
                    checked={formData.categoryLocked && !!formData.category}
                    onCheckedChange={(checked) => {
                      if (!formData.category) return;
                      setFormData(prev => ({ ...prev, categoryLocked: checked === true }));
                    }}
                    disabled={!formData.category}
                    aria-label={t('repositoryEditModal.category-lock')}
                  />
                </div>
                <p className="text-xs text-muted-foreground dark:text-muted-foreground">
                  {!formData.category
                    ? t('repositoryEditModal.select-a-category-first-to-enable-locking')
                    : formData.categoryLocked
                      ? t('repositoryEditModal.locked-category-will-remain-unchanged-during-syn')
                      : t('repositoryEditModal.unlocked-category-may-be-auto-reclassified-by-ai')
                  }
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Tags Section */}
        <div className={sectionClass}>
          <div className={labelClass}>
            <Tag className="w-4 h-4 text-muted-foreground dark:text-muted-foreground " />
            <span>{t('repositoryEditModal.tags')}</span>
            {customStatus.tags && (
              <span className="ml-2 px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground dark:bg-muted/40 dark:text-muted-foreground rounded-full">
                {t('repositoryEditModal.custom')}
              </span>
            )}
            <span className="ml-auto text-xs text-muted-foreground dark:text-muted-foreground">
              {formData.tags.length > 0 ? `${formData.tags.length} ${t('repositoryEditModal.tags-2')}` : t('repositoryEditModal.no-tags')}
            </span>
          </div>

          {/* Tags Display */}
          {formData.tags.length > 0 ? (
            <div className="flex flex-wrap gap-2 mb-4">
              {formData.tags.map((tag, index) => (
                <span key={index} className={tagClass}>
                  {tag}
                  <Button
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRemoveTag(tag);
                    }}
                    className="ml-1.5 h-7 w-7 p-0 hover:bg-accent dark:hover:bg-accent hover:text-foreground dark:text-foreground dark:hover:text-foreground rounded transition-colors"
                    title={t('repositoryEditModal.remove')}
                    aria-label={t('repositoryEditModal.remove-tag-tag', { tag: tag })}
                  >
                    <X className="w-3 h-3" />
                  </Button>
                </span>
              ))}
            </div>
          ) : (
            <div className="mb-4">
              <span className="text-sm text-muted-foreground dark:text-muted-foreground">{t('repositoryEditModal.no-tags-2')}</span>
            </div>
          )}

          {/* Quick Actions */}
          <div className="flex flex-wrap gap-2 mb-4">
            {repository.ai_tags && repository.ai_tags.length > 0 && (
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  resetTagsToAI();
                }}
                className={`${buttonSecondaryClass} ${
                  editIntent.tags === 'reset-to-ai'
                    ? 'bg-muted text-foreground border-transparent dark:bg-accent dark:text-foreground dark:border-transparent'
                    : 'bg-card text-muted-foreground border-border hover:bg-accent dark:bg-transparent dark:text-muted-foreground dark:border-border dark:hover:bg-card dark:hover:text-foreground'
                }`}
              >
                <Bot className="w-3.5 h-3.5 mr-1.5" />
                <span>{t('repositoryEditModal.reset-to-ai-2')}</span>
              </Button>
            )}
            {repository.topics && repository.topics.length > 0 && (
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  resetTagsToTopics();
                }}
                className={`${buttonSecondaryClass} ${
                  editIntent.tags === 'reset-to-original'
                    ? 'bg-muted text-foreground border-transparent dark:bg-accent dark:text-foreground dark:border-transparent'
                    : 'bg-card text-muted-foreground border-border hover:bg-accent dark:bg-transparent dark:text-muted-foreground dark:border-border dark:hover:bg-card dark:hover:text-foreground'
                }`}
              >
                <FileText className="w-3.5 h-3.5 mr-1.5" />
                <span>{t('repositoryEditModal.reset-to-topics')}</span>
              </Button>
            )}
            <Button
              onClick={(e) => {
                e.stopPropagation();
                clearTags();
              }}
              className={`${buttonSecondaryClass} ${
                editIntent.tags === 'clear'
                  ? 'bg-muted text-foreground border-transparent dark:bg-accent dark:text-foreground dark:border-transparent'
                  : 'bg-card text-muted-foreground border-border hover:bg-accent dark:bg-transparent dark:text-muted-foreground dark:border-border dark:hover:bg-card dark:hover:text-foreground'
              }`}
            >
              <X className="w-3.5 h-3.5 mr-1.5" />
              <span>{t('repositoryEditModal.clear-2')}</span>
            </Button>
          </div>

          {/* Status Alert - Enhanced */}
          {formData.tags.length === 0 && (
            <div className={`${infoBoxClass} mb-4`}>
              <p className={`${infoTextClass} flex items-center`}>
                {editIntent.tags === 'clear' ? (
                  <>
                    <span className="mr-2">⚠️</span>
                    {t('repositoryEditModal.tags-cleared-no-tags-will-be-shown-after-saving')}
                  </>
                ) : editIntent.tags === 'reset-to-ai' ? (
                  <>
                    <span className="mr-2 text-success">✓</span>
                    {t('repositoryEditModal.ai-tags-will-be-shown')}
                  </>
                ) : editIntent.tags === 'reset-to-original' ? (
                  <>
                    <span className="mr-2 text-success">✓</span>
                    {t('repositoryEditModal.github-topics-will-be-shown')}
                  </>
                ) : repository?.ai_tags && repository.ai_tags.length > 0 ? (
                  <>
                    <span className="mr-2">⚠️</span>
                    {t('repositoryEditModal.no-custom-tags-ai-tags-will-be-shown-after-savin')}
                  </>
                ) : repository?.topics && repository.topics.length > 0 ? (
                  <>
                    <span className="mr-2">⚠️</span>
                    {t('repositoryEditModal.no-custom-tags-github-topics-will-be-shown-after')}
                  </>
                ) : (
                  <>
                    <span className="mr-2">⚠️</span>
                    {t('repositoryEditModal.no-tags-available')}
                  </>
                )}
              </p>
            </div>
          )}

          {/* Add New Tag */}
          <div className="flex space-x-2">
            <Input
              aria-label={t('repositoryEditModal.add-custom-tag')}
              type="text"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={handleKeyPress}
              className={inputClass}
              placeholder={t('repositoryEditModal.add-custom-tag-2')}
            />
            <Button
              aria-label={t('repositoryEditModal.add-tag')}
              onClick={(e) => {
                e.stopPropagation();
                handleAddTag();
              }}
              disabled={!newTag.trim()}
              className="flex items-center px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90  disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Plus className="w-4 h-4" />
            </Button>
          </div>

        </div>

      </div>
    </Modal>
  );
};
