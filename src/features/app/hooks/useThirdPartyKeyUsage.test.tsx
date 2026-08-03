// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThirdPartyKeyUsage } from "./useThirdPartyKeyUsage";

const getWorkspaceThirdPartyKeyUsageMock = vi.fn();
const usageSnapshot = {
  balanceUsd: 12.5,
  todayCostUsd: 1.25,
  totalCostUsd: null,
  spendPeriod: "today" as const,
  averageLatencyMs: 842,
  isUnlimited: false,
  isPartial: false,
  source: "sub2" as const,
};

vi.mock("@/services/tauri", () => ({
  getWorkspaceThirdPartyKeyUsage: (...args: unknown[]) =>
    getWorkspaceThirdPartyKeyUsageMock(...args),
}));

describe("useThirdPartyKeyUsage", () => {
  const flushPromises = async () => {
    await act(async () => {
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    getWorkspaceThirdPartyKeyUsageMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads usage for a configured third-party workspace", async () => {
    getWorkspaceThirdPartyKeyUsageMock.mockResolvedValue(usageSnapshot);

    const { result } = renderHook(() =>
      useThirdPartyKeyUsage({ enabled: true, workspaceId: "ws-usage" }),
    );

    await flushPromises();

    expect(result.current).toEqual(usageSnapshot);
    expect(getWorkspaceThirdPartyKeyUsageMock).toHaveBeenCalledWith("ws-usage");
  });

  it("does not require an app key profile", async () => {
    getWorkspaceThirdPartyKeyUsageMock.mockResolvedValue(null);

    renderHook(() =>
      useThirdPartyKeyUsage({ enabled: true, workspaceId: "ws-default-provider" }),
    );

    await flushPromises();

    expect(getWorkspaceThirdPartyKeyUsageMock).toHaveBeenCalledWith(
      "ws-default-provider",
    );
  });

  it("refreshes usage every minute", async () => {
    getWorkspaceThirdPartyKeyUsageMock.mockResolvedValue(null);

    renderHook(() =>
      useThirdPartyKeyUsage({ enabled: true, workspaceId: "ws-usage" }),
    );

    await flushPromises();

    expect(getWorkspaceThirdPartyKeyUsageMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(getWorkspaceThirdPartyKeyUsageMock).toHaveBeenCalledTimes(2);
  });

  it("retains a Cookie balance when refresh returns Key spend only", async () => {
    getWorkspaceThirdPartyKeyUsageMock
      .mockResolvedValueOnce({
        source: "page",
        balanceUsd: 1.29,
        todayCostUsd: null,
        totalCostUsd: 9.8,
        spendPeriod: "total",
        averageLatencyMs: null,
        isUnlimited: false,
        isPartial: true,
      })
      .mockResolvedValueOnce({
        source: "new-api",
        balanceUsd: null,
        todayCostUsd: 0.5327,
        totalCostUsd: null,
        spendPeriod: "today",
        averageLatencyMs: 9440,
        isUnlimited: true,
        isPartial: false,
      });

    const { result } = renderHook(() =>
      useThirdPartyKeyUsage({ enabled: true, workspaceId: "ws-usage" }),
    );

    await flushPromises();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(result.current).toEqual({
      source: "new-api",
      balanceUsd: 1.29,
      balanceScope: "account",
      todayCostUsd: 0.5327,
      totalCostUsd: 9.8,
      spendPeriod: "today",
      averageLatencyMs: 9440,
      isUnlimited: false,
      isPartial: false,
    });
  });

  it("ignores a stale response after the active profile changes", async () => {
    let resolveOldRequest: ((value: unknown) => void) | undefined;
    getWorkspaceThirdPartyKeyUsageMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOldRequest = resolve;
          }),
      )
      .mockResolvedValueOnce({
        ...usageSnapshot,
        balanceUsd: 20,
        todayCostUsd: 2,
        averageLatencyMs: 200,
      });

    const { result, rerender } = renderHook(
      ({ profileId }) =>
        useThirdPartyKeyUsage({
          enabled: true,
          workspaceId: "ws-usage",
          profileId,
        }),
      { initialProps: { profileId: "fk" } },
    );

    rerender({ profileId: "0.02" });
    await flushPromises();
    expect(result.current).toEqual({
      ...usageSnapshot,
      balanceUsd: 20,
      todayCostUsd: 2,
      averageLatencyMs: 200,
    });

    resolveOldRequest?.({
      ...usageSnapshot,
      balanceUsd: 13,
      todayCostUsd: 3,
      averageLatencyMs: 900,
    });
    await flushPromises();

    expect(result.current).toEqual({
      ...usageSnapshot,
      balanceUsd: 20,
      todayCostUsd: 2,
      averageLatencyMs: 200,
    });
    expect(getWorkspaceThirdPartyKeyUsageMock).toHaveBeenCalledTimes(2);
  });
});
