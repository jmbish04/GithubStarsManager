/**
 * V1.5 plugin page network account tag: used by the host to namespace local caches
 * for plugin pages by identity.
 *
 * Takes the first 16 hex characters of the token's SHA-256 (or 'anon' for anonymous requests).
 * The page only receives this tag and cannot access the token itself; the tag is not a credential
 * either—it only ensures that when switching GitHub accounts on the same machine, caches from the
 * previous account are not read by the new one.
 */
const accountTagCache = new Map<string, string>();

/** Resolves the stable account tag corresponding to a token (memoized by token to avoid recomputation). */
export async function resolvePluginAccountTag(token: string | null): Promise<string> {
  const key = token ?? '';
  const cached = accountTagCache.get(key);
  if (cached) return cached;
  let tag = 'anon';
  if (token) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
      tag = Array.from(new Uint8Array(digest)).slice(0, 8)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    } catch {
      // Fall back to a length digest when subtle crypto is unavailable (very old environments)—still better than account-agnostic caching.
      tag = `len:${token.length}`;
    }
  }
  accountTagCache.set(key, tag);
  return tag;
}
