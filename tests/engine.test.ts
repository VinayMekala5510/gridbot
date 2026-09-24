import assert from "node:assert/strict";
import { test } from "node:test";
import { GridEngine } from "../src/lib/grid/engine";
import { simulate } from "../src/lib/grid/simulate";
import type { Config } from "../src/lib/grid/types";

const config: Config = { anchor: "100", interval: "10", quantity: "1",
  maxSteps: 10, spacing: "absolute", baseOverflow: "pending" };
function started(overrides: Partial<Config> = {}) {
  const engine = new GridEngine({ ...config, ...overrides });
  engine.start(); return engine;
}

test("starts with two buys and two sells", () => {
  const engine = started();
  assert.deepEqual(engine.snapshot().orders.map(o => [o.side, o.price]),
    [["buy", "90"], ["buy", "80"], ["sell", "110"], ["sell", "120"]]);
  assert.throws(() => engine.start());
});

test("buy and sell fills create opposite target and next outer base", () => {
  for (const [id, expected] of [
    ["grid-1", [["sell", "target", "100"], ["buy", "base", "70"]]],
    ["grid-3", [["buy", "target", "100"], ["sell", "base", "130"]]],
  ] as const) {
    const engine = started();
    const actions = engine.onFill(id, "1");
    const orders = actions.map(a => engine.snapshot().orders.find(o => o.id === a.orderId)!);
    assert.deepEqual(orders.map(o => [o.side, o.role, o.price]), expected);
    assert.equal(engine.snapshot().filledSteps, 1);
  }
});

test("partial, old and duplicate fill updates do not double count", () => {
  const engine = started();
  assert.deepEqual(engine.onFill("grid-1", "0.5"), []);
  assert.deepEqual(engine.onFill("grid-1", "0.2"), []);
  assert.equal(engine.snapshot().filledSteps, 0);
  engine.onFill("grid-1", "1");
  assert.deepEqual(engine.onFill("grid-1", "1"), []);
  assert.equal(engine.snapshot().filledSteps, 1);
});

test("limit suppresses replacements and waits for cancellation confirmations", () => {
  const engine = started({ maxSteps: 1 });
  const actions = engine.onFill("grid-1", "1");
  assert.equal(actions.length, 3);
  assert(actions.every(a => a.kind === "cancel"));
  assert.equal(engine.snapshot().status, "stopping");
  assert.deepEqual(engine.onFill("grid-2", "1"), []);
  assert.equal(engine.snapshot().filledSteps, 2);
  engine.confirmCancel("grid-3"); engine.confirmCancel("grid-4");
  assert.equal(engine.snapshot().status, "stopped");
  assert.equal(engine.snapshot().stopReason, "max_steps");
});

test("pending policy stops at target-fill conflict", () => {
  const result = simulate({ config, fills: [
    { orderId: "grid-1", cumulativeQuantity: "1" },
    { orderId: "grid-5", cumulativeQuantity: "1" },
  ] });
  assert.equal(result.status, "stopped");
  assert.equal(result.stopReason, "base_order_policy_required");
  assert.equal(result.filledSteps, 2);
  assert.equal(result.orders.length, 0);
});

test("target fills create both replacements with explicit overflow choice", () => {
  for (const policy of ["cancel-nearest", "cancel-farthest", "allow"] as const) {
    const result = simulate({ config: { ...config, baseOverflow: policy }, fills: [
      { orderId: "grid-1", cumulativeQuantity: "1" },
      { orderId: "grid-5", cumulativeQuantity: "1" },
    ] });
    assert.equal(result.filledSteps, 2);
    assert.equal(result.status, "running");
    assert.equal(result.orders.filter(o => o.side === "buy" && o.role === "base").length, 2);
    assert.equal(result.orders.filter(o => o.side === "sell" && o.role === "base").length, policy === "allow" ? 3 : 2);
    assert(result.orders.some(o => o.role === "target" && o.side === "buy" && o.price === "90"));
    assert(result.orders.some(o => o.role === "base" && o.side === "sell" && o.price === "130"));
    if (policy !== "allow") assert(!result.orders.some(o => o.id === (policy === "cancel-nearest" ? "grid-3" : "grid-4")));
  }
});

test("decimal prices and percentage grid avoid binary arithmetic", () => {
  const fixed = started({ anchor: "0.3", interval: "0.1" });
  assert.equal(fixed.price(-1), "0.2");
  const percent = started({ spacing: "percentage", interval: "0.01" });
  assert.equal(percent.price(1), "101");
  assert.equal(percent.price(2), "102.01");
  assert.equal(percent.price(0), "100");
});

test("invalid next base price cancels without replacements", () => {
  const engine = started({ anchor: "25" });
  const actions = engine.onFill("grid-1", "1");
  assert(actions.every(a => a.kind === "cancel"));
  assert.equal(engine.snapshot().stopReason, "invalid_next_grid_price");
});

test("rejects invalid configuration and fill quantities", () => {
  for (const override of [{ anchor: "20" }, { quantity: "0" }, { anchor: "NaN" }, { maxSteps: 0 }]) {
    assert.throws(() => started(override));
  }
  const engine = started();
  for (const amount of ["NaN", "-1", "2"]) assert.throws(() => engine.onFill("grid-1", amount));
  assert.throws(() => engine.onFill("unknown", "1"));
  assert.equal(engine.snapshot().filledSteps, 0);
});

test("manual stop cancels orders and stateless requests remain isolated", () => {
  assert.equal(simulate({ config, fills: [], stop: true }).status, "stopped");
  assert.equal(simulate({ config, fills: [] }).orders.length, 4);
});
