import Decimal from "decimal.js";
import { createHmac } from "node:crypto";
import type { Side } from "../../shared/types";
import { fetchPrice } from "./prices";
import type { AccountClient, CancelResult, ExchangeAdapter, ExchangeFill, PlaceRequest, TrackedOrder } from "./types";

// Binance Spot adapter: GTC limit orders, fills from /myTrades, HMAC-SHA256 signed requests.

const BASE = "https://api.binance.com";
const TIMEOUT_MS = 10_000;
const INFO_TTL_MS = 10 * 60_000;
const FILL_POLL_MS = 3_000;
const FILL_BUFFER_MS = 30 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export class BinanceError extends Error {
  constructor(message: string, readonly code: number | null, readonly status: number) { super(message); }
}

export function binanceSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase().replace(/[-/ _]/gu, "");
  return /(USDT|USDC|FDUSD|TUSD|BTC|ETH|BNB|EUR|TRY)$/u.test(s) && s.length > 4 ? s : `${s}USDT`;
}

export function validateBinanceKey(apiKey: string, secret: string): { apiKey: string; secret: string } {
  const k = apiKey.trim(), s = secret.trim();
  if (!/^[A-Za-z0-9]{40,128}$/u.test(k)) throw new Error("Binance API key should be 40–128 letters and digits");
  if (!/^[A-Za-z0-9]{40,128}$/u.test(s)) throw new Error("Binance API secret should be 40–128 letters and digits (HMAC keys only)");
  return { apiKey: k, secret: s };
}

/** Rounds `value` to a multiple of `step` (Binance tick/step filters). */
export function toStep(value: Decimal, step: Decimal, mode: Decimal.Rounding): Decimal {
  if (step.lte(0)) return value;
  return value.div(step).toDecimalPlaces(0, mode).times(step);
}

async function publicGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const b = body as { code?: number; msg?: string };
    throw new BinanceError(`Binance ${res.status}: ${b.msg ?? "request failed"}`, b.code ?? null, res.status);
  }
  return body;
}

interface SymbolRules { symbol: string; base: string; quote: string; tick: Decimal; step: Decimal; minQty: Decimal; minNotional: Decimal }
const rulesCache = new Map<string, { at: number; rules: Promise<SymbolRules> }>();

export function symbolRules(symbol: string): Promise<SymbolRules> {
  const pair = binanceSymbol(symbol);
  const hit = rulesCache.get(pair);
  if (hit && Date.now() - hit.at < INFO_TTL_MS) return hit.rules;
  const load = (async () => {
    let info: { symbols?: { symbol: string; status: string; baseAsset: string; quoteAsset: string; filters: Record<string, string>[] }[] };
    try {
      info = await publicGet(`/api/v3/exchangeInfo?symbol=${encodeURIComponent(pair)}`) as typeof info;
    } catch (err) {
      if (err instanceof BinanceError && err.code === -1121) throw new Error(`${pair} is not a Binance spot pair`);
      throw err;
    }
    const s = info.symbols?.[0];
    if (!s) throw new Error(`${pair} is not a Binance spot pair`);
    if (s.status !== "TRADING") throw new Error(`${pair} is not trading on Binance (status ${s.status})`);
    const f = (type: string) => s.filters.find(x => x.filterType === type);
    return {
      symbol: pair, base: s.baseAsset, quote: s.quoteAsset,
      tick: new Decimal(f("PRICE_FILTER")?.tickSize ?? "0"),
      step: new Decimal(f("LOT_SIZE")?.stepSize ?? "0"),
      minQty: new Decimal(f("LOT_SIZE")?.minQty ?? "0"),
      minNotional: new Decimal(f("NOTIONAL")?.minNotional ?? f("MIN_NOTIONAL")?.minNotional ?? "0"),
    };
  })();
  rulesCache.set(pair, { at: Date.now(), rules: load });
  load.catch(() => rulesCache.delete(pair));
  return load;
}

function plain(value: Decimal): string {
  const s = value.toFixed();
  return s.includes(".") ? s.replace(/0+$/u, "").replace(/\.$/u, "") : s;
}

interface BnTrade {
  id: number; orderId: number; price: string; qty: string; commission: string; commissionAsset: string;
  time: number; isBuyer: boolean;
}

/** One per saved Binance account: signs requests and shares trade polling across its bots. */
export class BinanceAccount implements AccountClient {
  private offset = 0;
  private offsetAt = 0;
  private trades = new Map<string, { trades: Map<number, BnTrade>; start: number; lastPoll: number; polling: Promise<void> | null }>();

  constructor(private readonly apiKey: string, private readonly secret: string) {}

  private async serverOffset(): Promise<number> {
    if (Date.now() - this.offsetAt > 10 * 60_000) {
      try {
        const { serverTime } = await publicGet("/api/v3/time") as { serverTime: number };
        this.offset = serverTime - Date.now();
      } catch { /* keep the last offset */ }
      this.offsetAt = Date.now();
    }
    return this.offset;
  }

