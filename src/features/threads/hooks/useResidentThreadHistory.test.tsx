// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConversationItem } from "@/types";
import {
  MAX_RESIDENT_THREAD_HISTORIES,
  getProtectedResidentThreadIds,
  selectResidentThreadEvictions,
  useResidentThreadHistory,
} from "./useResidentThreadHistory";

function buildItemsByThread(count: number) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `thread-${index + 1}`,
      [
        {
          id: `message-${index + 1}`,
          kind: "message",
          role: "assistant",
          text: `message ${index + 1}`,
        },
      ] as ConversationItem[],
    ]),
  );
}

describe("useResidentThreadHistory", () => {
  it("keeps only the recent history budget and restores evicted threads by replacement", async () => {
    const itemsByThread = buildItemsByThread(MAX_RESIDENT_THREAD_HISTORIES + 3);
    const itemsByThreadRef = { current: itemsByThread };
    const loadedThreadsRef = {
      current: Object.fromEntries(
        Object.keys(itemsByThread).map((threadId) => [threadId, true]),
      ),
    };
    const loadedThreadRuntimeKeyRef = {
      current: Object.fromEntries(
        Object.keys(itemsByThread).map((threadId) => [threadId, "runtime-1"]),
      ),
    };
    const dispatch = vi.fn();
    const readThreadForWorkspace = vi.fn(async (_workspaceId, threadId) => threadId);

    const { result } = renderHook(() =>
      useResidentThreadHistory({
        activeThreadId: `thread-${MAX_RESIDENT_THREAD_HISTORIES + 3}`,
        itemsByThread,
        itemsByThreadRef,
        threadStatusById: {},
        threadResumeLoadingById: {},
        threadHistoryRestoreStateById: {},
        threadHistoryRecoveryAnchorThreadId: null,
        activeTurnIdByThread: {},
        approvals: [],
        userInputRequests: [],
        pendingUserMessageReplacementByThread: {},
        loadedThreadsRef,
        loadedThreadRuntimeKeyRef,
        runtimeKey: "runtime-1",
        dispatch,
        readThreadForWorkspace,
      }),
    );

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: "evictThreadItems",
        threadIds: ["thread-1", "thread-2", "thread-3"],
      });
    });
    expect(Object.keys(itemsByThreadRef.current)).toHaveLength(
      MAX_RESIDENT_THREAD_HISTORIES,
    );
    expect(loadedThreadsRef.current["thread-1"]).toBe(false);
    expect(loadedThreadRuntimeKeyRef.current["thread-1"]).toBeUndefined();

    await result.current.restoreThreadHistory("ws-1", "thread-1");

    expect(readThreadForWorkspace).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      false,
      true,
    );
    expect(result.current.isThreadHistoryEvicted("thread-1")).toBe(false);
  });

  it("never evicts active, processing, interaction, or replacement threads", () => {
    const protectedThreadIds = getProtectedResidentThreadIds({
      activeThreadId: "thread-active",
      threadStatusById: {
        "thread-processing": {
          isProcessing: true,
          hasUnread: false,
          isReviewing: false,
          processingStartedAt: 1,
          lastDurationMs: null,
        },
        "thread-review": {
          isProcessing: false,
          hasUnread: false,
          isReviewing: true,
          processingStartedAt: null,
          lastDurationMs: null,
        },
      },
      threadResumeLoadingById: { "thread-loading": true },
      threadHistoryRestoreStateById: { "thread-retrying": "loading" },
      threadHistoryRecoveryAnchorThreadId: "thread-failed",
      activeTurnIdByThread: { "thread-turn": "turn-1" },
      approvals: [
        {
          workspace_id: "ws-1",
          request_id: 1,
          method: "approval/request",
          params: { thread_id: "thread-approval" },
        },
      ],
      userInputRequests: [
        {
          workspace_id: "ws-1",
          request_id: 2,
          params: {
            thread_id: "thread-input",
            turn_id: "turn-2",
            item_id: "item-2",
            questions: [],
          },
        },
      ],
      pendingUserMessageReplacementByThread: {
        "thread-replacement": { messageId: "message-1", text: "pending" },
      },
    });
    const protectedIds = [...protectedThreadIds];
    const residents = [
      ...protectedIds,
      ...Array.from({ length: 10 }, (_, index) => `recent-${index}`),
    ];
    const evicted = selectResidentThreadEvictions(
      residents,
      residents,
      protectedThreadIds,
      2,
    );

    protectedIds.forEach((threadId) => {
      expect(evicted).not.toContain(threadId);
    });
  });

  it("keeps one failed recovery anchor outside the recent history budget", () => {
    const protectedThreadIds = getProtectedResidentThreadIds({
      activeThreadId: "thread-active",
      threadStatusById: {},
      threadResumeLoadingById: {},
      threadHistoryRestoreStateById: {},
      threadHistoryRecoveryAnchorThreadId: "thread-failed",
      activeTurnIdByThread: {},
      approvals: [],
      userInputRequests: [],
      pendingUserMessageReplacementByThread: {},
    });
    const residents = [
      "thread-failed",
      "thread-old",
      "thread-recent",
      "thread-active",
    ];

    const evicted = selectResidentThreadEvictions(
      residents,
      residents,
      protectedThreadIds,
      MAX_RESIDENT_THREAD_HISTORIES,
    );

    expect(evicted).toEqual(["thread-old"]);
    expect(residents.filter((threadId) => !evicted.includes(threadId))).toHaveLength(
      MAX_RESIDENT_THREAD_HISTORIES + 1,
    );
  });

  it("retries an evicted history read before reporting recovery failure", async () => {
    vi.useFakeTimers();
    const itemsByThread = buildItemsByThread(1);
    const itemsByThreadRef = { current: itemsByThread };
    const loadedThreadsRef = { current: { "thread-1": true } };
    const loadedThreadRuntimeKeyRef = { current: { "thread-1": "runtime-1" } };
    const dispatch = vi.fn();
    const readThreadForWorkspace = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("thread-1");

    const { result } = renderHook(() =>
      useResidentThreadHistory({
        activeThreadId: "thread-1",
        itemsByThread,
        itemsByThreadRef,
        threadStatusById: {},
        threadResumeLoadingById: {},
        threadHistoryRestoreStateById: {},
        threadHistoryRecoveryAnchorThreadId: null,
        activeTurnIdByThread: {},
        approvals: [],
        userInputRequests: [],
        pendingUserMessageReplacementByThread: {},
        loadedThreadsRef,
        loadedThreadRuntimeKeyRef,
        runtimeKey: "runtime-1",
        dispatch,
        readThreadForWorkspace,
      }),
    );

    let restorePromise!: Promise<string | null>;
    act(() => {
      restorePromise = result.current.restoreThreadHistory("ws-1", "thread-1");
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(readThreadForWorkspace).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadHistoryRestoreState",
      threadId: "thread-1",
      state: "loading",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(readThreadForWorkspace).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await restorePromise;
    });

    expect(readThreadForWorkspace).toHaveBeenCalledTimes(3);
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "setThreadHistoryRestoreState",
      threadId: "thread-1",
      state: null,
    });
    vi.useRealTimers();
  });

  it("reports recovery failure after bounded history retries", async () => {
    vi.useFakeTimers();
    const itemsByThread = buildItemsByThread(1);
    const dispatch = vi.fn();
    const readThreadForWorkspace = vi.fn().mockResolvedValue(null);
    const { result } = renderHook(() =>
      useResidentThreadHistory({
        activeThreadId: "thread-1",
        itemsByThread,
        itemsByThreadRef: { current: itemsByThread },
        threadStatusById: {},
        threadResumeLoadingById: {},
        threadHistoryRestoreStateById: {},
        threadHistoryRecoveryAnchorThreadId: null,
        activeTurnIdByThread: {},
        approvals: [],
        userInputRequests: [],
        pendingUserMessageReplacementByThread: {},
        loadedThreadsRef: { current: { "thread-1": true } },
        loadedThreadRuntimeKeyRef: { current: { "thread-1": "runtime-1" } },
        runtimeKey: "runtime-1",
        dispatch,
        readThreadForWorkspace,
      }),
    );

    let restoredThreadId: string | null = "unexpected";
    await act(async () => {
      const restorePromise = result.current.restoreThreadHistory("ws-1", "thread-1");
      await vi.advanceTimersByTimeAsync(1300);
      restoredThreadId = await restorePromise;
    });

    expect(restoredThreadId).toBeNull();
    expect(readThreadForWorkspace).toHaveBeenCalledTimes(3);
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "setThreadHistoryRestoreState",
      threadId: "thread-1",
      state: "failed",
    });
    vi.useRealTimers();
  });
});
