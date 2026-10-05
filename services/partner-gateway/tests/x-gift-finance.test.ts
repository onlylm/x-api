import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AppDatabase } from "../src/database.js";
import { MockPaymentClient } from "../src/clients/payment.js";
import { MockXApiClient } from "../src/clients/x-api.js";
import { MockZovoClient } from "../src/clients/zovo.js";
import { ledgerTestConfig } from "./ledger-fixtures.js";

describe("蓝V未知成本不虚构毛利，人民币供货结算不变", () => {
  let directory: string, db: AppDatabase, app: Awaited<ReturnType<typeof buildApp>>;
  let config: ReturnType<typeof ledgerTestConfig>, serial: number;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "x-gift-finance-"));
    config = ledgerTestConfig(join(directory, "gateway.sqlite"));
    config.xApi.mode = "mock";
    config.products.push(...(["x_premium_3m", "x_premium_6m"] as const).map((plan) => ({
      product: plan, plan, name_zh: plan, name: plan, internal_cost_cny: "0.00",
      cost_price: plan === "x_premium_3m" ? "22.00" : "44.00", max_sell_price: "99.00",
      currency: "CNY" as const, max_qty: 1 as const, enabled: true,
    })));
    serial = 0;
    db = new AppDatabase(config.databasePath);
    app = await buildApp(config, { db, payment: new MockPaymentClient(config.publicBaseUrl),
      xApi: new MockXApiClient(), zovo: new MockZovoClient(), startWorkers: false });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function order(product = "x_premium_3m", sellPrice = "30.00", delivered = true) {
    const response = await app.inject({ method: "POST", url: "/api/v1/checkout/orders",
      headers: { "x-api-key": config.platformApiKey }, payload: { product, quantity: 1,
        sell_price: sellPrice, client_order_id: "JD-X-FINANCE-" + (++serial),
        ...(product.startsWith("x_") ? { recipient: "@example_user" } : {}) } });
    expect(response.statusCode).toBe(200);
    const id = String(response.json().order_id);
    db.markOrderPaid(id, new Date().toISOString(), "MOCK-" + serial, sellPrice);
    if (delivered) db.db.prepare("UPDATE orders SET delivery_status='success' WHERE order_id=?").run(id);
    return id;
  }
  async function finance() {
    const response = await app.inject({ url: "/admin/api/finance?from=2020-01-01&to=2099-01-01",
      headers: { "x-admin-token": config.adminToken } });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  it.each([
    ["x_premium_3m", "30.00", "22.00", "8.00"],
    ["x_premium_6m", "60.00", "44.00", "16.00"],
  ])("%s 未核实成本时行和汇总毛利为null，但供货/价差正常结算", async (product, retail, supply, spread) => {
    const id = await order(product, retail);
    const report = await finance();
    expect(report.items[0]).toMatchObject({ order_id: id, gross_profit: null, profit_basis: "pending",
      supply_price: supply, supplier_net_income_cny: supply, platform_margin: spread, settlement_eligible: true });
    expect(report.summary).toMatchObject({ gross_profit: null, profit_pending_count: 1,
      profit_estimated_count: 0, platform_margin: spread, platform_payable: spread });
    const statement = db.createPlatformSettlement({ settlementId: "ST-X-FINANCE", from: "2020-01-01T00:00:00.000Z",
      to: "2099-01-01T00:00:00.000Z" });
    expect(statement.settlement).toMatchObject({ amount: spread, rebate_usd: "0.00", order_count: 1 });
    expect(statement.lines[0]).toMatchObject({ order_id: id, amount: spread, supply_price: supply });
  });

  it.each([null, "0.00"])("缺失或零预估 %s 不得视为免费成本", async estimate => {
    const id = await order();
    db.db.prepare("UPDATE orders SET upstream_estimated_cost_cny=? WHERE order_id=?").run(estimate, id);
    expect((await finance()).items[0]).toMatchObject({ gross_profit: null, profit_basis: "pending" });
  });

  it.each([["12.00", "10.00"], ["0.00", "22.00"]])("显式登记真实成本%s后使用已核实口径", async (cost, profit) => {
    const id = await order();
    db.setOrderUpstreamCost({ orderId: id, amount: cost, currency: "CNY", cny: cost });
    expect((await finance()).items[0]).toMatchObject({ gross_profit: profit, profit_basis: "verified",
      cost_is_estimate: false, platform_margin: "8.00", supplier_net_income_cny: "22.00" });
  });

  it("有效正数预估成本仍可显示预估毛利", async () => {
    const id = await order();
    db.db.prepare("UPDATE orders SET upstream_estimated_cost_cny='10.00' WHERE order_id=?").run(id);
    expect((await finance()).items[0]).toMatchObject({ gross_profit: "12.00", profit_basis: "estimated", cost_is_estimate: true });
  });

  it("不把旧GPT美元核查数据套给蓝V零成本订单", async () => {
    const id = await order();
    const rows = db.listOrdersForReport("2020-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z");
    vi.spyOn(db, "listOrdersForReport").mockReturnValue(rows.map(row => ({ ...row, cost_review_status: "confirmed",
      reviewed_standard_usd: "15.76", reviewed_actual_usd: "15.76", reviewed_fees_usd: "0.00",
      reviewed_retained_usd: "0.00", reviewed_fx_rate: "7.00" })));
    expect((await finance()).items[0]).toMatchObject({ order_id: id, gross_profit: null,
      profit_basis: "pending", platform_margin: "8.00", supplier_net_income_cny: "22.00" });
  });

  it("GPT原有成本计算不变，混合汇总不会隐藏蓝V未知成本", async () => {
    const gptId = await order("chatgpt_plus_1m", "135.00");
    let report = await finance();
    expect(report.items[0]).toMatchObject({ order_id: gptId, gross_profit: "2.00", profit_basis: "estimated" });
    await order();
    report = await finance();
    expect(report.summary).toMatchObject({ gross_profit: null, profit_pending_count: 1,
      profit_estimated_count: 1, platform_margin: "33.00", platform_payable: "33.00" });
  });

  it("未成功履约不产生供货结算或待核算利润", async () => {
    await order("x_premium_3m", "30.00", false);
    expect((await finance()).items[0]).toMatchObject({ gross_profit: "0.00", profit_basis: "not_eligible",
      settlement_eligible: false, platform_margin: "0.00" });
  });
});
