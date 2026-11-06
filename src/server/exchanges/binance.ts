import { createHmac } from "node:crypto";

// Binance account key check. Live Binance order placement is not implemented yet;
// Binance bots run in Paper mode.

export function validateBinanceKey(apiKey: string, secret: string): { apiKey: string; secret: string } {
  const k = apiKey.trim(), s = secret.trim();
  if (!/^[A-Za-z0-9]{40,128}$/u.test(k)) throw new Error("Binance API key should be 40–128 letters and digits");
  if (!/^[A-Za-z0-9]{40,128}$/u.test(s)) throw new Error("Binance API secret should be 40–128 letters and digits (HMAC keys only)");
  return { apiKey: k, secret: s };
}

/** Calls a signed read-only endpoint to confirm the key works and may trade spot. */
export async function verifyBinanceKey(apiKey: string, secret: string): Promise<void> {
  const query = `omitZeroBalances=true&recvWindow=10000&timestamp=${Date.now()}`;
  const signature = createHmac("sha256", secret).update(query).digest("hex");
  let res: Response;
  try {
    res = await fetch(`https://api.binance.com/api/v3/account?${query}&signature=${signature}`, {
      headers: { "X-MBX-APIKEY": apiKey }, signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new Error(`Could not reach Binance to verify the key, try again: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body = await res.json().catch(() => ({})) as { code?: number; msg?: string; canTrade?: boolean };
  if (!res.ok) {
    if (res.status === 451 || res.status === 403) throw new Error("Binance refused requests from the server's location");
    throw new Error(`Binance rejected the key: ${body.msg ?? `HTTP ${res.status}`}`);
  }
  if (body.canTrade === false) throw new Error("This Binance API key does not have Spot trading enabled");
}
