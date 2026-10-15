<!-- BEGIN colby-ecosystem: managed by pull-agents, do not edit inside this block -->
## Machine-wide agent briefings (synced — do not edit here)

Pulled from `jmbish04/colby-ecosystem` by `.github/workflows/agents-sync.yml`, right-sized to this
repo's stack. Read them before your first load-bearing change; where they and the
notes below this block disagree, they win. Edit them in `jmbish04/colby-ecosystem`, never here.

@.agents/ecosystem/AGENTS.md
@.agents/ecosystem/AGENTS-maestro.md
@.agents/ecosystem/AGENTS-github.md
@.agents/ecosystem/AGENTS-cloudflare-workers.md
@.agents/ecosystem/AGENTS-frontend.md
@.agents/ecosystem/AGENTS-mcp.md
@.agents/ecosystem/AGENTS-ai.md

The scripts in `scripts/` carrying a `colby-ecosystem: managed script` banner come from there too.
Use them rather than writing another: `scripts/gh.mjs` is the GitHub entry point
and wraps the `gh-tools` CLI, which already solves the auth this machine trips on.

Work is tracked in **colby-maestro** (`https://colby-maestro.hacolby.workers.dev/mcp`,
bearer `$(tokens show WORKER_API_KEY --value-only)`) — never in this repo and never
in colby-ecosystem, which only stores config. Refresh this block with
`.agents/ecosystem/pull-agents`.
<!-- END colby-ecosystem -->

# GithubStarsManager

Repo-local agent notes go below the block above.

## Backend: the `worker/` Cloudflare Worker (since 2026-10-14)

- The live backend is `worker/` (`github-stars-manager`), on Postgres `github_stars` (LXC 109) through Hyperdrive `b4a044ba931849f8a74ca3ad3cf29df5`. Read `worker/README.md` first.
- Vectors are pgvector (384 dims, bge-small through core-guardian) and keyword search is pg_textsearch BM25. Do not add Vectorize or an `ai` binding.
- `cloudflare-worker/` (the old Vectorize proxy) and `server/` (Express + SQLite) are legacy, kept until the React app is pointed at the Worker (Maestro task `c94658981e62`).
- Migrations: `cd worker && pnpm run migrate` from the LAN, before `pnpm run deploy`. The runtime role cannot run DDL.
- Locale files under `src/locales/zh`, `zh-TW` and `ja` are real translations. Keep them. Everything else is US English.
- Frontend retrofit question is open: `docs/decisions/2026-10-15-frontend-reui-retrofit.md`.
