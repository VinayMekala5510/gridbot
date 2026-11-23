import assert from "node:assert/strict";
import { test } from "node:test";
import Decimal from "decimal.js";
import { GridBot } from "../src/server/engine/grid";
import { BotManager } from "../src/server/engine/manager";
import { PaperAdapter } from "../src/server/exchanges/paper";
import { MemoryStore } from "../src/server/store/memory";
import type { BotConfig } from "../src/shared/types";

// Entry 100, spread 1, target spread 0.5. Total distance 10 / basket distance 2 = 5 baskets.
const base: BotConfig = {
  name: "b", exchange: "hyperliquid", mode: "paper", accountId: null, symbol: "BTC",
  spread: "1", targetSpread: "0.5", steps: 3, stepQty: "1", mmQty: "20",
  upperLimit: "130", lowerLimit: "70", entryPrice: "100",
  gridModel: "basket-grid", totalDistance: "10", basketDistance: "2",
};

async function setup(overrides: Partial<BotConfig> = {}, store = new MemoryStore()) {
  let price = new Decimal(100);
  const adapter = new PaperAdapter(async () => price);
  const rec = await store.createBot({ ...base, ...overrides }, "idle");
  const bot = new GridBot(rec, store, adapter, { tickMs: 60_000 });
  await bot.load();
  return {
    store, bot, adapter,
    at: async (p: number) => { price = new Decimal(p); await bot.tick(); },
    open: () => store.orders.filter(o => o.status === "open"),
    baskets: () => [...store.baskets].sort((a, b) => a.index - b.index),
  };
}

test("basket count and qty per basket: 10 / 2 = 5 baskets, 20 qty / 5 = 4 each", async () => {
  const { bot, baskets } = await setup();
  const v = bot.view();
  assert.equal(v.basket?.count, 5);
  assert.equal(v.basket?.qty, "4");
  assert.equal(baskets().length, 1);
  assert.equal(baskets()[0].startZone, "Start");
  assert.equal(baskets()[0].startPrice, "100");
});

test("price moves the basket distance → cancel all, square off at market, next basket starts at 0", async () => {
  const { at, open, baskets, bot, store } = await setup();
  await at(100);
  assert.equal(open().filter(o => o.role === "entry").length, 6);
  await at(101); // sell 101 fills, buy target 100.5 placed
  await at(102); // sell 102 fills → position short 2; price moved 2 → square off

  const [b1, b2] = baskets();
  assert.equal(b1.status, "closed");
  assert.equal(b1.reason, "distance_up");
  assert.equal(`${b1.startZone} → ${b1.endZone}`, "Start → UB1");
  assert.equal(b1.endPrice, "102");
  assert.equal(b1.squareoffSide, "buy");
  assert.equal(b1.squareoffQty, "2");
  assert.equal(b1.squareoffPrice, "102");
  assert.equal(b1.squareoffPnl, "-1"); // (101 − 102) + (102 − 102)
  assert.equal(bot.rec.squareoffPnl, "-1");

  // The market order is recorded as a square-off fill.
  const sq = store.fills.filter(f => f.role === "squareoff");
  assert.equal(sq.length, 1);
  assert.equal(sq[0].side, "buy");
  assert.equal(sq[0].qty, "2");

  // Next basket: starts at 102 (UB1) with no position and a fresh grid around 102.
  assert.equal(b2.status, "open");
  assert.equal(b2.index, 2);
  assert.equal(b2.startPrice, "102");
  assert.equal(b2.startZone, "UB1");
  assert.equal(open().filter(o => o.role === "target").length, 0, "old basket's target was canceled");
  assert.deepEqual(open().filter(o => o.role === "entry").map(o => Number(o.price)).sort((a, b) => a - b), [99, 100, 101, 103, 104, 105]);
  assert.equal(bot.view().openExposure, "0");
  assert.equal(bot.rec.status, "running");
});

test("basket qty full → square off immediately even before the basket distance", async () => {
  // spread 0.5: sells at 100.5, 101, 101.5. Market making qty 10 → 2 per basket.
  const { at, baskets, open } = await setup({ spread: "0.5", targetSpread: "0.4", mmQty: "10" });
  await at(100);
  await at(101); // sells 100.5 and 101 fill → 2 = basket qty → full
  const [b1, b2] = baskets();
  assert.equal(b1.reason, "qty_full");
  assert.equal(`${b1.startZone} → ${b1.endZone}`, "Start → UB1");
  assert.equal(b1.squareoffSide, "buy");
  assert.equal(b1.squareoffQty, "2");
  assert.equal(b1.squareoffPnl, "-0.5"); // (100.5 − 101) + (101 − 101)
  assert.equal(b2.startPrice, "101");
  assert.equal(b2.startZone, "UB1");
  assert.equal(open().filter(o => o.role === "target").length, 0);
});

test("a basket closed by qty full inside one zone is listed as UB1 → UB1", async () => {
  const { at, baskets } = await setup({ spread: "0.5", targetSpread: "0.4", mmQty: "10" });
  await at(100);
  await at(101);   // basket 1 full at 101 → basket 2 starts at 101 (UB1)
  await at(102);   // basket 2: sells 101.5 and 102 fill → full again at 102 (still UB1)
  const b2 = baskets()[1];
  assert.equal(b2.reason, "qty_full");
  assert.equal(`${b2.startZone} → ${b2.endZone}`, "UB1 → UB1");
});

