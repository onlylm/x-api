import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { CURRENT_STANDARD_COST_USD } from "../src/services/financial-ledger.js";

describe("Pro 50x catalog", () => {
  it("publishes the verified upstream plan at the configured CNY floor", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    });
    const product = config.products.find((item) => item.product === "chatgpt_pro_50x_1m");

    expect(product).toMatchObject({
      plan: "pro_50x",
      internal_cost_cny: "3250.00",
      cost_price: "3250.00",
      enabled: true,
    });
    expect(CURRENT_STANDARD_COST_USD.pro_50x).toBe("465.47");
  });
});
