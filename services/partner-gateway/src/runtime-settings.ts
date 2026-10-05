import type { AppConfig } from "./config.js";
import { AppDatabase } from "./database.js";
import { decryptValue, encryptValue } from "./security.js";

export const settingKeys = {
  paymentMode: "payment_mode",
  alipayAppId: "alipay_app_id",
  alipayPrivateKey: "alipay_private_key",
  alipayPublicKey: "alipay_public_key",
  alipaySellerId: "alipay_seller_id",
  zovoMode: "zovo_mode",
  zovoAppId: "zovo_app_id",
  zovoApiKey: "zovo_api_key",
} as const;

export class RuntimeSettings {
  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
  ) {}

  get(key: string, fallback = ""): string {
    const stored = this.db.getSetting(key);
    if (!stored) return fallback;
    return decryptValue(stored, this.config.sessionEncryptionKey, `setting:${key}`);
  }

  set(key: string, value: string, isSecret = true): void {
    this.db.setSetting(
      key,
      encryptValue(value, this.config.sessionEncryptionKey, `setting:${key}`),
      isSecret,
    );
  }

  has(key: string, fallback = ""): boolean {
    return this.get(key, fallback).trim().length > 0;
  }

  paymentMode(): "mock" | "alipay" {
    return this.get(settingKeys.paymentMode, this.config.paymentProvider) === "alipay" ? "alipay" : "mock";
  }

  zovoMode(): "mock" | "live" {
    return this.get(settingKeys.zovoMode, this.config.zovo.mode) === "live" ? "live" : "mock";
  }

  alipayConfig(): AppConfig["alipay"] {
    return {
      ...this.config.alipay,
      appId: this.get(settingKeys.alipayAppId, this.config.alipay.appId),
      privateKey: this.get(settingKeys.alipayPrivateKey, this.config.alipay.privateKey),
      publicKey: this.get(settingKeys.alipayPublicKey, this.config.alipay.publicKey),
      sellerId: this.get(settingKeys.alipaySellerId, this.config.alipay.sellerId),
      notifyUrl: `${this.config.publicBaseUrl.replace(/\/$/, "")}/callbacks/alipay`,
    };
  }

  zovoConfig(): AppConfig["zovo"] {
    return {
      ...this.config.zovo,
      mode: this.zovoMode(),
      appId: this.get(settingKeys.zovoAppId, this.config.zovo.appId),
      apiKey: this.get(settingKeys.zovoApiKey, this.config.zovo.apiKey),
    };
  }

  readiness(): { alipay: boolean; zovo: boolean; readyForSales: boolean } {
    const alipay = this.alipayConfig();
    const alipayReady = Boolean(alipay.appId && alipay.privateKey && alipay.publicKey && alipay.sellerId);
    const zovoReady = Boolean(this.zovoConfig().apiKey);
    return {
      alipay: alipayReady,
      zovo: zovoReady,
      readyForSales: this.paymentMode() === "alipay" && this.zovoMode() === "live" && alipayReady && zovoReady,
    };
  }
}
