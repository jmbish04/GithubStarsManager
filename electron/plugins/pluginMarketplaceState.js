'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

/**
 * Plugin marketplace state store (self-service plugin sources): persists user-added plugin sources.
 *
 * The state layer only normalizes structure and loosely validates that URLs look like GitHub directory URLs.
 * Full URL parsing (owner/repo/ref/path) is handled by pluginMarketplace.js. This decouples the persistence
 * layer from parsing rules so evolving parsing rules won't invalidate existing state files.
 */

const STATE_VERSION = 1;
const MAX_SOURCES = 50;
const MAX_SOURCE_URL_BYTES = 2048;
const MAX_SOURCE_NAME_BYTES = 200;

/** Sources must be GitHub repository directories (or repo roots); full structural validation is done on add. */
function isPlausibleSourceUrl(url) {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_SOURCE_URL_BYTES) return false;
  if (/\s/.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'github.com';
  } catch {
    return false;
  }
}

function normalizeSource(input) {
  if (!input || typeof input !== 'object') return null;
  if (typeof input.id !== 'string' || !/^src-[0-9a-f-]{4,64}$/.test(input.id)) return null;
  if (!isPlausibleSourceUrl(input.url)) return null;
  const name = typeof input.name === 'string' && input.name.trim() !== ''
    ? input.name.trim().slice(0, MAX_SOURCE_NAME_BYTES)
    : null;
  return {
    id: input.id,
    url: input.url,
    ...(name ? { name } : {}),
    addedAt: typeof input.addedAt === 'string' && input.addedAt !== ''
      ? input.addedAt
      : new Date(0).toISOString(),
  };
}

function emptyState() {
  return { version: STATE_VERSION, sources: [] };
}

function normalizeState(input) {
  if (!input || input.version !== STATE_VERSION || !Array.isArray(input.sources)) {
    return emptyState();
  }
  const seen = new Set();
  const sources = [];
  for (const candidate of input.sources) {
    const source = normalizeSource(candidate);
    if (!source || seen.has(source.url.toLowerCase())) continue;
    seen.add(source.url.toLowerCase());
    sources.push(source);
    if (sources.length >= MAX_SOURCES) break;
  }
  return { version: STATE_VERSION, sources };
}

function createMarketplaceStateStore(statePath) {
  if (typeof statePath !== 'string' || statePath.trim() === '') {
    throw new TypeError('statePath must be a non-empty string');
  }
  const resolvedPath = path.resolve(statePath);

  return {
    /** Returns null when the file does not exist, letting callers distinguish "uninitialized" from "cleared by user". */
    load() {
      let text;
      try {
        text = fs.readFileSync(resolvedPath, 'utf8');
      } catch (error) {
        if (error && error.code === 'ENOENT') return null;
        // Re-throw other read errors (permissions, I/O): treating "cannot read" as "empty list"
        // would cause subsequent addSource saves to overwrite the user's existing source list.
        throw error;
      }
      try {
        return normalizeState(JSON.parse(text));
      } catch {
        return emptyState();
      }
    },
    save(state) {
      const normalized = normalizeState(state);
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
      const temporaryPath = `${resolvedPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        });
        fs.renameSync(temporaryPath, resolvedPath);
      } catch (error) {
        try {
          fs.unlinkSync(temporaryPath);
        } catch {
          // Ignore cleanup errors; the original save error is more useful.
        }
        throw error;
      }
    },
  };
}

module.exports = {
  MAX_SOURCES,
  STATE_VERSION,
  createMarketplaceStateStore,
  emptyState,
  isPlausibleSourceUrl,
  normalizeState,
  normalizeSource,
};
