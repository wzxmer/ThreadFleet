// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendNotification } from "../../../services/tauri";
import { useAgentSystemNotifications } from "./useAgentSystemNotifications";

const useAppServerEventsMock = vi.fn();

vi.mock("../../../services/tauri", () => ({
  sendNotification: vi.fn(),
}));

vi.mock("../../app/hooks/useAppServerEvents", () => ({
  useAppServerEvents: (handlers: unknown) => useAppServerEventsMock(handlers),
}));

describe("useAgentSystemNotifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sendNotification).mockResolvedValue();
  });

  it("mutes notifications for subagent threads when disabled", async () => {
    renderHook(() =>
      useAgentSystemNotifications({
        enabled: true,
        isWindowFocused: false,
        minDurationMs: 0,
        subagentNotificationsEnabled: false,
        isSubagentThread: (_workspaceId, threadId) => threadId === "child-thread",
      }),
    );

    const handlers = useAppServerEventsMock.mock.calls[
      useAppServerEventsMock.mock.calls.length - 1
    ]?.[0] as {
      onTurnStarted?: (workspaceId: string, threadId: string, turnId: string) => void;
      onTurnCompleted?: (workspaceId: string, threadId: string, turnId: string) => void;
    };

    act(() => {
      handlers.onTurnStarted?.("ws-1", "child-thread", "turn-1");
      handlers.onTurnCompleted?.("ws-1", "child-thread", "turn-1");
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("still notifies for non-subagent threads while muted", async () => {
    renderHook(() =>
      useAgentSystemNotifications({
        enabled: true,
        isWindowFocused: false,
        minDurationMs: 0,
        subagentNotificationsEnabled: false,
        isSubagentThread: (_workspaceId, threadId) => threadId === "child-thread",
      }),
    );

    const handlers = useAppServerEventsMock.mock.calls[
      useAppServerEventsMock.mock.calls.length - 1
    ]?.[0] as {
      onTurnStarted?: (workspaceId: string, threadId: string, turnId: string) => void;
      onTurnCompleted?: (workspaceId: string, threadId: string, turnId: string) => void;
    };

    act(() => {
      handlers.onTurnStarted?.("ws-1", "parent-thread", "turn-1");
      handlers.onTurnCompleted?.("ws-1", "parent-thread", "turn-1");
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendNotification).mock.calls[0]?.[2]).toMatchObject({
      extra: {
        workspaceId: "ws-1",
        threadId: "parent-thread",
      },
    });
  });

  it("notifies for completed turns while the window is focused", async () => {
    renderHook(() =>
      useAgentSystemNotifications({
        enabled: true,
        isWindowFocused: true,
        minDurationMs: 0,
      }),
    );

    const handlers = useAppServerEventsMock.mock.calls[
      useAppServerEventsMock.mock.calls.length - 1
    ]?.[0] as {
      onTurnStarted?: (workspaceId: string, threadId: string, turnId: string) => void;
      onTurnCompleted?: (workspaceId: string, threadId: string, turnId: string) => void;
    };

    act(() => {
      handlers.onTurnStarted?.("ws-1", "thread-1", "turn-1");
      handlers.onTurnCompleted?.("ws-1", "thread-1", "turn-1");
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("allows explicit opt-in for subagent completion notifications", async () => {
    renderHook(() =>
      useAgentSystemNotifications({
        enabled: true,
        isWindowFocused: false,
        minDurationMs: 0,
        subagentNotificationsEnabled: true,
        isSubagentThread: () => true,
      }),
    );

    const handlers = useAppServerEventsMock.mock.calls[
      useAppServerEventsMock.mock.calls.length - 1
    ]?.[0] as {
      onTurnStarted?: (workspaceId: string, threadId: string, turnId: string) => void;
      onTurnCompleted?: (workspaceId: string, threadId: string, turnId: string) => void;
    };

    act(() => {
      handlers.onTurnStarted?.("ws-1", "child-thread", "turn-1");
      handlers.onTurnCompleted?.("ws-1", "child-thread", "turn-1");
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("uses neutral completion text when no final answer is confirmed", async () => {
    renderHook(() =>
      useAgentSystemNotifications({
        enabled: true,
        isWindowFocused: false,
        minDurationMs: 0,
      }),
    );

    const handlers = useAppServerEventsMock.mock.calls[
      useAppServerEventsMock.mock.calls.length - 1
    ]?.[0] as {
      onTurnStarted?: (workspaceId: string, threadId: string, turnId: string) => void;
      onAgentMessageCompleted?: (event: {
        workspaceId: string;
        threadId: string;
        turnId: string;
        phase: string;
        text: string;
      }) => void;
      onTurnCompleted?: (workspaceId: string, threadId: string, turnId: string) => void;
    };

    act(() => {
      handlers.onAgentMessageCompleted?.({
        workspaceId: "ws-1",
        threadId: "thread-1",
        turnId: "turn-old",
        phase: "final_answer",
        text: "Stale final",
      });
      handlers.onTurnStarted?.("ws-1", "thread-1", "turn-1");
      handlers.onAgentMessageCompleted?.({
        workspaceId: "ws-1",
        threadId: "thread-1",
        turnId: "turn-1",
        phase: "commentary",
        text: "Intermediate agent message",
      });
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(sendNotification).not.toHaveBeenCalled();

    act(() => {
      handlers.onTurnCompleted?.("ws-1", "thread-1", "turn-1");
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith(
      "Agent Complete",
      "Your agent has finished its task.",
      expect.any(Object),
    );
  });

  it("uses only the final answer from the matching turn", async () => {
    renderHook(() =>
      useAgentSystemNotifications({
        enabled: true,
        isWindowFocused: false,
        minDurationMs: 0,
      }),
    );

    const handlers = useAppServerEventsMock.mock.calls[
      useAppServerEventsMock.mock.calls.length - 1
    ]?.[0] as {
      onTurnStarted?: (workspaceId: string, threadId: string, turnId: string) => void;
      onAgentMessageCompleted?: (event: {
        workspaceId: string;
        threadId: string;
        turnId: string;
        phase: string;
        text: string;
      }) => void;
      onTurnCompleted?: (workspaceId: string, threadId: string, turnId: string) => void;
    };

    act(() => {
      handlers.onAgentMessageCompleted?.({
        workspaceId: "ws-1",
        threadId: "thread-1",
        turnId: "turn-old",
        phase: "final_answer",
        text: "Stale final",
      });
      handlers.onTurnStarted?.("ws-1", "thread-1", "turn-1");
      handlers.onAgentMessageCompleted?.({
        workspaceId: "ws-1",
        threadId: "thread-1",
        turnId: "turn-1",
        phase: "final_answer",
        text: "Final answer",
      });
      handlers.onAgentMessageCompleted?.({
        workspaceId: "ws-1",
        threadId: "thread-2",
        turnId: "turn-1",
        phase: "final_answer",
        text: "Wrong thread",
      });
      handlers.onAgentMessageCompleted?.({
        workspaceId: "ws-1",
        threadId: "thread-1",
        turnId: "turn-2",
        phase: "final_answer",
        text: "Wrong turn",
      });
      handlers.onAgentMessageCompleted?.({
        workspaceId: "ws-2",
        threadId: "thread-1",
        turnId: "turn-1",
        phase: "final_answer",
        text: "Wrong workspace",
      });
      handlers.onTurnCompleted?.("ws-1", "thread-1", "turn-1");
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(sendNotification).toHaveBeenCalledWith(
      "Agent Complete",
      "Final answer",
      expect.any(Object),
    );
  });

  it("notifies when a windows-ui MCP tool actually starts and when its turn completes", async () => {
    renderHook(() =>
      useAgentSystemNotifications({
        enabled: true,
        isWindowFocused: true,
        minDurationMs: 0,
      }),
    );

    const handlers = useAppServerEventsMock.mock.calls[
      useAppServerEventsMock.mock.calls.length - 1
    ]?.[0] as {
      onItemStarted?: (
        workspaceId: string,
        threadId: string,
        item: Record<string, unknown>,
        turnId?: string,
      ) => void;
      onTurnCompleted?: (
        workspaceId: string,
        threadId: string,
        turnId: string,
        status?: "completed" | "interrupted" | "failed",
      ) => void;
    };

    act(() => {
      handlers.onItemStarted?.("ws-1", "thread-1", {
        type: "mcpToolCall",
        server: "windows-ui",
        tool: "click",
        turnId: "turn-1",
        arguments: { selector: "secret-selector" },
      });
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenNthCalledWith(
      1,
      "电脑操控已开始",
      "已开始使用 Windows 原生界面控制电脑。",
      expect.objectContaining({
        extra: {
          kind: "computer_control",
          phase: "started",
          workspaceId: "ws-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      }),
    );

    act(() => {
      handlers.onTurnCompleted?.("ws-1", "thread-1", "turn-1", "completed");
      handlers.onTurnCompleted?.("ws-1", "thread-1", "turn-1", "completed");
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(sendNotification).toHaveBeenNthCalledWith(
      2,
      "电脑操控已结束",
      "Windows 原生界面控制任务已完成。",
      expect.objectContaining({
        extra: expect.objectContaining({ phase: "completed", turnId: "turn-1" }),
      }),
    );
  });

  it("does not notify for preflight-like or non-windows-ui items", async () => {
    renderHook(() =>
      useAgentSystemNotifications({
        enabled: true,
        isWindowFocused: false,
        minDurationMs: 0,
      }),
    );

    const handlers = useAppServerEventsMock.mock.calls[
      useAppServerSystemNotificationsCallIndex(useAppServerEventsMock)
    ]?.[0] as {
      onItemStarted?: (
        workspaceId: string,
        threadId: string,
        item: Record<string, unknown>,
        turnId?: string,
      ) => void;
    };

    act(() => {
      handlers.onItemStarted?.("ws-1", "thread-1", {
        type: "mcpToolCall",
        server: "browser",
        tool: "click",
      });
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does not impersonate a remote execution host with local computer-control notifications", async () => {
    renderHook(() =>
      useAgentSystemNotifications({
        enabled: true,
        computerControlNotificationsEnabled: false,
        isWindowFocused: false,
        minDurationMs: 60_000,
      }),
    );

    const handlers = useAppServerEventsMock.mock.calls[
      useAppServerSystemNotificationsCallIndex(useAppServerEventsMock)
    ]?.[0] as {
      onItemStarted?: (
        workspaceId: string,
        threadId: string,
        item: Record<string, unknown>,
        turnId?: string,
      ) => void;
      onTurnCompleted?: (
        workspaceId: string,
        threadId: string,
        turnId: string,
        status?: "completed" | "interrupted" | "failed",
      ) => void;
    };

    act(() => {
      handlers.onItemStarted?.("remote-ws", "thread-1", {
        type: "mcpToolCall",
        server: "windows-ui",
        tool: "click",
        turnId: "turn-1",
      });
      handlers.onTurnCompleted?.("remote-ws", "thread-1", "turn-1", "completed");
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it.each([
    ["interrupted", "Windows 原生界面控制任务已中断。"],
    ["failed", "Windows 原生界面控制任务失败。"],
  ] as const)("uses the terminal notification for %s", async (status, body) => {
    renderHook(() =>
      useAgentSystemNotifications({
        enabled: true,
        isWindowFocused: false,
        minDurationMs: 0,
      }),
    );

    const handlers = useAppServerEventsMock.mock.calls[
      useAppServerSystemNotificationsCallIndex(useAppServerEventsMock)
    ]?.[0] as {
      onItemStarted?: (
        workspaceId: string,
        threadId: string,
        item: Record<string, unknown>,
        turnId?: string,
      ) => void;
      onTurnCompleted?: (
        workspaceId: string,
        threadId: string,
        turnId: string,
        status?: "completed" | "interrupted" | "failed",
      ) => void;
    };

    act(() => {
      handlers.onItemStarted?.("ws-1", "thread-1", {
        type: "mcpToolCall",
        server: "windows-ui",
        tool: "get_screenshot",
        turnId: "turn-1",
      });
      handlers.onTurnCompleted?.("ws-1", "thread-1", "turn-1", status);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(sendNotification).toHaveBeenNthCalledWith(
      2,
      "电脑操控已结束",
      body,
      expect.objectContaining({
        extra: expect.objectContaining({ phase: status }),
      }),
    );
  });

  it("deduplicates a terminal error followed by a failed turn event", async () => {
    renderHook(() =>
      useAgentSystemNotifications({
        enabled: true,
        isWindowFocused: false,
        minDurationMs: 0,
      }),
    );

    const handlers = useAppServerEventsMock.mock.calls[
      useAppServerSystemNotificationsCallIndex(useAppServerEventsMock)
    ]?.[0] as {
      onItemStarted?: (
        workspaceId: string,
        threadId: string,
        item: Record<string, unknown>,
        turnId?: string,
      ) => void;
      onTurnError?: (
        workspaceId: string,
        threadId: string,
        turnId: string,
        payload: { message: string; willRetry: boolean },
      ) => void;
      onTurnCompleted?: (
        workspaceId: string,
        threadId: string,
        turnId: string,
        status?: "completed" | "interrupted" | "failed",
      ) => void;
    };

    act(() => {
      handlers.onItemStarted?.("ws-1", "thread-1", {
        type: "mcpToolCall",
        server: "windows-ui",
        tool: "click",
        turnId: "turn-1",
      });
      handlers.onTurnError?.("ws-1", "thread-1", "turn-1", {
        message: "sensitive backend error",
        willRetry: false,
      });
      handlers.onTurnCompleted?.("ws-1", "thread-1", "turn-1", "failed");
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(sendNotification).toHaveBeenNthCalledWith(
      2,
      "电脑操控已结束",
      "Windows 原生界面控制任务失败。",
      expect.any(Object),
    );
  });
});

function useAppServerSystemNotificationsCallIndex(mock: typeof useAppServerEventsMock) {
  return mock.mock.calls.length - 1;
}
