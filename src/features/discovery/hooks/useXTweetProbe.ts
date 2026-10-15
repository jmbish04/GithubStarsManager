



import { useT } from '../../../i18n/useT';
import { useCallback, useState } from 'react';
import { probeXTweetSource } from '../../../services/xTweetService';
import { useAppStore } from '../../../store/useAppStore';

/**
 * Orchestration hook for X tweet channel "Test Connection": fetches and parses a creator's profile page,
 * returning displayable results (tweet count / repo link count or error). Views do not directly access services.
 */
export const useXTweetProbe = () => {
  const [isProbing, setIsProbing] = useState(false);
  const t = useT('discovery');
  const [probeResult, setProbeResult] = useState<string | null>(null);

  const probe = useCallback(async (handle: string) => {
    setIsProbing(true);
    setProbeResult(null);
    const auth = useAppStore.getState().xTweetAuth;
    try {
      const result = await probeXTweetSource(handle, undefined, auth);
      setProbeResult(result.ok
        ? `OK|${result.tweetCount ?? 0}|${result.repoCount ?? 0}`
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
          const [, tweetCount, repoCount] = probeResult.split('|');
          return t('useXTweetProbe.connected-parsed-tweetcount-tweets-with-repocoun', { tweetCount: tweetCount, repoCount: repoCount });
        })()
      : (() => {
          const [, error] = probeResult.split('|');
          return t('useXTweetProbe.failed-error', { error: error });
        })();
  const probeOk = probeResult?.startsWith('OK|') ?? null;

  return { probe, isProbing, message, probeOk };
};
