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
