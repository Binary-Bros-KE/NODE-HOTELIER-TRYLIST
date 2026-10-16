import { env } from "../config/env.js";

// Cloudflare Turnstile: the website form sends the widget's token, and we ask
// Cloudflare whether a real person produced it. Off (always passes) until
// TURNSTILE_SECRET_KEY is set.

export const turnstileEnabled = () => Boolean(env.TURNSTILE_SECRET_KEY);

export async function verifyTurnstile(token: unknown, remoteIp?: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (typeof token !== "string" || token.length < 10 || token.length > 2048) return false;
  try {
    const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, ...(remoteIp ? { remoteip: remoteIp } : {}) });
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body, signal: AbortSignal.timeout(8000) });
    const result = (await res.json()) as { success?: boolean };
    return result.success === true;
  } catch (error) {
    // Cloudflare unreachable: let the request through rather than block every
    // booking — the honeypot and rate limits still apply.
    console.error("Turnstile check failed open:", error instanceof Error ? error.message : error);
    return true;
  }
}
