'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { MAX_MANIFEST_BYTES, validateManifest } = require('./manifestSchema');
const { createMarketplaceStateStore, normalizeState } = require('./pluginMarketplaceState');
const { loadPluginRegistry } = require('./pluginRegistryFeed');
const { sanitizeText } = require('./pluginLogger');

/**
 * Plugin marketplace (self-hosted plugin sources).
 *
 * Users add GitHub repository directories as plugin sources. The client lists directories via
 * GitHub contents API and probes each subdirectory for manifest.json (raw.githubusercontent, read-only)
 * to build the catalog. During installation, it fetches the full file list via git trees API, downloads
 * files into staging, and invokes pluginManager.installFromDirectory for validation, copying, and atomic placement.
 * Update = uninstall old version (retaining data) and install the newly downloaded version.
 *
 * This module does not endorse third-party plugins: source plugins follow the exact same manifest validation,
 * permission confirmation, and enablement flows as locally installed plugins. Official static registry
 * revocations and blocks are layered on separately by the renderer.
 */

/** Seed source for initialization: sample plugins directory included in this repository. */
const DEFAULT_PLUGIN_SOURCE_URL = 'https://github.com/AmintaCCCP/GithubStarsManager/tree/main/examples/plugins';

const MAX_LISTING_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
/** Maximum subdirectory probes per source; truncated with warning to prevent runaway listings. */
const MAX_SOURCE_DIRECTORIES = 200;
/** Kept in sync with pluginManager installation limits. */
const MAX_PLUGIN_PACKAGE_FILES = 2000;
const MAX_PLUGIN_PACKAGE_BYTES = 50 * 1024 * 1024;
const PROBE_CONCURRENCY = 4;
const DOWNLOAD_CONCURRENCY = 4;

const GITHUB_HOST = 'github.com';
const RAW_HOST = 'raw.githubusercontent.com';
const API_HOST = 'api.github.com';

// Windows reserved device names and filenames ending in dot/space cause issues on Windows volumes; git allows them, so reject before download.
const WINDOWS_RESERVED_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function decodeSegment(segment) {
  try {
    return { ok: true, value: decodeURIComponent(segment) };
  } catch {
    return { ok: false };
  }
}

function segmentIsSafe(segment) {
  if (segment.length === 0) return false;
  if (segment === '.' || segment === '..') return false;
  // Reject path separators and control characters; remaining characters are validated by GitHub.
  for (const character of segment) {
    const code = character.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return false;
    if (character === '/' || character === '\\') return false;
  }
  return true;
}

/**
 * Parses plugin source URL: https://github.com/{owner}/{repo}[/tree/{ref}[/path]].
 *
 * GitHub tags may contain slashes, making them indistinguishable from directory paths in URLs.
 * We follow GitHub web conventions: the first segment after /tree/ is the ref, and remaining segments
 * form the directory path. Tags containing slashes are not supported.
 */
function parseSourceUrl(input) {
  if (typeof input !== 'string' || input.length === 0 || input.length > 2048) return null;
  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== GITHUB_HOST) return null;
  if (url.search || url.hash) return null;

  const rawSegments = url.pathname.split('/').filter((segment) => segment.length > 0);
  if (rawSegments.length < 2) return null;

  const decoded = [];
  for (const segment of rawSegments) {
    const result = decodeSegment(segment);
    if (!result.ok || !segmentIsSafe(result.value)) return null;
    decoded.push(result.value);
  }

  const owner = decoded[0];
  let repo = decoded[1];
  if (repo.toLowerCase().endsWith('.git')) repo = repo.slice(0, -4);
  if (repo.length === 0) return null;

  let ref = null;
  let pathSegments;
  if (decoded.length > 2 && decoded[2] === 'tree') {
    if (decoded.length === 3) return null;
    ref = decoded[3];
    if (ref === '.' || ref === '..' || ref.includes('\\')) return null;
    pathSegments = decoded.slice(4);
  } else {
    pathSegments = decoded.slice(2);
  }
  for (const segment of pathSegments) {
    if (!segmentIsSafe(segment)) return null;
  }

  return {
    owner,
    repo,
    ref,
    dirPath: pathSegments.join('/'),
    defaultName: pathSegments.length > 0 ? `${owner}/${repo}/${pathSegments.join('/')}` : `${owner}/${repo}`,
  };
}

