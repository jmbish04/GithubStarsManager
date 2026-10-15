



import { useT } from '../i18n/useT';
import { ListChecks, Star } from 'lucide-react';
import React, { useRef } from 'react';
import { useAppStore } from '../store/useAppStore';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';

/**
 * Select sync scope on first login / first use of GitHub Lists sync.
 * Must be rendered inside an authenticated component tree (such as App's authenticated shell),
 * cannot be triggered inside LoginScreen—because LoginScreen unmounts after setUser, preventing the modal from displaying.
 *
 * This modal is a blocking modal: a choice must be completed; it cannot be closed or dismissed by clicking the backdrop.
 */
export const SyncModeChoiceModal: React.FC = () => {
  const syncModeConfigured = useAppStore((state) => state.syncModeConfigured);
  const setSyncMode = useAppStore((state) => state.setSyncMode);
  const setSyncModeConfigured = useAppStore((state) => state.setSyncModeConfigured);

  const t = useT('app');
  const isOpen = !syncModeConfigured;
  const firstActionRef = useRef<HTMLButtonElement>(null);
  const optionClassName = 'h-auto w-full justify-start gap-3 whitespace-normal rounded-xl border border-border bg-card p-4 text-left text-foreground shadow-none hover:border-primary/40 hover:bg-card dark:border-border dark:bg-muted/40 dark:text-foreground dark:hover:bg-accent';

  const handleChooseSyncMode = (mode: 'stars' | 'stars-and-lists') => {
    setSyncMode(mode);
    setSyncModeConfigured(true);
  };

  return (
    <AlertDialog open={isOpen} onOpenChange={() => undefined}>
      <AlertDialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          firstActionRef.current?.focus();
        }}
        onEscapeKeyDown={(event) => event.preventDefault()}
        className="max-w-md p-6 sm:p-7"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{t('syncModeChoiceModal.choose-sync-scope')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('syncModeChoiceModal.what-should-be-synced-you-can-change-this-anytim')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <AlertDialogAction
            ref={firstActionRef}
            onClick={() => handleChooseSyncMode('stars')}
            className={optionClassName}
          >
            <Star className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <span>
              <span className="block font-medium">{t('syncModeChoiceModal.starred-repos-only')}</span>
              <span className="mt-1 block text-xs font-normal text-muted-foreground dark:text-muted-foreground">
                {t('syncModeChoiceModal.sync-all-your-starred-repositories-default-same')}
              </span>
            </span>
          </AlertDialogAction>
          <AlertDialogAction
            onClick={() => handleChooseSyncMode('stars-and-lists')}
            className={optionClassName}
          >
            <ListChecks className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <span>
              <span className="block font-medium">{t('syncModeChoiceModal.starred-repos-lists')}</span>
              <span className="mt-1 block text-xs font-normal text-muted-foreground dark:text-muted-foreground">
                {t('syncModeChoiceModal.also-fetch-your-lists-and-categorize-by-tags-unl')}
              </span>
            </span>
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default SyncModeChoiceModal;
