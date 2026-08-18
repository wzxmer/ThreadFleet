/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runManagedSessionCleanupScheduler } from "@services/tauri";
import {
  buildCleanupProtectedThreadIds,
  useSessionCleanupScheduler,
} from "./useSessionCleanupScheduler";

vi.mock("@services/tauri", () => ({
  runManagedSessionCleanupScheduler: vi.fn().mockResolvedValue({
    ran: false,
    results: [],
    successCount: 0,
    failureCount: 0,
  }),
}));

describe("useSessionCleanupScheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("protects current, processing, and pinned threads", () => {
    window.localStorage.setItem(
      "codexmonitor.pinnedThreads",
      JSON.stringify({ "workspace-a:pinned": 1 }),
    );
    expect(
      buildCleanupProtectedThreadIds("current", {
        processing: { isProcessing: true },
        idle: { isProcessing: false },
      }).sort(),
    ).toEqual(["current", "pinned", "processing"]);
  });

  it("runs one startup check after settings load", async () => {
    renderHook(() =>
      useSessionCleanupScheduler({
        settingsLoading: false,
        startupReady: true,
        enabled: true,
        activeThreadId: "current",
        threadStatusById: {},
        pinnedThreadsVersion: 0,
      }),
    );

    await waitFor(() =>
      expect(runManagedSessionCleanupScheduler).toHaveBeenCalledWith({
        protectedThreadIds: ["current"],
      }),
    );
  });

  it("stops protecting an unpinned thread on the next scheduler refresh", async () => {
    window.localStorage.setItem(
      "codexmonitor.pinnedThreads",
      JSON.stringify({ "workspace-a:pinned": 1 }),
    );
    const { rerender } = renderHook(
      ({ pinnedThreadsVersion }) =>
        useSessionCleanupScheduler({
          settingsLoading: false,
          startupReady: true,
          enabled: true,
          activeThreadId: null,
          threadStatusById: {},
          pinnedThreadsVersion,
        }),
      { initialProps: { pinnedThreadsVersion: 0 } },
    );

    await waitFor(() =>
      expect(runManagedSessionCleanupScheduler).toHaveBeenLastCalledWith({
        protectedThreadIds: ["pinned"],
      }),
    );

    window.localStorage.removeItem("codexmonitor.pinnedThreads");
    rerender({ pinnedThreadsVersion: 1 });

    await waitFor(() =>
      expect(runManagedSessionCleanupScheduler).toHaveBeenLastCalledWith({
        protectedThreadIds: [],
      }),
    );
  });

  it("waits until workspace and thread restoration completes", () => {
    renderHook(() =>
      useSessionCleanupScheduler({
        settingsLoading: false,
        startupReady: false,
        enabled: true,
        activeThreadId: "current",
        threadStatusById: {},
        pinnedThreadsVersion: 0,
      }),
    );

    expect(runManagedSessionCleanupScheduler).not.toHaveBeenCalled();
  });

  it("notifies the backend when enablement changes during the same run", async () => {
    const { rerender } = renderHook(
      ({ enabled }) =>
        useSessionCleanupScheduler({
          settingsLoading: false,
          startupReady: true,
          enabled,
          activeThreadId: null,
          threadStatusById: {},
          pinnedThreadsVersion: 0,
        }),
      { initialProps: { enabled: false } },
    );
    await waitFor(() => expect(runManagedSessionCleanupScheduler).toHaveBeenCalledTimes(1));

    await act(async () => rerender({ enabled: true }));

    await waitFor(() =>
      expect(runManagedSessionCleanupScheduler).toHaveBeenLastCalledWith({
        protectedThreadIds: [],
      }),
    );
  });
});
