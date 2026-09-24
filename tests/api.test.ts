import assert from "node:assert/strict";
import { test } from "node:test";
import { POST } from "../src/app/api/simulate/route";

function request(body: string) {
  return new Request("http://localhost/api/simulate", { method: "POST", body });
}
test("simulation endpoint returns initial grid", async () => {
  const response = await POST(request(JSON.stringify({ config: {
    anchor: "100", interval: "10", quantity: "1", maxSteps: 10,
    spacing: "absolute", baseOverflow: "pending",
  }, fills: [] })));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).orders.length, 4);
});
test("simulation endpoint rejects malformed and oversized requests", async () => {
  assert.equal((await POST(request("{"))).status, 400);
  assert.equal((await POST(request("{}"))).status, 400);
  assert.equal((await POST(request("x".repeat(100001)))).status, 413);
});
