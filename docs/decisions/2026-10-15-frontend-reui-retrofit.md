# Frontend: ReUI retrofit of the React app

- **Date:** 2026-10-15
- **Status:** Open (asked once, per AGENTS-frontend.md)
- **Maestro:** project `github-stars-manager`, task `d94adfa14153` (Phase 3), plan `05f240ca2a74`

## What happened

The backend retrofit is done: a Cloudflare Worker on Postgres (Phase 1). The React app in `src/` is still the upstream Vite SPA: about 113,000 lines, Radix primitives, raw Tailwind palette classes, no `@reui` registry, and it talks to the old Express/SQLite server and computes embeddings in the browser.

## Why it matters

The new features (discovery inbox, research runs, leverage results, Maestro export) have an API and an MCP surface today, but no screen. The frontend standard requires ReUI (Astro + React, Base UI `base-nova`, Data Grid, dark default) for new screens, and this app has not adopted it.

## The question

How should the frontend be retrofitted?

## Options

1. **Audit, then a plan on Maestro, then build (recommended).** A read-only audit of every page, component and token; epics and tasks filed under Phase 3; nothing changes until you approve the plan. The new screens are built first, in a new ReUI app on the Worker, and the old SPA screens move over one at a time.
2. **New screens only.** Build the discovery, research and leverage screens in ReUI as a separate app on the Worker; leave the existing SPA as it is.
3. **No frontend work.** Record the decline in the repo's `AGENTS.md`; use the API, Scalar and MCP.

## Default if there is no answer

Option 1, audit and plan only: read-only work, filed on Maestro, no code changes until approved.

## Decision

(empty)
