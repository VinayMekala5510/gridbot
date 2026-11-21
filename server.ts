import { setDefaultResultOrder } from "node:dns";
import { createServer } from "node:http";
import { setDefaultAutoSelectFamily } from "node:net";
import next from "next";
import { loadEnv, env, envInt } from "./src/server/env";
import { handleApi } from "./src/server/api";
import { loginConfigured, sessionUser } from "./src/server/auth";
import { BotManager } from "./src/server/engine/manager";
import { MemoryStore } from "./src/server/store/memory";
import { MysqlStore } from "./src/server/store/mysql";
import type { Store } from "./src/server/store/types";

// One process: the bot engine, the JSON/SSE API and the Next.js dashboard.
// Bound to 127.0.0.1 by default; nginx (HTTPS) or an SSH tunnel sits in front.

loadEnv();
// The EC2 server has no IPv6 route. For hosts that publish IPv6 addresses (e.g. api.telegram.org)
// Node raced IPv6/IPv4 with a 250 ms limit per attempt, but connecting to Telegram from AWS
// takes ~170–280 ms, so calls sometimes failed with ETIMEDOUT ("fetch failed").
// Use IPv4 first and give each connection its normal full timeout.
setDefaultResultOrder("ipv4first");
setDefaultAutoSelectFamily(false);
const dev = process.argv.includes("--dev");
const host = env("HOST") ?? "127.0.0.1";
const port = envInt("PORT", 3000);

function createStore(): Store {
  const dbHost = env("DB_HOST");
  if (!dbHost) {
    console.warn("DB_HOST not set — using in-memory storage. Data is lost on restart.");
    return new MemoryStore();
  }
  return new MysqlStore({
    host: dbHost, port: envInt("DB_PORT", 3306), user: env("DB_USER") ?? "gridbot",
    password: env("DB_PASSWORD") ?? "", database: env("DB_NAME") ?? "gridbot",
  });
}

async function main() {
  const store = createStore();
  const manager = new BotManager(store, { tickMs: envInt("TICK_MS", 2000) });
  await manager.init();

  const app = next({ dev, hostname: host, port });
  const handle = app.getRequestHandler();
  await app.prepare();

  const server = createServer((req, res) => {
    // Everything except the login page, its assets and the login API needs a session.
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const isPublic = path === "/login" || path.startsWith("/_next/") || path === "/favicon.ico" || path === "/icon.svg"
      || path === "/api/login" || path === "/api/logout" || path === "/api/health";
    const user = sessionUser(req);
    if (!isPublic && !user) {
      if (path.startsWith("/api/")) {
        res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "Not signed in" }));
      } else {
        res.writeHead(302, { location: "/login", "cache-control": "no-store" });
        res.end();
      }
      return;
    }
    if (path === "/login" && user) {
      res.writeHead(302, { location: "/", "cache-control": "no-store" });
      res.end();
      return;
    }

    handleApi(manager, req, res)
      .then(handled => (handled ? undefined : handle(req, res)))
      .catch(err => {
        console.error(err);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });
  server.listen(port, host, () => {
    console.log(`Gridbot ${dev ? "dev" : "production"} server on http://${host}:${port} (storage: ${store.kind})`);
    if (!loginConfigured()) console.warn("Login is not set up: nobody can sign in until scripts/set-login.mjs is run.");
  });

  const shutdown = (signal: string) => {
    console.log(`${signal}: suspending bots (orders stay on the exchange, bots resume on next start)`);
    manager.shutdown();
    server.close();
    setTimeout(() => store.close().finally(() => process.exit(0)), 1500).unref();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch(err => {
  console.error("Failed to start:", err);
  process.exit(1);
});
