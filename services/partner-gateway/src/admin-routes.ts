import { createHmac, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { validateXApiConfiguration } from "./config.js";
import { AppDatabase } from "./database.js";
import type { OrderRecord } from "./domain.js";
import { calculateFinancialAmounts, centsToMoney, isXGiftPlan, maskEmail, moneyToCents, signedMoneyToCents, sumMoney } from "./domain.js";
import { hmacHex, secureEqual } from "./security.js";
import { adminPageV2 } from "./admin-page-v2.js";
import { RuntimeSettings, settingKeys } from "./runtime-settings.js";
import type { RefundService } from "./services/refund-service.js";
import { FinancialLedger } from "./services/financial-ledger.js";
import { calculateCostReconciliation } from "./services/cost-reconciliation.js";

const operatorMoney = z.union([z.string(), z.number()]).transform((value, context) => {
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    context.addIssue({ code: "custom", message: "金额请输入数字，最多保留两位小数" });
    return z.NEVER;
  }
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount < 0 || amount > 9_999_999.99) {
    context.addIssue({ code: "custom", message: "金额超出允许范围" });
    return z.NEVER;
  }
  return amount.toFixed(2);
});
const configSchema = z.object({
  payment_mode: z.enum(["mock", "alipay"]).optional(),
  alipay_app_id: z.string().max(100).optional(),
  alipay_private_key: z.string().max(16_000).optional(),
  alipay_public_key: z.string().max(16_000).optional(),
  alipay_seller_id: z.string().max(100).optional(),
  zovo_mode: z.enum(["mock", "live"]).optional(),
  zovo_app_id: z.string().max(100).optional(),
  zovo_api_key: z.string().max(1_000).optional(),
});
const productSchema = z.object({
  internal_cost_cny: operatorMoney,
  cost_price: operatorMoney,
  enabled: z.boolean(),
});
const costSchema = z.object({
  amount: operatorMoney.nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  cny: operatorMoney,
});
const customerPriceRefundSchema = z.object({
  amount: operatorMoney,
  reference: z.string().trim().min(3).max(120),
  reason: z.string().trim().min(4).max(500),
  refunded_at: z.string().datetime(),
});
const platformRebateSchema = z.object({
  standard_usd: operatorMoney,
  actual_usd: operatorMoney,
  fee_usd: operatorMoney.default("0.15"),
  card_transaction_id: z.string().trim().max(120).default(""),
  reason: z.string().trim().min(4).max(500),
});
const settlementCreateSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});
const settlementPaymentSchema = z.object({
  payment_id: z.string().min(8).max(100).optional(),
  currency: z.enum(["CNY", "USD"]).optional(),
  amount: operatorMoney.optional(),
  method: z.enum(["bank_transfer", "alipay", "other"]),
  reference: z.string().trim().min(3).max(120),
  note: z.string().trim().max(500).default(""),
  paid_at: z.string().datetime(),
});
const invoiceCreateSchema = z.object({
  order_number: z.string().trim().min(5).max(120),
  title_type: z.enum(["personal", "company"]),
  title: z.string().trim().min(2).max(120),
  tax_id: z.string().trim().max(50).default(""),
  unit_address: z.string().trim().max(300).default(""),
  phone: z.string().trim().max(50).default(""),
  bank_name: z.string().trim().max(120).default(""),
  bank_account: z.string().trim().max(100).default(""),
  recipient_email: z.string().trim().email().max(200),
  request_note: z.string().trim().max(500).default(""),
}).superRefine((value, context) => {
  if (value.title_type === "company" && value.tax_id.length < 5) {
    context.addIssue({ code: "custom", path: ["tax_id"], message: "企业抬头必须填写纳税人识别号" });
  }
});
const invoiceIssueSchema = z.object({
  invoice_number: z.string().trim().min(2).max(120),
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  invoice_url: z.string().trim().max(1000).refine((value) => !value || value.startsWith("https://"), "电子发票地址必须使用 HTTPS").default(""),
  issue_note: z.string().trim().max(500).default(""),
});
const orderActionSchema = z.object({
  action: z.enum(["refund_via_alipay", "confirm_external_refund", "reject_refund", "mark_delivery_failed", "restore_delivery_pending", "begin_manual_takeover", "report_manual_takeover_issue", "release_manual_takeover_not_started", "release_manual_takeover_confirmed_failed", "confirm_manual_delivery", "close_test_order"]),
  reason: z.string().trim().min(4).max(500),
  expected_task_id: z.string().trim().min(1).max(120).optional(),
  account_email: z.string().trim().email().max(254).optional(),
  verified: z.boolean().optional(),
});
const loginFailures = new Map<string, { count: number; resetAt: number }>();

