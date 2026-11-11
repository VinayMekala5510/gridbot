import Decimal from "decimal.js";
import type { ExchangeId, Side } from "../../shared/types";
import { deribitInstrument, deribitUrl, fetchPrice } from "./prices";
import type { AccountClient, CancelResult, ExchangeAdapter, ExchangeFill, PlaceRequest, TrackedOrder } from "./types";

// Deribit perpetuals adapter (mainnet or testnet), JSON-RPC over HTTPS with
// client-credentials OAuth. Inverse perps (BTC-PERPETUAL, ETH-PERPETUAL) take the
// amount in USD; linear perps (SOL_USDC-PERPETUAL, …) take it in the coin.

const TIMEOUT_MS = 10_000;
const INFO_TTL_MS = 10 * 60_000;
const FILL_POLL_MS = 3_000;
const FILL_BUFFER_MS = 30 * 60_000;

export class DeribitError extends Error {
  constructor(message: string, readonly code: number | null) { super(message); }
}

async function rpc(base: string, method: string, params: Record<string, string | number | boolean>, token?: string): Promise<unknown> {
  const query = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))).toString();
  const res = await fetch(`${base}/${method}?${query}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({})) as { result?: unknown; error?: { code?: number; message?: string; data?: { reason?: string; param?: string } } };
  if (body.error) {
    const e = body.error;
    const detail = [e.data?.param, e.data?.reason].filter(Boolean).join(": ");
    throw new DeribitError(`Deribit: ${e.message ?? "error"}${detail ? ` (${detail})` : ""}`, e.code ?? null);
  }
  if (!res.ok) throw new DeribitError(`Deribit HTTP ${res.status}`, null);
  return body.result;
}

interface Instrument {
  name: string; inverse: boolean; tick: Decimal; ticks: { above: Decimal; tick: Decimal }[];
  minAmount: Decimal; settlement: string;
}
const instrumentCache = new Map<string, { at: number; value: Promise<Instrument> }>();

export function deribitInstrumentInfo(exchange: ExchangeId, symbol: string): Promise<Instrument> {
  const base = deribitUrl(exchange);
  const name = deribitInstrument(symbol);
  const key = `${base}:${name}`;
  const hit = instrumentCache.get(key);
  if (hit && Date.now() - hit.at < INFO_TTL_MS) return hit.value;
  const load = (async () => {
    let r: {
      instrument_name: string; instrument_type: string; tick_size: number; min_trade_amount: number; is_active: boolean;
      settlement_currency?: string; counter_currency?: string; tick_size_steps?: { above_price: number; tick_size: number }[]; kind?: string;
    };
    try {
      r = await rpc(base, "public/get_instrument", { instrument_name: name }) as typeof r;
    } catch (err) {
      if (err instanceof DeribitError) throw new Error(`${name} is not a Deribit instrument${exchange === "deribit-testnet" ? " on testnet" : ""}`);
      throw err;
    }
    if (!r.is_active) throw new Error(`${name} is not active on Deribit`);
    return {
      name: r.instrument_name, inverse: r.instrument_type === "reversed",
      tick: new Decimal(r.tick_size), minAmount: new Decimal(r.min_trade_amount),
      ticks: (r.tick_size_steps ?? []).map(s => ({ above: new Decimal(s.above_price), tick: new Decimal(s.tick_size) }))
        .sort((a, b) => a.above.cmp(b.above)),
      settlement: r.settlement_currency ?? r.counter_currency ?? "USD",
    };
  })();
  instrumentCache.set(key, { at: Date.now(), value: load });
  load.catch(() => instrumentCache.delete(key));
  return load;
}

function tickFor(inst: Instrument, price: Decimal): Decimal {
  let tick = inst.tick;
  for (const step of inst.ticks) if (price.gt(step.above)) tick = step.tick;
  return tick;
}

function toStep(value: Decimal, step: Decimal, mode: Decimal.Rounding): Decimal {
  return step.lte(0) ? value : value.div(step).toDecimalPlaces(0, mode).times(step);
}

function plain(value: Decimal): string {
  const s = value.toFixed();
  return s.includes(".") ? s.replace(/0+$/u, "").replace(/\.$/u, "") : s;
}

interface DbTrade {
  trade_id: string; order_id: string; price: number; amount: number; fee: number; fee_currency: string;
  timestamp: number; direction: "buy" | "sell"; instrument_name: string;
}

/** One per saved Deribit account: OAuth token, private calls, shared trade polling. */
export class DeribitAccount implements AccountClient {
  readonly base: string;
  private token: { value: string; expires: number } | null = null;
  private tokenLoading: Promise<string> | null = null;
  private trades = new Map<string, { trades: Map<string, DbTrade>; start: number; lastPoll: number; polling: Promise<void> | null }>();

  constructor(readonly exchange: ExchangeId, private readonly clientId: string, private readonly clientSecret: string) {
    this.base = deribitUrl(exchange);
  }

  async auth(): Promise<{ token: string; scope: string }> {
    const r = await rpc(this.base, "public/auth", {
      grant_type: "client_credentials", client_id: this.clientId, client_secret: this.clientSecret,
    }) as { access_token: string; expires_in: number; scope: string };
    this.token = { value: r.access_token, expires: Date.now() + (r.expires_in - 60) * 1000 };
    return { token: r.access_token, scope: r.scope };
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expires) return this.token.value;
    this.tokenLoading ??= this.auth().then(r => r.token).finally(() => { this.tokenLoading = null; });
    return this.tokenLoading;
  }

  async private(method: string, params: Record<string, string | number | boolean> = {}): Promise<unknown> {
    try {
      return await rpc(this.base, `private/${method}`, params, await this.accessToken());
    } catch (err) {
      // Token revoked or expired early: authenticate once more and retry.
      if (err instanceof DeribitError && (err.code === 13009 || err.code === 13010)) {
        this.token = null;
        return rpc(this.base, `private/${method}`, params, await this.accessToken());
      }
      throw err;
    }
  }

  async tradesSince(instrument: string, since: number): Promise<DbTrade[]> {
    let entry = this.trades.get(instrument);
    if (!entry) {
      entry = { trades: new Map(), start: Number.POSITIVE_INFINITY, lastPoll: 0, polling: null };
      this.trades.set(instrument, entry);
    }
    const e = entry;
    const backfill = since < e.start;
    if (backfill || Date.now() - e.lastPoll >= FILL_POLL_MS) {
      e.polling ??= this.poll(instrument, e, backfill ? since : Math.max(since, e.lastPoll - 10_000)).finally(() => { e.polling = null; });
      await e.polling;
    }
    return [...e.trades.values()].filter(t => t.timestamp >= since);
  }

  private async poll(instrument: string, e: { trades: Map<string, DbTrade>; start: number; lastPoll: number }, from: number) {
    const now = Date.now();
    let start = from;
    for (let page = 0; page < 20; page++) {
      const r = await this.private("get_user_trades_by_instrument_and_time", {
        instrument_name: instrument, start_timestamp: start, end_timestamp: now, count: 1000, sorting: "asc",
      }) as { trades: DbTrade[]; has_more: boolean };
      for (const t of r.trades) e.trades.set(t.trade_id, t);
      if (!r.has_more || !r.trades.length) break;
      start = r.trades[r.trades.length - 1].timestamp;
    }
    e.lastPoll = now;
    e.start = Math.min(e.start, from);
    const cutoff = now - FILL_BUFFER_MS;
    if (e.start < cutoff) {
      for (const [id, t] of e.trades) if (t.timestamp < cutoff) e.trades.delete(id);
      e.start = cutoff;
    }
  }

  async cancelAllOpen(): Promise<{ canceled: number; failed: number }> {
    const n = await this.private("cancel_all") as number;
    return { canceled: Number(n) || 0, failed: 0 };
  }
}

/** Authenticates with the credentials and requires trade permission. */
export async function verifyDeribitKey(exchange: ExchangeId, clientId: string, clientSecret: string): Promise<void> {
  const network = exchange === "deribit" ? "Deribit" : "Deribit Testnet";
  let scope: string;
  try {
    ({ scope } = await new DeribitAccount(exchange, clientId, clientSecret).auth());
  } catch (err) {
    if (err instanceof DeribitError) {
      throw new Error(`${network} rejected the credentials (${err.message.replace(/^Deribit: /u, "")}). ` +
        `Check the Client ID/secret and that the key was created on ${exchange === "deribit" ? "www.deribit.com" : "test.deribit.com"}.`);
    }
    throw new Error(`Could not reach ${network} to verify the key, try again: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!/trade:read_write/u.test(scope)) {
    throw new Error(`This ${network} API key cannot trade. Edit the key and give it "Trade: Read + Write" permission.`);
  }
}

