import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

/**
 * One postgres.js client per request. Hyperdrive pools the real connections,
 * so the Worker side stays small (max 5) and must not be cached across requests.
 */
export function createDb(env: Env): { db: Db; close: () => Promise<void> } {
  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    fetch_types: false, // Hyperdrive: skip the type-catalog round trip.
    prepare: true,
    onnotice: () => {},
  });
  return { db: drizzle(sql, { schema }), close: () => sql.end({ timeout: 5 }) };
}

/**
 * Run a filtered nearest-neighbour query. pgvector's HNSW scan applies WHERE
 * filters after it has collected ef_search (default 40) candidates, so a
 * filtered "top 25" can return fewer rows: measured 13 of 25 on 2026-10-15.
 * Iterative scans (pgvector 0.8) keep scanning until the limit is met.
 */
export async function withVectorScan<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local hnsw.iterative_scan = strict_order`);
    await tx.execute(sql`set local hnsw.ef_search = 200`);
    return fn(tx as unknown as Db);
  });
}
