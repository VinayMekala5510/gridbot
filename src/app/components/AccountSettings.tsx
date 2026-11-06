"use client";
import { useState } from "react";
import { EXCHANGES, exchangeInfo } from "@/shared/exchanges";
import type { AccountView, ExchangeId } from "@/shared/types";
import { api } from "../lib/client";
import { Card, Field } from "./ui";

// Networks offered for accounts, in this order.
const ACCOUNT_NETWORKS = (["binance", "hyperliquid", "hyperliquid-testnet"] as ExchangeId[])
  .map(id => EXCHANGES.find(x => x.id === id)!)
  .filter(x => x.accounts);

const HELP: Record<string, { key: string; secret: string; keyPlaceholder: string; note?: string }> = {
  binance: {
    key: "Binance API key (Profile → API Management). Enable Spot trading, never withdrawals. If you restrict the key by IP, allow this server: 15.252.130.220.",
    secret: "Binance API secret (HMAC). It is checked with Binance when you save.",
    keyPlaceholder: "64-character API key",
    note: "Binance live bots trade Spot: hold the coin for the sell levels and the quote (e.g. USDT) for the buy levels.",
  },
  hyperliquid: {
    key: "Your Hyperliquid account address (0x…). This is the account that holds the funds.",
    secret: "The key that signs orders: an API wallet key from Hyperliquid → More → API (recommended), or the wallet's own private key. It is checked against the wallet address when you save.",
    keyPlaceholder: "0x…",
  },
};

interface Props {
  accounts: AccountView[];
  activeAccountId: number | null;
  onActiveAccount: (id: number | null) => void;
  notify: (kind: "ok" | "error", text: string) => void;
}

const empty = { name: "", exchange: "hyperliquid" as ExchangeId, publicKey: "", secret: "" };

export function AccountSettings({ accounts, activeAccountId, onActiveAccount, notify }: Props) {
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);
  const address = form.publicKey.trim();
  const info = exchangeInfo(form.exchange);
  const help = HELP[form.exchange === "binance" ? "binance" : "hyperliquid"];
  const defaultName = (form.exchange === "binance" ? address.length >= 10 : /^0x[0-9a-fA-F]{40}$/u.test(address))
    ? `${info.label} ${address.slice(0, 6)}…${address.slice(-4)}` : "";
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [key]: e.target.value }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const account = await api<AccountView>("/api/accounts", "POST", {
        exchange: form.exchange, publicKey: address, secret: form.secret, name: form.name.trim() || defaultName,
      });
      setForm(f => ({ ...empty, exchange: f.exchange }));
      onActiveAccount(account.id);
      notify("ok", `Account "${account.name}" saved and set as active.`);
    } catch (err) {
      notify("error", (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(account: AccountView) {
    if (!window.confirm(`Remove account "${account.name}"? Its encrypted keys are wiped from the server.`)) return;
    try {
      await api(`/api/accounts/${account.id}`, "DELETE");
      if (activeAccountId === account.id) onActiveAccount(null);
      notify("ok", `Account "${account.name}" removed.`);
    } catch (err) {
      notify("error", (err as Error).message);
    }
  }

  return (
    <div className="page">
      <h1 className="page-title">Account Settings</h1>
      <div className="form-grid">
        <form onSubmit={save} autoComplete="off" className="contents">
          <Card title="Add Account" icon="⚿">
            <Field label="Network" info="Hyperliquid Testnet uses test funds; Hyperliquid and Binance are real money.">
              <select value={form.exchange} onChange={e => setForm(f => ({ ...f, exchange: e.target.value as ExchangeId, publicKey: "", secret: "" }))}>
                {ACCOUNT_NETWORKS.map(x => <option key={x.id} value={x.id}>{x.label.toUpperCase()}</option>)}
              </select>
            </Field>
            <Field label={info.keyLabel} info={help.key}>
              <input value={form.publicKey} onChange={set("publicKey")} placeholder={help.keyPlaceholder} spellCheck={false} required />
            </Field>
            <Field label={info.secretLabel} info={help.secret}>
              <input type="password" value={form.secret} onChange={set("secret")} spellCheck={false} autoComplete="new-password" required />
            </Field>
            {help.note && <p className="hint warn">{help.note}</p>}
            <Field label="Account name (optional)" info="A label for this account. Left empty, it is named after the network and address.">
              <input value={form.name} onChange={set("name")} placeholder={defaultName || "e.g. Main account"} maxLength={100} />
            </Field>
            <button className="btn primary" disabled={saving}>{saving ? "Checking & saving…" : "Save account"}</button>
            <p className="hint">Keys are encrypted (AES-256-GCM) on the server and never sent back to the browser.</p>
          </Card>
        </form>

        <Card title="Saved Accounts" icon="☰">
          <Field label="Active account" info="New live bots use this account by default.">
            <select value={activeAccountId ?? ""} onChange={e => onActiveAccount(e.target.value ? Number(e.target.value) : null)}>
              <option value="">None (paper trading only)</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name} · {exchangeInfo(a.exchange).label}</option>)}
            </select>
          </Field>
          {accounts.length === 0 ? <p className="empty">No accounts saved yet.</p> : (
            <ul className="account-list">
              {accounts.map(a => (
                <li key={a.id} className={a.id === activeAccountId ? "active" : ""}>
                  <div>
                    <strong>{a.name}{a.id === activeAccountId && <span className="badge paper">ACTIVE</span>}</strong>
                    <small>{exchangeInfo(a.exchange).label} · {a.publicKeyMasked}</small>
                  </div>
                  <button type="button" className="btn danger small" onClick={() => remove(a)}>✕ Remove</button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
