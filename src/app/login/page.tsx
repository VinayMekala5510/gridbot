"use client";
import { useState } from "react";
import { api } from "../lib/client";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/login", "POST", { username, password });
      window.location.replace("/");
    } catch (err) {
      setError((err as Error).message);
      setPassword("");
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="brand login-brand"><span className="logo">▦</span>gridbot<span className="dot">.</span></div>
        <h1>Sign in</h1>
        <p className="muted">Grid trading control panel</p>
        <label className="field"><span>Username</span>
          <input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" autoFocus required maxLength={100} />
        </label>
        <label className="field"><span>Password</span>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required maxLength={200} />
        </label>
        {error && <p className="login-error" role="alert">{error}</p>}
        <button className="btn primary big" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <p className="hint">Sessions last 12 hours. 5 failed attempts lock sign-in for 15 minutes.</p>
      </form>
    </main>
  );
}
