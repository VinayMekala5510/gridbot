import assert from "node:assert/strict";
import { test } from "node:test";
import Decimal from "decimal.js";
import { binanceSymbol, toStep } from "../src/server/exchanges/binance";
import { GridBot } from "../src/server/engine/grid";
import { PaperAdapter } from "../src/server/exchanges/paper";
import { MemoryStore } from "../src/server/store/memory";

test("Binance symbols normalise to spot pairs", () => {
  assert.equal(binanceSymbol("btc"), "BTCUSDT");
  assert.equal(binanceSymbol("SOL/USDT"), "SOLUSDT");
  assert.equal(binanceSymbol("ethbtc"), "ETHBTC");
});

test("tick/step rounding", () => {
  assert.equal(toStep(new Decimal("90.1234"), new Decimal("0.01"), Decimal.ROUND_DOWN).toFixed(), "90.12");
  assert.equal(toStep(new Decimal("90.1234"), new Decimal("0.01"), Decimal.ROUND_UP).toFixed(), "90.13");
  assert.equal(toStep(new Decimal("0.123456"), new Decimal("0.001"), Decimal.ROUND_DOWN).toFixed(), "0.123");
});

test("target sell uses the net quantity when the buy fee is taken in the coin", async () => {
  const store = new MemoryStore();
  let price = new Decimal(100);
  const adapter = new PaperAdapter(async () => price);
  Object.assign(adapter, { netEntryQty: async (_s: string, _id: string, side: string, q: Decimal) => (side === "buy" ? q.minus("0.001") : q) });
  const rec = await store.createBot({
    name: "t", exchange: "binance", mode: "paper", accountId: null, symbol: "SOLUSDT", spread: "1", targetSpread: "0.5",
    steps: 2, stepQty: "1", mmQty: "10", upperLimit: "110", lowerLimit: "90", entryPrice: "100",
  }, "idle");
  const bot = new GridBot(rec, store, adapter, { tickMs: 60_000 });
  await bot.load();
  await bot.tick();
  price = new Decimal(98.9);
  await bot.tick();
  const target = store.orders.find(o => o.role === "target" && o.status === "open");
  assert.equal(target?.side, "sell");
  assert.equal(target?.qty, "0.999");
});
