import Decimal from "decimal.js";
import { exchangeInfo } from "../../shared/exchanges";
import type { AccountView, BotConfig, ExchangeId, Snapshot } from "../../shared/types";
import { decryptSecret, encryptSecret, maskKey } from "../crypto";
import { HyperliquidAccount, HyperliquidAdapter, validateAddress, validatePrivateKey, verifyHyperliquidKey } from "../exchanges/hyperliquid";
import { BinanceAccount, BinanceAdapter, validateBinanceKey, verifyBinanceKey } from "../exchanges/binance";
import { DeribitAccount, DeribitAdapter, verifyDeribitKey } from "../exchanges/deribit";
import { PaperAdapter } from "../exchanges/paper";
import { fetchPrice } from "../exchanges/prices";
import type { AccountClient, ExchangeAdapter } from "../exchanges/types";
import type { AccountRecord, BotRecord, Store } from "../store/types";
import { GridBot, MAX_OPEN_PER_SIDE, message } from "./grid";

export class UserError extends Error {}

export interface AccountInput {
  name: string;
  exchange: ExchangeId;
  publicKey: string;
  secret: string;
  passphrase?: string;
}

export interface ManagerOptions {
  tickMs?: number;
  /** Override adapter creation (tests). */
  adapterFactory?: (config: BotConfig, account: AccountRecord | null) => ExchangeAdapter;
  /** Override the exchange key check (tests). */
  verifyKey?: (exchange: ExchangeId, address: string, privateKey: string) => Promise<unknown>;
}

/** Owns every bot instance, the saved accounts, and the master kill switch. */
export class BotManager {
  private bots = new Map<number, GridBot>();
  private hlAccounts = new Map<number, HyperliquidAccount>();
  private bnAccounts = new Map<number, BinanceAccount>();
  private dbAccounts = new Map<number, DeribitAccount>();
  private frozen = false;

  constructor(private readonly store: Store, private readonly opts: ManagerOptions = {}) {}

  async init(): Promise<void> {
    await this.store.init();
    const accounts = new Map((await this.store.listAccounts()).map(a => [a.id, a]));
    for (const rec of await this.store.listBots()) {
      try {
        const account = rec.config.accountId ? accounts.get(rec.config.accountId) ?? null : null;
        const bot = this.newBot(rec, account);
        await bot.load();
        this.bots.set(rec.id, bot);
        if (rec.status === "idle" || rec.status === "running") bot.start();
      } catch (err) {
        console.error(`Could not resume bot ${rec.id} (${rec.config.name}): ${message(err)}`);
        await this.store.updateBot(rec.id, { status: "error", statusReason: `Could not resume after restart: ${message(err)}`, stoppedAt: Date.now() });
      }
    }
  }

  /** Graceful process shutdown: loops stop, orders stay, bots resume on next start. */
  shutdown(): void {
    for (const bot of this.bots.values()) bot.suspend();
  }

  // ── Accounts ─────────────────────────────────────────────────────────

