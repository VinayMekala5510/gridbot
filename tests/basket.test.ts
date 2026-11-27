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

// ── Square-off safety: the exchange's order record decides, never the (possibly late) trade feed ──

type MarketMode = "late-fill" | "rest-then-cancel" | "stuck" | "reply-lost" | "dust" | "big-left" | "full" | "none";

/** Paper venue whose market orders behave like the Deribit testnet incident. */
class TrickyVenue extends PaperAdapter {
  placed: { id: string; qty: string; clientId: string }[] = [];
  private states = new Map<string, { filled: Decimal; avg: Decimal | null; open: boolean; qty: Decimal }>();
  constructor(public mode: MarketMode, private readonly px: () => Decimal) { super(async () => px()); }

  override async placeMarket(req: { symbol: string; side: "buy" | "sell"; qty: Decimal; clientId: string; refPrice: Decimal }) {
    const id = `mkt-${this.placed.length + 1}`;
    this.placed.push({ id, qty: req.qty.toFixed(), clientId: req.clientId });
    const first = this.placed.length === 1;
    if (this.mode === "late-fill") this.states.set(id, { filled: req.qty, avg: new Decimal("102.5"), open: false, qty: req.qty });
    else if (this.mode === "rest-then-cancel" && first) this.states.set(id, { filled: new Decimal("0.5"), avg: new Decimal(102), open: true, qty: req.qty });
    else if (this.mode === "stuck") this.states.set(id, { filled: new Decimal(0), avg: null, open: true, qty: req.qty });
    else if (this.mode === "dust" || this.mode === "big-left") {
      const short = new Decimal(this.mode === "dust" ? "0.3" : "0.6");
      this.states.set(id, { filled: Decimal.max(0, req.qty.minus(short)), avg: new Decimal(102), open: false, qty: req.qty });
    } else if (this.mode === "none") this.states.set(id, { filled: new Decimal(0), avg: null, open: false, qty: req.qty }); // nothing within the cap
    else this.states.set(id, { filled: req.qty, avg: new Decimal(102), open: false, qty: req.qty });
    if (this.mode === "reply-lost") throw new Error("socket hang up"); // sent, but the reply never arrived
    return { exchangeOrderId: id };
  }
  override async lookupByClientId(_s: string, clientId: string) {
    return this.placed.find(p => p.clientId === clientId)?.id ?? null;
  }
  override async orderState(_s: string, id: string) {
    const st = this.states.get(id);
    if (!st) return super.orderState(_s, id);
    return { filledQty: st.filled, avgPrice: st.avg, open: st.open };
  }
  override async cancel(symbol: string, ids: string[]) {
    for (const id of ids) {
      const st = this.states.get(id);
      if (st && this.mode !== "stuck") st.open = false;
    }
    return super.cancel(symbol, ids);
  }
  override async fillsFor(symbol: string, open: Parameters<PaperAdapter["fillsFor"]>[1], since: number) {
    // The trade feed never shows market-order trades (they "arrive late").
    return super.fillsFor(symbol, open.filter(o => !this.states.has(o.exchangeOrderId)), since);
  }
}

async function tricky(mode: MarketMode) {
  const store = new MemoryStore();
  let price = new Decimal(100);
  const venue = new TrickyVenue(mode, () => price);
  const rec = await store.createBot({ ...base }, "idle");
  const bot = new GridBot(rec, store, venue, { tickMs: 60_000 });
  await bot.load();
  const at = async (p: number) => { price = new Decimal(p); await bot.tick(); };
  await at(100);
  await at(101);
  await at(102); // short 2 → basket distance reached → square-off BUY 2
  return { store, bot, venue, baskets: () => [...store.baskets].sort((a, b) => a.index - b.index) };
}

test("square-off filled on the exchange but missing from the trade feed: one order only, booked from the order record", async () => {
  const { venue, baskets, store, bot } = await tricky("late-fill");
  assert.equal(venue.placed.length, 1, "no second order is sent");
  const b1 = baskets()[0];
  assert.equal(b1.status, "closed");
  assert.equal(b1.squareoffQty, "2");
  assert.equal(b1.squareoffPrice, "102.5");
  assert.equal(b1.squareoffPnl, "-2"); // (101 − 102.5) + (102 − 102.5)
  assert.ok(store.fills.some(f => f.role === "squareoff" && f.tradeId.endsWith(":order-state") && f.qty === "2"));
  assert.equal(bot.rec.status, "running");
});

