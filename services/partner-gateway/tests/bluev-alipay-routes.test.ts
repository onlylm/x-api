import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { BluevAlipayClientFactory } from "../src/bluev-alipay-settings.js";
import { buildBluevSandbox, bluevSandboxProducts, type BluevSandboxConfig } from "../src/bluev-sandbox.js";
import { MockPaymentClient } from "../src/clients/payment.js";
import { MockXApiClient } from "../src/clients/x-api.js";
import { ledgerTestConfig } from "./ledger-fixtures.js";
import { BLUEV_ALIPAY_NOTIFY_URL } from "../src/bluev-alipay-contract.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

describe("isolated blueV Alipay settings API", () => {
  const url = "/internal/bluev-test/settings/alipay";
  let directory: string, config: BluevSandboxConfig;
  let service: Awaited<ReturnType<typeof buildBluevSandbox>>;
  let factory: Mock<BluevAlipayClientFactory>;
  const headers = () => ({ "x-bluev-test-key": config.bluevTestKey });
  const body = () => ({ app_id: config.alipay.appId, seller_id: config.alipay.sellerId,
    private_key: "", public_key: "", expected_revision: 1, confirm_apply: true });
  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("external_network_forbidden"); }));
    directory = mkdtempSync(join(tmpdir(), "bluev-alipay-route-"));
    config = { ...ledgerTestConfig(join(directory, "bluev-sandbox.sqlite")), bluevSandbox: true,
      bluevTestKey: "test-key-".padEnd(40, "z"), partnerSalesGateFile: join(directory, "sales.enabled"),
      products: bluevSandboxProducts(), platformWebhookEnabled: false,
      alipay: { appId: "2026000000000001", sellerId: "2088000000000001", ...keys,
        gateway: "https://openapi.alipay.com/gateway.do", notifyUrl: BLUEV_ALIPAY_NOTIFY_URL, returnUrl: "" } };
    const payment = new MockPaymentClient("https://payment.invalid");
    factory = vi.fn(() => Object.assign(payment, { queryForRecovery: vi.fn(async () => ({ state: "unknown" as const,
      confirmation: { paid: false, tradeNo: null, paidAt: new Date().toISOString(), receiptAmount: null, tradeStatus: null } })) }));
    service = await buildBluevSandbox(config, { alipayClientFactory: factory, xApi: new MockXApiClient(), startWorkers: false });
  });
  afterEach(async () => {
    await service.app.close(); expect(fetch).not.toHaveBeenCalled();
    rmSync(directory, { recursive: true, force: true }); vi.unstubAllGlobals();
  });
  it("requires the independent key for both read and write", async () => {
    expect((await service.app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect((await service.app.inject({ method: "POST", url, payload: body() })).statusCode).toBe(401);
    expect(factory).not.toHaveBeenCalled();
  });
  it("returns only configuration metadata and never exposes stored key values", async () => {
    const response = await service.app.inject({ method: "GET", url, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json().settings).toMatchObject({ revision: 1, app_id: config.alipay.appId,
      seller_id: config.alipay.sellerId, has_private_key: true, has_public_key: true, notify_url: BLUEV_ALIPAY_NOTIFY_URL });
    expect(response.body).not.toContain("BEGIN"); expect(response.body).not.toContain("ciphertext");
    expect(response.headers["cache-control"]).toBe("no-store"); expect(factory).not.toHaveBeenCalled();
  });
  it("saves new merchant credentials without opening sales, creating orders or calling the provider", async () => {
    const response = await service.app.inject({ method: "POST", url, headers: headers(), payload: { ...body(),
      app_id: "2026000000000002", seller_id: "2088000000000002", private_key: keys.privateKey, public_key: keys.publicKey } });
    expect(response.statusCode).toBe(200);
    expect(response.json().settings).toMatchObject({ revision: 2, app_id: "2026000000000002", seller_id: "2088000000000002" });
    expect(response.body).not.toContain("BEGIN");
    expect(factory).not.toHaveBeenCalled(); expect(existsSync(config.partnerSalesGateFile)).toBe(false);
    expect(service.db.db.prepare("SELECT COUNT(*) n FROM orders").get()?.n).toBe(0);
    expect(service.db.db.prepare("SELECT COUNT(*) n FROM activations").get()?.n).toBe(0);
  });
  it("rejects stale edits and requires both keys when changing identity", async () => {
    const missing = await service.app.inject({ method: "POST", url, headers: headers(), payload: { ...body(), app_id: "2026000000000002" } });
    expect(missing.json().error.code).toBe("bluev_alipay_keys_required");
    expect((await service.app.inject({ method: "POST", url, headers: headers(), payload: body() })).statusCode).toBe(200);
    const stale = await service.app.inject({ method: "POST", url, headers: headers(), payload: body() });
    expect(stale.statusCode).toBe(409); expect(stale.json().error.code).toBe("bluev_alipay_revision_conflict");
  });
  it.each([
    { confirm_apply: false }, { app_id: "bad" }, { private_key: "NOT-A-PRIVATE-KEY-secret" },
    { public_key: "NOT-A-PUBLIC-KEY-secret" }, { notify_url: "https://attacker.invalid" }, { seller_id: "2088000000000002" },
  ])("rejects invalid configuration without exposing posted secrets %j", async change => {
    const response = await service.app.inject({ method: "POST", url, headers: headers(), payload: { ...body(), ...change } });
    expect(response.statusCode).toBe(400); expect(response.body).not.toContain("-secret");
    const read = await service.app.inject({ method: "GET", url, headers: headers() });
    expect(read.json().settings.revision).toBe(1);
  });
  it("rejects cross-format and excessive-body writes", async () => {
    expect((await service.app.inject({ method: "POST", url, headers: { ...headers(), "content-type": "text/plain" }, payload: "secret" })).statusCode).toBe(415);
    const large = await service.app.inject({ method: "POST", url, headers: headers(), payload: { ...body(), private_key: "z".repeat(20_000) } });
    expect(large.statusCode).toBeGreaterThanOrEqual(400); expect(large.body).not.toContain("zzzz");
  });
});
