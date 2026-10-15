import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../../store/useAppStore';
import { pluginClient } from '../../../plugins/pluginClient';
import { resolvePluginAccountTag } from '../../../plugins/pluginAccountTag';
import { buildNetworkRequestUrl, isAllowedNetworkTarget } from '../../../plugins/networkTargets';

export interface PluginNetworkValue {
  status: number;
  body: unknown;
  /**
   * Stable identifier for the current GitHub identity (first 16 hex characters of the token SHA-256;
   * 'anon' for anonymous requests). The page only receives this tag, never the token itself, allowing it
   * to namespace local caches by account so switching accounts on the same machine never leaks cached data.
   */
  acct: string;
}

export type PluginNetworkResult =
  | { success: true; value: PluginNetworkValue }
  | { success: false; error: { code: string; message: string } };

const REQUEST_TIMEOUT_MS = 15_000;
// Maximum response size for insight datasets: 52-week stats, top 100 contributors, curated release lists
// are all well below this limit; counts bytes during receipt and aborts immediately when exceeded.
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
// Error responses only need an extracted message, so use a much lower ceiling.
const MAX_ERROR_BODY_BYTES = 64 * 1024;

function argsToRequest(args: unknown): { host: string; path: string; query?: Record<string, unknown> } | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  if (typeof record.host !== 'string' || typeof record.path !== 'string') return null;
  if (record.query !== undefined && (!record.query || typeof record.query !== 'object' || Array.isArray(record.query))) return null;
  return { host: record.host, path: record.path, query: record.query as Record<string, unknown> | undefined };
}

/**
 * Reads response body text while counting bytes (chunk.byteLength): aborts the stream
 * and throws RangeError('TOO_LARGE') when the cap is exceeded. Shared across success and error paths.
 */
async function readBodyWithCap(response: Response, maxBytes: number, externalSignal: AbortSignal | null): Promise<string> {
  if (!response.body) return '';
  const declaredLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RangeError('TOO_LARGE');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  for (;;) {
    if (externalSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      void reader.cancel().catch(() => {});
      throw new RangeError('TOO_LARGE');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Renderer-side executor for V1.5 page network capability (network.request), isomorphic with
 * usePluginAI / usePluginWebSearch: first authorized by the main process (verifying method allowlist and
 * `network:<host>` permission), then dispatched from the renderer using the user's GitHub token as a
 * read-only GET. Tokens are omitted from IPC parameters and logs; GET only, allowlisted endpoints only.
 *
 * Authorization is re-checked before returning data: if the plugin was disabled/uninstalled in-flight,
 * the pending response is not delivered to the page.
 * `externalSignal`: host aborts in-flight requests on page close/reload to avoid running authenticated
 * requests to completion with no consumer.
 */
export function usePluginNetwork() {
  const githubToken = useAppStore(useShallow((state) => state.githubToken));

  return useCallback(async function request(
    pluginId: string,
    pageId: string,
    args: Record<string, unknown>,
    isCurrentPage: () => boolean,
    externalSignal?: AbortSignal,
  ): Promise<PluginNetworkResult> {
    const parsed = argsToRequest(args);
    if (!parsed || !isAllowedNetworkTarget(parsed)) {
      return { success: false, error: { code: 'PLUGIN_PAGE_REQUEST_INVALID', message: 'Network request arguments are invalid' } };
    }
    const authorize = () => pluginClient.requestPageCapability({
      pluginId, pageId, method: 'network.request', args: { host: parsed.host, path: parsed.path, query: parsed.query ?? {} },
    });
    const authorization = await authorize();
    if (!authorization.success) return authorization;
    if (!isCurrentPage() || externalSignal?.aborted) {
      return { success: false, error: { code: 'PLUGIN_PAGE_CLOSED', message: 'Plugin page closed' } };
    }

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onExternalAbort);
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(buildNetworkRequestUrl(parsed), {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
        },
        signal: controller.signal,
        referrerPolicy: 'no-referrer',
        // Allowlist only validates initial path; redirects bypass it (e.g. /repos/twitter/bootstrap
        // redirecting outside the allowlist to /repositories/{id}), so all redirects are rejected.
        redirect: 'error',
      });
      if (response.status === 202 || response.status === 204) {
        // Same contract as success branch: re-check authorization before returning; discarded if disabled.
        const reauth202 = await authorize();
        if (!reauth202.success) return reauth202;
        if (!isCurrentPage() || externalSignal?.aborted) {
          return { success: false, error: { code: 'PLUGIN_PAGE_CLOSED', message: 'Plugin page closed' } };
        }
        return { success: true, value: { status: response.status, body: null, acct: await resolvePluginAccountTag(githubToken) } };
      }
      if (!response.ok) {
        let detail = '';
        try {
          detail = await readBodyWithCap(response, MAX_ERROR_BODY_BYTES, externalSignal ?? null);
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
        }
        let hint = '';
        try { hint = String(JSON.parse(detail)?.message ?? ''); } catch { /* keep empty */ }
        return {
          success: false,
          error: {
            code: 'PLUGIN_NETWORK_HTTP_ERROR',
            message: `GitHub API returned ${response.status}${hint ? `: ${hint}` : ''}`,
          },
        };
      }
      const text = await readBodyWithCap(response, MAX_RESPONSE_BYTES, externalSignal ?? null);
      // Re-check authorization before returning: if plugin was disabled/uninstalled, data stops at renderer and page gets an error.
      const reauthorization = await authorize();
      if (!reauthorization.success) return reauthorization;
      if (!isCurrentPage() || externalSignal?.aborted) {
        return { success: false, error: { code: 'PLUGIN_PAGE_CLOSED', message: 'Plugin page closed' } };
      }
      try {
        return {
          success: true,
          value: { status: response.status, body: text ? JSON.parse(text) : null, acct: await resolvePluginAccountTag(githubToken) },
        };
      } catch {
        return { success: false, error: { code: 'PLUGIN_NETWORK_RESPONSE_INVALID', message: 'Network response is not valid JSON' } };
      }
    } catch (error) {
      if (!isCurrentPage() || externalSignal?.aborted) {
        return { success: false, error: { code: 'PLUGIN_PAGE_CLOSED', message: 'Plugin page closed' } };
      }
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      return {
        success: false,
        error: {
          code: aborted ? 'PLUGIN_NETWORK_TIMEOUT' : 'PLUGIN_NETWORK_FAILED',
          message: aborted
            ? 'Network request timed out'
            : 'Network request failed (redirects are not followed)',
        },
      };
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }, [githubToken]);
}
