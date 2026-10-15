import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useScrollbarFlash } from './useScrollbarFlash';

describe('useScrollbarFlash', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts idle and flashes while scrolling, then settles', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useScrollbarFlash(true));
    expect(result.current.isScrolling).toBe(false);

    act(() => {
      result.current.handleScroll();
    });
    expect(result.current.isScrolling).toBe(true);

    act(() => {
      vi.advanceTimersByTime(699);
    });
    expect(result.current.isScrolling).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.isScrolling).toBe(false);
  });

  it('keeps the thumb visible across continuous scrolling (no stacked timers)', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useScrollbarFlash(true));

    act(() => {
      result.current.handleScroll();
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    act(() => {
      result.current.handleScroll();
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    // Only 500ms since the last scroll; if timers stacked, it would have reset prematurely here.
    expect(result.current.isScrolling).toBe(true);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.isScrolling).toBe(false);
  });

  it('resets the pending timer and state when the view deactivates', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ active }) => useScrollbarFlash(active), {
      initialProps: { active: true },
    });

    act(() => {
      result.current.handleScroll();
    });
    expect(vi.getTimerCount()).toBe(1);

    rerender({ active: false });
    expect(result.current.isScrolling).toBe(false);
    // Pending timer has been cleared rather than left to fire late.
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      vi.advanceTimersByTime(700);
    });
    // Will not be set again after closing.
    expect(result.current.isScrolling).toBe(false);

    rerender({ active: true });
    act(() => {
      result.current.handleScroll();
    });
    expect(result.current.isScrolling).toBe(true);
  });

  it('clears the pending timer on unmount', () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useScrollbarFlash(true));

    act(() => {
      result.current.handleScroll();
    });
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    // Timer is cleared upon unmount: no lingering handle to trigger setState after unmount.
    expect(vi.getTimerCount()).toBe(0);

    expect(() => {
      act(() => {
        vi.advanceTimersByTime(700);
      });
    }).not.toThrow();
  });
});
