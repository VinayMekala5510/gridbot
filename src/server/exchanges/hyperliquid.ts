import Decimal from "decimal.js";
import { encode } from "@msgpack/msgpack";
import { Signature, Wallet, concat, getBytes, keccak256, isAddress } from "ethers";
import type { ExchangeId, Side } from "../../shared/types";
import { fetchPrice, hyperliquidCoin, hyperliquidUrl, resolveHyperliquidCoin } from "./prices";
import type { CancelResult, ExchangeAdapter, ExchangeFill, PlaceRequest, TrackedOrder } from "./types";

// Hyperliquid perpetuals adapter (mainnet or testnet).
// Signing follows Hyperliquid's L1 action scheme: msgpack(action) + nonce +
// vault flag → keccak256 → EIP-712 "Agent" signature.

const TIMEOUT_MS = 10_000;
const META_TTL_MS = 10 * 60_000;
const FILL_POLL_MS = 3_000;
const FILL_BUFFER_MS = 30 * 60_000;
const MIN_NOTIONAL = new Decimal(10);

interface AssetMeta { index: number; szDecimals: number }
const metaCache = new Map<string, { at: number; assets: Promise<Map<string, AssetMeta>> }>();

async function post(base: string, path: "/info" | "/exchange", body: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Hyperliquid ${path} ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { throw new Error(`Hyperliquid ${path}: ${text.slice(0, 200)}`); }
}

function assets(base: string): Promise<Map<string, AssetMeta>> {
  const hit = metaCache.get(base);
  if (hit && Date.now() - hit.at < META_TTL_MS) return hit.assets;
  const load = (async () => {
    const meta = await post(base, "/info", { type: "meta" }) as { universe: { name: string; szDecimals: number }[] };
    return new Map(meta.universe.map((u, index) => [u.name, { index, szDecimals: u.szDecimals }]));
  })();
  metaCache.set(base, { at: Date.now(), assets: load });
  load.catch(() => metaCache.delete(base));
  return load;
}

/** Hyperliquid wire format: plain decimal string without trailing zeros. */
export function wire(value: Decimal): string {
  const s = value.toFixed();
  return s.includes(".") ? s.replace(/0+$/u, "").replace(/\.$/u, "") : s;
}

/** Perp price rules: ≤ 5 significant figures (integers always ok), ≤ 6 − szDecimals decimals. */
export function roundHyperliquidPrice(price: Decimal, szDecimals: number, side: Side): Decimal {
  const mode = side === "sell" ? Decimal.ROUND_UP : Decimal.ROUND_DOWN;
  const maxDecimals = Math.max(0, 6 - szDecimals);
  let px = price.toDecimalPlaces(maxDecimals, mode);
  const integerDigits = px.trunc().abs().toFixed().replace(/^0$/u, "").length;
  if (integerDigits >= 5) px = px.toDecimalPlaces(0, mode);
  else if (px.sd(true) > 5) px = px.toSignificantDigits(5, mode);
  return px;
}

export function validatePrivateKey(key: string): string {
  const trimmed = key.trim();
  const normalized = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/u.test(normalized)) throw new Error("Private key must be 64 hex characters");
  return normalized;
}

export function validateAddress(address: string): string {
  const trimmed = address.trim();
  if (!isAddress(trimmed)) throw new Error("Wallet address must be a 0x… Ethereum-style address");
  return trimmed.toLowerCase();
}

/**
 * Checks that `privateKey` can trade for `address`: either it is the wallet's
 * own key, or an API wallet that the wallet approved. Throws a readable error otherwise.
 */
