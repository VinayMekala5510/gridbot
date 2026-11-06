import assert from "node:assert/strict";
import { test } from "node:test";
import { Wallet } from "ethers";
import { BotManager } from "../src/server/engine/manager";
import { verifyHyperliquidKey } from "../src/server/exchanges/hyperliquid";
import { MemoryStore } from "../src/server/store/memory";

process.env.MASTER_KEY = "22".repeat(32);

test("a wallet's own private key is accepted without a network call", async () => {
  const w = Wallet.createRandom();
  assert.equal(await verifyHyperliquidKey("hyperliquid-testnet", w.address, w.privateKey), "wallet");
});

test("account needs only address + key; name defaults to network and short address", async () => {
  const store = new MemoryStore();
  const manager = new BotManager(store, { verifyKey: async () => "api-wallet" });
  const w = Wallet.createRandom();
  const view = await manager.createAccount({ name: "", exchange: "hyperliquid-testnet", publicKey: w.address, secret: w.privateKey });
  const addr = w.address.toLowerCase();
  assert.equal(view.name, `Hyperliquid Testnet ${addr.slice(0, 6)}…${addr.slice(-4)}`);
  assert.ok(!store.accounts[0].secretEnc.includes(w.privateKey.slice(2)), "secret stored encrypted");
  await assert.rejects(
    manager.createAccount({ name: "", exchange: "hyperliquid-testnet", publicKey: w.address, secret: w.privateKey }),
    /already saved/u);
});

test("a key the exchange rejects is not saved", async () => {
  const store = new MemoryStore();
  const manager = new BotManager(store, { verifyKey: async () => { throw new Error("not an approved API wallet"); } });
  const w = Wallet.createRandom();
  await assert.rejects(
    manager.createAccount({ name: "x", exchange: "hyperliquid", publicKey: Wallet.createRandom().address, secret: w.privateKey }),
    /not an approved API wallet/u);
  assert.equal(store.accounts.length, 0);
});

test("paper-only exchanges cannot store accounts", async () => {
  const manager = new BotManager(new MemoryStore(), { verifyKey: async () => "wallet" });
  const w = Wallet.createRandom();
  await assert.rejects(
    manager.createAccount({ name: "b", exchange: "bybit", publicKey: w.address, secret: w.privateKey }),
    /not supported yet/u);
});

test("Binance accounts take an API key and secret", async () => {
  const store = new MemoryStore();
  const manager = new BotManager(store, { verifyKey: async () => undefined });
  const key = "A1".repeat(32), secret = "b2".repeat(32);
  const view = await manager.createAccount({ name: "", exchange: "binance", publicKey: key, secret });
  assert.equal(view.name, `Binance ${key.slice(0, 6)}…${key.slice(-4)}`);
  await assert.rejects(
    manager.createAccount({ name: "x", exchange: "binance", publicKey: "short", secret }),
    /API key should be/u);
});
