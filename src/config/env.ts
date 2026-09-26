import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  CORS_ORIGIN: z.string().min(1).default("http://localhost:5173"),
  APP_DOMAIN: z.string().trim().min(1).optional(),
  // Bootstrap credentials for the first platform admin account, consumed
  // only by `npm run seed:platform-admin` (see that script). The running
  // app never reads these — platform admins authenticate against
  // PlatformAdmin rows via email + password.
  PLATFORM_ADMIN_EMAIL: z.string().trim().toLowerCase().email().optional(),
  PLATFORM_ADMIN_PASSWORD: z.string().min(8).optional(),
  PLATFORM_ADMIN_NAME: z.string().trim().min(1).optional(),
  // Encrypts per-location M-Pesa Daraja secrets at rest (lib/secretBox.ts) —
  // any long random string; changing it makes existing encrypted rows
  // unreadable, so treat it like a database credential, not a rotatable key.
  SECRETS_ENCRYPTION_KEY: z.string().min(16, "SECRETS_ENCRYPTION_KEY must be at least 16 characters"),
  // The API's own public origin (e.g. https://server.hoteliermanagement.app) — deliberately
  // separate from APP_DOMAIN, which is the tenant-subdomain wildcard for CORS, not necessarily
  // where this server itself is reachable. Used to build the M-Pesa STK callback URL Safaricom
  // posts results to; optional because a dev box normally has no public URL to give it at all.
  MPESA_CALLBACK_BASE_URL: z.string().trim().url().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment variables");
}

export const env = {
  ...parsed.data,
  // Comma-separated so more than one dev server (REACT on :5173/:5174, the
  // standalone platform admin app on its own port) can all be allowed in
  // local development without needing APP_DOMAIN wildcard matching.
  CORS_ORIGINS: parsed.data.CORS_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean),
};
export type Env = typeof env;
