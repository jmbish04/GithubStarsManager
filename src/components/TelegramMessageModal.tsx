import { getIntlLocale } from '../i18n/format';
import { useT } from "../i18n/useT";
import React from 'react';
import { ExternalLink, Calendar } from 'lucide-react';
import { Modal } from './Modal';
import MarkdownRenderer from './MarkdownRenderer';
import { useAppStore } from '../store/useAppStore';
import type { TelegramRef } from '../types';

interface TelegramMessageModalProps {
  isOpen: boolean;
  onClose: () => void;
  message: TelegramRef;
}

/**
 * Modal to view the original Telegram channel message: displays the fetched channel message body
 * (HTML snippet output by t.me public preview, sanitized via rehype-sanitize), with channel,
 * timestamp, and original message link in the footer.
 */
export const TelegramMessageModal: React.FC<TelegramMessageModalProps> = ({ isOpen, onClose, message }) => {
  const language = useAppStore(state => state.language);
  const t = useT('plugins');

  const messageDate = message.createdAt && Number.isFinite(Date.parse(message.createdAt))
    ? new Date(message.createdAt).toLocaleString(getIntlLocale(language))
    : '';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('telegramMessageModal.channel-message-from-v1', { v1: message.displayName })}
      maxWidth="max-w-4xl"
      scrollable
      footer={
        <div className="flex items-center justify-between gap-3 w-full">
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            <span className="px-2 py-0.5 rounded-md text-xs font-medium bg-primary/10 text-primary dark:text-primary">
              @{message.channel}
            </span>
            {messageDate && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground dark:text-muted-foreground">
                <Calendar className="w-3 h-3" />
                {messageDate}
              </span>
            )}
          </div>
          <a
            href={message.html_url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
            {t('telegramMessageModal.open-in-telegram')}
          </a>
        </div>
      }
    >
      {message.content ? (
        <MarkdownRenderer
          content={message.content}
          enableHtml
          baseUrl={message.html_url}
        />
      ) : (
        <div className="py-10 text-center text-sm text-muted-foreground dark:text-muted-foreground">
          {t('telegramMessageModal.this-message-is-media-only-and-has-no-text-conte')}
        </div>
      )}
    </Modal>
  );
};
