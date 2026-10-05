const descriptions: Record<string, string> = {
  payment_cards_exhausted: '本轮指定的主卡与备用卡均暂不可用，请管理员处理。系统不会自动充值或重新从主卡开始尝试。',
  payment_card_unverified: '付款卡资料或身份未能确认，已保留原卡等待核对，不会据此自动切换备用卡。',
  card_frozen: '当前付款卡已冻结，请管理员核对原订单和卡状态。',
  card_deleted: '当前付款卡已被卡台标记为删除，请管理员核对原订单。',
  card_cancelled: '当前付款卡已被卡台标记为取消，请管理员核对原订单。',
  card_expired: '当前付款卡已过有效期，请管理员核对原订单。',
  card_balance_insufficient: '当前付款卡余额未达到付款要求，请管理员处理并核对原订单。',
  card_provider_unavailable: '卡台暂时无法访问，卡状态尚未确认。请保留原订单，不会据此自动换卡。',
  card_response_unconfirmed: '卡台响应尚未确认，请管理员核对原订单，不会据此自动换卡。',
  execution_requires_reconciliation: '执行或上游请求出现异常，结果需要核对。请保留原订单，不要重复付款。',
  original_request_unconfirmed: '原账单或支付方式创建请求的结果尚未确认，已停止重复提交，请管理员核对原单。',
  payment_requires_action: '付款需要额外验证（如 3DS），请联系管理员处理。不会自动换卡重复付款。',
  payment_pending: '原付款确认已提交，结果仍待核对。请通过原订单查询，不要再次付款。',
  result_unconfirmed: '付款结果尚未确认，请保留原订单并等待核对，不要重复付款。',
}

export function orderFailureDescription(code: unknown): string | null {
  return typeof code === 'string' && Object.hasOwn(descriptions, code) ? descriptions[code] : null
}
