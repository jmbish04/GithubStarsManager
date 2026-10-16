/**
 * License filtering and normalization utilities.
 *
 * Repository metadata stores licenses as SPDX ID strings (e.g. "MIT", "Apache-2.0") or null.
 * GitHub returns `{ key: 'Other', spdx_id: 'NOASSERTION' }` for undeclared or unrecognized repository licenses,
 * which we store as spdx_id `'NOASSERTION'`. To provide a "None / Undeclared" aggregate item in the filter panel,
 * all such representations are unified into {@link NO_LICENSE_SENTINEL}.
 *
 * Reused across front-end UI, filter evaluations, MCP, and elsewhere. Since server-side MCP cannot import the `src/` tree,
 * a duplicate implementation is kept in `server/src/mcp/repoSearch.ts`; update both when making changes here.
 */

/** "No license" aggregation sentinel: used by filters to group null / NOASSERTION / Other into a single item. */
export const NO_LICENSE_SENTINEL = '__NO_LICENSE__';

/**
 * Set of values treated as "No / Undeclared license" (case-insensitive comparison covering common GitHub/SPDX notations).
 * - `''` empty string
 * - `'noassertion'` GitHub spdx_id for "no assertion" (NOASSERTION)
 * - `'other'` GitHub license.key (Other, when no SPDX is present)
 * - `'none'` SPDX "no license" (NONE)
 * - `'no-license'` fallback string
 */
const NOASSERTION_KEYS = new Set(['', 'noassertion', 'other', 'none', 'no-license']);

/**
 * Normalizes a repository license value to an SPDX ID or the no-license sentinel.
 * Case-insensitive comparison handles lowercase variants written by legacy backups or third-party sources (e.g. 'other', 'none').
 *
 * Defensive: `v` may not be a string — legacy persisted data, third-party backup imports, or raw GitHub objects
 * `{ key, spdx_id, name, url }` not yet processed by {@link toLicenseSpdxId} can carry non-string licenses.
 * Objects are resolved to `spdx_id ?? key` before string matching; all other non-strings collapse to "no license",
 * preventing `.toLowerCase()` calls on objects or numbers from crashing client-side rendering.
 * @param v Raw license value (SPDX ID / GitHub object / number / null / undefined / empty string)
 * @returns Normalized string; returns {@link NO_LICENSE_SENTINEL} when there is no license
 */
export function normalizeLicense(v: unknown): string {
  if (v == null || v === '') return NO_LICENSE_SENTINEL;
  if (typeof v === 'object') {
    // GitHub license object: prefer spdx_id (e.g. 'MIT'), fall back to key (e.g. 'Other').
    // Note: trimmed-first + `||`: if spdx_id is a whitespace string (≠ null), `??` would retain the empty string
    // and erroneously classify as "no license"; it should fall back to a non-empty key.
    const l = v as { spdx_id?: unknown; key?: unknown };
    const spdx = typeof l.spdx_id === 'string' ? l.spdx_id.trim() : '';
    const key = typeof l.key === 'string' ? l.key.trim() : '';
    const resolved = spdx || key;
    if (!resolved) return NO_LICENSE_SENTINEL;
    return NOASSERTION_KEYS.has(resolved.toLowerCase()) ? NO_LICENSE_SENTINEL : resolved;
  }
  if (typeof v !== 'string') return NO_LICENSE_SENTINEL; // Numbers etc. are invalid licenses
  // Scalar string paths must also be trimmed: prevents whitespace variants like " Other " / " NOASSERTION " from evading sentinel aggregation
  const normalized = v.trim();
  return !normalized || NOASSERTION_KEYS.has(normalized.toLowerCase())
    ? NO_LICENSE_SENTINEL
    : normalized;
}
