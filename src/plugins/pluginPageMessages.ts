export interface PluginPageRequest {
  type: 'plugin-page:request';
  pluginId: string;
  pageId: string;
  requestId: string;
  token: string;
  method: string;
  args: Record<string, unknown>;
  /** The page's own origin. Because the host window origin is not fixed, the page must post to '*' and verifies against this. */
  origin: string;
}

export function validatePluginPageMessage(
  event: MessageEvent,
  frameWindow: Window | null,
  pluginId: string,
  pageId: string,
  token: string,
): PluginPageRequest | null {
  // Accept only the page's own plugin-page origin. allow-scripts does not prevent the page from navigating the iframe away;
  // after navigation, WindowProxy remains identical and the origin is still an opaque null. Validating against null would leak
  // tokens and repository context to the navigated document. Strict origin checking requires allow-same-origin on the iframe.
  if (!frameWindow || event.source !== frameWindow ||
    event.origin !== `plugin-page://${pluginId}`) return null;
  const data: unknown = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const message = data as Record<string, unknown>;
  if (Object.keys(message).some((key) => !['type', 'pluginId', 'pageId', 'requestId', 'token', 'method', 'args', 'origin'].includes(key))) return null;
  if (message.type !== 'plugin-page:request' || message.pluginId !== pluginId ||
    message.pageId !== pageId || message.token !== token ||
    message.origin !== `plugin-page://${pluginId}` ||
    typeof message.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(message.requestId) ||
    typeof message.method !== 'string' || message.method.length > 80 ||
    !message.args || typeof message.args !== 'object' || Array.isArray(message.args)) return null;
  return message as unknown as PluginPageRequest;
}
