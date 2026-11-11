"use client";
import { useEffect, useState } from "react";
import { exchangeInfo } from "@/shared/exchanges";
import type { BotStatus, BotView, OrderView, RoundtripView } from "@/shared/types";
import { api, clock, fmt, fmtPnl, pnlClass, timeAgo } from "../lib/client";

const STATUS_LABEL: Record<BotStatus, string> = {
  idle: "Idle",
  running: "Running",
  halted_volume_cap: "Halted: Volume Cap Reached",
  halted_limit_breach: "Halted: Price Limit Breached",
  killed: "KILLED",
  error: "Halted: Error",
};

type Tab = "orders" | "targets" | "fills" | "roundtrips" | "activity";

export function BotCard({ bot, now, notify, onRemoved }: { bot: BotView; now: number; notify: (kind: "ok" | "error", text: string) => void; onRemoved?: () => void }) {
  const [tab, setTab] = useState<Tab>("orders");
  const [busy, setBusy] = useState(false);
  const c = bot.config;
  const active = bot.status === "running" || bot.status === "idle";
  const used = Number(bot.openExposure) / Number(c.mmQty);
  const stepsTotal = Math.floor(Number(c.mmQty) / Number(c.stepQty) + 1e-9);
  const stepsUsed = Math.round(Number(bot.openExposure) / Number(c.stepQty) * 100) / 100;
  const pct = Math.min(100, Math.max(0, used * 100));

  async function stop() {
    if (!window.confirm(`KILL SWITCH — "${c.name}"\n\nStop this bot now and cancel all of its open orders${c.mode === "live" ? " on the exchange" : ""}? Other bots keep running. Positions already filled stay open.`)) return;
    setBusy(true);
    try { await api(`/api/bots/${bot.id}/stop`, "POST"); notify("ok", `Kill switch: "${c.name}" stopped and its orders canceled.`); }
    catch (err) { notify("error", (err as Error).message); }
    finally { setBusy(false); }
  }
  async function archive() {
    setBusy(true);
    try { await api(`/api/bots/${bot.id}/archive`, "POST"); notify("ok", `"${c.name}" removed from the dashboard.`); onRemoved?.(); }
    catch (err) { notify("error", (err as Error).message); setBusy(false); }
  }

  return (
    <article className={`bot-card detail status-${bot.status}`}>
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
          ? <button className="kill-btn" onClick={stop} disabled={busy} title="Stop this bot and cancel all of its orders">
              <span className="kill-btn-icon">⏻</span>{busy ? "STOPPING…" : "KILL SWITCH"}
            </button>
          : <button className="btn ghost small" onClick={archive} disabled={busy}>Remove from dashboard</button>}
      </header>

      <div className="status-row">
        <span className={`status-pill ${bot.status}`}><i />{STATUS_LABEL[bot.status]}</span>
        <span className="muted small">
          {bot.lastPrice ? <>Market <b className="mono">{fmt(bot.lastPrice)}</b>{bot.lastPriceAt && ` · ${timeAgo(bot.lastPriceAt, now)}`}</> : "Waiting for price…"}
        </span>
      </div>
      {bot.statusReason && !active && <p className="reason">{bot.statusReason}</p>}

      <section className="settings">
        <h4 className="settings-title">Bot parameters</h4>
        <dl className="params all">
          <div><dt>Bot name</dt><dd>{c.name}</dd></div>
          <div><dt>Exchange</dt><dd>{exchangeInfo(c.exchange).label}</dd></div>
          <div><dt>Symbol</dt><dd>{c.symbol}</dd></div>
          <div><dt>Mode</dt><dd>{c.mode === "live" ? "Live" : "Paper"}</dd></div>
          <div><dt>Account</dt><dd>{bot.accountName ?? "—"}</dd></div>
          <div><dt>Bot entry price</dt><dd>{fmt(c.entryPrice)}</dd></div>
          <div><dt>Spread</dt><dd>{fmt(c.spread)}</dd></div>
          <div><dt>Target spread</dt><dd>{fmt(c.targetSpread)}</dd></div>
          <div><dt>Steps</dt><dd>{c.steps} <small>({bot.activeLevels} levels inside limits)</small></dd></div>
          <div><dt>Per step qty</dt><dd>{fmt(c.stepQty)}</dd></div>
          <div><dt>Market making qty</dt><dd>{fmt(c.mmQty)}</dd></div>
          <div><dt>Upper limit</dt><dd>{fmt(c.upperLimit)}</dd></div>
          <div><dt>Lower limit</dt><dd>{fmt(c.lowerLimit)}</dd></div>
          <div><dt>Open at once</dt><dd>3 buy + 3 sell</dd></div>
          <div><dt>Created</dt><dd>{new Date(bot.createdAt).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</dd></div>
          <div><dt>Stopped</dt><dd>{bot.stoppedAt ? new Date(bot.stoppedAt).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}</dd></div>
        </dl>
      </section>

      <div className="volume">
        <div className="volume-head">
          <span title="Filled entries whose target has not filled yet. A completed roundtrip frees its step. When all steps are in use the bot stops.">Steps in use (open exposure) / ceiling</span>
          <b className="mono">{fmt(stepsUsed)} / {stepsTotal} steps · {fmt(bot.openExposure)} / {fmt(c.mmQty)} <small>({pct.toFixed(0)}%)</small></b>
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
        {(() => {
          // Total of every completed roundtrip (entry + target pair), before fees.
          const n = bot.roundtrips;
          const total = bot.realizedPnl;
          const last = bot.recentRoundtrips[0];
          return <Metric label={`RTP PnL (${n})`} value={n ? fmtPnl(total) : "—"} cls={n ? pnlClass(total) : ""}
            sub={n ? `avg ${fmtPnl(Number(total) / n)}${last ? ` · last ${fmtPnl(last.pnl)}` : ""}` : "no roundtrips yet"}
            title="Total PnL of all completed roundtrips (entry + target pairs), before fees." />;
        })()}
      </div>

      <nav className="tabs" role="tablist">
        {([
          ["orders", `Open orders (${bot.openEntries.length})`],
          ["targets", `Targets (${bot.openTargets.length})`],
          ["fills", "Filled"],
          ["roundtrips", `Roundtrips (${bot.roundtrips})`],
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
            {(() => {
              // One row per entry order (partial fills merged), shown next to its own target.
              const entries = new Map<number, { time: number; level: number; side: "buy" | "sell"; qty: number; notional: number }>();
              for (const f of bot.recentFills) {
                if (f.role !== "entry") continue;
                const e = entries.get(f.orderId) ?? { time: 0, level: f.level, side: f.side, qty: 0, notional: 0 };
                e.time = Math.max(e.time, f.time);
                e.qty += Number(f.qty);
                e.notional += Number(f.qty) * Number(f.price);
                entries.set(f.orderId, e);
              }
              const rows = [...entries.entries()].sort((a, b) => b[1].time - a[1].time);
              if (!rows.length) return <p className="empty">No filled entries yet.</p>;
              return (
                <table>
                  <thead><tr><th>Time</th><th>Lvl</th><th>Entry</th><th>Target</th><th>Target status</th><th>Qty</th>
                    <th title="Roundtrip PnL: appears only after the target has filled (entry + target pair, before fees)">RTP PnL</th></tr></thead>
                  <tbody>{rows.map(([orderId, e]) => {
                    const rt = bot.recentRoundtrips.find(r => r.entryOrderId === orderId);
                    const open = rt ? undefined : bot.openTargets.find(t => t.parentOrderId === orderId);
                    const entryPrice = rt ? Number(rt.entryPrice) : e.notional / e.qty;
                    const targetSide = e.side === "buy" ? "sell" : "buy";
                    const targetPrice = rt ? rt.exitPrice : open?.price;
                    return (
                      <tr key={orderId}>
                        <td className="mono">{clock(e.time)}</td>
                        <td>{e.level > 0 ? `+${e.level}` : e.level}</td>
                        <td className="mono"><span className={e.side}>{e.side.toUpperCase()}</span> {fmt(entryPrice)}</td>
                        <td className="mono">{targetPrice ? <><span className={targetSide}>{targetSide.toUpperCase()}</span> {fmt(targetPrice)}</> : "—"}</td>
                        <td>{rt ? <small className="target-state closed">filled target</small>
                          : open ? <small className="target-state open">target waiting for fill</small> : "—"}</td>
                        <td className="mono">{fmt(e.qty)}</td>
                        <td className="mono">{rt ? <b className={pnlClass(rt.pnl)}>{fmtPnl(rt.pnl)}</b> : "—"}</td>
                      </tr>
                    );
                  })}</tbody>
                </table>
              );
            })()}
          </>
        )}
        {tab === "roundtrips" && <RoundtripTable botId={bot.id} count={bot.roundtrips} inverse={bot.config.exchange.startsWith("deribit") && !bot.config.symbol.includes("_")} />}
        {tab === "activity" && (bot.events.length === 0 ? <p className="empty">No activity yet.</p> : (
          <ol className="events">{bot.events.map((e, i) => (
            <li key={`${e.time}-${i}`} className={e.level}><time className="mono">{clock(e.time)}</time>{e.message}</li>
          ))}</ol>
        ))}
      </div>
    </article>
  );
}

function Metric({ label, value, cls = "", big = false, sub, title }: { label: string; value: string; cls?: string; big?: boolean; sub?: string; title?: string }) {
  return <div className={`metric ${big ? "big" : ""}`} title={title}><span>{label}</span><b className={`mono ${cls}`}>{value}</b>{sub && <small className="metric-sub">{sub}</small>}</div>;
}

function OrderTable({ orders, empty, targets = false }: { orders: OrderView[]; empty: string; targets?: boolean }) {
  if (!orders.length) return <p className="empty">{empty}</p>;
  if (targets) {
    // Target orders: the entry that filled, and the target price waiting to close it.
    return (
      <table>
        <thead><tr><th>Lvl</th><th>Side</th><th>Entry fill</th><th>Target price</th><th>Qty</th><th>Status</th></tr></thead>
        <tbody>{orders.map(o => (
          <tr key={o.id}>
            <td>{o.level > 0 ? `+${o.level}` : o.level}</td>
            <td className={o.side}>{o.side.toUpperCase()}</td>
            <td className="mono">{fmt(o.refPrice)}</td>
            <td className="mono target-price">{fmt(o.price)}</td>
            <td className="mono">{fmt(o.qty)}{Number(o.filledQty) > 0 && <small> ({fmt(o.filledQty)} filled)</small>}</td>
            <td>{o.status}</td>
          </tr>
        ))}</tbody>
      </table>
    );
  }
  return (
    <table>
      <thead><tr><th>Lvl</th><th>Side</th><th>Price</th><th>Qty</th><th>Status</th></tr></thead>
      <tbody>{orders.map(o => (
        <tr key={o.id}>
          <td>{o.level > 0 ? `+${o.level}` : o.level}</td>
          <td className={o.side}>{o.side.toUpperCase()}</td>
          <td className="mono">{fmt(o.price)}</td>
          <td className="mono">{fmt(o.qty)}{Number(o.filledQty) > 0 && <small> ({fmt(o.filledQty)} filled)</small>}</td>
          <td>{o.status}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}


/** Every completed roundtrip of the bot with its entry fill, target fill and PnL (loaded on demand). */
function RoundtripTable({ botId, count, inverse }: { botId: number; count: number; inverse: boolean }) {
  const [rows, setRows] = useState<RoundtripView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<{ roundtrips: RoundtripView[] }>(`/api/bots/${botId}/roundtrips`)
      .then(r => { if (!cancelled) { setRows(r.roundtrips); setError(null); } })
      .catch(err => { if (!cancelled) setError((err as Error).message); });
    return () => { cancelled = true; };
  }, [botId, count]);
  if (error) return <p className="empty">Could not load roundtrips: {error}</p>;
  if (!rows) return <p className="empty">Loading roundtrips…</p>;
  if (!rows.length) return <p className="empty">No completed roundtrips yet.</p>;
  const total = rows.reduce((s, r) => s + Number(r.pnl), 0);
  return (
    <>
      <div className="fill-summary">
        <span>{rows.length} roundtrip{rows.length === 1 ? "" : "s"}</span>
        <span>Total RTP PnL <b className={pnlClass(total)}>{fmtPnl(total)}</b></span>
        {inverse && <span className="muted">PnL = price move × qty ÷ entry price (USD-sized contract)</span>}
      </div>
      <table>
        <thead><tr><th>#</th><th>Completed</th><th>Lvl</th><th>Entry filled</th><th>Target filled</th><th>Move</th><th>Qty</th><th>RTP PnL</th></tr></thead>
        <tbody>{rows.map((r, i) => {
          const targetSide = r.entrySide === "buy" ? "sell" : "buy";
          const move = Math.abs(Number(r.exitPrice) - Number(r.entryPrice));
          return (
            <tr key={r.targetOrderId}>
              <td>{rows.length - i}</td>
              <td className="mono">{new Date(r.time).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</td>
              <td>{r.level > 0 ? `+${r.level}` : r.level}</td>
              <td className="mono"><span className={r.entrySide}>{r.entrySide.toUpperCase()}</span> {fmt(r.entryPrice)}</td>
              <td className="mono"><span className={targetSide}>{targetSide.toUpperCase()}</span> {fmt(r.exitPrice)}</td>
              <td className="mono">{fmt(move)}</td>
              <td className="mono">{fmt(r.qty)}</td>
              <td className="mono"><b className={pnlClass(r.pnl)}>{fmtPnl(r.pnl)}</b></td>
            </tr>
          );
        })}</tbody>
      </table>
    </>
  );
}
