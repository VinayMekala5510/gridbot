import type { ExchangeId } from "../../shared/types";
import { deribitUrl, hyperliquidUrl } from "./prices";

// Tradable symbols per exchange, for the bot form's dropdown. Cached for an hour.

const TTL_MS = 60 * 60_000;
const TIMEOUT_MS = 20_000;
const cache = new Map<string, { at: number; value: Promise<string[]> }>();

/** Shown first in each list when present. */
const POPULAR = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX", "LINK", "SUI", "TON", "HYPE"];

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
  return res.json();
}

function ordered(symbols: string[], baseOf: (s: string) => string, tie: (s: string) => number = () => 0): string[] {
  const rank = (s: string) => {
    const i = POPULAR.indexOf(baseOf(s));
    return i === -1 ? POPULAR.length : i;
  };
  return [...new Set(symbols)].sort((a, b) => rank(a) - rank(b) || baseOf(a).localeCompare(baseOf(b)) || tie(a) - tie(b) || a.localeCompare(b));
}

async function load(exchange: ExchangeId): Promise<string[]> {
  switch (exchange) {
    case "hyperliquid":
    case "hyperliquid-testnet": {
      const meta = await getJson(`${hyperliquidUrl(exchange)}/info`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "meta" }),
      }) as { universe: { name: string; isDelisted?: boolean }[] };
      // Every Hyperliquid market traded here is a perpetual: name it that way (BTC-PERP).
      return ordered(meta.universe.filter(u => !u.isDelisted).map(u => `${u.name}-PERP`), s => s.replace(/-PERP$/u, ""));
    }
    case "binance":
    case "solana":
    case "ethereum": {
      const info = await getJson("https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT&symbolStatus=TRADING") as
        { symbols: { symbol: string; baseAsset: string; quoteAsset: string; status: string }[] };
      let rows = info.symbols.filter(s => s.status === "TRADING");
      if (exchange === "solana") rows = rows.filter(s => s.baseAsset === "SOL");
      if (exchange === "ethereum") rows = rows.filter(s => s.baseAsset === "ETH");
      const base = new Map(rows.map(s => [s.symbol, s.baseAsset]));
      const quote = new Map(rows.map(s => [s.symbol, s.quoteAsset]));
      // Per coin: USDT, then USDC, then FDUSD, then other quotes.
      const quoteRank = (s: string) => { const i = ["USDT", "USDC", "FDUSD"].indexOf(quote.get(s) ?? ""); return i === -1 ? 3 : i; };
      return ordered(rows.map(s => s.symbol), s => base.get(s) ?? s, quoteRank);
    }
    case "bybit": {
      const r = await getJson("https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000") as
        { result?: { list?: { symbol: string; baseCoin: string; status: string; contractType: string }[] } };
      const rows = (r.result?.list ?? []).filter(s => s.status === "Trading" && s.contractType === "LinearPerpetual");
      const base = new Map(rows.map(s => [s.symbol, s.baseCoin]));
      return ordered(rows.map(s => s.symbol), s => base.get(s) ?? s);
    }
    case "deribit":
    case "deribit-testnet": {
      const r = await getJson(`${deribitUrl(exchange)}/public/get_instruments?currency=any&kind=future`) as
        { result?: { instrument_name: string; is_active: boolean; settlement_period: string }[] };
      const perps = (r.result ?? []).filter(i => i.is_active && i.settlement_period === "perpetual").map(i => i.instrument_name);
      // Per coin: the inverse perp (BTC-PERPETUAL) before the USDC-settled one.
      return ordered(perps, s => s.split(/[-_]/u)[0], s => (s.includes("_") ? 1 : 0));
    }
  }
}

export function listSymbols(exchange: ExchangeId): Promise<string[]> {
  const hit = cache.get(exchange);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = load(exchange);
  cache.set(exchange, { at: Date.now(), value });
  value.catch(() => cache.delete(exchange));
  return value;
}
