import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

const getDbMock = vi.fn();

vi.mock('../../src/db/connection.js', () => ({
  getDb: () => getDbMock(),
}));
// The sync route imports config/crypto at top level, but the import branch does not actually use them; mocking with empty values is sufficient.
vi.mock('../../src/config.js', () => ({ config: { encryptionKey: 'test-key' } }));
vi.mock('../../src/services/crypto.js', () => ({ encrypt: (v: string) => v, decrypt: (v: string) => v }));

const { default: syncRouter } = await import('../../src/routes/sync.js');

const createTestApp = () => {
  const app = express();
  app.use(express.json());
  app.use(syncRouter);
  return app;
};

/**
 * Mock DB: only records prepared SQL and arguments on each run, facilitating assertions on import merge UPSERT is_read semantics.
 */
function captureStatements() {
  const statements: { sql: string; params: unknown[][] }[] = [];
  const exec: Record<string, unknown> = {};
  const db = {
    prepare: (sql: string) => {
      const stmt = {
        run: (...params: unknown[]) => {
          statements.push({ sql, params });
          return { changes: 1 };
        },
        all: () => [],
        get: () => undefined,
      };
      return stmt;
    },
    // In the route, `db.transaction(() => {...})` returns importAll, which is then invoked as `importAll()`;
    // hence return fn itself here (consistent with releasesUpsert.test.ts conventions).
    transaction: (fn: () => number) => fn,
    exec,
  };
  getDbMock.mockReturnValue(db);
  return { statements, db };
}

// In two-statement setup, preservation branch uses releases.is_read and overwrite branch uses excluded.is_read
const releasePreserveIndex = (statements: { sql: string }[]) =>
  statements.findIndex((s) =>
    s.sql.includes('INSERT INTO releases') && s.sql.includes('is_read = releases.is_read')
  );
const releaseOverwriteIndex = (statements: { sql: string }[]) =>
  statements.findIndex((s) =>
    s.sql.includes('INSERT INTO releases') && s.sql.includes('is_read = excluded.is_read')
  );

const validRelease = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  tag_name: 'v1',
  assets: [],
  repo_id: 10,
  repo_full_name: 'owner/repo',
  repo_name: 'repo',
  ...overrides,
});

describe('POST /api/sync/import release upsert is_read semantics', () => {
  it('uses preserve-statement and inserts is_read=0 when snapshot does not carry it', async () => {
    const { statements } = captureStatements();
    await request(createTestApp())
      .post('/api/sync/import')
      .send({
        repositories: [],
        releases: [validRelease()],
      })
      .expect(200);

    const idx = releasePreserveIndex(statements);
    expect(idx).toBeGreaterThan(-1);
    const releaseStmt = statements[idx];
    // Preservation branch: on conflict is_read = releases.is_read (retaining read status from DB)
    expect(releaseStmt.sql).toContain('is_read = releases.is_read');
    expect(releaseStmt.sql).not.toContain('is_read = CASE WHEN');
    // is_read is at index 8 of (id, tag_name, name, body, html_url, published_at, prerelease, draft, is_read, ...)
    // Defaults to 0 when not explicit (matching releases table DEFAULT 0 semantics) to avoid new imports writing NULL and being skipped by unread filters
    expect(releaseStmt.params[8]).toBe(0);
    // Overwrite statement should not be executed
    expect(releaseOverwriteIndex(statements)).toBe(-1);
  });

  it('uses overwrite-statement and passes explicit boolean when snapshot carries is_read', async () => {
    const { statements } = captureStatements();
    await request(createTestApp())
      .post('/api/sync/import')
      .send({
        repositories: [],
        releases: [validRelease({ is_read: true })],
      })
      .expect(200);

    const idx = releaseOverwriteIndex(statements);
    expect(idx).toBeGreaterThan(-1);
    // Overwrite branch: on conflict is_read = excluded.is_read (overwriting with snapshot read status)
    expect(statements[idx].sql).toContain('is_read = excluded.is_read');
    expect(statements[idx].params[8]).toBe(1);
    // Preservation statement should not be executed
    expect(releasePreserveIndex(statements)).toBe(-1);
  });

  it('rejects release snapshot missing required repository fields with 400', async () => {
    captureStatements();
    const res = await request(createTestApp())
      .post('/api/sync/import')
      .send({
        repositories: [],
        releases: [{ id: 1, tag_name: 'v1', assets: [] }],
      })
      .expect(400);

    expect(res.body.code).toBe('RELEASE_REPO_ID_REQUIRED');
  });

  it('accepts repository nested object for required repo fields', async () => {
    const { statements } = captureStatements();
    await request(createTestApp())
      .post('/api/sync/import')
      .send({
        repositories: [],
        releases: [{
          id: 2,
          tag_name: 'v2',
          assets: [],
          repository: { id: 20, full_name: 'owner/other', name: 'other' },
        }],
      })
      .expect(200);

    const idx = releasePreserveIndex(statements);
    expect(idx).toBeGreaterThan(-1);
    // repo_id / full_name / name are positioned after is_read(8) and assets(9)
    expect(statements[idx].params[10]).toBe(20);
    expect(statements[idx].params[11]).toBe('owner/other');
    expect(statements[idx].params[12]).toBe('other');
  });

  it('rejects decimal release id with 400 (must be integer)', async () => {
    captureStatements();
    const res = await request(createTestApp())
      .post('/api/sync/import')
      .send({
        repositories: [],
        releases: [validRelease({ id: 1.5 })],
      })
      .expect(400);

    expect(res.body.code).toBe('RELEASE_ID_REQUIRED');
  });

  it('persists zipball_url and tarball_url on import UPSERT', async () => {
    const { statements } = captureStatements();
    await request(createTestApp())
      .post('/api/sync/import')
      .send({
        repositories: [],
        releases: [validRelease({
          zipball_url: 'https://example.com/zip',
          tarball_url: 'https://example.com/tar',
        })],
      })
      .expect(200);

    const idx = releasePreserveIndex(statements);
    expect(idx).toBeGreaterThan(-1);
    expect(statements[idx].sql).toContain('zipball_url = excluded.zipball_url');
    expect(statements[idx].sql).toContain('tarball_url = excluded.tarball_url');
    // zipball/tarball are positioned after repo_name(12)
    expect(statements[idx].params[13]).toBe('https://example.com/zip');
    expect(statements[idx].params[14]).toBe('https://example.com/tar');
  });

  it('persists archive URLs on overwrite path as well', async () => {
    const { statements } = captureStatements();
    await request(createTestApp())
      .post('/api/sync/import')
      .send({
        repositories: [],
        releases: [validRelease({
          is_read: false,
          zipball_url: 'https://example.com/z2',
          tarball_url: 'https://example.com/t2',
        })],
      })
      .expect(200);

    const idx = releaseOverwriteIndex(statements);
    expect(idx).toBeGreaterThan(-1);
    expect(statements[idx].sql).toContain('zipball_url = excluded.zipball_url');
    expect(statements[idx].sql).toContain('tarball_url = excluded.tarball_url');
    // is_read: false → overwrite branch binds 0
    expect(statements[idx].params[8]).toBe(0);
    expect(statements[idx].params[13]).toBe('https://example.com/z2');
    expect(statements[idx].params[14]).toBe('https://example.com/t2');
  });
});
