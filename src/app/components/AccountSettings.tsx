"use client";
import { useState } from "react";
import { EXCHANGES, exchangeInfo } from "@/shared/exchanges";
import type { AccountView, ExchangeId } from "@/shared/types";
import { api } from "../lib/client";
import { Card, Field } from "./ui";

interface Props {
  accounts: AccountView[];
  activeAccountId: number | null;
  onActiveAccount: (id: number | null) => void;
  notify: (kind: "ok" | "error", text: string) => void;
}

const empty = { name: "", exchange: "hyperliquid" as ExchangeId, publicKey: "", secret: "", passphrase: "" };

export function AccountSettings({ accounts, activeAccountId, onActiveAccount, notify }: Props) {
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);
  const info = exchangeInfo(form.exchange);
  const hyperliquid = form.exchange.startsWith("hyperliquid");
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [key]: e.target.value }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const account = await api<AccountView>("/api/accounts", "POST", form);
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
          <Card title="Exchange & Key" icon="⚿">
            <Field label="Account name" info='A label to recognise this account, e.g. "Main Hyperliquid".'>
              <input value={form.name} onChange={set("name")} placeholder="Main Hyperliquid account" maxLength={100} required />
            </Field>
            <Field label="Exchange / network" info="Live trading is available for Hyperliquid. Other exchanges run in Paper mode for now.">
              <select value={form.exchange} onChange={set("exchange")}>
                {EXCHANGES.map(x => <option key={x.id} value={x.id}>{x.label.toUpperCase()}{x.live ? "" : " (paper only)"}</option>)}
              </select>
            </Field>
          </Card>

          <Card title="Credentials" icon="⚷">
            <Field label={info.keyLabel} info={hyperliquid ? "Your main Hyperliquid wallet address (0x…). Public, read-only." : "The public API key for this exchange."}>
              <input value={form.publicKey} onChange={set("publicKey")} placeholder={hyperliquid ? "0x…" : ""} spellCheck={false} required />
            </Field>
            <Field label={info.secretLabel} info={hyperliquid ? "Private key of an API wallet (Hyperliquid → More → API). Never your main wallet key." : "Secret used to sign orders."}>
              <input type="password" value={form.secret} onChange={set("secret")} spellCheck={false} autoComplete="new-password" required />
            </Field>
            <Field label="Passphrase (optional)" info="Only for exchanges that require an extra API passphrase.">
              <input type="password" value={form.passphrase} onChange={set("passphrase")} autoComplete="new-password" />
            </Field>
            <button className="btn primary" disabled={saving}>{saving ? "Saving…" : "Save account"}</button>
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
