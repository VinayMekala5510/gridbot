import assert from "node:assert/strict";
import { test } from "node:test";
import Decimal from "decimal.js";
import { roundHyperliquidPrice, wire, validateAddress, validatePrivateKey } from "../src/server/exchanges/hyperliquid";
import { hyperliquidCoin, resolveHyperliquidCoin } from "../src/server/exchanges/prices";

process.env.MASTER_KEY = "11".repeat(32);

test("Hyperliquid price rounding follows the 5 significant figure / decimal rules", () => {
  assert.equal(roundHyperliquidPrice(new Decimal("95000.55"), 5, "sell").toFixed(), "95001");
  assert.equal(roundHyperliquidPrice(new Decimal("95000.55"), 5, "buy").toFixed(), "95000");
  assert.equal(roundHyperliquidPrice(new Decimal("3456.789"), 4, "buy").toFixed(), "3456.7");
  assert.equal(roundHyperliquidPrice(new Decimal("1.234567"), 0, "sell").toFixed(), "1.2346");
  assert.equal(roundHyperliquidPrice(new Decimal("0.000123456"), 0, "buy").toFixed(), "0.000123");
});

test("wire format strips trailing zeros", () => {
  assert.equal(wire(new Decimal("100.500")), "100.5");
  assert.equal(wire(new Decimal("100.000")), "100");
  assert.equal(wire(new Decimal("0.001")), "0.001");
});

test("symbol normalisation for Hyperliquid perps", () => {
  assert.equal(hyperliquidCoin("ETH-PERP"), "ETH");
  assert.equal(resolveHyperliquidCoin("eth-perp", ["BTC", "ETH"]), "ETH");
  assert.equal(resolveHyperliquidCoin("KPEPE-PERP", ["kPEPE"]), "kPEPE");
  assert.equal(resolveHyperliquidCoin("NOPE", ["BTC"]), null);
  assert.equal(hyperliquidCoin("BTC/USDC"), "BTC");
  assert.equal(hyperliquidCoin("SOL"), "SOL");
});

test("key validation", () => {
  assert.throws(() => validatePrivateKey("abc"));
  assert.equal(validatePrivateKey("a".repeat(64)), `0x${"a".repeat(64)}`);
  assert.throws(() => validateAddress("0x123"));
});

test("secrets round-trip through AES-GCM", async () => {
  const { encryptSecret, decryptSecret } = await import("../src/server/crypto");
  const sealed = encryptSecret("super-secret");
  assert.notEqual(sealed, "super-secret");
  assert.equal(decryptSecret(sealed), "super-secret");
});
