



import { useT } from '../../../i18n/useT';
import { useCallback, useState } from 'react';
import { probeTelegramSource } from '../../../services/telegramService';

/**
 * Orchestration hook for Telegram channel "Test Connection": fetches and parses the latest page of a channel,
 * returning displayable results (message count / repo link count or error). Views do not directly access services.
 */
export const useTelegramProbe = () => {
  const [isProbing, setIsProbing] = useState(false);
  const t = useT('discovery');
  const [probeResult, setProbeResult] = useState<string | null>(null);

  const probe = useCallback(async (channel: string) => {
    setIsProbing(true);
    setProbeResult(null);
    try {
      const result = await probeTelegramSource(channel);
      setProbeResult(result.ok
        ? `OK|${result.messageCount ?? 0}|${result.repoCount ?? 0}`
        : `FAIL|${result.error ?? 'Unknown error'}`);
    } catch (error) {
      setProbeResult(`FAIL|${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsProbing(false);
    }
  }, []);

  const message = probeResult === null
    ? null
    : probeResult.startsWith('OK|')
      ? (() => {
          const [, messageCount, repoCount] = probeResult.split('|');
          return t('useTelegramProbe.connected-parsed-messagecount-channel-messages-w', { messageCount: messageCount, repoCount: repoCount });
        })()
      : (() => {
          const [, error] = probeResult.split('|');
          return t('useTelegramProbe.failed-error', { error: error });
        })();
  const probeOk = probeResult?.startsWith('OK|') ?? null;

  return { probe, isProbing, message, probeOk };
};
