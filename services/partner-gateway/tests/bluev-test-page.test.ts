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
  upstream_order_id: null, detail_zh: "等待付款" });

// A minimal DOM facade exercises event/state logic only. No browser or visual tools.
class Element {
  value = ""; checked = false; disabled = false; hidden = false; textContent = ""; className = ""; type = ""; src = "";
  children: Element[] = [];
  onclick?: () => Promise<void> | void; onchange?: () => void; oninput?: () => void;
  onerror?: () => void; onload?: () => void;
  onsubmit?: (event: { preventDefault(): void }) => Promise<void>;
  append(...elements: Element[]) { this.children.push(...elements); }
  replaceChildren() { this.children = []; }
  removeAttribute(name: string) { if (name === "src") this.src = ""; }
  focus() {} scrollIntoView() {}
}
type Handler = (path: string, init: RequestInit) => Response | Promise<Response>;
async function harness(handler: Handler = () => Response.json({ success: true, items: [] }), saved?: string | Record<string, unknown>, statusFails = false) {
  const elements = new Map([...bluevTestPage.matchAll(/\sid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const el = (id: string) => elements.get(id)!;
  el("product").value = "x_premium_3m"; el("recipient").value = "tester";
  el("orderBody").hidden = true; el("pendingRequest").hidden = true;
  const storage = new Map(saved ? [["bluev-test-request", JSON.stringify(typeof saved === "string" ? { request_id: saved } : saved)]] : []);
  const calls: Array<{ path: string; init: RequestInit }> = [];
  let tick = () => {}; let ids = saved ? 1 : 0; let pendingAtFirstRead = false;
  const document = { hidden: false, getElementById: el, createElement: () => new Element() };
  const context = createContext({ document, Date, Intl, AbortSignal, Error,
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
  return { el, storage, calls, settle, qualify, document, pendingAtFirstRead, tick: async () => { tick(); await settle(); } };
}
const creates = (calls: Array<{ path: string; init: RequestInit }>) => calls.filter(call => call.path === "/orders" && call.init.method === "POST");

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
});
