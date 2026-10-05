export class TelegramDeliveryError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, readonly retryAfterMs?: number) {
    super(code);
    this.name = "TelegramDeliveryError";
  }
}

export class TelegramClient {
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly token: string, private readonly chatId: string,
    options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
    if (!/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(token)) throw new Error("telegram_token_invalid");
    if (!/^-?[1-9]\d{0,19}$/.test(chatId)) throw new Error("telegram_chat_id_invalid");
    this.request = options.fetch ?? fetch;
    this.timeoutMs = Math.min(15_000, Math.max(100, options.timeoutMs ?? 10_000));
  }

  async send(text: string): Promise<{ messageId: string }> {
    if (!text.trim() || text.length > 4096) throw new TelegramDeliveryError("telegram_text_invalid", false);
    try {
      const response = await this.request(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(this.timeoutMs),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text, protect_content: true,
          link_preview_options: { is_disabled: true } }),
      });
      const data = await response.json().catch(() => null) as {
        ok?: boolean; error_code?: number; parameters?: { retry_after?: number };
        result?: { message_id?: number };
      } | null;
      const code = response.status === 429 ? 429 : data?.error_code ?? response.status;
      if (code === 429) {
        const retry = Number(data?.parameters?.retry_after ?? response.headers.get("retry-after"));
        const ms = Number.isFinite(retry) && retry > 0 ? Math.ceil(retry * 1000) : 60_000;
        throw new TelegramDeliveryError("telegram_rate_limited", true, Math.min(ms, 7 * 86_400_000));
      }
      if (!response.ok || data?.ok !== true) {
        throw new TelegramDeliveryError(`telegram_http_${Number.isInteger(code) ? code : 0}`,
          code >= 500 || code === 408 || response.ok);
      }
      if (!Number.isSafeInteger(data.result?.message_id) || Number(data.result?.message_id) <= 0) {
        throw new TelegramDeliveryError("telegram_response_invalid", true);
      }
      return { messageId: String(data.result!.message_id) };
    } catch (error) {
      if (error instanceof TelegramDeliveryError) throw error;
      // Fetch errors often embed the URL containing the bot token. Never forward them.
      throw new TelegramDeliveryError("telegram_transport_error", true);
    }
  }
}
