/**
 * 仅供京东后端使用。Node.js 20+，无第三方依赖；密钥由服务端环境提供。
 * 不在浏览器打包；不自动生成 client_order_id；不调用 activate/refund。
 * import 本模块不会发送请求。调用 createOrder 前必须先持久化购买意图。
 */
export class PartnerApiError extends Error {
  constructor(status, code, detail) {
    super(detail || '蓝V服务请求未完成');
    this.name = 'PartnerApiError';
    this.status = status;
    this.code = code;
  }
}

export function createXPartnerClient({
  baseUrl = process.env.X_PARTNER_BASE_URL || 'https://api.quefa.cn/bluev',
  apiKey = process.env.X_PARTNER_API_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('服务地址必须为不含凭据、查询串和片段的 HTTPS 地址');
  }
  if (typeof apiKey !== 'string' || apiKey.length < 32 || apiKey.startsWith('REPLACE_')) {
    throw new Error('请在服务端配置有效 X_PARTNER_API_KEY');
  }
  const api = base.toString().replace(/\/$/, '') + '/api/v1/checkout';

  async function request(path, body) {
    let response;
    try {
      response = await fetchImpl(api + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'X-API-Key': apiKey, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
        redirect: 'error',
      });
    } catch {
      // 不能确认远端是否已受理。调用方只能保留原编号查询或原样重试。
      throw new PartnerApiError(0, 'request_state_unknown', '请求结果未知，请保留原订单号查询；不要新建订单');
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success !== true) {
      throw new PartnerApiError(response.status, payload?.error || 'invalid_response',
        payload?.detail_zh || '订单状态尚未确认，请核对原单');
    }
    return payload;
  }

  function orderPath(orderId) {
    if (typeof orderId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(orderId)) {
      throw new Error('请使用创建接口返回并已保存的 order_id');
    }
    return '/orders/' + encodeURIComponent(orderId);
  }

  return {
    products: () => request('/products'),
    createOrder(input) {
      if (!input || !['x_premium_3m', 'x_premium_6m'].includes(input.product) || input.quantity !== 1 ||
        typeof input.sell_price !== 'string' || !/^\d+\.\d{2}$/.test(input.sell_price) ||
        typeof input.client_order_id !== 'string' || !input.client_order_id.trim() || input.client_order_id.length > 64 ||
        typeof input.recipient !== 'string' || !/^@?[A-Za-z0-9_]{1,15}$/.test(input.recipient.trim())) {
        throw new Error('商品、数量、金额、业务订单号或 X 用户名格式不正确');
      }
      const { product, quantity, sell_price, client_order_id, recipient } = input;
      return request('/orders', { product, quantity, sell_price, client_order_id, recipient });
    },
    order: orderId => request(orderPath(orderId)),
    activation: orderId => request(orderPath(orderId) + '/activation'),
  };
}

/**
 * 用法（在京东后端业务代码中；值需替换，不能直接拿陌生用户进行真实支付）：
 *
 * const client = createXPartnerClient();
 * const catalog = await client.products();
 * // 先在京东数据库保存 intent；重试必须从数据库取同一份 intent。
 * const intent = {
 *   product: 'x_premium_3m', quantity: 1, sell_price: '30.00',
 *   client_order_id: 'JD-X-REPLACE-WITH-UNIQUE-ID', recipient: '@example_user',
 * };
 * const created = await client.createOrder(intent);
 * // 保存 created.order_id，然后只向该订单所有者返回 qr_image_url 等必要字段。
 * const payment = await client.order(created.order_id);
 * const delivery = await client.activation(created.order_id);
 * const delivered = payment.status === 'paid' && delivery.items.some(
 *   task => task.status === 'success' && task.finished === true,
 * );
 * // paid但items为空或requires_review时继续查询原单，不调用activate、不新建订单。
 */
