const descriptions: Record<string, string> = {
  manual_payment_approval_required: '本单银行卡支付方式已准备，尚未提交扣款。请由管理员在订单详情核对后确认付款。',
  manual_payment_approved: '管理员已授权本单付款，等待队列继续提交；请勿重复付款。',
  manual_payment_approval_expired: '人工付款授权已过期，尚未提交扣款。请刷新订单详情，重新核对并确认。',
  x_query_failed: 'X 账号或赠送查询未完成，请核对原单。若尚未创建付款页面，可由管理员尝试安全关闭。',
  cancelled_before_execution: '管理员在创建付款页面前关闭了订单，冻结点数已释放；卡密兑换记录继续保留。',
  cancelled_by_admin: '管理员已关闭订单，冻结点数已释放。',
  cancelled_unconfirmed_creation: '管理员已确认风险并终止本地订单，冻结点数已释放，系统不会再提交本单付款。X 端可能创建的账单未被撤销，请勿另行支付该历史账单。',
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
