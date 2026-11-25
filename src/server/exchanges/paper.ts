import Decimal from "decimal.js";
import { randomUUID } from "node:crypto";
import type { Side } from "../../shared/types";
import type { CancelResult, ExchangeAdapter, ExchangeFill, MarketRequest, OrderState, PlaceRequest, TrackedOrder } from "./types";

/**
 * Simulated venue. Uses a real (or injected) price source; a resting limit
 * order fills completely at its limit price once the market trades through it.
 */
export class PaperAdapter implements ExchangeAdapter {
  readonly live = false;
  constructor(private readonly priceSource: (symbol: string) => Promise<Decimal>) {}

  getPrice(symbol: string) { return this.priceSource(symbol); }
  async roundPrice(_symbol: string, price: Decimal, _side: Side) { return price; }
  async roundQty(_symbol: string, qty: Decimal) { return qty; }
  async validateOrder(_symbol: string, price: Decimal, qty: Decimal) {
    if (price.lte(0) || qty.lte(0)) throw new Error("Price and quantity must be positive");
  }

  async placeLimit(_req: PlaceRequest) {
    return { exchangeOrderId: `paper-${randomUUID()}` };
  }

  /** Market orders fill completely at the market price on the next fill check. */
  private market = new Set<string>();
  private marketState = new Map<string, OrderState>();
  async placeMarket(req: MarketRequest) {
    const id = `paper-mkt-${randomUUID()}`;
    this.market.add(id);
    this.marketState.set(id, { filledQty: req.qty, avgPrice: await this.priceSource(req.symbol), open: false });
    return { exchangeOrderId: id };
  }

  async orderState(_symbol: string, id: string): Promise<OrderState> {
    return this.marketState.get(id) ?? { filledQty: new Decimal(0), avgPrice: null, open: true };
  }

  async lookupByClientId(_symbol: string, _clientId: string): Promise<string | null> { return null; }

  async cancel(_symbol: string, ids: string[]): Promise<CancelResult> {
    return { canceled: [...ids], failed: [] };
  }

  async fillsFor(symbol: string, open: TrackedOrder[], since: number) {
    if (!open.length) return { fills: [], cursor: since };
    const price = await this.priceSource(symbol);
    const now = Date.now();
    const fills: ExchangeFill[] = [];
    for (const order of open) {
      const isMarket = this.market.has(order.exchangeOrderId);
      const crossed = isMarket || (order.side === "buy" ? price.lte(order.price) : price.gte(order.price));
      const remaining = order.qty.minus(order.filledQty);
      if (!crossed || remaining.lte(0)) continue;
      if (isMarket) this.market.delete(order.exchangeOrderId);
      fills.push({
        exchangeOrderId: order.exchangeOrderId, tradeId: `${order.exchangeOrderId}:fill`,
        price: isMarket ? this.marketState.get(order.exchangeOrderId)?.avgPrice ?? price : order.price, qty: remaining, fee: new Decimal(0), time: now,
      });
    }
    return { fills, cursor: now };
  }
}
