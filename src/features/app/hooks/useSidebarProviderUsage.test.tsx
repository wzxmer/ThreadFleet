// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@/types";
import { useSidebarProviderUsage } from "./useSidebarProviderUsage";

const getProviderStatusMock = vi.fn();
const getWorkspaceThirdPartyKeyUsageMock = vi.fn();

vi.mock("@/services/tauri", () => ({
  getProviderStatus: (...args: unknown[]) => getProviderStatusMock(...args),
  getWorkspaceThirdPartyKeyUsage: (...args: unknown[]) =>
    getWorkspaceThirdPartyKeyUsageMock(...args),
}));

const appSettings = {
  activeCodexKeyProfileId: "profile-002",
  codexHome: null,
  codexKeyProfiles: [
    {
      id: "profile-002",
      name: "0.02",
      providerKind: "custom",
      baseUrl: "https://provider.example/v1",
    },
  ],
} as unknown as AppSettings;

describe("useSidebarProviderUsage", () => {
  beforeEach(() => {
    getProviderStatusMock.mockReset();
    getWorkspaceThirdPartyKeyUsageMock.mockReset();
    getProviderStatusMock.mockResolvedValue({
      providerName: "0.02",
      baseUrl: "https://provider.example/v1",
      source: "profile",
      isConfigured: true,
      isThirdParty: true,
      autoCompactTokenLimit: null,
      modelContextWindow: null,
      error: null,
    });
    getWorkspaceThirdPartyKeyUsageMock.mockResolvedValue({
      balanceUsd: 20,
      todayCostUsd: 2,
      totalCostUsd: null,
      spendPeriod: "today",
      averageLatencyMs: 200,
      isUnlimited: false,
      isPartial: false,
      source: "sub2",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the home account workspace when no project is active", async () => {
    const { result } = renderHook(() =>
      useSidebarProviderUsage({
        appSettings,
        activeWorkspaceId: null,
        homeAccountWorkspaceId: "home-workspace",
      }),
    );

    await waitFor(() => {
      expect(result.current.thirdPartyProviderUsage?.balanceUsd).toBe(20);
    });

    expect(getProviderStatusMock).toHaveBeenCalledWith("home-workspace");
    expect(getWorkspaceThirdPartyKeyUsageMock).toHaveBeenCalledWith(
      "home-workspace",
    );
    expect(result.current.workspaceId).toBe("home-workspace");
  });

  it("prefers the active workspace and ignores a late home response", async () => {
    let resolveHomeStatus: ((value: unknown) => void) | undefined;
    getProviderStatusMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveHomeStatus = resolve;
          }),
      )
      .mockResolvedValueOnce({
        providerName: "0.02",
        baseUrl: "https://provider.example/v1",
        source: "profile",
        isConfigured: true,
        isThirdParty: true,
        autoCompactTokenLimit: null,
        modelContextWindow: null,
        error: null,
      });

    const { result, rerender } = renderHook(
      ({ activeWorkspaceId }) =>
        useSidebarProviderUsage({
          appSettings,
          activeWorkspaceId,
          homeAccountWorkspaceId: "home-workspace",
        }),
      { initialProps: { activeWorkspaceId: null as string | null } },
    );

    rerender({ activeWorkspaceId: "active-workspace" });
    await waitFor(() => {
      expect(result.current.codexProviderStatus?.providerName).toBe("0.02");
    });

    resolveHomeStatus?.({
      providerName: "fk",
      baseUrl: "https://old.example/v1",
      source: "config",
      isConfigured: true,
      isThirdParty: true,
      autoCompactTokenLimit: null,
      modelContextWindow: null,
      error: null,
    });

    await waitFor(() => {
      expect(result.current.codexProviderStatus?.providerName).toBe("0.02");
    });
    expect(result.current.workspaceId).toBe("active-workspace");
    expect(getWorkspaceThirdPartyKeyUsageMock).toHaveBeenCalledWith(
      "active-workspace",
    );
  });

  it("refreshes usage when the active profile is edited without changing its id", async () => {
    const { rerender } = renderHook(
      ({ settings }) =>
        useSidebarProviderUsage({
          appSettings: settings,
          activeWorkspaceId: "active-workspace",
          homeAccountWorkspaceId: "home-workspace",
        }),
      { initialProps: { settings: appSettings } },
    );

    await waitFor(() => {
      expect(getWorkspaceThirdPartyKeyUsageMock).toHaveBeenCalledTimes(1);
    });

    rerender({
      settings: {
        ...appSettings,
        codexKeyProfiles: appSettings.codexKeyProfiles.map((profile) => ({
          ...profile,
          key: "updated-key",
        })),
      },
    });

    await waitFor(() => {
      expect(getWorkspaceThirdPartyKeyUsageMock).toHaveBeenCalledTimes(2);
    });
    expect(getProviderStatusMock).toHaveBeenCalledTimes(2);
  });

  it("does not refresh usage when unrelated display settings change", async () => {
    const { rerender } = renderHook(
      ({ settings }) =>
        useSidebarProviderUsage({
          appSettings: settings,
          activeWorkspaceId: "active-workspace",
          homeAccountWorkspaceId: "home-workspace",
        }),
      { initialProps: { settings: appSettings } },
    );

    await waitFor(() => {
      expect(getWorkspaceThirdPartyKeyUsageMock).toHaveBeenCalledTimes(1);
    });

    rerender({
      settings: {
        ...appSettings,
        messageReadingStyle: "cli",
        messageToolGroupsCollapsedByDefault: true,
      } as AppSettings,
    });

    await Promise.resolve();

    expect(getProviderStatusMock).toHaveBeenCalledTimes(1);
    expect(getWorkspaceThirdPartyKeyUsageMock).toHaveBeenCalledTimes(1);
  });

  it("can defer the initial provider status request for a non-critical startup surface", async () => {
    vi.useFakeTimers();

    renderHook(() =>
      useSidebarProviderUsage({
        appSettings,
        activeWorkspaceId: null,
        homeAccountWorkspaceId: "home-workspace",
        statusDelayMs: 800,
      }),
    );

    expect(getProviderStatusMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(799);
    });
    expect(getProviderStatusMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(getProviderStatusMock).toHaveBeenCalledWith("home-workspace");
  });
});