function mapLimit(items, limit, mapper) {
  if (items.length === 0) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const results = new Array(items.length);
    let nextIndex = 0;
    let settled = 0;
    let failed = false;
    const launch = () => {
      if (failed) return;
      if (nextIndex >= items.length) {
        if (settled === items.length) resolve(results);
        return;
      }
      const index = nextIndex++;
      Promise.resolve()
        .then(() => mapper(items[index], index))
        .then((value) => {
          if (failed) return;
          results[index] = value;
          settled += 1;
          if (settled === items.length) resolve(results);
          else launch();
        })
        .catch((error) => {
          if (failed) return;
          failed = true;
          reject(error);
        });
    };
    for (let index = 0; index < Math.min(limit, items.length); index += 1) launch();
  });
}

/** Reads response body with streaming byte cap, aborting immediately when limit is exceeded. */
async function readBodyCap(response, controller, maxBytes) {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    controller.abort();
    return { ok: false, error: { code: 'TOO_LARGE', message: 'Response exceeds the accepted size' } };
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
        if (totalBytes > maxBytes) {
          controller.abort();
          await reader.cancel().catch(() => undefined);
          return { ok: false, error: { code: 'TOO_LARGE', message: 'Response exceeds the accepted size' } };
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    return { ok: true, bytes: Buffer.concat(chunks, totalBytes) };
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.byteLength > maxBytes
    ? { ok: false, error: { code: 'TOO_LARGE', message: 'Response exceeds the accepted size' } }
    : { ok: true, bytes: buffer };
}

/**
 * Unified fetch channel: timeouts, HTTP status checks, rate limit detection, and byte limits.
 * Returns { ok: true, bytes } or { ok: false, error: { code, message, status? } },
 * where code is a neutral error (HTTP_ERROR/TIMEOUT/UNREACHABLE/TOO_LARGE/RATE_LIMITED/READ_FAILED) mapped by callers.
 */
async function fetchCapped(fetchImpl, url, { headers = {}, maxBytes, requestTimeoutMs }) {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, error: { code: 'UNREACHABLE', message: 'No fetch implementation was provided' } };
  }
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, requestTimeoutMs);
  try {
    const response = await fetchImpl(url, { redirect: 'follow', headers, signal: controller.signal });
    if (!response) {
      return { ok: false, error: { code: 'UNREACHABLE', message: 'Request returned no response' } };
    }
    if (!response.ok) {
      const rateLimited = response.status === 403
        || response.status === 429
        || response.headers?.get?.('x-ratelimit-remaining') === '0';
      return {
        ok: false,
        error: {
          code: rateLimited ? 'RATE_LIMITED' : 'HTTP_ERROR',
          message: `Request returned HTTP ${response.status}`,
          status: response.status,
        },
      };
    }
    const body = await readBodyCap(response, controller, maxBytes);
    if (!body.ok && timedOut) {
      return { ok: false, error: { code: 'TIMEOUT', message: 'Request timed out' } };
    }
    return body;
  } catch (error) {
    if (timedOut) {
      return { ok: false, error: { code: 'TIMEOUT', message: 'Request timed out' } };
    }
    return {
      ok: false,
      error: { code: 'UNREACHABLE', message: error instanceof Error ? error.message : 'Request failed' },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function prefixedError(prefix, error) {
  return { code: `${prefix}_${error.code}`, message: sanitizeText(error.message) };
}

function githubApiHeaders() {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/** Encodes a path (possibly multi-segment, e.g. "plugins/fixture/manifest.json") into a safe URL path, preserving slashes. */
function encodePath(...pathParts) {
  return pathParts
    .filter((part) => part !== '')
    .flatMap((part) => part.split('/'))
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function createPluginMarketplace({
  statePath,
  stagingRoot,
  fetchImpl,
  pluginManager,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  seedDefaultSource = true,
}) {
  if (typeof statePath !== 'string' || statePath.trim() === '') {
    throw new TypeError('statePath must be a non-empty string');
  }
  if (typeof stagingRoot !== 'string' || stagingRoot.trim() === '') {
    throw new TypeError('stagingRoot must be a non-empty string');
  }
  if (!pluginManager || typeof pluginManager.installFromDirectory !== 'function') {
    throw new TypeError('pluginManager with installFromDirectory is required');
  }

  const stateStore = createMarketplaceStateStore(statePath);
  const loaded = stateStore.load();
  // Distinguish uninitialized from user clearing all sources: seed default source only on first run.
  const firstRun = loaded === null;
  let sources = loaded !== null ? loaded.sources : [];
  if (firstRun && seedDefaultSource) {
    sources = [{
      id: `src-${randomUUID()}`,
      url: DEFAULT_PLUGIN_SOURCE_URL,
      addedAt: new Date().toISOString(),
    }];
    stateStore.save({ version: 1, sources });
  }

  /** sourceId → { status: 'ok'|'error', plugins, warnings, error, fetchedAt } */
  const catalog = new Map();
  const defaultBranches = new Map();
  const refreshInFlight = new Map();
  let installChain = Promise.resolve();

  function persist() {
    stateStore.save({ version: 1, sources });
  }

  function findSource(sourceId) {
    return sources.find((source) => source.id === sourceId) || null;
  }

  /**
   * Deduplication key for sources. When ref is omitted in URL, compares using cached default branch
   * so explicit "main" and implicit "main" are recognized as the same source.
   */
  function canonicalKey(parsed) {
    const ref = parsed.ref ?? defaultBranches.get(`${parsed.owner}/${parsed.repo}`) ?? '';
    return `${parsed.owner}/${parsed.repo}@${ref}:${parsed.dirPath}`.toLowerCase();
  }

  function getState() {
    return {
      sources: sources.map((source) => ({ ...source })),
      entries: sources.map((source) => {
        const cached = catalog.get(source.id);
        return {
          source: { ...source },
          status: cached ? cached.status : 'pending',
          plugins: cached ? cached.plugins.map((plugin) => ({ ...plugin })) : [],
          warnings: cached ? [...cached.warnings] : [],
          error: cached && cached.error ? { ...cached.error } : null,
          fetchedAt: cached ? cached.fetchedAt : null,
        };
      }),
    };
  }

  /** Fetches and caches the repository default branch when ref is omitted from the source URL. */
  async function resolveDefaultBranch(parsed) {
    if (parsed.ref) return { ok: true, ref: parsed.ref };
    const repoKey = `${parsed.owner}/${parsed.repo}`;
    const cached = defaultBranches.get(repoKey);
    if (cached) return { ok: true, ref: cached };
    const result = await fetchCapped(
      fetchImpl,
      `https://${API_HOST}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
      { headers: githubApiHeaders(), maxBytes: MAX_LISTING_BYTES, requestTimeoutMs },
    );
    if (!result.ok) {
      return { ok: false, error: prefixedError('SOURCE_REPO_INFO', result.error) };
    }
    let branch = null;
    try {
      const parsed_ = JSON.parse(result.bytes.toString('utf8'));
      if (typeof parsed_.default_branch === 'string' && parsed_.default_branch !== '') branch = parsed_.default_branch;
    } catch {
      branch = null;
    }
    if (!branch || !segmentIsSafe(branch)) {
      return { ok: false, error: { code: 'SOURCE_REPO_INFO_JSON_INVALID', message: 'Repository metadata is not valid JSON or lacks a default branch' } };
    }
    defaultBranches.set(repoKey, branch);
    return { ok: true, ref: branch };
  }

  /**
   * Resolves a ref name to an immutable commit SHA. Branches advance over time: requesting by ref
   * directly risks directory enumeration and file downloads pulling from different commits. Pinning
   * to SHA ensures git trees, contents API, and raw downloads target the exact same commit.
   * SHA is not cached persistently: each refresh/install re-resolves so branch updates are visible.
   */
  async function resolveSourceCommit(parsed) {
    const ref = await resolveDefaultBranch(parsed);
    if (!ref.ok) return ref;
    const result = await fetchCapped(
      fetchImpl,
      `https://${API_HOST}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`
      + `/commits/${encodeURIComponent(ref.ref)}`,
      { headers: githubApiHeaders(), maxBytes: MAX_LISTING_BYTES, requestTimeoutMs },
    );
    if (!result.ok) {
      return { ok: false, error: prefixedError('SOURCE_COMMIT', result.error) };
    }
    let sha = null;
    try {
      const payload = JSON.parse(result.bytes.toString('utf8'));
      if (typeof payload.sha === 'string' && /^[0-9a-f]{40}$/.test(payload.sha)) sha = payload.sha;
    } catch {
      sha = null;
    }
    if (!sha) {
      return { ok: false, error: { code: 'SOURCE_COMMIT_JSON_INVALID', message: 'Repository commit metadata is not valid JSON or lacks a commit SHA' } };
    }
    return { ok: true, sha };
  }

  /** Enumerates a source: lists directories and probes each subdirectory for manifest.json. */
  async function listSourcePlugins(source) {
    const parsed = parseSourceUrl(source.url);
    if (!parsed) {
      return { status: 'error', plugins: [], warnings: [], error: { code: 'SOURCE_URL_INVALID', message: 'The source URL is not a GitHub repository directory' } };
    }
    const commit = await resolveSourceCommit(parsed);
    if (!commit.ok) {
      return { status: 'error', plugins: [], warnings: [], error: commit.error };
    }

    const contentsUrl = `https://${API_HOST}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`
      + `/contents/${encodePath(parsed.dirPath)}?ref=${encodeURIComponent(commit.sha)}`;
    const listing = await fetchCapped(fetchImpl, contentsUrl, {
      headers: githubApiHeaders(),
      maxBytes: MAX_LISTING_BYTES,
      requestTimeoutMs,
    });
    if (!listing.ok) {
      const error = prefixedError('SOURCE_LIST', listing.error);
      if (listing.error.status === 404) {
        return { status: 'error', plugins: [], warnings: [], error: { code: 'SOURCE_PATH_NOT_FOUND', message: 'The source directory does not exist in this repository' } };
      }
      return { status: 'error', plugins: [], warnings: [], error };
    }
    let entries;
    try {
      entries = JSON.parse(listing.bytes.toString('utf8'));
    } catch {
      return { status: 'error', plugins: [], warnings: [], error: { code: 'SOURCE_LIST_JSON_INVALID', message: 'The directory listing is not valid JSON' } };
    }
    if (!Array.isArray(entries)) {
      return { status: 'error', plugins: [], warnings: [], error: { code: 'SOURCE_LIST_JSON_INVALID', message: 'The directory listing is not a JSON array' } };
    }

    const directories = entries
      .filter((entry) => entry && entry.type === 'dir' && typeof entry.name === 'string'
        && !entry.name.startsWith('.') && segmentIsSafe(entry.name))
      .map((entry) => entry.name);
    const warnings = [];
    if (directories.length > MAX_SOURCE_DIRECTORIES) {
      warnings.push(`The source lists more than ${MAX_SOURCE_DIRECTORIES} directories; only the first ${MAX_SOURCE_DIRECTORIES} were checked.`);
      directories.length = MAX_SOURCE_DIRECTORIES;
    }
    if (directories.length === 0) {
      return { status: 'ok', plugins: [], warnings, error: null, fetchedAt: new Date().toISOString() };
    }

    const probed = await mapLimit(directories, PROBE_CONCURRENCY, async (directory) => {
      const manifestUrl = `https://${RAW_HOST}/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`
        + `/${encodeURIComponent(commit.sha)}/${encodePath(parsed.dirPath, directory, 'manifest.json')}`;
      const response = await fetchCapped(fetchImpl, manifestUrl, {
        headers: { Accept: 'application/json' },
        maxBytes: MAX_MANIFEST_BYTES,
        requestTimeoutMs,
      });
      // Subdirectories lacking manifest.json are not plugins: silently skip; record other failures as warnings.
      if (!response.ok) {
        if (response.error.status === 404) return { skipped: true };
        return { skipped: false, warning: `${directory}: ${prefixedError('SOURCE_MANIFEST', response.error).message}` };
      }
      let manifest;
      try {
        manifest = JSON.parse(response.bytes.toString('utf8'));
      } catch {
        return { skipped: false, warning: `${directory}: manifest.json is not valid JSON` };
      }
      const validation = validateManifest(manifest);
      if (!validation.success) {
        return { skipped: false, warning: `${directory}: ${validation.message} (${validation.code})` };
      }
      return { skipped: false, plugin: { directoryName: directory, manifest: validation.data } };
    });

    const plugins = [];
    const seenIds = new Set();
    for (const probe of probed) {
      if (!probe || probe.skipped) continue;
      if (probe.warning) {
        warnings.push(probe.warning);
        continue;
      }
      const plugin = probe.plugin;
      if (seenIds.has(plugin.manifest.id)) {
        warnings.push(`${plugin.directoryName}: a plugin with id '${plugin.manifest.id}' is already listed by this source.`);
        continue;
      }
      seenIds.add(plugin.manifest.id);
      plugins.push(plugin);
    }
    plugins.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name, 'en'));

    return { status: 'ok', plugins, warnings, error: null, fetchedAt: new Date().toISOString() };
  }

  function publishCatalog(sourceId, result) {
    // The source may have been removed while listing: verify it still exists before publishing.
    if (!findSource(sourceId)) return;
    catalog.set(sourceId, result);
  }

  /**
   * Refreshes a source and publishes catalog. Deduplicates in-flight calls and guards against stale results:
   * - Reuses in-flight listing for the same source URL;
   * - Discards results if source was removed or URL changed during listing.
   */
  function refreshOne(source) {
    const inFlightKey = `${source.id}:${source.url}`;
    const existing = refreshInFlight.get(inFlightKey);
    if (existing) return existing;
    const urlAtStart = source.url;
    const promise = (async () => {
      try {
        const result = await listSourcePlugins(source);
        if (source.url !== urlAtStart || !findSource(source.id)) return;
        publishCatalog(source.id, result);
      } catch (error) {
        if (source.url !== urlAtStart || !findSource(source.id)) return;
        publishCatalog(source.id, {
          status: 'error',
          plugins: [],
          warnings: [],
          error: { code: 'SOURCE_LIST_UNREACHABLE', message: sanitizeText(error instanceof Error ? error.message : 'Source could not be fetched') },
          fetchedAt: new Date().toISOString(),
        });
      }
    })().finally(() => {
      if (refreshInFlight.get(inFlightKey) === promise) refreshInFlight.delete(inFlightKey);
    });
    refreshInFlight.set(inFlightKey, promise);
    return promise;
  }

  function clearStagingRoot() {
    try {
      if (!fs.existsSync(stagingRoot)) return;
      for (const entry of fs.readdirSync(stagingRoot)) {
        try { fs.rmSync(path.join(stagingRoot, entry), { recursive: true, force: true }); } catch { /* keep going */ }
      }
    } catch { /* staging cleanup is best-effort */ }
  }

  return {
    getState,
    async addSource(input) {
      const url = typeof input?.url === 'string' ? input.url.trim() : '';
      const parsed = parseSourceUrl(url);
      if (!parsed) {
        return { success: false, error: { code: 'SOURCE_URL_INVALID', message: 'Enter a GitHub repository directory URL, e.g. https://github.com/owner/repo/tree/main/plugins' } };
      }
      if (sources.length >= 50) {
        return { success: false, error: { code: 'SOURCE_LIMIT_REACHED', message: 'The plugin source list is full' } };
      }
      const canonical = canonicalKey(parsed);
      const duplicate = sources.find((source) => {
        const existing = parseSourceUrl(source.url);
        return existing && canonicalKey(existing) === canonical;
      });
      if (duplicate) {
        return { success: false, error: { code: 'SOURCE_ALREADY_EXISTS', message: 'This plugin source has already been added' } };
      }
      const name = typeof input?.name === 'string' && input.name.trim() !== '' ? input.name.trim().slice(0, 200) : parsed.defaultName;
      const source = { id: `src-${randomUUID()}`, url, ...(name ? { name } : {}), addedAt: new Date().toISOString() };
      sources.push(source);
      persist();
      await refreshOne(source);
      return { success: true, state: getState() };
    },
    async updateSource(input) {
      const id = typeof input?.id === 'string' ? input.id : '';
      const source = findSource(id);
      if (!source) {
        return { success: false, error: { code: 'SOURCE_NOT_FOUND', message: 'The plugin source was not found' } };
      }
      const nameInput = typeof input?.name === 'string' ? input.name.trim().slice(0, 200) : undefined;
      const urlInput = typeof input?.url === 'string' ? input.url.trim() : undefined;
      let refetch = false;
      if (urlInput !== undefined && urlInput !== source.url) {
        const parsed = parseSourceUrl(urlInput);
        if (!parsed) {
          return { success: false, error: { code: 'SOURCE_URL_INVALID', message: 'Enter a GitHub repository directory URL, e.g. https://github.com/owner/repo/tree/main/plugins' } };
        }
        const canonical = canonicalKey(parsed);
        const duplicate = sources.find((other) => {
          if (other.id === id) return false;
          const existing = parseSourceUrl(other.url);
          return existing && canonicalKey(existing) === canonical;
        });
        if (duplicate) {
          return { success: false, error: { code: 'SOURCE_ALREADY_EXISTS', message: 'This plugin source has already been added' } };
        }
        source.url = urlInput;
        refetch = true;
      }
      if (nameInput !== undefined) {
        if (nameInput === '') delete source.name;
        else source.name = nameInput;
      }
      persist();
      if (refetch) await refreshOne(source);
      return { success: true, state: getState() };
    },
    async removeSource(input) {
      const id = typeof input?.id === 'string' ? input.id : '';
      const index = sources.findIndex((source) => source.id === id);
      if (index === -1) {
        return { success: false, error: { code: 'SOURCE_NOT_FOUND', message: 'The plugin source was not found' } };
      }
      sources.splice(index, 1);
      catalog.delete(id);
      persist();
      return { success: true, state: getState() };
    },
    async refresh(options) {
      const sourceId = typeof options?.sourceId === 'string' ? options.sourceId : null;
      const targets = sourceId ? sources.filter((source) => source.id === sourceId) : [...sources];
      // Concurrent refreshes for the same source are deduplicated in refreshOne; wait for all targets.
      await Promise.all(targets.map((source) => refreshOne(source)));
      return { success: true, state: getState() };
    },

    /**
     * Installs a plugin from source: downloads files to staging, then delegates to pluginManager.
     * When replace is true (update flow), uninstalls the previous version while preserving data.
     */
    install(request) {
      const sourceId = typeof request?.sourceId === 'string' ? request.sourceId : '';
      const directoryName = typeof request?.directoryName === 'string' ? request.directoryName : '';
      const replace = request?.replace === true;
      const expectedPluginId = typeof request?.expectedPluginId === 'string' ? request.expectedPluginId.trim() : '';
      const expectedVersion = typeof request?.expectedVersion === 'string' ? request.expectedVersion.trim() : '';
      // Installation and updates uninstall/reinstall plugins; serialize to avoid concurrency races.
      const run = () => installInner(sourceId, directoryName, replace, expectedPluginId, expectedVersion);
      const result = installChain.then(run, run);
      installChain = result.then(() => undefined, () => undefined);
      return result;
    },
    /** Test helper: resets in-memory sources to the specified list. */
    __setSourcesForTests(next) {
      sources = normalizeState({ version: 1, sources: next }).sources;
    },
  };

  function validateRelativeEntry(stagingDirectory, relative) {
    if (relative === '' || relative.startsWith('/') || relative.includes('\\')) return false;
    const segments = relative.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false;
    if (segments.some((segment) => !segmentIsSafe(segment) || WINDOWS_RESERVED_RE.test(segment) || /[. ]$/.test(segment))) {
      return false;
    }
    return isInside(path.resolve(stagingDirectory), path.resolve(stagingDirectory, relative));
  }

  async function downloadPackageFiles(parsed, sha, directoryName, dirPath, stagingDirectory) {
    const treeUrl = `https://${API_HOST}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`
      + `/git/trees/${encodeURIComponent(sha)}?recursive=1`;
    const tree = await fetchCapped(fetchImpl, treeUrl, {
      headers: githubApiHeaders(),
      maxBytes: MAX_LISTING_BYTES,
      requestTimeoutMs,
    });
    if (!tree.ok) {
      const error = prefixedError('SOURCE_TREE', tree.error);
      return { ok: false, error: tree.error.status === 404 ? { code: 'SOURCE_PATH_NOT_FOUND', message: 'The source directory does not exist in this repository' } : error };
    }
    let treePayload;
    try {
      treePayload = JSON.parse(tree.bytes.toString('utf8'));
    } catch {
      return { ok: false, error: { code: 'SOURCE_TREE_JSON_INVALID', message: 'The repository file tree is not valid JSON' } };
    }
    if (treePayload && treePayload.truncated === true) {
      return { ok: false, error: { code: 'SOURCE_TREE_TRUNCATED', message: 'The repository is too large to enumerate; plugin installation from this source is unavailable' } };
    }
    const blobs = Array.isArray(treePayload?.tree) ? treePayload.tree : [];
    const prefix = dirPath ? `${dirPath}/${directoryName}/` : `${directoryName}/`;
    const files = [];
    for (const entry of blobs) {
      if (typeof entry?.path !== 'string' || !entry.path.startsWith(prefix)) continue;
      if (entry.type === 'commit') {
        return { ok: false, error: { code: 'MARKETPLACE_SUBMODULE_UNSUPPORTED', message: 'The plugin directory contains a git submodule, which cannot be installed' } };
      }
      if (entry.type !== 'blob') continue;
      files.push(entry);
    }
    if (files.length === 0) {
      return { ok: false, error: { code: 'MARKETPLACE_PLUGIN_NOT_FOUND', message: 'No plugin files were found under this source directory' } };
    }
    if (files.length > MAX_PLUGIN_PACKAGE_FILES
      || files.reduce((total, entry) => total + (Number(entry.size) || 0), 0) > MAX_PLUGIN_PACKAGE_BYTES) {
      return { ok: false, error: { code: 'MARKETPLACE_PACKAGE_TOO_LARGE', message: 'The plugin package exceeds the installation limits' } };
    }

    let totalBytes = 0;
    await mapLimit(files, DOWNLOAD_CONCURRENCY, async (entry) => {
      const relative = entry.path.slice(prefix.length);
      if (!validateRelativeEntry(stagingDirectory, relative)) {
        throw Object.assign(new Error(`Plugin file path '${entry.path}' is unsafe`), { code: 'MARKETPLACE_ENTRY_UNSAFE' });
      }
      const target = path.join(stagingDirectory, relative);
      const response = await fetchCapped(
        fetchImpl,
        `https://${RAW_HOST}/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`
        + `/${encodeURIComponent(sha)}/${encodePath(entry.path)}`,
        { headers: { Accept: 'application/octet-stream' }, maxBytes: MAX_PLUGIN_PACKAGE_BYTES, requestTimeoutMs },
      );
      if (!response.ok) {
        throw Object.assign(
          new Error(prefixedError('MARKETPLACE_DOWNLOAD', response.error).message),
          { code: prefixedError('MARKETPLACE_DOWNLOAD', response.error).code },
        );
      }
      const bytes = response.bytes;
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_PLUGIN_PACKAGE_BYTES) {
        throw Object.assign(new Error('The plugin package exceeds the installation limits'), { code: 'MARKETPLACE_PACKAGE_TOO_LARGE' });
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
      return undefined;
    });

    // Rely on the actually downloaded manifest to obtain plugin id for uninstallation in update flow.
    const manifestPath = path.join(stagingDirectory, 'manifest.json');
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      return { ok: false, error: { code: 'MARKETPLACE_MANIFEST_INVALID', message: 'The downloaded plugin manifest is missing or unreadable' } };
    }
    const validation = validateManifest(manifest);
    if (!validation.success) {
      return { ok: false, error: { code: 'MARKETPLACE_MANIFEST_INVALID', message: validation.message } };
    }
    return { ok: true, pluginId: validation.data.id, manifestVersion: validation.data.version };
  }

  /**
   * Matches against revocation/block list: empty versions array means all versions.
   * On multiple matches, revoke takes priority over block, and newer dates take priority (matching renderer logic).
   */
  function findRemovalRecord(removed, pluginId, version) {
    const matches = (removed || []).filter((record) =>
      record && record.id === pluginId
      && Array.isArray(record.versions)
      && (record.versions.length === 0 || record.versions.includes(version)));
    if (matches.length === 0) return null;
    matches.sort((left, right) => (
      (left.action === 'revoke' ? 0 : 1) - (right.action === 'revoke' ? 0 : 1)
      || String(right.date || '').localeCompare(String(left.date || ''))
    ));
    return matches[0];
  }

  /**
   * Final verification against official static registry revocation/block list in main process, independent of renderer.
   * Passes if registry is temporarily unreachable (matching informational nature and local install trust model).
   */
  async function checkOfficialRemoval({ id, version }) {
    const registry = await loadPluginRegistry({ fetchImpl });
    if (!registry.success) return null;
    const record = findRemovalRecord(registry.registry.removed, id, version);
    if (!record) return null;
    return {
      code: record.action === 'revoke' ? 'MARKETPLACE_VERSION_REVOKED' : 'MARKETPLACE_VERSION_BLOCKED',
      message: `Version ${version} of '${id}' is ${record.action} by the official registry`,
    };
  }

  async function installInner(sourceId, directoryName, replace, expectedPluginId, expectedVersion) {
    // Request must include the plugin identity displayed to the user; otherwise downloaded files cannot
    // be verified against the clicked entry, risking installing or replacing the wrong plugin.
    if (!expectedPluginId || !expectedVersion) {
      return { success: false, error: { code: 'MARKETPLACE_IDENTITY_REQUIRED', message: 'The install request must carry the plugin identity shown to the user' } };
    }
    if (!directoryName || directoryName.includes('/') || directoryName.includes('\\') || directoryName === '.' || directoryName === '..') {
      return { success: false, error: { code: 'MARKETPLACE_PLUGIN_NOT_FOUND', message: 'No plugin files were found under this source directory' } };
    }
    const source = findSource(sourceId);
    if (!source) {
      return { success: false, error: { code: 'SOURCE_NOT_FOUND', message: 'The plugin source was not found' } };
    }
    const parsed = parseSourceUrl(source.url);
    if (!parsed) {
      return { success: false, error: { code: 'SOURCE_URL_INVALID', message: 'The source URL is not a GitHub repository directory' } };
    }
    const commit = await resolveSourceCommit(parsed);
    if (!commit.ok) {
      return { success: false, error: commit.error };
    }

    clearStagingRoot();
    fs.mkdirSync(stagingRoot, { recursive: true });
    const stagingDirectory = path.join(stagingRoot, randomUUID());
    try {
      const downloaded = await downloadPackageFiles(parsed, commit.sha, directoryName, parsed.dirPath, stagingDirectory);
      if (!downloaded.ok) return { success: false, error: downloaded.error };
      // Source may have been removed during download: verify before committing to avoid ghost plugins.
      if (!findSource(sourceId)) {
        return { success: false, error: { code: 'SOURCE_NOT_FOUND', message: 'The plugin source was not found' } };
      }
      // Downloaded manifest must match the expected identity, preventing bait-and-switch installs.
      if (expectedPluginId !== downloaded.pluginId || expectedVersion !== downloaded.manifestVersion) {
        return { success: false, error: { code: 'MARKETPLACE_PLUGIN_CHANGED', message: 'The plugin changed on the source while installing; refresh and try again' } };
      }
      // Final verification against official revocation/block list in main process.
      const removal = await checkOfficialRemoval({ id: downloaded.pluginId, version: downloaded.manifestVersion });
      if (removal) {
        return { success: false, error: removal };
      }
      if (replace) {
        // Update: pluginManager atomically replaces directory, rolling back old version and state on failure.
        // Must await: returning a promise inside try/finally without await would run finally before settlement,
        // prematurely cleaning up staging and breaking the async replacement.
        return await pluginManager.replaceFromDirectory(stagingDirectory);
      }
      return pluginManager.installFromDirectory(stagingDirectory);
    } catch (error) {
      return {
        success: false,
        error: {
          code: typeof error?.code === 'string' ? error.code : 'MARKETPLACE_INSTALL_FAILED',
          message: sanitizeText(error instanceof Error ? error.message : 'Plugin installation failed'),
        },
      };
    } finally {
      try { fs.rmSync(stagingDirectory, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

module.exports = {
  DEFAULT_PLUGIN_SOURCE_URL,
  MAX_PLUGIN_PACKAGE_BYTES,
  MAX_PLUGIN_PACKAGE_FILES,
  MAX_SOURCE_DIRECTORIES,
  REQUEST_TIMEOUT_MS,
  createPluginMarketplace,
  mapLimit,
  parseSourceUrl,
};
