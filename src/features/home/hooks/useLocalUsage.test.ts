// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalUsageSnapshot } from "../../../types";
import { useLocalUsage } from "./useLocalUsage";

const localUsageSnapshotMock = vi.fn();

vi.mock("../../../services/tauri", () => ({
  localUsageSnapshot: (...args: unknown[]) => localUsageSnapshotMock(...args),
}));

const snapshot = {
  totals: {
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
  },
  days: [],
  topModels: [],
  updatedAt: 1_700_000_000,
} as unknown as LocalUsageSnapshot;

describe("useLocalUsage", () => {
  afterEach(() => {
    vi.useRealTimers();
    localUsageSnapshotMock.mockReset();
    window.localStorage.clear();
  });

  it("defers the initial usage scan when configured for startup", async () => {
    vi.useFakeTimers();
    localUsageSnapshotMock.mockResolvedValue(snapshot);

    const { result } = renderHook(() =>
      useLocalUsage(true, null, { initialDelayMs: 800 }),
    );

    expect(localUsageSnapshotMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(799);
    });
    expect(localUsageSnapshotMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(localUsageSnapshotMock).toHaveBeenCalledWith(30, undefined);
    expect(result.current.snapshot).toBe(snapshot);
  });

  it("shows a cached snapshot while the background refresh is deferred", async () => {
    localUsageSnapshotMock.mockResolvedValue(snapshot);
    const first = renderHook(() => useLocalUsage(true, "/tmp/project"));

    await waitFor(() => {
      expect(first.result.current.snapshot).toBe(snapshot);
    });
    first.unmount();
    localUsageSnapshotMock.mockClear();

    const { result } = renderHook(() =>
      useLocalUsage(true, "/tmp/project", { initialDelayMs: 800 }),
    );

    expect(result.current.snapshot).toBe(snapshot);
    expect(localUsageSnapshotMock).not.toHaveBeenCalled();
  });

  it("hydrates a persistent cached snapshot before refreshing", () => {
    const workspacePath = "/tmp/persistent-project";
    window.localStorage.setItem(
      `codex-monitor:local-usage:v1:${workspacePath}`,
      JSON.stringify(snapshot),
    );
    localUsageSnapshotMock.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useLocalUsage(true, workspacePath));

    expect(result.current.snapshot).toEqual(snapshot);
    expect(localUsageSnapshotMock).toHaveBeenCalledWith(30, workspacePath);
  });
});