  async signed(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, string | number> = {}): Promise<unknown> {
    const timestamp = Date.now() + await this.serverOffset();
    const query = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), recvWindow: "10000", timestamp: String(timestamp) }).toString();
    const signature = createHmac("sha256", this.secret).update(query).digest("hex");
    const res = await fetch(`${BASE}${path}?${query}&signature=${signature}`, {
      method, headers: { "X-MBX-APIKEY": this.apiKey }, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const b = body as { code?: number; msg?: string };
      if (res.status === 451) throw new BinanceError("Binance refused requests from the server's location", b.code ?? null, 451);
      throw new BinanceError(`Binance: ${b.msg ?? `HTTP ${res.status}`}`, b.code ?? null, res.status);
    }
    return body;
  }

  async balances(): Promise<Map<string, Decimal>> {
    const acct = await this.signed("GET", "/api/v3/account", { omitZeroBalances: "true" }) as { balances: { asset: string; free: string }[] };
    return new Map(acct.balances.map(b => [b.asset, new Decimal(b.free)]));
  }

  /** Trades for `pair` at or after `since`, polled at most every few seconds per pair. */
  async tradesSince(pair: string, since: number): Promise<BnTrade[]> {
    let entry = this.trades.get(pair);
    if (!entry) {
      entry = { trades: new Map(), start: Number.POSITIVE_INFINITY, lastPoll: 0, polling: null };
      this.trades.set(pair, entry);
    }
    const e = entry;
    const backfill = since < e.start;
    if (backfill || Date.now() - e.lastPoll >= FILL_POLL_MS) {
      e.polling ??= this.pollTrades(pair, e, backfill ? since : Math.max(since, e.lastPoll - 10_000)).finally(() => { e.polling = null; });
      await e.polling;
    }
    return [...e.trades.values()].filter(t => t.time >= since);
  }

  private async pollTrades(pair: string, e: { trades: Map<number, BnTrade>; start: number; lastPoll: number }, from: number) {
    const now = Date.now();
    // myTrades allows at most a 24h window per request; page by window, then by id.
    for (let start = from; start <= now; start += DAY_MS) {
      const end = Math.min(start + DAY_MS - 1, now);
      let rows = await this.signed("GET", "/api/v3/myTrades", { symbol: pair, startTime: start, endTime: end, limit: 1000 }) as BnTrade[];
      for (const t of rows) e.trades.set(t.id, t);
      for (let page = 0; rows.length === 1000 && page < 20; page++) {
        rows = await this.signed("GET", "/api/v3/myTrades", { symbol: pair, fromId: rows[rows.length - 1].id + 1, limit: 1000 }) as BnTrade[];
        for (const t of rows) if (t.time <= end) e.trades.set(t.id, t);
      }
    }
    e.lastPoll = now;
    e.start = Math.min(e.start, from);
    const cutoff = now - FILL_BUFFER_MS;
    if (e.start < cutoff) {
      for (const [id, t] of e.trades) if (t.time < cutoff) e.trades.delete(id);
      e.start = cutoff;
    }
  }

  async cancelAllOpen(): Promise<{ canceled: number; failed: number }> {
    const open = await this.signed("GET", "/api/v3/openOrders") as { symbol: string }[];
    const counts = new Map<string, number>();
    for (const o of open) counts.set(o.symbol, (counts.get(o.symbol) ?? 0) + 1);
    let canceled = 0, failed = 0;
    for (const [symbol, n] of counts) {
      try { await this.signed("DELETE", "/api/v3/openOrders", { symbol }); canceled += n; }
      catch { failed += n; }
    }
    return { canceled, failed };
  }
}

