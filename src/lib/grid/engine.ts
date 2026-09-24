import Decimal from "decimal.js";
import { configSchema } from "./config";
import type { Action, Config, Order, Side, Snapshot } from "./types";

const D = Decimal.clone({ precision: 40 });

/** Strategy intents only. Exchange acknowledgements belong in a future adapter. */
export class GridEngine {
  private readonly config: Config;
  private orders = new Map<string, Order>();
  private completed = new Set<string>();
  private serial = 0;
  private low = -2;
  private high = 2;
  private status: Snapshot["status"] = "new";
  private filledSteps = 0;
  private stopReason: string | null = null;

  constructor(config: Config) { this.config = configSchema.parse(config); }

  price(level: number): string {
    const { anchor, interval, spacing } = this.config;
    const value = spacing === "absolute"
      ? new D(anchor).plus(new D(interval).times(level))
      : new D(anchor).times(new D(1).plus(interval).pow(level));
    if (!value.isFinite() || value.lte(0)) throw new Error("Invalid next grid price");
    return value.toFixed();
  }

  snapshot(): Snapshot {
    return { status: this.status, filledSteps: this.filledSteps,
      stopReason: this.stopReason, orders: [...this.orders.values()].map(o => ({ ...o })) };
  }

  private place(side: Side, role: Order["role"], level: number): Action {
    const price = this.price(level);
    const id = `grid-${++this.serial}`;
    this.orders.set(id, { id, side, role, level, price,
      quantity: this.config.quantity, filled: "0", cancelPending: false });
    return { kind: "place", orderId: id };
  }

  start(): Action[] {
    if (this.status !== "new") throw new Error("Engine already started");
    this.status = "running";
    return [this.place("buy", "base", -1), this.place("buy", "base", -2),
      this.place("sell", "base", 1), this.place("sell", "base", 2)];
  }

  onFill(orderId: string, cumulativeQuantity: string): Action[] {
    if (this.completed.has(orderId)) return [];
    if (this.status !== "running" && this.status !== "stopping") {
      throw new Error("Engine is not accepting fills");
    }
    const order = this.orders.get(orderId);
    if (!order) throw new Error("Unknown order");
    const filled = new D(cumulativeQuantity);
    if (!filled.isFinite() || filled.lt(0) || filled.gt(order.quantity)) {
      throw new Error("Invalid cumulative fill quantity");
    }
    if (filled.lte(order.filled)) return [];
    order.filled = filled.toFixed();
    if (filled.lt(order.quantity)) return [];
    this.orders.delete(orderId);
    this.completed.add(orderId);
    this.filledSteps++;
    if (this.status === "stopping") { this.finishStop(); return []; }
    if (this.filledSteps >= this.config.maxSteps) return this.stop("max_steps");

    const target = order.level + (order.side === "buy" ? 1 : -1);
    const base = order.side === "buy" ? this.low - 1 : this.high + 1;
    const existing = [...this.orders.values()].filter(o =>
      o.side === order.side && o.role === "base" && !o.cancelPending);
    if (existing.length >= 2 && this.config.baseOverflow === "pending") {
      return this.stop("base_order_policy_required");
    }
    try { this.price(target); this.price(base); }
    catch { return this.stop("invalid_next_grid_price"); }

    const actions: Action[] = [];
    if (existing.length >= 2 && this.config.baseOverflow !== "allow") {
      // Nearest/farthest uses the filled order price as the reference.
      existing.sort((a, b) => new D(a.price).minus(order.price).abs()
        .cmp(new D(b.price).minus(order.price).abs()));
      if (this.config.baseOverflow === "cancel-farthest") existing.reverse();
      for (const excess of existing.slice(0, existing.length - 1)) {
        excess.cancelPending = true;
        actions.push({ kind: "cancel", orderId: excess.id });
      }
    }
    actions.push(this.place(order.side === "buy" ? "sell" : "buy", "target", target));
    actions.push(this.place(order.side, "base", base));
    if (order.side === "buy") this.low = base;
    else this.high = base;
    return actions;
  }

  stop(reason = "manual"): Action[] {
    if (this.status === "stopped") return [];
    this.status = "stopping";
    this.stopReason ??= reason;
    const actions = [...this.orders.values()].map(order => {
      order.cancelPending = true;
      return { kind: "cancel" as const, orderId: order.id };
    });
    this.finishStop();
    return actions;
  }

  confirmCancel(orderId: string): void {
    const order = this.orders.get(orderId);
    if (!order) return;
    if (!order.cancelPending) throw new Error("Cancellation was not requested");
    this.orders.delete(orderId);
    this.finishStop();
  }

  private finishStop(): void {
    if (this.status === "stopping" && this.orders.size === 0) this.status = "stopped";
  }
}
