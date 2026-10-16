import { env } from "../config/env.js";

// Cloudflare for SaaS: clients' own domains (www.example.com) CNAME to
// SITE_CNAME_TARGET; registering them as "custom hostnames" makes Cloudflare
// issue and renew their certificates and proxy them to our origin.
// Credentials are written to .env by WEBSITE/scripts/setup-site-hosting.sh.

const API = "https://api.cloudflare.com/client/v4";

export const cloudflareConfigured = () => Boolean(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ZONE_ID);

type CfResponse<T> = { success: boolean; errors?: { code: number; message: string }[]; result: T };

async function cf<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}/zones/${env.CLOUDFLARE_ZONE_ID}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({ success: false }))) as CfResponse<T>;
  if (!res.ok || !body.success) {
    const message = body.errors?.map((e) => e.message).join("; ") || `Cloudflare answered ${res.status}`;
    throw Object.assign(new Error(message), { cloudflareCodes: body.errors?.map((e) => e.code) ?? [] });
  }
  return body.result;
}

export type CustomHostname = {
  id: string;
  hostname: string;
  status: string; // "active" once Cloudflare sees the CNAME
  ssl?: { status?: string; validation_errors?: { message: string }[] };
  verification_errors?: string[];
};

async function findCustomHostname(hostname: string): Promise<CustomHostname | null> {
  const list = await cf<CustomHostname[]>(`/custom_hostnames?hostname=${encodeURIComponent(hostname)}`);
  return list.find((h) => h.hostname === hostname) ?? null;
}

/** Registers the hostname (once) and returns its current state. */
export async function ensureCustomHostname(hostname: string): Promise<CustomHostname> {
  const existing = await findCustomHostname(hostname);
  if (existing) return existing;
  return cf<CustomHostname>("/custom_hostnames", {
    method: "POST",
    body: JSON.stringify({ hostname, ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } } }),
  });
}

export async function removeCustomHostname(hostname: string): Promise<void> {
  const existing = await findCustomHostname(hostname);
  if (existing) await cf(`/custom_hostnames/${existing.id}`, { method: "DELETE" });
}

/** Live = Cloudflare routes it and its certificate is issued. */
export function customHostnameLive(h: CustomHostname): boolean {
  return h.status === "active" && h.ssl?.status === "active";
}

/** A plain-language reason the hostname isn't live yet. */
export function customHostnameWaiting(h: CustomHostname): string {
  const problem = h.verification_errors?.[0] ?? h.ssl?.validation_errors?.[0]?.message;
  if (problem) return `Cloudflare: ${problem}`;
  if (h.status !== "active") return `Waiting for the CNAME to point at ${env.SITE_CNAME_TARGET ?? "our address"} — DNS changes can take up to an hour`;
  return "Issuing the certificate — usually a few minutes";
}
