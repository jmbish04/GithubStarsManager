import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

const getDbMock = vi.fn();

vi.mock('../../src/db/connection.js', () => ({
  getDb: () => getDbMock(),
}));

const { default: releasesRouter } = await import('../../src/routes/releases.js');

const createTestApp = () => {
  const app = express();
  app.use(express.json());
  app.use(releasesRouter);
  return app;
};

/**
 * Mock DB that only records prepared SQL and arguments on each run, facilitating assertions on merge UPSERT behavior.
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
    transaction: (fn: () => number) => fn,
    exec,
  };
  getDbMock.mockReturnValue(db);
  return { statements, db };
}

const sampleRelease = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  tag_name: 'v1',
  name: 'Release 1',
  body: null,
  html_url: 'https://github.com/owner/repo/releases/tag/v1',
  published_at: '2026-01-01T00:00:00.000Z',
  assets: [{ id: 100, name: 'a.dmg', size: 1000 }],
  repository: { id: 10, full_name: 'owner/repo', name: 'repo' },
  ...overrides,
});

describe('PUT /api/releases merge upsert', () => {
  it('preserves existing is_read when release does not carry it explicitly', async () => {
    const { statements } = captureStatements();
    await request(createTestApp())
      .put('/api/releases')
      .send({ releases: [sampleRelease()] })
      .expect(200);

    const sql = statements[0].sql;
    // When is_read is not explicitly provided, the conflict branch must preserve releases.is_read
    expect(sql).toContain('is_read = releases.is_read');
    expect(sql).not.toContain('is_read = excluded.is_read');
    // For new inserts, pass 0 for is_read (unread by default)
    expect(statements[0].params[8]).toBe(0);
  });

  it('overwrites is_read when the release carries it explicitly', async () => {
    const { statements } = captureStatements();
    await request(createTestApp())
      .put('/api/releases')
      .send({ releases: [sampleRelease({ is_read: true })] })
      .expect(200);

    const sql = statements[0].sql;
    expect(sql).toContain('is_read = excluded.is_read');
    expect(statements[0].params[8]).toBe(1);
  });

  it('updates data columns while preserving is_read on conflict', async () => {
    const { statements } = captureStatements();
    await request(createTestApp())
      .put('/api/releases')
      .send({ releases: [sampleRelease({ assets: [{ id: 100, size: 9999 }], name: 'New name' })] })
      .expect(200);

    const sql = statements[0].sql;
    // Data columns should update
    expect(sql).toContain('assets = excluded.assets');
    expect(sql).toContain('name = excluded.name');
    // is_read should be preserved
    expect(sql).toContain('is_read = releases.is_read');
  });

  it('rejects release without a valid positive id', async () => {
    captureStatements();
    await request(createTestApp())
      .put('/api/releases')
      .send({ releases: [{ ...sampleRelease(), id: 0 }] })
      .expect(400);
  });
});
