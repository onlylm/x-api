/** Fixed UI/server copy only. No provider messages, credentials or SDK imports. */
export const bluevPaymentErrorMessages = {
  bluev_payment_timeout: "支付宝请求超时，结果尚未确认；请查询原单，不要重复付款。",
  bluev_payment_network: "支付宝连接异常，结果尚未确认；请查询原单。",
  bluev_payment_signature_unverified: "支付宝响应未通过验签，暂不能确认结果；请检查支付宝公钥和应用配置。",
  bluev_payment_provider_rejected: "支付宝已返回业务拒绝；请检查当面付配置后，再明确操作原单。",
  bluev_payment_provider_permission: "支付宝已拒绝当前应用的接口权限；请确认应用已开通当面付并完成授权。",
  bluev_payment_missing_qr: "支付宝未返回付款码；保留原单，请先核查原单状态。",
  bluev_payment_invalid_qr: "支付宝付款码地址不符合安全要求，已停止展示；请核查原单。",
  bluev_payment_order_mismatch: "支付宝响应订单号与原单不一致，已停止处理；请人工核查。",
  bluev_payment_amount_mismatch: "支付宝响应金额与原单不一致，已停止处理；请人工核查。",
  bluev_payment_local_config: "支付宝本地配置不完整或密钥无效；请检查应用与 RSA2 密钥配置。",
  bluev_payment_expired: "原单付款窗口已到期；如需继续，请明确确认原单续期，不会自动续期或重新下单。",
  bluev_payment_invalid_expiry: "原单付款有效期无效，已停止请求付款码；请核查原单。",
  bluev_payment_unknown: "支付宝处理结果尚未确认；请保留原单查询，不要重复付款或赠送。",
  payment_result_unknown: "付款结果尚未确认；请保留原单核查，不要重复付款或赠送。",
  retry_not_allowed: "原单当前不满足重取付款码条件；请先查询原单状态。",
  retry_busy: "原单正在处理，请稍后查询状态，不要重复提交。",
  renewal_required: "原单付款窗口已到期；继续前需明确确认原单续期。",
  retry_conflict: "原单状态已变化；请刷新原单后再确认操作。",
  retry_recipient_changed: "接收账号或原单资料不一致，已停止处理；请核查原单。",
  retry_fulfillment_unavailable: "赠送服务暂不可用，未请求新的付款码；请稍后核查。",
  sales_paused: "当前已暂停接单，未请求新的付款码；原单仍会继续核查。",
} as const;

export type BluevPaymentErrorCode = keyof typeof bluevPaymentErrorMessages;

/** Never retain the raw SDK error, its cause or provider response. */
export class BluevPaymentError extends Error {
  constructor(readonly code: BluevPaymentErrorCode) {
    super(bluevPaymentErrorMessages[code]);
    this.name = "BluevPaymentError";
  }
}

export function describeBluevPaymentError(error: unknown): { code: BluevPaymentErrorCode; message: string } {
  const code = error instanceof BluevPaymentError && Object.hasOwn(bluevPaymentErrorMessages, error.code)
    ? error.code : "bluev_payment_unknown";
  return { code, message: bluevPaymentErrorMessages[code] };
}
