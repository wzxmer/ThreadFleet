// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RateLimitSnapshot, TurnPlan } from "@/types";
import { interruptTurn } from "@services/tauri";
import {
  normalizePlanUpdate,
  normalizeRateLimits,
  normalizeTokenUsage,
} from "@threads/utils/threadNormalize";
import { useThreadTurnEvents } from "./useThreadTurnEvents";

vi.mock("@services/tauri", () => ({
  interruptTurn: vi.fn(),
}));

vi.mock("@threads/utils/threadNormalize", () => ({
  asString: (value: unknown) =>
    typeof value === "string" ? value : value ? String(value) : "",
  normalizePlanUpdate: vi.fn(),
  normalizeRateLimits: vi.fn(),
  normalizeTokenUsage: vi.fn(),
}));

type SetupOverrides = {
  pendingInterrupts?: string[];
  planByThread?: Record<string, TurnPlan | null>;
  activeTurnByThread?: Record<string, string | null>;
  rateLimitsByWorkspace?: Record<string, RateLimitSnapshot | null>;
  reconcilePlan?: (workspaceId: string, threadId: string) => Promise<void>;
};

const makeOptions = (overrides: SetupOverrides = {}) => {
  const dispatch = vi.fn();
  const getCustomName = vi.fn();
  const isThreadHidden = vi.fn(() => false);
  const markProcessing = vi.fn();
  const markReviewing = vi.fn();
  const setThreadLoaded = vi.fn();
  const setActiveTurnId = vi.fn();
  const getActiveTurnId = vi.fn(
    (threadId: string) => overrides.activeTurnByThread?.[threadId] ?? null,
  );
  const getCurrentRateLimits = vi.fn(
    (workspaceId: string) => overrides.rateLimitsByWorkspace?.[workspaceId] ?? null,
  );
  const pushThreadErrorMessage = vi.fn();
  const safeMessageActivity = vi.fn();
  const recordThreadActivity = vi.fn();
  const reconcilePlan = vi.fn(overrides.reconcilePlan ?? (async () => undefined));
  const pendingInterruptsRef = {
    current: new Set(overrides.pendingInterrupts ?? []),
  };
  const planByThreadRef = {
    current: overrides.planByThread ?? {},
  };

  const { result } = renderHook(() =>
    useThreadTurnEvents({
      dispatch,
      planByThreadRef,
      getCurrentRateLimits,
      getCustomName,
      isThreadHidden,
      markProcessing,
      markReviewing,
      setThreadLoaded,
      setActiveTurnId,
      getActiveTurnId,
      pendingInterruptsRef,
      pushThreadErrorMessage,
      safeMessageActivity,
      recordThreadActivity,
      reconcilePlan,
    }),
  );

  return {
    result,
    dispatch,
    getCustomName,
    isThreadHidden,
    markProcessing,
    markReviewing,
    setThreadLoaded,
    setActiveTurnId,
    getActiveTurnId,
    getCurrentRateLimits,
    pushThreadErrorMessage,
    safeMessageActivity,
    recordThreadActivity,
    reconcilePlan,
    pendingInterruptsRef,
    planByThreadRef,
  };
};