test("square-off left resting by the venue is canceled and confirmed before the rest is sent", async () => {
  const { venue, baskets } = await tricky("rest-then-cancel");
  assert.deepEqual(venue.placed.map(p => p.qty), ["2", "1.5"], "second order is only the part the first did not fill");
  const b1 = baskets()[0];
  assert.equal(b1.squareoffQty, "2");
  assert.equal(b1.status, "closed");
});

test("square-off order that stays open and cannot be canceled stops the bot without sending another", async () => {
  const { venue, bot } = await tricky("stuck");
  assert.equal(venue.placed.length, 1);
  assert.equal(bot.rec.status, "error");
  assert.match(bot.rec.statusReason ?? "", /still open on the exchange and could not be canceled/u);
});

test("square-off whose reply was lost is found by its client id instead of being sent twice", async () => {
  const { venue, baskets } = await tricky("reply-lost");
  assert.equal(venue.placed.length, 1);
  assert.equal(baskets()[0].squareoffQty, "2");
  assert.equal(baskets()[0].status, "closed");
});

// ── Small leftovers (< 0.5) are carried into the next basket instead of stopping the bot ──

async function walk(mode: MarketMode) {
  const store = new MemoryStore();
  let price = new Decimal(100);
  const venue = new TrickyVenue(mode, () => price);
  const rec = await store.createBot({ ...base }, "idle");
  const bot = new GridBot(rec, store, venue, { tickMs: 60_000 });
  await bot.load();
  const at = async (p: number) => { price = new Decimal(p); await bot.tick(); };
  return { store, bot, venue, at, baskets: () => [...store.baskets].sort((a, b) => a.index - b.index) };
}

test("leftover under 0.5 after square-off is carried into the next basket and closed with it", async () => {
  const { at, bot, venue, baskets } = await walk("dust");
  await at(100);
  await at(101);
  await at(102); // short 2 → BUY 2 fills only 1.7, retries fill nothing → 0.3 left
  assert.equal(bot.rec.status, "running", "the bot keeps running");
  const [b1, b2] = baskets();
  assert.equal(b1.status, "closed");
  assert.equal(b1.squareoffQty, "1.7");
  assert.equal(b2.carryInSide, "sell");   // still short 0.3
  assert.equal(b2.carryInQty, "0.3");
  assert.equal(b2.carryInPrice, "102");
  assert.equal(bot.view().basket?.current?.carryInQty, "0.3");

  venue.mode = "full";
  await at(103);
  await at(104); // basket 2: sells 103, 104 fill; moved 2 → BUY 2 + carried 0.3
  const b2done = baskets()[1];
  assert.equal(b2done.status, "closed");
  assert.equal(b2done.squareoffSide, "buy");
  assert.equal(b2done.squareoffQty, "2.3");
  assert.equal(baskets()[2].carryInQty, "0", "nothing left to carry");
  // Carried part is valued from 102 (basket 1 close) to 102 (basket 2 close): no double counting.
  // basket 1: (101 − 102) + (102 − 102) = −1 ; basket 2: (103 − 102) + (104 − 102) + 0.3 × (102 − 102) = 3
  assert.equal(b1.squareoffPnl, "-1");
  assert.equal(b2done.squareoffPnl, "3");
});

test("a leftover that keeps failing is carried again, basket after basket", async () => {
  const { at, bot, baskets } = await walk("dust");
  await at(100);
  await at(101);
  await at(102); // basket 1 → 0.3 carried
  await at(103);
  await at(104); // basket 2: BUY 2.3 fills 2.0 → 0.3 carried again
  assert.equal(bot.rec.status, "running");
  assert.equal(baskets()[1].squareoffQty, "2");
  assert.equal(baskets()[2].carryInQty, "0.3");
});

test("leftover of 0.5 or more (but within one basket qty) is carried too", async () => {
  const { at, bot, baskets } = await walk("big-left");
  await at(100);
  await at(101);
  await at(102); // BUY 2 fills 1.4 → 0.6 left; basket qty is 4
  assert.equal(bot.rec.status, "running");
  assert.equal(baskets()[1].carryInQty, "0.6");
});

test("nothing fills within the 0.2% cap: up to one basket qty is carried; more than that stops the bot", async () => {
  // Market making qty 10 → 5 baskets × 2 qty.
  const store = new MemoryStore();
  let price = new Decimal(100);
  const venue = new TrickyVenue("none", () => price);
  const rec = await store.createBot({ ...base, mmQty: "10" }, "idle");
  const bot = new GridBot(rec, store, venue, { tickMs: 60_000 });
  await bot.load();
  const at = async (p: number) => { price = new Decimal(p); await bot.tick(); };
  await at(100);
  await at(101);
  await at(102); // short 2 = basket qty → square off; nothing fills → carry short 2 (= one basket qty)
  assert.equal(bot.rec.status, "running");
  assert.equal(venue.placed.length, 3, "3 tries, each at the latest price");
  const b2 = [...store.baskets].sort((a, b) => a.index - b.index)[1];
  assert.equal(b2.carryInQty, "2");
  await at(103);
  await at(104); // basket 2 full again: short 2 + carried 2 = 4 > 2 → stop
  assert.equal(bot.rec.status, "error");
  assert.match(bot.rec.statusReason ?? "", /BUY 4 could not be executed within the 0.2% price cap, more than one basket.s qty \(2\)/u);
});

