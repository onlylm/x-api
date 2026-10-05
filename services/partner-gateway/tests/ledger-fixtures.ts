import type { AppConfig } from "../src/config.js";
export function ledgerTestConfig(databasePath:string):AppConfig {
  return {nodeEnv:"test",host:"127.0.0.1",port:3197,publicBaseUrl:"http://127.0.0.1:3197",databasePath,
    trustProxy:false,platformApiKey:"local-ledger-platform",platformAllowedIps:new Set(["127.0.0.1"]),
    platformWebhookUrl:"http://127.0.0.1:3999/disabled",platformWebhookSecret:"local-only-webhook",
    adminToken:"local-ledger-preview",sessionEncryptionKey:Buffer.alloc(32,9),emailHmacKey:"local-hmac",
    products:[{product:"chatgpt_pro_5x_1m",name_zh:"Pro 5x",name:"Pro 5x",plan:"pro_5x",cost_price:"638.00",
      max_sell_price:"999.00",currency:"CNY",max_qty:1,enabled:true,internal_cost_cny:"637.00"},
      {product:"chatgpt_plus_1m",name_zh:"Plus",name:"Plus",plan:"plus",cost_price:"110.00",
      max_sell_price:"199.00",currency:"CNY",max_qty:1,enabled:true,internal_cost_cny:"108.00"}],
    paymentProvider:"mock",alipay:{appId:"",privateKey:"",publicKey:"",sellerId:"",gateway:"",notifyUrl:"",returnUrl:""},
    zovo:{mode:"mock",baseUrl:"https://invalid.example",appId:"",apiKey:"",timeoutMs:1000},
    xApi:{mode:"disabled",baseUrl:"https://x.aifu.me",partnerId:"",keyId:"",secret:"",timeoutMs:1000},
    activationPollIntervalMs:3000,webhookPollIntervalMs:5000};
}
