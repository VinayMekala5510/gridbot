import assert from "node:assert/strict";
import { test } from "node:test";
import Decimal from "decimal.js";
import { AlertMonitor } from "../src/server/alerts";
import { MemoryStore } from "../src/server/store/memory";
import { TelegramNotifier, alertMessage, validateToken } from "../src/server/telegram";

process.env.MASTER_KEY = "33".repeat(32);

function monitor() {
  const store = new MemoryStore();
  let price = new Decimal(100);
  const m = new AlertMonitor(store, async () => price, 60_000);
  return { m, store, setPrice: (p: number) => { price = new Decimal(p); } };
}

test("an alert fires once at the upper limit, calls the notifier, and can be re-armed", async () => {
  const { m, setPrice } = monitor();
  const fired: string[] = [];
  m.onTrigger = async (a, side, price) => { fired.push(`${a.symbol} ${side} ${price}`); return "Sent to Telegram"; };
  await m.create({ exchange: "hyperliquid", symbol: "BTC-PERP", upper: "110", lower: "90" });
  setPrice(105); await m.check();
  assert.equal(m.view()[0].status, "watching");
  setPrice(110.5); await m.check();
  await m.check(); // stays triggered, no second notification
  assert.deepEqual(fired, ["BTC-PERP upper 110.5"]);
  const v = m.view()[0];
  assert.equal(v.status, "triggered_upper");
  assert.equal(v.triggeredPrice, "110.5");
  await new Promise(r => setImmediate(r));
  assert.equal(m.view()[0].notice, "Sent to Telegram");

  await assert.rejects(m.rearm(v.id), /still beyond a limit/u);
  setPrice(100); await m.check();
  await m.rearm(v.id);
  assert.equal(m.view()[0].status, "watching");
  setPrice(89); await m.check();
  assert.equal(m.view()[0].status, "triggered_lower");
  assert.deepEqual(fired, ["BTC-PERP upper 110.5", "BTC-PERP lower 89"]);
});

test("alerts are refused when the price is already beyond a limit or limits are inverted", async () => {
  const { m } = monitor();
  await assert.rejects(m.create({ exchange: "hyperliquid", symbol: "BTC", upper: "99", lower: null }), /already at or above/u);
  await assert.rejects(m.create({ exchange: "hyperliquid", symbol: "BTC", upper: null, lower: "101" }), /already at or below/u);
  await assert.rejects(m.create({ exchange: "hyperliquid", symbol: "BTC", upper: "90", lower: "95" }), /below the upper/u);
  await assert.rejects(m.create({ exchange: "hyperliquid", symbol: "BTC", upper: null, lower: null }), /upper limit, a lower limit, or both/u);
  const one = await m.create({ exchange: "hyperliquid", symbol: "BTC", upper: "120", lower: null });
  assert.equal(one.upper, "120");
  assert.equal(one.lower, null);
});

test("Telegram: token check, encrypted storage and message sent to the saved chat", async () => {
  assert.throws(() => validateToken("nope"), /bot token/u);
  const store = new MemoryStore();
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    calls.push({ url, body });
    const result = url.endsWith("/getMe") ? { username: "gridbot_alerts_bot" }
      : url.endsWith("/getUpdates") ? [{ message: { chat: { id: 987654321, first_name: "Vinay" } } }] : true;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  }) as typeof fetch;
  try {
    const tg = new TelegramNotifier(store);
    await tg.init();
    const token = "123456789:" + "A".repeat(35);
    await tg.save({ token });
    assert.ok(!(await store.getSetting("telegram.token"))!.includes("AAAA"), "token stored encrypted");
    const s = await tg.detectChat();
    assert.equal(s.chatId, "987654321");
    assert.equal(s.chatName, "Vinay");
    assert.equal(s.configured, true);
    await tg.send(alertMessage({ symbol: "BTC-PERP", exchangeLabel: "Hyperliquid", side: "upper", price: "72010", upper: "72000", lower: "60000", time: Date.UTC(2026, 10, 21, 14, 5, 12) }));
    const sent = calls.find(c => c.url.endsWith("/sendMessage"))!;
    assert.equal(sent.body.chat_id, "987654321");
    assert.equal(sent.body.parse_mode, "HTML");
    assert.match(String(sent.body.text), /BTC-PERP.*\n.*rose to <b>72010<\/b>.*upper limit <b>72000<\/b>/su);
    assert.match(String(sent.body.text), /2026-11-21 14:05:12 UTC/u);

    const reloaded = new TelegramNotifier(store); // survives a restart
    await reloaded.init();
    assert.equal(reloaded.status().configured, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});
