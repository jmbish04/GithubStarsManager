#!/usr/bin/env node
/**
 * Apply drizzle/*.sql to the github_stars database as the owner role.
 *
 * The Worker never migrates at runtime: it connects as github_stars_app through
 * Hyperdrive and has no DDL rights. Migrations run here, before `wrangler deploy`,
 * on a machine on the LAN with LXC 109 (192.168.1.50) and the tokens CLI.
 * Ledger: drizzle's own `drizzle.__drizzle_migrations` table, and nothing else.
 */
import { execFileSync } from "node:child_process";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const host = process.env.GITHUB_STARS_PG_HOST ?? "192.168.1.50";
const password =
  process.env.GITHUB_STARS_PG_OWNER_PASSWORD ??
  execFileSync("tokens", ["show", "GITHUB_STARS_PG_OWNER_PASSWORD", "--value-only"], { encoding: "utf8" }).trim();
if (!password) throw new Error("GITHUB_STARS_PG_OWNER_PASSWORD is empty; check the tokens CLI.");

const sql = postgres({ host, port: 5432, database: "github_stars", username: "github_stars_owner", password, ssl: "require", max: 1, onnotice: () => {} });
try {
  await migrate(drizzle(sql), { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
  const [{ count }] = await sql`select count(*)::int as count from drizzle.__drizzle_migrations`;
  console.log(`migrations applied; ledger rows: ${count}`);
} finally {
  await sql.end();
}
