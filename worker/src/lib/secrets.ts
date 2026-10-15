/**
 * Secret Store bindings are objects (`await env.NAME.get()`), not strings.
 * In `wrangler dev` with `.dev.vars` the same name is a plain string, so read
 * both shapes here and nowhere else.
 */
type SecretBinding = { get(): Promise<string> };

export type SecretName = "WORKER_API_KEY" | "GH_TOKEN" | "CLOUDFLARE_AI_GATEWAY_TOKEN";

function isSecretBinding(value: unknown): value is SecretBinding {
  return Boolean(value) && typeof value === "object" && typeof (value as SecretBinding).get === "function";
}

export async function getSecret(env: Env, name: SecretName): Promise<string> {
  const value: unknown = (env as unknown as Record<string, unknown>)[name];
  if (typeof value === "string") return value;
  if (isSecretBinding(value)) return (await value.get()) ?? "";
  return "";
}

/** A secret the caller cannot work without: missing is an error, never "". */
export async function requireSecret(env: Env, name: SecretName): Promise<string> {
  const value = await getSecret(env, name);
  if (!value) throw new Error(`${name} is not bound. Add it under secrets_store_secrets in wrangler.jsonc.`);
  return value;
}
