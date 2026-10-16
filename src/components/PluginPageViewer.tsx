
import { TranslateFn } from '../i18n/useT';
import React, { useEffect, useRef, useState } from 'react';
import { pluginClient } from '../plugins/pluginClient';
import { validatePluginPageMessage } from '../plugins/pluginPageMessages';
import { usePluginAccountTag } from '../features/plugins/hooks/usePluginAccountTag';
import { usePluginAI } from '../features/plugins/hooks/usePluginAI';
import { usePluginNetwork } from '../features/plugins/hooks/usePluginNetwork';
import { usePluginWebSearch } from '../features/plugins/hooks/usePluginWebSearch';

interface PluginPageViewerProps {
  pluginId: string;
  pluginName: string;
  pageId: string;
  pageTitle: string;
  onClose: () => void;
  t: TranslateFn;
  /** modal: used inside modal dialog, hides internal titlebar (outer Modal provides title and close button). */
  variant?: 'panel' | 'modal';
  /** Context dispatched at once to page via plugin-page:init (e.g. repo metadata); does not go through capability bridge. */
  initContext?: Record<string, unknown>;
}

export const PluginPageViewer: React.FC<PluginPageViewerProps> = ({ pluginId, pluginName, pageId, pageTitle, onClose, t, variant = 'panel', initContext }) => {
  const isModal = variant === 'modal';
  // Account tag is dispatched to page with init: page uses it to complete account verification before rendering local cache.
  // Tag resolution is async (SHA-256); do not render iframe before ready to prevent first frame from bypassing verification.
  const accountTag = usePluginAccountTag();
  const generateAI = usePluginAI();
  const requestNetwork = usePluginNetwork();
  const searchWeb = usePluginWebSearch();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const tokenRef = useRef(crypto.randomUUID());
  const pendingRef = useRef(new Set<string>());
  const requestTimesRef = useRef<number[]>([]);
  const mountedRef = useRef(true);
  const aiRequestsRef = useRef(new Set<AbortController>());
  // In-flight network.request calls: aborted on page unmount/reload to prevent requests carrying Token
  // from running to completion when results have no consumer (ai.generate has matching mechanism).
  const networkSignalRef = useRef<AbortController>(new AbortController());
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    const aiRequests = aiRequestsRef.current;
    return () => {
      mountedRef.current = false;
      for (const controller of aiRequests) controller.abort();
      networkSignalRef.current.abort();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    void pluginClient.getPage(pluginId, pageId).then((result) => {
      if (disposed) return;
      if (result.success) setUrl(result.url);
      else setError(result.error.message);
    }).catch(() => {
      if (!disposed) setError(t('pluginPageViewer.failed-to-load-plugin-page'));
    });
    return () => { disposed = true; };
  }, [pluginId, pageId, t]);

  const initContextRef = useRef(initContext);
  initContextRef.current = initContext;
  const accountTagRef = useRef(accountTag);
  accountTagRef.current = accountTag;

  // init is only sent once upon iframe onLoad, whereas modal context (like README) arrives asynchronously.
  // When context changes after initialization, redispatch once with the same token so page refreshes with new context.
  const initContextSignature = JSON.stringify(initContext ?? null);
  useEffect(() => {
    const frameWindow = frameRef.current?.contentWindow;
    if (!frameWindow || !tokenRef.current || !initContextRef.current) return;
    frameWindow.postMessage({
      type: 'plugin-page:init', pluginId, pageId, token: tokenRef.current,
      context: { ...initContextRef.current, accountTag: accountTagRef.current },
    }, `plugin-page://${pluginId}`);
    // initContextSignature is only used to trigger redispatch; actual payload is read from ref to avoid object identity in deps.
  }, [initContextSignature, pluginId, pageId, accountTag]);

  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      const request = validatePluginPageMessage(event, frameRef.current?.contentWindow ?? null, pluginId, pageId, tokenRef.current);
      if (!request) return;
      const pendingKey = `${tokenRef.current}:${request.requestId}`;
      const rejectRequest = (code: string, message: string) => {
        frameRef.current?.contentWindow?.postMessage({
          type: 'plugin-page:response', pluginId, pageId,
          requestId: request.requestId, token: tokenRef.current,
          success: false, error: { code, message },
        }, `plugin-page://${pluginId}`);
      };
      if (pendingRef.current.has(pendingKey) || pendingRef.current.size >= 8) {
        rejectRequest('PLUGIN_PAGE_RATE_LIMITED', 'Plugin page request limit exceeded');
        return;
      }
      const now = Date.now();
      requestTimesRef.current = requestTimesRef.current.filter((time) => now - time < 60_000);
      if (requestTimesRef.current.length >= 120) {
        rejectRequest('PLUGIN_PAGE_RATE_LIMITED', 'Plugin page request rate limit exceeded');
        return;
      }
      requestTimesRef.current.push(now);
      let requestSize;
      try { requestSize = JSON.stringify(request.args).length; } catch {
        rejectRequest('PLUGIN_PAGE_REQUEST_TOO_LARGE', 'Plugin page request arguments are not serializable');
        return;
      }
      // Matches main-process pluginPageBridge budget: binary screenshot export payload relaxed to
      // 10 MiB; other methods stay 1 MiB. Intercept here to prevent large payloads entering IPC.
      const sizeLimit = request.method === 'clipboard.writeImage' || request.method === 'downloads.saveFile'
        ? 10 * 1024 * 1024
        : 1024 * 1024;
      if (requestSize > sizeLimit) {
        rejectRequest('PLUGIN_PAGE_REQUEST_TOO_LARGE', 'Plugin page request exceeds the size limit');
        return;
      }
      pendingRef.current.add(pendingKey);
      const requestToken = tokenRef.current;
      const aiController = request.method === 'ai.generate' ? new AbortController() : null;
      if (aiController) aiRequestsRef.current.add(aiController);
      try {
        let result;
        try {
          result = request.method === 'ai.generate'
            ? await generateAI(pluginId, pluginName, pageId, request.args,
              () => mountedRef.current && tokenRef.current === requestToken, aiController!.signal)
            : request.method === 'web.search'
              ? await searchWeb(pluginId, pluginName, pageId, request.args,
                () => mountedRef.current && tokenRef.current === requestToken)
            : request.method === 'network.request'
              ? await requestNetwork(pluginId, pageId, request.args,
                () => mountedRef.current && tokenRef.current === requestToken,
                networkSignalRef.current.signal)
              : await pluginClient.requestPageCapability({ pluginId, pageId, method: request.method, args: request.args });
        } catch {
          result = { success: false as const, error: { code: 'PLUGIN_PAGE_REQUEST_FAILED', message: 'Host request failed' } };
        }
        if (tokenRef.current !== requestToken) return;
        frameRef.current?.contentWindow?.postMessage({
          type: 'plugin-page:response', pluginId, pageId,
          requestId: request.requestId, token: requestToken, ...result,
        }, `plugin-page://${pluginId}`);
      } finally {
        pendingRef.current.delete(pendingKey);
        if (aiController) aiRequestsRef.current.delete(aiController);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [pluginId, pageId, pluginName, generateAI, requestNetwork, searchWeb, t]);

  return (
    <section
      className={isModal ? 'flex h-full min-h-0 flex-1 flex-col gap-3' : 'space-y-3'}
      aria-label={`${pluginName}: ${pageTitle}`}
    >
      {!isModal && (
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">{pluginName} · {pageTitle}</h3>
            <p className="text-xs text-muted-foreground">{t('pluginPageViewer.this-page-comes-from-a-local-plugin-data-request')}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded border border-border px-3 py-1.5 text-sm">
            {t('pluginPageViewer.back-to-plugins')}
          </button>
        </div>
      )}
      {isModal && (
        <p className="shrink-0 text-xs text-muted-foreground">{t('pluginPageViewer.this-page-comes-from-a-local-plugin-data-request')}</p>
      )}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> :
        url && accountTag ? <iframe
          ref={frameRef}
          title={`${pluginName}: ${pageTitle}`}
          src={url}
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="no-referrer"
          className={isModal
            ? 'min-h-0 w-full flex-1 rounded-lg border border-border bg-white'
            : 'h-[min(70vh,800px)] min-h-[480px] w-full rounded-lg border border-border bg-white'}
          onLoad={() => {
            for (const controller of aiRequestsRef.current) controller.abort();
            // Abort in-flight requests of previous epoch before rotating, preventing them from running to completion with Token.
            networkSignalRef.current.abort();
            networkSignalRef.current = new AbortController();
            tokenRef.current = crypto.randomUUID();
            pendingRef.current.clear();
            frameRef.current?.contentWindow?.postMessage({
              type: 'plugin-page:init', pluginId, pageId, token: tokenRef.current,
              ...(initContextRef.current ? { context: { ...initContextRef.current, accountTag: accountTagRef.current } } : {}),
            }, `plugin-page://${pluginId}`);
          }}
        /> : <p role="status">{t('pluginPageViewer.loading-plugin-page')}</p>}
    </section>
  );
};
