// Types shared by the server (engine/API) and the dashboard UI.
// Keep this file free of server-only imports.

export type ExchangeId =
  | "hyperliquid"
  | "hyperliquid-testnet"
  | "binance"
  | "bybit"
  | "deribit"
  | "solana"
  | "ethereum";

export type BotMode = "paper" | "live";

export type BotStatus =
  | "idle"
  | "running"
  | "halted_volume_cap"
  | "halted_limit_breach"
  | "killed"
  | "error";

export type Side = "buy" | "sell";
export type OrderRole = "entry" | "target";
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
  /** Average fill price of the entry this target closes (targets only). */
  refPrice: string | null;
  createdAt: number;
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
  roundtrips: number;
  realizedPnl: string;
  unrealizedPnl: string;
  fees: string;
  netPnl: string;
  /** Grid levels that sit inside the upper/lower limits. */
  activeLevels: number;
  openEntries: OrderView[];
  openTargets: OrderView[];
  recentFills: FillView[];
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
    runningBots: number;
    totalBots: number;
    roundtrips: number;
  };
  bots: BotView[];
  accounts: AccountView[];
}

export const STOPPED_STATUSES: BotStatus[] = [
  "halted_volume_cap",
  "halted_limit_breach",
  "killed",
  "error",
];
