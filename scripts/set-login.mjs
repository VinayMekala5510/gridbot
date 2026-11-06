#!/usr/bin/env node
// Sets the dashboard login on the server (writes ADMIN_USER / ADMIN_PASSWORD_HASH to .env,
// then restarts the app). Only a scrypt hash of the password is stored.
//
//   node scripts/set-login.mjs            (prompts; password input is hidden)
//   printf 'user\npass\n' | node scripts/set-login.mjs
import { randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");

async function readAnswers() {
  if (!process.stdin.isTTY) {
    const lines = readFileSync(0, "utf8").split(/\r?\n/u);
    return { user: lines[0] ?? "", pass: lines[1] ?? "", confirm: lines[1] ?? "" };
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = (q, hidden = false) => new Promise(resolve => {
    if (hidden) {
      const write = rl._writeToOutput.bind(rl);
      rl._writeToOutput = s => write(s.includes(q) ? s : s.replace(/[^\r\n]/gu, "*"));
      rl.question(q, a => { rl._writeToOutput = write; process.stdout.write("\n"); resolve(a); });
    } else rl.question(q, resolve);
  });
  const user = await ask("Username: ");
  const pass = await ask("Password: ", true);
  const confirm = await ask("Repeat password: ", true);
  rl.close();
  return { user, pass, confirm };
}

const { user, pass, confirm } = await readAnswers();
const username = user.trim();
if (!/^[A-Za-z0-9._@-]{3,100}$/u.test(username)) {
  console.error("Username: 3-100 characters, letters/digits/._@- only");
  process.exit(1);
}
if (pass.length < 10) { console.error("Password must be at least 10 characters"); process.exit(1); }
if (pass !== confirm) { console.error("Passwords do not match"); process.exit(1); }

const salt = randomBytes(16);
const hash = scryptSync(pass, salt, 64, { N: 16384, r: 8, p: 1 });
const value = `scrypt:${salt.toString("base64")}:${hash.toString("base64")}`;

const lines = existsSync(envPath) ? readFileSync(envPath, "utf8").split(/\r?\n/u) : [];
const kept = lines.filter(l => l && !l.startsWith("ADMIN_USER=") && !l.startsWith("ADMIN_PASSWORD_HASH="));
kept.push(`ADMIN_USER=${username}`, `ADMIN_PASSWORD_HASH=${value}`);
writeFileSync(envPath, `${kept.join("\n")}\n`);
chmodSync(envPath, 0o600);
console.log(`Login saved for "${username}". Existing sessions are signed out.`);

try {
  execSync("pm2 restart gridbot --update-env", { stdio: "ignore" });
  console.log("Restarted gridbot.");
} catch {
  console.log("Restart the app to apply (pm2 restart gridbot).");
}
