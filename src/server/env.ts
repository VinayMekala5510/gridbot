import { existsSync } from "node:fs";
import { resolve } from "node:path";

let loaded = false;

/** Loads `.env` from the project root once. Existing process variables win. */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  const file = resolve(process.cwd(), ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

export function env(name: string): string | undefined {
  loadEnv();
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

export function envInt(name: string, fallback: number): number {
  const raw = env(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}
