import Decimal from "decimal.js";
import type { BotConfig, BotStatus, OrderStatus } from "../../shared/types";
import type {
  AccountRecord, BotPatch, BotRecord, EventRecord, FillAggregate, FillRecord,
  OrderPatch, OrderRecord, RoundtripRecord, Store,
} from "./types";

/** In-process store for tests and local development without MySQL. */
export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  accounts: AccountRecord[] = [];
  bots: (BotRecord & { archived: boolean })[] = [];
  orders: OrderRecord[] = [];
  fills: FillRecord[] = [];
  roundtrips: RoundtripRecord[] = [];
  events: EventRecord[] = [];
  private seq = 0;

  async init() {}
  async close() {}

  async createAccount(a: Omit<AccountRecord, "id" | "createdAt">) {
    const rec = { ...a, id: ++this.seq, createdAt: Date.now() };
    this.accounts.push(rec);
    return { ...rec };
  }
  async listAccounts() { return this.accounts.map(a => ({ ...a })); }
  async getAccount(id: number) { const a = this.accounts.find(x => x.id === id); return a ? { ...a } : null; }
  async deleteAccount(id: number) { this.accounts = this.accounts.filter(a => a.id !== id); }

  async createBot(config: BotConfig, status: BotStatus) {
    const rec: BotRecord & { archived: boolean } = {
      id: ++this.seq, config: { ...config }, status, statusReason: null, entryFilledQty: "0",
      roundtrips: 0, realizedPnl: "0", fees: "0", lastPrice: null, fillCursor: Date.now(),
      createdAt: Date.now(), stoppedAt: null, archived: false,
    };
    this.bots.push(rec);
    const { archived: _a, ...bot } = rec;
    return { ...bot, config: { ...bot.config } };
  }
  async updateBot(id: number, patch: BotPatch) {
    const bot = this.bots.find(b => b.id === id);
    if (bot) Object.assign(bot, patch);
  }
  async archiveBot(id: number) {
    const bot = this.bots.find(b => b.id === id);
    if (bot) bot.archived = true;
  }
  async listBots() {
    return this.bots.filter(b => !b.archived).map(({ archived: _a, ...b }) => ({ ...b, config: { ...b.config } }));
  }

  async createOrder(o: Omit<OrderRecord, "id">) {
    const rec = { ...o, id: ++this.seq };
    this.orders.push(rec);
    return { ...rec };
  }
  async updateOrder(id: number, patch: OrderPatch) {
    const order = this.orders.find(o => o.id === id);
    if (order) Object.assign(order, patch);
  }
  async listOrders(botId: number, statuses: OrderStatus[]) {
    return this.orders.filter(o => o.botId === botId && statuses.includes(o.status)).map(o => ({ ...o }));
  }

  async insertFill(f: Omit<FillRecord, "id">) {
    if (this.fills.some(x => x.botId === f.botId && x.tradeId === f.tradeId)) return null;
    const rec = { ...f, id: ++this.seq };
    this.fills.push(rec);
    return { ...rec };
  }
  async recentFills(botId: number, limit: number) {
    return this.fills.filter(f => f.botId === botId).sort((a, b) => b.id - a.id).slice(0, limit).map(f => ({ ...f }));
  }
  async fillTradeIds(botId: number, orderIds: number[]) {
    return this.fills.filter(f => f.botId === botId && orderIds.includes(f.orderId)).map(f => f.tradeId);
  }
  async fillAggregates(botId: number): Promise<FillAggregate[]> {
    const out: FillAggregate[] = [];
    for (const side of ["buy", "sell"] as const) {
      const rows = this.fills.filter(f => f.botId === botId && f.side === side);
      if (!rows.length) continue;
      out.push({
        side, count: rows.length,
        qty: rows.reduce((s, f) => s.plus(f.qty), new Decimal(0)).toFixed(),
        notional: rows.reduce((s, f) => s.plus(new Decimal(f.qty).times(f.price)), new Decimal(0)).toFixed(),
      });
    }
    return out;
  }

  async insertRoundtrip(r: RoundtripRecord) { this.roundtrips.push({ ...r }); }
  async insertEvent(e: EventRecord) { this.events.push({ ...e }); }
  async recentEvents(botId: number, limit: number) {
    return this.events.filter(e => e.botId === botId).slice(-limit).reverse();
  }
}
