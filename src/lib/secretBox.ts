import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { env } from "../config/env.js";

// Symmetric encryption for real production secrets that must live in Postgres
// (Daraja Consumer Secret / Passkey) rather than a .env file, because they're
// per-location and editable via the app — unlike PIN hashing (lib/hash.ts,
// one-way), these must be recoverable to call Safaricom's API.
//
// AES-256-GCM: SECRETS_ENCRYPTION_KEY (any length string, not necessarily 32
// bytes) is stretched to a 256-bit key with scrypt and a fixed, non-secret
// salt — the key material's secrecy comes entirely from the env var, so a
// fixed salt is fine here (it only needs to make the KDF output the right
// length, not add its own entropy). Ciphertext is stored as
// "<ivHex>:<authTagHex>:<cipherHex>" so nothing else needs its own column.
const KEY = scryptSync(env.SECRETS_ENCRYPTION_KEY, "hotelier-secret-box", 32);

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptSecret(stored: string): string {
  const [ivHex, tagHex, dataHex] = stored.split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("Malformed encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}

/** Last 4 characters only, for showing "a secret is set" without exposing it. */
export function maskSecret(plaintext: string): string {
  const tail = plaintext.slice(-4);
  return `${"*".repeat(Math.max(0, plaintext.length - 4))}${tail}`;
}
