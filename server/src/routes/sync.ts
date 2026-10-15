import { Router } from 'express';
import { getDb } from '../db/connection.js';
import { encrypt, decrypt } from '../services/crypto.js';
import { config } from '../config.js';

const router = Router();

/** Aligned with frontend NOASSERTION_KEYS: whitespace / NOASSERTION / Other / none resolve to null. */
const NO_LICENSE_KEYS = new Set(['', 'noassertion', 'other', 'none', 'no-license']);

/**
 * Canonicalize an imported license string into an SPDX id or null.
 * Returns null if empty after trimming or belonging to the "no license" set; otherwise returns the trimmed string.
 */
function canonicalizeLicenseString(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || NO_LICENSE_KEYS.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

function maskApiKey(key: string | null | undefined): string {
  if (!key || typeof key !== 'string') return '';
  if (key.length <= 4) return '****';
  return '***' + key.slice(-4);
}

// POST /api/sync/export
router.post('/api/sync/export', (_req, res) => {
  try {
    const db = getDb();

    const repositories = db.prepare('SELECT * FROM repositories').all() as Record<string, unknown>[];
    const releases = db.prepare('SELECT * FROM releases').all() as Record<string, unknown>[];
    const categories = db.prepare('SELECT * FROM categories').all() as Record<string, unknown>[];
    const assetFilters = db.prepare('SELECT * FROM asset_filters').all() as Record<string, unknown>[];

    // AI configs — mask api_key
    const aiConfigRows = db.prepare('SELECT * FROM ai_configs').all() as Record<string, unknown>[];
    const aiConfigs = aiConfigRows.map((row) => {
      const masked = { ...row };
      if (masked.api_key_encrypted && typeof masked.api_key_encrypted === 'string') {
        try {
          masked.api_key_masked = maskApiKey(decrypt(masked.api_key_encrypted, config.encryptionKey));
        } catch {
          masked.api_key_masked = '****';
        }
      }
      delete masked.api_key_encrypted;
      return masked;
    });

    // WebDAV configs — mask password
    const webdavRows = db.prepare('SELECT * FROM webdav_configs').all() as Record<string, unknown>[];
    const webdavConfigs = webdavRows.map((row) => {
      const masked = { ...row };
      if (masked.password_encrypted && typeof masked.password_encrypted === 'string') {
        try {
          masked.password_masked = maskApiKey(decrypt(masked.password_encrypted, config.encryptionKey));
        } catch {
          masked.password_masked = '****';
        }
      }
      delete masked.password_encrypted;
      return masked;
    });

    // Settings — mask github_token
    const settingsRows = db.prepare('SELECT * FROM settings').all() as Record<string, unknown>[];
    const settings: Record<string, unknown> = {};
    for (const row of settingsRows) {
      const key = row.key as string;
      let value = row.value as string | null;
      if (key === 'github_token' && value) {
        try {
          value = maskApiKey(decrypt(value, config.encryptionKey));
        } catch {
          value = '****';
        }
      }
      settings[key] = value;
    }

    res.json({
      version: 1,
      exported_at: new Date().toISOString(),
      repositories,
      releases,
      categories,
      asset_filters: assetFilters,
      ai_configs: aiConfigs,
      webdav_configs: webdavConfigs,
      settings,
    });
  } catch (err) {
    console.error('POST /api/sync/export error:', err);
    res.status(500).json({ error: 'Failed to export data', code: 'EXPORT_DATA_FAILED' });
  }
});

// POST /api/sync/import
router.post('/api/sync/import', (req, res) => {
  try {
    const db = getDb();
    const data = req.body as Record<string, unknown>;
    const counts: Record<string, number> = {};

    // Validate required data structure
    if (!data || typeof data !== 'object') {
      res.status(400).json({ error: 'Invalid data format', code: 'INVALID_DATA_FORMAT' });
      return;
    }

    // Validate releases before import: id / repo_id / repo_full_name / repo_name must be non-null
    // to avoid NOT NULL column constraint failures throwing a 500 error on the whole transaction.
    const importRels = data.releases as Record<string, unknown>[] | undefined;
    if (Array.isArray(importRels)) {
      for (const r of importRels) {
        const repository = r.repository as { id?: unknown; full_name?: unknown; name?: unknown } | undefined;
        const id = r.id;
        const repoId = r.repo_id ?? repository?.id;
        const repoFullName = r.repo_full_name ?? repository?.full_name;
        const repoName = r.repo_name ?? repository?.name;
        if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
          res.status(400).json({
            error: 'Each release must have a valid positive integer id',
            code: 'RELEASE_ID_REQUIRED',
          });
          return;
        }
        if (typeof repoId !== 'number' || !Number.isInteger(repoId) || repoId <= 0) {
          res.status(400).json({
            error: 'Each release must have a valid positive integer repo_id',
            code: 'RELEASE_REPO_ID_REQUIRED',
          });
          return;
        }
        if (typeof repoFullName !== 'string' || !repoFullName.trim()) {
          res.status(400).json({
            error: 'Each release must have a non-empty repo_full_name',
            code: 'RELEASE_REPO_FULL_NAME_REQUIRED',
          });
          return;
        }
        if (typeof repoName !== 'string' || !repoName.trim()) {
          res.status(400).json({
            error: 'Each release must have a non-empty repo_name',
            code: 'RELEASE_REPO_NAME_REQUIRED',
          });
          return;
        }
      }
    }

    const importAll = db.transaction(() => {
      // Repositories
      const repos = data.repositories as Record<string, unknown>[] | undefined;
      if (Array.isArray(repos) && repos.length > 0) {
        const repoStmt = db.prepare(`
          INSERT OR REPLACE INTO repositories (
            id, name, full_name, description, html_url, stargazers_count, language,
            created_at, updated_at, pushed_at, starred_at,
            owner_login, owner_avatar_url, topics,
            ai_summary, ai_tags, ai_platforms, analyzed_at, analysis_failed,
            custom_description, custom_tags, custom_category, category_locked, last_edited,
            subscribed_to_releases, vector_indexed_at, license, vector_indexed_license
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const r of repos) {
          // Validate required fields
          if (!r.id || typeof r.id !== 'number') {
            throw new Error(`Invalid repository data: missing or invalid id`);
          }
          // license: compatible with legacy backups (missing column -> null), GitHub object shapes, and normalized SPDX strings.
          // After trimming candidate strings, whitespace / NOASSERTION / Other / none consistently resolve to null (aligned with
          // frontend normalizeLicense "no license" semantics), ensuring the DB only stores SPDX-or-null.
          const rawLicense = (r as Record<string, unknown>).license;
          let licenseValue: string | null = null;
          if (typeof rawLicense === 'string') {
            licenseValue = canonicalizeLicenseString(rawLicense);
          } else if (rawLicense && typeof rawLicense === 'object') {
            const obj = rawLicense as { spdx_id?: unknown; key?: unknown };
            const spdx = typeof obj.spdx_id === 'string' ? obj.spdx_id.trim() : '';
            const key = typeof obj.key === 'string' ? obj.key.trim() : '';
            licenseValue = canonicalizeLicenseString(spdx || key);
          }
          // vector_indexed_license shares the same SPDX-or-null rules as license, preventing fingerprint vs. current
          // license divergence (e.g. "NOASSERTION" stored verbatim would cause incremental predicates to always flag changes).
          const rawVectorLicense = (r as Record<string, unknown>).vector_indexed_license;
          const vectorIndexedLicense = typeof rawVectorLicense === 'string'
            ? canonicalizeLicenseString(rawVectorLicense)
            : null;
          repoStmt.run(
            r.id, r.name, r.full_name, r.description ?? null,
            r.html_url, r.stargazers_count ?? 0, r.language ?? null,
            r.created_at ?? null, r.updated_at ?? null, r.pushed_at ?? null,
            r.starred_at ?? null,
            r.owner_login ?? '', r.owner_avatar_url ?? null,
            typeof r.topics === 'string' ? r.topics : JSON.stringify(r.topics ?? []),
            r.ai_summary ?? null,
            typeof r.ai_tags === 'string' ? r.ai_tags : JSON.stringify(r.ai_tags ?? []),
            typeof r.ai_platforms === 'string' ? r.ai_platforms : JSON.stringify(r.ai_platforms ?? []),
            r.analyzed_at ?? null, r.analysis_failed ? 1 : 0,
            r.custom_description ?? null,
            typeof r.custom_tags === 'string' ? r.custom_tags : JSON.stringify(r.custom_tags ?? []),
            r.custom_category ?? null, (r.category_locked === true || r.category_locked === 1) ? 1 : 0, r.last_edited ?? null,
            r.subscribed_to_releases ? 1 : 0,
            r.vector_indexed_at ?? null,
            licenseValue,
            // INSERT OR REPLACE replaces the entire row, so backups missing this column store null (triggering
            // a one-time re-indexing to backfill fingerprints), which is expected.
            vectorIndexedLicense
          );
        }
        counts.repositories = repos.length;
      }

      // Releases
      // Merging UPSERT: on conflict only updates data columns, preserving existing is_read status in the DB.
      // Overwrites is_read only when the snapshot explicitly includes an is_read boolean (stmtOverwriteIsRead);
      // otherwise takes the preservation branch to prevent imports/rollbacks from inadvertently clearing read status.
      const rels = data.releases as Record<string, unknown>[] | undefined;
      if (Array.isArray(rels) && rels.length > 0) {
        const relStmtPreserveIsRead = db.prepare(`
          INSERT INTO releases (
            id, tag_name, name, body, html_url, published_at,
            prerelease, draft, is_read, assets,
            repo_id, repo_full_name, repo_name,
            zipball_url, tarball_url
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            tag_name = excluded.tag_name,
            name = excluded.name,
            body = excluded.body,
            html_url = excluded.html_url,
            published_at = excluded.published_at,
            prerelease = excluded.prerelease,
            draft = excluded.draft,
            is_read = releases.is_read,
            assets = excluded.assets,
            repo_id = excluded.repo_id,
            repo_full_name = excluded.repo_full_name,
            repo_name = excluded.repo_name,
            zipball_url = excluded.zipball_url,
            tarball_url = excluded.tarball_url
        `);
        const relStmtOverwriteIsRead = db.prepare(`
          INSERT INTO releases (
            id, tag_name, name, body, html_url, published_at,
            prerelease, draft, is_read, assets,
            repo_id, repo_full_name, repo_name,
            zipball_url, tarball_url
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            tag_name = excluded.tag_name,
            name = excluded.name,
            body = excluded.body,
            html_url = excluded.html_url,
            published_at = excluded.published_at,
            prerelease = excluded.prerelease,
            draft = excluded.draft,
            is_read = excluded.is_read,
            assets = excluded.assets,
            repo_id = excluded.repo_id,
            repo_full_name = excluded.repo_full_name,
            repo_name = excluded.repo_name,
            zipball_url = excluded.zipball_url,
            tarball_url = excluded.tarball_url
        `);
        for (const r of rels) {
          const repository = r.repository as { id?: number; full_name?: string; name?: string } | undefined;
          const hasExplicitIsRead = typeof r.is_read === 'boolean';
          const relStmt = hasExplicitIsRead ? relStmtOverwriteIsRead : relStmtPreserveIsRead;
          relStmt.run(
            r.id, r.tag_name ?? null, r.name ?? null, r.body ?? null,
            r.html_url ?? null, r.published_at ?? null,
            r.prerelease ? 1 : 0, r.draft ? 1 : 0,
            // Under the preservation branch still default to 0 (non-null), matching releases table is_read DEFAULT 0 semantics
            // to avoid newly imported rows storing NULL which would cause unread filtering (is_read = 0) to omit them.
            hasExplicitIsRead ? (r.is_read ? 1 : 0) : 0,
            typeof r.assets === 'string' ? r.assets : JSON.stringify(r.assets ?? []),
            r.repo_id ?? repository?.id ?? null,
            r.repo_full_name ?? repository?.full_name ?? null,
            r.repo_name ?? repository?.name ?? null,
            r.zipball_url ?? null,
            r.tarball_url ?? null
          );
        }
        counts.releases = rels.length;
      }

      // Categories
      const cats = data.categories as Record<string, unknown>[] | undefined;
      if (Array.isArray(cats) && cats.length > 0) {
        const catStmt = db.prepare(`
          INSERT OR REPLACE INTO categories (id, name, description, icon, keywords, color, sort_order, is_custom)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const c of cats) {
          catStmt.run(
            c.id, c.name ?? '', c.description ?? null, c.icon ?? '📁',
            typeof c.keywords === 'string' ? c.keywords : JSON.stringify(c.keywords ?? []),
            c.color ?? null, c.sort_order ?? 0, c.is_custom ? 1 : 0
          );
        }
        counts.categories = cats.length;
      }

      // Asset Filters
      const filters = data.asset_filters as Record<string, unknown>[] | undefined;
      if (Array.isArray(filters) && filters.length > 0) {
        const filterStmt = db.prepare(`
          INSERT OR REPLACE INTO asset_filters (id, name, description, keywords, platform, sort_order)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const f of filters) {
          filterStmt.run(
            f.id, f.name ?? '', f.description ?? null,
            typeof f.keywords === 'string' ? f.keywords : JSON.stringify(f.keywords ?? []),
            f.platform ?? null, f.sort_order ?? 0
          );
        }
        counts.asset_filters = filters.length;
      }

      // AI Configs — skip masked secrets
      const aiConfigs = data.ai_configs as Record<string, unknown>[] | undefined;
      if (Array.isArray(aiConfigs) && aiConfigs.length > 0) {
        for (const c of aiConfigs) {
          const existing = db.prepare('SELECT api_key_encrypted FROM ai_configs WHERE id = ?').get(c.id) as Record<string, unknown> | undefined;
          const existingKey = (existing?.api_key_encrypted as string) ?? null;
          // Skip masked keys, keep existing encrypted value
          db.prepare(`
            INSERT OR REPLACE INTO ai_configs (id, name, api_type, base_url, api_key_encrypted, model, is_active, custom_prompt, use_custom_prompt, concurrency, reasoning_effort, mimo_plan)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            c.id, c.name ?? '', c.api_type ?? c.apiType ?? 'openai', c.base_url ?? c.baseUrl ?? null,
            existingKey, c.model ?? '',
            (c.is_active ?? c.isActive) ? 1 : 0, c.custom_prompt ?? c.customPrompt ?? null,
            (c.use_custom_prompt ?? c.useCustomPrompt) ? 1 : 0, c.concurrency ?? 1, c.reasoning_effort ?? c.reasoningEffort ?? null,
            c.mimo_plan ?? c.mimoPlan ?? null
          );
        }
        counts.ai_configs = aiConfigs.length;
      }

      // WebDAV Configs — skip masked secrets
      const webdavConfigs = data.webdav_configs as Record<string, unknown>[] | undefined;
      if (Array.isArray(webdavConfigs) && webdavConfigs.length > 0) {
        for (const c of webdavConfigs) {
          const existing = db.prepare('SELECT password_encrypted FROM webdav_configs WHERE id = ?').get(c.id) as Record<string, unknown> | undefined;
          const existingPwd = (existing?.password_encrypted as string) ?? null;
          db.prepare(`
            INSERT OR REPLACE INTO webdav_configs (id, name, url, username, password_encrypted, path, is_active)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            c.id, c.name ?? '', c.url ?? '', c.username ?? '',
            existingPwd,
            c.path ?? '/', (c.is_active ?? c.isActive) ? 1 : 0
          );
        }
        counts.webdav_configs = webdavConfigs.length;
      }

      // Settings — skip masked github_token
      const settings = data.settings as Record<string, unknown> | undefined;
      if (settings && typeof settings === 'object') {
        const settingsStmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
        let settingsCount = 0;
        for (const [key, value] of Object.entries(settings)) {
          if (key === 'github_token' && typeof value === 'string' && value.startsWith('***')) {
            continue; // Skip masked token
          }
          if (key === 'github_token' && value && typeof value === 'string') {
            settingsStmt.run(key, encrypt(value, config.encryptionKey));
          } else {
            settingsStmt.run(key, (value as string) ?? null);
          }
          settingsCount++;
        }
        counts.settings = settingsCount;
      }
    });

    importAll();
    res.json({ imported: counts });
  } catch (err) {
    console.error('POST /api/sync/import error:', err);
    res.status(500).json({ error: 'Failed to import data', code: 'IMPORT_DATA_FAILED' });
  }
});

export default router;
