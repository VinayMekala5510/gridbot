"use client";
import { useState } from "react";
import { EXCHANGES, exchangeInfo } from "@/shared/exchanges";
import type { AccountView, BotMode, ExchangeId } from "@/shared/types";
import { api, fmt } from "../lib/client";

interface Props {
  accounts: AccountView[];
  activeAccountId: number | null;
  onActiveAccount: (id: number | null) => void;
  notify: (kind: "ok" | "error", text: string) => void;
}

const emptyAccount = { name: "", exchange: "hyperliquid" as ExchangeId, publicKey: "", secret: "", passphrase: "" };
const emptyBot = {
  name: "", exchange: "hyperliquid" as ExchangeId, mode: "paper" as BotMode, symbol: "",
  spread: "", targetSpread: "", steps: "5", stepQty: "", mmQty: "", upperLimit: "", lowerLimit: "", entryPrice: "",
};

export function Sidebar({ accounts, activeAccountId, onActiveAccount, notify }: Props) {
  return (
    <aside className="sidebar">
      <AccountSection accounts={accounts} activeAccountId={activeAccountId} onActiveAccount={onActiveAccount} notify={notify} />
      <BotSection accounts={accounts} activeAccountId={activeAccountId} notify={notify} />
    </aside>
  );
}

function AccountSection({ accounts, activeAccountId, onActiveAccount, notify }: Props) {
  const [form, setForm] = useState(emptyAccount);
  const [saving, setSaving] = useState(false);
  const [showList, setShowList] = useState(false);
  const info = exchangeInfo(form.exchange);
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [key]: e.target.value }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const account = await api<AccountView>("/api/accounts", "POST", form);
      setForm(f => ({ ...emptyAccount, exchange: f.exchange }));
      onActiveAccount(account.id);
      notify("ok", `Account "${account.name}" saved and selected.`);
    } catch (err) {
      notify("error", (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(account: AccountView) {
    if (!window.confirm(`Delete account "${account.name}"? Its encrypted keys are wiped from the server.`)) return;
    try {
      await api(`/api/accounts/${account.id}`, "DELETE");
      if (activeAccountId === account.id) onActiveAccount(null);
      notify("ok", `Account "${account.name}" deleted.`);
    } catch (err) {
      notify("error", (err as Error).message);
    }
  }

  return (
    <section className="side-section">
      <header className="side-head"><span className="side-index">A</span><h2>Account settings</h2></header>

      <label className="field">
        <span>Active account</span>
        <select value={activeAccountId ?? ""} onChange={e => onActiveAccount(e.target.value ? Number(e.target.value) : null)}>
          <option value="">— None (paper trading only) —</option>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.name} · {exchangeInfo(a.exchange).label}</option>)}
        </select>
      </label>
      {accounts.length > 0 && (
        <button type="button" className="link-btn" onClick={() => setShowList(s => !s)}>
          {showList ? "Hide" : "Manage"} saved accounts ({accounts.length})
        </button>
      )}
      {showList && (
        <ul className="account-list">
          {accounts.map(a => (
            <li key={a.id}>
              <div><strong>{a.name}</strong><small>{exchangeInfo(a.exchange).label} · {a.publicKeyMasked}</small></div>
              <button type="button" className="icon-btn" aria-label={`Delete ${a.name}`} onClick={() => remove(a)}>✕</button>
            </li>
          ))}
        </ul>
      )}

      <form className="stack" onSubmit={save} autoComplete="off">
        <div className="subhead">Add account</div>
        <label className="field"><span>Account name</span>
          <input value={form.name} onChange={set("name")} placeholder="Main Hyperliquid account" maxLength={100} required /></label>
        <label className="field"><span>Exchange / network</span>
          <select value={form.exchange} onChange={set("exchange")}>
            {EXCHANGES.map(x => <option key={x.id} value={x.id}>{x.label}{x.live ? "" : " (paper only for now)"}</option>)}
          </select></label>
        <label className="field"><span>{info.keyLabel}</span>
          <input value={form.publicKey} onChange={set("publicKey")} spellCheck={false} required /></label>
        <label className="field"><span>{info.secretLabel}</span>
          <input type="password" value={form.secret} onChange={set("secret")} spellCheck={false} autoComplete="new-password" required /></label>
        <label className="field"><span>Passphrase <em>optional</em></span>
          <input type="password" value={form.passphrase} onChange={set("passphrase")} autoComplete="new-password" /></label>
        {form.exchange.startsWith("hyperliquid") && (
          <p className="hint">Use an <b>API wallet</b> key from Hyperliquid → More → API, not your main wallet key. The address above is your main account.</p>
        )}
        <button className="btn secondary" disabled={saving}>{saving ? "Saving…" : "Save account"}</button>
        <p className="hint">Keys are encrypted (AES-256-GCM) on the server and never sent back to the browser.</p>
      </form>
    </section>
  );
}

