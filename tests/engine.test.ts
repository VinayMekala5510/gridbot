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

test("places the 3 nearest buy and sell entries", async () => {
  const { bot, open } = await setup();
  await bot.tick();
  assert.equal(bot.rec.status, "running");
  const prices = open().map(o => `${o.side}@${o.price}`).sort();
  assert.deepEqual(prices, ["buy@97", "buy@98", "buy@99", "sell@101", "sell@102", "sell@103"]);
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

test("bot stops when all steps are in use (filled entries whose targets have not filled)", async () => {
  const { bot, open, setPrice } = await setup({ mmQty: "2" });
  await bot.tick();
  assert.equal(open().length, 6, "orders are not limited by the cap, only by 3 + 3");
  setPrice(101.5);
  await bot.tick(); // sell +1 fills: 1 of 2 steps in use (its buy target at 100.5 waits)
  assert.equal(bot.rec.status, "running");
  assert.equal(bot.view().openExposure, "1");
  setPrice(102.5);
  await bot.tick(); // sell +2 fills: 2 of 2 steps in use → stop
  assert.equal(bot.rec.status, "halted_volume_cap");
  assert.match(bot.rec.statusReason ?? "", /All steps in use/u);
  assert.equal(open().length, 0, "all orders canceled");
});

test("a completed roundtrip frees its step, so the bot keeps running past Steps fills", async () => {
  const { bot, open, setPrice } = await setup({ mmQty: "1" }); // only 1 step may be in use
  await bot.tick();
  setPrice(101.2);
  await bot.tick(); // sell +1 fills: 1 of 1 step in use → would stop only if another entry fills
  // The cap is full, so it stops immediately (all steps in use).
  assert.equal(bot.rec.status, "halted_volume_cap");

  const second = await setup({ mmQty: "2" });
  await second.bot.tick();
  for (const p of [101.2, 100.4, 101.2, 100.4, 101.2, 100.4]) { // three roundtrips on level +1
    second.setPrice(p);
    await second.bot.tick();
  }
  assert.equal(second.bot.rec.roundtrips, 3);
  assert.equal(second.bot.rec.entryFilledQty, "3", "3 entries filled in total — more than the 2-step cap");
  assert.equal(second.bot.rec.status, "running", "completed roundtrips do not use up steps");
  assert.equal(second.bot.view().openExposure, "0");
  assert.ok(open().length >= 0);
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

test("only 3 buy and 3 sell entries rest at once, however many steps are configured", async () => {
  const { bot, open } = await setup({ steps: 8, mmQty: "100", upperLimit: "120", lowerLimit: "80" });
  await bot.tick();
  const entries = open().filter(o => o.role === "entry");
  assert.deepEqual(entries.filter(o => o.side === "buy").map(o => o.price).sort(), ["97", "98", "99"]);
  assert.deepEqual(entries.filter(o => o.side === "sell").map(o => o.price).sort(), ["101", "102", "103"]);
  assert.equal(entries.length, 6);
});

test("when an entry fills, the next level on that side is placed to keep 3 per side", async () => {
  const { bot, open, setPrice } = await setup({ steps: 8, mmQty: "100", upperLimit: "120", lowerLimit: "80" });
  await bot.tick();
  setPrice(101.2);
  await bot.tick(); // sell +1 fills → buy target at 100.5, sell +4 placed
  const entries = open().filter(o => o.role === "entry");
  assert.deepEqual(entries.filter(o => o.side === "sell").map(o => o.price).sort(), ["102", "103", "104"]);
  assert.equal(entries.filter(o => o.side === "buy").length, 3);
  assert.equal(open().filter(o => o.role === "target").length, 1);
  await bot.tick(); // nothing else changes on a quiet tick
  assert.equal(open().filter(o => o.role === "entry").length, 6);
});

test("a bot started before the 3 + 3 rule cancels its extra entries, keeping the nearest", async () => {
  const store = new MemoryStore();
  const adapter = new PaperAdapter(async () => new Decimal(100));
  const rec = await store.createBot({ ...base, steps: 8, mmQty: "100", upperLimit: "120", lowerLimit: "80" }, "idle");
  const old = new GridBot(rec, store, adapter, { tickMs: 60_000, maxOpenPerSide: 10 });
  await old.load();
  await old.tick();
  assert.equal(store.orders.filter(o => o.status === "open").length, 16, "old behaviour: every level placed");
  old.suspend();

  const resumed = new GridBot((await store.listBots())[0], store, adapter, { tickMs: 60_000 });
  await resumed.load();
  await resumed.tick();
  const open = store.orders.filter(o => o.status === "open");
  assert.deepEqual(open.filter(o => o.side === "buy").map(o => o.price).sort(), ["97", "98", "99"]);
  assert.deepEqual(open.filter(o => o.side === "sell").map(o => o.price).sort(), ["101", "102", "103"]);
  assert.equal(store.orders.filter(o => o.status === "canceled").length, 10);
});

test("the bot view lists each roundtrip's PnL against the target order that closed it", async () => {
  const { bot, open, setPrice, store } = await setup({ mmQty: "10" });
  await bot.tick();
  setPrice(101.2);
  await bot.tick();
  const target = open().find(o => o.role === "target")!;
  setPrice(100.4);
  await bot.tick();
  const view = bot.view();
  assert.equal(view.recentRoundtrips.length, 1);
  assert.equal(view.recentRoundtrips[0].targetOrderId, target.id);
  assert.equal(view.recentRoundtrips[0].pnl, "0.5");
  assert.ok(view.recentFills.some(f => f.role === "target" && f.orderId === target.id));
  assert.equal((await store.recentRoundtrips(bot.id, 10)).length, 1);
});

test("always refills after a fill even when filled + open exceeds the cap (BTC-TEST case)", async () => {
  const { bot, open, setPrice } = await setup({ steps: 6, mmQty: "6", upperLimit: "120", lowerLimit: "80" });
  await bot.tick();
  assert.equal(open().filter(o => o.role === "entry").length, 6);
  setPrice(101.2);
  await bot.tick(); // sell +1 fills: filled 1 of 6, 5 entries open
  const sells = open().filter(o => o.role === "entry" && o.side === "sell").map(o => o.price).sort();
  assert.deepEqual(sells, ["102", "103", "104"], "next sell level placed");
  assert.equal(bot.rec.status, "running");
});

test("orders that fail to cancel on stop are retried later until canceled", async () => {
  const store = new MemoryStore();
  const adapter = new PaperAdapter(async () => new Decimal(100));
  let failNext = true;
  const realCancel = adapter.cancel.bind(adapter);
  adapter.cancel = async (symbol: string, ids: string[]) => {
    if (failNext) {
      failNext = false;
      return { canceled: ids.slice(1), failed: [{ exchangeOrderId: ids[0], error: "too_many_requests" }] };
    }
    return realCancel(symbol, ids);
  };
  const rec = await store.createBot({ ...base }, "idle");
  const bot = new GridBot(rec, store, adapter, { tickMs: 60_000 });
  await bot.load();
  await bot.tick();
  // Every retry inside the stop fails for the first order: make all 3 attempts fail.
  let attempts = 0;
  adapter.cancel = async (symbol: string, ids: string[]) => {
    attempts++;
    return { canceled: ids.slice(1), failed: [{ exchangeOrderId: ids[0], error: "too_many_requests" }] };
  };
  await bot.kill();
  assert.equal(bot.rec.status, "killed");
  assert.ok(attempts >= 1);
  assert.equal(store.orders.filter(o => o.status === "open").length, 1, "one order left open");
  assert.ok(bot.hasLeftovers);
  assert.match(bot.rec.statusReason ?? "", /could not be canceled/u);

  adapter.cancel = realCancel;
  const remaining = await bot.cleanupLeftovers();
  assert.equal(remaining, 0);
  assert.equal(store.orders.filter(o => o.status === "open").length, 0);
  assert.ok(!bot.hasLeftovers);
  assert.doesNotMatch(bot.rec.statusReason ?? "", /WARNING/u);
});

test("an entry the exchange closed after a partial fill gets a target for the filled part", async () => {
  const store = new MemoryStore();
  let price = new Decimal(100);
  const adapter = new PaperAdapter(async () => price);
  Object.defineProperty(adapter, "live", { value: true });
  let closedId: string | null = null;
  let partial: { id: string; qty: Decimal } | null = null;
  // Fills: only the partial fill we inject; paper crossing is switched off.
  adapter.fillsFor = async (_s, _open, since) => ({
    fills: partial ? [{ exchangeOrderId: partial.id, tradeId: "t-partial", price: new Decimal(101), qty: partial.qty, fee: new Decimal(0), time: Date.now() }] : [],
    cursor: since,
  });
  Object.assign(adapter, {
    openOrderIds: async () => new Set(store.orders.filter(o => o.status === "open" && o.exchangeOrderId !== closedId).map(o => o.exchangeOrderId!)),
  });
  const rec = await store.createBot({ ...base, mmQty: "10" }, "idle");
  const bot = new GridBot(rec, store, adapter, { tickMs: 60_000 });
  await bot.load();
  await bot.tick();
  const sell1 = store.orders.find(o => o.level === 1 && o.role === "entry")!;
  closedId = sell1.exchangeOrderId;
  partial = { id: sell1.exchangeOrderId!, qty: new Decimal("0.4") };

  const realNow = Date.now;
  Date.now = () => realNow() + 60_000; // orders are now old enough to be checked
  try { await bot.tick(); } finally { Date.now = realNow; }

  const after = store.orders.find(o => o.id === sell1.id)!;
  assert.equal(after.status, "canceled");
  assert.equal(after.error, "Closed by the exchange");
  const target = store.orders.find(o => o.role === "target" && o.level === 1);
  assert.equal(target?.side, "buy");
  assert.equal(target?.qty, "0.4");
  assert.equal(target?.price, "100.5");
});
