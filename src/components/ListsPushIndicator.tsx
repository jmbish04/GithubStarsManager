



import { useT } from '../i18n/useT';
import React, { useEffect, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { useDialog } from '../hooks/useDialog';

/**
 * Global GitHub Lists push progress indicator.
 * The process runs as a store-level action and persists across page navigation;
 * this provides a cross-page floating progress overlay and toasts on completion or failure.
 */
export const ListsPushIndicator: React.FC = () => {
  const { listsPush, resetListsPush } = useAppStore(useShallow((state) => ({
    language: state.language,
    listsPush: state.listsPush,
    resetListsPush: state.resetListsPush,
  })));
  const { toast } = useDialog();
  const t = useT('app');

  const prevRunningRef = useRef(listsPush.isRunning);
  // Compare by object reference: each store write produces a new listsPush object, re-triggering notifications even if the error text is identical
  const prevListsPushRef = useRef(listsPush);
  // Keep delayed reset timer in a ref so subsequent store writes re-running the effect do not cancel it prematurely
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(resetTimerRef.current), []);

  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    const prevListsPush = prevListsPushRef.current;
    prevRunningRef.current = listsPush.isRunning;
    prevListsPushRef.current = listsPush;
    // Any new push state replaces the previous pending reset, preventing it from clearing the new run state or error
    if (listsPush !== prevListsPush) clearTimeout(resetTimerRef.current);

    if (wasRunning && !listsPush.isRunning) {
      if (listsPush.error) {
        toast(listsPush.error, 'error');
      } else if (listsPush.message) {
        toast(listsPush.message, 'success');
      }
      resetTimerRef.current = setTimeout(() => resetListsPush(), 4000);
      return;
    }

    // Errors occurring when not running (e.g. pre-flight token/repo/selection validation failure) have no running->finished transition and need an immediate toast.
    // Do not call reset: errors are displayed inline by StarSyncPanel and retained in the store.
    if (!wasRunning && !listsPush.isRunning && listsPush.error && listsPush !== prevListsPush) {
      toast(listsPush.error, 'error');
    }
  }, [listsPush, toast, resetListsPush]);

  if (!listsPush.isRunning) return null;

  const percent = listsPush.total > 0
    ? Math.min(100, Math.round((listsPush.done / listsPush.total) * 100))
    : 0;

  return (
    <div className="fixed bottom-4 right-4 z-[9999] w-80 max-w-[calc(100vw_-_2rem)] bg-card dark:bg-card rounded-xl border border-border dark:border-border shadow-lg p-4">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-sm font-medium text-foreground dark:text-foreground">
          {t('listsPushIndicator.pushing-categories-to-lists')}
        </span>
        <span className="text-xs text-muted-foreground dark:text-muted-foreground shrink-0">
          {listsPush.total > 0 ? `${listsPush.done}/${listsPush.total}` : '…'}
        </span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden mb-2">
        <div
          className="h-full bg-primary dark:bg-primary transition-all duration-200"
          style={{ width: `${percent}%` }}
        />
      </div>
      {listsPush.currentLabel && (
        <p className="text-xs text-muted-foreground dark:text-muted-foreground truncate">
          {listsPush.currentLabel}
        </p>
      )}
    </div>
  );
};

export default ListsPushIndicator;
