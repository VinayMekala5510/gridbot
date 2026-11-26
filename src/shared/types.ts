// Types shared by the server (engine/API) and the dashboard UI.
// Keep this file free of server-only imports.

export type ExchangeId =
  | "hyperliquid"
  | "hyperliquid-testnet"
  | "binance"
  | "bybit"
  | "deribit"
  | "deribit-testnet"
  | "solana"
  | "ethereum";

export type BotMode = "paper" | "live";

export type BotStatus =
  | "idle"
  | "running"
  | "halted_volume_cap"
  | "halted_limit_breach"
  | "halted_total_distance"
  | "killed"
  | "error";

export type Side = "buy" | "sell";
/** squareoff = market order that closes a basket's position (basket-grid only). */
export type OrderRole = "entry" | "target" | "squareoff";

/**
 * step-grid: the original logic (one grid, stops when all steps are in use).
 * basket-grid: the same grid inside baskets; each basket is squared off at market when the price
 * moves the basket distance or the basket's quantity is full, then the next basket starts at 0.
 */
export type GridModel = "step-grid" | "basket-grid";
export const GRID_MODELS: GridModel[] = ["step-grid", "basket-grid"];

/** Why a basket was closed. */
export type BasketReason = "distance_up" | "distance_down" | "qty_full" | "total_distance";

export interface BasketView {
  /** 1, 2, 3… in the order the baskets ran. */
  index: number;
  status: "open" | "closing" | "closed";
  startPrice: string;
  /** Start, UB1, UB2…, LB1, LB2… (zones of basket distance measured from the bot entry price). */
  startZone: string;
  endPrice: string | null;
  endZone: string | null;
  reason: BasketReason | null;
  roundtrips: number;
  /** Completed roundtrips inside this basket (before fees). */
  rtpPnl: string;
  /** Market order that closed the basket's position (null when it was already flat). */
  squareoffSide: Side | null;
  squareoffQty: string;
  squareoffPrice: string | null;
  squareoffPnl: string;
  /** Small leftover (< 0.5) carried in from the previous basket, squared off with this one. */
  carryInSide: Side | null;
  carryInQty: string;
  startedAt: number;
  closedAt: number | null;
}
export type OrderStatus = "pending" | "open" | "filled" | "canceled" | "rejected";

export interface ExchangeInfo {
  id: ExchangeId;
  label: string;
  /** Real order placement is implemented for this exchange. */
  live: boolean;
  /** Accounts (keys) can be saved for this exchange. */
  accounts: boolean;
  /** Placeholder shown in the symbol field. */
  symbolHint: string;
  keyLabel: string;
  secretLabel: string;
}

export interface BotConfig {
  name: string;
  exchange: ExchangeId;
  mode: BotMode;
  accountId: number | null;
  symbol: string;
  spread: string;
  targetSpread: string;
  steps: number;
  stepQty: string;
  mmQty: string;
  upperLimit: string;
  lowerLimit: string;
  entryPrice: string;
  /** Missing on bots created before basket-grid existed: they are step-grid. */
  gridModel?: GridModel;
  /** basket-grid: the bot stops once the price is this far from the entry price. */
  totalDistance?: string | null;
  /** basket-grid: a basket is squared off once the price moves this far from its start. */
  basketDistance?: string | null;
}

export function gridModelOf(c: Pick<BotConfig, "gridModel">): GridModel {
  return c.gridModel ?? "step-grid";
}

/** Number of baskets = total distance / basket distance, rounded to a whole number (at least 1). */
export function basketCount(c: Pick<BotConfig, "totalDistance" | "basketDistance">): number {
  const total = Number(c.totalDistance), basket = Number(c.basketDistance);
  if (!(total > 0) || !(basket > 0)) return 1;
  return Math.max(1, Math.round(total / basket));
}

export interface OrderView {
  id: number;
  level: number;
  side: Side;
  role: OrderRole;
  price: string;
  qty: string;
  filledQty: string;
  status: OrderStatus;
  /** Entry order this target closes (targets only). */
  parentOrderId: number | null;
  /** Average fill price of the entry this target closes (targets only). */
  refPrice: string | null;
  createdAt: number;
}

