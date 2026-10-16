import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../../store/useAppStore';
import { resolvePluginAccountTag } from '../../../plugins/pluginAccountTag';

/**
 * Account tag for the current GitHub identity (null indicates resolution is in progress).
 *
 * Modals defer rendering the plugin page until the tag is ready: the initial frame's `plugin-page:init`
 * receives the account tag, completing account validation before drawing any local cache (caches are isolated per account).
 */
export function usePluginAccountTag(): string | null {
  const githubToken = useAppStore(useShallow((state) => state.githubToken));
  const [tag, setTag] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    setTag(null);
    void resolvePluginAccountTag(githubToken ?? null).then((value) => {
      if (!disposed) setTag(value);
    });
    return () => { disposed = true; };
  }, [githubToken]);

  return tag;
}
