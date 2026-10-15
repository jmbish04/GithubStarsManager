import type { AppLanguage } from '../../../i18n/languages';
import { useEffect, useRef, useState } from 'react';
import type { RepositoryChatMessage } from '../../../types/repositoryChat';

export type TurnAnnouncementStatus = '' | RepositoryChatMessage['status'];

/**
 * Produces a one-time screen reader announcement text only when an answer transitions from streaming to a terminal state.
 * Clears old announcements upon entering the streaming state, ensuring the same announcement text can be broadcast again across consecutive completed turns.
 */
export const useTurnStatusAnnouncement = (lastAssistantStatus: TurnAnnouncementStatus, language: AppLanguage): string => {
  const [announcement, setAnnouncement] = useState('');
  const previousStatusRef = useRef<TurnAnnouncementStatus>('');

  useEffect(() => {
    const previous = previousStatusRef.current;
    previousStatusRef.current = lastAssistantStatus;
    if (lastAssistantStatus === 'streaming') {
      setAnnouncement('');
      return;
    }
    if (previous !== 'streaming') return;
    const zh = language === 'zh';
    if (lastAssistantStatus === 'complete') setAnnouncement(zh ? '回答已完成。' : 'Answer complete.');
    else if (lastAssistantStatus === 'error') setAnnouncement(zh ? '回答生成失败。' : 'Answer generation failed.');
    else if (lastAssistantStatus === 'aborted') setAnnouncement(zh ? '已停止生成。' : 'Generation stopped.');
  }, [lastAssistantStatus, language]);

  return announcement;
};
