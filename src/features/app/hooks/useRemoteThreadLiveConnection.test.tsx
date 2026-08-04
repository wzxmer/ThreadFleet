// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectRemoteEventGapRecoveryTargets,
  useRemoteThreadLiveConnection,
} from "./useRemoteThreadLiveConnection";

const appServerListeners = new Set<(event: any) => void>();
const remoteBackendEventGapListeners = new Set<(event: any) => void>();
const subscribeAppServerEventsMock = vi.fn((listener: (event: any) => void) => {
  appServerListeners.add(listener);
  return () => {
    appServerListeners.delete(listener);
  };
});
const subscribeRemoteBackendEventGapMock = vi.fn((listener: (event: any) => void) => {
  remoteBackendEventGapListeners.add(listener);
  return () => {
    remoteBackendEventGapListeners.delete(listener);
  };
});

const threadLiveSubscribeMock = vi.fn().mockResolvedValue(undefined);
const threadLiveUnsubscribeMock = vi.fn().mockResolvedValue(undefined);
const pushErrorToastMock = vi.fn();

vi.mock("@services/events", () => ({
  subscribeAppServerEvents: (listener: (event: any) => void) =>
    subscribeAppServerEventsMock(listener),
  subscribeRemoteBackendEventGap: (listener: (event: any) => void) =>
    subscribeRemoteBackendEventGapMock(listener),
}));

vi.mock("@services/tauri", () => ({
  threadLiveSubscribe: (...args: any[]) => threadLiveSubscribeMock(...args),
  threadLiveUnsubscribe: (...args: any[]) => threadLiveUnsubscribeMock(...args),
}));

vi.mock("@services/toasts", () => ({
  pushErrorToast: (...args: any[]) => pushErrorToastMock(...args),
}));

vi.mock("@utils/appServerEvents", () => ({
  getAppServerRawMethod: (event: any) => event.method ?? null,
  getAppServerParams: (event: any) => event.params ?? {},
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    listen: vi.fn().mockResolvedValue(() => {}),
  }),
}));

