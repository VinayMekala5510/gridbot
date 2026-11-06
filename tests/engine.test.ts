import assert from "node:assert/strict";
import { test } from "node:test";
import Decimal from "decimal.js";
import { GridBot } from "../src/server/engine/grid";
import { PaperAdapter } from "../src/server/exchanges/paper";
import { MemoryStore } from "../src/server/store/memory";
import type { BotConfig } from "../src/shared/types";

const base: BotConfig = {
  name: "t", exchange: "hyperliquid", mode: "paper", accountId: null, symbol: "BTC",
  spread: "1", targetSpread: "0.5", steps: 3, stepQty: "1", mmQty: "4",
  upperLimit: "110", lowerLimit: "90", entryPrice: "100",
};

async function setup(overrides: Partial<BotConfig> = {}) {
  const store = new MemoryStore();
  let price = new Decimal(100);
  const adapter = new PaperAdapter(async () => price);
  const rec = await store.createBot({ ...base, ...overrides }, "idle");
  const bot = new GridBot(rec, store, adapter, { tickMs: 60_000 });
  await bot.load();
  return {
    store, bot,
    setPrice: (p: number) => { price = new Decimal(p); },
    open: () => store.orders.filter(o => o.status === "open"),
  };
}

test("places the nearest entry orders that fit the volume budget", async () => {
  const { bot, open } = await setup();
  await bot.tick();
  assert.equal(bot.rec.status, "running");
  const prices = open().map(o => `${o.side}@${o.price}`).sort();
  assert.deepEqual(prices, ["buy@98", "buy@99", "sell@101", "sell@102"]);
  assert.ok(open().every(o => o.role === "entry" && o.qty === "1"));
});

test("sell entry fill places a buy target at price - target spread, then a roundtrip completes", async () => {
  const { bot, open, setPrice, store } = await setup({ mmQty: "10" });
  await bot.tick();
  setPrice(101.2);
  await bot.tick();
  const target = open().find(o => o.role === "target");
  assert.ok(target, "target placed");
  assert.equal(target.side, "buy");
  assert.equal(target.price, "100.5");
  assert.equal(target.level, 1);
  assert.equal(bot.rec.entryFilledQty, "1");
  assert.ok(!open().some(o => o.role === "entry" && o.level === 1), "level busy with its target, no second entry");

  setPrice(100.4);
  await bot.tick();
  assert.equal(bot.rec.roundtrips, 1);
  assert.equal(bot.rec.realizedPnl, "0.5");
  assert.equal(store.roundtrips.length, 1);
  // Level +1 is re-armed with a fresh sell entry.
  assert.ok(open().some(o => o.role === "entry" && o.level === 1 && o.side === "sell"));
});

test("buy entry fill places a sell target above it", async () => {
  const { bot, open, setPrice } = await setup({ mmQty: "10" });
  await bot.tick();
  setPrice(98.9);
  await bot.tick();
  const target = open().find(o => o.role === "target");
  assert.equal(target?.side, "sell");
  assert.equal(target?.price, "99.5");
  setPrice(99.6);
  await bot.tick();
  assert.equal(bot.rec.roundtrips, 1);
  assert.equal(bot.rec.realizedPnl, "0.5");
});

test("volume cap halts the bot and cancels every order without exceeding the ceiling", async () => {
  const { bot, open, setPrice } = await setup({ mmQty: "2" });
  await bot.tick();
  assert.equal(open().length, 2, "only two steps of room");
  setPrice(101.5);
  await bot.tick(); // sell +1 fills (1 of 2)
  assert.equal(bot.rec.status, "running");
  setPrice(98.5);
  await bot.tick(); // buy -1 fills (2 of 2) → cap reached
  assert.equal(bot.rec.status, "halted_volume_cap");
  assert.equal(bot.rec.entryFilledQty, "2");
  assert.equal(open().length, 0, "all orders canceled");
  assert.ok(new Decimal(bot.rec.entryFilledQty).lte(2));
});

test("price outside the limits stops the bot completely", async () => {
  const { bot, open, setPrice } = await setup();
  await bot.tick();
  setPrice(110.5);
  await bot.tick();
  assert.equal(bot.rec.status, "halted_limit_breach");
  assert.equal(open().length, 0);
  await bot.tick();
  assert.equal(open().length, 0, "no new orders after halting");
});

test("instance kill switch cancels orders and marks the bot killed", async () => {
  const { bot, open, store } = await setup();
  await bot.tick();
  assert.ok(open().length > 0);
  await bot.kill();
  assert.equal(bot.rec.status, "killed");
  assert.equal(open().length, 0);
  assert.ok(store.orders.filter(o => o.status === "canceled").length >= 4);
});

test("levels outside the limits are skipped", async () => {
  const { bot, open } = await setup({ steps: 5, upperLimit: "103", mmQty: "100" });
  await bot.tick();
  const sells = open().filter(o => o.side === "sell").map(o => o.price).sort();
  assert.deepEqual(sells, ["101", "102"]);
  assert.equal(bot.view().activeLevels, 7);
});

test("state survives a restart", async () => {
  const { bot, store, setPrice } = await setup({ mmQty: "10" });
  await bot.tick();
  setPrice(101.2);
  await bot.tick();
  bot.suspend();
  const rec = (await store.listBots())[0];
  const resumed = new GridBot(rec, store, new PaperAdapter(async () => new Decimal(100.4)), { tickMs: 60_000 });
  await resumed.load();
  await resumed.tick();
  assert.equal(resumed.rec.roundtrips, 1, "target from before the restart completes");
});
