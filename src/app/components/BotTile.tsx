"use client";
import { exchangeInfo } from "@/shared/exchanges";
import type { BotStatus, BotView } from "@/shared/types";

const BADGE: Record<BotStatus, { text: string; cls: string }> = {
  idle: { text: "STARTING", cls: "starting" },
  running: { text: "RUNNING", cls: "running" },
  halted_volume_cap: { text: "VOLUME CAP", cls: "halted" },
  halted_limit_breach: { text: "LIMIT HIT", cls: "halted" },
  killed: { text: "STOPPED", cls: "stopped" },
  error: { text: "ERROR", cls: "error" },
};

/** Short, stable id shown on the card (like a commit hash). */
export function botTag(bot: BotView): string {
  let h = (bot.id * 2654435761 + bot.createdAt) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h >>> 0).toString(16).padStart(8, "0");
}

const when = (ms: number) => new Date(ms).toLocaleString("en-US");

/** Compact bot card for the dashboard grid. All details open in the bot's detail view. */
export function BotTile({ bot, onOpen, dimmed = false }: { bot: BotView; onOpen: () => void; dimmed?: boolean }) {
  const c = bot.config;
  const badge = BADGE[bot.status];
  return (
    <article className={`bot-tile tile-${badge.cls}${dimmed ? " dimmed" : ""}`}>
      <header className="tile-head">
        <h3 className="tile-symbol" title={c.symbol}>{c.symbol}</h3>
        <span className={`tile-badge ${badge.cls}`}>{badge.text}</span>
      </header>
      <div className="tile-date">Created {new Date(bot.createdAt).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" })}</div>
      <div className="tile-exchange">{exchangeInfo(c.exchange).label.toUpperCase()}</div>
      <div className="tile-account"><span aria-hidden="true">⚿</span> {bot.accountName ? bot.accountName.toUpperCase() : "PAPER TRADING"}</div>
      <div className="tile-tags">
        <span className="tile-tag">STEP-GRID</span>
        {c.mode === "live" ? <span className="tile-tag live">LIVE</span> : <span className="tile-tag paper">PAPER</span>}
        <span className="tile-hash">#{botTag(bot)}</span>
      </div>
      <div className="tile-name" title={c.name}>{c.name}</div>
      {(() => {
        const left = bot.openEntries.length + bot.openTargets.length;
        const stopped = bot.status !== "running" && bot.status !== "idle";
        return stopped && left > 0
          ? <div className="tile-warn">⚠ {left} order{left === 1 ? "" : "s"} still open on the exchange — retrying cancel</div>
          : null;
      })()}
      <div className="tile-times">
        <div>Started: {when(bot.createdAt)}</div>
        {bot.stoppedAt ? <div>Stopped: {when(bot.stoppedAt)}</div> : <div>Running for {duration(Date.now() - bot.createdAt)}</div>}
      </div>
      <button className="tile-open" onClick={onOpen}>Open Bot Details</button>
    </article>
  );
}

function duration(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
