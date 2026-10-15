/**
 * Every model call goes through core-guardian's `GuardianRpc` service binding:
 * chat through `run()`, embeddings through `workersAi()`. The binding is the
 * trust boundary, so no key travels with the call.
 *
 * `run()` returns `{ status, body }` where `body` is the guardian ENVELOPE and
 * the OpenAI chat completion is one level further down (`body.body.choices`).
 * The envelope's status wins: a provider 404 arrives as `{ status: 200, body: {
 * status: 404 } }`. Measured in core-sg-data, 2026-09-26.
 */

export interface GuardianRpcSurface {
  run(payload: unknown): Promise<{ status?: number; body?: GuardianEnvelope; stream?: Response }>;
  workersAi(
    model: string,
    origin: string,
    input: unknown,
    opts?: { taskDescription?: string; operationId?: string },
  ): Promise<{ ok: true; status: 200; body: unknown; costUsd: number; neurons: number } | { ok: false; status: number; error: string }>;
}

interface GuardianEnvelope {
  status?: number;
  provider?: string;
  model?: string;
  cost_usd?: number;
  body?: { choices?: Array<{ message?: { content?: string | null } }> };
}

export class GuardianError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface ChatResult {
  text: string;
  model: string;
  costUsd: number;
}

const ORIGIN = "github-stars-manager";

function guardian(env: Env): GuardianRpcSurface {
  return env.GUARDIAN as unknown as GuardianRpcSurface;
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export async function chat(
  env: Env,
  messages: ChatMessage[],
  opts: { useCase?: string; importance?: "low" | "medium" | "high"; complexity?: "low" | "medium" | "high"; task?: string; repo?: string } = {},
): Promise<ChatResult> {
  const result = await guardian(env).run({
    project: env.GUARDIAN_PROJECT,
    importance: opts.importance ?? "medium",
    use_case: opts.useCase ?? "analysis",
    complexity: opts.complexity,
    task: opts.task,
    repo: opts.repo,
    input: { messages },
  });
  const envelope = result.body;
  const status = envelope?.status ?? result.status ?? 500;
  if (status !== 200 || !envelope) {
    throw new GuardianError(`core-guardian refused the call (status ${status}): ${JSON.stringify(envelope ?? {}).slice(0, 300)}`, status);
  }
  const text = envelope.body?.choices?.[0]?.message?.content ?? "";
  if (!text) throw new GuardianError("core-guardian returned no assistant message", 502);
  return { text, model: envelope.model ?? "unknown", costUsd: envelope.cost_usd ?? 0 };
}

/** Parse the first JSON object or array in a model answer (models wrap JSON in prose or fences). */
export function parseJsonAnswer<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start < 0) throw new Error("model answer contains no JSON");
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  const end = candidate.lastIndexOf(close);
  if (end <= start) throw new Error("model answer contains unterminated JSON");
  return JSON.parse(candidate.slice(start, end + 1)) as T;
}

/** Ask for JSON and parse it; one call, no retry loop. */
export async function chatJson<T extends object>(env: Env, messages: ChatMessage[], opts: Parameters<typeof chat>[2] = {}): Promise<T & { _meta: ChatResult }> {
  const result = await chat(env, messages, opts);
  return Object.assign(parseJsonAnswer<T>(result.text), { _meta: result });
}

const EMBED_BATCH = 50;

/** Embed texts with bge-small (384 dims) through the guardian. Throws on any non-200. */
export async function embed(env: Env, texts: string[], taskDescription: string): Promise<number[][]> {
  const out: number[][] = [];
  const expected = Number(env.EMBEDDING_DIMENSIONS);
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const result = await guardian(env).workersAi(env.EMBEDDING_MODEL, `${ORIGIN}:embed`, { text: batch }, { taskDescription });
    if (!result.ok) throw new GuardianError(`guardian embed failed: ${result.error.slice(0, 300)}`, result.status);
    const data = (result.body as { data?: unknown })?.data;
    if (!Array.isArray(data) || data.length !== batch.length) throw new GuardianError("guardian embed returned no usable data", 502);
    for (const vector of data as number[][]) {
      if (!Array.isArray(vector) || vector.length !== expected) {
        throw new GuardianError(`embedding has ${Array.isArray(vector) ? vector.length : "no"} dims, expected ${expected}`, 502);
      }
      out.push(vector);
    }
  }
  return out;
}
