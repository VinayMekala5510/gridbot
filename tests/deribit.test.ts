import assert from "node:assert/strict";
import { test } from "node:test";
import Decimal from "decimal.js";
import { deribitInstrument } from "../src/server/exchanges/prices";
import { GridBot } from "../src/server/engine/grid";
import { PaperAdapter } from "../src/server/exchanges/paper";
import { MemoryStore } from "../src/server/store/memory";

test("Deribit symbols normalise to perpetual instruments", () => {
  assert.equal(deribitInstrument("btc"), "BTC-PERPETUAL");
  assert.equal(deribitInstrument("ETH-PERP"), "ETH-PERPETUAL");
  assert.equal(deribitInstrument("sol_usdc"), "SOL_USDC-PERPETUAL");
  assert.equal(deribitInstrument("SOL/USDC"), "SOL_USDC-PERPETUAL");
  assert.equal(deribitInstrument("BTC-PERPETUAL"), "BTC-PERPETUAL");
});

test("inverse contracts: roundtrip PnL converts USD amount to coins at the entry price", async () => {
  const store = new MemoryStore();
  let price = new Decimal(100_000);
  const adapter = new PaperAdapter(async () => price);
  Object.assign(adapter, { isInverse: async () => true });
  const rec = await store.createBot({
    name: "inv", exchange: "deribit-testnet", mode: "paper", accountId: null, symbol: "BTC-PERPETUAL",
    spread: "100", targetSpread: "200", steps: 1, stepQty: "1000", mmQty: "10000",
    upperLimit: "110000", lowerLimit: "90000", entryPrice: "100000",
  }, "idle");
  const bot = new GridBot(rec, store, adapter, { tickMs: 60_000 });
  await bot.load();
  await bot.tick();                       // buy 1000 USD @ 99,900 and sell @ 100,100 resting
  price = new Decimal(99_850); await bot.tick();   // buy fills → sell target @ 100,100
  price = new Decimal(100_150); await bot.tick();  // target (and the +1 sell entry) fill
  assert.equal(bot.rec.roundtrips, 1);
  // 1000 USD / 99,900 = 0.01001 BTC × 200 USD move ≈ 2.002 USD
  assert.ok(Math.abs(Number(bot.rec.realizedPnl) - 2.002002) < 1e-5, bot.rec.realizedPnl);
});

test("Deribit square-off: immediate-or-cancel LIMIT order 0.2% through the market, kept inside Deribit's price band", async () => {
  const { DeribitAccount, DeribitAdapter } = await import("../src/server/exchanges/deribit");
  const sent: URL[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string) => {
    const url = new URL(input);
    sent.push(url);
    const method = url.pathname.split("/api/v2/")[1];
    const result = method === "public/auth" ? { access_token: "t", expires_in: 3600, scope: "trade:read_write" }
      : method === "public/get_instrument" ? { instrument_name: "HYPE_USDC-PERPETUAL", instrument_type: "linear", tick_size: 0.001, min_trade_amount: 0.01, is_active: true, settlement_currency: "USDC" }
      : method === "public/get_order_book" ? (url.searchParams.get("depth") ? { min_price: Number(process.env.T_MIN ?? 50), max_price: Number(process.env.T_MAX ?? 70) } : {})
      : { order: { order_id: "USDC-1" } };
    return new Response(JSON.stringify({ jsonrpc: "2.0", result }), { status: 200 });
  }) as typeof fetch;
  try {
    const adapter = new DeribitAdapter(new DeribitAccount("deribit-testnet", "id", "secret"));
    const order = (side: "buy" | "sell", ref: number) =>
      adapter.placeMarket({ symbol: "HYPE_USDC-PERPETUAL", side, qty: new Decimal(5), clientId: "0x" + "a".repeat(32), refPrice: new Decimal(ref) });
    const last = () => sent.filter(u => /private\/(buy|sell)$/u.test(u.pathname)).at(-1)!;
    await order("sell", 60);
    assert.equal(last().searchParams.get("type"), "limit");
    assert.equal(last().searchParams.get("time_in_force"), "immediate_or_cancel");
    assert.equal(last().searchParams.get("price"), "59.88");  // 60 × 0.998
    assert.equal(last().searchParams.get("amount"), "5");
    await order("buy", 61);
    assert.equal(last().searchParams.get("price"), "61.122"); // 61 × 1.002
    process.env.T_MIN = "59.95"; process.env.T_MAX = "61.1";   // Deribit's band is narrower than the cap
    await order("sell", 60);
    assert.equal(last().searchParams.get("price"), "59.95");
    await order("buy", 61);
    assert.equal(last().searchParams.get("price"), "61.1");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.T_MIN; delete process.env.T_MAX;
  }
});