/** Checks the key with a signed read-only call: it must work and allow spot trading. */
export async function verifyBinanceKey(apiKey: string, secret: string): Promise<void> {
  let acct: { canTrade?: boolean };
  try {
    acct = await new BinanceAccount(apiKey, secret).signed("GET", "/api/v3/account", { omitZeroBalances: "true" }) as typeof acct;
  } catch (err) {
    if (err instanceof BinanceError) {
      if (err.status === 451) throw new Error(err.message);
      throw new Error(`Binance rejected the key: ${err.message.replace(/^Binance: /u, "")}`);
    }
    throw new Error(`Could not reach Binance to verify the key, try again: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (acct.canTrade === false) throw new Error("This Binance API key does not have Spot trading enabled");
}

export class BinanceAdapter implements ExchangeAdapter {
  readonly live = true;
  constructor(private readonly account: BinanceAccount) {}

  getPrice(symbol: string) { return fetchPrice("binance", binanceSymbol(symbol)); }

  async roundPrice(symbol: string, price: Decimal, side: Side) {
    const { tick } = await symbolRules(symbol);
    return toStep(price, tick, side === "sell" ? Decimal.ROUND_UP : Decimal.ROUND_DOWN);
  }

  async roundQty(symbol: string, qty: Decimal) {
    const { step } = await symbolRules(symbol);
    return toStep(qty, step, Decimal.ROUND_DOWN);
  }

  async validateOrder(symbol: string, price: Decimal, qty: Decimal) {
    const r = await symbolRules(symbol);
    if (!toStep(qty, r.step, Decimal.ROUND_DOWN).eq(qty)) throw new Error(`${r.symbol} quantity must be a multiple of ${plain(r.step)}`);
    if (qty.lt(r.minQty)) throw new Error(`${r.symbol} minimum quantity is ${plain(r.minQty)}`);
    if (price.times(qty).lt(r.minNotional)) {
      throw new Error(`${r.symbol} minimum order value is ${plain(r.minNotional)} ${r.quote} (${plain(qty)} × ${plain(price)} is less)`);
    }
  }

  async preflight(symbol: string, need: { base: Decimal; quote: Decimal }) {
    const r = await symbolRules(symbol);
    const balances = await this.account.balances();
    const base = balances.get(r.base) ?? new Decimal(0);
    const quote = balances.get(r.quote) ?? new Decimal(0);
    const missing: string[] = [];
    if (base.lt(need.base)) missing.push(`${plain(need.base)} ${r.base} for the sell orders (free: ${plain(base)})`);
    if (quote.lt(need.quote)) missing.push(`${need.quote.toDecimalPlaces(2, Decimal.ROUND_UP).toFixed()} ${r.quote} for the buy orders (free: ${plain(quote)})`);
    if (missing.length) throw new Error(`Not enough balance on Binance: needs ${missing.join(" and ")}`);
  }

  async placeLimit(req: PlaceRequest) {
    const r = await symbolRules(req.symbol);
    const res = await this.account.signed("POST", "/api/v3/order", {
      symbol: r.symbol, side: req.side === "buy" ? "BUY" : "SELL", type: "LIMIT", timeInForce: "GTC",
      quantity: plain(req.qty), price: plain(req.price), newClientOrderId: req.clientId, newOrderRespType: "ACK",
    }) as { orderId?: number };
    if (res.orderId === undefined) throw new Error("Binance did not return an order id");
    return { exchangeOrderId: String(res.orderId) };
  }

  async openOrderIds(symbol: string): Promise<Set<string>> {
    const r = await symbolRules(symbol);
    const open = await this.account.signed("GET", "/api/v3/openOrders", { symbol: r.symbol }) as { orderId: number }[];
    return new Set(open.map(o => String(o.orderId)));
  }

  async lookupByClientId(symbol: string, clientId: string) {
    const r = await symbolRules(symbol);
    try {
      const o = await this.account.signed("GET", "/api/v3/order", { symbol: r.symbol, origClientOrderId: clientId }) as { orderId: number };
      return String(o.orderId);
    } catch (err) {
      if (err instanceof BinanceError && err.code === -2013) return null; // order does not exist
      throw err;
    }
  }

  async cancel(symbol: string, ids: string[]): Promise<CancelResult> {
    const r = await symbolRules(symbol);
    const result: CancelResult = { canceled: [], failed: [] };
    for (const id of ids) {
      try {
        await this.account.signed("DELETE", "/api/v3/order", { symbol: r.symbol, orderId: id });
        result.canceled.push(id);
      } catch (err) {
        // -2011 "Unknown order": already filled or canceled — no longer resting either way.
        if (err instanceof BinanceError && err.code === -2011) result.canceled.push(id);
        else result.failed.push({ exchangeOrderId: id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return result;
  }

  async fillsFor(symbol: string, open: TrackedOrder[], since: number) {
    const cursor = Math.max(since, Date.now() - 60_000);
    if (!open.length) return { fills: [], cursor };
    const r = await symbolRules(symbol);
    const ids = new Set(open.map(o => o.exchangeOrderId));
    const rows = await this.account.tradesSince(r.symbol, since);
    const fills: ExchangeFill[] = [];
    for (const t of rows) {
      if (!ids.has(String(t.orderId))) continue;
      fills.push({
        exchangeOrderId: String(t.orderId), tradeId: String(t.id), price: new Decimal(t.price), qty: new Decimal(t.qty),
        fee: await this.feeInQuote(r, t), time: t.time,
      });
    }
    return { fills, cursor };
  }

  /** Converts a trade's commission into the quote asset so PnL stays in one currency. */
  private async feeInQuote(r: SymbolRules, t: BnTrade): Promise<Decimal> {
    const fee = new Decimal(t.commission || "0");
    if (fee.isZero() || t.commissionAsset === r.quote) return fee;
    if (t.commissionAsset === r.base) return fee.times(t.price);
    try { return fee.times(await fetchPrice("binance", `${t.commissionAsset}${r.quote}`)); } catch { return new Decimal(0); }
  }

  async netEntryQty(symbol: string, exchangeOrderId: string, side: Side, filledQty: Decimal) {
    if (side !== "buy") return filledQty;
    const r = await symbolRules(symbol);
    const rows = await this.account.tradesSince(r.symbol, Date.now() - FILL_BUFFER_MS);
    const baseFee = rows
      .filter(t => String(t.orderId) === exchangeOrderId && t.commissionAsset === r.base)
      .reduce((sum, t) => sum.plus(t.commission), new Decimal(0));
    return toStep(filledQty.minus(baseFee), r.step, Decimal.ROUND_DOWN);
  }
}
