import { createServer } from "node:http";
import next from "next";
import { loadEnv, env, envInt } from "./src/server/env";
import { handleApi } from "./src/server/api";
import { BotManager } from "./src/server/engine/manager";
import { MemoryStore } from "./src/server/store/memory";
import { MysqlStore } from "./src/server/store/mysql";
import type { Store } from "./src/server/store/types";

// One process: the bot engine, the JSON/SSE API and the Next.js dashboard.
// Bound to 127.0.0.1 by default — reach it through an SSH tunnel.

loadEnv();
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
