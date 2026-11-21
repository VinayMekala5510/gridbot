import Decimal from "decimal.js";
import type { ExchangeId, PriceAlertView } from "../shared/types";
import { fetchPrice } from "./exchanges/prices";
import type { AlertRecord, Store } from "./store/types";

export class AlertError extends Error {}

/**
 * Price alerts: the server checks every few seconds, whether or not the dashboard is open.
 * An alert fires once when the price reaches its upper limit (price ≥ upper) or its lower
 * limit (price ≤ lower), then stays "triggered" until re-armed or deleted.
 */
export class AlertMonitor {
  private alerts = new Map<number, AlertRecord>();
  private prices = new Map<number, { price: string; at: number }>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** What happened with the notification for each fired alert (e.g. "Sent to Telegram"). */
  private notices = new Map<number, string>();
  /** Called once when an alert fires; returns a short note shown next to the alert. */
  onTrigger: ((a: AlertRecord, side: "upper" | "lower", price: string) => Promise<string>) | null = null;

  constructor(
    private readonly store: Store,
    private readonly priceOf: (exchange: ExchangeId, symbol: string) => Promise<Decimal> = fetchPrice,
    private readonly intervalMs = 3000,
  ) {}

  async init(): Promise<void> {
    for (const a of await this.store.listAlerts()) this.alerts.set(a.id, a);
    this.timer = setInterval(() => void this.check(), this.intervalMs);
    this.timer.unref?.();
    void this.check();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over every alert. Exposed for tests. */
  async check(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // One price request per market, shared by its alerts.
      const markets = new Map<string, AlertRecord[]>();
      for (const a of this.alerts.values()) {
        const key = `${a.exchange}|${a.symbol}`;
        markets.set(key, [...(markets.get(key) ?? []), a]);
      }
      await Promise.all([...markets.values()].map(async group => {
        let price: Decimal;
        try { price = await this.priceOf(group[0].exchange, group[0].symbol); } catch { return; }
        const now = Date.now();
        for (const a of group) {
          this.prices.set(a.id, { price: price.toFixed(), at: now });
          if (a.status !== "watching") continue;
          const hitUpper = a.upper !== null && price.gte(a.upper);
          const hitLower = a.lower !== null && price.lte(a.lower);
          if (!hitUpper && !hitLower) continue;
          a.status = hitUpper ? "triggered_upper" : "triggered_lower";
          a.triggeredAt = now;
          a.triggeredPrice = price.toFixed();
          await this.store.updateAlert(a.id, { status: a.status, triggeredAt: now, triggeredPrice: a.triggeredPrice });
          console.log(`Price alert ${a.id} ${a.exchange} ${a.symbol}: ${hitUpper ? "upper" : "lower"} limit reached at ${a.triggeredPrice}`);
          if (this.onTrigger) {
            const side = hitUpper ? "upper" : "lower";
            const rec = a, at = a.triggeredPrice;
            this.notices.set(a.id, "Sending notification…");
            void this.onTrigger(rec, side, at)
              .then(note => this.notices.set(rec.id, note))
              .catch(err => this.notices.set(rec.id, `Notification failed: ${err instanceof Error ? err.message : String(err)}`));
          }
        }
      }));
    } finally {
      this.running = false;
    }
  }

  async create(input: { exchange: ExchangeId; symbol: string; upper: string | null; lower: string | null }): Promise<PriceAlertView> {
    const symbol = input.symbol.trim();
    if (!symbol) throw new AlertError("Choose a symbol");
    const upper = input.upper?.trim() ? new Decimal(input.upper) : null;
    const lower = input.lower?.trim() ? new Decimal(input.lower) : null;
    if (!upper && !lower) throw new AlertError("Enter an upper limit, a lower limit, or both");
    if ((upper && upper.lte(0)) || (lower && lower.lte(0))) throw new AlertError("Limits must be greater than 0");
    if (upper && lower && !lower.lt(upper)) throw new AlertError("Lower limit must be below the upper limit");
    let price: Decimal;
    try { price = await this.priceOf(input.exchange, symbol); } catch (err) {
      throw new AlertError(`Could not get the price of ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (upper && price.gte(upper)) throw new AlertError(`The price (${price.toFixed()}) is already at or above the upper limit ${upper.toFixed()}`);
    if (lower && price.lte(lower)) throw new AlertError(`The price (${price.toFixed()}) is already at or below the lower limit ${lower.toFixed()}`);
    const rec = await this.store.createAlert({ exchange: input.exchange, symbol, upper: upper?.toFixed() ?? null, lower: lower?.toFixed() ?? null });
    this.alerts.set(rec.id, rec);
    this.prices.set(rec.id, { price: price.toFixed(), at: Date.now() });
    return this.viewOf(rec);
  }

  async rearm(id: number): Promise<void> {
    const a = this.alerts.get(id);
    if (!a) throw new AlertError("Alert not found");
    const price = this.prices.get(id)?.price;
    if (price && ((a.upper && new Decimal(price).gte(a.upper)) || (a.lower && new Decimal(price).lte(a.lower)))) {
      throw new AlertError("The price is still beyond a limit — change the limits or wait until it is back inside");
    }
    a.status = "watching";
    a.triggeredAt = null;
    a.triggeredPrice = null;
    this.notices.delete(id);
    await this.store.updateAlert(id, { status: "watching", triggeredAt: null, triggeredPrice: null });
  }

  async remove(id: number): Promise<void> {
    if (!this.alerts.has(id)) throw new AlertError("Alert not found");
    this.alerts.delete(id);
    this.prices.delete(id);
    await this.store.deleteAlert(id);
  }

  private viewOf(a: AlertRecord): PriceAlertView {
    const p = this.prices.get(a.id);
    return { ...a, lastPrice: p?.price ?? null, lastPriceAt: p?.at ?? null, notice: this.notices.get(a.id) ?? null };
  }

  view(): PriceAlertView[] {
    return [...this.alerts.values()].sort((x, y) => y.id - x.id).map(a => this.viewOf(a));
  }
}