  async createAccount(input: AccountInput): Promise<AccountView> {
    const info = exchangeInfo(input.exchange);
    let publicKey = input.publicKey.trim();
    let secret = input.secret.trim();
    if (!publicKey || !secret) throw new UserError(`${info.keyLabel} and ${info.secretLabel} are required`);
    if (!info.accounts) throw new UserError(`${info.label} accounts are not supported yet`);
    try {
      if (isDeribit(input.exchange)) {
        if (!/^[A-Za-z0-9_-]{4,64}$/u.test(publicKey)) throw new Error("Deribit Client ID looks wrong (letters, digits, - and _ only)");
        if (!/^[A-Za-z0-9_-]{8,128}$/u.test(secret)) throw new Error("Deribit Client secret looks wrong (letters, digits, - and _ only)");
        await (this.opts.verifyKey ?? verifyDeribitKey)(input.exchange, publicKey, secret);
      } else if (input.exchange === "binance") {
        ({ apiKey: publicKey, secret } = validateBinanceKey(publicKey, secret));
        if (this.opts.verifyKey) await this.opts.verifyKey(input.exchange, publicKey, secret);
        else await verifyBinanceKey(publicKey, secret);
      } else {
        publicKey = validateAddress(publicKey);
        secret = validatePrivateKey(secret);
        await (this.opts.verifyKey ?? verifyHyperliquidKey)(input.exchange, publicKey, secret);
      }
    } catch (err) {
      throw new UserError(message(err));
    }
    const existing = await this.store.listAccounts();
    if (existing.some(a => a.exchange === input.exchange && a.publicKey === publicKey)) {
      throw new UserError(`This ${info.keyLabel.toLowerCase()} is already saved for ${info.label}`);
    }
    const name = input.name.trim() || `${info.label} ${publicKey.slice(0, 6)}…${publicKey.slice(-4)}`;
    if (existing.some(a => a.name.toLowerCase() === name.toLowerCase())) {
      throw new UserError("An account with this name already exists");
    }
    const rec = await this.store.createAccount({
      name, exchange: input.exchange, publicKey,
      secretEnc: encryptSecret(secret), passphraseEnc: input.passphrase?.trim() ? encryptSecret(input.passphrase.trim()) : null,
    });
    return accountView(rec);
  }

  async deleteAccount(id: number): Promise<void> {
    const inUse = [...this.bots.values()].find(b => b.rec.config.accountId === id && !b.isStopped);
    if (inUse) throw new UserError(`Stop bot "${inUse.rec.config.name}" before deleting its account`);
    await this.store.deleteAccount(id);
    this.hlAccounts.delete(id);
    this.bnAccounts.delete(id);
    this.dbAccounts.delete(id);
  }

  private hyperliquid(account: AccountRecord): HyperliquidAccount {
    let client = this.hlAccounts.get(account.id);
    if (!client) {
      client = new HyperliquidAccount(account.exchange, account.publicKey, decryptSecret(account.secretEnc));
      this.hlAccounts.set(account.id, client);
    }
    return client;
  }

  private binance(account: AccountRecord): BinanceAccount {
    let client = this.bnAccounts.get(account.id);
    if (!client) {
      client = new BinanceAccount(account.publicKey, decryptSecret(account.secretEnc));
      this.bnAccounts.set(account.id, client);
    }
    return client;
  }

  private deribit(account: AccountRecord): DeribitAccount {
    let client = this.dbAccounts.get(account.id);
    if (!client) {
      client = new DeribitAccount(account.exchange, account.publicKey, decryptSecret(account.secretEnc));
      this.dbAccounts.set(account.id, client);
    }
    return client;
  }

  private accountClient(account: AccountRecord): AccountClient {
    if (account.exchange === "binance") return this.binance(account);
    if (isDeribit(account.exchange)) return this.deribit(account);
    return this.hyperliquid(account);
  }

  // ── Bots ─────────────────────────────────────────────────────────────

  private adapterFor(config: BotConfig, account: AccountRecord | null): ExchangeAdapter {
    if (this.opts.adapterFactory) return this.opts.adapterFactory(config, account);
    if (config.mode === "paper") return new PaperAdapter(symbol => fetchPrice(config.exchange, symbol));
    if (!account) throw new UserError("Live bots need an account");
    if (config.exchange === "hyperliquid" || config.exchange === "hyperliquid-testnet") {
      return new HyperliquidAdapter(this.hyperliquid(account));
    }
    if (config.exchange === "binance") return new BinanceAdapter(this.binance(account));
    if (isDeribit(config.exchange)) return new DeribitAdapter(this.deribit(account));
    throw new UserError(`Live trading is not available for ${exchangeInfo(config.exchange).label} yet — use Paper mode`);
  }

  private newBot(rec: BotRecord, account: AccountRecord | null): GridBot {
    return new GridBot(rec, this.store, this.adapterFor(rec.config, account), {
      tickMs: this.opts.tickMs, accountName: account?.name ?? null, isFrozen: () => this.frozen,
    });
  }

