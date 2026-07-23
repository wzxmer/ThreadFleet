import { describe, expect, it } from "vitest";
import type { ConversationItem, ThreadSummary, TurnExecutionSummary } from "@/types";
import { getActivePlanStream } from "@/features/plan/planStream";
import { buildConversationItem } from "@utils/threadItems";
import { buildItemForDisplay } from "./threadItemEventHelpers";
import { initialState, threadReducer } from "./useThreadsReducer";
import type { ThreadState } from "./useThreadsReducer";

describe("threadReducer", () => {
  it("ensures thread with default name and active selection", () => {
    const next = threadReducer(initialState, {
      type: "ensureThread",
      workspaceId: "ws-1",
      threadId: "thread-1",
    });
    const threads = next.threadsByWorkspace["ws-1"] ?? [];
    expect(threads).toHaveLength(1);
    expect(threads[0].name).toBe("New Agent");
    expect(next.activeThreadIdByWorkspace["ws-1"]).toBe("thread-1");
    expect(next.threadStatusById["thread-1"]?.isProcessing).toBe(false);
  });

  it("keeps context token usage isolated between sessions", () => {
    const usageA = {
      total: {
        totalTokens: 10_000,
        inputTokens: 9_000,
        cachedInputTokens: 0,
        outputTokens: 1_000,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: 2_000,
        inputTokens: 1_800,
        cachedInputTokens: 0,
        outputTokens: 200,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: 100_000,
    };
    const usageB = {
      ...usageA,
      last: { ...usageA.last, totalTokens: 80_000 },
    };

    const withSessionA = threadReducer(initialState, {
      type: "setThreadTokenUsage",
      threadId: "thread-a",
      tokenUsage: usageA,
    });
    const withBothSessions = threadReducer(withSessionA, {
      type: "setThreadTokenUsage",
      threadId: "thread-b",
      tokenUsage: usageB,
    });

    expect(withBothSessions.tokenUsageByThread["thread-a"]).toEqual(usageA);
    expect(withBothSessions.tokenUsageByThread["thread-b"]).toEqual(usageB);
  });

  it("counts completed context compactions once across hydration and live events", () => {
    const completed = {
      id: "compact-1",
      kind: "tool" as const,
      toolType: "contextCompaction",
      title: "Context compaction",
      detail: "",
      status: "completed",
    };
    const hydrated = threadReducer(initialState, {
      type: "setThreadItems",
      threadId: "thread-1",
      items: [completed],
    });
    const duplicated = threadReducer(hydrated, {
      type: "upsertItem",
      workspaceId: "ws-1",
      threadId: "thread-1",
      item: completed,
    });
    const inProgress = threadReducer(duplicated, {
      type: "upsertItem",
      workspaceId: "ws-1",
      threadId: "thread-1",
      item: {
        ...completed,
        id: "compact-2",
        status: "inProgress",
      },
    });

    expect(
      Object.keys(
        inProgress.completedContextCompactionIdsByThread["thread-1"] ?? {},
      ),
    ).toEqual(["compact-1"]);
  });

  it("keeps completed compaction counts when resident message history is evicted", () => {
    const hydrated = threadReducer(initialState, {
      type: "setThreadItems",
      threadId: "thread-1",
      items: [
        {
          id: "compact-1",
          kind: "tool",
          toolType: "contextCompaction",
          title: "Context compaction",
          detail: "",
          status: "completed",
        },
      ],
    });
    const evicted = threadReducer(hydrated, {
      type: "evictThreadItems",
      threadIds: ["thread-1"],
    });

    expect(evicted.itemsByThread["thread-1"]).toBeUndefined();
    expect(
      Object.keys(
        evicted.completedContextCompactionIdsByThread["thread-1"] ?? {},
      ),
    ).toEqual(["compact-1"]);
  });

  it("renames auto-generated thread on first user message", () => {
    const threads: ThreadSummary[] = [
      { id: "thread-1", name: "New Agent", updatedAt: 1 },
    ];
    const next = threadReducer(
      {
        ...initialState,
        threadsByWorkspace: { "ws-1": threads },
      },
      {
        type: "upsertItem",
        workspaceId: "ws-1",
        threadId: "thread-1",
        item: {
          id: "user-1",
          kind: "message",
          role: "user",
          text: "Hello there",
        },
        hasCustomName: false,
      },
    );
    expect(next.threadsByWorkspace["ws-1"]?.[0]?.name).toBe("Hello there");
    const items = next.itemsByThread["thread-1"] ?? [];
    expect(items).toHaveLength(1);
    if (items[0]?.kind === "message") {
      expect(items[0].id).toBe("user-1");
      expect(items[0].text).toBe("Hello there");
    }
  });

  it("renames auto-generated thread from assistant output when no user message", () => {
    const threads: ThreadSummary[] = [
      { id: "thread-1", name: "New Agent", updatedAt: 1 },
    ];
    const next = threadReducer(
      {
        ...initialState,
        threadsByWorkspace: { "ws-1": threads },
        itemsByThread: { "thread-1": [] },
      },
      {
        type: "appendAgentDelta",
        workspaceId: "ws-1",
        threadId: "thread-1",
        itemId: "assistant-1",
        delta: "Assistant note",
        hasCustomName: false,
      },
    );
    expect(next.threadsByWorkspace["ws-1"]?.[0]?.name).toBe("Assistant note");
  });

  it("stores the completed agent message phase", () => {
    const streaming = threadReducer(initialState, {
      type: "appendAgentDelta",
      workspaceId: "ws-1",
      threadId: "thread-1",
      itemId: "assistant-1",
      delta: "Working",
      hasCustomName: false,
    });
    const completed = threadReducer(streaming, {
      type: "completeAgentMessage",
      workspaceId: "ws-1",
      threadId: "thread-1",
      itemId: "assistant-1",
      turnId: "turn-1",
      text: "Working",
      phase: "commentary",
      hasCustomName: false,
    });

    expect(completed.itemsByThread["thread-1"]?.[0]).toMatchObject({
      id: "assistant-1",
      phase: "commentary",
      turnId: "turn-1",
    });
  });

  it("updates thread timestamp when newer activity arrives", () => {
    const threads: ThreadSummary[] = [
      { id: "thread-1", name: "Agent 1", updatedAt: 1000 },
    ];
    const next = threadReducer(
      {
        ...initialState,
        threadsByWorkspace: { "ws-1": threads },
      },
      {
        type: "setThreadTimestamp",
        workspaceId: "ws-1",
        threadId: "thread-1",
        timestamp: 1500,
      },
    );
    expect(next.threadsByWorkspace["ws-1"]?.[0]?.updatedAt).toBe(1500);
  });

  it("moves active thread to top on timestamp updates when sorted by updated_at", () => {
    const threads: ThreadSummary[] = [
      { id: "thread-1", name: "Agent 1", updatedAt: 1000 },
      { id: "thread-2", name: "Agent 2", updatedAt: 900 },
    ];
    const next = threadReducer(
      {
        ...initialState,
        threadsByWorkspace: { "ws-1": threads },
        threadSortKeyByWorkspace: { "ws-1": "updated_at" },
      },
      {
        type: "setThreadTimestamp",
        workspaceId: "ws-1",
        threadId: "thread-2",
        timestamp: 1500,
      },
    );
    expect(next.threadsByWorkspace["ws-1"]?.map((thread) => thread.id)).toEqual([
      "thread-2",
      "thread-1",
    ]);
  });

  it("keeps ordering stable on timestamp updates when sorted by created_at", () => {
    const threads: ThreadSummary[] = [
      { id: "thread-1", name: "Agent 1", updatedAt: 1000 },
      { id: "thread-2", name: "Agent 2", updatedAt: 900 },
    ];
    const next = threadReducer(
      {
        ...initialState,
        threadsByWorkspace: { "ws-1": threads },
        threadSortKeyByWorkspace: { "ws-1": "created_at" },
      },
      {
        type: "setThreadTimestamp",
        workspaceId: "ws-1",
        threadId: "thread-2",
        timestamp: 1500,
      },
    );
    expect(next.threadsByWorkspace["ws-1"]?.map((thread) => thread.id)).toEqual([
      "thread-1",
      "thread-2",
    ]);
  });

  it("does not churn state for unchanged thread names", () => {
    const base = {
      ...initialState,
      threadsByWorkspace: {
        "ws-1": [{ id: "thread-1", name: "Agent 1", updatedAt: 1000 }],
      },
    };

    expect(
      threadReducer(base, {
        type: "setThreadName",
        workspaceId: "ws-1",
        threadId: "thread-1",
        name: "Agent 1",
      }),
    ).toBe(base);
  });

  it("tracks processing durations", () => {
    const started = threadReducer(
      {
        ...initialState,
        threadStatusById: {
          "thread-1": {
            isProcessing: false,
            hasUnread: false,
            isReviewing: false,
            processingStartedAt: null,
            lastDurationMs: null,
          },
        },
      },
      {
        type: "markProcessing",
        threadId: "thread-1",
        isProcessing: true,
        timestamp: 1000,
      },
    );
    const stopped = threadReducer(started, {
      type: "markProcessing",
      threadId: "thread-1",
      isProcessing: false,
      timestamp: 1600,
    });
    expect(stopped.threadStatusById["thread-1"]?.lastDurationMs).toBe(600);
  });

  it("does not churn state for repeated processing=true updates", () => {
    const processingState = threadReducer(
      {
        ...initialState,
        threadStatusById: {
          "thread-1": {
            isProcessing: true,
            hasUnread: false,
            isReviewing: false,
            processingStartedAt: 1000,
            lastDurationMs: null,
          },
        },
      },
      {
        type: "markProcessing",
        threadId: "thread-1",
        isProcessing: true,
        timestamp: 1200,
      },
    );

    expect(processingState).toBe(
      threadReducer(processingState, {
        type: "markProcessing",
        threadId: "thread-1",
        isProcessing: true,
        timestamp: 1400,
      }),
    );
  });

  it("does not churn state for unchanged unread/review flags", () => {
    const base = {
      ...initialState,
      threadStatusById: {
        "thread-1": {
          isProcessing: false,
          hasUnread: true,
          isReviewing: true,
          processingStartedAt: null,
          lastDurationMs: 300,
        },
      },
    };

    const unread = threadReducer(base, {
      type: "markUnread",
      threadId: "thread-1",
      hasUnread: true,
    });
    expect(unread).toBe(base);

    const reviewing = threadReducer(base, {
      type: "markReviewing",
      threadId: "thread-1",
      isReviewing: true,
    });
    expect(reviewing).toBe(base);
  });

  it("tracks request user input queue", () => {
    const request = {
      workspace_id: "ws-1",
      request_id: 99,
      params: {
        thread_id: "thread-1",
        turn_id: "turn-1",
        item_id: "call-1",
        questions: [{ id: "q1", header: "Confirm", question: "Proceed?" }],
      },
    };
    const added = threadReducer(initialState, {
      type: "addUserInputRequest",
      request,
    });
    expect(added.userInputRequests).toHaveLength(1);
    expect(added.userInputRequests[0]).toEqual(request);

    const removed = threadReducer(added, {
      type: "removeUserInputRequest",
      requestId: 99,
      workspaceId: "ws-1",
    });
    expect(removed.userInputRequests).toHaveLength(0);
  });

  it("drops local review-start items when server review starts", () => {
    const localReview: ConversationItem = {
      id: "review-start-1",
      kind: "review",
      state: "started",
      text: "",
    };
    const incomingReview: ConversationItem = {
      id: "remote-review-1",
      kind: "review",
      state: "started",
      text: "",
    };
    const next = threadReducer(
      {
        ...initialState,
        itemsByThread: { "thread-1": [localReview] },
      },
      {
        type: "upsertItem",
        workspaceId: "ws-1",
        threadId: "thread-1",
        item: incomingReview,
      },
    );
    const items = next.itemsByThread["thread-1"] ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("remote-review-1");
  });

  it("appends review items when ids repeat", () => {
    const firstReview: ConversationItem = {
      id: "review-mode",
      kind: "review",
      state: "started",
      text: "Reviewing changes",
    };
    const next = threadReducer(
      {
        ...initialState,
        itemsByThread: { "thread-1": [firstReview] },
      },
      {
        type: "upsertItem",
        workspaceId: "ws-1",
        threadId: "thread-1",
        item: {
          id: "review-mode",
          kind: "review",
          state: "completed",
          text: "Reviewing changes",
        },
      },
    );
    const items = next.itemsByThread["thread-1"] ?? [];
    expect(items).toHaveLength(2);
    expect(items[0]?.id).toBe("review-mode");
    expect(items[1]?.id).toBe("review-mode-1");
  });

  it("ignores duplicate review items with identical id, state, and text", () => {
    const firstReview: ConversationItem = {
      id: "review-mode",
      kind: "review",
      state: "started",
      text: "Reviewing changes",
    };
    const next = threadReducer(
      {
        ...initialState,
        itemsByThread: { "thread-1": [firstReview] },
      },
      {
        type: "upsertItem",
        workspaceId: "ws-1",
        threadId: "thread-1",
        item: {
          id: "review-mode",
          kind: "review",
          state: "started",
          text: "Reviewing changes",
        },
      },
    );
    const items = next.itemsByThread["thread-1"] ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("review-mode");
  });

  it("dedupes review items with identical content", () => {
    const firstReview: ConversationItem = {
      id: "review-mode",
      kind: "review",
      state: "completed",
      text: "Reviewing changes",
    };
    const next = threadReducer(
      {
        ...initialState,
        itemsByThread: { "thread-1": [firstReview] },
      },
      {
        type: "upsertItem",
        workspaceId: "ws-1",
        threadId: "thread-1",
        item: {
          id: "review-mode-duplicate",
          kind: "review",
          state: "completed",
          text: "Reviewing changes",
        },
      },
    );
    const items = next.itemsByThread["thread-1"] ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("review-mode");
  });

  it("creates and appends plan deltas when no plan tool item exists", () => {
    const next = threadReducer(initialState, {
      type: "appendPlanDelta",
      threadId: "thread-1",
      itemId: "plan-1",
      delta: "- Step 1",
    });
    const items = next.itemsByThread["thread-1"] ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "plan-1",
      kind: "tool",
      toolType: "plan",
      title: "Plan",
      output: "- Step 1",
    });
    expect(next.planByThread["thread-1"]).toBeUndefined();
  });

  it("keeps delta-only plan streams separate from structured turn plans", () => {
    const withFirstDelta = threadReducer(initialState, {
      type: "appendPlanDelta",
      threadId: "thread-1",
      itemId: "plan-1",
      delta: "- Inspect source\n",
    });
    const next = threadReducer(withFirstDelta, {
      type: "appendPlanDelta",
      threadId: "thread-1",
      itemId: "plan-1",
      delta: "- Run tests",
    });

    expect(next.itemsByThread["thread-1"]?.[0]).toMatchObject({
      id: "plan-1",
      toolType: "plan",
      output: "- Inspect source\n- Run tests",
    });
    expect(next.planByThread["thread-1"]).toBeUndefined();
  });

  it("clears a delta plan stream when its status-less completed item arrives", () => {
    const withDelta = threadReducer(initialState, {
      type: "appendPlanDelta",
      threadId: "thread-1",
      itemId: "plan-1",
      delta: "- Inspect source\n- Run tests",
    });
    const completed = buildConversationItem(
      buildItemForDisplay(
        {
          type: "plan",
          id: "plan-1",
          text: "- Inspect source\n- Run tests",
        },
        false,
      ),
    );
    expect(completed).not.toBeNull();

    const next = threadReducer(withDelta, {
      type: "upsertItem",
      workspaceId: "ws-1",
      threadId: "thread-1",
      item: completed!,
    });
    const items = next.itemsByThread["thread-1"] ?? [];

    expect(items[0]).toMatchObject({
      id: "plan-1",
      status: "completed",
    });
    expect(getActivePlanStream(items)).toBeNull();
  });

  it("appends reasoning summary and content when missing", () => {
    const withSummary = threadReducer(initialState, {
      type: "appendReasoningSummary",
      threadId: "thread-1",
      itemId: "reasoning-1",
      delta: "Short plan",
    });
    const summaryItem = withSummary.itemsByThread["thread-1"]?.[0];
    expect(summaryItem?.kind).toBe("reasoning");
    if (summaryItem?.kind === "reasoning") {
      expect(summaryItem.summary).toBe("Short plan");
      expect(summaryItem.content).toBe("");
    }

    const withContent = threadReducer(withSummary, {
      type: "appendReasoningContent",
      threadId: "thread-1",
      itemId: "reasoning-1",
      delta: "More detail",
    });
    const contentItem = withContent.itemsByThread["thread-1"]?.[0];
    expect(contentItem?.kind).toBe("reasoning");
    if (contentItem?.kind === "reasoning") {
      expect(contentItem.summary).toBe("Short plan");
      expect(contentItem.content).toBe("More detail");
    }
  });

  it("inserts a reasoning summary boundary between sections", () => {
    const withSummary = threadReducer(initialState, {
      type: "appendReasoningSummary",
      threadId: "thread-1",
      itemId: "reasoning-1",
      delta: "Exploring files",
    });
    const withBoundary = threadReducer(withSummary, {
      type: "appendReasoningSummaryBoundary",
      threadId: "thread-1",
      itemId: "reasoning-1",
    });
    const withSecondSummary = threadReducer(withBoundary, {
      type: "appendReasoningSummary",
      threadId: "thread-1",
      itemId: "reasoning-1",
      delta: "Searching for routes",
    });

    const item = withSecondSummary.itemsByThread["thread-1"]?.[0];
    expect(item?.kind).toBe("reasoning");
    if (item?.kind === "reasoning") {
      expect(item.summary).toBe("Exploring files\n\nSearching for routes");
    }
  });

  it("ignores tool output deltas when the item is not a tool", () => {
    const message: ConversationItem = {
      id: "tool-1",
      kind: "message",
      role: "assistant",
      text: "Hi",
    };
    const base: ThreadState = {
      ...initialState,
      itemsByThread: { "thread-1": [message] },
    };
    const next = threadReducer(base, {
      type: "appendToolOutput",
      threadId: "thread-1",
      itemId: "tool-1",
      delta: "delta",
    });
    expect(next).toBe(base);
  });

  it("adds and removes user input requests by workspace and id", () => {
    const requestA = {
      workspace_id: "ws-1",
      request_id: 1,
      params: {
        thread_id: "thread-1",
        turn_id: "turn-1",
        item_id: "item-1",
        questions: [],
      },
    };
    const requestB = {
      workspace_id: "ws-2",
      request_id: 1,
      params: {
        thread_id: "thread-2",
        turn_id: "turn-2",
        item_id: "item-2",
        questions: [],
      },
    };

    const added = threadReducer(initialState, {
      type: "addUserInputRequest",
      request: requestA,
    });
    expect(added.userInputRequests).toEqual([requestA]);

    const deduped = threadReducer(added, {
      type: "addUserInputRequest",
      request: requestA,
    });
    expect(deduped.userInputRequests).toHaveLength(1);

    const withSecond = threadReducer(added, {
      type: "addUserInputRequest",
      request: requestB,
    });
    expect(withSecond.userInputRequests).toHaveLength(2);

    const removed = threadReducer(withSecond, {
      type: "removeUserInputRequest",
      requestId: 1,
      workspaceId: "ws-1",
    });
    expect(removed.userInputRequests).toEqual([requestB]);
  });

  it("stores turn diff updates by thread id", () => {
    const next = threadReducer(initialState, {
      type: "setThreadTurnDiff",
      threadId: "thread-1",
      diff: "diff --git a/file.ts b/file.ts",
    });

    expect(next.turnDiffByThread["thread-1"]).toBe(
      "diff --git a/file.ts b/file.ts",
    );
  });

  it("clears turn diff state when a thread is removed", () => {
    const base: ThreadState = {
      ...initialState,
      threadsByWorkspace: {
        "ws-1": [{ id: "thread-1", name: "Agent 1", updatedAt: 1 }],
      },
      activeThreadIdByWorkspace: { "ws-1": "thread-1" },
      turnDiffByThread: { "thread-1": "diff --git a/file.ts b/file.ts" },
    };

    const next = threadReducer(base, {
      type: "removeThread",
      workspaceId: "ws-1",
      threadId: "thread-1",
    });

    expect(next.turnDiffByThread["thread-1"]).toBeUndefined();
  });

  it("hides background threads and keeps them hidden on future syncs", () => {
    const withThread = threadReducer(initialState, {
      type: "ensureThread",
      workspaceId: "ws-1",
      threadId: "thread-bg",
    });
    expect(withThread.threadsByWorkspace["ws-1"]?.some((t) => t.id === "thread-bg")).toBe(true);

    const hidden = threadReducer(withThread, {
      type: "hideThread",
      workspaceId: "ws-1",
      threadId: "thread-bg",
    });
    expect(hidden.threadsByWorkspace["ws-1"]?.some((t) => t.id === "thread-bg")).toBe(false);

    const synced = threadReducer(hidden, {
      type: "setThreads",
      workspaceId: "ws-1",
      sortKey: "updated_at",
      threads: [
        { id: "thread-bg", name: "Agent 1", updatedAt: Date.now() },
        { id: "thread-visible", name: "Agent 2", updatedAt: Date.now() },
      ],
    });
    const ids = synced.threadsByWorkspace["ws-1"]?.map((t) => t.id) ?? [];
    expect(ids).toContain("thread-visible");
    expect(ids).not.toContain("thread-bg");
  });

  it("preserves active, processing, and ancestor anchors on partial setThreads payloads", () => {
    const base: ThreadState = {
      ...initialState,
      threadsByWorkspace: {
        "ws-1": [
          { id: "thread-parent", name: "Parent (stale)", updatedAt: 10 },
          { id: "thread-child", name: "Child (stale)", updatedAt: 11 },
          { id: "thread-active", name: "Active", updatedAt: 12 },
          { id: "thread-processing", name: "Processing", updatedAt: 13 },
        ],
      },
      activeThreadIdByWorkspace: { "ws-1": "thread-active" },
      threadParentById: {
        "thread-child": "thread-parent",
      },
      threadStatusById: {
        "thread-processing": {
          isProcessing: true,
          hasUnread: false,
          isReviewing: false,
          processingStartedAt: null,
          lastDurationMs: null,
        },
      },
      lastAgentMessageByThread: {
        "thread-parent": {
          text: "Parent fresh preview",
          timestamp: 300,
        },
      },
    };

    const next = threadReducer(base, {
      type: "setThreads",
      workspaceId: "ws-1",
      sortKey: "updated_at",
      preserveAnchors: true,
      threads: [
        { id: "thread-child", name: "Child (fresh)", updatedAt: 200 },
        { id: "thread-new", name: "New", updatedAt: 199 },
      ],
    });

    expect(next.threadsByWorkspace["ws-1"]?.map((thread) => thread.id)).toEqual([
      "thread-parent",
      "thread-child",
      "thread-new",
      "thread-processing",
      "thread-active",
    ]);
    expect(
      next.threadsByWorkspace["ws-1"]?.find((thread) => thread.id === "thread-child")
        ?.name,
    ).toBe("Child (fresh)");
    expect(
      next.threadsByWorkspace["ws-1"]?.find((thread) => thread.id === "thread-parent")
        ?.updatedAt,
    ).toBe(300);
  });

  it("reorders active anchors already present in a refresh payload", () => {
    const base: ThreadState = {
      ...initialState,
      threadsByWorkspace: {
        "ws-1": [
          { id: "active-a", name: "Active A", updatedAt: 1 },
          { id: "old", name: "Old", updatedAt: 900 },
          { id: "active-b", name: "Active B", updatedAt: 2 },
        ],
      },
      threadStatusById: {
        "active-a": {
          isProcessing: true,
          hasUnread: false,
          isReviewing: false,
          processingStartedAt: 3000,
          lastDurationMs: null,
        },
        "active-b": {
          isProcessing: true,
          hasUnread: false,
          isReviewing: false,
          processingStartedAt: 2900,
          lastDurationMs: null,
        },
      },
    };

    const next = threadReducer(base, {
      type: "setThreads",
      workspaceId: "ws-1",
      sortKey: "updated_at",
      preserveAnchors: true,
      threads: [
        { id: "active-a", name: "Active A", updatedAt: 1 },
        { id: "old", name: "Old", updatedAt: 900 },
        { id: "active-b", name: "Active B", updatedAt: 2 },
      ],
    });

    expect(next.threadsByWorkspace["ws-1"]?.map((thread) => thread.id)).toEqual([
      "active-a",
      "active-b",
      "old",
    ]);
    expect(next.threadsByWorkspace["ws-1"]?.[0]?.updatedAt).toBe(3000);
    expect(next.threadsByWorkspace["ws-1"]?.[1]?.updatedAt).toBe(2900);
  });

  it("does not resurrect hidden anchors on partial setThreads payloads", () => {
    const base: ThreadState = {
      ...initialState,
      threadsByWorkspace: {
        "ws-1": [
          { id: "thread-parent", name: "Parent", updatedAt: 10 },
          { id: "thread-child", name: "Child", updatedAt: 11 },
          { id: "thread-active", name: "Active", updatedAt: 12 },
          { id: "thread-processing", name: "Processing", updatedAt: 13 },
        ],
      },
      activeThreadIdByWorkspace: { "ws-1": "thread-active" },
      hiddenThreadIdsByWorkspace: {
        "ws-1": {
          "thread-parent": true,
          "thread-active": true,
          "thread-processing": true,
        },
      },
      threadParentById: {
        "thread-child": "thread-parent",
      },
      threadStatusById: {
        "thread-processing": {
          isProcessing: true,
          hasUnread: false,
          isReviewing: false,
          processingStartedAt: null,
          lastDurationMs: null,
        },
      },
    };

    const next = threadReducer(base, {
      type: "setThreads",
      workspaceId: "ws-1",
      sortKey: "updated_at",
      preserveAnchors: true,
      threads: [{ id: "thread-child", name: "Child", updatedAt: 210 }],
    });

    expect(next.threadsByWorkspace["ws-1"]?.map((thread) => thread.id)).toEqual([
      "thread-child",
    ]);
  });

  it("drops stale active anchors on complete setThreads payloads", () => {
    const base: ThreadState = {
      ...initialState,
      threadsByWorkspace: {
        "ws-1": [
          { id: "thread-old", name: "Old", updatedAt: 10 },
          { id: "thread-stale", name: "Stale", updatedAt: 9 },
        ],
      },
      activeThreadIdByWorkspace: { "ws-1": "thread-old" },
    };

    const next = threadReducer(base, {
      type: "setThreads",
      workspaceId: "ws-1",
      sortKey: "updated_at",
      threads: [{ id: "thread-fresh", name: "Fresh", updatedAt: 210 }],
    });

    expect(next.threadsByWorkspace["ws-1"]?.map((thread) => thread.id)).toEqual([
      "thread-fresh",
    ]);
    expect(next.activeThreadIdByWorkspace["ws-1"]).toBe("thread-fresh");
  });

  it("keeps an active thread while resume or turn processing is in flight", () => {
    const base: ThreadState = {
      ...initialState,
      threadsByWorkspace: {
        "ws-1": [{ id: "thread-resumed", name: "Resumed", updatedAt: 10 }],
      },
      activeThreadIdByWorkspace: { "ws-1": "thread-resumed" },
      threadResumeLoadingById: { "thread-resumed": true },
    };

    const duringResume = threadReducer(base, {
      type: "setThreads",
      workspaceId: "ws-1",
      sortKey: "updated_at",
      threads: [],
    });

    expect(duringResume.threadsByWorkspace["ws-1"]?.map((thread) => thread.id)).toEqual([
      "thread-resumed",
    ]);
    expect(duringResume.activeThreadIdByWorkspace["ws-1"]).toBe("thread-resumed");

    const duringTurn = threadReducer(
      {
        ...base,
        threadResumeLoadingById: {},
        threadStatusById: {
          "thread-resumed": {
            isProcessing: true,
            hasUnread: false,
            isReviewing: false,
            processingStartedAt: 100,
            lastDurationMs: null,
          },
        },
      },
      {
        type: "setThreads",
        workspaceId: "ws-1",
        sortKey: "updated_at",
        threads: [],
      },
    );

    expect(duringTurn.activeThreadIdByWorkspace["ws-1"]).toBe("thread-resumed");
  });

  it("keeps a missing active processing thread in updated order", () => {
    const base: ThreadState = {
      ...initialState,
      threadsByWorkspace: {
        "ws-1": [
          { id: "thread-now", name: "Now", updatedAt: 1_000 },
          { id: "thread-active", name: "Active", updatedAt: 940 },
          { id: "thread-two-hours", name: "Two hours", updatedAt: 800 },
          { id: "thread-one-day", name: "One day", updatedAt: 100 },
        ],
      },
      activeThreadIdByWorkspace: { "ws-1": "thread-active" },
      threadStatusById: {
        "thread-active": {
          isProcessing: true,
          hasUnread: false,
          isReviewing: false,
          processingStartedAt: 950,
          lastDurationMs: null,
        },
      },
    };

    const next = threadReducer(base, {
      type: "setThreads",
      workspaceId: "ws-1",
      sortKey: "updated_at",
      preserveAnchors: true,
      threads: [
        { id: "thread-now", name: "Now", updatedAt: 1_000 },
        { id: "thread-two-hours", name: "Two hours", updatedAt: 800 },
        { id: "thread-one-day", name: "One day", updatedAt: 100 },
      ],
    });

    expect(next.threadsByWorkspace["ws-1"]?.map((thread) => thread.id)).toEqual([
      "thread-now",
      "thread-active",
      "thread-two-hours",
      "thread-one-day",
    ]);
    expect(next.threadsByWorkspace["ws-1"]?.[1]?.updatedAt).toBe(950);
  });

  it("keeps a missing in-flight active thread in updated order on replacement", () => {
    const base: ThreadState = {
      ...initialState,
      threadsByWorkspace: {
        "ws-1": [{ id: "thread-active", name: "Active", updatedAt: 940 }],
      },
      activeThreadIdByWorkspace: { "ws-1": "thread-active" },
      threadResumeLoadingById: { "thread-active": true },
      lastAgentMessageByThread: {
        "thread-active": { text: "Working", timestamp: 950 },
      },
    };

    const next = threadReducer(base, {
      type: "setThreads",
      workspaceId: "ws-1",
      sortKey: "updated_at",
      threads: [
        { id: "thread-now", name: "Now", updatedAt: 1_000 },
        { id: "thread-old", name: "Old", updatedAt: 100 },
      ],
    });

    expect(next.threadsByWorkspace["ws-1"]?.map((thread) => thread.id)).toEqual([
      "thread-now",
      "thread-active",
      "thread-old",
    ]);
    expect(next.threadsByWorkspace["ws-1"]?.[1]?.updatedAt).toBe(950);
  });

  it("inserts missing anchors by created time when created_at sorting is active", () => {
    const base: ThreadState = {
      ...initialState,
      threadsByWorkspace: {
        "ws-1": [
          {
            id: "thread-active",
            name: "Active",
            createdAt: 900,
            updatedAt: 950,
          },
        ],
      },
      activeThreadIdByWorkspace: { "ws-1": "thread-active" },
      threadResumeLoadingById: { "thread-active": true },
    };

    const next = threadReducer(base, {
      type: "setThreads",
      workspaceId: "ws-1",
      sortKey: "created_at",
      threads: [
        { id: "thread-new", name: "New", createdAt: 1_000, updatedAt: 1_000 },
        { id: "thread-old", name: "Old", createdAt: 100, updatedAt: 980 },
      ],
    });

    expect(next.threadsByWorkspace["ws-1"]?.map((thread) => thread.id)).toEqual([
      "thread-new",
      "thread-active",
      "thread-old",
    ]);
  });

  it("removes an optimistic user message by id", () => {
    const next = threadReducer(
      {
        ...initialState,
        itemsByThread: {
          "thread-1": [
            {
              id: "local-user-1",
              kind: "message",
              role: "user",
              text: "failed steer",
            },
          ],
        },
      },
      {
        type: "removeItem",
        threadId: "thread-1",
        itemId: "local-user-1",
      },
    );

    expect(next.itemsByThread["thread-1"]).toEqual([]);
  });

  it("evicts only the requested resident thread items", () => {
    const base: ThreadState = {
      ...initialState,
      itemsByThread: {
        "thread-1": [
          {
            id: "message-1",
            kind: "message",
            role: "assistant",
            text: "one",
          },
        ],
        "thread-2": [
          {
            id: "message-2",
            kind: "message",
            role: "assistant",
            text: "two",
          },
        ],
      },
    };

    const next = threadReducer(base, {
      type: "evictThreadItems",
      threadIds: ["thread-1", "missing-thread"],
    });

    expect(next.itemsByThread["thread-1"]).toBeUndefined();
    expect(next.itemsByThread["thread-2"]).toEqual(base.itemsByThread["thread-2"]);
  });

  it("dedupes repeated thread summaries on complete setThreads payloads", () => {
    const next = threadReducer(initialState, {
      type: "setThreads",
      workspaceId: "ws-1",
      sortKey: "updated_at",
      threads: [
        { id: "thread-1", name: "Older name", updatedAt: 100 },
        { id: "thread-2", name: "Second", updatedAt: 90 },
        { id: "thread-1", name: "", updatedAt: 120 },
      ],
    });

    expect(next.threadsByWorkspace["ws-1"]).toEqual([
      { id: "thread-1", name: "Older name", updatedAt: 120 },
      { id: "thread-2", name: "Second", updatedAt: 90 },
    ]);
  });

  it("preserves a resolved title when a newer list snapshot only has an Agent fallback", () => {
    const next = threadReducer(
      {
        ...initialState,
        threadsByWorkspace: {
          "ws-1": [
            {
              id: "thread-1",
              name: "已解析的会话标题",
              updatedAt: 100,
            },
          ],
        },
      },
      {
        type: "setThreads",
        workspaceId: "ws-1",
        sortKey: "updated_at",
        threads: [
          {
            id: "thread-1",
            name: "Agent 1",
            nameIsFallback: true,
            updatedAt: 200,
          },
        ],
      },
    );

    expect(next.threadsByWorkspace["ws-1"]).toEqual([
      {
        id: "thread-1",
        name: "已解析的会话标题",
        updatedAt: 200,
      },
    ]);
  });

  it("dedupes incoming threads before preserving local anchors", () => {
    const base: ThreadState = {
      ...initialState,
      threadsByWorkspace: {
        "ws-1": [
          { id: "thread-active", name: "Active", updatedAt: 10 },
          { id: "thread-processing", name: "Processing", updatedAt: 11 },
        ],
      },
      activeThreadIdByWorkspace: { "ws-1": "thread-active" },
      threadStatusById: {
        "thread-processing": {
          isProcessing: true,
          hasUnread: false,
          isReviewing: false,
          processingStartedAt: 300,
          lastDurationMs: null,
        },
      },
    };

    const next = threadReducer(base, {
      type: "setThreads",
      workspaceId: "ws-1",
      sortKey: "updated_at",
      preserveAnchors: true,
      threads: [
        { id: "thread-fresh", name: "Fresh", updatedAt: 200 },
        { id: "thread-fresh", name: "Fresh duplicate", updatedAt: 180 },
      ],
    });

    expect(next.threadsByWorkspace["ws-1"]?.map((thread) => thread.id)).toEqual([
      "thread-processing",
      "thread-fresh",
      "thread-active",
    ]);
    expect(
      next.threadsByWorkspace["ws-1"]?.find(
        (thread) => thread.id === "thread-fresh",
      ),
    ).toEqual({
      id: "thread-fresh",
      name: "Fresh",
      updatedAt: 200,
    });
    expect(next.threadsByWorkspace["ws-1"]?.filter((thread) => thread.id === "thread-fresh")).toHaveLength(1);
  });

  it("trims existing items when maxItemsPerThread is reduced", () => {
    const items: ConversationItem[] = Array.from({ length: 5 }, (_, index) => ({
      id: `msg-${index}`,
      kind: "message",
      role: "assistant",
      text: `message ${index}`,
    }));

    const withItems = threadReducer(initialState, {
      type: "setThreadItems",
      threadId: "thread-1",
      items,
    });
    expect(withItems.itemsByThread["thread-1"]).toHaveLength(5);

    const trimmed = threadReducer(withItems, {
      type: "setMaxItemsPerThread",
      maxItemsPerThread: 3,
    });
    expect(trimmed.itemsByThread["thread-1"]).toHaveLength(3);
    expect(trimmed.itemsByThread["thread-1"]?.[0]?.id).toBe("msg-2");
  });

  it("does not trim live thread items when scrollback cap is exceeded", () => {
    const items: ConversationItem[] = Array.from({ length: 3 }, (_, index) => ({
      id: `msg-${index}`,
      kind: "message",
      role: "assistant",
      text: `message ${index}`,
    }));

    const base = {
      ...initialState,
      maxItemsPerThread: 3,
      itemsByThread: { "thread-1": items },
    };

    const next = threadReducer(base, {
      type: "upsertItem",
      workspaceId: "ws-1",
      threadId: "thread-1",
      item: {
        id: "msg-3",
        kind: "message",
        role: "assistant",
        text: "message 3",
      },
    });

    expect(next.itemsByThread["thread-1"]).toHaveLength(4);
    expect(next.itemsByThread["thread-1"]?.[0]?.id).toBe("msg-0");
  });

  it("replaces the edited user message when the server echoes the resent message", () => {
    const base = threadReducer(
      {
        ...initialState,
        itemsByThread: {
          "thread-1": [
            {
              id: "msg-user-1",
              kind: "message",
              role: "user",
              text: "old text",
              images: ["data:image/png;base64,AAA"],
            },
          ],
        },
      },
      {
        type: "upsertItem",
        workspaceId: "ws-1",
        threadId: "thread-1",
        replaceExisting: true,
        item: {
          id: "msg-user-1",
          kind: "message",
          role: "user",
          text: "edited text",
          images: ["data:image/png;base64,AAA"],
        },
      },
    );

    const echoed = threadReducer(base, {
      type: "upsertItem",
      workspaceId: "ws-1",
      threadId: "thread-1",
      item: {
        id: "server-user-2",
        kind: "message",
        role: "user",
        text: "edited text",
        images: ["data:image/png;base64,AAA"],
      },
    });

    expect(echoed.itemsByThread["thread-1"]).toEqual([
      {
        id: "server-user-2",
        kind: "message",
        role: "user",
        text: "edited text",
        images: ["data:image/png;base64,AAA"],
      },
    ]);
    expect(echoed.pendingUserMessageReplacementByThread["thread-1"]).toBeUndefined();
  });

  it("replaces edited image messages when Windows path formatting changes", () => {
    const base = threadReducer(
      {
        ...initialState,
        itemsByThread: {
          "thread-1": [
            {
              id: "msg-user-image-1",
              kind: "message",
              role: "user",
              text: "old text",
              images: ["C:\\Temp\\IMAGE.PNG"],
            },
          ],
        },
      },
      {
        type: "upsertItem",
        workspaceId: "ws-1",
        threadId: "thread-1",
        replaceExisting: true,
        item: {
          id: "msg-user-image-1",
          kind: "message",
          role: "user",
          text: "edited text",
          images: ["C:\\Temp\\IMAGE.PNG"],
        },
      },
    );

    const echoed = threadReducer(base, {
      type: "upsertItem",
      workspaceId: "ws-1",
      threadId: "thread-1",
      item: {
        id: "server-user-image-2",
        kind: "message",
        role: "user",
        text: "edited text",
        images: ["c:/temp/image.png"],
      },
    });

    expect(echoed.itemsByThread["thread-1"]?.map((item) => item.id)).toEqual([
      "server-user-image-2",
    ]);
    expect(echoed.pendingUserMessageReplacementByThread["thread-1"]).toBeUndefined();
  });

  it("replaces edited user messages when file attachments echo as names", () => {
    const base = threadReducer(
      {
        ...initialState,
        itemsByThread: {
          "thread-1": [
            {
              id: "msg-user-file-1",
              kind: "message",
              role: "user",
              text: "old text",
              attachments: ['data:text/plain;name="trace.log";base64,AAA'],
            },
          ],
        },
      },
      {
        type: "upsertItem",
        workspaceId: "ws-1",
        threadId: "thread-1",
        replaceExisting: true,
        item: {
          id: "msg-user-file-1",
          kind: "message",
          role: "user",
          text: "edited text",
          attachments: ['data:text/plain;name="trace.log";base64,AAA'],
        },
      },
    );

    const echoed = threadReducer(base, {
      type: "upsertItem",
      workspaceId: "ws-1",
      threadId: "thread-1",
      item: {
        id: "server-user-file-2",
        kind: "message",
        role: "user",
        text: "edited text",
        attachments: ["trace.log"],
      },
    });

    expect(echoed.itemsByThread["thread-1"]).toEqual([
      {
        id: "server-user-file-2",
        kind: "message",
        role: "user",
        text: "edited text",
        attachments: ["trace.log"],
      },
    ]);
    expect(echoed.pendingUserMessageReplacementByThread["thread-1"]).toBeUndefined();
  });

  it("keeps retry turns in one execution chain and ignores stale diffs", () => {
    const started = threadReducer(initialState, {
      type: "startTurnExecution",
      workspaceId: "ws-1",
      threadId: "thread-1",
      turnId: "turn-1",
      executionId: "execution-1",
      timestamp: 100,
      continueExecution: false,
    });
    const continued = threadReducer(started, {
      type: "startTurnExecution",
      workspaceId: "ws-1",
      threadId: "thread-1",
      turnId: "turn-2",
      executionId: "ignored-execution",
      timestamp: 200,
      continueExecution: true,
    });
    const staleDiff = threadReducer(continued, {
      type: "updateTurnExecutionDiff",
      threadId: "thread-1",
      turnId: "turn-1",
      diff: "+stale",
      timestamp: 300,
    });

    expect(staleDiff.turnExecutionSummaryByThread["thread-1"]).toMatchObject({
      executionId: "execution-1",
      turnId: "turn-2",
      turnChain: ["turn-1", "turn-2"],
      diffRevision: 0,
    });
  });

  it("preserves manual interruption against delayed completion", () => {
    const started = threadReducer(initialState, {
      type: "startTurnExecution",
      workspaceId: "ws-1",
      threadId: "thread-1",
      turnId: "turn-1",
      executionId: "execution-1",
      timestamp: 100,
      continueExecution: false,
    });
    const interrupted = threadReducer(started, {
      type: "completeTurnExecution",
      threadId: "thread-1",
      turnId: "turn-1",
      status: "interrupted",
      timestamp: 200,
    });
    const delayedCompletion = threadReducer(interrupted, {
      type: "completeTurnExecution",
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
      timestamp: 300,
    });

    expect(delayedCompletion.turnExecutionSummaryByThread["thread-1"]).toMatchObject({
      status: "interrupted",
      endedAtMs: 200,
      workingDurationMs: 100,
    });
  });

  it("does not let a late failure change a completed execution", () => {
    const started = threadReducer(initialState, {
      type: "startTurnExecution",
      workspaceId: "ws-1",
      threadId: "thread-1",
      turnId: "turn-1",
      executionId: "execution-1",
      timestamp: 100,
      continueExecution: false,
    });
    const completed = threadReducer(started, {
      type: "completeTurnExecution",
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
      timestamp: 200,
    });
    const delayedFailure = threadReducer(completed, {
      type: "completeTurnExecution",
      threadId: "thread-1",
      turnId: "turn-1",
      status: "failed",
      timestamp: 300,
    });

    expect(delayedFailure.turnExecutionSummaryByThread["thread-1"]).toMatchObject({
      status: "completed",
      endedAtMs: 200,
      workingDurationMs: 100,
    });
  });

  it("retains a completed summary when the next execution starts", () => {
    const started = threadReducer(initialState, {
      type: "startTurnExecution",
      workspaceId: "ws-1",
      threadId: "thread-1",
      turnId: "turn-1",
      executionId: "execution-1",
      timestamp: 100,
      continueExecution: false,
    });
    const completed = threadReducer(started, {
      type: "completeTurnExecution",
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
      timestamp: 200,
    });
    const next = threadReducer(completed, {
      type: "startTurnExecution",
      workspaceId: "ws-1",
      threadId: "thread-1",
      turnId: "turn-2",
      executionId: "execution-2",
      timestamp: 300,
      continueExecution: false,
    });

    expect(next.turnExecutionSummariesByThread["thread-1"]).toMatchObject([
      { executionId: "execution-1", status: "completed" },
      { executionId: "execution-2", status: "active" },
    ]);
  });

  it("hydrates only a newer matching terminal execution summary", () => {
    const hydrated: TurnExecutionSummary = {
      schemaVersion: 1,
      executionId: "execution-1",
      workspaceId: "ws-1",
      threadId: "thread-1",
      turnId: "turn-1",
      turnChain: ["turn-1"],
      status: "completed",
      startedAtMs: 100,
      endedAtMs: 200,
      workingDurationMs: 100,
      addedLines: 4,
      deletedLines: 1,
      diffRevision: 1,
      recordRevision: 2,
      updatedAtMs: 200,
    };
    const next = threadReducer(initialState, {
      type: "hydrateTurnExecutionSummary",
      workspaceId: "ws-1",
      threadId: "thread-1",
      summary: hydrated,
    });
    const stale = threadReducer(next, {
      type: "hydrateTurnExecutionSummary",
      workspaceId: "ws-1",
      threadId: "thread-1",
      summary: { ...hydrated, recordRevision: 1, updatedAtMs: 150 },
    });

    expect(stale.turnExecutionSummaryByThread["thread-1"]).toEqual(hydrated);
  });

  it("ignores an older continuity request for the same runtime generation", () => {
    const newer = threadReducer(initialState, {
      type: "setThreads",
      workspaceId: "ws-1",
      threads: [{ id: "thread-new", name: "New", updatedAt: 20 }],
      sortKey: "updated_at",
      continuity: {
        sourceId: "source-a",
        runtimeGeneration: 4,
        listGeneration: 2,
        requestId: "request-2",
        requestSequence: 2,
        paginationComplete: true,
        verifiedSnapshot: null,
        staleThreadIds: [],
      },
    });
    const stale = threadReducer(newer, {
      type: "setThreads",
      workspaceId: "ws-1",
      threads: [{ id: "thread-old", name: "Old", updatedAt: 10 }],
      sortKey: "updated_at",
      continuity: {
        sourceId: "source-a",
        runtimeGeneration: 4,
        listGeneration: 1,
        requestId: "request-1",
        requestSequence: 1,
        paginationComplete: true,
        verifiedSnapshot: null,
        staleThreadIds: [],
      },
    });

    expect(stale).toBe(newer);
    expect(stale.threadsByWorkspace["ws-1"]?.map((thread) => thread.id)).toEqual([
      "thread-new",
    ]);
  });

  it("ignores an older runtime response after the session source changes", () => {
    const newer = threadReducer(initialState, {
      type: "setThreads",
      workspaceId: "ws-1",
      threads: [{ id: "thread-source-b", name: "Source B", updatedAt: 20 }],
      sortKey: "updated_at",
      continuity: {
        sourceId: "source-b",
        runtimeGeneration: 5,
        listGeneration: 2,
        requestId: "request-2",
        requestSequence: 2,
        paginationComplete: true,
        verifiedSnapshot: null,
        staleThreadIds: [],
      },
    });
    const stale = threadReducer(newer, {
      type: "setThreads",
      workspaceId: "ws-1",
      threads: [{ id: "thread-source-a", name: "Source A", updatedAt: 10 }],
      sortKey: "updated_at",
      continuity: {
        sourceId: "source-a",
        runtimeGeneration: 4,
        listGeneration: 1,
        requestId: "request-1",
        requestSequence: 1,
        paginationComplete: true,
        verifiedSnapshot: null,
        staleThreadIds: [],
      },
    });

    expect(stale).toBe(newer);
  });

  it("keeps hidden threads excluded from continuity stale metadata", () => {
    const state = {
      ...initialState,
      hiddenThreadIdsByWorkspace: {
        "ws-1": { "thread-hidden": true as const },
      },
    };
    const next = threadReducer(state, {
      type: "setThreads",
      workspaceId: "ws-1",
      threads: [
        { id: "thread-visible", name: "Visible", updatedAt: 20 },
        { id: "thread-hidden", name: "Hidden", updatedAt: 10 },
      ],
      sortKey: "updated_at",
      continuity: {
        sourceId: "source-a",
        runtimeGeneration: 4,
        listGeneration: 1,
        requestId: "request-1",
        requestSequence: 1,
        paginationComplete: false,
        verifiedSnapshot: null,
        staleThreadIds: ["thread-visible", "thread-hidden"],
      },
    });

    expect(next.threadsByWorkspace["ws-1"]?.map((thread) => thread.id)).toEqual([
      "thread-visible",
    ]);
    expect(
      next.threadListContinuityByWorkspace["ws-1"]?.staleThreadIds,
    ).toEqual(["thread-visible"]);
  });

  it("clears continuity metadata when continuity protection is disabled", () => {
    const state = {
      ...initialState,
      threadListContinuityByWorkspace: {
        "ws-1": {
          sourceId: "source-a",
          runtimeGeneration: 4,
          listGeneration: 1,
          requestId: "request-1",
          requestSequence: 1,
          paginationComplete: false,
          verifiedSnapshot: null,
          staleThreadIds: ["thread-stale"],
        },
      },
    };
    const next = threadReducer(state, {
      type: "setThreads",
      workspaceId: "ws-1",
      threads: [],
      sortKey: "updated_at",
      continuity: null,
    });

    expect(next.threadListContinuityByWorkspace["ws-1"]).toBeUndefined();
  });
});
