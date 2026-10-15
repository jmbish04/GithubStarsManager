import axios, { AxiosRequestConfig } from 'axios';
import { logger } from './logger.js';
import { redactUrl } from './logSanitizer.js';

export interface ProxyConfig {
  enabled: boolean;
  type: 'http' | 'socks5';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface ProxyRequestOptions {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string | object;
  timeout?: number;
  proxyConfig?: ProxyConfig | null;
  preserveRawResponse?: boolean;
  /** Allow loopback and private IP ranges (only for URLs originating from user-configured settings). */
  allowPrivate?: boolean;
}

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  data: unknown;
}

const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '169.254.169.254']);
const PRIVATE_IP_PATTERNS = [/^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./];

export interface ValidateUrlOptions {
  /** Relaxed mode: allow loopback addresses and private IP ranges. Only used for URLs originating from
   *  explicit user-saved configurations (e.g. AI / WebDAV / download targets); must not be applied to arbitrary or semi-trusted input. */
  allowPrivate?: boolean;
}

/** Normalize hostname: strip IPv6 brackets and trailing dots (preventing `localhost.`/`127.0.0.1.` bypasses),
 *  and unwrap IPv4-mapped IPv6 (such as [::ffff:169.254.169.254]) back to the corresponding IPv4 string,
 *  ensuring SSRF filtering inspects the true destination address. */
function normalizeHostname(hostname: string): string {
  // Strip trailing dot first to prevent SSRF bypasses (e.g. "localhost." or "127.0.0.1.")
  const h = hostname.replace(/\.$/, '').replace(/^\[(.+)\]$/, '$1').toLowerCase();
  // Handle hybrid IPv4-mapped IPv6 written with dotted decimals (::ffff:169.254.169.254)
  if (h.startsWith('::ffff:') && h.includes('.')) {
    return h.slice(7);
  }
  // Handle IPv4-mapped IPv6 written in hex form (::ffff:a9fe:a9fe)
  const mapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const octets = [mapped[1], mapped[2]].flatMap((hex) => {
      const v = parseInt(hex, 16);
      return [(v >>> 8) & 0xff, v & 0xff];
    });
    return octets.join('.');
  }
  return h;
}

/** IPv6 private/local prefix checks: unique local fc00::/7, link-local fe80::/10, multicast ff00::/8 */
function isPrivateOrLocalIpv6(h: string): boolean {
  if (!h.includes(':')) return false;
  return (
    h.startsWith('fc') || h.startsWith('fd') ||
    h.startsWith('fe8') || h.startsWith('fe9') ||
    h.startsWith('fea') || h.startsWith('feb') ||
    h.startsWith('ff')
  );
}

function isLocalOrLanHostname(h: string): boolean {
  return (
    h.endsWith('.local') ||
    h.endsWith('.lan') ||
    h.endsWith('.home') ||
    h.endsWith('.internal') ||
    h.endsWith('.corp') ||
    h.endsWith('.home.arpa')
  );
}

/** Determine whether a hostname is a loopback address or private subnet (including IPv6 private/local subnets). */
export function isPrivateOrLoopback(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  if (BLOCKED_HOSTS.has(h)) return true;
  if (isLocalOrLanHostname(h)) return true;
  if (PRIVATE_IP_PATTERNS.some(p => p.test(h))) return true;
  if (isPrivateOrLocalIpv6(h)) return true;
  return false;
}

