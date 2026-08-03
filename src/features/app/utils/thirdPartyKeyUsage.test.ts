import { describe, expect, it } from "vitest";
import {
  buildThirdPartyUsageUrl,
  normalizeThirdPartyUsagePayload,
} from "./thirdPartyKeyUsage";

describe("thirdPartyKeyUsage", () => {
  it("derives the usage endpoint from the configured provider origin", () => {
    expect(buildThirdPartyUsageUrl("https://fk.k-star.net/v1")).toBe(
      "https://fk.k-star.net/v1/usage",
    );
    expect(buildThirdPartyUsageUrl("fcodex.top/api/v1")).toBe(
      "https://fcodex.top/api/v1/usage",
    );
    expect(buildThirdPartyUsageUrl("https://openrouter.ai/api/v1/")).toBe(
      "https://openrouter.ai/api/v1/usage",
    );
    expect(buildThirdPartyUsageUrl("api.deepseek.com")).toBe(
      "https://api.deepseek.com/v1/usage",
    );
  });

  it("normalizes balance and today cost from provider usage payloads", () => {
    expect(
      normalizeThirdPartyUsagePayload({
        balance: "$12.50",
        usage: {
          today: {
            actual_cost: "0.0342",
          },
          average_duration_ms: 842,
        },
      }),
    ).toEqual({
      balanceUsd: 12.5,
      todayCostUsd: 0.0342,
      totalCostUsd: null,
      spendPeriod: "today",
      averageLatencyMs: 842,
      isUnlimited: false,
      isPartial: false,
      source: null,
    });
  });

  it("falls back to remaining balance and subscription daily usage", () => {
    expect(
      normalizeThirdPartyUsagePayload({
        remaining: 8,
        subscription: {
          daily_usage_usd: 0.12,
        },
      }),
    ).toEqual({
      balanceUsd: 8,
      todayCostUsd: 0.12,
      totalCostUsd: null,
      spendPeriod: "today",
      averageLatencyMs: null,
      isUnlimited: false,
      isPartial: false,
      source: null,
    });
  });

  it("normalizes Sub2 dashboard total actual cost", () => {
    expect(
      normalizeThirdPartyUsagePayload({
        balance: "15.00",
        today_actual_cost: "0.40",
        total_actual_cost: "2.95",
      }),
    ).toEqual({
      balanceUsd: 15,
      todayCostUsd: 0.4,
      totalCostUsd: 2.95,
      spendPeriod: "today",
      averageLatencyMs: null,
      isUnlimited: false,
      isPartial: false,
      source: null,
    });
  });

  it("normalizes a New API total-cost fallback snapshot", () => {
    expect(
      normalizeThirdPartyUsagePayload({
        source: "new-api",
        balanceUsd: 2.5,
        todayCostUsd: null,
        totalCostUsd: 0.5,
        spendPeriod: "total",
        averageLatencyMs: null,
        isUnlimited: false,
        isPartial: true,
      }),
    ).toEqual({
      source: "new-api",
      balanceUsd: 2.5,
      todayCostUsd: null,
      totalCostUsd: 0.5,
      spendPeriod: "total",
      averageLatencyMs: null,
      isUnlimited: false,
      isPartial: true,
    });
  });

  it("preserves whether a New API balance is an account balance", () => {
    expect(
      normalizeThirdPartyUsagePayload({
        source: "new-api",
        balanceUsd: 7.5,
        balanceScope: "account",
        todayCostUsd: 1.25,
        totalCostUsd: 3.5,
        spendPeriod: "today",
        averageLatencyMs: 1200,
        isUnlimited: false,
        isPartial: false,
      }),
    ).toEqual({
      source: "new-api",
      balanceUsd: 7.5,
      balanceScope: "account",
      todayCostUsd: 1.25,
      totalCostUsd: 3.5,
      spendPeriod: "today",
      averageLatencyMs: 1200,
      isUnlimited: false,
      isPartial: false,
    });
  });

  it("accepts page-scanned balance and total usage snapshots", () => {
    expect(
      normalizeThirdPartyUsagePayload({
        source: "page",
        balanceUsd: 1.29,
        todayCostUsd: null,
        totalCostUsd: 9.8,
        isUnlimited: false,
        isPartial: false,
      }),
    ).toEqual({
      source: "page",
      balanceUsd: 1.29,
      todayCostUsd: null,
      totalCostUsd: 9.8,
      spendPeriod: "total",
      averageLatencyMs: null,
      isUnlimited: false,
      isPartial: false,
    });
  });
});
