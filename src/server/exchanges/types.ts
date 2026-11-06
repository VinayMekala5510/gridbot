import type Decimal from "decimal.js";
import type { Side } from "../../shared/types";

export interface PlaceRequest {
  symbol: string;
  side: Side;
  price: Decimal;
  qty: Decimal;
  /** Our own id for the order, unique per order: "0x" + 32 hex characters. */
  clientId: string;
}

export interface PlaceResult {
  exchangeOrderId: string;
}

export interface TrackedOrder {
  exchangeOrderId: string;
  side: Side;
  price: Decimal;
  qty: Decimal;
  filledQty: Decimal;
}

export interface ExchangeFill {
  exchangeOrderId: string;
  tradeId: string;
  price: Decimal;
  qty: Decimal;
  fee: Decimal;
  time: number;
}

export interface CancelResult {
  canceled: string[];
  failed: { exchangeOrderId: string; error: string }[];
}

export interface ExchangeAdapter {
  readonly live: boolean;
  getPrice(symbol: string): Promise<Decimal>;
  /** Rounds a price/qty to what the venue accepts. Sells round up, buys round down. */
  roundPrice(symbol: string, price: Decimal, side: Side): Promise<Decimal>;
  roundQty(symbol: string, qty: Decimal): Promise<Decimal>;
  /** Throws with a readable message when the order cannot be valid on this venue. */
  validateOrder(symbol: string, price: Decimal, qty: Decimal): Promise<void>;
  placeLimit(req: PlaceRequest): Promise<PlaceResult>;
  cancel(symbol: string, exchangeOrderIds: string[]): Promise<CancelResult>;
  /** After a crash between "send" and "save": finds an order by our client id. */
  lookupByClientId(symbol: string, clientId: string): Promise<string | null>;
  /** Fills for the given open orders that happened at or after `since` (ms). */
  fillsFor(symbol: string, open: TrackedOrder[], since: number): Promise<{ fills: ExchangeFill[]; cursor: number }>;
}
