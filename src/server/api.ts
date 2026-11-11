import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { EXCHANGE_IDS } from "../shared/exchanges";
import { attemptLogin, clearSession, sessionUser } from "./auth";
import { hasMasterKey } from "./crypto";
import { listSymbols } from "./exchanges/symbols";
import { BotManager, UserError } from "./engine/manager";
import { message } from "./engine/grid";

const MAX_BODY = 32 * 1024;
const decimal = z.string().trim().regex(/^\d+(\.\d+)?$/u, "must be a positive number").max(40);

const accountSchema = z.object({
  name: z.string().trim().max(100).default(""),
  exchange: z.enum(EXCHANGE_IDS),
  publicKey: z.string().trim().min(1).max(255),
  secret: z.string().trim().min(1).max(500),
  passphrase: z.string().max(200).optional(),
});

const botSchema = z.object({
  name: z.string().trim().min(1).max(60),
  exchange: z.enum(EXCHANGE_IDS),
  mode: z.enum(["paper", "live"]),
  accountId: z.number().int().positive().nullable(),
  symbol: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9._/-]+$/u, "letters, digits, - / . _ only"),
  spread: decimal,
  targetSpread: decimal,
  steps: z.number().int().min(1).max(100),
  stepQty: decimal,
  mmQty: decimal,
  upperLimit: decimal,
  lowerLimit: decimal,
  entryPrice: decimal,
});

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new UserError("Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new UserError("Invalid JSON"); }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new UserError(`${issue.path.join(".") || "input"}: ${issue.message}`);
  }
  return result.data;
}

/** Handles /api/* requests. Returns false when the path is not an API route. */
export async function handleApi(manager: BotManager, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/")) return false;
  const method = req.method ?? "GET";

  try {
    // Mutations need a custom header: browsers cannot send it cross-site without a CORS preflight we never allow.
    if (method !== "GET" && req.headers["x-gridbot"] !== "1") return send(res, 403, { error: "Missing x-gridbot header" }), true;

    const path = url.pathname;
    let m: RegExpMatchArray | null;

    if (method === "GET" && path === "/api/snapshot") return send(res, 200, await manager.snapshot()), true;

    if (method === "GET" && path === "/api/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      const push = async () => {
        try { res.write(`data: ${JSON.stringify(await manager.snapshot())}\n\n`); } catch { /* client gone */ }
      };
      await push();
      const timer = setInterval(push, 1000);
      req.on("close", () => clearInterval(timer));
      return true;
    }

    if (method === "POST" && path === "/api/login") {
      const body = parse(z.object({ username: z.string().max(100), password: z.string().max(200) }), await readJson(req));
      const result = attemptLogin(req, res, body.username, body.password);
      return send(res, result.ok ? 200 : result.status, result.ok ? { ok: true } : { error: result.error }), true;
    }

    if (method === "POST" && path === "/api/logout") {
      clearSession(req, res);
      return send(res, 200, { ok: true }), true;
    }

    if (method === "GET" && path === "/api/me") {
      return send(res, 200, { user: sessionUser(req) }), true;
    }

    if (method === "GET" && path === "/api/health") {
      return send(res, 200, { ok: true, masterKey: hasMasterKey() }), true;
    }

    if (method === "GET" && path === "/api/symbols") {
      const exchange = parse(z.enum(EXCHANGE_IDS), url.searchParams.get("exchange"));
      try {
        return send(res, 200, { symbols: await listSymbols(exchange) }), true;
      } catch (err) {
        throw new UserError(`Could not load the symbol list: ${message(err)}`);
      }
    }

    if (method === "GET" && path === "/api/price") {
      const exchange = parse(z.enum(EXCHANGE_IDS), url.searchParams.get("exchange"));
      const symbol = parse(z.string().trim().min(1).max(40), url.searchParams.get("symbol"));
      return send(res, 200, { price: await manager.price(exchange, symbol) }), true;
    }

    if (method === "POST" && path === "/api/accounts") {
      if (!hasMasterKey()) throw new UserError("Server MASTER_KEY is not configured — accounts cannot be stored securely");
      const account = await manager.createAccount(parse(accountSchema, await readJson(req)));
      return send(res, 201, account), true;
    }

    if (method === "DELETE" && (m = path.match(/^\/api\/accounts\/(\d+)$/u))) {
      await manager.deleteAccount(Number(m[1]));
      return send(res, 200, { ok: true }), true;
    }

    if (method === "POST" && path === "/api/bots") {
      const id = await manager.createBot(parse(botSchema, await readJson(req)));
      return send(res, 201, { id }), true;
    }

    if (method === "GET" && (m = path.match(/^\/api\/bots\/(\d+)\/roundtrips$/u))) {
      return send(res, 200, { roundtrips: await manager.roundtrips(Number(m[1])) }), true;
    }

    if (method === "POST" && (m = path.match(/^\/api\/bots\/(\d+)\/stop$/u))) {
      await manager.stopBot(Number(m[1]));
      return send(res, 200, { ok: true }), true;
    }

    if (method === "POST" && (m = path.match(/^\/api\/bots\/(\d+)\/archive$/u))) {
      await manager.archiveBot(Number(m[1]));
      return send(res, 200, { ok: true }), true;
    }

    if (method === "POST" && path === "/api/kill-all") {
      return send(res, 200, await manager.killAll()), true;
    }

    return send(res, 404, { error: "Not found" }), true;
  } catch (err) {
    if (err instanceof UserError) return send(res, 400, { error: err.message }), true;
    console.error(`API ${method} ${url.pathname} failed:`, err);
    return send(res, 500, { error: `Server error: ${message(err)}` }), true;
  }
}