function BotSection({ accounts, activeAccountId, notify }: Omit<Props, "onActiveAccount">) {
  const [form, setForm] = useState(emptyBot);
  const [busy, setBusy] = useState(false);
  const info = exchangeInfo(form.exchange);
  const active = accounts.find(a => a.id === activeAccountId) ?? null;
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [key]: e.target.value }));

  const n = (v: string) => (v.trim() === "" ? NaN : Number(v));
  const steps = Math.trunc(n(form.steps));
  const maxEntries = n(form.mmQty) / n(form.stepQty);
  const liveProblem = form.mode !== "live" ? null
    : !info.live ? `Live trading for ${info.label} is not available yet.`
    : !active ? "Select an active account above."
    : active.exchange !== form.exchange ? `Active account "${active.name}" is for ${exchangeInfo(active.exchange).label}.`
    : null;

  async function useMarket() {
    if (!form.symbol.trim()) return notify("error", "Enter a coin / asset symbol first.");
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
      `Start LIVE bot "${form.name}" on ${info.label} with account "${active?.name}"? It will place real orders.`)) return;
    setBusy(true);
    try {
      await api("/api/bots", "POST", {
        ...form, steps, accountId: form.mode === "live" ? activeAccountId : null,
      });
      notify("ok", `Bot "${form.name}" added and started.`);
      setForm(f => ({ ...f, name: "" }));
    } catch (err) {
      notify("error", (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="side-section">
      <header className="side-head"><span className="side-index">B</span><h2>Bot parameters</h2></header>
      <form className="stack" onSubmit={addBot} autoComplete="off">
        <label className="field"><span>BotName</span>
          <input value={form.name} onChange={set("name")} placeholder="btc-grid-1" maxLength={60} required /></label>
        <div className="row2">
          <label className="field"><span>Target exchange</span>
            <select value={form.exchange} onChange={set("exchange")}>
              {EXCHANGES.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select></label>
          <label className="field"><span>Mode</span>
            <select value={form.mode} onChange={set("mode")}>
              <option value="paper">Paper (simulated)</option>
              <option value="live" disabled={!info.live}>Live{info.live ? "" : " (not available)"}</option>
            </select></label>
        </div>
        {form.mode === "live" && (
          <p className={liveProblem ? "hint warn" : "hint live"}>
            {liveProblem ?? `Real orders via "${active?.name}".`}
          </p>
        )}
        <label className="field"><span>Coin / asset symbol</span>
          <div className="inline">
            <input value={form.symbol} onChange={set("symbol")} placeholder={info.symbolHint} maxLength={40} required spellCheck={false} />
            <button type="button" className="btn ghost small" onClick={useMarket} disabled={busy}>Use market</button>
          </div></label>
        <div className="row2">
          <Num label="Spread" hint="price distance" value={form.spread} onChange={set("spread")} />
          <Num label="Target spread" hint="profit distance" value={form.targetSpread} onChange={set("targetSpread")} />
        </div>
        <div className="row2">
          <label className="field"><span>Steps <em>per side</em></span>
            <input type="number" min={1} max={100} step={1} value={form.steps} onChange={set("steps")} required /></label>
          <Num label="Per step qty" value={form.stepQty} onChange={set("stepQty")} />
        </div>
        <Num label="Market making qty" hint="hard volume ceiling" value={form.mmQty} onChange={set("mmQty")} />
        <div className="row2">
          <Num label="Upper limit" value={form.upperLimit} onChange={set("upperLimit")} />
          <Num label="Lower limit" value={form.lowerLimit} onChange={set("lowerLimit")} />
        </div>
        <Num label="Bot entry price" value={form.entryPrice} onChange={set("entryPrice")} />

        <div className="preview">
          <div><span>Grid levels</span><b>{Number.isFinite(steps) ? `${steps} buy + ${steps} sell` : "—"}</b></div>
          <div><span>Range</span><b>{Number.isFinite(n(form.spread)) && Number.isFinite(steps) && Number.isFinite(n(form.entryPrice))
            ? `${fmt(n(form.entryPrice) - steps * n(form.spread))} – ${fmt(n(form.entryPrice) + steps * n(form.spread))}` : "—"}</b></div>
          <div><span>Max entry fills</span><b>{Number.isFinite(maxEntries) ? fmt(Math.floor(maxEntries + 1e-9), 0) : "—"}</b></div>
        </div>

        <button className={`btn primary big ${form.mode === "live" ? "live" : ""}`} disabled={busy}>
          {busy ? "Working…" : form.mode === "live" ? "ADD LIVE BOT" : "ADD BOT"}
        </button>
      </form>
    </section>
  );
}

function Num({ label, hint, value, onChange }: { label: string; hint?: string; value: string; onChange: React.ChangeEventHandler<HTMLInputElement> }) {
  return (
    <label className="field"><span>{label}{hint && <em>{hint}</em>}</span>
      <input type="text" inputMode="decimal" pattern="\d+(\.\d+)?" value={value} onChange={onChange} required spellCheck={false} />
    </label>
  );
}
