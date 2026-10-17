import { describe, expect, it } from "vitest";

import { corsHeaders, DEFAULT_EMBEDDING_MODEL, forwardToGuardian, guardianAttempts, isNoFreeRoute, isProviderRejection, mutable, normalizeUseCase, PAID_FALLBACK_MAX_USD, withEmbeddingModel, type GuardianFetch } from "../src/lib/openaiDoor";

type Call = { path: string; headers: Record<string, string>; body: string };

/** A fake guardian that answers each call from a queue and records what it was sent. */
function fakeGuardian(responses: Array<() => Response>) {
  const calls: Call[] = [];
  const fetch: GuardianFetch = async (path, init) => {
    calls.push({ path, headers: init.headers as Record<string, string>, body: String(init.body) });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected call ${calls.length} to ${path}`);
    return next();
  };
  return { fetch, calls };
}

const args = (fetch: GuardianFetch, useCase: string | null = "rag") => ({
  fetch,
  path: "/v1/chat/completions" as const,
  body: '{"model":"auto","messages":[]}',
  token: "guardian-token",
  project: "github-stars-manager",
  useCase,
});

const noFree = () => new Response(JSON.stringify({ error: { type: "no_free_route", message: "no free model fits" } }), { status: 422 });
const ok = (text = "hello") => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200, headers: { "x-guardian-model": "kimi-k2.6" } });

describe("normalizeUseCase", () => {
  it("keeps a use case guardian routes, ignoring case and spaces", () => {
    expect(normalizeUseCase("rag")).toBe("rag");
    expect(normalizeUseCase(" Agentic ")).toBe("agentic");
  });
  it("maps a missing or unknown value to general", () => {
    expect(normalizeUseCase(undefined)).toBe("general");
    expect(normalizeUseCase("")).toBe("general");
    expect(normalizeUseCase("repo_summary")).toBe("general");
  });
});

describe("guardianAttempts", () => {
  it("asks for free models on the use case, then free on general, then a capped paid fallback", () => {
    const attempts = guardianAttempts({ token: "t", project: "p", useCase: "chat" });
    expect(attempts.map((a) => a.route)).toEqual(["free", "free-general", "paid-fallback"]);
    const [free, general, paid] = attempts;
    expect(general.headers["x-guardian-use-case"]).toBe("general");
    expect(general.headers["x-guardian-free-only"]).toBe("true");
    expect(free.headers["x-guardian-free-only"]).toBe("true");
    expect(free.headers["x-guardian-budget-max-usd"]).toBeUndefined();
    expect(paid.headers["x-guardian-free-only"]).toBeUndefined();
    expect(paid.headers["x-guardian-budget-max-usd"]).toBe(PAID_FALLBACK_MAX_USD);
    for (const attempt of [free, general, paid]) {
      expect(attempt.headers.authorization).toBe("Bearer t");
      expect(attempt.headers["x-guardian-project"]).toBe("p");
    }
    expect(free.headers["x-guardian-use-case"]).toBe("chat");
    expect(paid.headers["x-guardian-use-case"]).toBe("chat");
  });
  it("skips the free-general step when the use case is already general", () => {
    expect(guardianAttempts({ token: "t", project: "p", useCase: "general" }).map((a) => a.route)).toEqual(["free", "paid-fallback"]);
  });
  it("passes a streaming accept header through so SSE stays SSE", () => {
    const [free] = guardianAttempts({ token: "t", project: "p", useCase: null, accept: "text/event-stream" });
    expect(free.headers.accept).toBe("text/event-stream");
  });
});

describe("isNoFreeRoute", () => {
  it("is true only for a 422 that names a missing free or in-budget route", () => {
    expect(isNoFreeRoute(422, '{"error":{"type":"no_free_route"}}')).toBe(true);
    expect(isNoFreeRoute(422, '{"error":{"type":"no_model_in_budget"}}')).toBe(true);
    expect(isNoFreeRoute(422, '{"error":{"type":"unpriceable_model"}}')).toBe(false);
    expect(isNoFreeRoute(429, '{"error":{"type":"no_free_route"}}')).toBe(false);
  });
});

describe("isProviderRejection", () => {
  it("is true only for a 400 that carries the upstream provider's refusal", () => {
    expect(isProviderRejection(400, '{"error":{"message":"Provider returned error","metadata":{"provider_name":"Google AI Studio"}}}')).toBe(true);
    expect(isProviderRejection(400, '{"error":{"message":"embeddings need a concrete model","type":"invalid_request_error"}}')).toBe(false);
    expect(isProviderRejection(500, '{"error":{"message":"Provider returned error"}}')).toBe(false);
  });
});

describe("withEmbeddingModel", () => {
  it("fills in the pgvector model when the app sends none or a router sentinel", () => {
    for (const model of [undefined, "", "auto", "best"]) {
      expect(JSON.parse(withEmbeddingModel(JSON.stringify({ model, input: ["x"] }))).model).toBe(DEFAULT_EMBEDDING_MODEL);
    }
  });
  it("keeps a concrete model and the rest of the body", () => {
    const out = JSON.parse(withEmbeddingModel(JSON.stringify({ model: "openai/text-embedding-3-small", input: ["a", "b"], dimensions: 256 })));
    expect(out).toEqual({ model: "openai/text-embedding-3-small", input: ["a", "b"], dimensions: 256 });
  });
});

describe("mutable", () => {
  it("returns a response whose headers can be set", () => {
    const frozen = Response.redirect("https://example.com/", 302);
    expect(() => frozen.headers.set("x-a", "1")).toThrow();
    const copy = mutable(frozen);
    copy.headers.set("x-a", "1");
    expect(copy.headers.get("x-a")).toBe("1");
    expect(copy.status).toBe(302);
  });
});

describe("forwardToGuardian", () => {
  it("answers from the free attempt and makes exactly one call when a free model fits", async () => {
    const guardian = fakeGuardian([() => ok("free answer")]);
    const response = await forwardToGuardian(args(guardian.fetch));
    expect(guardian.calls).toHaveLength(1);
    expect(guardian.calls[0].headers["x-guardian-free-only"]).toBe("true");
    expect(response.headers.get("x-guardian-route")).toBe("free");
    expect(response.headers.get("x-guardian-model")).toBe("kimi-k2.6");
    expect(((await response.json()) as { choices: Array<{ message: { content: string } }> }).choices[0].message.content).toBe("free answer");
  });

  it("falls through free, then free on general, then the paid cap, sending the same body each time", async () => {
    const guardian = fakeGuardian([noFree, noFree, () => ok("paid answer")]);
    const response = await forwardToGuardian(args(guardian.fetch));
    expect(guardian.calls).toHaveLength(3);
    expect(guardian.calls[1].headers["x-guardian-use-case"]).toBe("general");
    expect(guardian.calls[2].headers["x-guardian-free-only"]).toBeUndefined();
    expect(guardian.calls[2].headers["x-guardian-budget-max-usd"]).toBe(PAID_FALLBACK_MAX_USD);
    expect(new Set(guardian.calls.map((c) => c.body)).size).toBe(1);
    expect(response.headers.get("x-guardian-route")).toBe("paid-fallback");
    expect(((await response.json()) as { choices: Array<{ message: { content: string } }> }).choices[0].message.content).toBe("paid answer");
  });

  it("recovers on the free general route when the provider rejects the free model (the rag/lyria case)", async () => {
    const rejected = () => new Response('{"error":{"message":"Provider returned error","code":400,"metadata":{"provider_name":"Google AI Studio"}}}', { status: 400 });
    const guardian = fakeGuardian([rejected, () => ok("general answer")]);
    const response = await forwardToGuardian(args(guardian.fetch));
    expect(guardian.calls).toHaveLength(2);
    expect(guardian.calls[1].headers["x-guardian-free-only"]).toBe("true");
    expect(response.headers.get("x-guardian-route")).toBe("free-general");
    expect(response.status).toBe(200);
  });

  it("does not retry the door's own invalid request", async () => {
    const guardian = fakeGuardian([() => new Response('{"error":{"message":"embeddings need a concrete model","type":"invalid_request_error"}}', { status: 400 })]);
    const response = await forwardToGuardian(args(guardian.fetch));
    expect(guardian.calls).toHaveLength(1);
    expect(response.status).toBe(400);
  });

  it("does not retry other errors: a 422 for another reason and a 429 go straight back", async () => {
    for (const status of [422, 429]) {
      const guardian = fakeGuardian([() => new Response('{"error":{"type":"kill_switch"}}', { status })]);
      const response = await forwardToGuardian(args(guardian.fetch));
      expect(guardian.calls).toHaveLength(1);
      expect(response.status).toBe(status);
    }
  });

  it("returns the last refusal when every attempt fails, with no extra call", async () => {
    const guardian = fakeGuardian([noFree, noFree, noFree]);
    const response = await forwardToGuardian(args(guardian.fetch));
    expect(guardian.calls).toHaveLength(3);
    expect(response.status).toBe(422);
    expect(response.headers.get("x-guardian-route")).toBe("paid-fallback");
  });

  it("streams the body through unchanged", async () => {
    const sse = "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n";
    const guardian = fakeGuardian([() => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })]);
    const response = await forwardToGuardian({ ...args(guardian.fetch), accept: "text/event-stream" });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe(sse);
  });
});

describe("corsHeaders", () => {
  it("allows the use-case header and exposes the routing result", () => {
    const headers = corsHeaders();
    expect(headers["access-control-allow-headers"]).toContain("x-guardian-use-case");
    expect(headers["access-control-allow-headers"]).toContain("authorization");
    expect(headers["access-control-expose-headers"]).toContain("x-guardian-model");
    expect(headers["access-control-allow-origin"]).toBe("*");
  });
});
