import { simulationSchema } from "./config";
import { GridEngine } from "./engine";
import type { Action, Simulation } from "./types";

/** Stateless replay: no shared accounts, timers, wallet keys or exchange calls. */
export function simulate(input: unknown): Simulation {
  const { config, fills, stop } = simulationSchema.parse(input);
  const engine = new GridEngine(config);
  const logs: string[] = [];
  function execute(actions: Action[]) {
    for (const action of actions) {
      const order = engine.snapshot().orders.find(o => o.id === action.orderId);
      logs.push(`${action.kind}: ${action.orderId}${order ? ` ${order.side} ${order.role} ${order.quantity} @ ${order.price}` : ""}`);
      if (action.kind === "cancel") engine.confirmCancel(action.orderId);
    }
  }
  execute(engine.start());
  for (const fill of fills) {
    logs.push(`fill update: ${fill.orderId}, cumulative ${fill.cumulativeQuantity}`);
    execute(engine.onFill(fill.orderId, fill.cumulativeQuantity));
  }
  if (stop) execute(engine.stop());
  if (engine.snapshot().stopReason) logs.push(`stopped: ${engine.snapshot().stopReason}`);
  return { ...engine.snapshot(), logs };
}
