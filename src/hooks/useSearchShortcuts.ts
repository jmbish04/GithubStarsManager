import { useEffect, useRef } from 'react';

interface UseSearchShortcutsProps {
  onFocusSearch: () => void;
  onClearSearch: () => void;
  onToggleFilters: () => void;
}

/**
 * Search shortcuts hook.
 * Provides keyboard shortcut support to enhance the search experience.
 */
export const useSearchShortcuts = ({
  onFocusSearch,
  onClearSearch,
  onToggleFilters
}: UseSearchShortcutsProps) => {
  const isListening = useRef(true);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isListening.current) return;

      // Check if focus is inside an input element
      const isInInput = event.target instanceof HTMLInputElement || 
                       event.target instanceof HTMLTextAreaElement ||
                       (event.target as HTMLElement)?.contentEditable === 'true';

      // Ctrl/Cmd + K: Focus search box
      if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
        event.preventDefault();
        onFocusSearch();
        return;
      }

      // Escape: Clear search (only when inside search box)
      if (event.key === 'Escape' && isInInput) {
        onClearSearch();
        return;
      }

      // Ctrl/Cmd + Shift + F: Toggle filters
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === 'F') {
        event.preventDefault();
        onToggleFilters();
        return;
      }

      // Slash key: Quick-focus search box (only when outside input)
      if (event.key === '/' && !isInInput) {
        event.preventDefault();
        onFocusSearch();
        return;
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onFocusSearch, onClearSearch, onToggleFilters]);

  // Methods to pause/resume listening
  const pauseListening = () => {
    isListening.current = false;
  };

  const resumeListening = () => {
    isListening.current = true;
  };

  return {
    pauseListening,
    resumeListening
  };
};

/**
 * Search shortcut hint data.
 */
export const searchShortcuts = [
  {
    id: 'focus-search',
    key: 'Ctrl/Cmd + K',
    description: 'Focus search box',
    descriptionEn: 'Focus search box'
  },
  {
    id: 'clear-search',
    key: 'Escape',
    description: 'Clear search',
    descriptionEn: 'Clear search'
  },
  {
    id: 'toggle-filters',
    key: 'Ctrl/Cmd + Shift + F',
    description: 'Toggle filters',
    descriptionEn: 'Toggle filters'
  },
  {
    id: 'quick-search',
    key: '/',
    description: 'Quick search',
    descriptionEn: 'Quick search'
  },
  {
    id: 'ai-search',
    key: 'Enter',
    description: 'AI search',
    descriptionEn: 'AI search'
  }
];