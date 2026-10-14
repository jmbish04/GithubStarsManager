# AI operations

> Part of the workstation briefing. **`~/AGENTS.md` is the parent — read it first**;
> it carries the rules that apply everywhere (secrets, backups, how to write to
> Justin, when to flag). This file adds the rules for **every AI or LLM call**, in any language, runtime, or script. There are no exceptions to this file.

---

# AI operations

**Every AI inference call — every project, every script, every language, every
runtime — goes through core-guardian. No exceptions.** Not "most calls." Not
"production calls." Not "except this one throwaway script." A one-off `curl` to
`api.openai.com`, a Python notebook, a `env.AI.run` in a Worker, a test harness,
a cron job: all of it routes through the guardian or it does not run.

This is not a style preference. A direct provider call is **invisible** to the
budget: it is not metered, it does not count against the cap, it cannot be
attributed to a project, and the kill switch cannot stop it. One unmetered
script is enough to blow the monthly cap silently. If you are about to write a
provider base URL or an SDK client pointed at a provider, stop — you are doing
it wrong.

- **Base:** `https://core-guardian.hacolby.workers.dev`
- **Contract:** [`/openapi.json`](https://core-guardian.hacolby.workers.dev/openapi.json)
  — the live source of truth. Read it rather than trusting this section.
- **Architecture & plan:** [`/docs/architecture`](https://core-guardian.hacolby.workers.dev/docs/architecture)
  — what is real, what was verified against the live Cloudflare API, and which
  assumptions turned out false. Read it before designing anything spend-related.
- **Source:** `/Volumes/Projects/workers/core-guardian`

## Auth — two doors, two different credentials

| Door | Routes | Credential |
|---|---|---|
| **Inference** | `POST /api/ai-router/run` | `Authorization: Bearer <CLOUDFLARE_AI_GATEWAY_TOKEN>` |
| **Admin / management** | `/api/ai/*`, `/api/ai-router/circuits`, `/kill-switch`, `/usage`, `/requests`, `/ollama`, `/recommendations` | `Authorization: Bearer <WORKER_API_KEY>` (guardianAuth; a signed session cookie also works) |

Do not cross the wires — the inference door does an exact compare against
`CLOUDFLARE_AI_GATEWAY_TOKEN` only, and `WORKER_API_KEY` will 401 there.

**Resolve `CLOUDFLARE_AI_GATEWAY_TOKEN` the way you resolve every other secret**
(see "Secrets & credentials" above) — never inline it:

- **In a Worker:** a Secret Store binding. Declare it in `wrangler.jsonc` under
  `secrets_store_secrets` with `binding` and `secret_name` both
  `CLOUDFLARE_AI_GATEWAY_TOKEN`, then `await requireSecret(env, "CLOUDFLARE_AI_GATEWAY_TOKEN")`.
- **In a local script:** `requireSecret("CLOUDFLARE_AI_GATEWAY_TOKEN")` /
  `require_secret("CLOUDFLARE_AI_GATEWAY_TOKEN")` from the scaffolded SDK.
- Verify it first: `tokens find CLOUDFLARE_AI_GATEWAY_TOKEN`.

## Which endpoint

| You are doing | Endpoint |
|---|---|
| **Any inference — default to this** | `POST /api/ai-router/run`. Routes through AI Gateway, metered, circuit-breaker gated. Body: `project`, `importance` (`low`\|`medium`\|`high`), `provider` (now **optional** — omit to route across all providers; still required when a concrete `model` is given), `model`, `input`, optional `task`, `use_case`, `complexity` (`low`\|`medium`\|`high`, **caller-authoritative** — supply it to skip the classifier), `reasoning` (`low`\|`medium`\|`high`), `budgetRange` (`{minUsd?,maxUsd?}`, supersedes the older single `budgetUsd`), `mode` / `stream` / `capabilities` / `repo`. Returns `request_uuid`, `status`, `provider`, `model`, `mode`, `gateway`, `tokens_in`, `tokens_out`, `cost_usd`, `body`, `routing` — or, when routing (no concrete `model`) can't find a candidate inside `budgetRange`, a `422 {status:"no_model_in_budget", lowestAvailable:{provider,model,estCostUsd}, reason}` and nothing runs. |
| Preview a routing decision without spending | `POST /api/ai-router/route`. Same body as `/run` minus execution — dry-run, `Authorization: Bearer <WORKER_API_KEY>` (guardianAuth), no metering. Returns the full `RoutingDecision`: `status`, `provider`, `model`, `tier`, `complexity`, `complexitySource`, `estCostUsd`, `reason[]`, `quotaState[]`, `excluded[]`, optional `lowestAvailable`. |
| Discover routable use cases / models | `GET /api/ai-router/use-cases`. `Authorization: Bearer <WORKER_API_KEY>` (guardianAuth). Returns the curated `use_case` catalog joined to the live model catalog + quota state: `{useCases:[{key,description,capabilityFloor,tags,matchingModels[]}]}`. Docs + live playground at `/docs/ai-router-routing`. |
| A raw provider call with your own key | `POST /api/ai/{provider}/{model}` (`openai` \| `anthropic` \| `google`), key in the `X-Provider-Key` header — never stored. Returns `{ body, cost, spent }`, 429s when the monthly cap is blown. |
| Workers AI | `POST /api/ai/workers-ai/{model}` with a required `origin`. Calling `env.AI.run` directly dumps the neuron spend into the unattributed bucket — route it here so it is traceable. |
| Checking / setting the cap, or stopping everything | `GET`/`PUT /api/ai/budget`, `POST /api/ai/budget/break-glass`, `GET /api/ai-router/circuits`, `POST /api/ai-router/kill-switch` |

## Vendoring the client

`GET /api/integration/instructions` returns the current pull command, `vars` stub,
and required secrets for your language. Worker and Python clients are already
written: `~/.colby-ecosystem/workers/utils/ai.ts` and `python/utils/ai.py`.

---
