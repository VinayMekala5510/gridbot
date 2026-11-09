import type { BotConfig, BotStatus, ExchangeId, OrderRole, OrderStatus, Side } from "../../shared/types";

export interface AccountRecord {
  id: number;
  name: string;
  exchange: ExchangeId;
  publicKey: string;
  secretEnc: string;
  passphraseEnc: string | null;
  createdAt: number;
}

export interface BotRecord {
  id: number;
  config: BotConfig;
  status: BotStatus;
  statusReason: string | null;
  entryFilledQty: string;
  roundtrips: number;
  realizedPnl: string;
  fees: string;
  lastPrice: string | null;
  /** Exchange fill-history cursor (ms) used to resume live bots after a restart. */
  fillCursor: number;
  createdAt: number;
  stoppedAt: number | null;
}

export type BotPatch = Partial<Omit<BotRecord, "id" | "config" | "createdAt">>;

export interface OrderRecord {
  id: number;
  botId: number;
  level: number;
  side: Side;
  role: OrderRole;
  price: string;
  qty: string;
  filledQty: string;
  avgFillPrice: string | null;
  status: OrderStatus;
  exchangeOrderId: string | null;
  clientId: string;
  parentOrderId: number | null;
  refPrice: string | null;
  error: string | null;
  createdAt: number;
  filledAt: number | null;
}

export type OrderPatch = Partial<Pick<OrderRecord,
  "filledQty" | "avgFillPrice" | "status" | "exchangeOrderId" | "error" | "filledAt">>;

export interface FillRecord {
  id: number;
  botId: number;
  orderId: number;
  tradeId: string;
  level: number;
  role: OrderRole;
  side: Side;
  price: string;
  qty: string;
  fee: string;
  time: number;
}

export interface RoundtripRecord {
  botId: number;
  level: number;
  entryOrderId: number;
  targetOrderId: number;
  entrySide: Side;
  entryPrice: string;
  exitPrice: string;
  qty: string;
  pnl: string;
  time: number;
}

export interface EventRecord {
  botId: number | null;
  level: "info" | "warn" | "error";
  message: string;
  time: number;
}

export interface FillAggregate {
  side: Side;
  count: number;
  qty: string;
  notional: string;
}

export interface Store {
  readonly kind: "mysql" | "memory";
  init(): Promise<void>;
  close(): Promise<void>;

  createAccount(a: Omit<AccountRecord, "id" | "createdAt">): Promise<AccountRecord>;
  listAccounts(): Promise<AccountRecord[]>;
  getAccount(id: number): Promise<AccountRecord | null>;
  deleteAccount(id: number): Promise<void>;

  createBot(config: BotConfig, status: BotStatus): Promise<BotRecord>;
  updateBot(id: number, patch: BotPatch): Promise<void>;
  archiveBot(id: number): Promise<void>;
  /** Bots that have not been archived. */
  listBots(): Promise<BotRecord[]>;

  createOrder(o: Omit<OrderRecord, "id">): Promise<OrderRecord>;
  updateOrder(id: number, patch: OrderPatch): Promise<void>;
  listOrders(botId: number, statuses: OrderStatus[]): Promise<OrderRecord[]>;

  /** Returns null when this trade was already recorded for the bot. */
  insertFill(f: Omit<FillRecord, "id">): Promise<FillRecord | null>;
  recentFills(botId: number, limit: number): Promise<FillRecord[]>;
  fillTradeIds(botId: number, orderIds: number[]): Promise<string[]>;
  fillAggregates(botId: number): Promise<FillAggregate[]>;

  insertRoundtrip(r: RoundtripRecord): Promise<void>;
  recentRoundtrips(botId: number, limit: number): Promise<RoundtripRecord[]>;
  insertEvent(e: EventRecord): Promise<void>;
  recentEvents(botId: number, limit: number): Promise<EventRecord[]>;
}
