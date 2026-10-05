import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { AppDatabase } from "../src/database.js";
import { MockPaymentClient } from "../src/clients/payment.js";
import { MockZovoClient } from "../src/clients/zovo.js";
import { MockXApiClient } from "../src/clients/x-api.js";
import { RuntimeSettings, settingKeys } from "../src/runtime-settings.js";

describe("后台启用蓝V商品保护",()=>{
  let directory:string,config:AppConfig,db:AppDatabase,app:Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async()=>{
    directory=mkdtempSync(join(tmpdir(),"x-gift-enable-"));
    config=loadConfig({NODE_ENV:"test",DATABASE_PATH:join(directory,"test.sqlite"),
      SESSION_ENCRYPTION_KEY:Buffer.alloc(32,11).toString("base64")});
    config.nodeEnv="production";
    config.paymentProvider="alipay";
    config.alipay={...config.alipay,appId:"test-app",sellerId:"test-seller",
      privateKey:"test-private-key",publicKey:"test-public-key"};
    config.zovo={...config.zovo,mode:"mock",apiKey:""};
    config.xApi={mode:"live",baseUrl:"https://x.aifu.me",partnerId:"usr_"+"a".repeat(32),
      keyId:"key_"+"b".repeat(32),secret:"c".repeat(40),timeoutMs:1000};
    config.products=[{product:"x_premium_3m",name_zh:"X Premium 3个月",name:"X Premium 3 Months",
      plan:"x_premium_3m",internal_cost_cny:"20.00",cost_price:"30.00",max_sell_price:"35.00",
      currency:"CNY",max_qty:1,enabled:false}];
    db=new AppDatabase(config.databasePath);
    app=await buildApp(config,{db,payment:new MockPaymentClient(config.publicBaseUrl),
      zovo:new MockZovoClient(),xApi:new MockXApiClient(),startWorkers:false});
  });
  afterEach(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const productCode="x_premium_3m";
  function enable(enabled=true) {
    return app.inject({method:"PUT",url:"/admin/api/products/"+productCode,
      headers:{"x-admin-token":config.adminToken},payload:{internal_cost_cny:"20.00",cost_price:"30.00",enabled}});
  }
  it("正式支付宝与有效X配置即可启用，无需Zovo可用",async()=>{
    expect((await enable()).statusCode).toBe(200);
    expect(db.listProducts()[0].enabled).toBe(true);
  });
  it.each(["disabled","mock"] as const)("生产环境拒绝X %s模式",async mode=>{
    config.xApi.mode=mode;
    const result=await enable();
    expect(result.statusCode).toBe(409);expect(result.json().error).toBe("x_gift_not_configured");
    expect(db.listProducts()[0].enabled).toBe(false);
  });
  it.each([
    ["baseUrl","http://x.aifu.me"], ["baseUrl","https://user:secret@x.aifu.me"],
    ["baseUrl","https://x.aifu.me?key=unsafe"], ["baseUrl","https://x.aifu.me#unsafe"],
    ["partnerId","not-a-partner"], ["keyId","not-a-key"], ["secret","too-short"],
  ] as const)("拒绝无效%s配置",async(field,value)=>{
    config.xApi[field]=value;
    const result=await enable();
    expect(result.statusCode).toBe(409);expect(result.json().error).toBe("x_gift_not_configured");
    expect(db.listProducts()[0].enabled).toBe(false);
    expect(result.body).not.toContain("unsafe");expect(result.body).not.toContain("too-short");
  });
  it("不能用有凭据但仍是模拟模式的支付宝启用销售",async()=>{
    new RuntimeSettings(config,db).set(settingKeys.paymentMode,"mock",false);
    const result=await enable();expect(result.statusCode).toBe(409);
    expect(result.json().error).toBe("payment_not_ready");
  });
  it("支付宝缺少必要凭据时拒绝启用",async()=>{
    config.alipay.sellerId="";
    const result=await enable();expect(result.statusCode).toBe(409);
    expect(result.json().error).toBe("payment_not_ready");
  });
  it("非生产可用X模拟接口测试，但仍需收款配置就绪",async()=>{
    config.nodeEnv="test";config.xApi.mode="mock";
    expect((await enable()).statusCode).toBe(200);
  });
  it("履约配置失效时仍可关闭商品",async()=>{
    config.xApi.mode="disabled";config.alipay.sellerId="";
    expect((await enable(false)).statusCode).toBe(200);
    expect(db.listProducts()[0].enabled).toBe(false);
  });
});
