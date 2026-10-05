import type { FastifyBaseLogger } from "fastify";
import { validatePlatformWebhookConfiguration, type AppConfig } from "../config.js";
import { AppDatabase } from "../database.js";
import { signPlatformWebhook } from "../security.js";

const retryMinutes = [1, 5, 15, 60, 360];

export class PlatformWebhookWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly log: FastifyBaseLogger,
  ) {}

  private deliveryEnabled(): boolean { return this.config.platformWebhookEnabled !== false; }

  start(): void {
    if (this.timer || !this.deliveryEnabled()) return;
    this.timer = setInterval(() => void this.tick(), this.config.webhookPollIntervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running || !this.deliveryEnabled()) return;
    validatePlatformWebhookConfiguration(this.config);
    this.running = true;
    try {
      for (const row of this.db.getDueWebhooks(new Date().toISOString())) {
        if (!this.deliveryEnabled()) break;
        await this.deliver(row);
      }
    } finally {
      this.running = false;
    }
  }

  private async deliver(row: Record<string, unknown>): Promise<void> {
    const id = Number(row.id);
    const attempt = Number(row.attempt_count) + 1;
    const body = String(row.payload_json);
    const event = String(row.event);
    const timestamp = Math.floor(Date.now() / 1000);
    try {
      const response = await fetch(this.config.platformWebhookUrl, {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Event": event,
          "X-Webhook-Delivery": `dlv_${id}_${attempt}`,
          "X-Webhook-Timestamp": String(timestamp),
          "X-Webhook-Signature": signPlatformWebhook(
            this.config.platformWebhookSecret,
            timestamp,
            body,
          ),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      if (response.status !== 200 || text.trim() !== "success") {
        throw new Error(`platform_webhook_rejected_${response.status}`);
      }
      this.db.markWebhookDelivered(id, new Date().toISOString());
    } catch (error) {
      const message = error instanceof Error && /^platform_webhook_rejected_\d{3}$/.test(error.message)
        ? error.message : "platform_webhook_unavailable";
      if (attempt >= 6) {
        this.db.markWebhookExhausted(id, attempt, new Date().toISOString(), message);
        this.log.error({ outboxId: id, attempt }, "platform webhook delivery exhausted");
        return;
      }
      const minutes = retryMinutes[attempt - 1];
      const next = new Date(Date.now() + minutes * 60_000).toISOString();
      this.db.markWebhookFailed(id, attempt, next, message);
      this.log.warn({ outboxId: id, attempt }, "platform webhook delivery delayed");
    }
  }
}