test("roundtrips inside a basket are kept as that basket's RTP PnL, separate from square-off PnL", async () => {
  const { at, baskets, bot } = await setup();
  await at(100);
  await at(101);   // sell 101 fills
  await at(100.5); // its buy target fills → roundtrip +0.5; sell 101 is placed again
  await at(102);   // sells 101 and 102 fill; distance reached → square off
  const b1 = baskets()[0];
  assert.equal(b1.roundtrips, 1);
  assert.equal(b1.rtpPnl, "0.5");
  assert.equal(b1.squareoffPnl, "-1");
  const v = bot.view();
  assert.equal(v.realizedPnl, "0.5");
  assert.equal(v.squareoffPnl, "-1");
});

test("price going down: Start → LB1, then back up: LB1 → Start", async () => {
  const { at, baskets } = await setup();
  await at(100);
  await at(98);  // buys 99 and 98 fill → long 2; moved −2 → sell 2 at market
  await at(100); // basket 2 (from 98): its sells fill on the way up, moved +2 → square off
  const [b1, b2, b3] = baskets();
  assert.equal(`${b1.startZone} → ${b1.endZone}`, "Start → LB1");
  assert.equal(b1.reason, "distance_down");
  assert.equal(b1.squareoffSide, "sell");
  assert.equal(b1.squareoffPnl, "-1"); // (98 − 99) + (98 − 98)
  assert.equal(`${b2.startZone} → ${b2.endZone}`, "LB1 → Start");
  assert.equal(b2.reason, "distance_up");
  assert.equal(b3.status, "open");
  assert.equal(b3.startPrice, "100");
});

test("total distance reached → last basket squared off and the bot stops", async () => {
  const { at, baskets, bot, open } = await setup({ totalDistance: "4", mmQty: "8" }); // 2 baskets × 4 qty
  await at(100);
  await at(102); // basket 1 closes (distance)
  await at(104); // basket 2: sells 103 and 104 fill; 4 from the entry price → total distance
  const [b1, b2] = baskets();
  assert.equal(b1.reason, "distance_up");
  assert.equal(b2.reason, "total_distance");
  assert.equal(b2.squareoffQty, "2");
  assert.equal(b2.squareoffPnl, "-1");
  assert.equal(baskets().length, 2, "no new basket after the total distance");
  assert.equal(bot.rec.status, "halted_total_distance");
  assert.equal(open().length, 0);
});

test("the current basket survives a restart; a restart during a square-off stops the bot safely", async () => {
  const store = new MemoryStore();
  const first = await setup({}, store);
  await first.at(100);
  await first.at(102); // basket 2 starts at 102
  first.bot.suspend();

  const again = new GridBot(store.bots[0], store, first.adapter, { tickMs: 60_000 });
  await again.load();
  assert.equal(again.view().basket?.current?.index, 2);
  assert.equal(again.view().basket?.current?.startPrice, "102");

  store.baskets.find(b => b.index === 2)!.status = "closing";
  const third = new GridBot({ ...store.bots[0], status: "running" }, store, first.adapter, { tickMs: 60_000 });
  await third.load();
  await third.tick();
  assert.equal(third.rec.status, "error");
  assert.match(third.rec.statusReason ?? "", /middle of the basket #2 square-off/u);
});

test("step-grid bots are unchanged: no baskets, and all steps in use still stops the bot", async () => {
  const { at, bot, baskets } = await setup({ gridModel: "step-grid", mmQty: "2" });
  await at(100);
  await at(102);
  assert.equal(baskets().length, 0);
  assert.equal(bot.view().basket, null);
  assert.equal(bot.rec.status, "halted_volume_cap");
});

test("basket-grid settings are checked before the bot starts", async () => {
  const store = new MemoryStore();
  const manager = new BotManager(store, { adapterFactory: () => new PaperAdapter(async () => new Decimal(100)) });
  await manager.init();
  try {
    await assert.rejects(manager.createBot({ ...base, name: "x1", basketDistance: "1" }), /larger than the spread/u);
    await assert.rejects(manager.createBot({ ...base, name: "x2", mmQty: "4" }), /less than one per-step quantity/u);
    await assert.rejects(manager.createBot({ ...base, name: "x3", basketDistance: "12" }), /not be larger than the total distance/u);
    await assert.rejects(manager.createBot({ ...base, name: "x4", totalDistance: null }), /Total distance must be a number/u);
    const id = await manager.createBot({ ...base, name: "ok", totalDistance: "10", basketDistance: "3" });
    const snap = await manager.snapshot();
    const v = snap.bots.find(b => b.id === id)!;
    assert.equal(v.basket?.count, 3); // 10 / 3 = 3.33 → 3 baskets
    assert.equal(snap.totals.squareoffPnl, "0");
    await manager.stopBot(id);
  } finally {
    manager.shutdown();
  }
});
