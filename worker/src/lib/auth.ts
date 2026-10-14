/**
 * One gate for every door: `Authorization: Bearer <WORKER_API_KEY>`, `x-api-key`,
 * or the signed `gsm_session` cookie set by the passcode page. MCP clients use
 * OAuth (see mcp.ts), whose grant is also unlocked with the same passcode.
 *
 * The cookie holds `<expiry>.<hmac>` signed with WORKER_API_KEY, never the key.
 * Rotating the key signs every browser out at once.
 */
import { getSecret } from "./secrets";

export const SESSION_COOKIE = "gsm_session";
export const SESSION_MAX_AGE_SECONDS = 400 * 24 * 60 * 60; // the browser ceiling (RFC 6265bis)

const encoder = new TextEncoder();

/** Constant-time string compare (length leak only). */
export function safeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

async function hmacHex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createSessionToken(apiKey: string, nowMs = Date.now()): Promise<string> {
  const expires = Math.floor(nowMs / 1000) + SESSION_MAX_AGE_SECONDS;
  return `${expires}.${await hmacHex(apiKey, `session:${expires}`)}`;
}

export async function verifySessionToken(apiKey: string, token: string, nowMs = Date.now()): Promise<boolean> {
  const [expiresText, signature] = token.split(".");
  const expires = Number(expiresText);
  if (!signature || !Number.isFinite(expires) || expires * 1000 < nowMs) return false;
  return safeEqual(signature, await hmacHex(apiKey, `session:${expires}`));
}

export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax; Path=/`;
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/** The presented API key from `Authorization: Bearer` or `x-api-key`, or null. */
export function presentedKey(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return request.headers.get("x-api-key");
}

export async function isAuthenticated(env: Env, request: Request): Promise<boolean> {
  const apiKey = await getSecret(env, "WORKER_API_KEY");
  if (!apiKey) return false; // Missing key is a refusal, never an open door.
  const key = presentedKey(request);
  if (key && safeEqual(key, apiKey)) return true;
  const cookie = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  return cookie ? verifySessionToken(apiKey, cookie) : false;
}
