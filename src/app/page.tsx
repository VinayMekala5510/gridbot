"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Snapshot } from "@/shared/types";
import { BotCard } from "./components/BotCard";
import { AccountSettings } from "./components/AccountSettings";
import { BotParameters } from "./components/BotParameters";
import { Logo } from "./components/Logo";
import { ThemeToggle } from "./components/ThemeToggle";
import { api, fmtPnl, pnlClass } from "./lib/client";

type Toast = { id: number; kind: "ok" | "error"; text: string };
type Filter = "all" | "active" | "stopped";
type View = "dashboard" | "accounts" | "new-bot";
const VIEWS: { id: View; label: string; icon: string }[] = [
  { id: "dashboard", label: "Dashboard", icon: "▦" },
  { id: "accounts", label: "Account Settings", icon: "⚿" },
  { id: "new-bot", label: "Bot Parameters", icon: "＋" },
];
const ACTIVE_KEY = "gridbot.activeAccount";

export default function Dashboard() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [activeAccountId, setActiveAccountId] = useState<number | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [killing, setKilling] = useState(false);
  const [user, setUser] = useState<string | null>(null);
  const [view, setView] = useState<View>("dashboard");
  const toastId = useRef(0);

  // The current page lives in the URL hash so refresh and back/forward keep it.
  useEffect(() => {
    const read = () => {
      const h = window.location.hash.slice(1) as View;
      setView(VIEWS.some(v => v.id === h) ? h : "dashboard");
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  function go(next: View) {
    if (window.location.hash !== `#${next}`) window.location.hash = next;
    setView(next);
    window.scrollTo({ top: 0 });
  }

  const notify = useCallback((kind: Toast["kind"], text: string) => {
    const id = ++toastId.current;
    setToasts(t => [...t, { id, kind, text }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), kind === "error" ? 9000 : 4500);
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(ACTIVE_KEY);
      if (saved) setActiveAccountId(Number(saved));
    } catch { /* storage unavailable */ }
    api<{ user: string | null }>("/api/me").then(r => setUser(r.user)).catch(() => undefined);
    const source = new EventSource("/api/stream");
    source.onmessage = e => { setSnap(JSON.parse(e.data) as Snapshot); setConnected(true); };
    source.onerror = () => {
      setConnected(false);
      // Session expired → back to the login page.
      fetch("/api/me").then(r => { if (r.status === 401) window.location.replace("/login"); }).catch(() => undefined);
    };
    return () => source.close();
  }, []);

  async function logout() {
    await api("/api/logout", "POST").catch(() => undefined);
    window.location.replace("/login");
  }

  // Drop a stale active-account selection (e.g. account deleted elsewhere).
  useEffect(() => {
    if (snap && activeAccountId !== null && !snap.accounts.some(a => a.id === activeAccountId)) chooseAccount(null);
  }, [snap, activeAccountId]);

  function chooseAccount(id: number | null) {
    setActiveAccountId(id);
    try { id === null ? localStorage.removeItem(ACTIVE_KEY) : localStorage.setItem(ACTIVE_KEY, String(id)); } catch { /* ignore */ }
  }

  async function killAll() {
    if (!window.confirm("MASTER KILL SWITCH\n\nStop EVERY bot and cancel ALL open orders on every connected live account (including orders not placed by these bots)?")) return;
    setKilling(true);
    try {
      const res = await api<{ bots: number; accountCancels: { account: string; canceled: number; failed: number; error?: string }[] }>("/api/kill-all", "POST");
      const problems = res.accountCancels.filter(a => a.failed || a.error);
      notify(problems.length ? "error" : "ok",
        `Emergency stop: ${res.bots} bot(s) stopped. ` +
        (res.accountCancels.length ? res.accountCancels.map(a => `${a.account}: ${a.error ? `ERROR ${a.error}` : `${a.canceled} canceled${a.failed ? `, ${a.failed} FAILED` : ""}`}`).join("; ") : "No live accounts."));
    } catch (err) {
      notify("error", (err as Error).message);
    } finally {
      setKilling(false);
    }
  }

  const bots = (snap?.bots ?? []).filter(b =>
    filter === "all" ? true : filter === "active" ? b.status === "running" || b.status === "idle" : !(b.status === "running" || b.status === "idle"));

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><Logo />gridbot<span className="dot">.</span></div>
        <div className="topbar-right">
          {snap?.storage === "memory" && <span className="chip warn">In-memory storage</span>}
          <span className={`conn ${connected ? "on" : "off"}`}><i />{connected ? "Live" : "Reconnecting…"}</span>
          <ThemeToggle />
          {user && <span className="user-chip">{user}</span>}
          <button className="btn ghost small" onClick={logout}>Log out</button>
        </div>
      </header>

      <div className="shell">
        <nav className="sidebar nav" aria-label="Main">
          {VIEWS.map(v => (
            <button key={v.id} className={`nav-item ${view === v.id ? "on" : ""}`} aria-current={view === v.id ? "page" : undefined} onClick={() => go(v.id)}>
              <span className="nav-icon">{v.icon}</span>
              <span className="nav-label">{v.label}</span>
              {v.id === "dashboard" && snap && <span className="nav-count">{snap.totals.runningBots}</span>}
              {v.id === "accounts" && snap && <span className="nav-count">{snap.accounts.length}</span>}
            </button>
          ))}
        </nav>

        <main className="main">
          {view === "accounts" && (
            <AccountSettings accounts={snap?.accounts ?? []} activeAccountId={activeAccountId} onActiveAccount={chooseAccount} notify={notify} />
          )}
          {view === "new-bot" && (
            <BotParameters accounts={snap?.accounts ?? []} activeAccountId={activeAccountId} notify={notify} onCreated={() => go("dashboard")} />
          )}
          {view === "dashboard" && <>
          <section className="overview">
            <div className="stat"><span>Total combined PnL</span><b className={`mono ${pnlClass(snap?.totals.netPnl ?? 0)}`}>{snap ? fmtPnl(snap.totals.netPnl) : "—"}</b><small>realized + unrealized − fees</small></div>
            <div className="stat"><span>Running bots</span><b className="mono">{snap ? snap.totals.runningBots : "—"}</b><small>of {snap?.totals.totalBots ?? 0} on dashboard</small></div>
            <div className="stat"><span>Completed roundtrips</span><b className="mono">{snap ? snap.totals.roundtrips : "—"}</b><small>entry + target both filled</small></div>
            <button className="kill-all" onClick={killAll} disabled={killing || !snap}>
              <span className="kill-icon">⏻</span>
              <span><b>{killing ? "STOPPING ALL…" : "MASTER KILL SWITCH"}</b><small>Emergency stop all · cancel all orders</small></span>
            </button>
          </section>

          <div className="list-head">
            <h2>Bot instances <button className="btn primary small" onClick={() => go("new-bot")}>＋ New bot</button></h2>
            <div className="seg" role="group" aria-label="Filter bots">
              {(["all", "active", "stopped"] as Filter[]).map(f => (
                <button key={f} className={filter === f ? "on" : ""} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                  {f[0].toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {!snap ? <div className="placeholder">Connecting to the bot server…</div>
            : bots.length === 0 ? (
              <div className="placeholder">
                {snap.bots.length === 0
                  ? <>No bots yet. <button className="link-btn inline-link" onClick={() => go("new-bot")}>Create one in Bot Parameters</button>. Start with Paper mode to test your settings.</>
                  : "No bots match this filter."}
              </div>
            ) : (
              <div className="cards">{bots.map(b => <BotCard key={b.id} bot={b} now={snap.serverTime} notify={notify} />)}</div>
            )}
          </>}
        </main>
      </div>

      <div className="toasts" aria-live="polite">
        {toasts.map(t => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </div>
  );
}
