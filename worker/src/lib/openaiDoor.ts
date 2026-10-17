/**
 * OpenAI-compatible door for the desktop app: /v1/chat/completions, /v1/embeddings, /v1/models.
 *
 * The app sends a normal OpenAI request with `Authorization: Bearer <passcode>` and an optional
 * `x-guardian-use-case` header. This module forwards it to core-guardian's own /v1 routes over the
 * GUARDIAN_HTTP service binding, adding the routing headers guardian reads:
 *   x-guardian-project    this Worker's GUARDIAN_PROJECT
 *   x-guardian-use-case   the app's value if guardian knows it, else "general"
 *   x-guardian-free-only  "true" on the first attempt
 * Attempts, in order, stopping at the first that is not a retryable refusal:
 *   1. free-only, the app's use case
 *   2. free-only, use case "general" (only when 1 was not already general). This covers a free route
 *      that picks a model the provider then rejects: measured 2026-10-17, use case "rag" routed every
 *      time to openrouter/google/lyria-3-pro-preview, a music model, which answers 400.
 *   3. no free-only, a small budget cap, the app's use case
 * A retryable refusal is a 422 saying no free or in-budget model fits, or a 400 the upstream
 * provider returned. Auth errors, 429s and the door's own 400s go straight back.
 * The guardian token stays in the Secret Store; the app only ever holds the passcode.
 */

/** Use cases core-guardian routes (GET /api/ai-router/use-cases, measured 2026-10-17). */
export const GUARDIAN_USE_CASES = ["general", "chat", "rag", "agentic", "coding", "web_search", "deep_research", "image_editing"] as const;
export type GuardianUseCase = (typeof GUARDIAN_USE_CASES)[number];

/** Paid fallback ceiling per request when no free model fits. */
export const PAID_FALLBACK_MAX_USD = "0.01";

/** Response headers worth showing to the app (routing result and cost). */
export const EXPOSED_HEADERS = ["x-guardian-provider", "x-guardian-model", "x-guardian-cost-usd", "x-request-uuid", "x-guardian-route"];

export function normalizeUseCase(value: string | null | undefined): GuardianUseCase {
  const candidate = (value ?? "").trim().toLowerCase();
  return (GUARDIAN_USE_CASES as readonly string[]).includes(candidate) ? (candidate as GuardianUseCase) : "general";
}

export interface GuardianAttempt {
  headers: Record<string, string>;
  route: "free" | "free-general" | "paid-fallback";
}

/** The header sets for each attempt, in order (see the module comment). */
export function guardianAttempts(input: { token: string; project: string; useCase: string | null | undefined; accept?: string | null }): GuardianAttempt[] {
  const useCase = normalizeUseCase(input.useCase);
  const base: Record<string, string> = {
    authorization: `Bearer ${input.token}`,
    "content-type": "application/json",
    accept: input.accept || "application/json",
    "x-guardian-project": input.project,
    "x-guardian-use-case": useCase,
    "x-guardian-importance": "low",
  };
  const attempts: GuardianAttempt[] = [{ route: "free", headers: { ...base, "x-guardian-free-only": "true" } }];
  if (useCase !== "general") attempts.push({ route: "free-general", headers: { ...base, "x-guardian-use-case": "general", "x-guardian-free-only": "true" } });
  attempts.push({ route: "paid-fallback", headers: { ...base, "x-guardian-budget-max-usd": PAID_FALLBACK_MAX_USD } });
  return attempts;
}

/** True when guardian refused the free attempt only because no free model fits. */
export function isNoFreeRoute(status: number, bodyText: string): boolean {
  if (status !== 422) return false;
  return /no_free_route|no_model_in_budget/.test(bodyText);
}

/** True when the routed provider rejected the request (guardian relays it as a 400 with provider metadata). */
export function isProviderRejection(status: number, bodyText: string): boolean {
  return status === 400 && /Provider returned error|provider_name|provider_error_code/.test(bodyText);
}

/** Default embedding model: the same 384-dimension model the Worker stores in pgvector. */
export const DEFAULT_EMBEDDING_MODEL = "workers-ai/@cf/baai/bge-small-en-v1.5";

/** Guardian needs a concrete embedding model; fill it in when the app sends none or a router sentinel. */
export function withEmbeddingModel(bodyText: string): string {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return bodyText;
  }
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!model || ["auto", "best", "budget", "cheapest"].includes(model)) body.model = DEFAULT_EMBEDDING_MODEL;
  return JSON.stringify(body);
}

export type GuardianFetch = (path: string, init: RequestInit) => Promise<Response>;

/**
 * Forward one OpenAI request to guardian. Returns guardian's response unchanged (streaming bodies
 * pass straight through), plus an `x-guardian-route` header saying which attempt answered.
 */
export async function forwardToGuardian(args: {
  fetch: GuardianFetch;
  path: "/v1/chat/completions" | "/v1/embeddings";
  body: string;
  token: string;
  project: string;
  useCase: string | null | undefined;
  accept?: string | null;
}): Promise<Response> {
  const attempts = guardianAttempts(args);
  let last: Response | undefined;
  for (const [index, attempt] of attempts.entries()) {
    const response = await args.fetch(args.path, { method: "POST", headers: attempt.headers, body: args.body });
    if (index < attempts.length - 1 && (response.status === 422 || response.status === 400)) {
      const text = await response.clone().text();
      if (isNoFreeRoute(response.status, text) || isProviderRejection(response.status, text)) {
        last = response;
        continue;
      }
    }
    return withRoute(response, attempt.route);
  }
  return withRoute(last!, attempts[attempts.length - 1].route);
}

/** A copy with mutable headers (responses from fetch have immutable headers). */
export function mutable(response: Response): Response {
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: new Headers(response.headers) });
}

function withRoute(response: Response, route: GuardianAttempt["route"]): Response {
  const headers = new Headers(response.headers);
  headers.set("x-guardian-route", route);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** CORS for the desktop app (file:// origin) and browsers. Bearer auth only, so no credentials. */
export function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, accept, x-api-key, x-guardian-use-case",
    "access-control-expose-headers": EXPOSED_HEADERS.join(", "),
    "access-control-max-age": "86400",
  };
}
