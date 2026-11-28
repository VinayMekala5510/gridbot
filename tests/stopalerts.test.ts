import assert from "node:assert/strict";
import { test } from "node:test";
import Decimal from "decimal.js";
import { encryptSecret } from "../src/server/crypto";
import { BotManager } from "../src/server/engine/manager";
import { PaperAdapter } from "../src/server/exchanges/paper";
import { MemoryStore } from "../src/server/store/memory";
import { botStoppedMessage } from "../src/server/telegram";
import type { BotConfig } from "../src/shared/types";

process.env.MASTER_KEY = "44".repeat(32);

const base: BotConfig = {
  name: "btctest20", exchange: "deribit-testnet", mode: "paper", accountId: null, symbol: "BTC-PERPETUAL",
  spread: "1", targetSpread: "0.5", steps: 3, stepQty: "1", mmQty: "4",
  upperLimit: "110", lowerLimit: "90", entryPrice: "100",
};

/** Manager on a paper venue with a controllable price; Telegram calls are captured, not sent. */
async function setup(opts: { telegram: boolean }) {
  const store = new MemoryStore();
  if (opts.telegram) {
    await store.setSetting("telegram.token", encryptSecret("123456789:" + "A".repeat(35)));
    await store.setSetting("telegram.chatId", "987654321");
  }
  let price = new Decimal(100);
  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (String(url).endsWith("/sendMessage")) sent.push(String(JSON.parse(String(init.body)).text));
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  }) as typeof fetch;
  const manager = new BotManager(store, { tickMs: 15, adapterFactory: () => new PaperAdapter(async () => price) });
  await manager.init();
  const waitFor = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setTimeout(r, 10));
  };
  return {
    manager, sent, waitFor, setPrice: (p: number) => { price = new Decimal(p); },
    done: () => { manager.shutdown(); globalThis.fetch = realFetch; },
  };
}

test("kill switch → Telegram message with bot name, symbol, reason and PnL", async () => {
  const t = await setup({ telegram: true });
  try {
    const id = await t.manager.createBot({ ...base });
    await t.manager.stopBot(id);
    await t.waitFor(() => t.sent.length > 0);
    assert.equal(t.sent.length, 1);
    const msg = t.sent[0];
    assert.match(msg, /Bot stopped · btctest20/u);
    assert.match(msg, /BTC-PERPETUAL · Deribit Testnet · PAPER · step-grid/u);
    assert.match(msg, /Reason:<\/b> Stopped manually \(kill switch\)/u);
    assert.match(msg, /Stopped with the instance kill switch/u);
    assert.match(msg, /RTP PnL:<\/b> 0 \(0 roundtrips\)/u);
    assert.doesNotMatch(msg, /Square-off PnL/u, "step-grid has no square-off PnL");
    assert.match(msg, /Open position: none/u);
  } finally { t.done(); }
});

test("price limit breach with a filled entry → message warns about the open position", async () => {
  const t = await setup({ telegram: true });
  try {
    await t.manager.createBot({ ...base });
    await t.waitFor(() => false || t.sent.length > 0); // let it place its orders
    t.setPrice(99);   // buy entry at 99 fills → long 1
    await new Promise(r => setTimeout(r, 100));
    t.setPrice(89);   // below the lower limit 90 → stops
    await t.waitFor(() => t.sent.length > 0);
    const msg = t.sent[0];
    assert.match(msg, /Reason:<\/b> Price limit breached/u);
    assert.match(msg, /fell below the lower limit 90/u);
    assert.match(msg, /Open position:<\/b> LONG \d+ BTC-PERPETUAL is still open \(paper\)/u);
  } finally { t.done(); }
});

test("no Telegram set up → bots stop normally and nothing is sent", async () => {
  const t = await setup({ telegram: false });
  try {
    const id = await t.manager.createBot({ ...base });
    await t.manager.stopBot(id);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(t.sent.length, 0);
  } finally { t.done(); }
});

test("basket-grid stop message shows RTP and Square-off PnL separately, plus orders still open", () => {
  const msg = botStoppedMessage({
    name: "hypetest22", symbol: "HYPE_USDC-PERPETUAL", exchangeLabel: "Deribit Testnet", mode: "live", gridModel: "basket-grid",
    status: "halted_total_distance", reason: "Total distance reached: price 59.5 is 2 from the entry price 61.5",
    rtpPnl: "0.429", roundtrips: 2, squareoffPnl: "-0.30461", basketsClosed: 5,
    netPosition: "-1.87", ordersStillOpen: 2, time: Date.UTC(2026, 10, 28, 8, 0, 29),
  });
  assert.match(msg, /Reason:<\/b> Total distance reached/u);
  assert.match(msg, /RTP PnL:<\/b> \+0\.429 \(2 roundtrips\)/u);
  assert.match(msg, /Square-off PnL:<\/b> -0\.30461 \(5 baskets closed\)/u);
  assert.match(msg, /Open position:<\/b> SHORT 1\.87 HYPE_USDC-PERPETUAL is still open on the exchange/u);
  assert.match(msg, /2 order\(s\)<\/b> could not be canceled yet/u);
  assert.match(msg, /2026-11-28 08:00:29 UTC/u);
});
