import type { ExchangeId, ExchangeInfo } from "./types";

export const EXCHANGES: ExchangeInfo[] = [
  {
    id: "hyperliquid",
    label: "Hyperliquid",
    live: true,
    accounts: true,
    symbolHint: "BTC or ETH-PERP",
    keyLabel: "Wallet address",
    secretLabel: "Private key",
  },
  {
    id: "hyperliquid-testnet",
    label: "Hyperliquid Testnet",
    live: true,
    accounts: true,
    symbolHint: "BTC or ETH-PERP",
    keyLabel: "Wallet address",
    secretLabel: "Private key",
  },
  { id: "binance", label: "Binance", live: false, accounts: true, symbolHint: "BTCUSDT", keyLabel: "API key", secretLabel: "API secret" },
  { id: "bybit", label: "Bybit", live: false, accounts: false, symbolHint: "BTCUSDT", keyLabel: "API key", secretLabel: "API secret" },
  { id: "deribit", label: "Deribit", live: false, accounts: false, symbolHint: "BTC-PERPETUAL", keyLabel: "Client ID", secretLabel: "Client secret" },
  { id: "solana", label: "Solana", live: false, accounts: false, symbolHint: "SOL", keyLabel: "Public key", secretLabel: "Private key" },
  { id: "ethereum", label: "Ethereum", live: false, accounts: false, symbolHint: "ETH", keyLabel: "Public address", secretLabel: "Private key" },
];

export const EXCHANGE_IDS = EXCHANGES.map(e => e.id) as [ExchangeId, ...ExchangeId[]];

export function exchangeInfo(id: ExchangeId): ExchangeInfo {
  const info = EXCHANGES.find(e => e.id === id);
  if (!info) throw new Error(`Unknown exchange ${id}`);
  return info;
}
