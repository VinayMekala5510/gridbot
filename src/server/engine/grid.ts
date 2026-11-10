import Decimal from "decimal.js";
import { randomBytes } from "node:crypto";
import type { BotStatus, BotView, EventView, OrderRole, OrderView, Side } from "../../shared/types";
import type { ExchangeAdapter, ExchangeFill } from "../exchanges/types";
import type { BotRecord, FillRecord, OrderRecord, RoundtripRecord, Store } from "../store/types";

const D = Decimal.clone({ precision: 40 });
type Dec = Decimal;
const ZERO = new D(0);

/** Entry orders resting at once per side: 3 buys + 3 sells, so at most 6 per bot. */
export const MAX_OPEN_PER_SIDE = 3;

export interface GridBotOptions {
  tickMs?: number;
  /** Consecutive order-placement failures before the bot halts with an error. */
  maxPlaceErrors?: number;
  /** Entry orders allowed to rest at once on each side (default MAX_OPEN_PER_SIDE). */
  maxOpenPerSide?: number;
  accountName?: string | null;
  /** Returns true while the master kill switch is engaged. */
  isFrozen?: () => boolean;
}

interface Level { k: number; side: Side; price: Dec }

/**
 * One independent grid bot instance.
 *
 * Levels: k = 1..steps sells at entry + k·spread, k = -1..-steps buys at
 * entry − k·spread (only levels strictly inside the lower/upper limits).
 * Each level cycles: resting entry → (fill) → resting target at
 * fill-order price ∓ targetSpread → (fill) → roundtrip, level re-armed.
 *
 * Safety:
 * - Volume cap: entry fills accumulate for the bot's lifetime. Orders always refill
 *   (3 buy + 3 sell open); once filled volume leaves less than one step of room
 *   under Market Making Qty, the bot halts and cancels all. Fills that land at the
 *   same moment can overshoot by at most the open entries.
 * - Price limits: market above upper / below lower → halt and cancel all.
 * - Kill switch: halt and cancel all.
 */
export class GridBot {
  rec: BotRecord;
  private orders = new Map<number, OrderRecord>();
  private seenTrades = new Set<string>();
  private recentFills: FillRecord[] = [];
  private recentRoundtrips: RoundtripRecord[] = [];
  private events: EventView[] = [];
  private summary = { buy: { count: 0, qty: ZERO, notional: ZERO }, sell: { count: 0, qty: ZERO, notional: ZERO } };
  private levels: Level[] = [];
  /** Inverse contracts: quantity is in USD, so PnL uses qty / entry price as the coin amount. */
  private inverse = false;
  private chain: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private stopRequested = false;
  private placeErrors = 0;
  private lastWarn = "";
  private lastPriceAt: number | null = null;
  private lastPersistedPrice = 0;
  private readonly tickMs: number;
  private readonly maxPlaceErrors: number;
  private readonly maxOpenPerSide: number;
  private readonly isFrozen: () => boolean;
  readonly accountName: string | null;

  constructor(rec: BotRecord, private readonly store: Store, private readonly adapter: ExchangeAdapter, opts: GridBotOptions = {}) {
    this.rec = rec;
    this.tickMs = opts.tickMs ?? 2000;
    this.maxPlaceErrors = opts.maxPlaceErrors ?? 5;
    this.maxOpenPerSide = opts.maxOpenPerSide ?? MAX_OPEN_PER_SIDE;
    this.isFrozen = opts.isFrozen ?? (() => false);
    this.accountName = opts.accountName ?? null;
  }

  get id() { return this.rec.id; }
  get symbol() { return this.rec.config.symbol; }
  get isStopped() { return this.stopRequested || !["idle", "running"].includes(this.rec.status); }
  get isLive() { return this.adapter.live; }

  /** Computes the grid levels (rounded to the venue's tick rules) inside the limits. */
  static async computeLevels(rec: BotRecord, adapter: ExchangeAdapter): Promise<Level[]> {
    const c = rec.config;
    const entry = new D(c.entryPrice), spread = new D(c.spread);
    const lower = new D(c.lowerLimit), upper = new D(c.upperLimit);
    const levels: Level[] = [];
    for (let i = 1; i <= c.steps; i++) {
      for (const k of [i, -i]) {
        const side: Side = k > 0 ? "sell" : "buy";
        const raw = entry.plus(spread.times(k));
        if (raw.lte(0)) continue;
        const price = await adapter.roundPrice(c.symbol, raw, side);
        if (price.gt(lower) && price.lt(upper)) levels.push({ k, side, price });
      }
    }
    return levels;
  }