  async createBot(input: BotConfig): Promise<number> {
    if (this.frozen) throw new UserError("Master kill switch is in progress");
    const config: BotConfig = { ...input, name: input.name.trim(), symbol: input.symbol.trim().toUpperCase() };
    validateNumbers(config);
    if ([...this.bots.values()].some(b => b.rec.config.name.toLowerCase() === config.name.toLowerCase())) {
      throw new UserError(`A bot named "${config.name}" already exists`);
    }

    let account: AccountRecord | null = null;
    if (config.mode === "live") {
      if (!exchangeInfo(config.exchange).live) {
        throw new UserError(`Live trading is not available for ${exchangeInfo(config.exchange).label} yet — use Paper mode`);
      }
      if (!config.accountId) throw new UserError("Choose an account for live trading");
      account = await this.store.getAccount(config.accountId);
      if (!account) throw new UserError("The selected account no longer exists");
      if (account.exchange !== config.exchange) {
        throw new UserError(`Account "${account.name}" is for ${exchangeInfo(account.exchange).label}, not ${exchangeInfo(config.exchange).label}`);
      }
    } else {
      config.accountId = null;
    }

    const adapter = this.adapterFor(config, account);
    const draft: BotRecord = {
      id: 0, config, status: "idle", statusReason: null, entryFilledQty: "0", roundtrips: 0, realizedPnl: "0",
      fees: "0", lastPrice: null, fillCursor: Date.now(), createdAt: Date.now(), stoppedAt: null,
    };
    let levels;
    let price: Decimal;
    try {
      levels = await GridBot.computeLevels(draft, adapter);
      price = await adapter.getPrice(config.symbol);
    } catch (err) {
      throw new UserError(message(err));
    }
    if (!levels.length) throw new UserError("No grid level falls inside the upper/lower limits — widen the limits or reduce the spread");
    if (price.gt(config.upperLimit) || price.lt(config.lowerLimit)) {
      throw new UserError(`Current ${config.symbol} price ${price.toFixed()} is outside your limits ${config.lowerLimit}–${config.upperLimit}`);
    }
    const lowest = levels.reduce((min, l) => (l.price.lt(min) ? l.price : min), levels[0].price);
    const lowestTarget = lowest.minus(config.targetSpread);
    try {
      await adapter.validateOrder(config.symbol, lowestTarget.gt(0) ? Decimal.min(lowest, lowestTarget) : lowest, new Decimal(config.stepQty));
    } catch (err) {
      throw new UserError(message(err));
    }

    // Spot venues: the account must hold the coins for the first sells and the quote for the first buys.
    if (adapter.preflight) {
      const stepQty = new Decimal(config.stepQty);
      const perSide = { buy: 0, sell: 0 };
      const first = [...levels]
        .sort((a, b) => a.price.minus(price).abs().cmp(b.price.minus(price).abs()))
        .filter(l => (perSide[l.side] < MAX_OPEN_PER_SIDE ? (perSide[l.side]++, true) : false));
      const need = first.reduce((n, l) => (l.side === "sell"
        ? { ...n, base: n.base.plus(stepQty) }
        : { ...n, quote: n.quote.plus(l.price.times(stepQty)) }), { base: new Decimal(0), quote: new Decimal(0) });
      try { await adapter.preflight(config.symbol, need); } catch (err) { throw new UserError(message(err)); }
    }

    const rec = await this.store.createBot(config, "idle");
    const bot = new GridBot(rec, this.store, adapter, {
      tickMs: this.opts.tickMs, accountName: account?.name ?? null, isFrozen: () => this.frozen,
    });
    await bot.load();
    this.bots.set(rec.id, bot);
    bot.start();
    return rec.id;
  }

  async stopBot(id: number): Promise<void> {
    const bot = this.bots.get(id);
    if (!bot) throw new UserError("Bot not found");
    await bot.kill("Stopped with the instance kill switch");
  }