export function validateUrl(rawUrl: string, opts: ValidateUrlOptions = {}): void {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked proxy request: unsupported protocol '${parsed.protocol}'`);
  }

  // Always block URLs with embedded username/password (prevents leaking credentials into logs)
  if (parsed.username || parsed.password) {
    throw new Error(`Blocked proxy request: URL containing credentials is not allowed`);
  }

  // Normalizing covers both plaintext 169.254.169.254 and IPv4-mapped formats like [::ffff:a9fe:a9fe].
  const hostname = normalizeHostname(parsed.hostname);

  if (opts.allowPrivate) {
    // Relaxed mode: still strictly protect cloud metadata IMDS addresses — the highest-risk SSRF target (cloud provider credentials).
    if (hostname === '169.254.169.254') {
      throw new Error(`Blocked proxy request: IMDS address '169.254.169.254' is not allowed`);
    }
    return;
  }

  // Strict mode (default): block loopback addresses and private subnets (including IPv6 private/local subnets and LAN hostnames).
  if (BLOCKED_HOSTS.has(hostname)) {
    throw new Error(`Blocked proxy request: hostname '${hostname}' is not allowed`);
  }
  if (isLocalOrLanHostname(hostname)) {
    throw new Error(`Blocked proxy request: LAN hostname '${hostname}' is not allowed`);
  }
  if (PRIVATE_IP_PATTERNS.some(p => p.test(hostname))) {
    throw new Error(`Blocked proxy request: private IP '${hostname}' is not allowed`);
  }
  if (isPrivateOrLocalIpv6(hostname)) {
    throw new Error(`Blocked proxy request: private IPv6 address '${hostname}' is not allowed`);
  }
}

export async function proxyRequest(options: ProxyRequestOptions): Promise<ProxyResponse> {
  const { url, method, headers = {}, body, timeout = 30000, proxyConfig, preserveRawResponse = false } = options;

  try {
    validateUrl(url, { allowPrivate: options.allowPrivate });
    logger.info('proxy.request', `${method} ${redactUrl(url)}`);

    const axiosConfig: AxiosRequestConfig = {
      url,
      method: method.toLowerCase() as AxiosRequestConfig['method'],
      headers,
      timeout,
      validateStatus: () => true, // Do not throw on HTTP error status codes
    };
    if (preserveRawResponse) {
      axiosConfig.responseType = 'text';
      axiosConfig.transformResponse = [(data) => data];
    }

    if (body && method !== 'GET' && method !== 'HEAD') {
      axiosConfig.data = body;
      const hasContentType = Object.keys(headers).some(
        k => k.toLowerCase() === 'content-type'
      );
      if (!hasContentType && typeof body === 'object') {
        axiosConfig.headers = { ...axiosConfig.headers, 'Content-Type': 'application/json' };
      }
    }

    // Configure proxy
    if (proxyConfig?.enabled && proxyConfig.host && proxyConfig.port) {
      if (proxyConfig.type === 'socks5') {
        // SOCKS5: axios does not natively support socks5, use socks-proxy-agent
        const { SocksProxyAgent } = await import('socks-proxy-agent');
        const socksUrl = `socks5://${proxyConfig.host}:${proxyConfig.port}`;
        const agent = new SocksProxyAgent(socksUrl);
        axiosConfig.httpAgent = agent;
        axiosConfig.httpsAgent = agent;
        axiosConfig.proxy = false; // Disable axios built-in proxy and use custom agent
      } else {
        // HTTP/HTTPS proxy
        axiosConfig.proxy = {
          protocol: 'http',
          host: proxyConfig.host,
          port: proxyConfig.port,
        };
        if (proxyConfig.username && proxyConfig.password) {
          axiosConfig.proxy.auth = {
            username: proxyConfig.username,
            password: proxyConfig.password,
          };
        }
      }
    } else {
      // Explicitly disable proxy to prevent axios from falling back to HTTP_PROXY/HTTPS_PROXY environment variables
      axiosConfig.proxy = false;
    }

    const response = await axios(axiosConfig);

    logger.info('proxy.response', `${method} ${redactUrl(url)} -> ${response.status}`);

    const responseHeaders: Record<string, string> = {};
    if (response.headers) {
      for (const [key, value] of Object.entries(response.headers)) {
        responseHeaders[key] = String(value);
      }
    }

    let data: unknown;
    if (preserveRawResponse) {
      data = typeof response.data === 'string' ? response.data : String(response.data ?? '');
    } else {
      const contentType = String(response.headers['content-type'] || '');
      if (contentType.includes('application/json') && typeof response.data === 'object') {
        data = response.data;
      } else if (typeof response.data === 'string') {
        try {
          data = JSON.parse(response.data);
        } catch {
          data = response.data;
        }
      } else {
        data = response.data;
      }
    }

    return { status: response.status, headers: responseHeaders, data };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
        return { status: 504, headers: {}, data: { error: 'Gateway Timeout', code: 'GATEWAY_TIMEOUT' } };
      }
      if (error.code === 'ECONNREFUSED') {
        return { status: 502, headers: {}, data: { error: 'Proxy connection refused', code: 'PROXY_CONNECTION_REFUSED', details: error.message } };
      }
      if (error.code === 'ETIMEDOUT') {
        return { status: 504, headers: {}, data: { error: 'Proxy connection timeout', code: 'PROXY_TIMEOUT', details: error.message } };
      }
      if (error.response) {
        // Request was sent, but the server responded with an error status code
        return {
          status: error.response.status,
          headers: {},
          data: error.response.data || { error: 'Upstream error' }
        };
      }
    }
    logger.errorFromError('proxy.error', 'Proxy request failed', error);
    return { status: 502, headers: {}, data: { error: 'Bad Gateway', code: 'BAD_GATEWAY', details: error instanceof Error ? error.message : 'Unknown error' } };
  }
}
