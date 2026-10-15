# github-stars-manager Worker

The Cloudflare Worker backend for GitHub Stars Manager: your stars in Postgres with vector and keyword search, a daily discovery inbox, and research consultations that search GitHub and judge what you can reuse.

- Live: https://github-stars-manager.hacolby.workers.dev
- API reference: `/scalar`, `/swagger`, `/openapi.json`
- MCP: `/mcp` (OAuth 2.1, or `Authorization: Bearer <WORKER_API_KEY>`)
- Health: `/health` (503 when a critical dependency fails)
- Design: `docs/superpowers/specs/2026-10-14-cloudflare-postgres-retrofit-design.md`, and Colby Maestro plan `05f240ca2a74` in project `github-stars-manager`

## Stack

Hono + `@hono/zod-openapi`, Drizzle ORM on postgres.js, Postgres 17 on LXC 109 (`github_stars`) through Hyperdrive, a Cloudflare Workflow for research, `@cloudflare/workers-oauth-provider` plus `agents/mcp` for MCP. Every model call goes through core-guardian's `GuardianRpc` service binding. There is no `ai` binding and no Vectorize index.

## Commands

All from `worker/`. Wrangler authenticates from the tokens CLI:

```bash
export CLOUDFLARE_ACCOUNT_ID="$(tokens show CLOUDFLARE_ACCOUNT_ID --value-only)"
export CLOUDFLARE_API_TOKEN="$(tokens show CLOUDFLARE_WRANGLER_API_TOKEN --value-only)"

pnpm install
pnpm run typecheck        # tsc
pnpm test                 # vitest: pure logic and guards
pnpm run db:generate      # drizzle-kit: SQL from src/db/schema.ts into drizzle/
pnpm run migrate          # apply drizzle/*.sql as github_stars_owner (LAN only)
pnpm run deploy           # typecheck, then wrangler deploy
```

**Migrations run before the deploy, from a machine on the LAN.** The Worker connects as `github_stars_app`, which has DML rights only, so it cannot migrate. `scripts/migrate.mjs` reads `GITHUB_STARS_PG_OWNER_PASSWORD` from the tokens CLI. Indexes Drizzle cannot express (HNSW, BM25) live in `drizzle/0001_search_indexes.sql`.

After a deploy, check the live route, not the build:

```bash
curl -s https://github-stars-manager.hacolby.workers.dev/health
```

## Main routes

| Route | What it does |
|---|---|
| `POST /api/stars/sync` | Mirror stars, fetch some READMEs, embed what changed |
| `POST /api/embeddings/backfill` | Embed stored repositories with no vector |
| `GET /api/search?q=&mode=hybrid` | `semantic` (pgvector), `keyword` (BM25) or `hybrid` (rank fusion) |
| `GET /api/discovery/inbox` | Unread discoveries, best first |
| `POST /api/discovery/read` | Mark items reviewed; they never return |
| `POST /api/discovery/items/{id}/star` | Star on GitHub and mark reviewed |
| `GET/POST/PUT/DELETE /api/interests` | Interest profiles (none = derived from your stars) |
| `POST /api/research` | Consultation: orchestrator + sub-agents search GitHub and your library |
| `POST /api/leverage` | Would these repos help my new or existing repo on this infrastructure? |
| `POST /api/research/{id}/select`, `/leverage` | Narrow a run, then analyze leverage on the selection |
| `POST /api/research/{id}/maestro-export` | Colby Maestro plan + epic + one task per finding |
| `POST /api/maestro/auto-research` | The daily Maestro job now (`dryRun` to preview) |

## Daily cron (13:00 UTC)

1. Star sync (200 READMEs, 500 embeddings at most).
2. Discovery scan (at most 24 GitHub searches; at most 40 inbox items scoring 0.6 or more).
3. Maestro auto-research: up to 3 projects with open tasks. Full run when a plan is new or changed, a new-repositories-only rescan after 7 days, otherwise skipped. Findings with relevance 0.8 or more are exported to Maestro in backlog.

## Limits that protect the bill

`wrangler.jsonc` `vars`: `DAILY_DISCOVERY_LIMIT`, `DISCOVERY_MIN_SCORE`, `DAILY_MAESTRO_PROJECTS`, `RESEARCH_MAX_CANDIDATES`, `RESEARCH_MAX_LLM_CALLS` (12 model calls per research run). Spend itself is enforced by core-guardian.
