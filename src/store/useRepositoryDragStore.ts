import { create } from 'zustand';

interface RepositoryDragState {
  isDragging: boolean;
  /** Starts a repository card drag: sets state and registers document-level fallback listeners */
  startDrag: () => void;
  /** Ends drag: idempotent, removes fallback listeners */
  endDrag: () => void;
}

/**
 * Transient state during repository card dragging (not persisted).
 *
 * Why we cannot rely solely on the card's own React onDragEnd: if on drop the source card unmounts
 * from the current view due to category change, the browser dispatches dragend to a detached DOM node.
 * React's synthetic event delegated at the root container never receives it, so endDrag would never execute (root cause of issue #353).
 * Therefore startDrag also registers native document-level fallback listeners:
 * - dragend (capture): covers the normal path where the source node remains mounted;
 * - mousemove (capture): browsers suppress mousemove during HTML5 dragging,
 *   resuming dispatch immediately when dragging ends, reliably clearing state even if dragend was dropped.
 */
export const useRepositoryDragStore = create<RepositoryDragState>()((set, get) => {
  let cleanupFallback: (() => void) | null = null;

  const endDrag = () => {
    if (cleanupFallback) {
      cleanupFallback();
      cleanupFallback = null;
    }
    if (get().isDragging) {
      set({ isDragging: false });
    }
  };

  return {
    isDragging: false,
    startDrag: () => {
      endDrag();
      set({ isDragging: true });

      const onDragEnd = () => endDrag();
      const onMouseMove = () => endDrag();
      document.addEventListener('dragend', onDragEnd, true);
      document.addEventListener('mousemove', onMouseMove, true);
      cleanupFallback = () => {
        document.removeEventListener('dragend', onDragEnd, true);
        document.removeEventListener('mousemove', onMouseMove, true);
      };
    },
    endDrag,
  };
});
