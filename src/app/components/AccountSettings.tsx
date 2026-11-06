"use client";
import { useState } from "react";
import { EXCHANGES, exchangeInfo } from "@/shared/exchanges";
import type { AccountView, ExchangeId } from "@/shared/types";
import { api } from "../lib/client";
import { Card, Field } from "./ui";

const LIVE_EXCHANGES = EXCHANGES.filter(x => x.live);

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
  const defaultName = /^0x[0-9a-fA-F]{40}$/u.test(address)
    ? `${exchangeInfo(form.exchange).label} ${address.slice(0, 6)}…${address.slice(-4)}` : "";
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
    <div className="page">
      <h1 className="page-title">Account Settings</h1>
      <div className="form-grid">
        <form onSubmit={save} autoComplete="off" className="contents">
          <Card title="Add Account" icon="⚿">
            <Field label="Network" info="Hyperliquid Testnet uses test funds; Hyperliquid is real money.">
              <select value={form.exchange} onChange={set("exchange")}>
                {LIVE_EXCHANGES.map(x => <option key={x.id} value={x.id}>{x.label.toUpperCase()}</option>)}
              </select>
            </Field>
            <Field label="Wallet address" info="Your Hyperliquid account address (0x…). This is the account that holds the funds.">
              <input value={form.publicKey} onChange={set("publicKey")} placeholder="0x…" spellCheck={false} required />
            </Field>
            <Field label="Private key" info="The key that signs orders: an API wallet key from Hyperliquid → More → API (recommended), or the wallet's own private key. It is checked against the wallet address when you save.">
              <input type="password" value={form.secret} onChange={set("secret")} placeholder="0x…" spellCheck={false} autoComplete="new-password" required />
            </Field>
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
                  <button type="button" className="icon-btn" aria-label={`Delete ${a.name}`} onClick={() => remove(a)}>✕</button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
