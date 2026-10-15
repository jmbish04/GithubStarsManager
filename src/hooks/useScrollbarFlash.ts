import * as React from 'react';

const SCROLL_STOP_DELAY_MS = 700;

/**
 * Drives the scrolling state for the `scrollbar-on-scroll` utility class: returns true during scrolling
 * (and for a brief buffer window after stopping) to reveal the scrollbar thumb, then resets once stationary
 * to toggle `.scrolling`. When active becomes false (e.g. dialog closes), clears pending timers and resets
 * to prevent late state updates on closed views.
 */
export const useScrollbarFlash = (active: boolean): {
  isScrolling: boolean;
  handleScroll: () => void;
} => {
  const [isScrolling, setIsScrolling] = React.useState(false);
  const scrollStopTimerRef = React.useRef<number | null>(null);

  React.useEffect(() => () => {
    if (scrollStopTimerRef.current) window.clearTimeout(scrollStopTimerRef.current);
  }, []);

  React.useEffect(() => {
    if (active) return;
    if (scrollStopTimerRef.current) {
      window.clearTimeout(scrollStopTimerRef.current);
      scrollStopTimerRef.current = null;
    }
    setIsScrolling(false);
  }, [active]);

  const handleScroll = React.useCallback(() => {
    setIsScrolling(true);
    if (scrollStopTimerRef.current) window.clearTimeout(scrollStopTimerRef.current);
    scrollStopTimerRef.current = window.setTimeout(() => {
      setIsScrolling(false);
      scrollStopTimerRef.current = null;
    }, SCROLL_STOP_DELAY_MS);
  }, []);

  return { isScrolling, handleScroll };
};
