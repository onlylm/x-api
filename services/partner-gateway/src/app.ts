import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import formbody from "@fastify/formbody";
import { z, ZodError } from "zod";
import type { AppConfig } from "./config.js";
import { AppDatabase } from "./database.js";
import type { PaymentClient } from "./clients/payment.js";
import type { ZovoClient } from "./clients/zovo.js";
import type { XApiClient } from "./clients/x-api.js";
import { secureEqual } from "./security.js";
import { RuntimeSettings } from "./runtime-settings.js";
import { RuntimePaymentClient, RuntimeZovoClient } from "./runtime-clients.js";
import { createXApiClient } from "./clients/x-api.js";
import { adminGuard, registerAdminRoutes } from "./admin-routes.js";
import { OrderService, BusinessError } from "./services/order-service.js";
import { ActivationService, inspectSession } from "./services/activation-service.js";
import { ActivationWorker } from "./services/activation-worker.js";
import { gateWorkerStartup } from "./services/worker-startup-gate.js";
import { PlatformWebhookWorker } from "./services/platform-webhook.js";
import { RefundService } from "./services/refund-service.js";
import { DailySettlementWorker } from "./services/daily-settlement-worker.js";
import { XPaymentReconciler } from "./services/x-payment-reconciler.js";
import { registerLedgerRoutes } from "./ledger-routes.js";
import { LedgerError } from "./services/financial-ledger.js";
import { FinancialAmountError } from "./domain.js";
import { isXGiftPlan } from "./domain.js";
import { qrImageUrl, renderQrPng, verifyQrImageToken } from "./qr-image.js";

const createOrderSchema = z.object({
  product: z.string().min(1).max(64),
  quantity: z.literal(1),
  sell_price: z.string().regex(/^\d+\.\d{2}$/),
  client_order_id: z.string().min(1).max(64),
  recipient: z.string().trim().min(1).max(16).optional(),
});

const activateSchema = z.object({
  session_data: z.unknown(),
  confirm_duplicate: z.boolean().optional().default(false),
});

const adminTestOrderSchema = z.object({
  product: z.string().min(1).max(64),
  sell_price: z.string().regex(/^\d+\.\d{2}$/),
});
const adminManualOrderSchema = z.object({
  product: z.string().min(1).max(64),
  sell_price: z.string().regex(/^\d+\.\d{2}$/),
  collection_method: z.literal("cash"),
  received_at: z.string().datetime(),
  payment_reference: z.string().trim().min(3).max(120),
  customer_ref: z.string().trim().min(2).max(120),
  note: z.string().trim().max(500).default(""),
});

const refundRequestSchema = z.object({
  refund_id: z.string().trim().min(1, "退款请求号不能为空").max(64, "退款请求号不能超过 64 个字符"),
  reason: z.string().trim().max(500, "退款原因不能超过 500 个字符"),
});

export interface BuildAppOptions {
  db?: AppDatabase;
  payment?: PaymentClient;
  zovo?: ZovoClient;
  xApi?: XApiClient;
  startWorkers?: boolean;
}

