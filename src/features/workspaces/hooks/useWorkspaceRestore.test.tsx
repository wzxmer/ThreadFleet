/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceInfo } from "@/types";
import { LOCAL_CODEX_WORKSPACE_ID } from "@/features/workspaces/domain/localCodexWorkspace";
import { useWorkspaceRestore } from "./useWorkspaceRestore";

const workspace: WorkspaceInfo = {
  id: "workspace-a",
  name: "Workspace A",
  path: "C:/workspace-a",
  connected: true,
  kind: "main",
  parentId: null,
  worktree: null,
  settings: {
    sidebarCollapsed: false,
  },
};

describe("useWorkspaceRestore", () => {
  it("waits for the initial thread list before becoming ready", async () => {
    let resolveList: (() => void) | null = null;
    const listThreadsForWorkspaces = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveList = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useWorkspaceRestore({
        workspaces: [workspace],
        hasLoaded: true,
        connectWorkspace: vi.fn().mockResolvedValue(undefined),
        listThreadsForWorkspaces,
      }),
    );

    expect(result.current).toBe(false);
    await waitFor(() => expect(listThreadsForWorkspaces).toHaveBeenCalledTimes(1));
    await act(async () => resolveList?.());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("becomes ready when there are no workspaces to restore", async () => {
    const { result } = renderHook(() =>
      useWorkspaceRestore({
        workspaces: [],
        hasLoaded: true,
        connectWorkspace: vi.fn().mockResolvedValue(undefined),
        listThreadsForWorkspaces: vi.fn().mockResolvedValue(undefined),
      }),
    );

    await waitFor(() => expect(result.current).toBe(true));
  });

  it("loads local sessions without connecting the virtual workspace", async () => {
    const connectWorkspace = vi.fn().mockRejectedValue(new Error("virtual workspace"));
    const listThreadsForWorkspaces = vi.fn().mockResolvedValue(undefined);
    const localWorkspace: WorkspaceInfo = {
      ...workspace,
      id: LOCAL_CODEX_WORKSPACE_ID,
      name: "Local sessions",
      path: "",
      connected: true,
    };

    const { result } = renderHook(() =>
      useWorkspaceRestore({
        workspaces: [localWorkspace],
        hasLoaded: true,
        connectWorkspace,
        listThreadsForWorkspaces,
      }),
    );

    await waitFor(() => expect(listThreadsForWorkspaces).toHaveBeenCalledWith(
      [localWorkspace],
      {
        maxPages: 1,
        refreshReason: "initial_restore",
        knownWorkspaces: [localWorkspace],
      },
    ));
    await waitFor(() => expect(result.current).toBe(true));
    expect(connectWorkspace).not.toHaveBeenCalled();
  });

  it("connects pending workspaces with bounded concurrency and preserves input order", async () => {
    const pending = Array.from({ length: 5 }, (_, index) => ({
      ...workspace,
      id: `workspace-${index}`,
      name: `Workspace ${index}`,
      connected: false,
    }));
    let activeConnections = 0;
    let maxActiveConnections = 0;
    const connectWorkspace = vi.fn(async (entry: WorkspaceInfo) => {
      activeConnections += 1;
      maxActiveConnections = Math.max(maxActiveConnections, activeConnections);
      await new Promise((resolve) => setTimeout(resolve, entry.id === "workspace-0" ? 20 : 1));
      activeConnections -= 1;
    });
    const listThreadsForWorkspaces = vi.fn().mockResolvedValue(undefined);

    renderHook(() =>
      useWorkspaceRestore({
        workspaces: pending,
        hasLoaded: true,
        connectWorkspace,
        listThreadsForWorkspaces,
      }),
    );

    await waitFor(() => expect(listThreadsForWorkspaces).toHaveBeenCalledTimes(1));
    expect(maxActiveConnections).toBeLessThanOrEqual(3);
    expect(listThreadsForWorkspaces.mock.calls[0]?.[0]).toEqual(
      pending.map((entry) => ({ ...entry, connected: true })),
    );
  });
});
