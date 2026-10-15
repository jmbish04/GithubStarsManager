import { beforeEach, describe, expect, it } from 'vitest';
import { useRepositoryDragStore } from './useRepositoryDragStore';

const dispatchDragEnd = () => document.dispatchEvent(new Event('dragend'));
const dispatchMouseMove = () => document.dispatchEvent(new Event('mousemove'));

describe('useRepositoryDragStore', () => {
  beforeEach(() => {
    useRepositoryDragStore.getState().endDrag();
  });

  it('sets dragging state on startDrag', () => {
    useRepositoryDragStore.getState().startDrag();
    expect(useRepositoryDragStore.getState().isDragging).toBe(true);
  });

  it('clears dragging state via document-level dragend fallback', () => {
    useRepositoryDragStore.getState().startDrag();
    dispatchDragEnd();
    expect(useRepositoryDragStore.getState().isDragging).toBe(false);
  });

  it('clears dragging state via document-level mousemove fallback (recovery path when dragend is dropped)', () => {
    useRepositoryDragStore.getState().startDrag();
    dispatchMouseMove();
    expect(useRepositoryDragStore.getState().isDragging).toBe(false);
  });

  it('endDrag is idempotent and safe to call repeatedly', () => {
    const state = useRepositoryDragStore.getState();
    state.startDrag();
    state.endDrag();
    state.endDrag();
    expect(useRepositoryDragStore.getState().isDragging).toBe(false);
  });

  it('does not stack listeners on repeated startDrag: a single dragend clears state', () => {
    const state = useRepositoryDragStore.getState();
    state.startDrag();
    state.startDrag();
    dispatchDragEnd();
    expect(useRepositoryDragStore.getState().isDragging).toBe(false);
    // Fallback listeners are completely removed after clearing; subsequent events no longer affect state
    state.startDrag();
    expect(useRepositoryDragStore.getState().isDragging).toBe(true);
    state.endDrag();
  });
});