export async function verifyHyperliquidKey(exchange: ExchangeId, address: string, privateKey: string): Promise<"wallet" | "api-wallet"> {
  const owner = validateAddress(address);
  const signer = new Wallet(validatePrivateKey(privateKey)).address.toLowerCase();
  if (signer === owner) return "wallet";
  const network = exchange === "hyperliquid" ? "Hyperliquid mainnet" : "Hyperliquid testnet";
  let role: { role?: string; data?: { user?: string } };
  try {
    role = await post(hyperliquidUrl(exchange), "/info", { type: "userRole", user: signer }) as typeof role;
  } catch (err) {
    throw new Error(`Could not verify the key with Hyperliquid, try again: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (role.role === "agent") {
    if (role.data?.user?.toLowerCase() === owner) return "api-wallet";
    throw new Error(`This API wallet key belongs to a different account (${role.data?.user ?? "unknown"}), not ${owner}`);
  }
  throw new Error(`This private key (address ${signer}) is not the key of ${owner} and is not an approved API wallet for it on ${network}. ` +
    "Create one in Hyperliquid → More → API, or check you picked the right network.");
}

interface HlFill { coin: string; px: string; sz: string; side: string; time: number; oid: number; tid: number; fee: string }

/** One per saved account: signs actions, shares fill polling across that account's bots. */
export class HyperliquidAccount {
  readonly base: string;
  private readonly wallet: Wallet;
  private lastNonce = 0;
  private fills = new Map<number, HlFill>();
  private bufferStart = Number.POSITIVE_INFINITY;
  private polledTo = 0;
  private lastPoll = 0;
  private polling: Promise<void> | null = null;

  constructor(readonly exchange: ExchangeId, readonly user: string, privateKey: string) {
    this.base = hyperliquidUrl(exchange);
    this.user = validateAddress(user);
    this.wallet = new Wallet(validatePrivateKey(privateKey));
  }

  get isMainnet() { return this.exchange === "hyperliquid"; }
  get signerAddress() { return this.wallet.address; }

  async asset(symbol: string): Promise<AssetMeta & { coin: string }> {
    const all = await assets(this.base);
    const coin = resolveHyperliquidCoin(symbol, all.keys());
    const meta = coin ? all.get(coin) : undefined;
    if (!coin || !meta) throw new Error(`${hyperliquidCoin(symbol)} is not a Hyperliquid perpetual`);
    return { ...meta, coin };
  }

  info(body: Record<string, unknown>): Promise<unknown> { return post(this.base, "/info", body); }

  private nonce(): number {
    this.lastNonce = Math.max(Date.now(), this.lastNonce + 1);
    return this.lastNonce;
  }

  async sendAction(action: Record<string, unknown>): Promise<unknown> {
    const nonce = this.nonce();
    const nonceBytes = new Uint8Array(8);
    new DataView(nonceBytes.buffer).setBigUint64(0, BigInt(nonce));
    const connectionId = keccak256(concat([encode(action, { ignoreUndefined: true }), nonceBytes, new Uint8Array([0])]));
    const signature = await this.wallet.signTypedData(
      { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" },
      { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
      { source: this.isMainnet ? "a" : "b", connectionId: getBytes(connectionId) },
    );
    const { r, s, v } = Signature.from(signature);
    const res = await post(this.base, "/exchange", { action, nonce, signature: { r, s, v }, vaultAddress: null }) as
      { status: string; response: unknown };
    if (res.status !== "ok") throw new Error(`Hyperliquid rejected the request: ${String(res.response).slice(0, 300)}`);
    return res.response;
  }

  /** Fills at or after `since`, polled at most every few seconds and shared by all bots on this account. */
  async fillsSince(since: number): Promise<HlFill[]> {
    const needBackfill = since < this.bufferStart;
    if (needBackfill || Date.now() - this.lastPoll >= FILL_POLL_MS) {
      this.polling ??= this.poll(needBackfill ? since : Math.max(0, Math.min(this.polledTo, Date.now()) - 5_000))
        .finally(() => { this.polling = null; });
      await this.polling;
    }
    return [...this.fills.values()].filter(f => f.time >= since);
  }

  private async poll(startTime: number): Promise<void> {
    let cursor = startTime;
    // userFillsByTime returns at most 2000 rows; page forward until caught up.
    for (let page = 0; page < 10; page++) {
      const rows = await post(this.base, "/info", {
        type: "userFillsByTime", user: this.user, startTime: cursor, aggregateByTime: false,
      }) as HlFill[];
      for (const f of rows) this.fills.set(f.tid, f);
      if (rows.length < 2000) break;
      cursor = Math.max(...rows.map(f => f.time));
    }
    this.lastPoll = Date.now();
    this.polledTo = this.lastPoll;
    this.bufferStart = Math.min(this.bufferStart, startTime);
    const cutoff = Date.now() - FILL_BUFFER_MS;
    if (this.bufferStart < cutoff) {
      for (const [tid, f] of this.fills) if (f.time < cutoff) this.fills.delete(tid);
      this.bufferStart = cutoff;
    }
  }

  /** Blanket cancel of every open order on this account (master kill switch). */
  async cancelAllOpen(): Promise<{ canceled: number; failed: number }> {
    const open = await post(this.base, "/info", { type: "openOrders", user: this.user }) as { coin: string; oid: number }[];
    if (!open.length) return { canceled: 0, failed: 0 };
    const metas = await assets(this.base);
    const cancels = open.filter(o => metas.has(o.coin)).map(o => ({ a: metas.get(o.coin)!.index, o: o.oid }));
    const res = await this.sendAction({ type: "cancel", cancels }) as { data?: { statuses?: unknown[] } };
    const statuses = res.data?.statuses ?? [];
    const ok = statuses.filter(s => s === "success").length;
    return { canceled: ok, failed: open.length - ok };
  }
}

export class HyperliquidAdapter implements ExchangeAdapter {
  readonly live = true;
  constructor(private readonly account: HyperliquidAccount) {}

  getPrice(symbol: string) { return fetchPrice(this.account.exchange, symbol); }

  async roundPrice(symbol: string, price: Decimal, side: Side) {
    const { szDecimals } = await this.account.asset(symbol);
    return roundHyperliquidPrice(price, szDecimals, side);
  }

  async roundQty(symbol: string, qty: Decimal) {
    const { szDecimals } = await this.account.asset(symbol);
    return qty.toDecimalPlaces(szDecimals, Decimal.ROUND_DOWN);
  }

  async validateOrder(symbol: string, price: Decimal, qty: Decimal) {
    const { szDecimals, coin } = await this.account.asset(symbol);
    if (!qty.toDecimalPlaces(szDecimals, Decimal.ROUND_DOWN).eq(qty)) {
      throw new Error(`${coin} quantity allows at most ${szDecimals} decimals`);
    }
    if (qty.lte(0)) throw new Error("Quantity rounds to zero");
    if (price.times(qty).lt(MIN_NOTIONAL)) {
      throw new Error(`Hyperliquid minimum order value is $${MIN_NOTIONAL.toFixed()} (${wire(qty)} × ${wire(price)} is less)`);
    }
  }

  async placeLimit(req: PlaceRequest) {
    const { index } = await this.account.asset(req.symbol);
    if (!/^0x[0-9a-f]{32}$/u.test(req.clientId)) throw new Error("Invalid client order id");
    // Key order matters: it is part of the signed msgpack payload.
    const order = { a: index, b: req.side === "buy", p: wire(req.price), s: wire(req.qty), r: false, t: { limit: { tif: "Gtc" } }, c: req.clientId };
    const res = await this.account.sendAction({ type: "order", orders: [order], grouping: "na" }) as
      { data?: { statuses?: ({ resting?: { oid: number }; filled?: { oid: number }; error?: string })[] } };
    const status = res.data?.statuses?.[0];
    const oid = status?.resting?.oid ?? status?.filled?.oid;
    if (oid === undefined) throw new Error(status?.error ?? "Hyperliquid did not accept the order");
    return { exchangeOrderId: String(oid) };
  }

  async openOrderIds(symbol: string): Promise<Set<string>> {
    const { coin } = await this.account.asset(symbol);
    const open = await this.account.info({ type: "openOrders", user: this.account.user }) as { coin: string; oid: number }[];
    return new Set(open.filter(o => o.coin === coin).map(o => String(o.oid)));
  }

  async lookupByClientId(_symbol: string, clientId: string): Promise<string | null> {
    const res = await this.account.info({ type: "orderStatus", user: this.account.user, oid: clientId }) as
      { status?: string; order?: { order?: { oid?: number } } };
    const oid = res.order?.order?.oid;
    return res.status === "order" && oid !== undefined ? String(oid) : null;
  }

  async cancel(symbol: string, ids: string[]): Promise<CancelResult> {
    if (!ids.length) return { canceled: [], failed: [] };
    const { index } = await this.account.asset(symbol);
    const res = await this.account.sendAction({ type: "cancel", cancels: ids.map(id => ({ a: index, o: Number(id) })) }) as
      { data?: { statuses?: (string | { error?: string })[] } };
    const statuses = res.data?.statuses ?? [];
    const result: CancelResult = { canceled: [], failed: [] };
    ids.forEach((id, i) => {
      const s = statuses[i];
      if (s === "success") result.canceled.push(id);
      // Already canceled or filled: no longer resting either way; fills are reconciled separately.
      else if (typeof s === "object" && s?.error && /never placed|already canceled|filled/iu.test(s.error)) result.canceled.push(id);
      else result.failed.push({ exchangeOrderId: id, error: typeof s === "object" && s?.error ? s.error : "No cancel confirmation" });
    });
    return result;
  }

  async fillsFor(symbol: string, open: TrackedOrder[], since: number) {
    if (!open.length) return { fills: [], cursor: Math.max(since, Date.now() - 60_000) };
    const { coin } = await this.account.asset(symbol);
    const ids = new Set(open.map(o => o.exchangeOrderId));
    const rows = await this.account.fillsSince(since);
    const fills: ExchangeFill[] = rows
      .filter(f => f.coin === coin && ids.has(String(f.oid)))
      .map(f => ({
        exchangeOrderId: String(f.oid), tradeId: String(f.tid), price: new Decimal(f.px), qty: new Decimal(f.sz),
        fee: new Decimal(f.fee || "0"), time: f.time,
      }));
    // Keep a safety overlap: trade ids make re-reads harmless.
    return { fills, cursor: Math.max(since, Date.now() - 60_000) };
  }
}
