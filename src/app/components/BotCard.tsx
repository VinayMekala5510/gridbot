"use client";
import { useState } from "react";
import { exchangeInfo } from "@/shared/exchanges";
import type { BotStatus, BotView, OrderView } from "@/shared/types";
import { api, clock, fmt, fmtPnl, pnlClass, timeAgo } from "../lib/client";

const STATUS_LABEL: Record<BotStatus, string> = {
  idle: "Idle",
  running: "Running",
  halted_volume_cap: "Halted: Volume Cap Reached",
  halted_limit_breach: "Halted: Price Limit Breached",
  killed: "KILLED",
  error: "Halted: Error",
};

type Tab = "orders" | "targets" | "fills" | "activity";

export function BotCard({ bot, now, notify }: { bot: BotView; now: number; notify: (kind: "ok" | "error", text: string) => void }) {
  const [tab, setTab] = useState<Tab>("orders");
  const [busy, setBusy] = useState(false);
  const c = bot.config;
  const active = bot.status === "running" || bot.status === "idle";
  const used = Number(bot.entryFilledQty) / Number(c.mmQty);
  const pct = Math.min(100, Math.max(0, used * 100));

  async function stop() {
    if (!window.confirm(`Stop "${c.name}" and cancel all of its orders?`)) return;
    setBusy(true);
    try { await api(`/api/bots/${bot.id}/stop`, "POST"); notify("ok", `"${c.name}" stopped.`); }
    catch (err) { notify("error", (err as Error).message); }
    finally { setBusy(false); }
  }
  async function archive() {
    setBusy(true);
    try { await api(`/api/bots/${bot.id}/archive`, "POST"); }
    catch (err) { notify("error", (err as Error).message); setBusy(false); }
  }

  return (
    <article className={`bot-card status-${bot.status}`}>
      <header className="bot-head">
        <div className="bot-title">
          <h3>{c.name}</h3>
          <div className="bot-sub">
            <span>{exchangeInfo(c.exchange).label}: <b>{c.symbol}</b></span>
            <span className={`badge ${c.mode}`}>{c.mode === "live" ? "LIVE" : "PAPER"}</span>
            {bot.accountName && <span className="muted">· {bot.accountName}</span>}
          </div>
        </div>
        {active
          ? <button className="btn danger small" onClick={stop} disabled={busy}>■ Stop bot</button>
          : <button className="btn ghost small" onClick={archive} disabled={busy}>Remove</button>}
      </header>

      <div className="status-row">
        <span className={`status-pill ${bot.status}`}><i />{STATUS_LABEL[bot.status]}</span>
        <span className="muted small">
          {bot.lastPrice ? <>Market <b className="mono">{fmt(bot.lastPrice)}</b>{bot.lastPriceAt && ` · ${timeAgo(bot.lastPriceAt, now)}`}</> : "Waiting for price…"}
        </span>
      </div>
      {bot.statusReason && !active && <p className="reason">{bot.statusReason}</p>}

      <dl className="params">
        <div><dt>Entry</dt><dd>{fmt(c.entryPrice)}</dd></div>
        <div><dt>Lower – Upper</dt><dd>{fmt(c.lowerLimit)} – {fmt(c.upperLimit)}</dd></div>
        <div><dt>Spread / Target</dt><dd>{fmt(c.spread)} / {fmt(c.targetSpread)}</dd></div>
        <div><dt>Levels</dt><dd>{bot.activeLevels} <small>(±{c.steps})</small></dd></div>
      </dl>

      <div className="volume">
        <div className="volume-head">
          <span>Accumulated vol / safety threshold</span>
          <b className="mono">{fmt(bot.entryFilledQty)} / {fmt(c.mmQty)} <small>({pct.toFixed(0)}%)</small></b>
        </div>
        <div className="bar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
          <div className={`bar-fill ${pct >= 90 ? "hot" : pct >= 60 ? "warm" : ""}`} style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="metrics">
        <Metric label="Net PnL" value={fmtPnl(bot.netPnl)} cls={pnlClass(bot.netPnl)} big />
        <Metric label="Roundtrips" value={String(bot.roundtrips)} big />
        <Metric label="Realized" value={fmtPnl(bot.realizedPnl)} cls={pnlClass(bot.realizedPnl)} />
        <Metric label="Unrealized" value={fmtPnl(bot.unrealizedPnl)} cls={pnlClass(bot.unrealizedPnl)} />
        <Metric label="Fees" value={fmt(bot.fees, 6)} />
        <Metric label="Filled" value={`${bot.fillSummary.buyCount}B / ${bot.fillSummary.sellCount}S`} />
      </div>

      <nav className="tabs" role="tablist">
        {([
          ["orders", `Open orders (${bot.openEntries.length})`],
          ["targets", `Targets (${bot.openTargets.length})`],
          ["fills", "Filled"],
          ["activity", "Activity"],
        ] as [Tab, string][]).map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? "on" : ""} onClick={() => setTab(key)}>{label}</button>
        ))}
      </nav>
      <div className="tab-body">
        {tab === "orders" && <OrderTable orders={bot.openEntries} empty="No open entry orders." />}
        {tab === "targets" && <OrderTable orders={bot.openTargets} empty="No target orders waiting." targets />}
        {tab === "fills" && (
          <>
            <div className="fill-summary">
              <span className="buy">Buys {bot.fillSummary.buyCount} · {fmt(bot.fillSummary.buyQty)} @ avg {fmt(bot.fillSummary.avgBuy)}</span>
              <span className="sell">Sells {bot.fillSummary.sellCount} · {fmt(bot.fillSummary.sellQty)} @ avg {fmt(bot.fillSummary.avgSell)}</span>
            </div>
            {bot.recentFills.length === 0 ? <p className="empty">No fills yet.</p> : (
              <table>
                <thead><tr><th>Time</th><th>Lvl</th><th>Type</th><th>Side</th><th>Price</th><th>Qty</th></tr></thead>
                <tbody>{bot.recentFills.map(f => (
                  <tr key={f.id}><td className="mono">{clock(f.time)}</td><td>{f.level > 0 ? `+${f.level}` : f.level}</td>
                    <td>{f.role}</td><td className={f.side}>{f.side.toUpperCase()}</td><td className="mono">{fmt(f.price)}</td><td className="mono">{fmt(f.qty)}</td></tr>
                ))}</tbody>
              </table>
            )}
          </>
        )}
        {tab === "activity" && (bot.events.length === 0 ? <p className="empty">No activity yet.</p> : (
          <ol className="events">{bot.events.map((e, i) => (
            <li key={`${e.time}-${i}`} className={e.level}><time className="mono">{clock(e.time)}</time>{e.message}</li>
          ))}</ol>
        ))}
      </div>
    </article>
  );
}

function Metric({ label, value, cls = "", big = false }: { label: string; value: string; cls?: string; big?: boolean }) {
  return <div className={`metric ${big ? "big" : ""}`}><span>{label}</span><b className={`mono ${cls}`}>{value}</b></div>;
}

function OrderTable({ orders, empty, targets = false }: { orders: OrderView[]; empty: string; targets?: boolean }) {
  if (!orders.length) return <p className="empty">{empty}</p>;
  return (
    <table>
      <thead><tr><th>Lvl</th><th>Side</th><th>Price</th><th>Qty</th>{targets ? <th>Entry fill</th> : <th>Status</th>}</tr></thead>
      <tbody>{orders.map(o => (
        <tr key={o.id}>
          <td>{o.level > 0 ? `+${o.level}` : o.level}</td>
          <td className={o.side}>{o.side.toUpperCase()}</td>
          <td className="mono">{fmt(o.price)}</td>
          <td className="mono">{fmt(o.qty)}{Number(o.filledQty) > 0 && <small> ({fmt(o.filledQty)} filled)</small>}</td>
          {targets ? <td className="mono">{fmt(o.refPrice)}</td> : <td>{o.status}</td>}
        </tr>
      ))}</tbody>
    </table>
  );
}