export function registerAdminRoutes(
  app: FastifyInstance,
  config: AppConfig,
  db: AppDatabase,
  settings: RuntimeSettings,
  refunds: RefundService,
): void {
  app.get("/admin", async (_request, reply) =>
    reply
      .header("X-Frame-Options", "DENY")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate")
      .header("Pragma", "no-cache")
      .header("Expires", "0")
      .header("Surrogate-Control", "no-store")
      .type("text/html; charset=utf-8")
      .send(adminPageV2),
  );

  app.post("/admin/api/login", async (request, reply) => {
    const ip = request.ip;
    const blocked = loginFailures.get(ip);
    if (blocked && blocked.resetAt > Date.now() && blocked.count >= 8) {
      return reply.code(429).send({ success: false, detail_zh: "尝试次数过多，请 15 分钟后再试" });
    }
    const body = z.object({ password: z.string().min(1).max(500) }).parse(request.body);
    if (!secureEqual(body.password, config.adminToken)) {
      const active = blocked && blocked.resetAt > Date.now() ? blocked : { count: 0, resetAt: Date.now() + 15 * 60_000 };
      active.count += 1;
      loginFailures.set(ip, active);
      return reply.code(401).send({ success: false, detail_zh: "管理员密码不正确" });
    }
    loginFailures.delete(ip);
    const token = createSession(config.adminToken);
    reply.header(
      "Set-Cookie",
      `merchant_admin=${token}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`,
    );
    return { success: true };
  });

  app.post("/admin/api/logout", async (_request, reply) => {
    reply.header("Set-Cookie", "merchant_admin=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
    return { success: true };
  });

  app.get("/admin/api/session", { preHandler: adminGuard(config) }, async () => ({ success: true }));

  app.get("/admin/api/config", { preHandler: adminGuard(config) }, async () => {
    const alipay = settings.alipayConfig();
    const zovo = settings.zovoConfig();
    const ready = settings.readiness();
    return {
      success: true,
      payment_mode: settings.paymentMode(),
      zovo_mode: settings.zovoMode(),
      alipay_ready: ready.alipay,
      zovo_ready: ready.zovo,
      ready_for_sales: ready.readyForSales,
      alipay_app_id_masked: mask(alipay.appId),
      alipay_seller_id_masked: mask(alipay.sellerId),
      zovo_app_id_masked: mask(zovo.appId),
      zovo_api_key_masked: mask(zovo.apiKey),
      alipay_notify_url: `${config.publicBaseUrl.replace(/\/$/, "")}/callbacks/alipay`,
    };
  });

  app.put("/admin/api/config", { preHandler: adminGuard(config) }, async (request, reply) => {
    const input = configSchema.parse(request.body);
    const currentAlipay = settings.alipayConfig();
    const candidate = {
      appId: input.alipay_app_id || currentAlipay.appId,
      privateKey: normalizePem(input.alipay_private_key || currentAlipay.privateKey),
      publicKey: normalizePem(input.alipay_public_key || currentAlipay.publicKey),
      sellerId: input.alipay_seller_id || currentAlipay.sellerId,
    };
    const paymentMode = input.payment_mode ?? settings.paymentMode();
    const zovoKey = input.zovo_api_key || settings.zovoConfig().apiKey;
    const zovoMode = input.zovo_mode ?? settings.zovoMode();
    if (paymentMode === "alipay" && (!candidate.appId || !candidate.privateKey || !candidate.publicKey || !candidate.sellerId)) {
      return reply.code(422).send({ success: false, detail_zh: "切换正式支付宝前，请完整填写 App ID、PID、应用私钥和支付宝公钥" });
    }
    if (zovoMode === "live" && !zovoKey) {
      return reply.code(422).send({ success: false, detail_zh: "切换正式上游前，请填写上游 API Key" });
    }
    if (input.payment_mode) settings.set(settingKeys.paymentMode, input.payment_mode, false);
    if (input.alipay_app_id) settings.set(settingKeys.alipayAppId, input.alipay_app_id);
    if (input.alipay_private_key) settings.set(settingKeys.alipayPrivateKey, normalizePem(input.alipay_private_key));
    if (input.alipay_public_key) settings.set(settingKeys.alipayPublicKey, normalizePem(input.alipay_public_key));
    if (input.alipay_seller_id) settings.set(settingKeys.alipaySellerId, input.alipay_seller_id);
    if (input.zovo_mode) settings.set(settingKeys.zovoMode, input.zovo_mode, false);
    if (input.zovo_app_id) settings.set(settingKeys.zovoAppId, input.zovo_app_id, false);
    if (input.zovo_api_key) settings.set(settingKeys.zovoApiKey, input.zovo_api_key);
    return { success: true };
  });

  app.get("/admin/api/products", { preHandler: adminGuard(config) }, async () => ({
    success: true,
    items: db.listProducts(),
  }));

  app.get("/admin/api/operations", { preHandler: adminGuard(config) }, async () => {
    const now = new Date();
    const since = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
    const staleBefore = new Date(now.getTime() - 20 * 60_000).toISOString();
    const snapshot = db.getOperationsSnapshot(since, staleBefore);
    const ready = settings.readiness();
    return {
      success: true,
      generated_at: now.toISOString(),
      window_hours: 24,
      readiness: {
        payment: ready.alipay,
        upstream: ready.zovo,
        ready_for_sales: ready.readyForSales,
      },
      controls: [
        {
          key: "platform_auth",
          name: "平台接口鉴权",
          status: config.platformApiKey.length >= 32 && config.platformAllowedIps.size > 0 ? "active" : "attention",
          detail: `API Key + ${config.platformAllowedIps.size} 个出口 IP 白名单`,
        },
        {
          key: "payment_verify",
          name: "支付到账校验",
          status: "active",
          detail: "RSA2 验签、商户与金额校验，并主动查单确认",
        },
        {
          key: "price_guard",
          name: "价格保护",
          status: "active",
          detail: "创建订单时校验供货底价、数量和金额精度",
        },
        {
          key: "idempotency",
          name: "订单幂等",
          status: "active",
          detail: "同参数请求复用原单；参数变化返回 idempotency_conflict",
        },
        {
          key: "activation_guard",
          name: "履约防重",
          status: "active",
          detail: "单订单单任务运行，成功后禁止再次消费额度",
        },
        {
          key: "refund_guard",
          name: "原路退款控制",
          status: "active",
          detail: "全额退款、请求号幂等、支付宝结果确认，履约中和成功订单禁止直退",
        },
        {
          key: "webhook_outbox",
          name: "回调可靠投递",
          status: "active",
          detail: "事件唯一键、签名校验、固定退避重试与耗尽告警",
        },
        {
          key: "secret_storage",
          name: "敏感信息保护",
          status: "active",
          detail: "密钥与 Session 加密保存，日志自动脱敏",
        },
      ],
      ...snapshot,
    };
  });

  app.get("/admin/api/analytics/daily", { preHandler: adminGuard(config) }, async () => {
    const today = new Date(Date.now() + 8 * 60 * 60_000).toISOString().slice(0, 10);
    const from = new Date(`${today}T00:00:00Z`);
    from.setUTCDate(from.getUTCDate() - 6);
    return {
      success: true,
      items: db.listDailyMetrics(from.toISOString().slice(0, 10), today),
    };
  });

  app.get<{ Querystring: { q?: string; page?: string; page_size?: string } }>(
    "/admin/api/customers",
    { preHandler: adminGuard(config) },
    async (request) => {
      const { page, pageSize } = pagination(request.query);
      const result = db.listCustomers({ search: request.query.q, page, pageSize });
      return { success: true, items: result.items, pagination: paginationResult(result.total, page, pageSize) };
    },
  );

  app.get<{ Querystring: {
    q?: string; status?: string; from?: string; to?: string; page?: string; page_size?: string;
  } }>(
    "/admin/api/orders",
    { preHandler: adminGuard(config) },
    async (request, reply) => {
      const allowedStatuses = new Set(["", "pending", "paid", "expired", "refunded"]);
      const status = String(request.query.status ?? "");
      if (!allowedStatuses.has(status)) return reply.code(422).send({ success: false, detail_zh: "支付状态筛选值无效" });
      const { from, to } = reportRange(request.query);
      const { page, pageSize } = pagination(request.query);
      const result = db.listAdminOrders({
        from, to, search: request.query.q, paymentStatus: status || undefined,
        page, pageSize, timeField: "created_at",
      });
      return {
        success: true,
        items: result.items.map(financeRow),
        pagination: paginationResult(result.total, page, pageSize),
      };
    },
  );

  app.get<{ Querystring: {
    q?: string; delivery_status?: string; from?: string; to?: string; page?: string; page_size?: string;
  } }>(
    "/admin/api/fulfillment",
    { preHandler: adminGuard(config) },
    async (request, reply) => {
      const allowedStatuses = new Set(["", "pending", "success", "failed"]);
      const deliveryStatus = String(request.query.delivery_status ?? "");
      if (!allowedStatuses.has(deliveryStatus)) return reply.code(422).send({ success: false, detail_zh: "履约状态筛选值无效" });
      const { from, to } = reportRange(request.query);
      const { page, pageSize } = pagination(request.query);
      const result = db.listAdminOrders({
        from, to, search: request.query.q, deliveryStatus: deliveryStatus || undefined,
        paidOnly: true, page, pageSize, timeField: "paid_at",
      });
      return {
        success: true,
        items: result.items.map(financeRow),
        summary: result.summary,
        pagination: paginationResult(result.total, page, pageSize),
      };
    },
  );

  app.get<{ Params: { customerId: string } }>(
    "/admin/api/customers/:customerId",
    { preHandler: adminGuard(config) },
    async (request, reply) => {
      const detail = db.getCustomerDetail(request.params.customerId);
      if (!detail) return reply.code(404).send({ success: false, detail_zh: "客户记录不存在" });
      return { success: true, ...detail };
    },
  );

  app.get<{ Querystring: { order_number?: string } }>(
    "/admin/api/invoices/order-lookup",
    { preHandler: adminGuard(config) },
    async (request, reply) => {
      const orderNumber = String(request.query.order_number ?? "").trim();
      if (!orderNumber) return reply.code(422).send({ success: false, detail_zh: "请输入平台订单号或我方订单号" });
      const order = db.findOrderForInvoice(orderNumber);
      if (!order) return reply.code(404).send({ success: false, detail_zh: "没有找到对应订单" });
      const eligible = order.status === "paid" && !order.refunded_at && !order.invoice_id;
      const invoiceable = eligible ? db.invoiceableAmount(String(order.order_id)) : null;
      const reason = order.invoice_id
        ? "该订单已经生成开票单"
        : order.status !== "paid"
          ? "订单尚未完成付款"
          : order.refunded_at
            ? "订单已经退款，不能开票"
            : null;
      return {
        success: true,
        eligible,
        reason,
        order: {
          ...order,
          receipt_amount: invoiceable ?? centsToMoney(
            moneyToCents(String(order.alipay_receipt_amount ?? order.amount))
              - moneyToCents(String(order.customer_price_refund_amount ?? "0.00")),
          ),
        },
      };
    },
  );

  app.get<{ Querystring: {
    q?: string; status?: string; from?: string; to?: string; page?: string; page_size?: string;
  } }>(
    "/admin/api/invoices",
    { preHandler: adminGuard(config) },
    async (request, reply) => {
      const status = String(request.query.status ?? "");
      if (!["", "requested", "issued"].includes(status)) {
        return reply.code(422).send({ success: false, detail_zh: "开票状态筛选值无效" });
      }
      const { page, pageSize } = pagination(request.query);
      const range = request.query.from || request.query.to ? reportRange(request.query) : {};
      const result = db.listInvoices({
        ...range, status: status || undefined, search: request.query.q, page, pageSize,
      });
      return { success: true, items: result.items, pagination: paginationResult(result.total, page, pageSize) };
    },
  );

  app.post(
    "/admin/api/invoices",
    { preHandler: adminGuard(config) },
    async (request, reply) => {
      const input = invoiceCreateSchema.parse(request.body);
      const order = db.findOrderForInvoice(input.order_number);
      if (!order) return reply.code(404).send({ success: false, detail_zh: "没有找到对应订单" });
      if (order.invoice_id) return reply.code(409).send({ success: false, detail_zh: "该订单已经生成开票单，不能重复创建" });
      if (order.status !== "paid") return reply.code(409).send({ success: false, detail_zh: "订单尚未付款，不能生成开票单" });
      if (order.refunded_at) return reply.code(409).send({ success: false, detail_zh: "订单已经退款，不能生成开票单" });
      const now = new Date();
      const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
      const invoice = db.createInvoice({
        invoiceId: `INV${stamp}${randomBytes(3).toString("hex").toUpperCase()}`,
        orderId: String(order.order_id),
        titleType: input.title_type,
        title: input.title,
        taxId: input.tax_id || null,
        unitAddress: input.unit_address,
        phone: input.phone,
        bankName: input.bank_name,
        bankAccount: input.bank_account,
        recipientEmail: input.recipient_email,
        amount: db.invoiceableAmount(String(order.order_id)),
        requestNote: input.request_note,
      });
      return reply.code(201).send({ success: true, invoice });
    },
  );

  app.post<{ Params: { invoiceId: string } }>(
    "/admin/api/invoices/:invoiceId/issue",
    { preHandler: adminGuard(config) },
    async (request, reply) => {
      const input = invoiceIssueSchema.parse(request.body);
      try {
        const invoice = db.markInvoiceIssued({
          invoiceId: request.params.invoiceId,
          invoiceNumber: input.invoice_number,
          invoiceDate: input.invoice_date,
          invoiceUrl: input.invoice_url || null,
          issueNote: input.issue_note,
        });
        return { success: true, invoice };
      } catch (error) {
        if (error instanceof Error && error.message === "invoice_not_found") {
          return reply.code(404).send({ success: false, detail_zh: "开票单不存在" });
        }
        if (error instanceof Error && error.message === "invoice_not_requested") {
          return reply.code(409).send({ success: false, detail_zh: "当前开票单状态不能登记开票结果" });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { orderId: string } }>(
    "/admin/api/orders/:orderId",
    { preHandler: adminGuard(config) },
    async (request, reply) => {
      const detail = db.getAdminOrderDetail(request.params.orderId);
      if (!detail) return reply.code(404).send({ success: false, detail_zh: "订单不存在" });
      return {
        success: true,
        order: detail.order,
        activations: detail.activations.map((row) => ({
          activation_id: row.activation_id,
          task_id: row.task_id,
          status: row.status,
          finished: Boolean(row.finished),
          failure_code: row.failure_code,
          message_zh: row.message_zh,
          account_email_masked: row.account_email_masked,
          upstream_order_id: row.upstream_order_id,
          created_at: row.created_at,
          updated_at: row.updated_at,
        })),
        refund: detail.refund,
        manual_takeover: db.getManualActivationTakeover(request.params.orderId) ?? null,
        can_begin_unsubmitted_takeover: !isXGiftPlan(detail.order.plan) && db.canBeginUnsubmittedManualTakeover(request.params.orderId),
        platform_rebate: detail.platformRebate,
        cost_reconciliation: new FinancialLedger(db).detail(request.params.orderId).reconciliation,
        cost_review_status: new FinancialLedger(db).get(request.params.orderId)?.status ?? null,
        audit: detail.audit,
      };
    },
  );

  app.post<{ Params: { orderId: string } }>(
    "/admin/api/orders/:orderId/actions",
    { preHandler: adminGuard(config) },
    async (request, reply) => {
      const input = orderActionSchema.parse(request.body);
      try {
        const takeoverActions = ["begin_manual_takeover", "report_manual_takeover_issue",
          "release_manual_takeover_not_started", "release_manual_takeover_confirmed_failed"];
        const actionOrder = db.getOrder(request.params.orderId);
        if (actionOrder && isXGiftPlan(actionOrder.plan) &&
            (takeoverActions.includes(input.action) || input.action === "confirm_manual_delivery")) {
          return reply.code(409).send({ success: false, error: "x_gift_original_order_required",
            detail_zh: "蓝V须核对原赠送订单；请在待核查任务中查询原单结果，不能人工接管或凭邮箱登记成功" });
        }
        const takeover = db.getManualActivationTakeover(request.params.orderId);
        const takeoverConfirmation = input.action === "confirm_manual_delivery" &&
          takeover && ["claimed", "review_required"].includes(takeover.status);
        if ((takeoverActions.includes(input.action) || takeoverConfirmation) &&
            !/^MT-[0-9]{8}-[0-9]{9}$/.test(input.reason)) {
          return reply.code(422).send({ success: false, detail_zh: "人工接管操作只填写 MT-日期-编号 格式的工单号，不接受自由文本或 Session" });
        }
        if (["begin_manual_takeover", "confirm_manual_delivery"].includes(input.action) &&
            /(?:access[_-]?token|session[_-]?token|authorization|eyJ[A-Za-z0-9_-]{20,}\.)/i.test(input.reason)) {
          return reply.code(422).send({ success: false, detail_zh: "操作原因只能填写脱敏工单或凭证号，不得包含 Session 或令牌" });
        }
        if (input.action === "refund_via_alipay") {
          const existing = db.getRefundByOrderId(request.params.orderId);
          const result = await refunds.execute({
            orderId: request.params.orderId,
            clientRefundId: existing?.client_refund_id ?? `ADMIN-${request.params.orderId}-${Date.now()}`,
            reason: input.reason,
          });
          if (result.refund.status === "processing") reply.code(202);
          return { success: true, refund: result.refund, idempotent: result.idempotent };
        }
        if (input.action === "confirm_external_refund") {
          const existing = db.getRefundByOrderId(request.params.orderId);
          const result = await refunds.reconcileExternal({
            orderId: request.params.orderId,
            clientRefundId: existing?.client_refund_id ?? `MANUAL-${request.params.orderId}-${Date.now()}`,
            reason: input.reason,
          });
          return { success: true, refund: result.refund, idempotent: result.idempotent };
        }
        if (input.action === "reject_refund") {
          return { success: true, refund: refunds.reject(request.params.orderId, input.reason) };
        }
        if (input.action === "close_test_order") {
          return { success: true, order: db.closeTestOrderWithoutRefund(request.params.orderId, input.reason) };
        }
        if (input.action === "begin_manual_takeover") {
          return { success: true, manual_takeover: db.beginManualActivationTakeover(
            request.params.orderId, input.reason, input.expected_task_id,
          ) };
        }
        if (input.action === "report_manual_takeover_issue") {
          return { success: true, manual_takeover: db.reportManualActivationTakeoverIssue(request.params.orderId, input.reason) };
        }
        if (input.action === "release_manual_takeover_not_started" ||
            input.action === "release_manual_takeover_confirmed_failed") {
          if (input.verified !== true) return reply.code(422).send({
            success: false, detail_zh: "解除接管前，必须人工复核原任务失败且人工开通明确未发生",
          });
          return { success: true, manual_takeover: db.releaseManualActivationTakeover({
            orderId: request.params.orderId,
            reference: input.reason,
            outcome: input.action === "release_manual_takeover_not_started"
              ? "not_started" : "confirmed_not_activated",
          }) };
        }
        if (input.action === "confirm_manual_delivery") {
          if (!input.account_email || input.verified !== true) return reply.code(422).send({
            success:false, detail_zh:"请填写实际充值账号，并确认已核实充值成功凭证",
          });
          const result = db.confirmManualDelivery({
            orderId: request.params.orderId,
            taskId: `manual_${Date.now()}_${randomBytes(4).toString("hex")}`,
            reason: input.reason,
            accountEmailMasked: maskEmail(input.account_email),
            emailHash: hmacHex(config.emailHmacKey, input.account_email.toLowerCase()),
          });
          return { success: true, ...result };
        }
        const order = db.setDeliveryStatusByAdmin(
          request.params.orderId,
          input.action === "mark_delivery_failed" ? "failed" : null,
          input.reason,
        );
        return { success: true, order };
      } catch (error) {
        const messages: Record<string, string> = {
          order_not_found: "订单不存在",
          order_must_be_paid: "只有已支付订单可以修改履约状态",
          successful_delivery_is_immutable: "履约成功状态不可人工回退",
          delivery_not_failed: "只有履约失败订单可以恢复为待处理",
          activation_requires_review: "任务仍在处理或结果未知，不能只修改订单标签；请通过人工核查队列核实原任务",
          manual_account_required: "请填写并核对实际充值账号",
          only_test_order_can_close: "只有内部 ADMINTEST 联调单允许不退款直接关闭",
          activation_blocks_close: "订单仍在履约或已经履约成功，不能直接关闭",
          refund_blocks_close: "订单存在待处理或已完成退款，不能直接关闭",
          activation_blocks_manual_delivery: "订单仍在履约中或结果未知，不能人工确认已完成充值",
          activation_already_succeeded: "订单已有成功履约记录，不需要重复确认",
          refund_blocks_manual_delivery: "订单已有待处理或已完成退款，不能人工确认已完成充值",
          manual_takeover_platform_only: "人工接管仅适用于平台订单",
          manual_takeover_requires_failed_activation: "原开通任务尚未明确失败，或结果仍不确定；请先核查上游结果",
          manual_takeover_pre_submit_not_proven: "原任务已被领取或存在上游痕迹，无法证明尚未提交；禁止直接接管，请先核查原任务结果",
          manual_takeover_task_mismatch: "目标任务号缺失或已变化，请刷新订单详情并重新确认这笔任务",
          manual_takeover_already_completed: "该订单的人工接管已完成",
          manual_takeover_required: "该订单有自动开通记录，请先开始人工接管再确认人工充值",
          manual_takeover_account_mismatch: "人工开通账号与原任务提交账号不一致；停止登记成功并联系平台复核",
          manual_takeover_ticket_required: "人工接管成功只填写短工单号，不接受 Session 或自由文本",
          manual_takeover_blocks_refund: "订单正在人工接管，不能发起或批准退款",
          manual_takeover_in_progress: "订单正在人工接管；请先确认人工开通结果，不要修改内部履约标签",
          manual_takeover_review_required: "人工操作结果尚未核实，接管锁继续生效；请先完成核查",
          manual_takeover_not_claimed: "订单当前不是人工接管中，不能上报接管异常",
          manual_takeover_not_active: "订单没有待解除的人工接管锁",
          manual_takeover_requires_confirmed_failure: "人工操作结果未确认时，不能按“尚未开始”解除接管",
          manual_takeover_requires_review: "请先将人工失败或未知结果转入待核查，再确认未开通",
          manual_takeover_release_blocked: "订单已成功、已退款或存在退款记录；不能解除接管锁",
        };
        const code = error instanceof Error ? error.message : "";
        if (messages[code]) return reply.code(409).send({ success: false, detail_zh: messages[code] });
        throw error;
      }
    },
  );

  app.put<{ Params: { product: string } }>(
    "/admin/api/products/:product",
    { preHandler: adminGuard(config) },
    async (request, reply) => {
      const input = productSchema.parse(request.body);
      if (moneyToCents(input.internal_cost_cny) > moneyToCents(input.cost_price)) {
        return reply.code(422).send({ success: false, detail_zh: "上游成本不能高于平台供货价" });
      }
      const targetProduct = db.listProducts().find((product) => product.product === request.params.product);
      if (!targetProduct) return reply.code(404).send({ success: false, detail_zh: "商品不存在" });
      if (input.enabled) {
        const readiness = settings.readiness();
        if (isXGiftPlan(targetProduct.plan)) {
          if (settings.paymentMode() !== "alipay" || !readiness.alipay) {
            return reply.code(409).send({ success: false, error: "payment_not_ready",
              detail_zh: "请先启用正式支付宝并完整配置收款信息，再启用蓝V商品" });
          }
          if (config.xApi.mode === "disabled" ||
              (config.nodeEnv === "production" && config.xApi.mode !== "live")) {
            return reply.code(409).send({ success: false, error: "x_gift_not_configured",
              detail_zh: "蓝V正式履约接口尚未配置，不能启用销售" });
          }
          try { validateXApiConfiguration(config); }
          catch {
            return reply.code(409).send({ success: false, error: "x_gift_not_configured",
              detail_zh: "蓝V履约地址或商户密钥配置无效，请完成服务器配置后再启用" });
          }
        } else if (!readiness.readyForSales) {
          return reply.code(409).send({ success: false, detail_zh: "请先把支付宝和上游都切换为正式模式并配置完整，再启用商品" });
        }
      }
      try {
        const product = db.updateProduct({
          product: request.params.product,
          internalCostCny: input.internal_cost_cny,
          supplyPrice: input.cost_price,
          enabled: input.enabled,
        });
        return { success: true, product };
      } catch (error) {
        if (error instanceof Error && error.message === "product_not_found") {
          return reply.code(404).send({ success: false, detail_zh: "商品不存在" });
        }
        if (error instanceof Error && error.message === "chile_price_not_verified") {
          return reply.code(409).send({ success: false, detail_zh: "智利 50x 价格及美元成本基准尚未核实，暂不可启用" });
        }
        throw error;
      }
    },
  );

  app.get<{ Querystring: { from?: string; to?: string; page?: string; page_size?: string } }>(
    "/admin/api/finance",
    { preHandler: adminGuard(config) },
    async (request) => {
      const { from, to } = reportRange(request.query);
      const { page, pageSize } = pagination(request.query);
      const allItems = db.listOrdersForReport(from, to).reverse().map(financeRow);
      const eligible = allItems.filter((row) => row.settlement_eligible);
      const activeReceipts = sumMoney(allItems
        .filter((row) => row.status === "paid")
        .map(row => row.receipt_amount));
      const rebateSummary = db.getPlatformRebateSummary();
      const items = allItems.slice((page - 1) * pageSize, page * pageSize);
      return {
        success: true,
        summary: {
          settlement_orders: eligible.length,
          receipts: activeReceipts,
          platform_margin: sumMoney(eligible.map(row=>row.platform_margin)),
          platform_payable: sumMoney(eligible.map(row=>centsToMoney(Math.max(0,signedMoneyToCents(row.platform_margin)-moneyToCents(String(row.platform_paid_cny)))))),
          platform_settled: sumMoney(eligible.map(row=>String(row.platform_paid_cny))),
          platform_rebate_pending_usd: rebateSummary.pending,
          platform_rebate_included_usd: rebateSummary.included,
          platform_rebate_payable_usd: rebateSummary.payable,
          platform_rebate_settled_usd: rebateSummary.paid,
          gross_profit: eligible.some(row=>row.gross_profit===null) ? null : sumMoney(eligible.map(row=>row.gross_profit!)),
          profit_pending_count: eligible.filter(row=>row.gross_profit===null).length,
          profit_action_required_count: eligible.filter(row=>row.gross_profit===null && (
            row.cost_review_status==="draft" || row.cost_review_status==="disputed" ||
            (moneyToCents(String(row.platform_rebate_usd || "0.00"))>0 && !row.reviewed_fx_rate)
          )).length,
          profit_estimated_count: eligible.filter(row=>row.profit_basis==="estimated").length,
        },
        items,
        pagination: paginationResult(allItems.length, page, pageSize),
        settlements: db.listPlatformSettlements(),
      };
    },
  );

  app.post(
    "/admin/api/platform-settlements",
    { preHandler: adminGuard(config) },
    async (request, reply) => {
      const input = settlementCreateSchema.parse(request.body);
      const { from, to } = reportRange(input);
      const now = new Date();
      const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
      try {
        const result = db.createPlatformSettlement({
          settlementId: `ST${stamp}${randomBytes(3).toString("hex").toUpperCase()}`,
          from,
          to,
        });
        return reply.code(201).send({ success: true, ...result });
      } catch (error) {
        if (error instanceof Error && error.message === "no_platform_payable") {
          return reply.code(409).send({ success: false, detail_zh: "当前区间没有待结算的平台利润或美元差价" });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { settlementId: string } }>(
    "/admin/api/platform-settlements/:settlementId/payment",
    { preHandler: adminGuard(config) },
    async (request, reply) => {
      const input = settlementPaymentSchema.parse(request.body);
      try {
        const settlement = db.recordPlatformSettlementPayment({
          settlementId: request.params.settlementId,
          method: input.method,
          reference: input.reference,
          note: input.note,
          paidAt: input.paid_at,
          paymentId: input.payment_id,
          currency: input.currency,
          amount: input.amount,
        });
        return { success: true, settlement };
      } catch (error) {
        if (error instanceof Error && error.message === "settlement_not_found") {
          return reply.code(404).send({ success: false, detail_zh: "结算单不存在" });
        }
        if (error instanceof Error && error.message === "settlement_not_pending") {
          return reply.code(409).send({ success: false, detail_zh: "当前结算单状态不能登记打款" });
        }
        throw error;
      }
    },
  );

  app.put<{ Params: { orderId: string } }>(
    "/admin/api/orders/:orderId/cost",
    { preHandler: adminGuard(config) },
    async (request, reply) => {
      const input = costSchema.parse(request.body);
      try {
        db.setOrderUpstreamCost({
          orderId: request.params.orderId,
          amount: input.amount,
          currency: input.currency,
          cny: input.cny,
        });
        return { success: true };
      } catch (error) {
        if (error instanceof Error && error.message === "order_not_found") {
          return reply.code(404).send({ success: false, detail_zh: "订单不存在" });
        }
        throw error;
      }
    },
  );

  app.put<{ Params: { orderId: string } }>(
    "/admin/api/orders/:orderId/customer-price-refund",
    { preHandler: adminGuard(config) },
    async (request, reply) => {
      const input = customerPriceRefundSchema.parse(request.body);
      try {
        const order = db.recordCustomerPriceRefund({
          orderId: request.params.orderId,
          amount: input.amount,
          reference: input.reference,
          reason: input.reason,
          refundedAt: input.refunded_at,
        });
        return { success: true, order };
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        const failures: Record<string, [number, string]> = {
          order_not_found: [404, "订单不存在"],
          platform_order_required: [409, "人工补录订单不参与平台补差"],
          successful_paid_order_required: [409, "只有已付款、履约成功且未全额退款的订单才能登记补差退款"],
          settlement_already_created: [409, "该订单已经进入平台结算单，不能再修改补差退款"],
          invoice_already_created: [409, "该订单已经生成开票单，不能再修改补差退款"],
          price_refund_must_be_positive: [422, "补差退款金额必须大于 0"],
          price_refund_exceeds_platform_margin: [422, "补差退款不能超过该订单原始平台利润"],
        };
        const failure = failures[code];
        if (failure) return reply.code(failure[0]).send({ success: false, detail_zh: failure[1] });
        throw error;
      }
    },
  );

  app.put<{ Params: { orderId: string } }>(
    "/admin/api/orders/:orderId/platform-rebate",
    { preHandler: adminGuard(config) },
    async (request, reply) => {
      const input = platformRebateSchema.parse(request.body);
      try {
        const rebate = db.recordPlatformRebate({
          rebateId: `PR${Date.now()}${randomBytes(3).toString("hex").toUpperCase()}`,
          orderId: request.params.orderId,
          standardUsd: input.standard_usd,
          actualUsd: input.actual_usd,
          feeUsd: input.fee_usd,
          cardTransactionId: input.card_transaction_id || null,
          reason: input.reason,
        });
        return { success: true, platform_rebate: rebate };
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        const failures: Record<string, [number, string]> = {
          order_not_found: [404, "订单不存在"],
          platform_order_required: [409, "人工补录订单不参与平台美元差价返还"],
          successful_paid_order_required: [409, "只有已付款、履约成功且未全额退款的订单才能登记平台差价"],
          platform_rebate_already_recorded: [409, "该订单已经登记平台美元差价，不能重复登记"],
          upstream_order_required: [409, "缺少可核对的上游订单号，不能登记平台美元差价"],
          card_transaction_already_used: [409, "该卡台交易已经关联其他订单，不能重复登记"],
          no_platform_rebate_due: [422, "扣除 0.15U 手续费后没有应返平台的美元差价"],
        };
        if (failures[code]) {
          const [status, detail] = failures[code];
          return reply.code(status).send({ success: false, detail_zh: detail });
        }
        throw error;
      }
    },
  );

  app.get<{ Querystring: { from?: string; to?: string } }>(
    "/admin/api/finance.csv",
    { preHandler: adminGuard(config) },
    async (request, reply) => {
      const { from, to } = reportRange(request.query);
      const rows = db.listOrdersForReport(from, to).map(financeRow);
      const header = [
        "订单号", "用户付款", "服务商收款", "供货成本", "补差退款", "平台利润",
        "下单时间", "付款时间", "履约提交时间", "履约完成时间", "补差退款时间", "全额退款时间", "平台结算时间",
        "标准扣款(U)", "实际扣款(U)", "手续费(U)", "应返平台差价(U)", "美元差价状态", "美元差价结算单", "美元差价结算时间",
        "真实成本合计(USD)", "实际费用(USD)", "核算汇率(CNY/USD)", "退差折合人民币(仅核算)",
        "我方净结算收入(CNY)", "我方毛利(CNY)", "毛利口径",
      ];
      const csv = [header, ...rows.map((r) => [
        r.client_order_id, r.customer_payment_amount, r.receipt_amount, r.supply_price,
        r.customer_price_refund_amount, r.platform_margin,
        beijingCsvTime(r.created_at), beijingCsvTime(r.paid_at),
        beijingCsvTime(r.fulfillment_submitted_at), beijingCsvTime(r.fulfillment_completed_at),
        beijingCsvTime(r.customer_price_refunded_at), beijingCsvTime(r.refunded_at),
        beijingCsvTime(r.platform_settled_at),
        r.platform_rebate_standard_usd ?? "", r.platform_rebate_actual_usd ?? "",
        r.platform_rebate_fee_usd ?? "", r.platform_rebate_usd ?? "",
        r.platform_rebate_status ?? "", r.platform_rebate_settlement_id ?? "",
        beijingCsvTime(r.platform_rebate_settled_at),
        r.verified_cost_usd ?? "", r.reviewed_fees_usd ?? "", r.reviewed_fx_rate ?? "",
        r.rebate_equivalent_cny ?? "", r.supplier_net_income_cny ?? "", r.gross_profit ?? "",
        ({verified:"已核实",estimated:"预估",pending:"待核算",not_eligible:"不计结算"})[r.profit_basis],
      ])].map((row) => row.map((cell) => csvCell(String(cell))).join(",")).join("\r\n");
      return reply
        .header("Content-Disposition", `attachment; filename="finance-${from.slice(0, 10)}-${to.slice(0, 10)}.csv"`)
        .type("text/csv; charset=utf-8")
        .send(`\uFEFF${csv}`);
    },
  );
}

export function adminGuard(config: AppConfig) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers["x-admin-token"];
    const supplied = Array.isArray(header) ? header[0] : header;
    const cookie = parseCookie(request.headers.cookie ?? "").merchant_admin;
    const validHeader = typeof supplied === "string" && secureEqual(supplied, config.adminToken);
    if (!validHeader && !verifySession(cookie, config.adminToken)) {
      return reply.code(401).send({ success: false, error: "admin_login_required", detail_zh: "请先登录运营后台" });
    }
  };
}

function createSession(secret: string): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 8 * 60 * 60_000 })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifySession(token: string | undefined, secret: string): boolean {
  if (!token) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (!secureEqual(signature, expected)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return typeof parsed.exp === "number" && parsed.exp > Date.now();
  } catch {
    return false;
  }
}

function parseCookie(value: string): Record<string, string> {
  return Object.fromEntries(value.split(";").map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [part.trim(), ""] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
}

function reportRange(query: { from?: string; to?: string }): { from: string; to: string } {
  const fallbackFrom = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const fallbackTo = new Date().toISOString();
  const from = new Date(query.from ?? fallbackFrom);
  const to = new Date(query.to ?? fallbackTo);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    throw new Error("invalid_report_range");
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

function pagination(query: { page?: string; page_size?: string }): { page: number; pageSize: number } {
  const page = Math.max(1, Math.floor(Number(query.page ?? 1) || 1));
  const pageSize = Math.max(10, Math.min(100, Math.floor(Number(query.page_size ?? 20) || 20)));
  return { page, pageSize };
}

function paginationResult(total: number, page: number, pageSize: number) {
  return {
    total,
    page,
    page_size: pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

function financeRow(order: OrderRecord & Record<string, unknown>): OrderRecord & Record<string, unknown> & {
  settlement_eligible: boolean;
  customer_payment_amount: string;
  receipt_amount: string;
  customer_price_refund_amount: string;
  supply_price: string;
  cost_basis_cny: string;
  cost_is_estimate: boolean;
  platform_margin: string;
  platform_settlement_id: string | null;
  platform_settlement_status: string | null;
  platform_payment_reference: string | null;
  platform_settlement_zh: string;
  platform_rebate_standard_usd: string | null;
  platform_rebate_actual_usd: string | null;
  platform_rebate_fee_usd: string | null;
  platform_rebate_usd: string | null;
  platform_rebate_status: string | null;
  platform_rebate_settlement_id: string | null;
  platform_rebate_settled_at: string | null;
  gross_profit: string | null;
  supplier_net_income_cny: string | null;
  rebate_equivalent_cny: string | null;
  platform_total_equivalent_cny: string | null;
  profit_basis: "verified" | "estimated" | "pending" | "not_eligible";
} {
  const eligible = order.status === "paid" && order.delivery_status === "success" && !order.refunded_at;
  const receipt = order.alipay_receipt_amount ?? (order.status === "paid" ? order.amount : "0.00");
  const supply = order.platform_supply_price ?? "0.00";
  const customerPriceRefund = order.customer_price_refund_amount ?? "0.00";
  const actualCost = order.upstream_actual_cost_cny;
  const costBasis = actualCost ?? order.upstream_estimated_cost_cny ?? "0.00";
  const manualOrder = order.order_source === "manual";
  const amounts = calculateFinancialAmounts({customerPayment:order.amount,serviceReceipt:receipt,supplyCost:supply,customerPriceRefund});
  const platformMarginCents = eligible && !manualOrder ? amounts.platformProfitCents : 0;
  const platformMargin = centsToMoney(platformMarginCents);
  let grossProfit: string | null = eligible
    ? manualOrder
      ? centsToMoney(moneyToCents(receipt) - moneyToCents(costBasis))
      : centsToMoney(moneyToCents(supply) - moneyToCents(costBasis))
    : "0.00";
  let netIncome: string | null = eligible ? (manualOrder ? receipt : supply) : "0.00";
  let rebateEquivalent: string | null = eligible ? null : "0.00";
  let platformTotalEquivalent: string | null = null;
  let profitBasis: "verified" | "estimated" | "pending" | "not_eligible" =
    !eligible ? "not_eligible" : actualCost ? "verified" : "estimated";
  // A draft/dispute or a legacy rebate must not silently use the old standard cost as actual profit.
  if (eligible && !isXGiftPlan(order.plan) && (order.cost_review_status || order.platform_rebate_id)) {
    grossProfit = null; netIncome = null; profitBasis = "pending";
    if (order.cost_review_status === "confirmed") {
      const split = calculateCostReconciliation({supplyCny:supply,standardCostCny:order.upstream_estimated_cost_cny ?? "0.00",platformBaseProfitCny:platformMargin,
        standardUsd:String(order.reviewed_standard_usd),actualUsd:String(order.reviewed_actual_usd),
        feesUsd:String(order.reviewed_fees_usd),retainedUsd:String(order.reviewed_retained_usd),
        fxRate:typeof order.reviewed_fx_rate==="string" ? order.reviewed_fx_rate : null});
      const recordedRebateCny = typeof order.verified_rebate_cny === "string"
        ? order.verified_rebate_cny
        : moneyToCents(split.rebate_usd) === 0 ? "0.00" : null;
      // Net CNY settlement is known without FX when there is no USD rebate:
      // it is the order's frozen product supply quote. Gross profit may still use
      // the product-center CNY estimate until a real USD funding rate is recorded.
      if (split.gross_profit_cny !== null) {
        grossProfit = split.gross_profit_cny;
        profitBasis = split.actual_cost_cny !== null ? "verified" : "estimated";
      }
      if (split.supplier_net_income_cny !== null &&
          split.rebate_equivalent_cny === recordedRebateCny) {
        netIncome = split.supplier_net_income_cny;
        rebateEquivalent = split.rebate_equivalent_cny;
        platformTotalEquivalent = split.platform_total_equivalent_cny;
        if (split.actual_cost_cny !== null && split.actual_cost_cny === actualCost && split.gross_profit_cny !== null) {
          profitBasis = "verified";
        }
      }
    }
  }
  // Blue-V's initial zero estimate means "not verified", not free fulfillment.
  // Its CNY supply quote/platform spread remain known; never substitute GPT/USD
  // cost reconciliation for an independently verified X fulfillment cost.
  if (eligible && isXGiftPlan(order.plan) && actualCost == null &&
      moneyToCents(order.upstream_estimated_cost_cny ?? "0.00") === 0) {
    grossProfit = null;
    profitBasis = "pending";
  }
  const paidCny = Math.min(Math.max(0,platformMarginCents), Math.max(0,
    moneyToCents(String(order.settlement_cny_paid || "0.00"))-Number(order.settlement_prior_cny_cents || 0)));
  const platformSettlementStatus = typeof order.platform_settlement_status === "string"
    ? order.platform_settlement_status
    : null;
  const platformSettlementId = typeof order.platform_settlement_id === "string"
    ? order.platform_settlement_id
    : null;
  const platformPaymentReference = typeof order.platform_payment_reference === "string"
    ? order.platform_payment_reference
    : null;
  const stringOrNull = (value: unknown): string | null => typeof value === "string" ? value : null;
  const platformSettlementZh = !eligible || platformMarginCents <= 0
    ? "无需核销"
    : paidCny >= platformMarginCents
      ? "已核销"
      : platformSettlementStatus === "pending" || platformSettlementStatus === "partial"
        ? "待打款"
        : "未生成";
  return {
    ...order,
    status_zh: ({ pending: "待支付", paid: "已支付", expired: "已过期", refunded: "已退款" } as Record<string, string>)[order.status] ?? order.status,
    delivery_zh: ({ success: "履约成功", failed: "履约失败" } as Record<string, string>)[order.delivery_status ?? ""] ?? (order.delivery_status ? order.delivery_status : "未履约"),
    settlement_eligible: eligible,
    customer_payment_amount: order.amount,
    receipt_amount: receipt,
    customer_price_refund_amount: customerPriceRefund,
    supply_price: supply,
    cost_basis_cny: costBasis,
    cost_is_estimate: !actualCost,
    platform_margin: platformMargin,
    platform_settlement_id: platformSettlementId,
    platform_settlement_status: platformSettlementStatus,
    platform_payment_reference: platformPaymentReference,
    platform_settlement_zh: platformSettlementZh,
    platform_rebate_standard_usd: stringOrNull(order.platform_rebate_standard_usd),
    platform_rebate_actual_usd: stringOrNull(order.platform_rebate_actual_usd),
    platform_rebate_fee_usd: stringOrNull(order.platform_rebate_fee_usd),
    platform_rebate_usd: stringOrNull(order.platform_rebate_usd),
    platform_rebate_status: stringOrNull(order.platform_rebate_status),
    platform_rebate_settlement_id: stringOrNull(order.platform_rebate_settlement_id),
    platform_rebate_settled_at: stringOrNull(order.platform_rebate_settled_at),
    gross_profit: grossProfit,
    supplier_net_income_cny: netIncome,
    rebate_equivalent_cny: rebateEquivalent,
    platform_total_equivalent_cny: platformTotalEquivalent,
    profit_basis: profitBasis,
    platform_paid_cny: centsToMoney(paidCny),
  };
}

function mask(value: string): string | null {
  if (!value) return null;
  if (value.length <= 6) return "已配置";
  return `••••${value.slice(-6)}`;
}

function normalizePem(value: string): string {
  return value.replace(/\\n/g, "\n").trim();
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function beijingCsvTime(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Date(date.getTime() + 8 * 60 * 60_000).toISOString().slice(0, 19).replace("T", " ");
}