describe("useThreadTurnEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("upserts thread summaries when a thread starts", () => {
    const { result, dispatch, recordThreadActivity, safeMessageActivity } =
      makeOptions();

    act(() => {
      result.current.onThreadStarted("ws-1", {
        id: "thread-1",
        preview: "A brand new thread",
        updatedAt: 1_700_000_000_000,
      });
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "ensureThread",
      workspaceId: "ws-1",
      threadId: "thread-1",
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadTimestamp",
      workspaceId: "ws-1",
      threadId: "thread-1",
      timestamp: 1_700_000_000_000,
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadName",
      workspaceId: "ws-1",
      threadId: "thread-1",
      name: "A brand new thread",
    });
    expect(recordThreadActivity).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      1_700_000_000_000,
    );
    expect(safeMessageActivity).toHaveBeenCalled();
  });

  it("does not override custom thread names on thread started", () => {
    const { result, dispatch, getCustomName } = makeOptions();
    getCustomName.mockReturnValue("Custom name");

    act(() => {
      result.current.onThreadStarted("ws-1", {
        id: "thread-2",
        preview: "Preview text",
        updatedAt: 1_700_000_000_100,
      });
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "ensureThread",
      workspaceId: "ws-1",
      threadId: "thread-2",
    });
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "setThreadName",
        workspaceId: "ws-1",
        threadId: "thread-2",
      }),
    );
  });

  it("uses formal thread titles from thread started before preview", () => {
    const { result, dispatch, getCustomName } = makeOptions();
    getCustomName.mockReturnValue(undefined);

    act(() => {
      result.current.onThreadStarted("ws-1", {
        id: "thread-formal-title",
        thread_name: "Official title",
        preview: "Raw user prompt",
        updatedAt: 1_700_000_000_150,
      });
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadName",
      workspaceId: "ws-1",
      threadId: "thread-formal-title",
      name: "Official title",
    });
  });

  it("ignores thread started events for hidden threads", () => {
    const { result, dispatch, isThreadHidden, recordThreadActivity, safeMessageActivity } =
      makeOptions();
    isThreadHidden.mockReturnValue(true);

    act(() => {
      result.current.onThreadStarted("ws-1", {
        id: "thread-hidden",
        preview: "Hidden thread",
        updatedAt: 1_700_000_000_200,
      });
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(recordThreadActivity).not.toHaveBeenCalled();
    expect(safeMessageActivity).not.toHaveBeenCalled();
  });

  it("hides memory consolidation thread started events", () => {
    const { result, dispatch, recordThreadActivity, safeMessageActivity } =
      makeOptions();

    act(() => {
      result.current.onThreadStarted("ws-1", {
        id: "thread-subagent-orphan",
        preview: "Memory helper",
        updatedAt: 1_700_000_000_250,
        source: { subagent: "memory_consolidation" },
      });
    });

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ensureThread",
        workspaceId: "ws-1",
        threadId: "thread-subagent-orphan",
      }),
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "hideThread",
      workspaceId: "ws-1",
      threadId: "thread-subagent-orphan",
    });
    expect(recordThreadActivity).not.toHaveBeenCalled();
    expect(safeMessageActivity).not.toHaveBeenCalled();
  });

  it("keeps subagent thread started events when a parent id exists", () => {
    const { result, dispatch } = makeOptions();

    act(() => {
      result.current.onThreadStarted("ws-1", {
        id: "thread-subagent-child",
        preview: "Spawned helper",
        updatedAt: 1_700_000_000_300,
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: "thread-parent",
            },
          },
        },
      });
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "ensureThread",
      workspaceId: "ws-1",
      threadId: "thread-subagent-child",
    });
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "hideThread",
        workspaceId: "ws-1",
        threadId: "thread-subagent-child",
      }),
    );
  });

  it("hydrates subagent nickname and role from thread started metadata", () => {
    const { result, dispatch } = makeOptions();

    act(() => {
      result.current.onThreadStarted("ws-1", {
        id: "thread-subagent-meta",
        preview: "Review helper",
        updatedAt: 1_700_000_000_350,
        agent_nickname: "Atlas",
        agent_role: "reviewer",
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: "thread-parent",
            },
          },
        },
      });
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "mergeThreadSummary",
      workspaceId: "ws-1",
      threadId: "thread-subagent-meta",
      patch: {
        isSubagent: true,
        subagentNickname: "Atlas",
        subagentRole: "reviewer",
      },
    });
  });

  it("keeps metadata-only subagent thread starts even before parent linkage arrives", () => {
    const { result, dispatch } = makeOptions();

    act(() => {
      result.current.onThreadStarted("ws-1", {
        id: "thread-subagent-late-parent",
        preview: "Late-linked helper",
        updatedAt: 1_700_000_000_360,
        source: {
          subAgent: {
            other: "thread_spawn",
            agentNickname: "Scout",
            agentRole: "explorer",
          },
        },
      });
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "ensureThread",
      workspaceId: "ws-1",
      threadId: "thread-subagent-late-parent",
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "mergeThreadSummary",
      workspaceId: "ws-1",
      threadId: "thread-subagent-late-parent",
      patch: {
        isSubagent: true,
        subagentNickname: "Scout",
        subagentRole: "explorer",
      },
    });
  });

  it("applies thread name updates when no custom name exists", () => {
    const { result, dispatch, getCustomName } = makeOptions();
    getCustomName.mockReturnValue(undefined);

    act(() => {
      result.current.onThreadNameUpdated("ws-1", {
        threadId: "thread-3",
        threadName: "Server Rename",
      });
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadName",
      workspaceId: "ws-1",
      threadId: "thread-3",
      name: "Server Rename",
    });
  });

  it("ignores placeholder thread names that mirror the thread id", () => {
    const { result, dispatch, getCustomName } = makeOptions();
    getCustomName.mockReturnValue(undefined);

    act(() => {
      result.current.onThreadNameUpdated("ws-1", {
        threadId: "019c9e0e-7f97-78f2-a719-d28af9fb76b6",
        threadName: "019c9e0e-7f97-78f2-a719-d28af9fb76b6",
      });
    });

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "setThreadName",
        workspaceId: "ws-1",
        threadId: "019c9e0e-7f97-78f2-a719-d28af9fb76b6",
      }),
    );
  });

  it("does not override custom thread names on thread name updated", () => {
    const { result, dispatch, getCustomName } = makeOptions();
    getCustomName.mockReturnValue("Custom Name");

    act(() => {
      result.current.onThreadNameUpdated("ws-1", {
        threadId: "thread-3",
        threadName: "Server Rename",
      });
    });

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "setThreadName",
        workspaceId: "ws-1",
        threadId: "thread-3",
      }),
    );
  });

  it("removes thread state on thread archived", () => {
    const { result, dispatch } = makeOptions();

    act(() => {
      result.current.onThreadArchived("ws-1", "thread-7");
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "removeThread",
      workspaceId: "ws-1",
      threadId: "thread-7",
    });
  });

  it("re-adds thread summary on thread unarchived", () => {
    const { result, dispatch, recordThreadActivity, safeMessageActivity } =
      makeOptions();

    act(() => {
      result.current.onThreadUnarchived("ws-1", "thread-8");
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "ensureThread",
      workspaceId: "ws-1",
      threadId: "thread-8",
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "setThreadTimestamp",
        workspaceId: "ws-1",
        threadId: "thread-8",
      }),
    );
    expect(recordThreadActivity).toHaveBeenCalledWith(
      "ws-1",
      "thread-8",
      expect.any(Number),
    );
    expect(safeMessageActivity).toHaveBeenCalled();
  });

  it("marks processing and active turn on turn started", () => {
    const { result, dispatch, markProcessing, setActiveTurnId } = makeOptions();

    act(() => {
      result.current.onTurnStarted("ws-1", "thread-1", "turn-1");
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "ensureThread",
      workspaceId: "ws-1",
      threadId: "thread-1",
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadTurnDiff",
      threadId: "thread-1",
      diff: "",
    });
    expect(markProcessing).toHaveBeenCalledWith("thread-1", true);
    expect(setActiveTurnId).toHaveBeenCalledWith("thread-1", "turn-1");
    expect(interruptTurn).not.toHaveBeenCalled();
  });

  it("interrupts immediately when a pending interrupt is queued", () => {
    const { result, markProcessing, setActiveTurnId, pendingInterruptsRef } =
      makeOptions({ pendingInterrupts: ["thread-1"] });
    vi.mocked(interruptTurn).mockResolvedValue({});

    act(() => {
      result.current.onTurnStarted("ws-1", "thread-1", "turn-2");
    });

    expect(pendingInterruptsRef.current.has("thread-1")).toBe(false);
    expect(interruptTurn).toHaveBeenCalledWith("ws-1", "thread-1", "turn-2");
    expect(markProcessing).not.toHaveBeenCalled();
    expect(setActiveTurnId).not.toHaveBeenCalled();
  });

  it("clears pending interrupt and active turn on turn completed", () => {
    const { result, markProcessing, setActiveTurnId, pendingInterruptsRef } =
      makeOptions({ pendingInterrupts: ["thread-1"] });

    act(() => {
      result.current.onTurnCompleted("ws-1", "thread-1", "turn-1");
    });

    expect(markProcessing).toHaveBeenCalledWith("thread-1", false);
    expect(setActiveTurnId).toHaveBeenCalledWith("thread-1", null);
    expect(pendingInterruptsRef.current.has("thread-1")).toBe(false);
  });

  it("records completion as thread activity before processing is cleared", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_123_000);
    const { result, dispatch, recordThreadActivity } = makeOptions();

    act(() => {
      result.current.onTurnCompleted("ws-1", "thread-1", "turn-1");
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadTimestamp",
      workspaceId: "ws-1",
      threadId: "thread-1",
      timestamp: 1_700_000_123_000,
    });
    expect(recordThreadActivity).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      1_700_000_123_000,
    );
    nowSpy.mockRestore();
  });

  it("records fallback terminal status as thread activity", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_124_000);
    const { result, dispatch, recordThreadActivity } = makeOptions();

    act(() => {
      result.current.onTurnStarted("ws-1", "thread-1", "turn-1");
      result.current.onThreadStatusChanged("ws-1", "thread-1", { type: "idle" });
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadTimestamp",
      workspaceId: "ws-1",
      threadId: "thread-1",
      timestamp: 1_700_000_124_000,
    });
    expect(recordThreadActivity).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      1_700_000_124_000,
    );
    nowSpy.mockRestore();
  });

  it.each([
    ["interrupted", "interrupted"],
    ["system error", "system_error"],
    ["not loaded", "notLoaded"],
  ])("records %s terminal status as thread activity", (_label, statusType) => {
    const { result, recordThreadActivity } = makeOptions();

    act(() => {
      result.current.onTurnStarted("ws-1", "thread-1", "turn-1");
      result.current.onThreadStatusChanged("ws-1", "thread-1", {
        type: statusType,
      });
    });

    expect(recordThreadActivity).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      expect.any(Number),
    );
  });

  it("finalizes terminal activity once when completion is followed by idle", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_125_000);
    const { result, dispatch, recordThreadActivity } = makeOptions();

    act(() => {
      result.current.onTurnStarted("ws-1", "thread-1", "turn-1");
      result.current.onTurnCompleted("ws-1", "thread-1", "turn-1");
      result.current.onThreadStatusChanged("ws-1", "thread-1", { type: "idle" });
    });

    expect(recordThreadActivity).toHaveBeenCalledTimes(1);
    expect(
      dispatch.mock.calls.filter(
        ([action]) => action.type === "setThreadTimestamp" && action.threadId === "thread-1",
      ),
    ).toHaveLength(1);
    nowSpy.mockRestore();
  });

  it("records a new status-only lifecycle after the previous turn was finalized", () => {
    const { result, dispatch, recordThreadActivity } = makeOptions();

    act(() => {
      result.current.onTurnStarted("ws-1", "thread-1", "turn-1");
      result.current.onTurnCompleted("ws-1", "thread-1", "turn-1");
      result.current.onThreadStatusChanged("ws-1", "thread-1", { type: "active" });
      result.current.onThreadStatusChanged("ws-1", "thread-1", { type: "idle" });
    });

    expect(recordThreadActivity).toHaveBeenCalledTimes(2);
    expect(
      dispatch.mock.calls.filter(
        ([action]) =>
          action.type === "completeTurnExecution" && action.turnId === "turn-1",
      ),
    ).toHaveLength(1);
  });

  it("does not record activity for an isolated idle status", () => {
    const { result, dispatch, recordThreadActivity } = makeOptions();

    act(() => {
      result.current.onThreadStatusChanged("ws-1", "thread-1", { type: "idle" });
    });

    expect(recordThreadActivity).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "setThreadTimestamp",
        workspaceId: "ws-1",
        threadId: "thread-1",
      }),
    );
  });

  it("does not finalize idle status while a retry continuation is pending", () => {
    const { result, dispatch, recordThreadActivity } = makeOptions();

    act(() => {
      result.current.onTurnStarted("ws-1", "thread-1", "turn-1");
      result.current.onTurnError("ws-1", "thread-1", "turn-1", {
        message: "retrying",
        willRetry: true,
      });
      result.current.onThreadStatusChanged("ws-1", "thread-1", { type: "idle" });
    });

    expect(recordThreadActivity).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "setThreadTimestamp",
        workspaceId: "ws-1",
        threadId: "thread-1",
      }),
    );
  });

  it("ignores turn completed events for stale turns", () => {
    const { result, markProcessing, setActiveTurnId } = makeOptions({
      activeTurnByThread: {
        "thread-1": "turn-active",
      },
    });

    act(() => {
      result.current.onTurnCompleted("ws-1", "thread-1", "turn-stale");
    });

    expect(markProcessing).not.toHaveBeenCalled();
    expect(setActiveTurnId).not.toHaveBeenCalled();
  });

  it("accepts completion for a newly started turn before state rerender", () => {
    const { result, markProcessing, setActiveTurnId } = makeOptions({
      activeTurnByThread: {
        "thread-1": "turn-old",
      },
    });

    act(() => {
      result.current.onTurnStarted("ws-1", "thread-1", "turn-new");
      result.current.onTurnCompleted("ws-1", "thread-1", "turn-new");
    });

    expect(markProcessing).toHaveBeenNthCalledWith(1, "thread-1", true);
    expect(markProcessing).toHaveBeenNthCalledWith(2, "thread-1", false);
    expect(setActiveTurnId).toHaveBeenNthCalledWith(1, "thread-1", "turn-new");
    expect(setActiveTurnId).toHaveBeenNthCalledWith(2, "thread-1", null);
  });

  it("accepts completion after reducer active turn changes externally", () => {
    const activeTurnByThread: Record<string, string | null> = {
      "thread-1": "turn-old",
    };
    const { result, markProcessing, setActiveTurnId } = makeOptions({
      activeTurnByThread,
    });

    act(() => {
      result.current.onTurnStarted("ws-1", "thread-1", "turn-local");
    });
    activeTurnByThread["thread-1"] = "turn-resumed";

    act(() => {
      result.current.onTurnCompleted("ws-1", "thread-1", "turn-resumed");
    });

    expect(markProcessing).toHaveBeenNthCalledWith(1, "thread-1", true);
    expect(markProcessing).toHaveBeenNthCalledWith(2, "thread-1", false);
    expect(setActiveTurnId).toHaveBeenNthCalledWith(1, "thread-1", "turn-local");
    expect(setActiveTurnId).toHaveBeenNthCalledWith(2, "thread-1", null);
  });

  it("marks processing when thread status changes to active", () => {
    const { result, markProcessing, setActiveTurnId } = makeOptions();

    act(() => {
      result.current.onThreadStatusChanged("ws-1", "thread-1", { type: "active" });
    });

    expect(markProcessing).toHaveBeenCalledWith("thread-1", true);
    expect(setActiveTurnId).not.toHaveBeenCalled();
  });

  it("clears processing, active turn, and pending interrupt for non-active thread status", () => {
    const {
      result,
      markProcessing,
      setActiveTurnId,
      setThreadLoaded,
      pendingInterruptsRef,
    } =
      makeOptions({ pendingInterrupts: ["thread-1"] });

    act(() => {
      result.current.onThreadStatusChanged("ws-1", "thread-1", {
        status_type: "system_error",
      });
    });

    expect(markProcessing).toHaveBeenCalledWith("thread-1", false);
    expect(setActiveTurnId).toHaveBeenCalledWith("thread-1", null);
    expect(setThreadLoaded).not.toHaveBeenCalled();
    expect(pendingInterruptsRef.current.has("thread-1")).toBe(false);
  });

  it("clears a completed plan when terminal thread status arrives without turn/completed", () => {
    const { result, dispatch } = makeOptions({
      planByThread: {
        "thread-1": {
          turnId: "turn-1",
          explanation: "Done",
          steps: [{ step: "Finish task", status: "completed" }],
        },
      },
    });

    act(() => {
      result.current.onThreadStatusChanged("ws-1", "thread-1", { type: "idle" });
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "clearThreadPlan",
      threadId: "thread-1",
    });
  });

  it("marks thread as unloaded when status changes to notLoaded", () => {
    const { result, setThreadLoaded, markReviewing } = makeOptions();

    act(() => {
      result.current.onThreadStatusChanged("ws-1", "thread-1", { type: "notLoaded" });
    });

    expect(setThreadLoaded).toHaveBeenCalledWith("thread-1", false);
    expect(markReviewing).toHaveBeenCalledWith("thread-1", false);
  });

  it("clears runtime state and marks unloaded on thread closed", () => {
    const {
      result,
      markProcessing,
      markReviewing,
      setThreadLoaded,
      setActiveTurnId,
      pendingInterruptsRef,
    } = makeOptions({ pendingInterrupts: ["thread-1"] });

    act(() => {
      result.current.onThreadClosed("ws-1", "thread-1");
    });

    expect(setThreadLoaded).toHaveBeenCalledWith("thread-1", false);
    expect(markProcessing).toHaveBeenCalledWith("thread-1", false);
    expect(markReviewing).toHaveBeenCalledWith("thread-1", false);
    expect(setActiveTurnId).toHaveBeenCalledWith("thread-1", null);
    expect(pendingInterruptsRef.current.has("thread-1")).toBe(false);
  });

  it("adds a visible error when an active turn closes unexpectedly", () => {
    const {
      result,
      dispatch,
      markProcessing,
      setActiveTurnId,
      pushThreadErrorMessage,
      recordThreadActivity,
      safeMessageActivity,
    } = makeOptions();

    act(() => {
      result.current.onTurnStarted("ws-1", "thread-1", "turn-1");
      result.current.onThreadClosed("ws-1", "thread-1");
    });

    expect(markProcessing).toHaveBeenNthCalledWith(1, "thread-1", true);
    expect(markProcessing).toHaveBeenNthCalledWith(2, "thread-1", false);
    expect(setActiveTurnId).toHaveBeenNthCalledWith(1, "thread-1", "turn-1");
    expect(setActiveTurnId).toHaveBeenNthCalledWith(2, "thread-1", null);
    expect(pushThreadErrorMessage).toHaveBeenCalledWith(
      "thread-1",
      "Turn failed: Codex app-server stopped unexpectedly.",
      "turn-1",
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "setThreadTimestamp",
        workspaceId: "ws-1",
        threadId: "thread-1",
      }),
    );
    expect(recordThreadActivity).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      expect.any(Number),
    );
    expect(safeMessageActivity).toHaveBeenCalled();
  });

  it("clears the active plan when all plan steps are completed", () => {
    const { result, dispatch } = makeOptions({
      planByThread: {
        "thread-1": {
          turnId: "turn-1",
          explanation: "Done",
          steps: [{ step: "Finish task", status: "completed" }],
        },
      },
    });

    act(() => {
      result.current.onTurnCompleted("ws-1", "thread-1", "turn-1");
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "clearThreadPlan",
      threadId: "thread-1",
    });
  });

  it("does not clear a completed plan for a different turn", () => {
    const { result, dispatch } = makeOptions({
      planByThread: {
        "thread-1": {
          turnId: "turn-2",
          explanation: "Done",
          steps: [{ step: "Finish task", status: "completed" }],
        },
      },
    });

    act(() => {
      result.current.onTurnCompleted("ws-1", "thread-1", "turn-1");
    });

    expect(dispatch).not.toHaveBeenCalledWith({
      type: "clearThreadPlan",
      threadId: "thread-1",
    });
  });

  it("reconciles once and marks an unfinished terminal plan stale", async () => {
    let finishReconcile: (() => void) | null = null;
    const { result, dispatch, reconcilePlan } = makeOptions({
      planByThread: {
        "thread-1": {
          turnId: "turn-1",
          explanation: "Still working",
          steps: [
            { step: "Finish task", status: "completed" },
            { step: "Verify output", status: "inProgress" },
          ],
        },
      },
      reconcilePlan: () =>
        new Promise<void>((resolve) => {
          finishReconcile = resolve;
        }),
    });

    act(() => {
      result.current.onTurnCompleted("ws-1", "thread-1", "turn-1");
      result.current.onTurnCompleted("ws-1", "thread-1", "turn-1");
    });

    expect(reconcilePlan).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadPlan",
      threadId: "thread-1",
      plan: expect.objectContaining({ syncState: "reconciling" }),
    });

    await act(async () => {
      finishReconcile?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: "setThreadPlan",
        threadId: "thread-1",
        plan: expect.objectContaining({ syncState: "stale" }),
      });
    });
    expect(dispatch).not.toHaveBeenCalledWith({
      type: "clearThreadPlan",
      threadId: "thread-1",
    });
  });

  it("restores an unfinished terminal plan to live when thread activity continues", async () => {
    const { result, dispatch } = makeOptions({
      planByThread: {
        "thread-1": {
          turnId: "turn-1",
          explanation: "Still working",
          steps: [{ step: "Verify output", status: "inProgress" }],
        },
      },
    });

    act(() => {
      result.current.onTurnCompleted("ws-1", "thread-1", "turn-1");
    });

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: "setThreadPlan",
        threadId: "thread-1",
        plan: expect.objectContaining({ syncState: "stale" }),
      });
    });

    act(() => {
      result.current.onThreadActivity("ws-1", "thread-1");
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadPlan",
      threadId: "thread-1",
      plan: expect.objectContaining({ syncState: "live" }),
    });
  });

  it("does not mark an unfinished terminal plan stale while an item remains active", async () => {
    vi.useFakeTimers();
    try {
      const { result, dispatch } = makeOptions({
        planByThread: {
          "thread-1": {
            turnId: "turn-1",
            explanation: "Still working",
            steps: [{ step: "Verify output", status: "inProgress" }],
          },
        },
      });

      act(() => {
        result.current.onThreadActivity("ws-1", "thread-1", "started");
        result.current.onTurnCompleted("ws-1", "thread-1", "turn-1");
      });

      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        vi.advanceTimersByTime(600);
      });

      expect(dispatch).not.toHaveBeenCalledWith({
        type: "setThreadPlan",
        threadId: "thread-1",
        plan: expect.objectContaining({ syncState: "stale" }),
      });

      act(() => {
        result.current.onThreadActivity("ws-1", "thread-1", "completed");
        vi.advanceTimersByTime(600);
      });

      expect(dispatch).toHaveBeenCalledWith({
        type: "setThreadPlan",
        threadId: "thread-1",
        plan: expect.objectContaining({ syncState: "stale" }),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps onTurnCompleted stable while plan content changes", () => {
    const dispatch = vi.fn();
    const getCustomName = vi.fn();
    const isThreadHidden = vi.fn(() => false);
    const markProcessing = vi.fn();
    const markReviewing = vi.fn();
    const setThreadLoaded = vi.fn();
    const setActiveTurnId = vi.fn();
    const getActiveTurnId = vi.fn(() => null);
    const pushThreadErrorMessage = vi.fn();
    const safeMessageActivity = vi.fn();
    const recordThreadActivity = vi.fn();
    const pendingInterruptsRef = { current: new Set<string>() };
    const planByThreadRef = {
      current: {} as Record<string, TurnPlan | null>,
    };

    const { result, rerender } = renderHook(() =>
      useThreadTurnEvents({
        dispatch,
        planByThreadRef,
        getCustomName,
        isThreadHidden,
        markProcessing,
        markReviewing,
        setThreadLoaded,
        setActiveTurnId,
        getActiveTurnId,
        pendingInterruptsRef,
        pushThreadErrorMessage,
        safeMessageActivity,
        recordThreadActivity,
      }),
    );

    const originalHandler = result.current.onTurnCompleted;
    planByThreadRef.current = {
      "thread-1": {
        turnId: "turn-1",
        explanation: "Updated",
        steps: [{ step: "Done", status: "completed" }],
      },
    };
    rerender();

    expect(result.current.onTurnCompleted).toBe(originalHandler);
  });

  it("dispatches normalized plan updates", () => {
    const { result, dispatch } = makeOptions();
    const normalized: TurnPlan = {
      turnId: "turn-3",
      explanation: "Plan",
      steps: [],
    };

    vi.mocked(normalizePlanUpdate).mockReturnValue(normalized);

    act(() => {
      result.current.onTurnPlanUpdated("ws-1", "thread-1", "turn-3", {
        explanation: "Plan",
        plan: [{ id: "step-1" }],
      });
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "ensureThread",
      workspaceId: "ws-1",
      threadId: "thread-1",
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadPlan",
      threadId: "thread-1",
      plan: {
        ...normalized,
        syncState: "live",
        updatedAt: expect.any(Number),
      },
    });
  });

  it("clears a completed plan update that arrives after terminal state", () => {
    const { result, dispatch } = makeOptions();
    vi.mocked(normalizePlanUpdate).mockReturnValue({
      turnId: "turn-4",
      explanation: "Done",
      steps: [{ step: "Finish", status: "completed" }],
    });

    act(() => {
      result.current.onTurnCompleted("ws-1", "thread-1", "turn-4");
      result.current.onTurnPlanUpdated("ws-1", "thread-1", "turn-4", {
        explanation: "Done",
        plan: [],
      });
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "clearThreadPlan",
      threadId: "thread-1",
    });
  });

  it("marks an unfinished plan update stale after terminal quiet", async () => {
    const { result, dispatch } = makeOptions();
    vi.mocked(normalizePlanUpdate).mockReturnValue({
      turnId: "turn-5",
      explanation: "Incomplete",
      steps: [{ step: "Verify", status: "inProgress" }],
    });

    act(() => {
      result.current.onTurnCompleted("ws-1", "thread-1", "turn-5", "failed");
      result.current.onTurnPlanUpdated("ws-1", "thread-1", "turn-5", {
        explanation: "Incomplete",
        plan: [],
      });
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadPlan",
      threadId: "thread-1",
      plan: expect.objectContaining({
        syncState: "live",
        steps: [{ step: "Verify", status: "inProgress" }],
      }),
    });
    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: "setThreadPlan",
        threadId: "thread-1",
        plan: expect.objectContaining({
          syncState: "stale",
          steps: [{ step: "Verify", status: "inProgress" }],
        }),
      });
    });
    expect(dispatch).not.toHaveBeenCalledWith({
      type: "clearThreadPlan",
      threadId: "thread-1",
    });
  });

  it("keeps an unfinished terminal plan live while post-terminal activity repeats", () => {
    const { result, dispatch } = makeOptions();
    vi.mocked(normalizePlanUpdate).mockReturnValue({
      turnId: "turn-6",
      explanation: "Incomplete",
      steps: [{ step: "Verify", status: "inProgress" }],
    });

    act(() => {
      result.current.onTurnCompleted("ws-1", "thread-1", "turn-6");
      result.current.onTurnPlanUpdated("ws-1", "thread-1", "turn-6", {
        explanation: "Incomplete",
        plan: [],
      });
    });

    act(() => {
      result.current.onThreadActivity("ws-1", "thread-1");
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadPlan",
      threadId: "thread-1",
      plan: expect.objectContaining({
        syncState: "live",
        steps: [{ step: "Verify", status: "inProgress" }],
      }),
    });
  });

  it("does not let a late terminal plan overwrite a newer turn plan", () => {
    const newerPlan: TurnPlan = {
      turnId: "turn-2",
      explanation: "Current turn",
      steps: [{ step: "Continue", status: "inProgress" }],
    };
    const { result, dispatch, planByThreadRef } = makeOptions({
      planByThread: { "thread-1": newerPlan },
    });
    vi.mocked(normalizePlanUpdate).mockReturnValue({
      turnId: "turn-1",
      explanation: "Old turn done",
      steps: [{ step: "Old work", status: "completed" }],
    });

    act(() => {
      result.current.onTurnCompleted("ws-1", "thread-1", "turn-1");
      result.current.onTurnStarted("ws-1", "thread-1", "turn-2");
      result.current.onTurnPlanUpdated("ws-1", "thread-1", "turn-1", {
        explanation: "Old turn done",
        plan: [],
      });
    });

    expect(planByThreadRef.current["thread-1"]).toEqual(newerPlan);
    expect(dispatch).not.toHaveBeenCalledWith({
      type: "clearThreadPlan",
      threadId: "thread-1",
    });
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "setThreadPlan" }),
    );
  });

  it("dispatches turn diff updates", () => {
    const { result, dispatch } = makeOptions();

    act(() => {
      result.current.onTurnDiffUpdated("ws-1", "thread-1", "diff --git a/file b/file");
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "ensureThread",
      workspaceId: "ws-1",
      threadId: "thread-1",
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadTurnDiff",
      threadId: "thread-1",
      diff: "diff --git a/file b/file",
    });
  });

  it("dispatches normalized token usage updates", () => {
    const { result, dispatch } = makeOptions();
    const normalized = { total: 123 };

    vi.mocked(normalizeTokenUsage).mockReturnValue(normalized as never);

    act(() => {
      result.current.onThreadTokenUsageUpdated("ws-1", "thread-1", {
        total: 123,
      });
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "ensureThread",
      workspaceId: "ws-1",
      threadId: "thread-1",
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadTokenUsage",
      threadId: "thread-1",
      tokenUsage: normalized,
    });
  });

  it("dispatches normalized rate limits updates", () => {
    const previousRateLimits = {
      primary: {
        usedPercent: 35,
        windowDurationMins: 60,
        resetsAt: 1_700_000_000,
      },
      secondary: null,
      credits: null,
      planType: null,
    } satisfies RateLimitSnapshot;

    const { result, dispatch, getCurrentRateLimits } = makeOptions({
      rateLimitsByWorkspace: { "ws-1": previousRateLimits },
    });
    const normalized = { primary: { usedPercent: 10 } };

    vi.mocked(normalizeRateLimits).mockReturnValue(normalized as never);

    act(() => {
      result.current.onAccountRateLimitsUpdated("ws-1", { primary: {} });
    });

    expect(getCurrentRateLimits).toHaveBeenCalledWith("ws-1");
    expect(normalizeRateLimits).toHaveBeenCalledWith(
      { primary: {} },
      previousRateLimits,
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "setRateLimits",
      workspaceId: "ws-1",
      rateLimits: normalized,
    });
  });

  it("handles turn errors when retries are disabled", () => {
    const {
      result,
      dispatch,
      markProcessing,
      markReviewing,
      setActiveTurnId,
      pushThreadErrorMessage,
      recordThreadActivity,
      safeMessageActivity,
    } = makeOptions();

    act(() => {
      result.current.onTurnError("ws-1", "thread-1", "turn-1", {
        message: "boom",
        willRetry: false,
      });
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "ensureThread",
      workspaceId: "ws-1",
      threadId: "thread-1",
    });
    expect(markProcessing).toHaveBeenCalledWith("thread-1", false);
    expect(markReviewing).toHaveBeenCalledWith("thread-1", false);
    expect(setActiveTurnId).toHaveBeenCalledWith("thread-1", null);
    expect(pushThreadErrorMessage).toHaveBeenCalledWith(
      "thread-1",
      "Turn failed: boom",
      "turn-1",
    );
    expect(recordThreadActivity).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      expect.any(Number),
    );
    expect(safeMessageActivity).toHaveBeenCalled();
  });

  it("ignores stale turn errors for non-active turns", () => {
    const {
      result,
      dispatch,
      markProcessing,
      markReviewing,
      setActiveTurnId,
      pushThreadErrorMessage,
    } = makeOptions({
      activeTurnByThread: {
        "thread-1": "turn-active",
      },
    });

    act(() => {
      result.current.onTurnError("ws-1", "thread-1", "turn-stale", {
        message: "boom",
        willRetry: false,
      });
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(markProcessing).not.toHaveBeenCalled();
    expect(markReviewing).not.toHaveBeenCalled();
    expect(setActiveTurnId).not.toHaveBeenCalled();
    expect(pushThreadErrorMessage).not.toHaveBeenCalled();
  });

  it("handles new-turn errors even when reducer active turn id is stale", () => {
    const {
      result,
      dispatch,
      markProcessing,
      markReviewing,
      setActiveTurnId,
      pushThreadErrorMessage,
    } = makeOptions({
      activeTurnByThread: {
        "thread-1": "turn-old",
      },
    });

    act(() => {
      result.current.onTurnStarted("ws-1", "thread-1", "turn-new");
      result.current.onTurnError("ws-1", "thread-1", "turn-new", {
        message: "boom",
        willRetry: false,
      });
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "ensureThread",
      workspaceId: "ws-1",
      threadId: "thread-1",
    });
    expect(markProcessing).toHaveBeenLastCalledWith("thread-1", false);
    expect(markReviewing).toHaveBeenCalledWith("thread-1", false);
    expect(setActiveTurnId).toHaveBeenLastCalledWith("thread-1", null);
    expect(pushThreadErrorMessage).toHaveBeenCalledWith(
      "thread-1",
      "Turn failed: boom",
      "turn-new",
    );
  });

  it("handles errors after reducer active turn changes externally", () => {
    const activeTurnByThread: Record<string, string | null> = {
      "thread-1": "turn-old",
    };
    const {
      result,
      markProcessing,
      markReviewing,
      setActiveTurnId,
      pushThreadErrorMessage,
    } = makeOptions({
      activeTurnByThread,
    });

    act(() => {
      result.current.onTurnStarted("ws-1", "thread-1", "turn-local");
    });
    activeTurnByThread["thread-1"] = "turn-resumed";

    act(() => {
      result.current.onTurnError("ws-1", "thread-1", "turn-resumed", {
        message: "boom",
        willRetry: false,
      });
    });

    expect(markProcessing).toHaveBeenNthCalledWith(1, "thread-1", true);
    expect(markProcessing).toHaveBeenNthCalledWith(2, "thread-1", false);
    expect(markReviewing).toHaveBeenCalledWith("thread-1", false);
    expect(setActiveTurnId).toHaveBeenNthCalledWith(1, "thread-1", "turn-local");
    expect(setActiveTurnId).toHaveBeenNthCalledWith(2, "thread-1", null);
    expect(pushThreadErrorMessage).toHaveBeenCalledWith(
      "thread-1",
      "Turn failed: boom",
      "turn-resumed",
    );
  });

  it("ignores turn errors that will retry", () => {
    const { result, dispatch, markProcessing } = makeOptions();

    act(() => {
      result.current.onTurnError("ws-1", "thread-1", "turn-1", {
        message: "boom",
        willRetry: true,
      });
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(markProcessing).not.toHaveBeenCalled();
  });

});