  /** Loads levels and persisted state. Call once before start(). */
  async load(): Promise<void> {
    this.levels = await GridBot.computeLevels(this.rec, this.adapter);
    this.inverse = this.adapter.isInverse ? await this.adapter.isInverse(this.symbol) : false;
    const open = await this.store.listOrders(this.id, ["pending", "open"]);
    for (const o of open) this.orders.set(o.id, o);
    for (const t of await this.store.fillTradeIds(this.id, open.map(o => o.id))) this.seenTrades.add(t);
    this.recentFills = await this.store.recentFills(this.id, 50);
    this.recentRoundtrips = await this.store.recentRoundtrips(this.id, 50);
    for (const a of await this.store.fillAggregates(this.id)) {
      this.summary[a.side] = { count: a.count, qty: new D(a.qty), notional: new D(a.notional) };
    }
    this.events = (await this.store.recentEvents(this.id, 30)).map(e => ({ time: e.time, level: e.level, message: e.message }));
  }

  start(): void {
    if (this.isStopped || this.timer) return;
    this.schedule(0);
  }

  /** Stops the loop without touching orders (used for graceful process shutdown). */
  suspend(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopRequested = true;
  }

  private schedule(delay: number) {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.serial(() => this.tick())
        .catch(err => this.warn(`Tick failed: ${message(err)}`))
        .finally(() => { if (!this.isStopped) this.schedule(this.tickMs); });
    }, delay);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** One full cycle. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.isStopped || this.isFrozen()) return;
    await this.reconcilePending();

    let price: Dec;
    try {
      price = await this.adapter.getPrice(this.symbol);
    } catch (err) {
      this.warn(`Price unavailable: ${message(err)}`);
      return;
    }
    this.rec.lastPrice = price.toFixed();
    this.lastPriceAt = Date.now();
    if (Date.now() - this.lastPersistedPrice > 10_000) {
      this.lastPersistedPrice = Date.now();
      await this.store.updateBot(this.id, { lastPrice: this.rec.lastPrice });
    }

    const { upperLimit, lowerLimit } = this.rec.config;
    if (price.gt(upperLimit) || price.lt(lowerLimit)) {
      const which = price.gt(upperLimit) ? `rose above the upper limit ${upperLimit}` : `fell below the lower limit ${lowerLimit}`;
      await this.halt("halted_limit_breach", `Market price ${price.toFixed()} ${which}`);
      return;
    }

    await this.syncFills(true);
    if (this.isStopped || this.isFrozen()) return;
    if (this.capReached()) {
      await this.halt("halted_volume_cap",
        `Entry volume ${this.rec.entryFilledQty} reached the Market Making Quantity ceiling ${this.rec.config.mmQty}`);
      return;
    }

    if (this.rec.status === "idle") {
      this.rec.status = "running";
      await this.store.updateBot(this.id, { status: "running" });
      this.info(`Running. ${this.levels.length} grid levels inside the limits.`);
    }
    await this.trimEntries(price);
    if (this.isStopped || this.isFrozen()) return;
    await this.placeEntries(price);
  }

  // ── Fills ────────────────────────────────────────────────────────────

  /**
   * Records new fills. With `react`, completed entries get their target and
   * completed targets count a roundtrip; with `react` off (during shutdown)
   * fills are only recorded.
   */
  private async syncFills(react: boolean, include: OrderRecord[] = []): Promise<void> {
    const tracked = [...new Map([...this.orders.values(), ...include].map(o => [o.id, o])).values()]
      .filter(o => o.exchangeOrderId && o.status !== "filled");
    if (!tracked.length) return;
    const byExchangeId = new Map(tracked.map(o => [o.exchangeOrderId!, o]));
    const { fills, cursor } = await this.adapter.fillsFor(this.symbol, tracked.map(o => ({
      exchangeOrderId: o.exchangeOrderId!, side: o.side, price: new D(o.price), qty: new D(o.qty), filledQty: new D(o.filledQty),
    })), this.rec.fillCursor);

    const completed: OrderRecord[] = [];
    for (const fill of [...fills].sort((a, b) => a.time - b.time)) {
      const order = byExchangeId.get(fill.exchangeOrderId);
      if (!order || this.seenTrades.has(fill.tradeId)) continue;
      if (await this.recordFill(order, fill)) completed.push(order);
    }
    if (cursor > this.rec.fillCursor) {
      this.rec.fillCursor = cursor;
      await this.store.updateBot(this.id, { fillCursor: cursor });
    }

    for (const order of completed) {
      if (order.role === "target") await this.completeRoundtrip(order);
    }
    if (!react) return;
    if (this.capReached()) {
      await this.halt("halted_volume_cap",
        `Entry volume ${this.rec.entryFilledQty} reached the Market Making Quantity ceiling ${this.rec.config.mmQty}`);
      return;
    }
    for (const order of completed) {
      if (this.isStopped || this.isFrozen()) return;
      if (order.role === "entry") await this.placeTarget(order);
    }
  }

  /** Applies one fill. Returns true when the order is now completely filled. */
  private async recordFill(order: OrderRecord, fill: ExchangeFill): Promise<boolean> {
    this.seenTrades.add(fill.tradeId);
    const saved = await this.store.insertFill({
      botId: this.id, orderId: order.id, tradeId: fill.tradeId, level: order.level, role: order.role, side: order.side,
      price: fill.price.toFixed(), qty: fill.qty.toFixed(), fee: fill.fee.toFixed(), time: fill.time,
    });
    if (!saved) return false;

    const prevFilled = new D(order.filledQty);
    const filled = prevFilled.plus(fill.qty);
    const avg = prevFilled.isZero() ? fill.price
      : new D(order.avgFillPrice ?? order.price).times(prevFilled).plus(fill.price.times(fill.qty)).div(filled);
    order.filledQty = filled.toFixed();
    order.avgFillPrice = avg.toDecimalPlaces(18).toFixed();

    this.recentFills = [saved, ...this.recentFills].slice(0, 50);
    const s = this.summary[order.side];
    s.count++; s.qty = s.qty.plus(fill.qty); s.notional = s.notional.plus(fill.qty.times(fill.price));
    this.rec.fees = new D(this.rec.fees).plus(fill.fee).toFixed();
    if (order.role === "entry") this.rec.entryFilledQty = new D(this.rec.entryFilledQty).plus(fill.qty).toFixed();

    const done = filled.gte(order.qty);
    if (done) {
      order.status = "filled";
      order.filledAt = fill.time;
      this.orders.delete(order.id);
    }
    await this.store.updateOrder(order.id, {
      filledQty: order.filledQty, avgFillPrice: order.avgFillPrice, status: order.status, filledAt: order.filledAt,
    });
    await this.store.updateBot(this.id, { fees: this.rec.fees, entryFilledQty: this.rec.entryFilledQty });
    this.info(`${order.role === "entry" ? "Entry" : "Target"} ${order.side} L${order.level} filled ${fill.qty.toFixed()} @ ${fill.price.toFixed()}${done ? "" : " (partial)"}`);
    return done;
  }

  private async completeRoundtrip(target: OrderRecord) {
    const entryPrice = new D(target.refPrice ?? target.price);
    const exitPrice = new D(target.avgFillPrice ?? target.price);
    const qty = new D(target.filledQty);
    const entrySide: Side = target.side === "sell" ? "buy" : "sell";
    const coins = this.inverse ? qty.div(entryPrice) : qty;
    const pnl = entrySide === "buy" ? exitPrice.minus(entryPrice).times(coins) : entryPrice.minus(exitPrice).times(coins);
    this.rec.roundtrips++;
    this.rec.realizedPnl = new D(this.rec.realizedPnl).plus(pnl).toFixed();
    const roundtrip: RoundtripRecord = {
      botId: this.id, level: target.level, entryOrderId: target.parentOrderId ?? 0, targetOrderId: target.id, entrySide,
      entryPrice: entryPrice.toFixed(), exitPrice: exitPrice.toFixed(), qty: qty.toFixed(), pnl: pnl.toFixed(), time: Date.now(),
    };
    await this.store.insertRoundtrip(roundtrip);
    this.recentRoundtrips = [roundtrip, ...this.recentRoundtrips].slice(0, 50);
    await this.store.updateBot(this.id, { roundtrips: this.rec.roundtrips, realizedPnl: this.rec.realizedPnl });
    this.info(`Roundtrip #${this.rec.roundtrips} on L${target.level}: PnL ${pnl.toSignificantDigits(8).toFixed()}`);
  }

  private capReached(): boolean {
    const room = new D(this.rec.config.mmQty).minus(this.rec.entryFilledQty);
    return room.lt(this.rec.config.stepQty);
  }

  // ── Orders ───────────────────────────────────────────────────────────

  /**
   * Cancels entry orders beyond the per-side window (e.g. bots started before the
   * 3 + 3 rule), keeping the ones nearest the market. Partly filled orders are kept.
   */
  private async trimEntries(price: Dec) {
    const excess: OrderRecord[] = [];
    for (const side of ["buy", "sell"] as const) {
      const entries = [...this.orders.values()]
        .filter(o => o.role === "entry" && o.side === side && o.status === "open" && o.exchangeOrderId)
        .sort((a, b) => new D(a.price).minus(price).abs().cmp(new D(b.price).minus(price).abs()));
      const pending = [...this.orders.values()].filter(o => o.role === "entry" && o.side === side && o.status === "pending").length;
      const extra = entries.length + pending - this.maxOpenPerSide;
      if (extra <= 0) continue;
      excess.push(...entries.slice(-extra).filter(o => new D(o.filledQty).isZero()));
    }
    if (!excess.length) return;

    let canceled: Set<string>;
    try {
      const res = await this.adapter.cancel(this.symbol, excess.map(o => o.exchangeOrderId!));
      canceled = new Set(res.canceled);
      for (const f of res.failed) this.warn(`Could not cancel extra order ${f.exchangeOrderId}: ${f.error}`);
    } catch (err) {
      this.warn(`Could not cancel extra orders: ${message(err)}`);
      return;
    }
    // An order may have filled just before the cancel arrived: record that first.
    if (this.adapter.live) await this.syncFills(true);
    let n = 0;
    for (const order of excess) {
      if (order.status !== "open" || !canceled.has(order.exchangeOrderId!)) continue;
      order.status = "canceled";
      this.orders.delete(order.id);
      await this.store.updateOrder(order.id, { status: "canceled" });
      n++;
    }
    if (n) this.info(`Canceled ${n} extra entry order(s) to keep ${this.maxOpenPerSide} buy + ${this.maxOpenPerSide} sell open`);
  }

  private async placeEntries(price: Dec) {
    const busy = new Set([...this.orders.values()].map(o => o.level));
    // Always refill: open orders do not reserve the cap. New entries are placed while
    // filled entry volume still has room for at least one more step; the bot halts
    // once filled volume reaches Market making qty (simultaneous fills may overshoot
    // by up to the open entries).
    const room = new D(this.rec.config.mmQty).minus(this.rec.entryFilledQty);
    const stepQty = await this.adapter.roundQty(this.symbol, new D(this.rec.config.stepQty));
    // Only a window of levels rests at once: at most MAX_OPEN_PER_SIDE buy entries and as
    // many sell entries. When one fills, the next free level on that side is placed.
    const openPerSide = { buy: 0, sell: 0 };
    for (const o of this.orders.values()) if (o.role === "entry") openPerSide[o.side]++;
    const candidates = this.levels
      .filter(l => !busy.has(l.k))
      .sort((a, b) => a.price.minus(price).abs().cmp(b.price.minus(price).abs()));
    for (const level of candidates) {
      if (room.lt(stepQty) || this.isStopped || this.isFrozen()) break;
      if (openPerSide[level.side] >= this.maxOpenPerSide) continue;
      const ok = await this.placeOrder({ level: level.k, side: level.side, role: "entry", price: level.price, qty: stepQty });
      if (!ok) break;
      openPerSide[level.side]++;
    }
  }

  private async placeTarget(entry: OrderRecord) {
    const side: Side = entry.side === "buy" ? "sell" : "buy";
    const spread = new D(this.rec.config.targetSpread);
    const raw = side === "sell" ? new D(entry.price).plus(spread) : new D(entry.price).minus(spread);
    if (raw.lte(0)) {
      await this.halt("error", `Target price for L${entry.level} would be ≤ 0`);
      return;
    }
    const price = await this.adapter.roundPrice(this.symbol, raw, side);
    // Spot venues may take the fee out of the bought coin: close only what was received.
    let qty = new D(entry.filledQty);
    if (this.adapter.netEntryQty && entry.exchangeOrderId) {
      try { qty = await this.adapter.netEntryQty(this.symbol, entry.exchangeOrderId, entry.side, qty); }
      catch (err) { this.warn(`Could not read entry fees, using the full quantity: ${message(err)}`); }
    }
    if (qty.lte(0)) {
      await this.halt("error", `Target quantity for L${entry.level} is zero after fees`);
      return;
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (this.isStopped || this.isFrozen()) return;
      const ok = await this.placeOrder({
        level: entry.level, side, role: "target", price, qty,
        parentOrderId: entry.id, refPrice: entry.avgFillPrice ?? entry.price,
      });
      if (ok) return;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
    await this.halt("error", `Could not place the target order for L${entry.level} after 3 attempts`);
  }

  private async placeOrder(o: { level: number; side: Side; role: OrderRole; price: Dec; qty: Dec; parentOrderId?: number; refPrice?: string }): Promise<boolean> {
    const clientId = `0x${randomBytes(16).toString("hex")}`;
    const rec = await this.store.createOrder({
      botId: this.id, level: o.level, side: o.side, role: o.role, price: o.price.toFixed(), qty: o.qty.toFixed(),
      filledQty: "0", avgFillPrice: null, status: "pending", exchangeOrderId: null, clientId,
      parentOrderId: o.parentOrderId ?? null, refPrice: o.refPrice ?? null, error: null, createdAt: Date.now(), filledAt: null,
    });
    this.orders.set(rec.id, rec);
    try {
      const { exchangeOrderId } = await this.adapter.placeLimit({ symbol: this.symbol, side: o.side, price: o.price, qty: o.qty, clientId });
      rec.status = "open";
      rec.exchangeOrderId = exchangeOrderId;
      await this.store.updateOrder(rec.id, { status: "open", exchangeOrderId });
      this.placeErrors = 0;
      return true;
    } catch (err) {
      this.orders.delete(rec.id);
      rec.status = "rejected";
      rec.error = message(err).slice(0, 500);
      await this.store.updateOrder(rec.id, { status: "rejected", error: rec.error });
      this.event("error", `${o.role} ${o.side} L${o.level} @ ${o.price.toFixed()} rejected: ${rec.error}`);
      if (++this.placeErrors >= this.maxPlaceErrors) {
        await this.halt("error", `${this.placeErrors} order placements failed in a row. Last: ${rec.error}`);
      }
      return false;
    }
  }

  /** Orders saved as "pending" were possibly sent before a crash: find them on the venue by client id. */
  private async reconcilePending() {
    for (const order of [...this.orders.values()].filter(o => o.status === "pending")) {
      let oid: string | null = null;
      try { oid = await this.adapter.lookupByClientId(this.symbol, order.clientId); } catch (err) {
        this.warn(`Could not look up pending order ${order.id}: ${message(err)}`);
        continue;
      }
      if (oid) {
        order.status = "open"; order.exchangeOrderId = oid;
        await this.store.updateOrder(order.id, { status: "open", exchangeOrderId: oid });
        this.info(`Recovered order ${order.id} from the exchange after restart`);
      } else {
        this.orders.delete(order.id);
        order.status = "rejected";
        await this.store.updateOrder(order.id, { status: "rejected", error: "Not found on exchange after restart" });
      }
    }
  }

  // ── Stopping ─────────────────────────────────────────────────────────

  /** Instance kill switch. */
  kill(reason = "Stopped manually"): Promise<void> {
    this.stopRequested = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return this.serial(() => this.finish("killed", reason));
  }

  private async halt(status: BotStatus, reason: string) {
    this.stopRequested = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.finish(status, reason);
  }

  /** Cancels every open order, records last-moment fills and sets the final status. */
  private async finish(status: BotStatus, reason: string) {
    if (["killed", "halted_volume_cap", "halted_limit_breach", "error"].includes(this.rec.status)) return;
    const open = [...this.orders.values()];
    const live = open.filter(o => o.exchangeOrderId);
    let failed: { exchangeOrderId: string; error: string }[] = [];
    let ids = live.map(o => o.exchangeOrderId!);
    for (let attempt = 1; attempt <= 3 && ids.length; attempt++) {
      try {
        const res = await this.adapter.cancel(this.symbol, ids);
        failed = res.failed;
      } catch (err) {
        failed = ids.map(id => ({ exchangeOrderId: id, error: message(err) }));
      }
      ids = failed.map(f => f.exchangeOrderId);
      if (ids.length) await new Promise(r => setTimeout(r, 500 * attempt));
    }
    // Live venues: fills that landed before the cancel took effect still count.
    // (Paper cancels are instant, so there is nothing to catch up on.)
    if (this.adapter.live) {
      try { await this.syncFills(false, live); } catch (err) { this.warn(`Final fill check failed: ${message(err)}`); }
    }

    const stillOpen = new Set(ids);
    for (const order of open) {
      if (order.status === "filled" || (order.exchangeOrderId && stillOpen.has(order.exchangeOrderId))) continue;
      order.status = "canceled";
      this.orders.delete(order.id);
      await this.store.updateOrder(order.id, { status: "canceled" });
    }
    const note = stillOpen.size ? ` WARNING: ${stillOpen.size} order(s) could not be canceled — check the exchange.` : "";
    this.rec.status = status;
    this.rec.statusReason = `${reason}.${note}`.replace(/\.\./gu, ".");
    this.rec.stoppedAt = Date.now();
    await this.store.updateBot(this.id, {
      status, statusReason: this.rec.statusReason, stoppedAt: this.rec.stoppedAt, lastPrice: this.rec.lastPrice,
    });
    this.event(stillOpen.size || status === "error" ? "error" : "warn", this.rec.statusReason);
  }

  // ── View ─────────────────────────────────────────────────────────────

  view(): BotView {
    const price = this.rec.lastPrice ? new D(this.rec.lastPrice) : null;
    const open = [...this.orders.values()].sort((a, b) => b.level - a.level);
    const targets = open.filter(o => o.role === "target");
    let unrealized = ZERO;
    if (price) {
      for (const t of targets) {
        const contracts = new D(t.qty).minus(t.filledQty);
        const ref = new D(t.refPrice ?? t.price);
        const qty = this.inverse ? contracts.div(ref) : contracts;
        unrealized = unrealized.plus(t.side === "sell" ? price.minus(ref).times(qty) : ref.minus(price).times(qty));
      }
    }
    const net = new D(this.rec.realizedPnl).plus(unrealized).minus(this.rec.fees);
    const avg = (s: { qty: Dec; notional: Dec }) => (s.qty.isZero() ? null : s.notional.div(s.qty).toSignificantDigits(12).toFixed());
    return {
      id: this.id, config: { ...this.rec.config }, accountName: this.accountName,
      status: this.rec.status, statusReason: this.rec.statusReason,
      lastPrice: this.rec.lastPrice, lastPriceAt: this.lastPriceAt,
      entryFilledQty: this.rec.entryFilledQty, roundtrips: this.rec.roundtrips,
      realizedPnl: this.rec.realizedPnl, unrealizedPnl: unrealized.toFixed(), fees: this.rec.fees, netPnl: net.toFixed(),
      activeLevels: this.levels.length,
      openEntries: open.filter(o => o.role === "entry").map(orderView),
      openTargets: targets.map(orderView),
      recentRoundtrips: this.recentRoundtrips.map(r => ({
        entryOrderId: r.entryOrderId, targetOrderId: r.targetOrderId, level: r.level, entryPrice: r.entryPrice, exitPrice: r.exitPrice, qty: r.qty, pnl: r.pnl, time: r.time,
      })),
      recentFills: this.recentFills.slice(0, 25).map(f => ({
        id: f.id, orderId: f.orderId, level: f.level, role: f.role, side: f.side, price: f.price, qty: f.qty, fee: f.fee, time: f.time,
      })),
      fillSummary: {
        buyCount: this.summary.buy.count, sellCount: this.summary.sell.count,
        buyQty: this.summary.buy.qty.toFixed(), sellQty: this.summary.sell.qty.toFixed(),
        avgBuy: avg(this.summary.buy), avgSell: avg(this.summary.sell),
      },
      events: this.events.slice(0, 30),
      createdAt: this.rec.createdAt, stoppedAt: this.rec.stoppedAt,
    };
  }

  // ── Logging ──────────────────────────────────────────────────────────

  private info(msg: string) { this.event("info", msg); }
  private warn(msg: string) {
    if (msg === this.lastWarn) return; // avoid flooding on repeated network errors
    this.lastWarn = msg;
    this.event("warn", msg);
  }
  private event(level: EventView["level"], msg: string) {
    const time = Date.now();
    this.events = [{ time, level, message: msg }, ...this.events].slice(0, 30);
    this.store.insertEvent({ botId: this.id, level, message: msg, time }).catch(() => undefined);
  }
}

function orderView(o: OrderRecord): OrderView {
  return {
    id: o.id, level: o.level, side: o.side, role: o.role, price: o.price, qty: o.qty, filledQty: o.filledQty,
    status: o.status, refPrice: o.refPrice, parentOrderId: o.parentOrderId, createdAt: o.createdAt,
  };
}

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