describe("useRemoteThreadLiveConnection", () => {
  let visibilityState: DocumentVisibilityState;
  let hasFocus: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-19T00:00:00.000Z"));
    visibilityState = "visible";
    hasFocus = true;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => hasFocus,
    });
    appServerListeners.clear();
    remoteBackendEventGapListeners.clear();
    subscribeAppServerEventsMock.mockClear();
    subscribeRemoteBackendEventGapMock.mockClear();
    threadLiveSubscribeMock.mockClear();
    threadLiveUnsubscribeMock.mockClear();
    pushErrorToastMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collects resident and active background threads across connected workspaces", () => {
    const targets = collectRemoteEventGapRecoveryTargets({
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace 1",
          path: "/tmp/ws-1",
          connected: true,
          settings: { sidebarCollapsed: false },
        },
        {
          id: "ws-2",
          name: "Workspace 2",
          path: "/tmp/ws-2",
          connected: true,
          settings: { sidebarCollapsed: false },
        },
        {
          id: "ws-offline",
          name: "Offline",
          path: "/tmp/offline",
          connected: false,
          settings: { sidebarCollapsed: false },
        },
      ],
      threadsByWorkspace: {
        "ws-1": [
          { id: "thread-active" },
          { id: "thread-resident" },
          { id: "thread-idle" },
        ],
        "ws-2": [
          { id: "thread-processing" },
          { id: "thread-reviewing" },
          { id: "thread-active-turn" },
        ],
        "ws-offline": [{ id: "thread-offline" }],
      },
      itemsByThread: {
        "thread-active": [],
        "thread-resident": [],
        "thread-offline": [],
      },
      threadStatusById: {
        "thread-processing": { isProcessing: true },
        "thread-reviewing": { isReviewing: true },
      },
      activeTurnIdByThread: {
        "thread-active-turn": "turn-1",
      },
      activeWorkspaceId: "ws-1",
      activeThreadId: "thread-active",
    });

    expect(targets).toEqual([
      { workspaceId: "ws-1", threadId: "thread-resident" },
      { workspaceId: "ws-2", threadId: "thread-processing" },
      { workspaceId: "ws-2", threadId: "thread-reviewing" },
      { workspaceId: "ws-2", threadId: "thread-active-turn" },
    ]);
  });

  it("does not reconnect during normal idle period without detach signal", async () => {
    const refreshThread = vi.fn().mockResolvedValue(undefined);

    renderHook(() =>
      useRemoteThreadLiveConnection({
        backendMode: "remote",
        activeWorkspace: {
          id: "ws-1",
          name: "Workspace",
          path: "/tmp/ws-1",
          connected: true,
          settings: { sidebarCollapsed: false },
        },
        activeThreadId: "thread-1",
        refreshThread,
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(threadLiveSubscribeMock).toHaveBeenCalledTimes(1);
    expect(refreshThread).toHaveBeenCalledTimes(0);

    const heartbeatEvent = {
      workspace_id: "ws-1",
      method: "thread/live_heartbeat",
      params: { threadId: "thread-1" },
    };
    await act(async () => {
      for (const listener of appServerListeners) {
        listener(heartbeatEvent);
      }
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(25_000);
      await Promise.resolve();
    });

    expect(threadLiveSubscribeMock).toHaveBeenCalledTimes(1);
    expect(threadLiveUnsubscribeMock).toHaveBeenCalledTimes(0);
    expect(refreshThread).toHaveBeenCalledTimes(0);
    expect(pushErrorToastMock).not.toHaveBeenCalled();
  });

  it("reconnects when thread live stream detaches while visible", async () => {
    const refreshThread = vi.fn().mockResolvedValue(undefined);

    renderHook(() =>
      useRemoteThreadLiveConnection({
        backendMode: "remote",
        activeWorkspace: {
          id: "ws-1",
          name: "Workspace",
          path: "/tmp/ws-1",
          connected: true,
          settings: { sidebarCollapsed: false },
        },
        activeThreadId: "thread-1",
        refreshThread,
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(threadLiveSubscribeMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      for (const listener of appServerListeners) {
        listener({
          workspace_id: "ws-1",
          method: "thread/live_detached",
          params: { threadId: "thread-1" },
        });
      }
      await Promise.resolve();
    });

    expect(threadLiveSubscribeMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(refreshThread.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("hydrates and reattaches after the remote backend transport disconnects", async () => {
    const refreshThread = vi.fn().mockResolvedValue(undefined);

    renderHook(() =>
      useRemoteThreadLiveConnection({
        backendMode: "remote",
        activeWorkspace: {
          id: "ws-1",
          name: "Workspace",
          path: "/tmp/ws-1",
          connected: true,
          settings: { sidebarCollapsed: false },
        },
        activeThreadId: "thread-1",
        activeThreadHasLocalSnapshot: true,
        activeThreadIsProcessing: true,
        refreshThread,
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(threadLiveSubscribeMock).toHaveBeenCalledTimes(1);
    expect(refreshThread).toHaveBeenCalledTimes(0);

    await act(async () => {
      for (const listener of remoteBackendEventGapListeners) {
        listener({ reason: "disconnected" });
      }
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refreshThread).toHaveBeenCalledTimes(1);
    expect(threadLiveSubscribeMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("waits for connection-wide recovery before hydrating the active thread", async () => {
    let resolveConnectionRecovery: () => void = () => {};
    const recoverEventGap = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConnectionRecovery = resolve;
        }),
    );
    const refreshThread = vi.fn().mockResolvedValue(undefined);

    renderHook(() =>
      useRemoteThreadLiveConnection({
        backendMode: "remote",
        activeWorkspace: {
          id: "ws-1",
          name: "Workspace",
          path: "/tmp/ws-1",
          connected: true,
          settings: { sidebarCollapsed: false },
        },
        activeThreadId: "thread-1",
        activeThreadHasLocalSnapshot: true,
        activeThreadIsProcessing: true,
        refreshThread,
        recoverEventGap,
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      for (const listener of remoteBackendEventGapListeners) {
        listener({ reason: "lagged", skipped: 2 });
      }
      await Promise.resolve();
    });

    expect(recoverEventGap).toHaveBeenCalledTimes(1);
    expect(refreshThread).not.toHaveBeenCalled();

    await act(async () => {
      resolveConnectionRecovery();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refreshThread).toHaveBeenCalledWith("ws-1", "thread-1");
  });

  it("retries while connection-wide event-gap recovery remains unresolved", async () => {
    const recoverEventGap = vi
      .fn()
      .mockRejectedValueOnce(new Error("workspace list unavailable"))
      .mockResolvedValue(undefined);
    const refreshThread = vi.fn().mockResolvedValue(undefined);

    renderHook(() =>
      useRemoteThreadLiveConnection({
        backendMode: "remote",
        activeWorkspace: {
          id: "ws-1",
          name: "Workspace",
          path: "/tmp/ws-1",
          connected: true,
          settings: { sidebarCollapsed: false },
        },
        activeThreadId: "thread-1",
        activeThreadHasLocalSnapshot: true,
        activeThreadIsProcessing: true,
        refreshThread,
        recoverEventGap,
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      for (const listener of remoteBackendEventGapListeners) {
        listener({ reason: "disconnected" });
      }
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(recoverEventGap).toHaveBeenCalledTimes(1);
    expect(refreshThread).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(recoverEventGap).toHaveBeenCalledTimes(2);
    expect(refreshThread).toHaveBeenCalledTimes(2);
  });

  it("runs connection-wide recovery without an active thread selection", async () => {
    const recoverEventGap = vi.fn().mockResolvedValue(undefined);
    const refreshThread = vi.fn().mockResolvedValue(undefined);

    renderHook(() =>
      useRemoteThreadLiveConnection({
        backendMode: "remote",
        activeWorkspace: {
          id: "ws-1",
          name: "Workspace",
          path: "/tmp/ws-1",
          connected: true,
          settings: { sidebarCollapsed: false },
        },
        activeThreadId: null,
        refreshThread,
        recoverEventGap,
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      for (const listener of remoteBackendEventGapListeners) {
        listener({ reason: "disconnected" });
      }
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(recoverEventGap).toHaveBeenCalledTimes(1);
    expect(refreshThread).not.toHaveBeenCalled();
    expect(threadLiveSubscribeMock).not.toHaveBeenCalled();
  });

  it("hydrates a terminal thread after an event gap without reattaching live updates", async () => {
    const refreshThread = vi.fn().mockResolvedValue(undefined);

    renderHook(() =>
      useRemoteThreadLiveConnection({
        backendMode: "remote",
        activeWorkspace: {
          id: "ws-1",
          name: "Workspace",
          path: "/tmp/ws-1",
          connected: true,
          settings: { sidebarCollapsed: false },
        },
        activeThreadId: "thread-1",
        activeThreadNeedsLiveConnection: false,
        refreshThread,
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(threadLiveSubscribeMock).not.toHaveBeenCalled();

    await act(async () => {
      for (const listener of remoteBackendEventGapListeners) {
        listener({ reason: "lagged", skipped: 2 });
      }
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refreshThread).toHaveBeenCalledTimes(1);
    expect(threadLiveSubscribeMock).not.toHaveBeenCalled();
  });

  it("retries recovery while a confirmed remote event gap remains unresolved", async () => {
    const refreshThread = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(undefined);

    renderHook(() =>
      useRemoteThreadLiveConnection({
        backendMode: "remote",
        activeWorkspace: {
          id: "ws-1",
          name: "Workspace",
          path: "/tmp/ws-1",
          connected: true,
          settings: { sidebarCollapsed: false },
        },
        activeThreadId: "thread-1",
        activeThreadHasLocalSnapshot: true,
        activeThreadIsProcessing: true,
        refreshThread,
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      for (const listener of remoteBackendEventGapListeners) {
        listener({ reason: "disconnected" });
      }
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(refreshThread).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refreshThread).toHaveBeenCalledTimes(2);
    expect(threadLiveSubscribeMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("cancels event-gap recovery when remote live state is no longer desired", async () => {
    let resolveRefresh: () => void = () => {};
    const refreshThread = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const workspace = {
      id: "ws-1",
      name: "Workspace",
      path: "/tmp/ws-1",
      connected: true,
      settings: { sidebarCollapsed: false },
    };

    const { rerender } = renderHook(
      ({ backendMode }) =>
        useRemoteThreadLiveConnection({
          backendMode,
          activeWorkspace: workspace,
          activeThreadId: "thread-1",
          activeThreadHasLocalSnapshot: true,
          activeThreadIsProcessing: true,
          refreshThread,
        }),
      { initialProps: { backendMode: "remote" } },
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(threadLiveSubscribeMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      for (const listener of remoteBackendEventGapListeners) {
        listener({ reason: "disconnected" });
      }
      await Promise.resolve();
    });
    expect(refreshThread).toHaveBeenCalledTimes(1);

    rerender({ backendMode: "local" });
    await act(async () => {
      resolveRefresh();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(threadLiveSubscribeMock).toHaveBeenCalledTimes(1);
  });

  it("cancels stale event-gap retry after switching remote threads", async () => {
    let resolveRefresh: () => void = () => {};
    const refreshThread = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveRefresh = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const workspace = {
      id: "ws-1",
      name: "Workspace",
      path: "/tmp/ws-1",
      connected: true,
      settings: { sidebarCollapsed: false },
    };

    const { rerender } = renderHook(
      ({ threadId }) =>
        useRemoteThreadLiveConnection({
          backendMode: "remote",
          activeWorkspace: workspace,
          activeThreadId: threadId,
          activeThreadHasLocalSnapshot: true,
          activeThreadIsProcessing: true,
          refreshThread,
        }),
      { initialProps: { threadId: "thread-1" } },
    );

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      for (const listener of remoteBackendEventGapListeners) {
        listener({ reason: "disconnected" });
      }
      await Promise.resolve();
    });
    expect(refreshThread).toHaveBeenCalledWith("ws-1", "thread-1");

    await act(async () => {
      rerender({ threadId: "thread-2" });
      await Promise.resolve();
    });

    await act(async () => {
      resolveRefresh();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refreshThread).toHaveBeenCalledTimes(1);
  });

  it("reattaches without resume hydration when a processing thread already has a local snapshot", async () => {
    const refreshThread = vi.fn().mockResolvedValue(undefined);

    renderHook(() =>
      useRemoteThreadLiveConnection({
        backendMode: "remote",
        activeWorkspace: {
          id: "ws-1",
          name: "Workspace",
          path: "/tmp/ws-1",
          connected: true,
          settings: { sidebarCollapsed: false },
        },
        activeThreadId: "thread-1",
        activeThreadHasLocalSnapshot: true,
        activeThreadIsProcessing: true,
        refreshThread,
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(threadLiveSubscribeMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      for (const listener of appServerListeners) {
        listener({
          workspace_id: "ws-1",
          method: "thread/live_detached",
          params: { threadId: "thread-1" },
        });
      }
      await Promise.resolve();
    });

    expect(threadLiveSubscribeMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(refreshThread).toHaveBeenCalledTimes(0);
  });

  it("does not reconnect detached stream when window is not focused", async () => {
    const refreshThread = vi.fn().mockResolvedValue(undefined);

    renderHook(() =>
      useRemoteThreadLiveConnection({
        backendMode: "remote",
        activeWorkspace: {
          id: "ws-1",
          name: "Workspace",
          path: "/tmp/ws-1",
          connected: true,
          settings: { sidebarCollapsed: false },
        },
        activeThreadId: "thread-1",
        refreshThread,
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(threadLiveSubscribeMock).toHaveBeenCalledTimes(1);

    hasFocus = false;
    await act(async () => {
      for (const listener of appServerListeners) {
        listener({
          workspace_id: "ws-1",
          method: "thread/live_detached",
          params: { threadId: "thread-1" },
        });
      }
      await Promise.resolve();
    });

    expect(threadLiveSubscribeMock).toHaveBeenCalledTimes(1);
  });

  it("keeps live state on thread activity without heartbeat", async () => {
    const refreshThread = vi.fn().mockResolvedValue(undefined);
    const workspace = {
      id: "ws-1",
      name: "Workspace",
      path: "/tmp/ws-1",
      connected: true,
      settings: { sidebarCollapsed: false },
    };

    const { result } = renderHook(() =>
      useRemoteThreadLiveConnection({
        backendMode: "remote",
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        refreshThread,
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.connectionState).toBe("live");

    await act(async () => {
      for (const listener of appServerListeners) {
        listener({
          workspace_id: "ws-1",
          method: "item/started",
          params: { threadId: "thread-1" },
        });
      }
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.connectionState).toBe("live");
  });

  it("cleans up stale reconnect subscribe when sequence advances", async () => {
    let resolveFirstSubscribe: (() => void) | null = null;
    const firstSubscribe = new Promise<void>((resolve) => {
      resolveFirstSubscribe = resolve;
    });
    threadLiveSubscribeMock
      .mockImplementationOnce(() => firstSubscribe)
      .mockResolvedValue(undefined);
    const refreshThread = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useRemoteThreadLiveConnection({
        backendMode: "remote",
        activeWorkspace: {
          id: "ws-1",
          name: "Workspace",
          path: "/tmp/ws-1",
          connected: true,
          settings: { sidebarCollapsed: false },
        },
        activeThreadId: null,
        refreshThread,
      }),
    );

    let firstReconnectPromise: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      firstReconnectPromise = result.current.reconnectLive("ws-1", "thread-1", {
        runResume: false,
      });
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.reconnectLive("ws-1", "thread-2", { runResume: false });
      await Promise.resolve();
    });

    await act(async () => {
      resolveFirstSubscribe?.();
      await firstReconnectPromise;
      await Promise.resolve();
    });

    expect(threadLiveUnsubscribeMock).toHaveBeenCalledWith("ws-1", "thread-1");
  });

  it("coalesces same-key reconnect while subscribe is in flight", async () => {
    let resolveFirstSubscribe: (() => void) | null = null;
    const firstSubscribe = new Promise<void>((resolve) => {
      resolveFirstSubscribe = resolve;
    });
    threadLiveSubscribeMock
      .mockImplementationOnce(() => firstSubscribe)
      .mockResolvedValue(undefined);
    const refreshThread = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useRemoteThreadLiveConnection({
        backendMode: "remote",
        activeWorkspace: {
          id: "ws-1",
          name: "Workspace",
          path: "/tmp/ws-1",
          connected: true,
          settings: { sidebarCollapsed: false },
        },
        activeThreadId: null,
        refreshThread,
      }),
    );

    let firstReconnectPromise: Promise<boolean> = Promise.resolve(false);
    let secondReconnectPromise: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      firstReconnectPromise = result.current.reconnectLive("ws-1", "thread-1", {
        runResume: false,
      });
      await Promise.resolve();
    });

    await act(async () => {
      secondReconnectPromise = result.current.reconnectLive("ws-1", "thread-1", {
        runResume: false,
      });
      await Promise.resolve();
    });
    expect(threadLiveSubscribeMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirstSubscribe?.();
      await firstReconnectPromise;
      await secondReconnectPromise;
      await Promise.resolve();
    });

    expect(threadLiveUnsubscribeMock).not.toHaveBeenCalled();
  });

  it("cancels in-flight reconnect attempt when window blurs", async () => {
    let resolveFirstSubscribe: (() => void) | null = null;
    const firstSubscribe = new Promise<void>((resolve) => {
      resolveFirstSubscribe = resolve;
    });
    threadLiveSubscribeMock.mockImplementationOnce(() => firstSubscribe);
    const refreshThread = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useRemoteThreadLiveConnection({
        backendMode: "remote",
        activeWorkspace: {
          id: "ws-1",
          name: "Workspace",
          path: "/tmp/ws-1",
          connected: true,
          settings: { sidebarCollapsed: false },
        },
        activeThreadId: null,
        refreshThread,
      }),
    );

    await act(async () => {
      result.current.reconnectLive("ws-1", "thread-1", { runResume: false });
      await Promise.resolve();
    });

    await act(async () => {
      window.dispatchEvent(new Event("blur"));
      await Promise.resolve();
    });

    await act(async () => {
      resolveFirstSubscribe?.();
      await Promise.resolve();
    });

    expect(threadLiveUnsubscribeMock).toHaveBeenCalledWith("ws-1", "thread-1");
  });

  it("starts a fresh reconnect after blur cancels same-key in-flight attempt", async () => {
    let resolveFirstSubscribe: (() => void) | null = null;
    const firstSubscribe = new Promise<void>((resolve) => {
      resolveFirstSubscribe = resolve;
    });
    threadLiveSubscribeMock
      .mockImplementationOnce(() => firstSubscribe)
      .mockResolvedValue(undefined);
    const refreshThread = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useRemoteThreadLiveConnection({
        backendMode: "remote",
        activeWorkspace: {
          id: "ws-1",
          name: "Workspace",
          path: "/tmp/ws-1",
          connected: true,
          settings: { sidebarCollapsed: false },
        },
        activeThreadId: null,
        refreshThread,
      }),
    );

    let firstReconnectPromise: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      firstReconnectPromise = result.current.reconnectLive("ws-1", "thread-1", {
        runResume: false,
      });
      await Promise.resolve();
    });
    expect(threadLiveSubscribeMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event("blur"));
      await Promise.resolve();
    });

    let secondReconnectPromise: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      secondReconnectPromise = result.current.reconnectLive("ws-1", "thread-1", {
        runResume: false,
      });
      await Promise.resolve();
    });
    expect(threadLiveSubscribeMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await expect(secondReconnectPromise).resolves.toBe(true);
    });

    await act(async () => {
      resolveFirstSubscribe?.();
      await expect(firstReconnectPromise).resolves.toBe(false);
      await Promise.resolve();
    });
  });

  it("does not reconnect when workspace object identity changes but key is unchanged", async () => {
    const refreshThread = vi.fn().mockResolvedValue(undefined);
    const firstWorkspace = {
      id: "ws-1",
      name: "Workspace",
      path: "/tmp/ws-1",
      connected: true,
      settings: { sidebarCollapsed: false },
    };

    const { rerender } = renderHook(
      ({ workspace }) =>
        useRemoteThreadLiveConnection({
          backendMode: "remote",
          activeWorkspace: workspace,
          activeThreadId: "thread-1",
          refreshThread,
        }),
      {
        initialProps: { workspace: firstWorkspace },
      },
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(threadLiveSubscribeMock).toHaveBeenCalledTimes(1);
    expect(refreshThread).toHaveBeenCalledTimes(0);

    const secondWorkspace = {
      id: "ws-1",
      name: "Workspace (renamed)",
      path: "/tmp/ws-1",
      connected: true,
      settings: { sidebarCollapsed: false },
    };

    await act(async () => {
      rerender({ workspace: secondWorkspace });
      await Promise.resolve();
    });

    expect(threadLiveSubscribeMock).toHaveBeenCalledTimes(1);
    expect(threadLiveUnsubscribeMock).toHaveBeenCalledTimes(0);
    expect(refreshThread).toHaveBeenCalledTimes(0);
  });

  it("switches active threads without forcing resume refresh", async () => {
    const refreshThread = vi.fn().mockResolvedValue(undefined);
    const workspace = {
      id: "ws-1",
      name: "Workspace",
      path: "/tmp/ws-1",
      connected: true,
      settings: { sidebarCollapsed: false },
    };

    const { rerender } = renderHook(
      ({ threadId }: { threadId: string | null }) =>
        useRemoteThreadLiveConnection({
          backendMode: "remote",
          activeWorkspace: workspace,
          activeThreadId: threadId,
          refreshThread,
        }),
      {
        initialProps: { threadId: "thread-1" },
      },
    );

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      rerender({ threadId: "thread-2" });
      await Promise.resolve();
    });

    expect(threadLiveSubscribeMock).toHaveBeenCalledTimes(2);
    expect(threadLiveUnsubscribeMock).toHaveBeenCalledTimes(1);
    expect(refreshThread).toHaveBeenCalledTimes(0);
  });

  it("resumes when switching to a thread without local snapshot", async () => {
    const refreshThread = vi.fn().mockResolvedValue(undefined);
    const workspace = {
      id: "ws-1",
      name: "Workspace",
      path: "/tmp/ws-1",
      connected: true,
      settings: { sidebarCollapsed: false },
    };

    const { rerender } = renderHook(
      ({
        threadId,
        hasLocalSnapshot,
      }: {
        threadId: string | null;
        hasLocalSnapshot: boolean;
      }) =>
        useRemoteThreadLiveConnection({
          backendMode: "remote",
          activeWorkspace: workspace,
          activeThreadId: threadId,
          activeThreadHasLocalSnapshot: hasLocalSnapshot,
          refreshThread,
        }),
      {
        initialProps: { threadId: "thread-1", hasLocalSnapshot: true },
      },
    );

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      rerender({ threadId: "thread-2", hasLocalSnapshot: false });
      await Promise.resolve();
    });

    expect(threadLiveSubscribeMock).toHaveBeenCalledTimes(2);
    expect(threadLiveUnsubscribeMock).toHaveBeenCalledTimes(1);
    expect(refreshThread).toHaveBeenCalledTimes(1);
    expect(refreshThread).toHaveBeenCalledWith("ws-1", "thread-2");
  });

  it("ignores self-triggered detached event during dedupe reconnect", async () => {
    const refreshThread = vi.fn().mockResolvedValue(undefined);
    const workspace = {
      id: "ws-1",
      name: "Workspace",
      path: "/tmp/ws-1",
      connected: true,
      settings: { sidebarCollapsed: false },
    };

    const { result } = renderHook(() =>
      useRemoteThreadLiveConnection({
        backendMode: "remote",
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        refreshThread,
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(threadLiveSubscribeMock).toHaveBeenCalledTimes(1);
    expect(refreshThread).toHaveBeenCalledTimes(0);

    threadLiveUnsubscribeMock.mockImplementationOnce(async (workspaceId, threadId) => {
      for (const listener of appServerListeners) {
        listener({
          workspace_id: workspaceId,
          method: "thread/live_detached",
          params: { threadId },
        });
      }
    });

    await act(async () => {
      await result.current.reconnectLive("ws-1", "thread-1", { runResume: false });
      await Promise.resolve();
    });

    expect(threadLiveUnsubscribeMock).toHaveBeenCalledTimes(1);
    expect(threadLiveSubscribeMock).toHaveBeenCalledTimes(2);
    expect(refreshThread).toHaveBeenCalledTimes(0);
  });

  it("does not reconnect a terminal thread on remote recovery events when live updates are no longer needed", async () => {
    const refreshThread = vi.fn().mockResolvedValue(undefined);

    renderHook(() =>
      useRemoteThreadLiveConnection({
        backendMode: "remote",
        activeWorkspace: {
          id: "ws-1",
          name: "Workspace",
          path: "/tmp/ws-1",
          connected: true,
          settings: { sidebarCollapsed: false },
        },
        activeThreadId: "thread-1",
        activeThreadHasLocalSnapshot: true,
        activeThreadIsProcessing: false,
        activeThreadNeedsLiveConnection: false,
        refreshThread,
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    threadLiveSubscribeMock.mockClear();
    threadLiveUnsubscribeMock.mockClear();
    refreshThread.mockClear();

    await act(async () => {
      for (const listener of appServerListeners) {
        listener({
          workspace_id: "ws-1",
          method: "thread/live_detached",
          params: { threadId: "thread-1" },
        });
        listener({
          workspace_id: "ws-1",
          method: "codex/connected",
          params: {},
        });
      }
      await Promise.resolve();
    });

    expect(threadLiveSubscribeMock).not.toHaveBeenCalled();
    expect(threadLiveUnsubscribeMock).not.toHaveBeenCalled();
    expect(refreshThread).not.toHaveBeenCalled();
  });

  it("hydrates a terminal thread without subscribing when it lacks a local snapshot", async () => {
    const refreshThread = vi.fn().mockResolvedValue(undefined);

    renderHook(() =>
      useRemoteThreadLiveConnection({
        backendMode: "remote",
        activeWorkspace: {
          id: "ws-1",
          name: "Workspace",
          path: "/tmp/ws-1",
          connected: true,
          settings: { sidebarCollapsed: false },
        },
        activeThreadId: "thread-1",
        activeThreadHasLocalSnapshot: false,
        activeThreadIsProcessing: false,
        activeThreadNeedsLiveConnection: false,
        refreshThread,
      }),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refreshThread).toHaveBeenCalledWith("ws-1", "thread-1");
    expect(threadLiveSubscribeMock).not.toHaveBeenCalled();
    expect(threadLiveUnsubscribeMock).not.toHaveBeenCalled();
  });
});
