import Decimal from "decimal.js";
import mysql, { type Pool, type RowDataPacket, type ResultSetHeader } from "mysql2/promise";
import type { BotConfig, BotStatus, OrderStatus } from "../../shared/types";
import type {
  AccountRecord, BotPatch, BotRecord, EventRecord, FillAggregate, FillRecord,
  OrderPatch, OrderRecord, RoundtripRecord, Store,
} from "./types";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    exchange VARCHAR(40) NOT NULL,
    public_key VARCHAR(255) NOT NULL,
    secret_enc TEXT NOT NULL,
    passphrase_enc TEXT NULL,
    created_at DATETIME(3) NOT NULL,
    deleted_at DATETIME(3) NULL
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS bots (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    exchange VARCHAR(40) NOT NULL,
    mode VARCHAR(10) NOT NULL,
    account_id INT UNSIGNED NULL,
    symbol VARCHAR(40) NOT NULL,
    spread DECIMAL(38,18) NOT NULL,
    target_spread DECIMAL(38,18) NOT NULL,
    steps INT NOT NULL,
    step_qty DECIMAL(38,18) NOT NULL,
    mm_qty DECIMAL(38,18) NOT NULL,
    upper_limit DECIMAL(38,18) NOT NULL,
    lower_limit DECIMAL(38,18) NOT NULL,
    entry_price DECIMAL(38,18) NOT NULL,
    status VARCHAR(32) NOT NULL,
    status_reason VARCHAR(500) NULL,
    entry_filled_qty DECIMAL(38,18) NOT NULL DEFAULT 0,
    roundtrips INT NOT NULL DEFAULT 0,
    realized_pnl DECIMAL(38,18) NOT NULL DEFAULT 0,
    fees DECIMAL(38,18) NOT NULL DEFAULT 0,
    last_price DECIMAL(38,18) NULL,
    fill_cursor BIGINT NOT NULL,
    created_at DATETIME(3) NOT NULL,
    stopped_at DATETIME(3) NULL,
    archived_at DATETIME(3) NULL,
    INDEX idx_bots_archived (archived_at)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS orders (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    bot_id INT UNSIGNED NOT NULL,
    level INT NOT NULL,
    side VARCHAR(4) NOT NULL,
    role VARCHAR(10) NOT NULL,
    price DECIMAL(38,18) NOT NULL,
    qty DECIMAL(38,18) NOT NULL,
    filled_qty DECIMAL(38,18) NOT NULL DEFAULT 0,
    avg_fill_price DECIMAL(38,18) NULL,
    status VARCHAR(10) NOT NULL,
    exchange_order_id VARCHAR(80) NULL,
    client_id VARCHAR(80) NOT NULL,
    parent_order_id BIGINT UNSIGNED NULL,
    ref_price DECIMAL(38,18) NULL,
    error VARCHAR(500) NULL,
    created_at DATETIME(3) NOT NULL,
    filled_at DATETIME(3) NULL,
    INDEX idx_orders_bot_status (bot_id, status)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS fills (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    bot_id INT UNSIGNED NOT NULL,
    order_id BIGINT UNSIGNED NOT NULL,
    trade_id VARCHAR(100) NOT NULL,
    level INT NOT NULL,
    role VARCHAR(10) NOT NULL,
    side VARCHAR(4) NOT NULL,
    price DECIMAL(38,18) NOT NULL,
    qty DECIMAL(38,18) NOT NULL,
    fee DECIMAL(38,18) NOT NULL DEFAULT 0,
    filled_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_fills_trade (bot_id, trade_id),
    INDEX idx_fills_order (order_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS roundtrips (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    bot_id INT UNSIGNED NOT NULL,
    level INT NOT NULL,
    entry_order_id BIGINT UNSIGNED NOT NULL,
    target_order_id BIGINT UNSIGNED NOT NULL,
    entry_side VARCHAR(4) NOT NULL,
    entry_price DECIMAL(38,18) NOT NULL,
    exit_price DECIMAL(38,18) NOT NULL,
    qty DECIMAL(38,18) NOT NULL,
    pnl DECIMAL(38,18) NOT NULL,
    completed_at DATETIME(3) NOT NULL,
    INDEX idx_roundtrips_bot (bot_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    bot_id INT UNSIGNED NULL,
    level VARCHAR(5) NOT NULL,
    message VARCHAR(1000) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    INDEX idx_events_bot (bot_id, id)
  ) ENGINE=InnoDB`,
];

type Row = RowDataPacket & Record<string, unknown>;
const dec = (v: unknown): string => new Decimal(String(v)).toFixed();
const decOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : dec(v));
const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : new Date(String(v)).getTime());
const msOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : ms(v));
const date = (v: number | null | undefined) => (v === null || v === undefined ? null : new Date(v));

function botFromRow(r: Row): BotRecord {
  const config: BotConfig = {
    name: String(r.name), exchange: r.exchange as BotConfig["exchange"], mode: r.mode as BotConfig["mode"],
    accountId: r.account_id === null ? null : Number(r.account_id), symbol: String(r.symbol),
    spread: dec(r.spread), targetSpread: dec(r.target_spread), steps: Number(r.steps),
    stepQty: dec(r.step_qty), mmQty: dec(r.mm_qty), upperLimit: dec(r.upper_limit),
    lowerLimit: dec(r.lower_limit), entryPrice: dec(r.entry_price),
  };
  return {
    id: Number(r.id), config, status: r.status as BotStatus,
    statusReason: r.status_reason === null ? null : String(r.status_reason),
    entryFilledQty: dec(r.entry_filled_qty), roundtrips: Number(r.roundtrips),
    realizedPnl: dec(r.realized_pnl), fees: dec(r.fees), lastPrice: decOrNull(r.last_price),
    fillCursor: Number(r.fill_cursor), createdAt: ms(r.created_at), stoppedAt: msOrNull(r.stopped_at),
  };
}

function orderFromRow(r: Row): OrderRecord {
  return {
    id: Number(r.id), botId: Number(r.bot_id), level: Number(r.level), side: r.side as OrderRecord["side"],
    role: r.role as OrderRecord["role"], price: dec(r.price), qty: dec(r.qty), filledQty: dec(r.filled_qty),
    avgFillPrice: decOrNull(r.avg_fill_price), status: r.status as OrderStatus,
    exchangeOrderId: r.exchange_order_id === null ? null : String(r.exchange_order_id),
    clientId: String(r.client_id), parentOrderId: r.parent_order_id === null ? null : Number(r.parent_order_id),
    refPrice: decOrNull(r.ref_price), error: r.error === null ? null : String(r.error),
    createdAt: ms(r.created_at), filledAt: msOrNull(r.filled_at),
  };
}

function fillFromRow(r: Row): FillRecord {
  return {
    id: Number(r.id), botId: Number(r.bot_id), orderId: Number(r.order_id), tradeId: String(r.trade_id),
    level: Number(r.level), role: r.role as FillRecord["role"], side: r.side as FillRecord["side"],
    price: dec(r.price), qty: dec(r.qty), fee: dec(r.fee), time: ms(r.filled_at),
  };
}

const BOT_COLUMNS: Record<keyof BotPatch, string> = {
  status: "status", statusReason: "status_reason", entryFilledQty: "entry_filled_qty",
  roundtrips: "roundtrips", realizedPnl: "realized_pnl", fees: "fees", lastPrice: "last_price",
  fillCursor: "fill_cursor", stoppedAt: "stopped_at",
};
const ORDER_COLUMNS: Record<keyof OrderPatch, string> = {
  filledQty: "filled_qty", avgFillPrice: "avg_fill_price", status: "status",
  exchangeOrderId: "exchange_order_id", error: "error", filledAt: "filled_at",
};

function patchSql<T extends object>(patch: T, columns: Record<string, string>) {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const column = columns[key];
    if (!column) throw new Error(`Unknown column for ${key}`);
    sets.push(`${column} = ?`);
    values.push(key === "stoppedAt" || key === "filledAt" ? date(value as number | null) : value);
  }
  return { sets, values };
}

export class MysqlStore implements Store {
  readonly kind = "mysql" as const;
  private pool: Pool;

  constructor(opts: { host: string; port: number; user: string; password: string; database: string }) {
    this.pool = mysql.createPool({
      ...opts, connectionLimit: 8, timezone: "Z", supportBigNumbers: true, bigNumberStrings: false,
      decimalNumbers: false,
    });
  }

  async init() {
    for (const sql of SCHEMA) await this.pool.query(sql);
  }
  async close() { await this.pool.end(); }

  async createAccount(a: Omit<AccountRecord, "id" | "createdAt">) {
    const now = Date.now();
    const [res] = await this.pool.execute<ResultSetHeader>(
      "INSERT INTO accounts (name, exchange, public_key, secret_enc, passphrase_enc, created_at) VALUES (?,?,?,?,?,?)",
      [a.name, a.exchange, a.publicKey, a.secretEnc, a.passphraseEnc, new Date(now)]);
    return { ...a, id: res.insertId, createdAt: now };
  }
  async listAccounts() {
    const [rows] = await this.pool.query<Row[]>("SELECT * FROM accounts WHERE deleted_at IS NULL ORDER BY id");
    return rows.map(r => this.accountFromRow(r));
  }
  async getAccount(id: number) {
    const [rows] = await this.pool.execute<Row[]>("SELECT * FROM accounts WHERE id = ? AND deleted_at IS NULL", [id]);
    return rows[0] ? this.accountFromRow(rows[0]) : null;
  }
  async deleteAccount(id: number) {
    // Soft delete keeps history readable; the encrypted secret is wiped.
    await this.pool.execute("UPDATE accounts SET deleted_at = ?, secret_enc = '', passphrase_enc = NULL WHERE id = ?",
      [new Date(), id]);
  }
  private accountFromRow(r: Row): AccountRecord {
    return {
      id: Number(r.id), name: String(r.name), exchange: r.exchange as AccountRecord["exchange"],
      publicKey: String(r.public_key), secretEnc: String(r.secret_enc),
      passphraseEnc: r.passphrase_enc === null ? null : String(r.passphrase_enc), createdAt: ms(r.created_at),
    };
  }

  async createBot(c: BotConfig, status: BotStatus) {
    const now = Date.now();
    const [res] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO bots (name, exchange, mode, account_id, symbol, spread, target_spread, steps, step_qty, mm_qty,
        upper_limit, lower_limit, entry_price, status, fill_cursor, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [c.name, c.exchange, c.mode, c.accountId, c.symbol, c.spread, c.targetSpread, c.steps, c.stepQty, c.mmQty,
        c.upperLimit, c.lowerLimit, c.entryPrice, status, now, new Date(now)]);
    const [rows] = await this.pool.execute<Row[]>("SELECT * FROM bots WHERE id = ?", [res.insertId]);
    return botFromRow(rows[0]);
  }
  async updateBot(id: number, patch: BotPatch) {
    const { sets, values } = patchSql(patch, BOT_COLUMNS);
    if (!sets.length) return;
    await this.pool.execute(`UPDATE bots SET ${sets.join(", ")} WHERE id = ?`, [...values, id] as never[]);
  }
  async archiveBot(id: number) {
    await this.pool.execute("UPDATE bots SET archived_at = ? WHERE id = ?", [new Date(), id]);
  }
  async listBots() {
    const [rows] = await this.pool.query<Row[]>("SELECT * FROM bots WHERE archived_at IS NULL ORDER BY id");
    return rows.map(botFromRow);
  }

  async createOrder(o: Omit<OrderRecord, "id">) {
    const [res] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO orders (bot_id, level, side, role, price, qty, filled_qty, avg_fill_price, status,
        exchange_order_id, client_id, parent_order_id, ref_price, error, created_at, filled_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [o.botId, o.level, o.side, o.role, o.price, o.qty, o.filledQty, o.avgFillPrice, o.status,
        o.exchangeOrderId, o.clientId, o.parentOrderId, o.refPrice, o.error, new Date(o.createdAt), date(o.filledAt)]);
    return { ...o, id: res.insertId };
  }
  async updateOrder(id: number, patch: OrderPatch) {
    const { sets, values } = patchSql(patch, ORDER_COLUMNS);
    if (!sets.length) return;
    await this.pool.execute(`UPDATE orders SET ${sets.join(", ")} WHERE id = ?`, [...values, id] as never[]);
  }
  async listOrders(botId: number, statuses: OrderStatus[]) {
    if (!statuses.length) return [];
    const [rows] = await this.pool.query<Row[]>(
      `SELECT * FROM orders WHERE bot_id = ? AND status IN (?) ORDER BY id`, [botId, statuses]);
    return rows.map(orderFromRow);
  }

  async insertFill(f: Omit<FillRecord, "id">) {
    const [res] = await this.pool.execute<ResultSetHeader>(
      `INSERT IGNORE INTO fills (bot_id, order_id, trade_id, level, role, side, price, qty, fee, filled_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [f.botId, f.orderId, f.tradeId, f.level, f.role, f.side, f.price, f.qty, f.fee, new Date(f.time)]);
    return res.affectedRows === 0 ? null : { ...f, id: res.insertId };
  }
  async recentFills(botId: number, limit: number) {
    const [rows] = await this.pool.query<Row[]>(
      "SELECT * FROM fills WHERE bot_id = ? ORDER BY id DESC LIMIT ?", [botId, limit]);
    return rows.map(fillFromRow);
  }
  async fillTradeIds(botId: number, orderIds: number[]) {
    if (!orderIds.length) return [];
    const [rows] = await this.pool.query<Row[]>(
      "SELECT trade_id FROM fills WHERE bot_id = ? AND order_id IN (?)", [botId, orderIds]);
    return rows.map(r => String(r.trade_id));
  }
  async fillAggregates(botId: number): Promise<FillAggregate[]> {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT side, COUNT(*) AS cnt, SUM(qty) AS qty, SUM(qty * price) AS notional
       FROM fills WHERE bot_id = ? GROUP BY side`, [botId]);
    return rows.map(r => ({ side: r.side as "buy" | "sell", count: Number(r.cnt), qty: dec(r.qty), notional: dec(r.notional) }));
  }

  async insertRoundtrip(r: RoundtripRecord) {
    await this.pool.execute(
      `INSERT INTO roundtrips (bot_id, level, entry_order_id, target_order_id, entry_side, entry_price, exit_price,
        qty, pnl, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [r.botId, r.level, r.entryOrderId, r.targetOrderId, r.entrySide, r.entryPrice, r.exitPrice, r.qty, r.pnl,
        new Date(r.time)]);
  }
  async recentRoundtrips(botId: number, limit: number) {
    const [rows] = await this.pool.query<Row[]>(
      "SELECT * FROM roundtrips WHERE bot_id = ? ORDER BY id DESC LIMIT ?", [botId, limit]);
    return rows.map(r => ({
      botId: Number(r.bot_id), level: Number(r.level), entryOrderId: Number(r.entry_order_id),
      targetOrderId: Number(r.target_order_id), entrySide: r.entry_side as RoundtripRecord["entrySide"],
      entryPrice: dec(r.entry_price), exitPrice: dec(r.exit_price), qty: dec(r.qty), pnl: dec(r.pnl),
      time: ms(r.completed_at),
    }));
  }
  async insertEvent(e: EventRecord) {
    await this.pool.execute("INSERT INTO events (bot_id, level, message, created_at) VALUES (?,?,?,?)",
      [e.botId, e.level, e.message.slice(0, 1000), new Date(e.time)]);
  }
  async recentEvents(botId: number, limit: number) {
    const [rows] = await this.pool.query<Row[]>(
      "SELECT * FROM events WHERE bot_id = ? ORDER BY id DESC LIMIT ?", [botId, limit]);
    return rows.map(r => ({
      botId: Number(r.bot_id), level: r.level as EventRecord["level"], message: String(r.message), time: ms(r.created_at),
    }));
  }
}
