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
