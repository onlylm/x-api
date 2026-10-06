/** Shared browser/BFF contract: deliberately contains no SDK, runtime configuration or key values. */
export const BLUEV_ALIPAY_NOTIFY_URL = "https://x.aifu.me/bluev-sandbox/callbacks/alipay";

export interface BluevAlipaySettingsDto {
  revision: number;
  app_id: string;
  seller_id: string;
  has_private_key: boolean;
  has_public_key: boolean;
  notify_url: string;
  updated_at: string;
}

export interface BluevAlipaySaveInput {
  app_id: string;
  seller_id: string;
  private_key: string;
  public_key: string;
  expected_revision: number;
  confirm_apply: true;
}

export const bluevAlipaySettingErrorMessages = {
  bluev_alipay_invalid_request: "收款配置格式不正确，请核对应用 ID、商户 PID 和确认选项。",
  bluev_alipay_revision_conflict: "收款配置已被更新，请刷新配置后重新确认保存。",
  bluev_alipay_keys_required: "更换收款应用或商户时，必须同时填写应用私钥和支付宝公钥。",
  bluev_alipay_invalid_private_key: "应用私钥无效，请填写至少 2048 位的 RSA 私钥。",
  bluev_alipay_invalid_public_key: "支付宝公钥无效，请填写至少 2048 位的 RSA 公钥。",
  bluev_alipay_invalid_config: "收款配置不符合正式环境要求，未修改配置。",
  bluev_alipay_storage_unavailable: "收款配置暂时无法安全读取或保存，请稍后刷新核对。",
  bluev_alipay_binding_mismatch: "原订单的收款身份或订单资料不一致，已停止支付操作。",
  bluev_alipay_binding_missing: "原订单缺少收款身份记录，请人工核查，不能切换身份重试。",
  bluev_alipay_notification_invalid: "付款通知未通过原订单收款身份和签名核验。",
  bluev_alipay_refund_disabled: "此独立测试入口不支持发起退款，请人工核查原单。",
} as const;

export type BluevAlipaySettingErrorCode = keyof typeof bluevAlipaySettingErrorMessages;

export class BluevAlipaySettingsError extends Error {
  readonly httpStatus: number;
  constructor(readonly code: BluevAlipaySettingErrorCode) {
    super(bluevAlipaySettingErrorMessages[code]);
    this.name = "BluevAlipaySettingsError";
    this.httpStatus = code === "bluev_alipay_storage_unavailable" ? 503
      : ["bluev_alipay_revision_conflict", "bluev_alipay_binding_mismatch", "bluev_alipay_binding_missing", "bluev_alipay_refund_disabled"].includes(code) ? 409 : 400;
  }
}