/** One fill, exchange trade-history style. */
export interface TradeView {
  id: number;
  time: number;
  side: Side;
  role: OrderRole;
  level: number;
  price: string;
  qty: string;
  /** price × qty in the quote currency (equals qty for USD-sized inverse contracts). */
  value: string;
  fee: string;
  /** PnL this fill realized (target fills only, before fees). */
  realizedPnl: string | null;
  exchangeOrderId: string | null;
  tradeId: string;
}

export interface FillView {
  id: number;
  orderId: number;
  level: number;
  role: OrderRole;
  side: Side;
  price: string;
  qty: string;
  fee: string;
  time: number;
}

export interface RoundtripView {
  /** Entry order that opened this roundtrip. */
  entryOrderId: number;
  targetOrderId: number;
  level: number;
  entrySide: Side;
  entryPrice: string;
  exitPrice: string;
  qty: string;
  /** Profit of this entry + target pair before fees (quote currency, e.g. USD). */
  pnl: string;
  time: number;
}

export interface EventView {
  time: number;
  level: "info" | "warn" | "error";
  message: string;
}

export interface FillSummary {
  buyCount: number;
  sellCount: number;
  buyQty: string;
  sellQty: string;
  avgBuy: string | null;
  avgSell: string | null;
}

export interface BotView {
  id: number;
  config: BotConfig;
  accountName: string | null;
  status: BotStatus;
  statusReason: string | null;
  lastPrice: string | null;
  lastPriceAt: number | null;
  entryFilledQty: string;
  /** Steps in use: filled entry quantity whose target has not filled yet (counts toward Market making qty). */
  openExposure: string;
  roundtrips: number;
  realizedPnl: string;
  /** basket-grid: total PnL of all basket square-offs (market closes), before fees. */
  squareoffPnl: string;
  /** basket-grid only. */
  basket: {
    count: number;
    /** Market making qty / number of baskets. */
    qty: string;
    closed: number;
    current: BasketView | null;
  } | null;
  unrealizedPnl: string;
  fees: string;
  netPnl: string;
  /** Grid levels that sit inside the upper/lower limits. */
  activeLevels: number;
  openEntries: OrderView[];
  openTargets: OrderView[];
  recentFills: FillView[];
  /** Latest completed roundtrips (newest first), keyed to the target order that closed them. */
  recentRoundtrips: RoundtripView[];
  fillSummary: FillSummary;
  events: EventView[];
  createdAt: number;
  stoppedAt: number | null;
}

export interface AccountView {
  id: number;
  name: string;
  exchange: ExchangeId;
  publicKeyMasked: string;
  hasPassphrase: boolean;
  createdAt: number;
}

export interface Snapshot {
  serverTime: number;
  storage: "mysql" | "memory";
  frozen: boolean;
  totals: {
    netPnl: string;
    /** Sum of completed roundtrip PnL across bots (before fees). */
    rtpPnl: string;
    /** Sum of basket square-off PnL across bots (basket-grid). */
    squareoffPnl: string;
    realizedPnl: string;
    unrealizedPnl: string;
    fees: string;
    runningBots: number;
    totalBots: number;
    roundtrips: number;
  };
  bots: BotView[];
  accounts: AccountView[];
  alerts: PriceAlertView[];
}

export const STOPPED_STATUSES: BotStatus[] = [
  "halted_volume_cap",
  "halted_limit_breach",
  "halted_total_distance",
  "killed",
  "error",
];

export type PriceAlertStatus = "watching" | "triggered_upper" | "triggered_lower";

export interface PriceAlertView {
  id: number;
  exchange: ExchangeId;
  symbol: string;
  upper: string | null;
  lower: string | null;
  status: PriceAlertStatus;
  lastPrice: string | null;
  lastPriceAt: number | null;
  triggeredAt: number | null;
  triggeredPrice: string | null;
  /** Notification result for a fired alert, e.g. "Sent to Telegram". */
  notice: string | null;
  createdAt: number;
}