export class DeribitAdapter implements ExchangeAdapter {
  readonly live = true;
  constructor(private readonly account: DeribitAccount) {}

  private info(symbol: string) { return deribitInstrumentInfo(this.account.exchange, symbol); }

  getPrice(symbol: string) { return fetchPrice(this.account.exchange, symbol); }

  async isInverse(symbol: string) { return (await this.info(symbol)).inverse; }

  async roundPrice(symbol: string, price: Decimal, side: Side) {
    const inst = await this.info(symbol);
    return toStep(price, tickFor(inst, price), side === "sell" ? Decimal.ROUND_UP : Decimal.ROUND_DOWN);
  }

  async roundQty(symbol: string, qty: Decimal) {
    const inst = await this.info(symbol);
    return toStep(qty, inst.minAmount, Decimal.ROUND_DOWN);
  }

  async validateOrder(symbol: string, _price: Decimal, qty: Decimal) {
    const inst = await this.info(symbol);
    const unit = inst.inverse ? "USD" : inst.name.split("_")[0];
    if (qty.lt(inst.minAmount)) throw new Error(`${inst.name} minimum amount is ${plain(inst.minAmount)} ${unit}`);
    if (!toStep(qty, inst.minAmount, Decimal.ROUND_DOWN).eq(qty)) {
      throw new Error(`${inst.name} amount must be a multiple of ${plain(inst.minAmount)} ${unit}`);
    }
  }

