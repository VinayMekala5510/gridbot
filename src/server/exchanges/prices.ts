import Decimal from "decimal.js";
import type { ExchangeId } from "../../shared/types";

// Public market-data prices, cached briefly so many bots share one request.

const TTL_MS = 1500;
const TIMEOUT_MS = 8000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
  return res.json();
}

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

export function hyperliquidUrl(exchange: ExchangeId): string {
  return exchange === "hyperliquid-testnet" ? "https://api.hyperliquid-testnet.xyz" : "https://api.hyperliquid.xyz";
}

/** "eth-perp", "ETH/USDC", "ETHUSDC" → "ETH" for Hyperliquid perps. */
export function hyperliquidCoin(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/[-/ ]?(PERP|USDC|USD)$/u, "").replace(/[-/ ]$/u, "");
}

function spotPair(symbol: string): string {
  const s = symbol.trim().toUpperCase().replace(/[-/ _]/gu, "").replace(/PERP(ETUAL)?$/u, "");
  return /(USDT|USDC|BUSD|FDUSD|BTC|ETH)$/u.test(s) && s.length > 4 ? s : `${s}USDT`;
}

function deribitInstrument(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  if (s.includes("-")) return s.replace(/-PERP$/u, "-PERPETUAL");
  return `${s.replace(/(USDT|USDC|USD)$/u, "")}-PERPETUAL`;
}

function positive(raw: unknown, what: string): Decimal {
  const value = new Decimal(String(raw));
  if (!value.isFinite() || value.lte(0)) throw new Error(`No valid price for ${what}`);
  return value;
}

export async function fetchPrice(exchange: ExchangeId, symbol: string): Promise<Decimal> {
  switch (exchange) {
    case "hyperliquid":
    case "hyperliquid-testnet": {
      const base = hyperliquidUrl(exchange);
      const mids = await cached(`hl-mids:${base}`, () => fetchJson(`${base}/info`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "allMids" }),
      })) as Record<string, string>;
      const coin = hyperliquidCoin(symbol);
      if (!(coin in mids)) throw new Error(`${coin} is not listed on ${exchange === "hyperliquid" ? "Hyperliquid" : "Hyperliquid Testnet"}`);
      return positive(mids[coin], coin);
    }
    case "binance":
    case "solana":
    case "ethereum": {
      const pair = spotPair(symbol);
      const data = await cached(`binance:${pair}`, () =>
        fetchJson(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(pair)}`)) as { price?: string };
      return positive(data.price, pair);
    }
    case "bybit": {
      const pair = spotPair(symbol);
      const data = await cached(`bybit:${pair}`, () =>
        fetchJson(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${encodeURIComponent(pair)}`)) as
        { result?: { list?: { lastPrice?: string }[] } };
      return positive(data.result?.list?.[0]?.lastPrice, pair);
    }
    case "deribit": {
      const instrument = deribitInstrument(symbol);
      const data = await cached(`deribit:${instrument}`, () =>
        fetchJson(`https://www.deribit.com/api/v2/public/ticker?instrument_name=${encodeURIComponent(instrument)}`)) as
        { result?: { last_price?: number } };
      return positive(data.result?.last_price, instrument);
    }
  }
}
