export async function api<T = unknown>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json", "x-gridbot": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

/** Human-friendly number: up to `max` decimals, thousands separators. */
export function fmt(value: string | number | null | undefined, max = 8): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? Math.min(max, 2) : abs >= 1 ? Math.min(max, 4) : max;
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function fmtPnl(value: string | number): string {
  const n = Number(value);
  const text = fmt(Math.abs(n), 4);
  return n > 0 ? `+${text}` : n < 0 ? `−${text}` : text;
}

export function pnlClass(value: string | number): string {
  const n = Number(value);
  return n > 0 ? "pos" : n < 0 ? "neg" : "";
}

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
}
