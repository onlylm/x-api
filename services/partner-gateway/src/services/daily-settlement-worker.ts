import type { FastifyBaseLogger } from "fastify";
import { AppDatabase } from "../database.js";

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const SETTLEMENT_HOUR = 22;

export interface DailySettlementWindow {
  businessDate: string;
  from: string;
  to: string;
  settlementId: string;
}

function settlementWindowForBusinessDate(businessDate: string): DailySettlementWindow {
  const [year, month, day] = businessDate.split("-").map(Number);
  const to = new Date(Date.UTC(year, month - 1, day, SETTLEMENT_HOUR - 8, 0, 0));
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
  return {
    businessDate,
    from: from.toISOString(),
    to: to.toISOString(),
    settlementId: `STD${businessDate.replaceAll("-", "")}`,
  };
}

function nextBusinessDate(businessDate: string): string {
  const [year, month, day] = businessDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 返回当前时刻已经到期的最近一个北京时间 22:00 结算窗口。 */
export function dailySettlementWindow(now: Date): DailySettlementWindow {
  const beijing = new Date(now.getTime() + BEIJING_OFFSET_MS);
  let year = beijing.getUTCFullYear();
  let month = beijing.getUTCMonth();
  let day = beijing.getUTCDate();
  if (beijing.getUTCHours() < SETTLEMENT_HOUR) {
    const previous = new Date(Date.UTC(year, month, day) - 24 * 60 * 60 * 1000);
    year = previous.getUTCFullYear();
    month = previous.getUTCMonth();
    day = previous.getUTCDate();
  }
  const businessDate = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return settlementWindowForBusinessDate(businessDate);
}

export class DailySettlementWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: AppDatabase,
    private readonly log: FastifyBaseLogger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const due = dailySettlementWindow(now);
      if (this.db.getPlatformSettlementByBusinessDate(due.businessDate)) return;
      const latest = this.db.getLatestPlatformSettlementBusinessDate();
      let businessDate = latest && latest < due.businessDate ? nextBusinessDate(latest) : due.businessDate;
      let generated = 0;
      while (businessDate <= due.businessDate && generated < 31) {
        const window = settlementWindowForBusinessDate(businessDate);
        if (!this.db.getPlatformSettlementByBusinessDate(businessDate)) {
          const result = this.db.createPlatformSettlement({
            settlementId: window.settlementId,
            from: window.from,
            to: window.to,
            generationMode: "scheduled",
            businessDate: window.businessDate,
            allowEmpty: true,
          });
          this.log.info(
            {
              settlementId: result.settlement.settlement_id,
              businessDate: window.businessDate,
              orderCount: result.settlement.order_count,
              amount: result.settlement.amount,
              rebateUsd: result.settlement.rebate_usd,
            },
            "daily platform settlement generated",
          );
          generated += 1;
        }
        businessDate = nextBusinessDate(businessDate);
      }
    } catch (error) {
      // 多实例同时启动时，业务日期唯一约束会保证只生成一张；另一个实例无需报错。
      const window = dailySettlementWindow(now);
      if (this.db.getPlatformSettlementByBusinessDate(window.businessDate)) return;
      this.log.error({ err: error, businessDate: window.businessDate }, "daily platform settlement failed");
    } finally {
      this.running = false;
    }
  }
}
