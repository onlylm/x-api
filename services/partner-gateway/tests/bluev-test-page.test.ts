import { Script, createContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { bluevTestPage, bluevTestScript } from "../src/bluev-test-page.js";

const ID = "23ff9a67-f3d0-4350-ae58-6f2c2cfa7304";
const SECOND = "5dd52d41-d3ac-4d4f-b50e-37e38d626734";
const API = "/admin/api/bluev-test";
const baseItem = () => ({ test_id: ID, request_id: ID, order_id: "po_test", client_order_id: "BLUEVTEST-" + ID,
  product: "x_premium_3m", recipient: "@tester", amount: "22.00", currency: "CNY", payment_status: "pending",
  fulfillment_status: "not_started", requires_review: false, qr_available: true, terminal: false,
  expires_at: null, paid_at: null, created_at: "2026-10-06T00:00:00Z", updated_at: "2026-10-06T00:00:00Z",
  upstream_order_id: null, detail_zh: "等待付款", qr_error_code: null, qr_error_zh: null,
  qr_retry_allowed: false, qr_retry_requires_renewal: false, qr_retry_version: 0 });
const retryItem = () => ({ ...baseItem(), payment_status: "unknown", qr_available: false, requires_review: true,
  qr_error_code: "payment_result_unknown", qr_error_zh: "付款码生成结果尚未确认，请核对原单。", qr_retry_allowed: true });
const alipaySettings = () => ({ revision: 1, app_id: "2026000000000001", seller_id: "2088000000000001",
  has_private_key: true, has_public_key: true, notify_url: "https://x.aifu.me/bluev-sandbox/callbacks/alipay", updated_at: "2026-10-06T00:00:00.000Z" });

// A minimal DOM facade exercises event/state logic only. No browser or visual tools.
class Element {
  value = ""; checked = false; disabled = false; hidden = false; textContent = ""; className = ""; type = ""; src = "";
  children: Element[] = [];
  attributes = new Map<string, string>();
  onclick?: () => Promise<void> | void; onchange?: () => void; oninput?: () => void;
  onerror?: () => void; onload?: () => void;
  onsubmit?: (event: { preventDefault(): void }) => Promise<void>;
  append(...elements: Element[]) { this.children.push(...elements); }
  replaceChildren() { this.children = []; }
  removeAttribute(name: string) { if (name === "src") this.src = ""; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  focus() {} scrollIntoView() {}
}
type Handler = (path: string, init: RequestInit) => Response | Promise<Response>;
async function harness(handler: Handler = () => Response.json({ success: true, items: [] }), saved?: string | Record<string, unknown>, statusFails = false, savedAttempt?: Record<string, unknown>, hash = "") {
  const elements = new Map([...bluevTestPage.matchAll(/\sid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const el = (id: string) => elements.get(id)!;
  el("product").value = "x_premium_3m"; el("recipient").value = "tester";
  el("orderBody").hidden = true; el("pendingRequest").hidden = true;
  const storage = new Map(saved ? [["bluev-test-request", JSON.stringify(typeof saved === "string" ? { request_id: saved } : saved)]] : []);
  if (savedAttempt) storage.set("bluev-test-qr-attempt", JSON.stringify(savedAttempt));
  const calls: Array<{ path: string; init: RequestInit }> = [];
  let tick = () => {}; let ids = saved ? 1 : 0; let pendingAtFirstRead = false;
  const document = { hidden: false, getElementById: el, createElement: () => new Element() };
  const events = new Map<string, (event?: unknown) => void>();
  const window = { location: { hash }, addEventListener: (name: string, callback: (event?: unknown) => void) => { events.set(name, callback); } };
  const context = createContext({ document, window, Date, Intl, AbortSignal, Error,
    crypto: { randomUUID: () => ids++ === 0 ? ID : SECOND },
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    setInterval: (fn: () => void) => { tick = fn; },
    fetch: async (url: string, init: RequestInit) => {
      if (!calls.length) pendingAtFirstRead = !el("pendingRequest").hidden;
      const path = url.slice(API.length); calls.push({ path, init });
      if (path === "/status") return Response.json(statusFails ? { success: false, detail_zh: "状态查询失败" } : { success: true, isolated: true, sales_open: true, ready: true, active_test_id: null }, { status: statusFails ? 503 : 200 });
      if (path === "/eligibility") return Response.json({ success: true, product: "x_premium_3m", recipient: "@tester", eligible: true, available: true, amount: "22.00", detail_zh: "资格检查通过" });
      return handler(path, init);
    },
  });
  new Script(bluevTestScript).runInContext(context);
  const settle = async () => { for (let index = 0; index < 4; index++) await new Promise<void>(resolve => setImmediate(resolve)); };
  await settle();
  const qualify = async () => { await el("form").onsubmit!({ preventDefault() {} }); el("confirm").checked = true; el("confirm").onchange!(); };
  return { el, storage, calls, settle, qualify, document, events, pendingAtFirstRead,
    navigate: async (hash: string) => { window.location.hash = hash; events.get("hashchange")?.(); await settle(); },
    tick: async () => { tick(); await settle(); } };
}
const creates = (calls: Array<{ path: string; init: RequestInit }>) => calls.filter(call => call.path === "/orders" && call.init.method === "POST");
const qrRetries = (calls: Array<{ path: string; init: RequestInit }>) => calls.filter(call => call.path.endsWith("/retry-qr") && call.init.method === "POST");
const settingSaves = (calls: Array<{ path: string; init: RequestInit }>) => calls.filter(call => call.path === "/settings/alipay" && call.init.method === "POST");
const closes = (calls: Array<{ path: string; init: RequestInit }>) => calls.filter(call => call.path.endsWith("/close") && call.init.method === "POST");

describe("bluev test page state flow without a browser", () => {
  it("loads only reads, has a real empty state and requires eligibility plus explicit consent", async () => {
    const app = await harness();
    expect(app.calls.every(call => call.init.method === "GET")).toBe(true);
    expect(app.el("historyEmpty").textContent).toContain("暂无测试记录");
    expect(app.el("create").disabled).toBe(true);
    await app.el("form").onsubmit!({ preventDefault() {} });
    expect(app.el("create").disabled).toBe(true);
    app.el("confirm").checked = true; app.el("confirm").onchange!();
    expect(app.el("create").disabled).toBe(false);
    app.el("recipient").value = "someone_else"; app.el("recipient").oninput!();
    expect(app.el("create").disabled).toBe(true); expect(app.el("confirm").checked).toBe(false);
    expect(creates(app.calls)).toHaveLength(0);
  });
  it("binds a create to one persisted UUID and shows separate payment and fulfillment states", async () => {
    const app = await harness((path, init) => Response.json(path === "/orders" && init.method === "POST"
      ? { success: true, item: baseItem() } : { success: true, items: [] }));
    await app.qualify(); await app.el("create").onclick!();
    const request = JSON.parse(creates(app.calls)[0].init.body as string);
    expect(request).toEqual({ product: "x_premium_3m", recipient: "tester", request_id: ID, confirm_real_payment: true });
    expect(JSON.parse(app.storage.get("bluev-test-request")!)).toEqual({ request_id: ID, draft: request });
    expect(app.el("paymentStatus").textContent).toBe("等待扫码付款");
    expect(app.el("giftStatus").textContent).toBe("尚未开始");
    expect(app.el("qr").src).toBe(API + "/orders/" + ID + "/qr");
    await app.el("create").onclick!(); expect(creates(app.calls)).toHaveLength(1);
  });
  it("locks unknown submissions and only polls the original UUID, never repeats a create", async () => {
    const app = await harness((path, init) => {
      if (path === "/orders" && init.method === "POST") throw new Error("连接超时");
      return Response.json({ success: true, items: [] });
    });
    await app.qualify(); await app.el("create").onclick!();
    expect(app.el("pendingRequestId").textContent).toBe(ID);
    expect(app.el("create").disabled).toBe(true);
    await app.el("create").onclick!(); await app.el("newTest").onclick!(); await app.tick();
    expect(creates(app.calls)).toHaveLength(1);
    expect(app.calls.some(call => call.path === "/orders?request_id=" + ID)).toBe(true);
    expect(JSON.parse(app.storage.get("bluev-test-request")!).request_id).toBe(ID);
    const count = app.calls.length; app.document.hidden = true; await app.tick(); expect(app.calls).toHaveLength(count);
  });
  it("restores a refreshed page using its UUID without automatically posting anything", async () => {
    const app = await harness(path => Response.json({ success: true, items: path.includes("request_id=") ? [baseItem()] : [] }), ID);
    expect(creates(app.calls)).toHaveLength(0);
    expect(app.el("requestId").textContent).toBe(ID);
    expect(app.el("orderBody").hidden).toBe(false);
    expect(app.calls.some(call => call.path === "/orders?request_id=" + ID)).toBe(true);
  });
  it("keeps a confirmed no-intent record and permits a new qualification only after explicit next-test action", async () => {
    const failed = { ...baseItem(), order_id: null, payment_status: "not_created", terminal: true, qr_available: false,
      detail_zh: "资格或接单检查未通过，未发起付款。" };
    const app = await harness((path, init) => Response.json(path === "/orders" && init.method === "POST"
      ? { success: true, item: failed } : { success: true, items: [failed] }));
    await app.qualify(); await app.el("create").onclick!();
    expect(app.el("orderMessage").textContent).toBe(failed.detail_zh);
    expect(app.el("newTest").disabled).toBe(false); expect(app.el("create").disabled).toBe(true);
    expect(app.el("notice").textContent).toContain("未发起付款");
    await app.el("newTest").onclick!();
    expect(app.el("eligibility").disabled).toBe(false); expect(app.el("create").disabled).toBe(true);
    expect(creates(app.calls)).toHaveLength(1); expect(JSON.parse(app.storage.get("bluev-test-request")!).request_id).toBeNull();
    await app.qualify(); await app.el("create").onclick!();
    expect(JSON.parse(creates(app.calls)[1].init.body as string).request_id).toBe(SECOND);
  });
  it("does not hide an already confirmed original order when only the history refresh fails", async () => {
    let created = false;
    const app = await harness((path, init) => {
      if (path === "/orders" && init.method === "POST") { created = true; return Response.json({ success: true, item: baseItem() }); }
      if (created) return Response.json({ success: false, detail_zh: "历史列表暂不可用" }, { status: 503 });
      return Response.json({ success: true, items: [] });
    });
    await app.qualify(); await app.el("create").onclick!();
    expect(app.el("orderBody").hidden).toBe(false); expect(app.el("qrArea").hidden).toBe(false);
    expect(app.el("requestId").textContent).toBe(ID); expect(app.el("notice").textContent).toContain("当前测试单已保留");
  });
  it("allows an explicit same-UUID retry only after a successful empty lookup and another confirmation", async () => {
    let failed = false;
    const app = await harness((path, init) => {
      if (path === "/orders" && init.method === "POST") {
        if (!failed) { failed = true; throw new Error("未收到返回"); }
        return Response.json({ success: true, item: baseItem() });
      }
      return Response.json({ success: true, items: [] });
    });
    await app.qualify(); await app.el("create").onclick!();
    expect(app.el("retryRequest").disabled).toBe(true);
    await app.tick(); expect(app.el("retryControls").hidden).toBe(false);
    expect(app.el("pendingDraft").textContent).toContain("tester");
    expect(app.el("retryRequest").disabled).toBe(true);
    app.el("recipient").value = "other"; app.el("product").value = "x_premium_6m";
    app.el("retryConfirm").checked = true; app.el("retryConfirm").onchange!();
    await app.el("retryRequest").onclick!();
    expect(creates(app.calls)).toHaveLength(2);
    expect(creates(app.calls)[1].init.body).toBe(creates(app.calls)[0].init.body);
    expect(app.el("requestId").textContent).toBe(ID);
  });
  it("restores only an allowlisted original draft and never auto-retries it", async () => {
    const draft = { request_id: ID, product: "x_premium_3m", recipient: "tester", confirm_real_payment: true };
    const app = await harness((_path, init) => Response.json(init.method === "POST" ? { success: true, item: baseItem() } : { success: true, items: [] }),
      { request_id: ID, draft: { ...draft, sell_price: "0.01", extra: "private" } });
    expect(creates(app.calls)).toHaveLength(0);
    expect(app.el("pendingDraft").textContent).toContain("¥22.00");
    app.el("retryConfirm").checked = true; app.el("retryConfirm").onchange!(); await app.el("retryRequest").onclick!();
    expect(JSON.parse(creates(app.calls)[0].init.body as string)).toEqual(draft);
  });
  it("keeps a failed QR visible through polling until a reload really succeeds", async () => {
    const app = await harness((path, init) => Response.json(path === "/orders/" + ID || init.method === "POST"
      ? { success: true, item: baseItem() } : { success: true, items: [] }));
    await app.qualify(); await app.el("create").onclick!();
    app.el("qr").onerror!(); expect(app.el("qrError").hidden).toBe(false); expect(app.el("qr").hidden).toBe(true);
    await app.tick(); expect(app.el("qrError").hidden).toBe(false); expect(app.el("qr").hidden).toBe(true);
    await app.el("retryQr").onclick!(); app.el("qr").onload!();
    expect(app.el("qrError").hidden).toBe(true); expect(app.el("qr").hidden).toBe(false);
    expect(creates(app.calls)).toHaveLength(1);
  });
  it("shows the original request immediately and still recovers it when initial status and history fail", async () => {
    const app = await harness(path => path === "/orders"
      ? Response.json({ success: false, detail_zh: "历史查询失败" }, { status: 503 })
      : Response.json({ success: true, items: [baseItem()] }), ID, true);
    expect(app.pendingAtFirstRead).toBe(true);
    expect(app.el("orderBody").hidden).toBe(false); expect(app.el("requestId").textContent).toBe(ID);
    expect(creates(app.calls)).toHaveLength(0);
  });
  it("ignores an old refresh response after the user starts a new explicit test", async () => {
    const terminal = { ...baseItem(), payment_status: "not_created", terminal: true, qr_available: false };
    let release: (value: Response) => void = () => {};
    const app = await harness((path, init) => {
      if (path === "/orders/" + ID) return new Promise<Response>(resolve => { release = resolve; });
      if (init.method === "POST") return Response.json({ success: true, item: { ...baseItem(), test_id: SECOND, request_id: SECOND } });
      return Response.json({ success: true, items: path.includes("request_id=") ? [terminal] : [] });
    }, ID);
    const oldRefresh = app.el("refreshOrder").onclick!(); await app.settle();
    await app.el("newTest").onclick!(); await app.qualify(); await app.el("create").onclick!();
    expect(app.el("requestId").textContent).toBe(SECOND);
    release(Response.json({ success: true, item: terminal })); await oldRefresh;
    expect(app.el("requestId").textContent).toBe(SECOND);
    expect(JSON.parse(app.storage.get("bluev-test-request")!).request_id).toBe(SECOND);
  });
  it("does not overwrite an original-order query error with a refresh success notice", async () => {
    const app = await harness(path => path === "/orders/" + ID
      ? Response.json({ success: false, detail_zh: "原单查询暂不可用" }, { status: 503 })
      : Response.json({ success: true, items: path.includes("request_id=") ? [baseItem()] : [] }), ID);
    await app.el("refreshAll").onclick!();
    expect(app.el("notice").textContent).toBe("原单查询暂不可用");
  });
  it("distinguishes an ungenerated QR from an image failure and never retries during recovery or polling", async () => {
    const app = await harness(path => Response.json(path === "/orders/" + ID
      ? { success: true, item: retryItem() } : { success: true, items: path.includes("request_id=") ? [retryItem()] : [] }), ID);
    expect(app.el("qrArea").hidden).toBe(true); expect(app.el("qrRecovery").hidden).toBe(false);
    expect(app.el("qrServiceMessage").textContent).toBe(retryItem().qr_error_zh);
    expect(app.el("requestQrRetry").disabled).toBe(true); expect(app.el("qrRetryConfirm").checked).toBe(false);
    await app.tick(); await app.el("refreshOrder").onclick!();
    expect(qrRetries(app.calls)).toHaveLength(0); expect(creates(app.calls)).toHaveLength(0);
    expect(app.el("requestQrRetry").disabled).toBe(true);
  });
  it("requires both original-order consent and a separate renewal consent for an expired window", async () => {
    const expired = { ...retryItem(), qr_retry_requires_renewal: true };
    const app = await harness((path, init) => Response.json(init.method === "POST"
      ? { success: true, item: { ...baseItem(), qr_retry_version: 1 } }
      : { success: true, items: path.includes("request_id=") ? [expired] : [] }), ID);
    expect(app.el("qrRenewalControl").hidden).toBe(false);
    app.el("qrRetryConfirm").checked = true; app.el("qrRetryConfirm").onchange!();
    expect(app.el("requestQrRetry").disabled).toBe(true);
    await app.el("requestQrRetry").onclick!(); expect(qrRetries(app.calls)).toHaveLength(0);
    app.el("qrRenewalConfirm").checked = true; app.el("qrRenewalConfirm").onchange!();
    expect(app.el("requestQrRetry").disabled).toBe(false);
    await app.el("requestQrRetry").onclick!();
    expect(qrRetries(app.calls)).toHaveLength(1);
    expect(qrRetries(app.calls)[0].path).toBe("/orders/" + ID + "/retry-qr");
    expect(JSON.parse(qrRetries(app.calls)[0].init.body as string)).toEqual({ expected_version: 0, confirm_retry: true, confirm_renewal: true });
    expect(app.el("qrArea").hidden).toBe(false); expect(app.el("qrRecovery").hidden).toBe(true);
    expect(app.el("notice").textContent).toContain("手动扫码"); expect(creates(app.calls)).toHaveLength(0);
  });
  it("preserves a checked consent on unchanged reads but resets it when version or renewal changes", async () => {
    let current = retryItem();
    const app = await harness(path => Response.json(path === "/orders/" + ID ? { success: true, item: current }
      : { success: true, items: path.includes("request_id=") ? [current] : [] }), ID);
    app.el("qrRetryConfirm").checked = true; app.el("qrRetryConfirm").onchange!();
    await app.tick(); expect(app.el("qrRetryConfirm").checked).toBe(true); expect(app.el("requestQrRetry").disabled).toBe(false);
    current = { ...current, qr_retry_version: 1 }; await app.tick();
    expect(app.el("qrRetryConfirm").checked).toBe(false); expect(app.el("requestQrRetry").disabled).toBe(true);
    app.el("qrRetryConfirm").checked = true; app.el("qrRetryConfirm").onchange!();
    current = { ...current, qr_retry_requires_renewal: true }; await app.tick();
    expect(app.el("qrRetryConfirm").checked).toBe(false); expect(app.el("qrRenewalConfirm").checked).toBe(false);
    expect(qrRetries(app.calls)).toHaveLength(0);
  });
  it("does not submit twice while a QR retry is pending and keeps refresh as reads only", async () => {
    let release: (value: Response) => void = () => {};
    const app = await harness((path, init) => init.method === "POST" ? new Promise<Response>(resolve => { release = resolve; })
      : Response.json({ success: true, items: path.includes("request_id=") ? [retryItem()] : [] }), ID);
    app.el("qrRetryConfirm").checked = true; app.el("qrRetryConfirm").onchange!();
    const first = app.el("requestQrRetry").onclick!(); await app.settle();
    expect(app.el("requestQrRetry").disabled).toBe(true); expect(app.el("requestQrRetry").textContent).toContain("正在核对");
    expect(app.el("refreshOrder").disabled).toBe(true);
    await app.el("requestQrRetry").onclick!(); await app.tick(); expect(qrRetries(app.calls)).toHaveLength(1);
    release(Response.json({ success: true, item: { ...baseItem(), qr_retry_version: 1 } })); await first;
    expect(app.el("refreshOrder").disabled).toBe(false); expect(creates(app.calls)).toHaveLength(0);
  });
  it("keeps the sent version after a lost POST result and requires a read plus renewed consent", async () => {
    let version = 0;
    const app = await harness((path, init) => {
      if (init.method === "POST") { version = 1; throw new Error("连接超时"); }
      const current = { ...retryItem(), qr_retry_version: version };
      return Response.json(path === "/orders/" + ID ? { success: true, item: current }
        : { success: true, items: path.includes("request_id=") ? [current] : [] });
    }, ID);
    app.el("qrRetryConfirm").checked = true; app.el("qrRetryConfirm").onchange!();
    await app.el("requestQrRetry").onclick!();
    expect(JSON.parse(app.storage.get("bluev-test-qr-attempt")!)).toEqual({ request_id: ID, expected_version: 0, confirm_retry: true, confirm_renewal: false });
    expect(app.el("requestQrRetry").disabled).toBe(true); expect(app.el("qrRetryStatus").textContent).toContain("原尝试版本");
    app.el("qrRetryConfirm").checked = true; app.el("qrRetryConfirm").onchange!();
    await app.el("requestQrRetry").onclick!(); expect(qrRetries(app.calls)).toHaveLength(1);
    await app.el("refreshOrder").onclick!();
    expect(app.el("qrRetryConfirm").checked).toBe(false); expect(app.el("requestQrRetry").disabled).toBe(true);
    expect(JSON.parse(app.storage.get("bluev-test-qr-attempt")!)).toBeNull();
    await app.tick(); expect(qrRetries(app.calls)).toHaveLength(1);
    app.el("qrRetryConfirm").checked = true; app.el("qrRetryConfirm").onchange!();
    await app.el("requestQrRetry").onclick!();
    expect(JSON.parse(qrRetries(app.calls)[1].init.body as string).expected_version).toBe(1);
  });
  it("rejects a stale GET from before a retry instead of overwriting the recovered QR", async () => {
    let release: (value: Response) => void = () => {};
    const app = await harness((path, init) => {
      if (path === "/orders/" + ID) return new Promise<Response>(resolve => { release = resolve; });
      if (init.method === "POST") return Response.json({ success: true, item: { ...baseItem(), qr_retry_version: 1 } });
      return Response.json({ success: true, items: path.includes("request_id=") ? [retryItem()] : [] });
    }, ID);
    const oldGet = app.el("refreshOrder").onclick!(); await app.settle();
    app.el("qrRetryConfirm").checked = true; app.el("qrRetryConfirm").onchange!();
    await app.el("requestQrRetry").onclick!(); expect(app.el("qrArea").hidden).toBe(false);
    release(Response.json({ success: true, item: retryItem() })); await oldGet;
    expect(app.el("qrArea").hidden).toBe(false); expect(app.el("qrRecovery").hidden).toBe(true);
    expect(app.el("paymentStatus").textContent).toBe("等待扫码付款");
  });
  it("restores an uncertain QR attempt only by reading the original order, never by posting", async () => {
    const app = await harness(path => Response.json({ success: true, items: path.includes("request_id=") ? [{ ...retryItem(), qr_retry_version: 1 }] : [] }), ID, false,
      { request_id: ID, expected_version: 0, confirm_retry: true, confirm_renewal: false, amount: "0.01" });
    expect(qrRetries(app.calls)).toHaveLength(0); expect(creates(app.calls)).toHaveLength(0);
    expect(app.el("requestQrRetry").disabled).toBe(true); expect(app.el("qrRetryConfirm").checked).toBe(false);
    expect(JSON.parse(app.storage.get("bluev-test-qr-attempt")!)).toBeNull();
  });
  it("loads settings only through its hash view without posting or changing the test flow", async () => {
    const app = await harness(path => Response.json(path === "/settings/alipay" ? { success: true, settings: alipaySettings() } : { success: true, items: [] }));
    expect(app.calls.some(call => call.path === "/settings/alipay")).toBe(false);
    await app.navigate("#alipay");
    expect(app.el("alipayView").hidden).toBe(false); expect(app.el("testView").hidden).toBe(true);
    expect(app.el("alipayTab").attributes.get("aria-current")).toBe("page");
    expect(app.el("alipayAppId").value).toBe(alipaySettings().app_id);
    expect(app.el("alipayPrivateKey").value).toBe(""); expect(app.el("alipayPublicKey").value).toBe("");
    expect(app.el("alipayPrivateState").textContent).toContain("不会回显");
    expect(app.el("saveAlipay").disabled).toBe(true); expect(settingSaves(app.calls)).toHaveLength(0);
    await app.navigate("#test"); await app.tick();
    expect(app.el("testView").hidden).toBe(false); expect(settingSaves(app.calls)).toHaveLength(0);
    expect(creates(app.calls)).toHaveLength(0); expect(qrRetries(app.calls)).toHaveLength(0);
  });
  it("saves same-identity blank keys only after consent and never stores or fills key values", async () => {
    const app = await harness((path, init) => Response.json(path === "/settings/alipay"
      ? { success: true, settings: { ...alipaySettings(), revision: init.method === "POST" ? 2 : 1 } } : { success: true, items: [] }), undefined, false, undefined, "#alipay");
    await app.el("alipayForm").onsubmit!({ preventDefault() {} }); expect(settingSaves(app.calls)).toHaveLength(0);
    app.el("alipayConfirm").checked = true; app.el("alipayConfirm").onchange!();
    await app.el("alipayForm").onsubmit!({ preventDefault() {} });
    expect(JSON.parse(settingSaves(app.calls)[0].init.body as string)).toEqual({ app_id: alipaySettings().app_id, seller_id: alipaySettings().seller_id,
      private_key: "", public_key: "", expected_revision: 1, confirm_apply: true });
    expect(app.el("alipayRevision").textContent).toBe("2"); expect(app.el("alipayConfirm").checked).toBe(false);
    expect(app.el("alipayNotice").textContent).toContain("没有发起交易或开启接单");
    expect([...app.storage.keys()].some(key => key.includes("alipay"))).toBe(false);
    expect(creates(app.calls)).toHaveLength(0); expect(qrRetries(app.calls)).toHaveLength(0);
  });
  it("requires both new keys for an identity change and resets consent after any edit", async () => {
    const app = await harness(path => Response.json(path === "/settings/alipay" ? { success: true, settings: alipaySettings() } : { success: true, items: [] }), undefined, false, undefined, "#alipay");
    app.el("alipayAppId").value = "2026000000000002"; app.el("alipayAppId").oninput!();
    app.el("alipayConfirm").checked = true; app.el("alipayConfirm").onchange!();
    expect(app.el("saveAlipay").disabled).toBe(true); expect(app.el("alipayFieldHint").textContent).toContain("同时填写");
    app.el("alipayPrivateKey").value = "FAKE PRIVATE KEY"; app.el("alipayPrivateKey").oninput!();
    expect(app.el("alipayConfirm").checked).toBe(false);
    app.el("alipayPublicKey").value = "FAKE PUBLIC KEY"; app.el("alipayPublicKey").oninput!();
    app.el("alipayConfirm").checked = true; app.el("alipayConfirm").onchange!();
    expect(app.el("saveAlipay").disabled).toBe(false);
    expect([...app.storage.values()].join("")).not.toMatch(/FAKE PRIVATE|FAKE PUBLIC/);
    expect(settingSaves(app.calls)).toHaveLength(0);
  });
  it("preserves unsaved keys across hash tabs, warns on leaving, and requires explicit discard before rereading", async () => {
    const app = await harness(path => Response.json(path === "/settings/alipay" ? { success: true, settings: alipaySettings() } : { success: true, items: [] }), undefined, false, undefined, "#alipay");
    app.el("alipayPrivateKey").value = "UNSAVED SECRET"; app.el("alipayPrivateKey").oninput!();
    expect(app.el("alipayUnsaved").hidden).toBe(false);
    const before = app.calls.length; await app.el("refreshAlipay").onclick!(); expect(app.calls).toHaveLength(before);
    expect(app.el("alipayPrivateKey").value).toBe("UNSAVED SECRET");
    await app.navigate("#test"); await app.navigate("#alipay");
    expect(app.el("alipayPrivateKey").value).toBe("UNSAVED SECRET");
    let prevented = false;
    app.events.get("beforeunload")!({ preventDefault: () => { prevented = true; }, returnValue: undefined });
    expect(prevented).toBe(true);
    await app.el("discardAlipay").onclick!();
    expect(app.el("alipayPrivateKey").value).toBe(""); expect(app.el("alipayUnsaved").hidden).toBe(true);
    expect(settingSaves(app.calls)).toHaveLength(0);
  });
  it("blocks duplicate saves and transaction creation while configuration is being saved", async () => {
    let release: (response: Response) => void = () => {};
    const app = await harness((path, init) => path === "/settings/alipay" && init.method === "POST"
      ? new Promise<Response>(resolve => { release = resolve; })
      : Response.json(path === "/settings/alipay" ? { success: true, settings: alipaySettings() } : { success: true, items: [] }), undefined, false, undefined, "#alipay");
    await app.qualify();
    app.el("alipayPrivateKey").value = "FAKE PRIVATE KEY"; app.el("alipayPrivateKey").oninput!();
    app.el("alipayPublicKey").value = "FAKE PUBLIC KEY"; app.el("alipayPublicKey").oninput!();
    app.el("alipayConfirm").checked = true; app.el("alipayConfirm").onchange!();
    const first = app.el("alipayForm").onsubmit!({ preventDefault() {} }); await app.settle();
    expect(app.el("saveAlipay").disabled).toBe(true); expect(app.el("saveAlipay").textContent).toContain("正在保存");
    expect(app.el("alipayPrivateKey").disabled).toBe(true); expect(app.el("create").disabled).toBe(true);
    await app.el("alipayForm").onsubmit!({ preventDefault() {} }); await app.el("create").onclick!();
    expect(settingSaves(app.calls)).toHaveLength(1); expect(creates(app.calls)).toHaveLength(0);
    release(Response.json({ success: true, settings: { ...alipaySettings(), revision: 2 } })); await first;
    expect(app.el("alipayPrivateKey").value).toBe(""); expect(app.el("alipayPublicKey").value).toBe("");
    expect([...app.storage.values()].join("")).not.toMatch(/FAKE PRIVATE|FAKE PUBLIC/);
  });
  it("keeps a lost save result locked until an explicit reread and never auto-saves from polling", async () => {
    let revision = 1;
    const app = await harness((path, init) => {
      if (path === "/settings/alipay" && init.method === "POST") { revision++; throw new Error("private fake key must not display"); }
      return Response.json(path === "/settings/alipay" ? { success: true, settings: { ...alipaySettings(), revision } } : { success: true, items: [] });
    }, undefined, false, undefined, "#alipay");
    app.el("alipayPrivateKey").value = "FAKE PRIVATE KEY"; app.el("alipayPrivateKey").oninput!();
    app.el("alipayConfirm").checked = true; app.el("alipayConfirm").onchange!();
    await app.el("alipayForm").onsubmit!({ preventDefault() {} });
    expect(app.el("alipayNotice").textContent).not.toContain("private fake key");
    expect(app.el("alipayPrivateKey").value).toBe("FAKE PRIVATE KEY");
    app.el("alipayConfirm").checked = true; app.el("alipayConfirm").onchange!();
    expect(app.el("saveAlipay").disabled).toBe(true);
    await app.el("alipayForm").onsubmit!({ preventDefault() {} }); await app.tick();
    expect(settingSaves(app.calls)).toHaveLength(1);
    await app.el("discardAlipay").onclick!();
    expect(app.el("alipayRevision").textContent).toBe("2"); expect(app.el("alipayPrivateKey").value).toBe("");
    expect(app.el("alipayConfirm").checked).toBe(false); expect(settingSaves(app.calls)).toHaveLength(1);
  });
  it("keeps rejected key input for correction while showing only a fixed validation message", async () => {
    const app = await harness((path, init) => path === "/settings/alipay" && init.method === "POST"
      ? Response.json({ success: false, error: "bluev_alipay_invalid_private_key", detail_zh: "PRIVATE RAW CONTENT" }, { status: 400 })
      : Response.json(path === "/settings/alipay" ? { success: true, settings: alipaySettings() } : { success: true, items: [] }), undefined, false, undefined, "#alipay");
    app.el("alipayPrivateKey").value = "INVALID KEY"; app.el("alipayPrivateKey").oninput!();
    app.el("alipayConfirm").checked = true; app.el("alipayConfirm").onchange!();
    await app.el("alipayForm").onsubmit!({ preventDefault() {} });
    expect(app.el("alipayNotice").textContent).toContain("RSA 私钥"); expect(app.el("alipayNotice").textContent).not.toContain("PRIVATE RAW");
    expect(app.el("alipayPrivateKey").value).toBe("INVALID KEY");
    app.el("alipayPrivateKey").value = "CORRECTED KEY"; app.el("alipayPrivateKey").oninput!();
    app.el("alipayConfirm").checked = true; app.el("alipayConfirm").onchange!(); expect(app.el("saveAlipay").disabled).toBe(false);
  });
  it("does not overwrite an edit with a late settings GET and wipes transient keys when leaving the page", async () => {
    let reads = 0; let release: (response: Response) => void = () => {};
    const app = await harness(path => path === "/settings/alipay" && ++reads > 1
      ? new Promise<Response>(resolve => { release = resolve; })
      : Response.json(path === "/settings/alipay" ? { success: true, settings: alipaySettings() } : { success: true, items: [] }), undefined, false, undefined, "#alipay");
    const reading = app.el("refreshAlipay").onclick!(); await app.settle();
    app.el("alipayPrivateKey").value = "LATE INPUT"; app.el("alipayPrivateKey").oninput!();
    release(Response.json({ success: true, settings: { ...alipaySettings(), revision: 2 } })); await reading;
    expect(app.el("alipayPrivateKey").value).toBe("LATE INPUT"); expect(app.el("alipayRevision").textContent).toBe("1");
    app.events.get("pagehide")!(); expect(app.el("alipayPrivateKey").value).toBe(""); expect(app.el("alipayPublicKey").value).toBe("");
  });
  it("allows a next-account draft while an old request is active but never changes its payload", async () => {
    const app = await harness(path => Response.json(path === "/orders/" + ID ? { success: true, item: retryItem() }
      : { success: true, items: path.includes("request_id=") ? [retryItem()] : [] }), ID);
    expect(app.el("recipient").disabled).toBe(false); expect(app.el("product").disabled).toBe(false);
    expect(app.el("eligibility").disabled).toBe(true); expect(app.el("testFormLock").textContent).toContain("@tester");
    app.el("recipient").value = "next_user"; app.el("recipient").oninput!();
    await app.el("form").onsubmit!({ preventDefault() {} }); await app.el("create").onclick!();
    expect(app.el("orderRecipient").textContent).toBe("@tester"); expect(creates(app.calls)).toHaveLength(0);
    expect(app.calls.some(call => call.path === "/eligibility")).toBe(false);
  });
  it("closes only the displayed unpaid unknown original after consent and preserves the next draft", async () => {
    const closed = { ...retryItem(), payment_status: "closed", terminal: true };
    const app = await harness((path, init) => Response.json(path.endsWith("/close") && init.method === "POST"
      ? { success: true, item: closed, idempotent: false } : { success: true, items: path.includes("request_id=") ? [retryItem()] : [] }), ID);
    expect(app.el("closeTestArea").hidden).toBe(false); expect(app.el("closeTest").disabled).toBe(true);
    await app.el("closeTest").onclick!(); expect(closes(app.calls)).toHaveLength(0);
    app.el("recipient").value = "next_user"; app.el("recipient").oninput!();
    app.el("closeTestConfirm").checked = true; app.el("closeTestConfirm").onchange!();
    await app.el("closeTest").onclick!();
    expect(closes(app.calls)).toHaveLength(1); expect(closes(app.calls)[0].path).toBe("/orders/" + ID + "/close");
    expect(JSON.parse(closes(app.calls)[0].init.body as string)).toEqual({ confirm_close: true });
    expect(app.el("newTest").disabled).toBe(false); expect(app.el("create").disabled).toBe(true);
    await app.el("newTest").onclick!();
    expect(app.el("recipient").value).toBe("next_user"); expect(app.el("eligibility").disabled).toBe(false);
    expect(app.el("testFormLock").hidden).toBe(true); expect(creates(app.calls)).toHaveLength(0);
  });
  it("does not offer a blind close for a saved QR or a paid order", async () => {
    for (const current of [baseItem(), { ...baseItem(), payment_status: "paid", qr_available: false, fulfillment_status: "queued" }]) {
      const app = await harness(path => Response.json({ success: true, items: path.includes("request_id=") ? [current] : [] }), ID);
      expect(app.el("closeTestArea").hidden).toBe(true);
      app.el("closeTestConfirm").checked = true; app.el("closeTestConfirm").onchange!();
      await app.el("closeTest").onclick!(); expect(closes(app.calls)).toHaveLength(0);
    }
  });
  it("keeps a refused close bound to its original order and never retries automatically", async () => {
    const app = await harness((path, init) => path.endsWith("/close") && init.method === "POST"
      ? Response.json({ success: false, error: "close_payment_unknown", detail_zh: "无法证实未付款" }, { status: 409 })
      : Response.json(path === "/orders/" + ID ? { success: true, item: retryItem() }
        : { success: true, items: path.includes("request_id=") ? [retryItem()] : [] }), ID);
    app.el("closeTestConfirm").checked = true; app.el("closeTestConfirm").onchange!();
    await app.el("closeTest").onclick!();
    expect(app.el("notice").textContent).toContain("无法证实未付款");
    expect(app.el("newTest").disabled).toBe(true); expect(app.el("closeTest").disabled).toBe(true);
    await app.tick(); expect(closes(app.calls)).toHaveLength(1); expect(creates(app.calls)).toHaveLength(0);
  });
});
