// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceInfo } from "../../../types";
import { useThreadListActions } from "./useThreadListActions";

function workspace(id: string, connected: boolean): WorkspaceInfo {
  return {
    id,
    name: id,
    path: `/tmp/${id}`,
    connected,
    settings: { sidebarCollapsed: false },
  };
}

describe("useThreadListActions", () => {
  it("reloads workspace histories even when the Codex connection fails", async () => {
    const stale = [workspace("stale", true)];
    const fresh = [workspace("one", true), workspace("two", false), workspace("three", true)];
    const refreshWorkspaces = vi.fn(async () => fresh);
    const listThreadsForWorkspaces = vi.fn(async () => {});
    const resetWorkspaceThreads = vi.fn();

    const { result } = renderHook(() =>
      useThreadListActions({
        threadListSortKey: "updated_at",
        setThreadListSortKey: vi.fn(),
        workspaces: stale,
        refreshWorkspaces,
        connectWorkspace: vi.fn().mockRejectedValue(new Error("offline")),
        listThreadsForWorkspaces,
        resetWorkspaceThreads,
      }),
    );

    await act(async () => {
      await result.current.handleRefreshAllWorkspaceThreads();
    });

    expect(refreshWorkspaces).toHaveBeenCalledTimes(1);
    expect(resetWorkspaceThreads).toHaveBeenCalledTimes(3);
    expect(resetWorkspaceThreads).toHaveBeenNthCalledWith(1, "one");
    expect(resetWorkspaceThreads).toHaveBeenNthCalledWith(2, "two");
    expect(resetWorkspaceThreads).toHaveBeenNthCalledWith(3, "three");
    expect(listThreadsForWorkspaces).toHaveBeenCalledTimes(1);
    expect(listThreadsForWorkspaces).toHaveBeenCalledWith(
      fresh,
      { refreshReason: "manual_refresh" },
    );
  });

  it("falls back to current workspaces when refresh fails", async () => {
    const current = [workspace("one", true), workspace("two", false)];
    const refreshWorkspaces = vi.fn(async () => undefined);
    const listThreadsForWorkspaces = vi.fn(async () => {});
    const resetWorkspaceThreads = vi.fn();

    const { result } = renderHook(() =>
      useThreadListActions({
        threadListSortKey: "updated_at",
        setThreadListSortKey: vi.fn(),
        workspaces: current,
        refreshWorkspaces,
        connectWorkspace: vi.fn().mockRejectedValue(new Error("offline")),
        listThreadsForWorkspaces,
        resetWorkspaceThreads,
      }),
    );

    await act(async () => {
      await result.current.handleRefreshAllWorkspaceThreads();
    });

    expect(refreshWorkspaces).toHaveBeenCalledTimes(1);
    expect(resetWorkspaceThreads).toHaveBeenCalledTimes(2);
    expect(resetWorkspaceThreads).toHaveBeenNthCalledWith(1, "one");
    expect(resetWorkspaceThreads).toHaveBeenNthCalledWith(2, "two");
    expect(listThreadsForWorkspaces).toHaveBeenCalledTimes(1);
    expect(listThreadsForWorkspaces).toHaveBeenCalledWith(
      current,
      { refreshReason: "manual_refresh" },
    );
  });

  it("reconnects disconnected workspaces before listing their threads", async () => {
    const disconnected = workspace("one", false);
    const refreshWorkspaces = vi.fn(async () => [disconnected]);
    const connectWorkspace = vi.fn(async () => {});
    const listThreadsForWorkspaces = vi.fn(async () => {});
    const resetWorkspaceThreads = vi.fn();

    const { result } = renderHook(() =>
      useThreadListActions({
        threadListSortKey: "updated_at",
        setThreadListSortKey: vi.fn(),
        workspaces: [disconnected],
        refreshWorkspaces,
        connectWorkspace,
        listThreadsForWorkspaces,
        resetWorkspaceThreads,
      }),
    );

    await act(async () => {
      await result.current.handleRefreshAllWorkspaceThreads();
    });

    expect(connectWorkspace).toHaveBeenCalledWith(disconnected);
    expect(resetWorkspaceThreads).toHaveBeenCalledWith("one");
    expect(listThreadsForWorkspaces).toHaveBeenCalledWith(
      [{ ...disconnected, connected: true }],
      { refreshReason: "manual_refresh" },
    );
  });

  it("marks a sort change when reloading connected workspace threads", () => {
    const listThreadsForWorkspaces = vi.fn(async () => {});
    const { result } = renderHook(() =>
      useThreadListActions({
        threadListSortKey: "updated_at",
        setThreadListSortKey: vi.fn(),
        workspaces: [workspace("one", true)],
        refreshWorkspaces: vi.fn().mockResolvedValue([]),
        connectWorkspace: vi.fn(),
        listThreadsForWorkspaces,
        resetWorkspaceThreads: vi.fn(),
      }),
    );

    act(() => {
      result.current.handleSetThreadListSortKey("created_at");
    });

    expect(listThreadsForWorkspaces).toHaveBeenCalledWith(
      [workspace("one", true)],
      { sortKey: "created_at", refreshReason: "sort_change" },
    );
  });
});
