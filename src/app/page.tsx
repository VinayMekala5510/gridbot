"use client";

import { useState } from "react";
import type { Config, Fill, Simulation } from "@/lib/grid/types";

const initial: Config = { anchor: "100", interval: "10", quantity: "1", maxSteps: 10,
  spacing: "absolute", baseOverflow: "pending" };

export default function Home() {
  const [config, setConfig] = useState<Config>(initial);
  const [fills, setFills] = useState<Fill[]>([]);
  const [result, setResult] = useState<Simulation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(nextFills: Fill[], stop = false) {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/simulate", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config, fills: nextFills, stop }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Simulation failed");
      setResult(data); setFills(nextFills);
    } catch (error) { setError(error instanceof Error ? error.message : "Request failed"); }
    finally { setBusy(false); }
  }

  const locked = busy || result !== null;
  return <main>
    <header><div><span className="eyebrow">HYPERLIQUID / STRATEGY LAB</span>
      <h1>Gridbot<span className="dot">.</span></h1>
      <p>Build your grid. Follow every fill.</p></div><span className="badge">Simulation only</span></header>
    <div className="layout">
      <section className="panel"><h2>Grid configuration</h2>
        <form onSubmit={event => { event.preventDefault(); void run([]); }}>
          <fieldset disabled={locked}>
            <label>Starting market price<input required value={config.anchor}
              onChange={e => setConfig({ ...config, anchor: e.target.value })} inputMode="decimal" /></label>
            <label>Spacing<select value={config.spacing} onChange={e => setConfig({ ...config,
              spacing: e.target.value as Config["spacing"] })}>
              <option value="absolute">Fixed price interval</option><option value="percentage">Percentage ratio</option>
            </select></label>
            <label>Grid interval {config.spacing === "percentage" && "(0.01 = 1%)"}
              <input required value={config.interval} inputMode="decimal"
                onChange={e => setConfig({ ...config, interval: e.target.value })} /></label>
            <label>Asset quantity per order<input required value={config.quantity} inputMode="decimal"
              onChange={e => setConfig({ ...config, quantity: e.target.value })} /></label>
            <label>Maximum filled steps<input required type="number" min="1" max="10000" value={config.maxSteps}
              onChange={e => setConfig({ ...config, maxSteps: Number(e.target.value) })} /></label>
            <label>When a third base order is needed<select value={config.baseOverflow}
              onChange={e => setConfig({ ...config, baseOverflow: e.target.value as Config["baseOverflow"] })}>
              <option value="pending">Undecided — stop at first conflict</option>
              <option value="cancel-nearest">Cancel nearest existing base order</option>
              <option value="cancel-farthest">Cancel farthest existing base order</option>
              <option value="allow">Allow additional base orders</option>
            </select></label>
          </fieldset>
          {!result && <button disabled={busy} type="submit">{busy ? "Starting…" : "Start simulation"}</button>}
        </form>
        {result && <div className="buttons"><button disabled={busy || result.status !== "running"}
          onClick={() => void run(fills, true)}>Stop & cancel orders</button>
          <button className="secondary" disabled={busy} onClick={() => { setResult(null); setFills([]); setError(""); }}>Reset</button></div>}
        <p className="note">Every full fill creates an opposite target and a new base order.
          Targets sit one grid level away. Nearest and farthest are measured from the filled order price.</p>
      </section>
      <section className="panel results" aria-live="polite">
        <div className="section-head"><h2>Orders</h2><span>{result?.status ?? "Ready"}</span></div>
        <div className="stats"><div><small>Filled steps</small><strong>{result?.filledSteps ?? 0} / {config.maxSteps}</strong></div>
          <div><small>Open orders</small><strong>{result?.orders.length ?? 0}</strong></div></div>
        {error && <p role="alert" className="error">{error}</p>}
        {result?.stopReason && <p className="notice">Stopped: {result.stopReason.replaceAll("_", " ")}</p>}
        {!result ? <div className="empty">Start a simulation to place 2 buys and 2 sells.<br />No wallet connection or real orders.</div> :
          <div className="table-wrap"><table><thead><tr><th>Order</th><th>Side</th><th>Role</th><th>Price</th><th>Quantity</th><th>Action</th></tr></thead>
            <tbody>{result.orders.map(order => <tr key={order.id}><td>{order.id}</td>
              <td className={order.side}>{order.side}</td><td>{order.role}</td><td>{order.price}</td><td>{order.quantity}</td>
              <td><button className="small" disabled={busy || result.status !== "running" || fills.length >= 500}
                onClick={() => void run([...fills, { orderId: order.id, cumulativeQuantity: order.quantity }])}>Fill</button></td></tr>)}</tbody></table></div>}
        {result && <details open><summary>Execution log</summary><pre>{result.logs.join("\n")}</pre>
          <button className="secondary small" onClick={() => {
            const url = URL.createObjectURL(new Blob([JSON.stringify({ config, fills, ...result }, null, 2)], { type: "application/json" }));
            const link = document.createElement("a"); link.href = url; link.download = "gridbot-simulation.json"; link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}>Download log</button></details>}
      </section>
    </div>
    <footer>Local strategy preview · Refreshing clears the session · Live exchange connection pending</footer>
  </main>;
}