// ── Exchange pauses (Deribit's daily settlement) are waited out, never counted as failures ──

/** Paper venue that answers "settlement_in_progress" to the next N placements / cancels. */
class SettlingVenue extends PaperAdapter {
  placeRefusals = 0;
  cancelRefusals = 0;
  constructor(px: () => Decimal) { super(async () => px()); }
  override async placeLimit(req: Parameters<PaperAdapter["placeLimit"]>[0]) {
    if (this.placeRefusals > 0) { this.placeRefusals--; throw new Error("Deribit: settlement_in_progress"); }
    return super.placeLimit(req);
  }
  override async placeMarket(req: Parameters<PaperAdapter["placeMarket"]>[0]) {
    if (this.placeRefusals > 0) { this.placeRefusals--; throw new Error("Deribit: settlement_in_progress"); }
    return super.placeMarket(req);
  }
  override async cancel(symbol: string, ids: string[]) {
    if (this.cancelRefusals > 0) {
      this.cancelRefusals--;
      return { canceled: [], failed: ids.map(id => ({ exchangeOrderId: id, error: "Deribit: settlement_in_progress" })) };
    }
    return super.cancel(symbol, ids);
  }
}

async function settling(overrides: Partial<BotConfig> = {}) {
  const store = new MemoryStore();
  let price = new Decimal(100);
  const venue = new SettlingVenue(() => price);
  const rec = await store.createBot({ ...base, ...overrides }, "idle");
  const bot = new GridBot(rec, store, venue, { tickMs: 60_000, pauseRetryMs: 1 });
  await bot.load();
  const at = async (p: number) => { price = new Decimal(p); await bot.tick(); };
  return { store, bot, venue, at, open: () => store.orders.filter(o => o.status === "open") };
}

test("settlement while placing orders: the bot waits and carries on, no 5-failures stop", async () => {
  const { bot, venue, at, open, store } = await settling();
  venue.placeRefusals = 12; // more than the 5-failures limit
  await at(100);
  assert.equal(bot.rec.status, "running");
  assert.equal(open().filter(o => o.role === "entry").length, 6);
  assert.equal(store.orders.filter(o => o.status === "rejected").length, 0);
  assert.equal(store.events.filter(e => /Exchange is paused/u.test(e.message)).length, 1, "one note, not one per retry");
});

test("settlement while cancelling on a stop: cancels are retried until they go through", async () => {
  const { bot, venue, at, open } = await settling();
  await at(100);
  venue.cancelRefusals = 6; // more than the 3 normal cancel tries
  await bot.kill("test stop");
  assert.equal(bot.rec.status, "killed");
  assert.equal(open().length, 0);
  assert.doesNotMatch(bot.rec.statusReason ?? "", /could not be canceled/u);
});

test("settlement during a square-off: cancels and the closing order wait, then the basket closes normally", async () => {
  const { bot, venue, at, open, store } = await settling();
  await at(100);
  await at(101);
  venue.cancelRefusals = 4;
  venue.placeRefusals = 4; // the square-off order, then the next basket's entries
  await at(102);
  assert.equal(bot.rec.status, "running");
  const b1 = store.baskets.find(b => b.index === 1)!;
  assert.equal(b1.status, "closed");
  assert.equal(b1.squareoffQty, "2");
  assert.equal(open().filter(o => o.role === "entry").length, 6);
});

test("a real placement error still stops the bot after 5 in a row", async () => {
  const store = new MemoryStore();
  const venue = new PaperAdapter(async () => new Decimal(100));
  Object.assign(venue, { placeLimit: async () => { throw new Error("Deribit: not_enough_funds"); } });
  const rec = await store.createBot({ ...base }, "idle");
  const bot = new GridBot(rec, store, venue, { tickMs: 60_000, pauseRetryMs: 1 });
  await bot.load();
  for (let i = 0; i < 5; i++) await bot.tick(); // one rejected placement per tick
  assert.equal(bot.rec.status, "error");
  assert.match(bot.rec.statusReason ?? "", /5 order placements failed in a row/u);
});
