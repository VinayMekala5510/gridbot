import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { env } from "./env";

// Single-admin login. Credentials live in the server .env:
//   ADMIN_USER=...
//   ADMIN_PASSWORD_HASH=scrypt:<salt b64>:<hash b64>   (set with scripts/set-login.mjs)
// The format avoids "$" because Next.js expands $VARS when it reads .env.
// Sessions are stateless signed cookies, so they survive restarts. Changing the
// password or MASTER_KEY signs everyone out.

const COOKIE = "gridbot_session";
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const failures = new Map<string, { count: number; first: number }>();

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt:${salt.toString("base64")}:${hash.toString("base64")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(actual, expected);
}

function credentials() {
  const user = env("ADMIN_USER");
  const hash = env("ADMIN_PASSWORD_HASH");
  return user && hash ? { user, hash } : null;
}

export function loginConfigured(): boolean {
  return credentials() !== null;
}

function signingKey(): Buffer {
  const creds = credentials();
  return createHash("sha256").update(`gridbot-session|${env("MASTER_KEY") ?? ""}|${creds?.hash ?? ""}`).digest();
}

function sign(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Returns the signed-in username, or null. */
export function sessionUser(req: IncomingMessage): string | null {
  const creds = credentials();
  const token = parseCookies(req)[COOKIE];
  if (!creds || !token) return null;
  const [user64, expires, sig] = token.split(".");
  if (!user64 || !expires || !sig) return null;
  const expected = sign(`${user64}.${expires}`);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  if (Number(expires) < Date.now()) return null;
  const user = Buffer.from(user64, "base64url").toString("utf8");
  return user === creds.user ? user : null;
}

function isHttps(req: IncomingMessage): boolean {
  return req.headers["x-forwarded-proto"] === "https";
}

/** Client IP as seen by nginx (the app itself only listens on 127.0.0.1). */
export function clientIp(req: IncomingMessage): string {
  const real = req.headers["x-real-ip"];
  return (typeof real === "string" && real) || req.socket.remoteAddress || "unknown";
}

export type LoginResult = { ok: true } | { ok: false; status: number; error: string };

export function attemptLogin(req: IncomingMessage, res: ServerResponse, username: string, password: string): LoginResult {
  const creds = credentials();
  if (!creds) return { ok: false, status: 503, error: "Login is not set up on the server yet. Run scripts/set-login.mjs on the server." };
  const ip = clientIp(req);
  const now = Date.now();
  const f = failures.get(ip);
  if (f && now - f.first > LOCK_MS) failures.delete(ip);
  const current = failures.get(ip);
  if (current && current.count >= MAX_FAILURES) {
    const mins = Math.ceil((LOCK_MS - (now - current.first)) / 60000);
    return { ok: false, status: 429, error: `Too many failed attempts. Try again in ${mins} minute(s).` };
  }

  const userOk = username.length === creds.user.length && timingSafeEqual(Buffer.from(username), Buffer.from(creds.user));
  const passOk = verifyPassword(password, creds.hash); // always run, so timing does not reveal the username
  if (!userOk || !passOk) {
    failures.set(ip, { count: (current?.count ?? 0) + 1, first: current?.first ?? now });
    console.warn(`Failed login from ${ip}`);
    return { ok: false, status: 401, error: "Wrong username or password" };
  }
  failures.delete(ip);

  const expires = String(now + SESSION_MS);
  const user64 = Buffer.from(creds.user, "utf8").toString("base64url");
  const token = `${user64}.${expires}.${sign(`${user64}.${expires}`)}`;
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${isHttps(req) ? "; Secure" : ""}`);
  console.log(`Login from ${ip}`);
  return { ok: true };
}

export function clearSession(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isHttps(req) ? "; Secure" : ""}`);
}
