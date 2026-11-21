import { decryptSecret, encryptSecret } from "./crypto";
import type { Store } from "./store/types";

// Telegram notifications through the Telegram Bot API (https://core.telegram.org/bots/api).
// The bot token is stored encrypted (MASTER_KEY) in app_settings; it never goes back to the browser.

const API = "https://api.telegram.org";
const TIMEOUT_MS = 10_000;
const KEYS = { token: "telegram.token", chat: "telegram.chatId", chatName: "telegram.chatName", bot: "telegram.bot" };

export class TelegramError extends Error {}

export interface TelegramStatus {
  configured: boolean;
  hasToken: boolean;
  botUsername: string | null;
  chatId: string | null;
  chatName: string | null;
}

export function validateToken(token: string): string {
  const t = token.trim();
  if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/u.test(t)) throw new TelegramError("That doesn't look like a bot token (format 123456789:ABC…). Copy it from @BotFather.");
  return t;
}

async function call<T>(token: string, method: string, body: Record<string, unknown> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new TelegramError(`Could not reach Telegram: ${err instanceof Error ? err.message : String(err)}`);
  }
  const data = await res.json().catch(() => ({})) as { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
  if (!data.ok) {
    const e = new TelegramError(`Telegram: ${data.description ?? `HTTP ${res.status}`}`);
    (e as TelegramError & { retryAfter?: number }).retryAfter = data.parameters?.retry_after;
    throw e;
  }
  return data.result as T;
}

export class TelegramNotifier {
  private token: string | null = null;
  private chatId: string | null = null;
  private chatName: string | null = null;
  private botUsername: string | null = null;

  constructor(private readonly store: Store) {}

  async init(): Promise<void> {
    const enc = await this.store.getSetting(KEYS.token);
    try { this.token = enc ? decryptSecret(enc) : null; } catch { this.token = null; }
    this.chatId = await this.store.getSetting(KEYS.chat);
    this.chatName = await this.store.getSetting(KEYS.chatName);
    this.botUsername = await this.store.getSetting(KEYS.bot);
  }

  status(): TelegramStatus {
    return { configured: Boolean(this.token && this.chatId), hasToken: Boolean(this.token), botUsername: this.botUsername, chatId: this.chatId, chatName: this.chatName };
  }

  /** Saves a new token (checked with getMe) and/or chat id. Omitted fields keep their saved value. */
  async save(input: { token?: string | null; chatId?: string | null }): Promise<TelegramStatus> {
    if (input.token) {
      const token = validateToken(input.token);
      const me = await call<{ username: string }>(token, "getMe");
      this.token = token;
      this.botUsername = me.username;
      await this.store.setSetting(KEYS.token, encryptSecret(token));
      await this.store.setSetting(KEYS.bot, me.username);
    }
    if (input.chatId !== undefined && input.chatId !== null) {
      const chat = input.chatId.trim();
      if (!/^(-?\d{3,}|@[A-Za-z0-9_]{5,})$/u.test(chat)) throw new TelegramError("Chat ID should be a number (e.g. 123456789) or a channel name like @mychannel");
      this.chatId = chat;
      await this.store.setSetting(KEYS.chat, chat);
    }
    return this.status();
  }

  /** Finds the chat of the latest message sent to the bot (send /start to the bot first) and saves it. */
  async detectChat(): Promise<TelegramStatus> {
    if (!this.token) throw new TelegramError("Save the bot token first");
    const updates = await call<{ message?: { chat: { id: number; first_name?: string; title?: string; username?: string } }; my_chat_member?: { chat: { id: number; title?: string } } }[]>(this.token, "getUpdates", { limit: 50 });
    const chats = updates.map(u => u.message?.chat ?? u.my_chat_member?.chat).filter(Boolean) as { id: number; first_name?: string; title?: string; username?: string }[];
    const chat = chats[chats.length - 1];
    if (!chat) throw new TelegramError(`No messages found. Open Telegram, find @${this.botUsername ?? "your bot"}, press Start (or send any message), then try again.`);
    this.chatId = String(chat.id);
    this.chatName = chat.title ?? chat.first_name ?? chat.username ?? null;
    await this.store.setSetting(KEYS.chat, this.chatId);
    await this.store.setSetting(KEYS.chatName, this.chatName);
    return this.status();
  }

  async clear(): Promise<void> {
    this.token = this.chatId = this.chatName = this.botUsername = null;
    for (const k of Object.values(KEYS)) await this.store.setSetting(k, null);
  }

  /** Sends an HTML message; retries rate limits and network errors up to 3 times. */
  async send(html: string): Promise<void> {
    if (!this.token || !this.chatId) throw new TelegramError("Telegram is not set up");
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await call(this.token, "sendMessage", { chat_id: this.chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true });
        return;
      } catch (err) {
        lastError = err;
        const wait = (err as { retryAfter?: number }).retryAfter;
        if (/chat not found|bot was blocked|Unauthorized|Forbidden/iu.test(String((err as Error).message))) break;
        await new Promise(r => setTimeout(r, (wait ? wait * 1000 : 1000 * attempt)));
      }
    }
    throw lastError instanceof Error ? lastError : new TelegramError(String(lastError));
  }
}

const esc = (s: string) => s.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

export function alertMessage(a: { symbol: string; exchangeLabel: string; side: "upper" | "lower"; price: string; upper: string | null; lower: string | null; time: number }): string {
  const hit = a.side === "upper" ? `rose to <b>${esc(a.price)}</b> — upper limit <b>${esc(a.upper ?? "")}</b> reached` : `fell to <b>${esc(a.price)}</b> — lower limit <b>${esc(a.lower ?? "")}</b> reached`;
  const other = a.side === "upper" ? (a.lower ? `Lower limit: ${esc(a.lower)}` : "") : (a.upper ? `Upper limit: ${esc(a.upper)}` : "");
  const when = new Date(a.time).toISOString().replace("T", " ").slice(0, 19);
  return [`${a.side === "upper" ? "📈" : "📉"} <b>Price alert · ${esc(a.symbol)}</b> (${esc(a.exchangeLabel)})`, `Price ${hit}.`, other, `${when} UTC · Gridbot`]
    .filter(Boolean).join("\n");
}
