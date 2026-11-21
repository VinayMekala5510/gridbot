"use client";
import { useEffect, useState } from "react";
import { EXCHANGES, exchangeInfo } from "@/shared/exchanges";
import type { ExchangeId, PriceAlertView } from "@/shared/types";
import { api, fmt, timeAgo } from "../lib/client";
import { Card, Field } from "./ui";

interface Props {
  alerts: PriceAlertView[];
  now: number;
  notify: (kind: "ok" | "error", text: string) => void;
}

const STATUS: Record<PriceAlertView["status"], { text: string; cls: string }> = {
  watching: { text: "Watching", cls: "watching" },
  triggered_upper: { text: "Upper limit hit", cls: "hit-up" },
  triggered_lower: { text: "Lower limit hit", cls: "hit-down" },
};

const pct = (target: number, from: number) => ((target - from) / from) * 100;
const when = (ms: number) => new Date(ms).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Symbols for an exchange, with the last good list kept in this browser. */
function useSymbols(exchange: ExchangeId) {
  const [list, setList] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const key = `gridbot.symbols.${exchange}`;
    try { setList(JSON.parse(localStorage.getItem(key) ?? "null")); } catch { setList(null); }
    api<{ symbols: string[] }>(`/api/symbols?exchange=${exchange}`)
      .then(r => {
        if (cancelled) return;
        setList(r.symbols);
        try { localStorage.setItem(key, JSON.stringify(r.symbols)); } catch { /* ignore */ }
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [exchange]);
  return list;
}

export function PriceAlerts({ alerts, now, notify }: Props) {
  const [exchange, setExchange] = useState<ExchangeId>("hyperliquid");
  const [symbol, setSymbol] = useState("");
  const [upper, setUpper] = useState("");
  const [lower, setLower] = useState("");
  const [price, setPrice] = useState<{ value: number; at: number } | null>(null);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const symbols = useSymbols(exchange);

  // Keep the chosen symbol valid for the exchange's list.
  useEffect(() => {
    if (symbols?.length && !symbols.includes(symbol)) setSymbol(symbols[0]);
  }, [symbols]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live price for the chosen market, refreshed every 2 seconds.
  useEffect(() => {
    if (!symbol) return;
    let cancelled = false;
    setPrice(null);
    setPriceError(null);
    const load = () => api<{ price: string }>(`/api/price?exchange=${exchange}&symbol=${encodeURIComponent(symbol)}`)
      .then(r => { if (!cancelled) { setPrice({ value: Number(r.price), at: Date.now() }); setPriceError(null); } })
      .catch(err => { if (!cancelled) setPriceError((err as Error).message); });
    void load();
    const timer = setInterval(load, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [exchange, symbol]);

  const up = upper.trim() === "" ? null : Number(upper);
  const lo = lower.trim() === "" ? null : Number(lower);
  const problem = up === null && lo === null ? "Enter an upper limit, a lower limit, or both."
    : up !== null && lo !== null && !(lo < up) ? "Lower limit must be below the upper limit."
    : price && up !== null && price.value >= up ? "The price is already at or above this upper limit."
    : price && lo !== null && price.value <= lo ? "The price is already at or below this lower limit."
    : null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (problem) return notify("error", problem);
    setSaving(true);
    try {
      await api("/api/alerts", "POST", { exchange, symbol, upper: upper.trim() || null, lower: lower.trim() || null });
      notify("ok", `Alert saved for ${symbol}. The server watches it even when this page is closed.`);
      setUpper("");
      setLower("");
    } catch (err) {
      notify("error", (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function act(alert: PriceAlertView, action: "rearm" | "delete") {
    try {
      await api(action === "delete" ? `/api/alerts/${alert.id}` : `/api/alerts/${alert.id}/rearm`, action === "delete" ? "DELETE" : "POST");
      notify("ok", action === "delete" ? `Alert for ${alert.symbol} deleted.` : `Alert for ${alert.symbol} is watching again.`);
    } catch (err) {
      notify("error", (err as Error).message);
    }
  }

  const fresh = price && now - price.at < 8000;

  return (
    <div className="page">
      <h1 className="page-title">Price Alerts</h1>
      <div className="form-grid">
        <form className="contents" onSubmit={save} autoComplete="off">
          <Card title="Market" icon="〰">
            <Field label="Exchange" info="Where the price comes from.">
              <select value={exchange} onChange={e => { setExchange(e.target.value as ExchangeId); setSymbol(""); }}>
                {EXCHANGES.map(x => <option key={x.id} value={x.id}>{x.label.toUpperCase()}</option>)}
              </select>
            </Field>
            <Field label="Symbol" info="Any tradable symbol on this exchange.">
              {symbols ? (
                <select value={symbol} onChange={e => setSymbol(e.target.value)}>
                  {symbols.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              ) : <select disabled><option>Loading symbols…</option></select>}
            </Field>
            <div className="live-price" aria-live="polite">
              <span className="field-label">Current price</span>
              <b className="mono">{price ? fmt(price.value) : priceError ? "—" : "…"}</b>
              <small className={fresh ? "live-on" : ""}>
                <i aria-hidden="true" />{priceError ? priceError : price ? `Live · updated ${timeAgo(price.at, now)}` : "Loading…"}
              </small>
            </div>
          </Card>

          <Card title="Limits" icon="⇅">
            <Field label="Upper limit" info="Alert when the price rises to this level or above.">
              <input type="text" inputMode="decimal" pattern="\d+(\.\d+)?" value={upper} onChange={e => setUpper(e.target.value)} placeholder="e.g. 72000" spellCheck={false} />
            </Field>
            <p className="hint">{price && up !== null && up > 0 ? `${pct(up, price.value) >= 0 ? "+" : ""}${pct(up, price.value).toFixed(2)}% from the current price` : "Leave empty for no upper alert."}</p>
            <Field label="Lower limit" info="Alert when the price falls to this level or below.">
              <input type="text" inputMode="decimal" pattern="\d+(\.\d+)?" value={lower} onChange={e => setLower(e.target.value)} placeholder="e.g. 60000" spellCheck={false} />
            </Field>
            <p className="hint">{price && lo !== null && lo > 0 ? `${pct(lo, price.value).toFixed(2)}% from the current price` : "Leave empty for no lower alert."}</p>
            {problem && (up !== null || lo !== null) && <p className="hint warn">{problem}</p>}
            <button className="btn primary" disabled={saving || !symbol}>{saving ? "Saving…" : "Save alert"}</button>
          </Card>
        </form>

        <TelegramCard notify={notify} />

        <Card title={`Your alerts (${alerts.length})`} icon="⚑" className="wide">
          {alerts.length === 0 ? <p className="empty">No alerts yet. Pick a market, enter a limit and press Save alert.</p> : (
            <div className="alerts-table">
              <table>
                <thead><tr><th>Market</th><th>Current price</th><th>Upper</th><th>Lower</th><th>Status</th><th>Since</th><th aria-label="Actions" /></tr></thead>
                <tbody>{alerts.map(a => {
                  const s = STATUS[a.status];
                  return (
                    <tr key={a.id} className={a.status !== "watching" ? "alert-hit" : ""}>
                      <td><b>{a.symbol}</b><small className="muted"> · {exchangeInfo(a.exchange).label}</small></td>
                      <td className="mono">{fmt(a.lastPrice)}</td>
                      <td className="mono">{a.upper ? fmt(a.upper) : "—"}</td>
                      <td className="mono">{a.lower ? fmt(a.lower) : "—"}</td>
                      <td><span className={`alert-status ${s.cls}`}>{s.text}</span>{a.triggeredPrice && <small className="muted"> at {fmt(a.triggeredPrice)}</small>}{a.notice && <small className={`alert-notice${/failed/u.test(a.notice) ? " bad" : ""}`}>{a.notice}</small>}</td>
                      <td className="mono">{when(a.triggeredAt ?? a.createdAt)}</td>
                      <td className="alert-actions">
                        {a.status !== "watching" && <button className="btn ghost small" onClick={() => act(a, "rearm")}>Re-arm</button>}
                        <button className="btn ghost small" onClick={() => act(a, "delete")}>Delete</button>
                      </td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

interface TelegramStatus { configured: boolean; hasToken: boolean; botUsername: string | null; chatId: string | null; chatName: string | null }

/** Telegram set-up: bot token (stored encrypted on the server), chat detection, test message. */
function TelegramCard({ notify }: { notify: Props["notify"] }) {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { api<TelegramStatus>("/api/telegram").then(setStatus).catch(() => undefined); }, []);

  async function run(label: string, fn: () => Promise<TelegramStatus | unknown>) {
    setBusy(true);
    try {
      const r = await fn();
      if (r && typeof r === "object" && "configured" in r) setStatus(r as TelegramStatus);
      notify("ok", label);
    } catch (err) {
      notify("error", (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const step = !status?.hasToken ? 1 : !status.chatId ? 2 : 3;
  return (
    <Card title="Telegram notifications" icon="✈" className="wide">
      <div className={`tg-state ${status?.configured ? "on" : ""}`}>
        <i aria-hidden="true" />
        {status?.configured
          ? <>Alerts are sent to <b>{status.chatName ?? status.chatId}</b> via <b>@{status.botUsername}</b>.</>
          : "Not set up yet. Fired alerts show on the dashboard only."}
      </div>
      <ol className="tg-steps">
        <li className={step === 1 ? "now" : ""}>
          In Telegram, open <b>@BotFather</b>, send <code>/newbot</code>, choose a name, and copy the <b>bot token</b> it gives you.
          <div className="inline tg-row">
            <input type="password" value={token} onChange={e => setToken(e.target.value)} placeholder={status?.hasToken ? `Saved · @${status.botUsername}` : "123456789:ABC…"} autoComplete="off" spellCheck={false} aria-label="Bot token" />
            <button type="button" className="btn secondary" disabled={busy || !token.trim()}
              onClick={() => run("Bot token saved.", async () => { const s = await api<TelegramStatus>("/api/telegram", "POST", { token }); setToken(""); return s; })}>Save token</button>
          </div>
        </li>
        <li className={step === 2 ? "now" : ""}>
          Open your bot in Telegram{status?.botUsername ? <> (<b>@{status.botUsername}</b>)</> : null} and press <b>Start</b>, then:
          <div className="inline tg-row">
            <button type="button" className="btn secondary" disabled={busy || !status?.hasToken}
              onClick={() => run("Chat found and saved.", () => api<TelegramStatus>("/api/telegram/detect", "POST"))}>Detect chat ID</button>
            <input value={chatId} onChange={e => setChatId(e.target.value)} placeholder={status?.chatId ? `Saved · ${status.chatId}` : "or type a chat ID"} spellCheck={false} aria-label="Chat ID" />
            <button type="button" className="btn ghost" disabled={busy || !chatId.trim()}
              onClick={() => run("Chat ID saved.", async () => { const s = await api<TelegramStatus>("/api/telegram", "POST", { chatId }); setChatId(""); return s; })}>Save</button>
          </div>
        </li>
        <li className={step === 3 ? "now" : ""}>
          Check it works:
          <div className="inline tg-row">
            <button type="button" className="btn primary" disabled={busy || !status?.configured}
              onClick={() => run("Test message sent — check Telegram.", () => api("/api/telegram/test", "POST"))}>Send test message</button>
            {status?.hasToken && (
              <button type="button" className="btn ghost" disabled={busy}
                onClick={() => run("Telegram disconnected.", async () => { await api("/api/telegram", "DELETE"); return { configured: false, hasToken: false, botUsername: null, chatId: null, chatName: null }; })}>Disconnect</button>
            )}
          </div>
        </li>
      </ol>
      <p className="hint">The token is encrypted on the server and never shown again. The server sends the message the moment a limit is reached, even when this page is closed.</p>
    </Card>
  );
}
