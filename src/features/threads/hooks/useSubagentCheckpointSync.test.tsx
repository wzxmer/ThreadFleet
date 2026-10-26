// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { steerTurn } from "@services/tauri";
import { useSubagentCheckpointSync } from "./useSubagentCheckpointSync";
import type { SubagentCheckpointSyncMode } from "@/types";

vi.mock("@services/tauri", () => ({
  steerTurn: vi.fn(),
}));

const steerTurnMock = vi.mocked(steerTurn);

function setup(mode: SubagentCheckpointSyncMode = "checkpoints") {
  const threadParentByIdRef = { current: { child: "parent" } };
  const threadStatusByIdRef = {
    current: {
      parent: {
        isProcessing: true,
        isReviewing: false,
        hasUnread: false,
        processingStartedAt: null,
        lastDurationMs: null,
      },
    },
  };
  const activeTurnIdByThreadRef: { current: Record<string, string | null> } = {
    current: { parent: "parent-turn" },
  };
  const onStatusChange = vi.fn();
  const hook = renderHook(({ mode }: { mode: SubagentCheckpointSyncMode }) =>
    useSubagentCheckpointSync({
      mode,
      threadParentByIdRef,
      threadStatusByIdRef,
      activeTurnIdByThreadRef,
      getChildName: () => "worker",
      onStatusChange,
    }), { initialProps: { mode } },
  );
  return { hook, threadStatusByIdRef, activeTurnIdByThreadRef, onStatusChange };
}