  async placeLimit(req: PlaceRequest) {
    const inst = await this.info(req.symbol);
    const r = await this.account.private(req.side === "buy" ? "buy" : "sell", {
      instrument_name: inst.name, amount: plain(req.qty), type: "limit", price: plain(req.price),
      label: req.clientId, time_in_force: "good_til_cancelled",
    }) as { order?: { order_id?: string } };
    if (!r.order?.order_id) throw new Error("Deribit did not return an order id");
    return { exchangeOrderId: r.order.order_id };
  }

  async lookupByClientId(symbol: string, clientId: string) {
    const inst = await this.info(symbol);
    const open = await this.account.private("get_open_orders_by_instrument", { instrument_name: inst.name }) as { order_id: string; label: string }[];
    const hit = open.find(o => o.label === clientId);
    if (hit) return hit.order_id;
    const history = await this.account.private("get_order_history_by_instrument", { instrument_name: inst.name, count: 100 }) as { order_id: string; label: string }[];
    return history.find(o => o.label === clientId)?.order_id ?? null;
  }

  async openOrderIds(symbol: string): Promise<Set<string>> {
    const inst = await this.info(symbol);
    const open = await this.account.private("get_open_orders_by_instrument", { instrument_name: inst.name }) as { order_id: string }[];
    return new Set(open.map(o => o.order_id));
  }

  async cancel(_symbol: string, ids: string[]): Promise<CancelResult> {
    const result: CancelResult = { canceled: [], failed: [] };
    for (const id of ids) {
      try {
        await this.account.private("cancel", { order_id: id });
        result.canceled.push(id);
      } catch (err) {
        // 11044 not_open_order / 10004 order_not_found: already filled, canceled or expired —
        // no longer resting either way (fills are reconciled separately).
        if (err instanceof DeribitError && (err.code === 11044 || err.code === 10004 || /order_not_found|not_open_order/u.test(err.message))) {
          result.canceled.push(id);
        }
        else result.failed.push({ exchangeOrderId: id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return result;
  }

  async fillsFor(symbol: string, open: TrackedOrder[], since: number) {
    const cursor = Math.max(since, Date.now() - 60_000);
    if (!open.length) return { fills: [], cursor };
    const inst = await this.info(symbol);
    const ids = new Set(open.map(o => o.exchangeOrderId));
    const rows = await this.account.tradesSince(inst.name, since);
    const fills: ExchangeFill[] = rows.filter(t => ids.has(t.order_id)).map(t => {
      const price = new Decimal(t.price);
      const fee = new Decimal(t.fee || 0);
      // Inverse perps charge fees in the coin; express them in USD at the trade price.
      const feeQuote = /^(USD|USDC|USDT)$/u.test(t.fee_currency) ? fee : fee.times(price);
      return {
        exchangeOrderId: t.order_id, tradeId: t.trade_id, price, qty: new Decimal(t.amount), fee: feeQuote, time: t.timestamp,
      };
    });
    return { fills, cursor };
  }
}