  async archiveBot(id: number): Promise<void> {
    const bot = this.bots.get(id);
    if (!bot) throw new UserError("Bot not found");
    if (!bot.isStopped) throw new UserError("Stop the bot before removing it");
    await this.store.archiveBot(id);
    this.bots.delete(id);
  }

  /** Master kill switch: freeze every loop, stop every bot, blanket-cancel every live account. */
  async killAll(): Promise<{ bots: number; accountCancels: { account: string; canceled: number; failed: number; error?: string }[] }> {
    this.frozen = true;
    try {
      const active = [...this.bots.values()].filter(b => !["killed", "halted_volume_cap", "halted_limit_breach", "error"].includes(b.rec.status));
      await Promise.allSettled(active.map(b => b.kill("Stopped by the MASTER KILL SWITCH")));
      const accountCancels = [];
      for (const account of await this.store.listAccounts()) {
        if (!exchangeInfo(account.exchange).live) continue;
        try {
          const res = await this.accountClient(account).cancelAllOpen();
          accountCancels.push({ account: account.name, ...res });
        } catch (err) {
          accountCancels.push({ account: account.name, canceled: 0, failed: 0, error: message(err) });
        }
      }
      return { bots: active.length, accountCancels };
    } finally {
      this.frozen = false;
    }
  }

  async price(exchange: ExchangeId, symbol: string): Promise<string> {
    try { return (await fetchPrice(exchange, symbol)).toFixed(); } catch (err) { throw new UserError(message(err)); }
  }

  async snapshot(): Promise<Snapshot> {
    const bots = [...this.bots.values()].map(b => b.view()).sort((a, b) => b.id - a.id);
    const accounts = (await this.store.listAccounts()).map(accountView);
    return {
      serverTime: Date.now(), storage: this.store.kind, frozen: this.frozen,
      totals: {
        netPnl: bots.reduce((s, b) => s.plus(b.netPnl), new Decimal(0)).toFixed(),
        runningBots: bots.filter(b => b.status === "running" || b.status === "idle").length,
        totalBots: bots.length,
        roundtrips: bots.reduce((s, b) => s + b.roundtrips, 0),
      },
      bots, accounts,
    };
  }
}

function isDeribit(exchange: ExchangeId): boolean {
  return exchange === "deribit" || exchange === "deribit-testnet";
}

function accountView(a: AccountRecord): AccountView {
  return {
    id: a.id, name: a.name, exchange: a.exchange, publicKeyMasked: maskKey(a.publicKey),
    hasPassphrase: a.passphraseEnc !== null, createdAt: a.createdAt,
  };
}

function validateNumbers(c: BotConfig) {
  const num = (label: string, v: string) => {
    let d: Decimal;
    try { d = new Decimal(v); } catch { throw new UserError(`${label} must be a number`); }
    if (!d.isFinite() || d.lte(0)) throw new UserError(`${label} must be greater than 0`);
    return d;
  };
  if (!c.name) throw new UserError("BotName is required");
  if (!c.symbol) throw new UserError("Coin / asset symbol is required");
  const spread = num("Spread", c.spread);
  num("Target spread", c.targetSpread);
  const stepQty = num("Per step quantity", c.stepQty);
  const mmQty = num("Market making quantity", c.mmQty);
  const upper = num("Upper limit", c.upperLimit);
  const lower = num("Lower limit", c.lowerLimit);
  const entry = num("Bot entry price", c.entryPrice);
  if (!Number.isInteger(c.steps) || c.steps < 1 || c.steps > 100) throw new UserError("Steps must be a whole number from 1 to 100");
  if (mmQty.lt(stepQty)) throw new UserError("Market making quantity must be at least one per-step quantity");
  if (!lower.lt(entry) || !entry.lt(upper)) throw new UserError("Entry price must be between the lower and upper limits");
  if (spread.gte(upper.minus(lower))) throw new UserError("Spread is wider than the whole price range");
}