export async function buildApp(config: AppConfig, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: config.trustProxy,
    logger: {
      level: config.nodeEnv === "test" ? "silent" : "info",
      redact: {
        paths: [
          "req.headers.x-api-key",
          "req.headers.x-admin-token",
          "req.headers.authorization",
          "req.headers.x-activation-token",
          "body.session_data",
          "body.credential",
          "body.recipient",
          "headers.x-api-key",
          "headers.x-activation-token",
        ],
        censor: "[REDACTED]",
      },
    },
    bodyLimit: 256 * 1024,
  });
  await app.register(formbody);

  const db = options.db ?? new AppDatabase(config.databasePath);
  db.seedProducts(config.products);
  const settings = new RuntimeSettings(config, db);
  const payment = options.payment ?? new RuntimePaymentClient(config, settings);
  const zovo = options.zovo ?? new RuntimeZovoClient(settings);
  const xApi = options.xApi ?? createXApiClient(config);
  const orders = new OrderService(db, payment, zovo, xApi, {
    encryptionKey: config.sessionEncryptionKey,
    hmacKey: config.emailHmacKey,
  }, config.partnerSalesGateFile);
  const refunds = new RefundService(db, payment);
  const activations = new ActivationService(config, db);
  const paymentReconciler = new XPaymentReconciler(db, payment, activations, app.log);
  const activationWorker = new ActivationWorker(config, db, zovo, app.log, xApi);
  const webhookWorker = new PlatformWebhookWorker(config, db, app.log);
  const dailySettlementWorker = new DailySettlementWorker(db, app.log);
  registerAdminRoutes(app, config, db, settings, refunds);
  registerLedgerRoutes(app, config, db, zovo);

  const ensureAutomaticFulfillment = (orderId: string): void => {
    try {
      const activation = activations.createForPaidOrder(orderId);
      if (activation) {
        app.log.info({ orderId, activationId: activation.id, taskId: activation.task_id },
          "paid x gift order queued for automatic fulfillment");
      }
    } catch (error) {
      db.recordOrderAudit({
        orderId,
        action: "automatic_fulfillment_enqueue_failed",
        fromStatus: "payment:paid",
        toStatus: "delivery:pending",
        operator: "system",
        reason: error instanceof Error ? error.message : "unknown_enqueue_error",
      });
      app.log.error({ orderId }, "paid x gift order could not be queued automatically");
    }
  };

  app.get("/admin/api/test/orders", { preHandler: adminGuard(config) }, async () => ({
    success: true,
    items: db.listPaidTestOrders().map((order) => ({
      order_id: order.order_id,
      client_order_id: order.client_order_id,
      product: order.product,
      status: order.status,
      amount: order.amount,
      paid_at: order.paid_at,
      delivery_status: order.delivery_status,
    })),
  }));

  app.post("/admin/api/test/orders", { preHandler: adminGuard(config) }, async (request) => {
    const input = adminTestOrderSchema.parse(request.body);
    const result = await orders.createOrder({
      product: input.product,
      quantity: 1,
      sellPrice: input.sell_price,
      clientOrderId: `ADMINTEST-${Date.now()}-${randomBytes(4).toString("hex")}`,
    });
    return {
      success: true,
      order_id: result.order.order_id,
      client_order_id: result.order.client_order_id,
      status: result.order.status,
      amount: result.order.amount,
      qr: result.order.qr,
      qr_image_url: qrImageUrl(config.publicBaseUrl, config.sessionEncryptionKey, result.order.order_id, result.order.qr),
      expires_at: result.order.expires_at,
    };
  });

  app.post("/admin/api/manual-orders", { preHandler: adminGuard(config) }, async (request, reply) => {
    const input = adminManualOrderSchema.parse(request.body);
    const order = await orders.createManualCashOrder({
      product: input.product,
      sellPrice: input.sell_price,
      clientOrderId: `MANUAL-${Date.now()}-${randomBytes(4).toString("hex")}`,
      customerRef: input.customer_ref,
      note: input.note,
      paidAt: input.received_at,
      paymentReference: input.payment_reference,
    });
    return reply.code(201).send({
      success: true,
      order_id: order.order_id,
      client_order_id: order.client_order_id,
      status: order.status,
      amount: order.amount,
      product: order.product,
      customer_ref: order.manual_customer_ref,
      payment_channel: order.payment_channel,
      payment_reference: order.manual_payment_reference,
      paid_at: order.paid_at,
    });
  });

  app.get<{ Params: { orderId: string } }>(
    "/admin/api/test/orders/:orderId",
    { preHandler: adminGuard(config) },
    async (request) => {
      const order = orders.getOrder(request.params.orderId);
      return {
        success: true,
        order_id: order.order_id,
        client_order_id: order.client_order_id,
        product: order.product,
        status: order.status,
        amount: order.amount,
        qr: order.qr,
        qr_image_url: qrImageUrl(config.publicBaseUrl, config.sessionEncryptionKey, order.order_id, order.qr),
        expires_at: order.expires_at,
        paid_at: order.paid_at,
        delivery_status: order.delivery_status,
        activation: activations.list(order.order_id),
      };
    },
  );

  app.post<{ Params: { orderId: string } }>(
    "/admin/api/test/orders/:orderId/refresh-payment",
    { preHandler: adminGuard(config) },
    async (request) => {
      const order = orders.getOrder(request.params.orderId);
      if (order.status === "paid") {
        ensureAutomaticFulfillment(order.order_id);
        return { success: true, status: order.status, paid_at: order.paid_at };
      }
      if (order.status !== "pending") return { success: true, status: order.status, paid_at: order.paid_at };
      const confirmation = await payment.queryPayment(order);
      if (confirmation.paid) {
        db.markOrderPaid(order.order_id, confirmation.paidAt, confirmation.tradeNo, confirmation.receiptAmount);
        ensureAutomaticFulfillment(order.order_id);
      }
      const current = orders.getOrder(order.order_id);
      return { success: true, status: current.status, paid_at: current.paid_at };
    },
  );

  app.post<{ Params: { orderId: string } }>(
    "/admin/api/orders/:orderId/refresh-payment",
    { preHandler: adminGuard(config) },
    async (request) => {
      const order = orders.getOrder(request.params.orderId);
      if (order.status === "paid") {
        ensureAutomaticFulfillment(order.order_id);
        return { success: true, status: order.status, paid_at: order.paid_at };
      }
      if (order.status === "refunded") {
        return { success: true, status: order.status, paid_at: order.paid_at };
      }
      if (order.status !== "pending") {
        return { success: true, status: order.status, paid_at: order.paid_at };
      }
      const confirmation = await payment.queryPayment(order);
      if (confirmation.paid) {
        db.markOrderPaid(order.order_id, confirmation.paidAt, confirmation.tradeNo, confirmation.receiptAmount);
        ensureAutomaticFulfillment(order.order_id);
      }
      const current = orders.getOrder(order.order_id);
      return { success: true, status: current.status, paid_at: current.paid_at };
    },
  );

  app.post<{ Params: { orderId: string } }>(
    "/admin/api/test/orders/:orderId/inspect-session",
    { preHandler: adminGuard(config) },
    async (request) => {
      const order = orders.getOrder(request.params.orderId);
      if (order.status !== "paid") throw new BusinessError(409, "order_not_paid", "订单尚未确认到账");
      const input = activateSchema.parse(request.body);
      return { success: true, ...inspectSession(input.session_data) };
    },
  );

  app.post<{ Params: { orderId: string } }>(
    "/admin/api/test/orders/:orderId/activate",
    { preHandler: adminGuard(config) },
    async (request) => {
      const input = activateSchema.parse(request.body);
      const activation = activations.create(request.params.orderId, input.session_data);
      return {
        success: true,
        order_id: activation.order_id,
        activation_id: activation.activation_id,
        task_id: activation.task_id,
        status: activation.status,
        finished: Boolean(activation.finished),
        message_zh: activation.message_zh,
      };
    },
  );

  app.post<{ Params: { orderId: string } }>(
    "/admin/api/manual-orders/:orderId/inspect-session",
    { preHandler: adminGuard(config) },
    async (request) => {
      const order = orders.getOrder(request.params.orderId);
      if (order.order_source !== "manual") throw new BusinessError(409, "not_manual_order", "该订单不是人工补录订单");
      if (order.status !== "paid") throw new BusinessError(409, "order_not_paid", "订单尚未确认收款");
      const input = activateSchema.parse(request.body);
      return { success: true, ...inspectSession(input.session_data) };
    },
  );

  app.post<{ Params: { orderId: string } }>(
    "/admin/api/manual-orders/:orderId/activate",
    { preHandler: adminGuard(config) },
    async (request) => {
      const order = orders.getOrder(request.params.orderId);
      if (order.order_source !== "manual") throw new BusinessError(409, "not_manual_order", "该订单不是人工补录订单");
      if (order.status !== "paid") throw new BusinessError(409, "order_not_paid", "订单尚未确认收款");
      const input = activateSchema.parse(request.body);
      const activation = activations.create(order.order_id, input.session_data);
      return {
        success: true,
        order_id: activation.order_id,
        activation_id: activation.activation_id,
        task_id: activation.task_id,
        status: activation.status,
        finished: Boolean(activation.finished),
        message_zh: activation.message_zh,
      };
    },
  );

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/v1/checkout")) return;
    const supplied = headerValue(request.headers["x-api-key"]);
    if (!supplied || !secureEqual(supplied, config.platformApiKey)) {
      return reply.code(401).send({ success: false, error: "invalid_api_key", detail_zh: "API Key 无效" });
    }
    const ip = normalizeIp(request.ip);
    if (config.platformAllowedIps.size > 0 && !config.platformAllowedIps.has(ip)) {
      return reply.code(403).send({ success: false, error: "ip_not_allowed", detail_zh: "来源 IP 不在白名单" });
    }
  });

  app.get("/health", async () => ({ success: true, service: "merchant-gateway" }));

  // 平台页面无需携带 API Key 即可展示二维码，但地址带有订单专属签名，
  // 防止仅凭订单号读取其他订单的付款二维码。
  app.get<{ Params: { orderId: string }; Querystring: { token?: string } }>(
    "/payment-qr/:orderId.png",
    async (request, reply) => {
      const order = db.getOrder(request.params.orderId);
      if (
        !order ||
        !verifyQrImageToken(
          config.sessionEncryptionKey,
          order.order_id,
          order.qr,
          request.query.token,
        )
      ) {
        return reply.code(404).type("text/plain").send("Not Found");
      }
      const png = await renderQrPng(order.qr);
      return reply
        .type("image/png")
        .header("Cache-Control", "private, no-store")
        .send(png);
    },
  );

  app.get("/api/v1/checkout/products", async () => {
    const products = await orders.getProducts();
    return {
      success: true,
      items: products.map(({ plan, enabled: _enabled, internal_cost_cny: _internalCost,
        payment_country: _paymentCountry, payment_currency: _paymentCurrency, ...product }) => ({
          ...product,
          fulfillment_type: isXGiftPlan(plan) ? "x_gift" : "chatgpt_session",
          required_input: isXGiftPlan(plan) ? {
            field: "recipient",
            type: "x_username",
            label_zh: "X 用户名",
            placeholder: "@username",
            timing: "before_payment",
          } : {
            field: "session_data",
            type: "chatgpt_session",
            label_zh: "ChatGPT Session",
            timing: "after_payment",
          },
          automatic_fulfillment: isXGiftPlan(plan),
        })),
    };
  });

  app.post("/api/v1/checkout/orders", async (request) => {
    const input = createOrderSchema.parse(request.body);
    const result = await orders.createOrder({
      product: input.product,
      quantity: input.quantity,
      sellPrice: input.sell_price,
      clientOrderId: input.client_order_id,
      recipient: input.recipient,
    });
    return {
      success: true,
      order_id: result.order.order_id,
      client_order_id: result.order.client_order_id,
      status: result.order.status,
      amount: result.order.amount,
      qr: result.order.qr,
      qr_image_url: qrImageUrl(config.publicBaseUrl, config.sessionEncryptionKey, result.order.order_id, result.order.qr),
      expires_at: result.order.expires_at,
      ...(result.order.fulfillment_recipient_masked
        ? { recipient: result.order.fulfillment_recipient_masked }
        : {}),
      idempotent: result.idempotent,
    };
  });

  app.get<{ Params: { orderId: string } }>("/api/v1/checkout/orders/:orderId", async (request) => {
    const order = orders.getOrder(request.params.orderId);
    const refund = db.getRefundByOrderId(order.order_id);
    return {
      success: true,
      order_id: order.order_id,
      client_order_id: order.client_order_id,
      status: order.status,
      amount: order.amount,
      expires_at: order.expires_at,
      ...(order.paid_at ? { paid_at: order.paid_at } : {}),
      ...(order.delivery_status ? { delivery_status: order.delivery_status } : {}),
      ...(order.fulfillment_recipient_masked ? { recipient: order.fulfillment_recipient_masked } : {}),
      ...(refund
        ? {
            refund: {
              refund_id: refund.refund_id,
              client_refund_id: refund.client_refund_id,
              status: refund.status,
              amount: refund.amount,
              refunded_at: refund.refunded_at,
              detail_zh: refund.failure_message,
            },
          }
        : {}),
    };
  });

  app.post<{ Params: { orderId: string } }>(
    "/api/v1/checkout/orders/:orderId/refund",
    async (request) => {
      const input = refundRequestSchema.parse(request.body);
      const result = await refunds.request({
        orderId: request.params.orderId,
        clientRefundId: input.refund_id,
        reason: input.reason,
        requestedBy: "platform",
      });
      return {
        success: true,
        order_id: result.refund.order_id,
        refund_status: result.refund.status === "succeeded" ? "refunded" : "pending",
      };
    },
  );

  app.get<{ Params: { orderId: string }; Querystring: { refresh?: string } }>(
    "/api/v1/checkout/orders/:orderId/refund",
    async (request, reply) => {
      const refund = await refunds.get(request.params.orderId, request.query.refresh === "1");
      if (["requested", "processing"].includes(refund.status)) reply.code(202);
      return { success: true, ...publicRefund(refund) };
    },
  );

  app.post<{ Params: { orderId: string } }>(
    "/api/v1/checkout/orders/:orderId/activate",
    async (request) => {
      const input = activateSchema.parse(request.body);
      const activation = activations.create(request.params.orderId, input.session_data);
      return {
        success: true,
        order_id: activation.order_id,
        activation_id: activation.activation_id,
        task_id: activation.task_id,
        status: activation.status,
        finished: Boolean(activation.finished),
        message_zh: activation.message_zh,
      };
    },
  );

  app.get<{ Params: { orderId: string } }>(
    "/api/v1/checkout/orders/:orderId/activation",
    async (request) => ({
      success: true,
      order_id: request.params.orderId,
      ...activations.list(request.params.orderId),
    }),
  );

  app.post("/callbacks/alipay", async (request, reply) => {
    const payload = normalizeStringRecord(request.body);
    try {
      const orderId = payload.out_trade_no || "";
      const order = db.getOrder(orderId);
      if (!order) return reply.type("text/plain").code(400).send("failure");
      const confirmation = await payment.verifyNotification(payload, order);
      if (confirmation.paid) {
        db.markOrderPaid(orderId, confirmation.paidAt, confirmation.tradeNo, confirmation.receiptAmount);
        ensureAutomaticFulfillment(orderId);
      }
      return reply.type("text/plain").send("success");
    } catch {
      // 不把验签细节返回给调用方，返回 failure 让支付宝稍后重推。
      return reply.type("text/plain").code(400).send("failure");
    }
  });

  if (config.nodeEnv !== "production") {
    app.get<{ Params: { orderId: string } }>("/dev/pay/:orderId", async (request, reply) => {
      if (payment instanceof RuntimePaymentClient && !payment.isMock()) return reply.code(404).send("Not Found");
      const order = orders.getOrder(request.params.orderId);
      return reply.type("text/html; charset=utf-8").send(`<!doctype html>
        <html lang="zh-CN"><meta charset="utf-8"><title>模拟支付宝</title>
        <body><h1>模拟支付宝付款</h1><p>订单：${escapeHtml(order.order_id)}</p>
        <p>金额：¥${escapeHtml(order.amount)}</p>
        <form method="post"><button type="submit">模拟付款成功</button></form></body></html>`);
    });
    app.post<{ Params: { orderId: string } }>("/dev/pay/:orderId", async (request, reply) => {
      if (payment instanceof RuntimePaymentClient && !payment.isMock()) return reply.code(404).send("Not Found");
      orders.getOrder(request.params.orderId);
      db.markOrderPaid(request.params.orderId, new Date().toISOString(), `MOCK-${Date.now()}`);
      ensureAutomaticFulfillment(request.params.orderId);
      return reply.type("text/html; charset=utf-8").send("付款状态已更新，可以返回平台。");
    });
  }

  app.post("/internal/webhooks/test", { preHandler: adminGuard(config) }, async () => {
    const id = `TEST-${Date.now()}`;
    db.enqueueWebhook(
      `${id}:webhook.test`,
      "webhook.test",
      { event: "webhook.test", order_id: id, test: true },
      new Date().toISOString(),
    );
    return { success: true, delivery_queued: true };
  });

  app.get<{ Querystring: { from?: string; to?: string } }>(
    "/internal/reports/orders.csv",
    { preHandler: adminGuard(config) },
    async (request, reply) => {
      const from = parseIso(request.query.from, new Date(Date.now() - 30 * 86_400_000).toISOString());
      const to = parseIso(request.query.to, new Date().toISOString());
      const rows = db.listOrdersForReport(from, to);
      const header = [
        "client_order_id",
        "order_id",
        "product",
        "amount",
        "payment_status",
        "delivery_status",
        "paid_at",
        "refunded_at",
        "created_at",
      ];
      const csv = [
        header.join(","),
        ...rows.map((row) =>
          [
            row.client_order_id,
            row.order_id,
            row.product,
            row.amount,
            row.status,
            row.delivery_status ?? "",
            row.paid_at ?? "",
            row.refunded_at ?? "",
            row.created_at,
          ]
            .map(csvCell)
            .join(","),
        ),
      ].join("\r\n");
      return reply.type("text/csv; charset=utf-8").send(`\uFEFF${csv}`);
    },
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof FinancialAmountError) {
      if (request.url.startsWith("/admin/")) return reply.code(409).send({success:false,detail_zh:error.message});
      app.log.warn({code:error.code,requestId:request.id},"financial amount requires review");
      return reply.code(500).send({success:false,error:"internal_error",detail_zh:"订单暂无法处理，请联系客服核查"});
    }
    if (error instanceof LedgerError) return reply.code(409).send({success:false,detail_zh:error.message});
    if (error instanceof BusinessError) {
      return reply.code(error.httpStatus).send({
        success: false,
        error: error.code,
        detail_zh: error.message,
      });
    }
    if (error instanceof ZodError) {
      const invalidQuantity = request.routeOptions.url === "/api/v1/checkout/orders" &&
        error.issues.some(issue => issue.path[0] === "quantity");
      return reply.code(422).send({
        success: false,
        error: invalidQuantity ? "invalid_quantity" : "invalid_argument",
        detail_zh: invalidQuantity ? "数量目前只能为 1" : error.issues[0]?.message || "请求参数不合法",
      });
    }
    const parserErrors: Record<string, number> = {
      FST_ERR_CTP_INVALID_JSON_BODY: 400, FST_ERR_CTP_EMPTY_JSON_BODY: 400,
      FST_ERR_CTP_BODY_TOO_LARGE: 413, FST_ERR_CTP_INVALID_MEDIA_TYPE: 415,
    };
    const parserStatus = parserErrors[(error as {code?: string}).code ?? ""];
    if (parserStatus) return reply.code(parserStatus).send({
      success: false, error: "invalid_argument", detail_zh: "请求正文格式或大小不合法",
    });
    app.log.error({ err: error }, "unhandled request error");
    return reply.code(500).send({ success: false, error: "internal_error", detail_zh: "服务暂时不可用" });
  });

  const stopWorkerGate = options.startWorkers !== false ? gateWorkerStartup(() => {
    paymentReconciler.start();
    activationWorker.start();
    webhookWorker.start();
    dailySettlementWorker.start();
  }) : () => {};
  app.addHook("onClose", async () => {
    stopWorkerGate();
    await paymentReconciler.stop();
    await activationWorker.stop();
    webhookWorker.stop();
    dailySettlementWorker.stop();
    db.close();
  });
  return app;
}

function headerValue(value: unknown): string {
  return Array.isArray(value) ? String(value[0] ?? "") : typeof value === "string" ? value : "";
}

function normalizeIp(value: string): string {
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

function parseIso(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new BusinessError(422, "invalid_argument", "时间格式无效");
  return date.toISOString();
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function publicRefund(refund: import("./domain.js").RefundRecord) {
  return {
    refund_id: refund.refund_id,
    order_id: refund.order_id,
    client_refund_id: refund.client_refund_id,
    status: refund.status,
    amount: refund.amount,
    refunded_at: refund.refunded_at,
    ...(refund.failure_code ? { failure_code: refund.failure_code } : {}),
    ...(refund.failure_message ? { detail_zh: refund.failure_message } : {}),
    created_at: refund.created_at,
    updated_at: refund.updated_at,
  };
}