describe("useSubagentCheckpointSync", () => {
  it("does not inject progress or final results while off", () => {
    const { hook, onStatusChange } = setup("off");
    act(() => {
      hook.result.current.onTurnStarted("ws", "child", "turn");
      hook.result.current.onAgentMessageCompleted({ workspaceId: "ws", threadId: "child", itemId: "answer", text: "Native result" });
      hook.result.current.onTurnCompleted("ws", "child", "turn");
    });
    expect(steerTurnMock).not.toHaveBeenCalled();
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it("discards pending progress and final messages when turned off, including after re-enabling", () => {
    const { hook, threadStatusByIdRef, activeTurnIdByThreadRef } = setup();
    threadStatusByIdRef.current.parent.isProcessing = false;
    activeTurnIdByThreadRef.current.parent = null;
    act(() => {
      hook.result.current.onTurnStarted("ws", "child", "turn");
      hook.result.current.onAgentMessageCompleted({ workspaceId: "ws", threadId: "child", itemId: "answer", text: "Queued" });
      hook.result.current.onTurnCompleted("ws", "child", "turn");
    });
    hook.rerender({ mode: "off" });
    threadStatusByIdRef.current.parent.isProcessing = true;
    activeTurnIdByThreadRef.current.parent = "turn-2";
    act(() => hook.result.current.onTurnStarted("ws", "parent", "turn-2"));
    hook.rerender({ mode: "checkpoints" });
    act(() => {
      hook.result.current.onTurnStarted("ws", "parent", "turn-3");
      hook.result.current.onTurnCompleted("ws", "child", "turn");
    });
    expect(steerTurnMock).not.toHaveBeenCalled();
  });

  it("does not requeue an in-flight failed injection after being turned off", async () => {
    let rejectDelivery!: (error: Error) => void;
    steerTurnMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectDelivery = reject; }));
    const { hook } = setup();
    act(() => hook.result.current.onAgentMessageCompleted({ workspaceId: "ws", threadId: "child", itemId: "answer", text: "Sending" }));
    expect(steerTurnMock).toHaveBeenCalledTimes(1);
    hook.rerender({ mode: "off" });
    await act(async () => rejectDelivery(new Error("no active turn")));
    hook.rerender({ mode: "checkpoints" });
    await act(async () => hook.result.current.flushParent("parent"));
    expect(steerTurnMock).toHaveBeenCalledTimes(1);
  });
  beforeEach(() => {
    steerTurnMock.mockReset();
    steerTurnMock.mockResolvedValue({});
  });

  it("steers a child progress checkpoint into an active parent", async () => {
    const { hook } = setup();
    act(() => {
      hook.result.current.onTurnStarted("ws", "child", "child-turn");
      hook.result.current.onAgentMessageCompleted({
        workspaceId: "ws",
        threadId: "child",
        itemId: "item-1",
        text: "Found the owning module.",
      });
    });
    await waitFor(() => expect(steerTurnMock).toHaveBeenCalledTimes(1));
    expect(steerTurnMock).toHaveBeenCalledWith(
      "ws",
      "parent",
      "parent-turn",
      expect.stringContaining("Found the owning module."),
    );
  });

  it("does not resend an identical final result after progress was delivered", async () => {
    const { hook } = setup();
    act(() => {
      hook.result.current.onTurnStarted("ws", "child", "child-turn");
      hook.result.current.onAgentMessageCompleted({
        workspaceId: "ws",
        threadId: "child",
        itemId: "item-1",
        text: "Final answer",
      });
    });
    await waitFor(() => expect(steerTurnMock).toHaveBeenCalledTimes(1));

    act(() => hook.result.current.onTurnCompleted("ws", "child", "child-turn"));
    await waitFor(() => expect(steerTurnMock).toHaveBeenCalledTimes(1));
  });

  it("replaces pending progress with final when the final text changes", async () => {
    const { hook, threadStatusByIdRef, activeTurnIdByThreadRef } = setup();
    threadStatusByIdRef.current.parent.isProcessing = false;
    activeTurnIdByThreadRef.current.parent = null;
    act(() => {
      hook.result.current.onTurnStarted("ws", "child", "child-turn");
      hook.result.current.onAgentMessageCompleted({
        workspaceId: "ws",
        threadId: "child",
        itemId: "item-1",
        text: "Progress answer",
      });
      hook.result.current.onAgentMessageCompleted({
        workspaceId: "ws",
        threadId: "child",
        itemId: "item-1",
        text: "Final answer",
      });
      hook.result.current.onTurnCompleted("ws", "child", "child-turn");
    });

    threadStatusByIdRef.current.parent.isProcessing = true;
    activeTurnIdByThreadRef.current.parent = "parent-turn-2";
    act(() => hook.result.current.onTurnStarted("ws", "parent", "parent-turn-2"));
    await waitFor(() => expect(steerTurnMock).toHaveBeenCalledTimes(1));
    expect(steerTurnMock.mock.calls[0]?.[3]).toContain('priority="final"');
    expect(steerTurnMock.mock.calls[0]?.[3]).toContain("Final answer");
  });

  it("queues while parent is idle and flushes after its next turn starts", async () => {
    const { hook, threadStatusByIdRef, activeTurnIdByThreadRef, onStatusChange } = setup();
    threadStatusByIdRef.current.parent.isProcessing = false;
    activeTurnIdByThreadRef.current.parent = null;
    act(() => {
      hook.result.current.onAgentMessageCompleted({
        workspaceId: "ws",
        threadId: "child",
        itemId: "item-1",
        text: "Checkpoint",
      });
    });
    expect(steerTurnMock).not.toHaveBeenCalled();
    expect(onStatusChange).toHaveBeenCalledWith("ws", "parent", "pending", 0);

    threadStatusByIdRef.current.parent.isProcessing = true;
    activeTurnIdByThreadRef.current.parent = "parent-turn-2";
    act(() => hook.result.current.onTurnStarted("ws", "parent", "parent-turn-2"));
    await waitFor(() => expect(steerTurnMock).toHaveBeenCalledTimes(1));
    expect(onStatusChange).toHaveBeenCalledWith("ws", "parent", "delivered", 1);
  });

  it("keeps stale steer checkpoints for a later parent turn", async () => {
    steerTurnMock.mockRejectedValueOnce(new Error("no active turn"));
    const { hook, activeTurnIdByThreadRef } = setup();
    act(() => {
      hook.result.current.onAgentMessageCompleted({
        workspaceId: "ws",
        threadId: "child",
        itemId: "item-1",
        text: "Checkpoint",
      });
    });
    await waitFor(() => expect(steerTurnMock).toHaveBeenCalledTimes(1));

    steerTurnMock.mockResolvedValue({});
    activeTurnIdByThreadRef.current.parent = "parent-turn-2";
    act(() => hook.result.current.onTurnStarted("ws", "parent", "parent-turn-2"));
    await waitFor(() => expect(steerTurnMock).toHaveBeenCalledTimes(2));
  });

  it("final-only mode waits for child completion", async () => {
    const { hook } = setup("finalOnly");
    act(() => {
      hook.result.current.onTurnStarted("ws", "child", "child-turn");
      hook.result.current.onAgentMessageCompleted({
        workspaceId: "ws",
        threadId: "child",
        itemId: "item-1",
        text: "Final answer",
      });
    });
    expect(steerTurnMock).not.toHaveBeenCalled();
    act(() => hook.result.current.onTurnCompleted("ws", "child", "child-turn"));
    await waitFor(() => expect(steerTurnMock).toHaveBeenCalledTimes(1));
    expect(steerTurnMock.mock.calls[0]?.[3]).toContain('priority="final"');
  });

  it("does not lock delivery when switching to final-only with pending progress", async () => {
    const threadParentByIdRef = { current: { child: "parent" } };
    const threadStatusByIdRef = {
      current: {
        parent: {
          isProcessing: false,
          isReviewing: false,
          hasUnread: false,
          processingStartedAt: null,
          lastDurationMs: null,
        },
      },
    };
    const activeTurnIdByThreadRef: { current: Record<string, string | null> } = {
      current: { parent: null },
    };
    const { result, rerender } = renderHook(
      ({ mode }: { mode: "finalOnly" | "checkpoints" | "continuous" }) =>
        useSubagentCheckpointSync({
          mode,
          threadParentByIdRef,
          threadStatusByIdRef,
          activeTurnIdByThreadRef,
        }),
      { initialProps: { mode: "checkpoints" as "finalOnly" | "checkpoints" | "continuous" } },
    );

    act(() => {
      result.current.onTurnStarted("ws", "child", "child-turn");
      result.current.onAgentMessageCompleted({
        workspaceId: "ws",
        threadId: "child",
        itemId: "item-1",
        text: "Progress",
      });
    });
    rerender({ mode: "finalOnly" });
    threadStatusByIdRef.current.parent.isProcessing = true;
    activeTurnIdByThreadRef.current.parent = "parent-turn";
    act(() => result.current.onTurnStarted("ws", "parent", "parent-turn"));
    expect(steerTurnMock).not.toHaveBeenCalled();

    act(() => result.current.onTurnCompleted("ws", "child", "child-turn"));
    await waitFor(() => expect(steerTurnMock).toHaveBeenCalledTimes(1));
  });
});
