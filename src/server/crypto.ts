import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "./env";

// Account secrets are encrypted with AES-256-GCM before they reach the
// database. The key lives only in the server's .env (MASTER_KEY, 64 hex chars).

function masterKey(): Buffer {
  const hex = env("MASTER_KEY");
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("MASTER_KEY is missing or invalid in .env (expected 64 hex characters)");
  }
  return Buffer.from(hex, "hex");
}

export function hasMasterKey(): boolean {
  try { masterKey(); return true; } catch { return false; }
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), data.toString("base64")].join(":");
}

export function decryptSecret(sealed: string): string {
  const [version, iv, tag, data] = sealed.split(":");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Unsupported secret format");
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

export function maskKey(value: string): string {
  if (value.length <= 10) return "•".repeat(value.length);
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
