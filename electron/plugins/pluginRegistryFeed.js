'use strict';

const { validateList, validateRegistryEntry, validateRemovedEntry } = require('./pluginRegistrySchema');

/**
 * Community plugin registry fetching (Development Guidelines §17 / §18).
 *
 * Performs three tasks: fetches two fixed-path JSON files, validates entries, and formats results
 * into "version list grouped by id + revocation list".
 * This module **does not download any plugin packages**: installation is a subsequent step, and
 * the client must verify sha256 checksums first.
 */

/** Default registry location: registry/ directory in the main repo (see docs/proposals/community-plugin-registry.md). */
const DEFAULT_REGISTRY_BASE_URL = 'https://raw.githubusercontent.com/AmintaCCCP/GithubStarsManager/main/registry';

const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
const REGISTRY_REQUEST_TIMEOUT_MS = 15_000;

const parseJson = (text, label) => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: { code: 'REGISTRY_JSON_INVALID', message: `${label} is not valid JSON` } };
  }
};

const tooLarge = () => ({
  ok: false,
  error: { code: 'REGISTRY_TOO_LARGE', message: 'Registry is larger than the accepted size' },
});

const readResponseText = async (response, controller) => {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_REGISTRY_BYTES) {
    controller.abort();
    return tooLarge();
  }

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_REGISTRY_BYTES) {
          controller.abort();
          await reader.cancel().catch(() => undefined);
          return tooLarge();
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    return { ok: true, text: Buffer.concat(chunks, totalBytes).toString('utf8') };
  }

  const text = await response.text();
  if (typeof text !== 'string') {
    return { ok: false, error: { code: 'REGISTRY_READ_FAILED', message: 'Registry body was empty' } };
  }
  return Buffer.byteLength(text, 'utf8') > MAX_REGISTRY_BYTES
    ? tooLarge()
    : { ok: true, text };
};

const fetchJson = async (fetchImpl, url, requestTimeoutMs) => {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, requestTimeoutMs);
  try {
    const response = await fetchImpl(url, {
      redirect: 'follow',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response || !response.ok) {
      return { ok: false, error: { code: 'REGISTRY_HTTP_ERROR', message: `Registry returned HTTP ${response ? response.status : 'unknown'}` } };
    }
    let body;
    try {
      body = await readResponseText(response, controller);
    } catch (error) {
      if (timedOut) {
        return { ok: false, error: { code: 'REGISTRY_TIMEOUT', message: 'Registry request timed out' } };
      }
      return { ok: false, error: { code: 'REGISTRY_READ_FAILED', message: error instanceof Error ? error.message : 'Registry body could not be read' } };
    }
    if (!body.ok) return body;
    const parsed = parseJson(body.text, 'Registry');
    if (!parsed.ok) return parsed;
    return { ok: true, value: parsed.value };
  } catch (error) {
    if (timedOut) {
      return { ok: false, error: { code: 'REGISTRY_TIMEOUT', message: 'Registry request timed out' } };
    }
    return { ok: false, error: { code: 'REGISTRY_UNREACHABLE', message: error instanceof Error ? error.message : 'Registry request failed' } };
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * Reads and validates the registry.
 *
 * Returns failure when neither file can be read; returns partial results if at least one file is read
 * (attaching the failure reason of the other file), because a missing revocation list should not disable
 * the entire feature, and vice versa.
 */
async function loadPluginRegistry({
  fetchImpl,
  baseUrl = DEFAULT_REGISTRY_BASE_URL,
  requestTimeoutMs = REGISTRY_REQUEST_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return { success: false, error: { code: 'REGISTRY_FETCH_UNAVAILABLE', message: 'No fetch implementation was provided' } };
  }

  const [pluginsResult, removedResult] = await Promise.all([
    fetchJson(fetchImpl, `${baseUrl}/community-plugins.json`, requestTimeoutMs),
    fetchJson(fetchImpl, `${baseUrl}/removed-plugins.json`, requestTimeoutMs),
  ]);

  if (!pluginsResult.ok && !removedResult.ok) {
    return { success: false, error: pluginsResult.error };
  }

  const plugins = pluginsResult.ok
    ? validateList(pluginsResult.value, validateRegistryEntry)
    : { accepted: [], rejected: [{ code: pluginsResult.error.code, message: pluginsResult.error.message }] };
  const removed = removedResult.ok
    ? validateList(removedResult.value, validateRemovedEntry)
    : { accepted: [], rejected: [{ code: removedResult.error.code, message: removedResult.error.message }] };

  // Group by plugin id: multiple versions for the same id sorted in descending semver order; client picks highest supported version
  const byId = new Map();
  for (const entry of plugins.accepted) {
    const versions = byId.get(entry.id) ?? [];
    versions.push(entry);
    byId.set(entry.id, versions);
  }
  for (const versions of byId.values()) {
    versions.sort((left, right) => compareVersions(right.version, left.version));
  }

  return {
    success: true,
    registry: {
      fetchedAt: new Date().toISOString(),
      plugins: [...byId.entries()].map(([id, versions]) => ({ id, versions })),
      removed: removed.accepted,
      rejected: [...plugins.rejected, ...removed.rejected],
      error: !pluginsResult.ok
        ? pluginsResult.error
        : (!removedResult.ok ? removedResult.error : null),
    },
  };
}

const compareNumericIdentifiers = (left, right) => {
  const a = left.replace(/^0+(?=\d)/, '');
  const b = right.replace(/^0+(?=\d)/, '');
  if (a.length !== b.length) return a.length > b.length ? 1 : -1;
  return a === b ? 0 : (a > b ? 1 : -1);
};

/** Compares semver versions validated by the registry schema. */
function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value));
    return match ? { numbers: [match[1], match[2], match[3]], prerelease: match[4] ?? null } : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return NaN;
  for (let index = 0; index < 3; index += 1) {
    const comparison = compareNumericIdentifiers(a.numbers[index], b.numbers[index]);
    if (comparison !== 0) return comparison;
  }
  // Prereleases precede final releases in semver precedence
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  // Compare prerelease identifiers per semver spec: numeric identifiers compared numerically, otherwise lexicographically
  return comparePrerelease(a.prerelease, b.prerelease);
}

function comparePrerelease(left, right) {
  const leftParts = left.split('.');
  const rightParts = right.split('.');
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const a = leftParts[index];
    const b = rightParts[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const diff = compareNumericIdentifiers(a, b);
      if (diff !== 0) return diff;
      continue;
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    if (a !== b) return a > b ? 1 : -1;
  }
  return 0;
}

module.exports = {
  DEFAULT_REGISTRY_BASE_URL,
  MAX_REGISTRY_BYTES,
  REGISTRY_REQUEST_TIMEOUT_MS,
  compareVersions,
  loadPluginRegistry,
};
