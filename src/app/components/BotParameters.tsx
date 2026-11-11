"use client";
import { useEffect, useState } from "react";
import { EXCHANGES, exchangeInfo } from "@/shared/exchanges";
import type { AccountView, BotMode, ExchangeId } from "@/shared/types";
import { api, fmt } from "../lib/client";
import { Card, Field } from "./ui";

interface Props {
  accounts: AccountView[];
  activeAccountId: number | null;
  notify: (kind: "ok" | "error", text: string) => void;
  onCreated: () => void;
}

const empty = {
  name: "", exchange: "hyperliquid" as ExchangeId, mode: "paper" as BotMode, accountId: "", symbol: "",
  spread: "", targetSpread: "", steps: "5", stepQty: "", mmQty: "", upperLimit: "", lowerLimit: "", entryPrice: "",
};

export function BotParameters({ accounts, activeAccountId, notify, onCreated }: Props) {
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [symbols, setSymbols] = useState<{ list: string[] | null; loading: boolean; error: string | null }>({ list: null, loading: true, error: null });
  const info = exchangeInfo(form.exchange);

  const [symbolsTry, setSymbolsTry] = useState(0);

  // Load the exchange's symbol list whenever the exchange changes (or Retry is pressed).
  // A copy of the last good list per exchange is kept in this browser so the dropdown
  // still works when a request is blocked; failed loads are retried 3 times.
  useEffect(() => {
    let cancelled = false;
    const cacheKey = `gridbot.symbols.${form.exchange}`;
    let cached: string[] | null = null;
    try { cached = JSON.parse(localStorage.getItem(cacheKey) ?? "null"); } catch { /* storage unavailable */ }
    const apply = (list: string[]) => setForm(f => (list.includes(f.symbol) ? f : { ...f, symbol: list[0] ?? "" }));
    setSymbols({ list: cached, loading: !cached, error: null });
    if (cached) apply(cached);

    (async () => {
      let lastError = "";
      for (let attempt = 1; attempt <= 3 && !cancelled; attempt++) {
        try {
          const { symbols: list } = await api<{ symbols: string[] }>(`/api/symbols?exchange=${form.exchange}`);
          if (cancelled) return;
          try { localStorage.setItem(cacheKey, JSON.stringify(list)); } catch { /* ignore */ }
          setSymbols({ list, loading: false, error: null });
          apply(list);
          return;
        } catch (err) {
          lastError = (err as Error).message;
          await new Promise(r => setTimeout(r, 800 * attempt));
        }
      }
      if (cancelled) return;
      setSymbols(s => ({ list: s.list, loading: false, error: lastError }));
      if (!cached) notify("error", `Could not load ${exchangeInfo(form.exchange).label} symbols: ${lastError}`);
    })();
    return () => { cancelled = true; };
  }, [form.exchange, symbolsTry]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [key]: e.target.value }));

  // Default the account to the active one when it matches the chosen exchange.
  const matching = accounts.filter(a => a.exchange === form.exchange);
  useEffect(() => {
    setForm(f => {
      if (matching.some(a => String(a.id) === f.accountId)) return f;
      const active = matching.find(a => a.id === activeAccountId) ?? matching[0];
      return { ...f, accountId: active ? String(active.id) : "" };
    });
  }, [form.exchange, activeAccountId, accounts.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const account = accounts.find(a => String(a.id) === form.accountId) ?? null;
  const liveProblem = form.mode !== "live" ? null
    : !info.live ? `Live trading for ${info.label} is not available yet.`
    : !account ? `Add a ${info.label} account in Account Settings first.`
    : null;

  const n = (v: string) => (v.trim() === "" ? NaN : Number(v));
  const steps = Math.trunc(n(form.steps));
  const entry = n(form.entryPrice), spread = n(form.spread), targetSpread = n(form.targetSpread);
  const range = n(form.upperLimit) - n(form.lowerLimit);
  const targetTooWide = Number.isFinite(targetSpread) && Number.isFinite(range) && targetSpread >= range;
  const r = (x: number) => fmt(Number(x.toPrecision(10)));
  const maxEntries = Math.floor(n(form.mmQty) / n(form.stepQty) + 1e-9);

  async function useMarket() {
    if (!form.symbol.trim()) return notify("error", "Enter a symbol first.");
    setBusy(true);
    try {
      const { price } = await api<{ price: string }>(`/api/price?exchange=${form.exchange}&symbol=${encodeURIComponent(form.symbol.trim())}`);
      const p = Number(price);
      const round = (x: number) => String(Number(x.toPrecision(6)));
      setForm(f => ({
        ...f, entryPrice: price,
        upperLimit: f.upperLimit || round(p * 1.1), lowerLimit: f.lowerLimit || round(p * 0.9),
        spread: f.spread || round(p * 0.005), targetSpread: f.targetSpread || round(p * 0.004),
      }));
    } catch (err) {
      notify("error", (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addBot(e: React.FormEvent) {
    e.preventDefault();
    if (liveProblem) return notify("error", liveProblem);
    if (form.mode === "live" && !window.confirm(
      `Start LIVE bot "${form.name}" on ${info.label} with account "${account?.name}"? It will place real orders.`)) return;
    setBusy(true);
    try {
      await api("/api/bots", "POST", {
        ...form, steps, accountId: form.mode === "live" && account ? account.id : null,
      });
      notify("ok", `Bot "${form.name}" added and started.`);
      setForm(f => ({ ...f, name: "" }));
      onCreated();
    } catch (err) {
      notify("error", (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <h1 className="page-title">Create New Bot</h1>
      <form className="form-grid" onSubmit={addBot} autoComplete="off">
        <Card title="Exchange & Key" icon="⚿">
          <Field label="Bot name" info="A unique name for this bot instance.">
            <input value={form.name} onChange={set("name")} placeholder="sol-grid-1" maxLength={60} required />
          </Field>
          <Field label="Exchange" info="Venue whose prices (and, in Live mode, order book) this bot uses.">
            <select value={form.exchange} onChange={set("exchange")}>
              {EXCHANGES.map(x => <option key={x.id} value={x.id}>{x.label.toUpperCase()}</option>)}
            </select>
          </Field>
          <Field label="Mode" info="Paper simulates fills on live prices. Live places real orders.">
            <select value={form.mode} onChange={set("mode")}>
              <option value="paper">Paper (simulated)</option>
              <option value="live" disabled={!info.live}>Live{info.live ? "" : " (not available)"}</option>
            </select>
          </Field>
          <Field label="API key / account" info="Saved account used for Live orders. Manage accounts in Account Settings.">
            <select value={form.accountId} onChange={set("accountId")} disabled={form.mode !== "live"}>
              {form.mode !== "live" && <option value="">Not needed in Paper mode</option>}
              {form.mode === "live" && matching.length === 0 && <option value="">No {info.label} account saved</option>}
              {form.mode === "live" && matching.map(a => <option key={a.id} value={a.id}>{a.name} · {a.publicKeyMasked}</option>)}
            </select>
          </Field>
          {form.mode === "live" && <p className={liveProblem ? "hint warn" : "hint live"}>{liveProblem ?? (form.exchange === "binance"
            ? "Real Spot orders. The account needs the coin for sells and the quote currency for buys; this is checked before the bot starts."
            : "Real orders will be placed.")}</p>}
        </Card>

        <Card title="Trading" icon="〰">
          <Field label="Symbol" info={`All tradable symbols on ${info.label}${symbols.list ? ` (${symbols.list.length})` : ""}. Type a letter to jump through the list.`}>
            <div className="inline">
              {symbols.list ? (
                <select value={form.symbol} onChange={set("symbol")} required>
                  {!symbols.list.includes(form.symbol) && <option value="">Select a symbol…</option>}
                  {symbols.list.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              ) : symbols.loading ? (
                <select disabled><option>Loading {info.label} symbols…</option></select>
              ) : (
                <input value={form.symbol} onChange={set("symbol")} placeholder={info.symbolHint} maxLength={40} required spellCheck={false}
                  title={symbols.error ?? undefined} />
              )}
              <button type="button" className="btn ghost" onClick={useMarket} disabled={busy}>Use market</button>
            </div>
          </Field>
          {symbols.error && (
            <p className="hint warn symbol-error">
              {symbols.list ? "Showing the last saved list — the latest list could not be loaded. " : "The symbol list could not be loaded, so you can type the symbol. "}
              <button type="button" className="link-btn inline-link" onClick={() => setSymbolsTry(n => n + 1)}>Retry</button>
              <span className="muted"> ({symbols.error})</span>
            </p>
          )}
          <Num label="Spread" info="Price distance from the entry price to each next grid level." value={form.spread} onChange={set("spread")} />
          <Num label="Target spread" info="Profit distance: a filled sell gets a buy target this much lower; a filled buy gets a sell target this much higher." value={form.targetSpread} onChange={set("targetSpread")} />
          {targetTooWide && <p className="hint warn">Target spread {form.targetSpread} is wider than the whole price range ({r(range)}). The bot will not start with this — check the value.</p>}
          <div className="row2">
            <Field label="Steps" info="Grid levels above and below the entry price. Only 3 buy and 3 sell orders rest at a time; when one fills, the next level is placed.">
              <input type="number" min={1} max={100} step={1} value={form.steps} onChange={set("steps")} required />
            </Field>
            <Num label="Per step qty" info={form.exchange.startsWith("deribit") ? "Order size at each level, in Deribit units: USD for BTC-PERPETUAL (multiples of 10) and ETH-PERPETUAL (multiples of 1); coins for *_USDC perps." : "Order size at each grid level."} value={form.stepQty} onChange={set("stepQty")} />
          </div>
        </Card>

        <Card title="Risk / Limits" icon="⛨">
          <Num label="Market making qty" info="Ceiling on steps in use: filled entries whose target has not filled yet. A completed roundtrip frees its step. When open exposure reaches this, the bot stops and cancels all its orders." value={form.mmQty} onChange={set("mmQty")} />
          <div className="row2">
            <Num label="Upper limit" info="If the market price rises above this, the bot stops completely." value={form.upperLimit} onChange={set("upperLimit")} />
            <Num label="Lower limit" info="If the market price falls below this, the bot stops completely." value={form.lowerLimit} onChange={set("lowerLimit")} />
          </div>
          <Num label="Bot entry price" info="Baseline price the grid levels are built around." value={form.entryPrice} onChange={set("entryPrice")} />
        </Card>

        <Card title="Summary" icon="▦" className="summary-card">
          <dl className="summary">
            <div><dt>Grid levels</dt><dd>{Number.isFinite(steps) ? `${steps} buy + ${steps} sell` : "—"}</dd></div>
            <div><dt>Grid range</dt><dd>{Number.isFinite(entry) && Number.isFinite(spread) && Number.isFinite(steps)
              ? `${fmt(entry - steps * spread)} – ${fmt(entry + steps * spread)}` : "—"}</dd></div>
            <div><dt>Steps that can be in use</dt><dd>{Number.isFinite(maxEntries) ? maxEntries : "—"}</dd></div>
            <div><dt>Open at once</dt><dd>{Number.isFinite(steps) ? `${Math.min(3, steps)} buy + ${Math.min(3, steps)} sell` : "—"}</dd></div>
            <div><dt>Sell entry → target</dt><dd className={targetTooWide ? "neg" : ""}>{Number.isFinite(entry) && Number.isFinite(spread) && Number.isFinite(targetSpread) ? `SELL ${r(entry + spread)} → BUY ${r(entry + spread - targetSpread)}` : "—"}</dd></div>
            <div><dt>Buy entry → target</dt><dd className={targetTooWide ? "neg" : ""}>{Number.isFinite(entry) && Number.isFinite(spread) && Number.isFinite(targetSpread) ? `BUY ${r(entry - spread)} → SELL ${r(entry - spread + targetSpread)}` : "—"}</dd></div>
            <div><dt>Mode</dt><dd className={form.mode === "live" ? "live-text" : ""}>{form.mode === "live" ? `LIVE · ${account?.name ?? "no account"}` : "Paper"}</dd></div>
          </dl>
          <button className={`btn primary big ${form.mode === "live" ? "live" : ""}`} disabled={busy}>
            {busy ? "Working…" : form.mode === "live" ? "ADD LIVE BOT" : "ADD BOT"}
          </button>
          <p className="hint">The bot starts immediately and appears on the Dashboard. Other bots keep running.</p>
        </Card>
      </form>
    </div>
  );
}

function Num({ label, info, value, onChange }: { label: string; info: string; value: string; onChange: React.ChangeEventHandler<HTMLInputElement> }) {
  return (
    <Field label={label} info={info}>
      <input type="text" inputMode="decimal" pattern="\d+(\.\d+)?" value={value} onChange={onChange} required spellCheck={false} />
    </Field>
  );
}
