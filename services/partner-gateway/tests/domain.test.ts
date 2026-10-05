import { describe, expect, it } from "vitest";
import { mapUpstreamFailure, mapZovoStatus, maskEmail, moneyToCents } from "../src/domain.js";
import { signPlatformWebhook } from "../src/security.js";

describe("domain mappings", () => {
  it("maps Zovo terminal and processing states", () => {
    expect(mapZovoStatus("completed")).toBe("success");
    expect(mapZovoStatus("declined")).toBe("failed");
    expect(mapZovoStatus("failed_precharge")).toBe("failed");
    expect(mapZovoStatus("queued")).toBe("queued");
    expect(mapZovoStatus("review")).toBe("running");
  });

  it("maps upstream failures without exposing upstream messages", () => {
    expect(mapUpstreamFailure("GPT_SESSION_INVALID")).toBe("session_invalid");
    expect(mapUpstreamFailure("GPT_PLAN_ALREADY_ACTIVE")).toBe("account_has_subscription");
    expect(mapUpstreamFailure("GPT_IOS_PLUS_SUBSCRIPTION_CONFLICT")).toBe("account_has_subscription");
    expect(mapUpstreamFailure("GPT_ACCOUNT_NOT_ELIGIBLE")).toBe("account_not_eligible");
    expect(mapUpstreamFailure("IOS_SUBSCRIPTION_WINDOW")).toBe("account_not_eligible");
    expect(mapUpstreamFailure(undefined,"failed_precharge","external_subscription")).toBe("account_has_subscription");
    expect(mapUpstreamFailure(undefined, "declined")).toBe("payment_blocked");
    expect(mapUpstreamFailure("something_new")).toBe("other");
  });

  it("handles money and masks email", () => {
    expect(moneyToCents("139.00")).toBe(13_900);
    expect(maskEmail("buyer@example.com")).toBe("b***r@example.com");
    expect(() => moneyToCents("139")).toThrow();
  });
});

describe("platform webhook signature", () => {
  it("matches the official test vector from the platform document", () => {
    const body = '{"event":"order.paid","order_id":"UP20260920121530A1B2","client_order_id":"po_abc"}';
    expect(signPlatformWebhook("whsec_test_vector", 1758300000, body)).toBe(
      "t=1758300000,v1=48bc46c969d8a4c0750178e62d899b0c835d867471fca6d627469863ffbc88e9",
    );
  });
});
