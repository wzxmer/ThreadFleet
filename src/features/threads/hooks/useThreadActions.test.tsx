// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationItem,
  ManagedSession,
  ThreadSummary,
  WorkspaceInfo,
} from "@/types";
import {
  archiveThread,
  cancelSessionTask,
  fetchManagedSessionsPage,
  forkThread,
  getThreadTokenUsage,
  listSessionSources,
  listThreads,
  listWorkspaces,
  readThread,
  readThreadPage,
  resumeThread,
  startThread,
  scanManagedSessions,
  verifySessionThreads,
} from "@services/tauri";
import { clearActiveManagedSessionsCache } from "@threads/utils/activeManagedSessions";
import {
  buildItemsFromThread,
  getThreadCreatedTimestamp,
  getThreadTimestamp,
  isReviewingFromThread,
  mergeThreadItems,
} from "@utils/threadItems";
import { saveThreadActivity } from "@threads/utils/threadStorage";
import { LOCAL_CODEX_WORKSPACE_ID } from "@/features/workspaces/domain/localCodexWorkspace";
import { useThreadActions } from "./useThreadActions";

vi.mock("@services/tauri", () => ({
  startThread: vi.fn(),
  forkThread: vi.fn(),
  getThreadTokenUsage: vi.fn(),
  listSessionSources: vi.fn(),
  resumeThread: vi.fn(),
  listThreads: vi.fn(),
  listWorkspaces: vi.fn(),
  readThread: vi.fn(),
  readThreadPage: vi.fn(),
  archiveThread: vi.fn(),
  cancelSessionTask: vi.fn(),
  fetchManagedSessionsPage: vi.fn(),
  scanManagedSessions: vi.fn(),
  verifySessionThreads: vi.fn(),
}));

vi.mock("@utils/threadItems", () => ({
  buildItemsFromThread: vi.fn(),
  getThreadCreatedTimestamp: vi.fn(),
  getThreadTimestamp: vi.fn(),
  isReviewingFromThread: vi.fn(),
  mergeThreadItems: vi.fn(),
}));

vi.mock("@threads/utils/threadStorage", () => ({
  saveThreadActivity: vi.fn(),
}));

describe("useThreadActions", () => {
  const workspace: WorkspaceInfo = {
    id: "ws-1",
    name: "ThreadFleet",
    path: "/tmp/codex",
    connected: true,
    settings: { sidebarCollapsed: false },
  };
  const workspaceTwo: WorkspaceInfo = {
    id: "ws-2",
    name: "Other",
    path: "/tmp/other",
    connected: true,
    settings: { sidebarCollapsed: false },
  };
  const localCodexWorkspace: WorkspaceInfo = {
    id: LOCAL_CODEX_WORKSPACE_ID,
    name: "历史会话总览",
    path: "",
    connected: true,
    settings: { sidebarCollapsed: false },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearActiveManagedSessionsCache();
    vi.mocked(listWorkspaces).mockResolvedValue([]);
    vi.mocked(getThreadTokenUsage).mockResolvedValue(null);
    vi.mocked(readThreadPage).mockRejectedValue(new Error("unknown command"));
    vi.mocked(listSessionSources).mockResolvedValue([
      {
        id: "source-a",
        name: "Default",
        codexHomePath: "/tmp/codex",
        enabled: true,
        isCurrent: true,
        isDefault: true,
        discoveredAt: 0,
        lastScanAt: null,
        status: "ready",
        error: null,
      },
    ]);
    vi.mocked(scanManagedSessions).mockResolvedValue({
      requestId: "scan",
      totalSessions: 0,
      diagnosticCount: 0,
      cancelled: false,
      sourceSnapshots: [],
    });
    vi.mocked(fetchManagedSessionsPage).mockResolvedValue({
      requestId: "scan",
      items: [],
      diagnostics: [],
      total: 0,
      nextOffset: null,
    });
    vi.mocked(cancelSessionTask).mockResolvedValue(undefined);
    vi.mocked(getThreadCreatedTimestamp).mockReturnValue(0);
  });

  function renderActions(
    overrides?: Partial<Parameters<typeof useThreadActions>[0]>,
  ) {
    const dispatch = vi.fn();
    const loadedThreadsRef = { current: {} as Record<string, boolean> };
    const loadedThreadRuntimeKeyRef = {
      current: {} as Record<string, string>,
    };
    const replaceOnResumeRef = { current: {} as Record<string, boolean> };
    const tokenUsageRevisionByThreadRef = {
      current: {} as Record<string, number>,
    };
    const threadActivityRef = {
      current: {} as Record<string, Record<string, number>>,
    };
    const applyCollabThreadLinksFromThread = vi.fn(() => []);
    const hydrateSubagentThreads = vi.fn(async () => undefined);
    const updateThreadParent = vi.fn();
    const onSubagentThreadDetected = vi.fn();
    const onSubagentTitleCandidate = vi.fn();

    const args: Parameters<typeof useThreadActions>[0] = {
      dispatch,
      itemsByThread: {},
      threadsByWorkspace: {},
      activeThreadIdByWorkspace: {},
      activeTurnIdByThread: {},
      threadParentById: {},
      threadListCursorByWorkspace: {},
      threadStatusById: {},
      threadSortKey: "updated_at",
      tokenEfficiencyMode: "quality",
      getCustomName: () => undefined,
      threadActivityRef,
      loadedThreadsRef,
      loadedThreadRuntimeKeyRef,
      replaceOnResumeRef,
      tokenUsageRevisionByThreadRef,
      applyCollabThreadLinksFromThread,
      hydrateSubagentThreads,
      updateThreadParent,
      onSubagentThreadDetected,
      onSubagentTitleCandidate,
      ...overrides,
    };

    const utils = renderHook(() => useThreadActions(args));

    return {
      args,
      dispatch,
      loadedThreadsRef: args.loadedThreadsRef,
      loadedThreadRuntimeKeyRef: args.loadedThreadRuntimeKeyRef,
      replaceOnResumeRef: args.replaceOnResumeRef,
      threadActivityRef: args.threadActivityRef,
      applyCollabThreadLinksFromThread: args.applyCollabThreadLinksFromThread,
      updateThreadParent: args.updateThreadParent,
      onSubagentThreadDetected: args.onSubagentThreadDetected,
      onSubagentTitleCandidate: args.onSubagentTitleCandidate,
      ...utils,
    };
  }

  it("starts a thread and activates it by default", async () => {
    vi.mocked(startThread).mockResolvedValue({
      result: { thread: { id: "thread-1" } },
    });

    const { result, dispatch, loadedThreadsRef } = renderActions();

    let threadId: string | null = null;
    await act(async () => {
      threadId = await result.current.startThreadForWorkspace("ws-1");
    });

    expect(threadId).toBe("thread-1");
    expect(startThread).toHaveBeenCalledWith("ws-1", "quality");
    expect(dispatch).toHaveBeenCalledWith({
      type: "ensureThread",
      workspaceId: "ws-1",
      threadId: "thread-1",
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setActiveThreadId",
      workspaceId: "ws-1",
      threadId: "thread-1",
    });
    expect(loadedThreadsRef.current["thread-1"]).toBe(true);
  });

  it("forks a thread and activates the fork", async () => {
    vi.mocked(forkThread).mockResolvedValue({
      result: { thread: { id: "thread-fork-1" } },
    });

    const { result, dispatch, loadedThreadsRef } = renderActions();

    let threadId: string | null = null;
    await act(async () => {
      threadId = await result.current.forkThreadForWorkspace("ws-1", "thread-1");
    });

    expect(threadId).toBe("thread-fork-1");
    expect(forkThread).toHaveBeenCalledWith("ws-1", "thread-1");
    expect(dispatch).toHaveBeenCalledWith({
      type: "ensureThread",
      workspaceId: "ws-1",
      threadId: "thread-fork-1",
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setActiveThreadId",
      workspaceId: "ws-1",
      threadId: "thread-fork-1",
    });
    expect(loadedThreadsRef.current["thread-fork-1"]).toBe(true);
  });

  it("forks a thread without activating when requested", async () => {
    vi.mocked(forkThread).mockResolvedValue({
      result: { thread: { id: "thread-fork-2" } },
    });

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.forkThreadForWorkspace("ws-1", "thread-1", {
        activate: false,
      });
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "ensureThread",
      workspaceId: "ws-1",
      threadId: "thread-fork-2",
    });
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "setActiveThreadId",
        threadId: "thread-fork-2",
      }),
    );
  });

  it("starts a thread without activating when requested", async () => {
    vi.mocked(startThread).mockResolvedValue({
      result: { thread: { id: "thread-2" } },
    });

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.startThreadForWorkspace("ws-1", { activate: false });
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "ensureThread",
      workspaceId: "ws-1",
      threadId: "thread-2",
    });
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "setActiveThreadId" }),
    );
  });

  it("skips resume when already loaded", async () => {
    const { result } = renderActions({
      loadedThreadsRef: { current: { "thread-1": true } },
      loadedThreadRuntimeKeyRef: { current: { "thread-1": ":0" } },
    });

    let threadId: string | null = null;
    await act(async () => {
      threadId = await result.current.resumeThreadForWorkspace("ws-1", "thread-1");
    });

    expect(threadId).toBe("thread-1");
    expect(resumeThread).not.toHaveBeenCalled();
  });

  it("invalidates the loaded runtime cache before a forced ensure", async () => {
    vi.mocked(resumeThread).mockRejectedValue(new Error("resume failed"));
    const { result, loadedThreadsRef, loadedThreadRuntimeKeyRef } = renderActions({
      loadedThreadsRef: { current: { "thread-1": true } },
      loadedThreadRuntimeKeyRef: { current: { "thread-1": ":0" } },
    });

    let threadId: string | null = "unexpected";
    await act(async () => {
      threadId = await result.current.ensureThreadRuntimeForWorkspace(
        "ws-1",
        "thread-1",
        true,
      );
    });

    expect(threadId).toBeNull();
    expect(resumeThread).toHaveBeenCalledTimes(1);
    expect(loadedThreadsRef.current["thread-1"]).toBeUndefined();
    expect(loadedThreadRuntimeKeyRef.current["thread-1"]).toBeUndefined();
  });

  it("does not mark a stale resume response as loaded in a newer runtime", async () => {
    let runtimeContext = {
      sourceId: "source-a",
      runtimeGeneration: 3,
    };
    let resolveResume!: (value: Awaited<ReturnType<typeof resumeThread>>) => void;
    vi.mocked(resumeThread).mockReturnValue(
      new Promise((resolve) => {
        resolveResume = resolve;
      }),
    );
    const { result } = renderActions({
      getThreadListRuntimeContext: () => runtimeContext,
    });

    let firstResume!: Promise<string | null>;
    act(() => {
      firstResume = result.current.resumeThreadForWorkspace("ws-1", "thread-1");
    });
    await waitFor(() => {
      expect(resumeThread).toHaveBeenCalledTimes(1);
    });

    runtimeContext = {
      sourceId: "source-a",
      runtimeGeneration: 4,
    };
    resolveResume({ result: {} } as Awaited<ReturnType<typeof resumeThread>>);
    await act(async () => {
      await firstResume;
    });

    vi.mocked(resumeThread).mockResolvedValue({ result: {} });
    await act(async () => {
      await result.current.resumeThreadForWorkspace("ws-1", "thread-1");
    });

    expect(resumeThread).toHaveBeenCalledTimes(2);
  });

  it("resumes an explicit thread id, replaces history, and activates after success", async () => {
    const serverItems = [{ id: "item-1", kind: "message" }] as ConversationItem[];
    vi.mocked(resumeThread).mockResolvedValue({
      result: { thread: { id: "thread-restored", turns: [] } },
    });
    vi.mocked(buildItemsFromThread).mockReturnValue(serverItems);

    const { result, dispatch } = renderActions();

    let threadId: string | null = null;
    await act(async () => {
      threadId = await result.current.resumeThreadById("ws-1", "  thread-restored  ");
    });

    expect(threadId).toBe("thread-restored");
    expect(resumeThread).toHaveBeenCalledWith("ws-1", "thread-restored");
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadItems",
      threadId: "thread-restored",
      items: serverItems,
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setActiveThreadId",
      workspaceId: "ws-1",
      threadId: "thread-restored",
    });
  });

  it("clears local history when a forced refresh returns an empty rolled-back thread", async () => {
    vi.mocked(readThread).mockResolvedValue({
      result: { thread: { id: "thread-1", turns: [] } },
    });
    vi.mocked(buildItemsFromThread).mockReturnValue([]);
    vi.mocked(mergeThreadItems).mockReturnValue([]);

    const { result, dispatch } = renderActions({
      itemsByThread: {
        "thread-1": [
          { id: "stale-user", kind: "message", role: "user", text: "retry" },
        ],
      },
    });

    await act(async () => {
      await result.current.refreshThread("ws-1", "thread-1");
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadItems",
      threadId: "thread-1",
      items: [],
    });
  });

  it("does not activate an explicit thread id when resume fails", async () => {
    vi.mocked(resumeThread).mockRejectedValue(new Error("thread not found"));
    const { result, dispatch } = renderActions();

    let threadId: string | null = "unexpected";
    await act(async () => {
      threadId = await result.current.resumeThreadById("ws-1", "missing-thread");
    });

    expect(threadId).toBeNull();
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "setActiveThreadId", threadId: "missing-thread" }),
    );
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "ensureThread", threadId: "missing-thread" }),
    );
  });

  it("does not activate an explicit thread id when resume returns no thread", async () => {
    vi.mocked(resumeThread).mockResolvedValue({ result: {} });
    const { result, dispatch } = renderActions();

    await act(async () => {
      expect(await result.current.resumeThreadById("ws-1", "missing-thread")).toBeNull();
    });

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "setActiveThreadId", threadId: "missing-thread" }),
    );
  });

  it("resumes a local Codex session through the virtual workspace", async () => {
    vi.mocked(resumeThread).mockResolvedValue({
      result: { thread: { id: "thread-local", preview: "Local session", updated_at: 123 } },
    });
    vi.mocked(getThreadTimestamp).mockReturnValue(123);

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.resumeThreadForWorkspace(
        LOCAL_CODEX_WORKSPACE_ID,
        "thread-local",
        true,
      );
    });

    expect(resumeThread).toHaveBeenCalledWith(LOCAL_CODEX_WORKSPACE_ID, "thread-local");
    expect(dispatch).toHaveBeenCalledWith({
      type: "ensureThread",
      workspaceId: LOCAL_CODEX_WORKSPACE_ID,
      threadId: "thread-local",
    });
  });

  it("skips resume while processing unless forced", async () => {
    const options = {
      loadedThreadsRef: { current: { "thread-1": true } },
      loadedThreadRuntimeKeyRef: { current: { "thread-1": ":0" } },
      threadStatusById: {
        "thread-1": {
          isProcessing: true,
          hasUnread: false,
          isReviewing: false,
          processingStartedAt: 123,
          lastDurationMs: null,
        },
      },
    };
    const { result: skipResult } = renderActions(options);

    await act(async () => {
      await skipResult.current.resumeThreadForWorkspace("ws-1", "thread-1");
    });

    expect(resumeThread).not.toHaveBeenCalled();

    vi.mocked(resumeThread).mockResolvedValue({
      result: { thread: { id: "thread-1", updated_at: 1 } },
    });

    const { result: forceResult } = renderActions(options);

    await act(async () => {
      await forceResult.current.resumeThreadForWorkspace("ws-1", "thread-1", true);
    });

    expect(resumeThread).toHaveBeenCalledWith("ws-1", "thread-1");
  });

  it("resumes thread, sets items, status, name, and last message", async () => {
    const assistantItem: ConversationItem = {
      id: "assistant-1",
      kind: "message",
      role: "assistant",
      text: "Hello!",
    };

    vi.mocked(resumeThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-2",
          thread_name: "Official Resume Title",
          preview: "preview",
          updated_at: 555,
        },
      },
    });
    vi.mocked(buildItemsFromThread).mockReturnValue([assistantItem]);
    vi.mocked(isReviewingFromThread).mockReturnValue(true);
    vi.mocked(getThreadTimestamp).mockReturnValue(999);
    vi.mocked(mergeThreadItems).mockReturnValue([assistantItem]);

    const { result, dispatch, applyCollabThreadLinksFromThread } = renderActions();

    await act(async () => {
      await result.current.resumeThreadForWorkspace("ws-1", "thread-2");
    });

    expect(resumeThread).toHaveBeenCalledWith("ws-1", "thread-2");
    expect(applyCollabThreadLinksFromThread).toHaveBeenCalledWith(
      "ws-1",
      "thread-2",
      expect.objectContaining({ id: "thread-2" }),
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "ensureThread",
      workspaceId: "ws-1",
      threadId: "thread-2",
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadItems",
      threadId: "thread-2",
      items: [assistantItem],
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "markReviewing",
      threadId: "thread-2",
      isReviewing: true,
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadName",
      workspaceId: "ws-1",
      threadId: "thread-2",
      name: "Official Resume Title",
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setLastAgentMessage",
      threadId: "thread-2",
      text: "Hello!",
      timestamp: 999,
    });
  });

  it("does not block parent resume on subagent title hydration", async () => {
    vi.mocked(resumeThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-parent",
          turns: [],
        },
      },
    });
    const hydrateSubagentThreads = vi.fn(
      () => new Promise<void>(() => undefined),
    );

    const { result } = renderActions({
      applyCollabThreadLinksFromThread: vi.fn(() => ["thread-child"]),
      hydrateSubagentThreads,
    });

    let resumedThreadId: string | null = null;
    await act(async () => {
      resumedThreadId = await result.current.resumeThreadForWorkspace(
        "ws-1",
        "thread-parent",
      );
    });

    expect(resumedThreadId).toBe("thread-parent");
    expect(hydrateSubagentThreads).toHaveBeenCalledWith("ws-1", [
      { threadId: "thread-child" },
    ]);
  });

  it("hydrates token usage from a resumed thread before rendering progress", async () => {
    vi.mocked(resumeThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-usage",
          token_usage: {
            total: { total_tokens: 42000 },
            last: { total_tokens: 1200 },
            model_context_window: 100000,
          },
        },
      },
    });
    vi.mocked(buildItemsFromThread).mockReturnValue([]);
    vi.mocked(mergeThreadItems).mockReturnValue([]);

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.resumeThreadForWorkspace("ws-1", "thread-usage");
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadTokenUsage",
      threadId: "thread-usage",
      tokenUsage: expect.objectContaining({
        total: expect.objectContaining({ totalTokens: 42000 }),
        last: expect.objectContaining({ totalTokens: 1200 }),
        modelContextWindow: 100000,
      }),
    });
  });

  it("ignores token usage from an older overlapping resume", async () => {
    let resolveFirst!: (value: Record<string, unknown>) => void;
    let resolveSecond!: (value: Record<string, unknown>) => void;
    const first = new Promise<Record<string, unknown>>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<Record<string, unknown>>((resolve) => {
      resolveSecond = resolve;
    });
    vi.mocked(resumeThread)
      .mockReturnValueOnce(first as any)
      .mockReturnValueOnce(second as any);
    vi.mocked(buildItemsFromThread).mockReturnValue([]);
    vi.mocked(mergeThreadItems).mockReturnValue([]);

    const { result, dispatch } = renderActions();
    let firstResume!: Promise<string | null>;
    let secondResume!: Promise<string | null>;
    await act(async () => {
      firstResume = result.current.resumeThreadForWorkspace("ws-1", "thread-usage", true);
      secondResume = result.current.resumeThreadForWorkspace("ws-1", "thread-usage", true);
    });

    resolveSecond({
      result: {
        thread: {
          id: "thread-usage",
          token_usage: { total: { total_tokens: 200 } },
        },
      },
    });
    await act(async () => {
      await secondResume;
    });
    resolveFirst({
      result: {
        thread: {
          id: "thread-usage",
          token_usage: { total: { total_tokens: 100 } },
        },
      },
    });
    await act(async () => {
      await firstResume;
    });

    const usageActions = dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === "setThreadTokenUsage");
    expect(usageActions).toEqual([
      expect.objectContaining({
        tokenUsage: expect.objectContaining({
          total: expect.objectContaining({ totalTokens: 200 }),
        }),
      }),
    ]);
  });

  it("keeps an earlier successful resume when a newer request fails", async () => {
    let resolveFirst!: (value: Record<string, unknown>) => void;
    let rejectSecond!: (error: Error) => void;
    const first = new Promise<Record<string, unknown>>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<Record<string, unknown>>((_resolve, reject) => {
      rejectSecond = reject;
    });
    vi.mocked(resumeThread)
      .mockReturnValueOnce(first as any)
      .mockReturnValueOnce(second as any);
    vi.mocked(buildItemsFromThread).mockReturnValue([]);
    vi.mocked(mergeThreadItems).mockReturnValue([]);

    const { result, dispatch } = renderActions();
    let firstResume!: Promise<string | null>;
    let secondResume!: Promise<string | null>;
    await act(async () => {
      firstResume = result.current.resumeThreadForWorkspace("ws-1", "thread-usage", true);
      secondResume = result.current.resumeThreadForWorkspace("ws-1", "thread-usage", true);
    });
    resolveFirst({
      result: {
        thread: {
          id: "thread-usage",
          token_usage: { total: { total_tokens: 100 } },
        },
      },
    });
    await act(async () => {
      await firstResume;
    });
    rejectSecond(new Error("newer resume failed"));
    await act(async () => {
      await secondResume;
    });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "setThreadTokenUsage",
        tokenUsage: expect.objectContaining({
          total: expect.objectContaining({ totalTokens: 100 }),
        }),
      }),
    );
  });

  it("does not overwrite token usage updated live during resume", async () => {
    let resolveResume!: (value: Record<string, unknown>) => void;
    const pending = new Promise<Record<string, unknown>>((resolve) => {
      resolveResume = resolve;
    });
    vi.mocked(resumeThread).mockReturnValue(pending as any);
    vi.mocked(buildItemsFromThread).mockReturnValue([]);
    vi.mocked(mergeThreadItems).mockReturnValue([]);
    const tokenUsageRevisionByThreadRef = {
      current: { "ws-1:thread-usage": 0 } as Record<string, number>,
    };
    const { result, dispatch } = renderActions({
      tokenUsageRevisionByThreadRef,
    });

    let resume!: Promise<string | null>;
    await act(async () => {
      resume = result.current.resumeThreadForWorkspace("ws-1", "thread-usage", true);
    });
    tokenUsageRevisionByThreadRef.current["ws-1:thread-usage"] = 1;
    resolveResume({
      result: {
        thread: {
          id: "thread-usage",
          token_usage: { total: { total_tokens: 100 } },
        },
      },
    });
    await act(async () => {
      await resume;
    });

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "setThreadTokenUsage" }),
    );
  });

  it("keeps token usage unknown when resume has no usage snapshot", async () => {
    vi.mocked(resumeThread).mockResolvedValue({
      result: { thread: { id: "thread-without-usage" } },
    });
    vi.mocked(buildItemsFromThread).mockReturnValue([]);
    vi.mocked(mergeThreadItems).mockReturnValue([]);

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.resumeThreadForWorkspace("ws-1", "thread-without-usage");
    });

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "setThreadTokenUsage" }),
    );
  });

  it("loads the latest history page and prepends an older page without duplicates", async () => {
    const latestItems: ConversationItem[] = [
      { id: "item-3", kind: "message", role: "user", text: "latest question" },
      { id: "item-4", kind: "message", role: "assistant", text: "latest answer" },
    ];
    const olderItems: ConversationItem[] = [
      { id: "item-1", kind: "message", role: "user", text: "older question" },
      { id: "item-2", kind: "message", role: "assistant", text: "older answer" },
    ];
    vi.mocked(readThreadPage)
      .mockResolvedValueOnce({
        codexMonitorReadAuthority: "history-no-active-execution",
        codexMonitorHistoryPage: {
          snapshotId: "snapshot-1",
          nextCursor: "cursor-1",
          hasMore: true,
        },
        result: { thread: { id: "thread-1", turns: [{ items: [] }] } },
      })
      .mockResolvedValueOnce({
        codexMonitorHistoryPage: {
          snapshotId: "snapshot-1",
          nextCursor: null,
          hasMore: false,
        },
        result: { thread: { id: "thread-1", turns: [{ items: [] }] } },
      });
    vi.mocked(buildItemsFromThread)
      .mockReturnValueOnce(latestItems)
      .mockReturnValueOnce(olderItems);

    const { result, dispatch } = renderActions({
      itemsByThread: { "thread-1": latestItems },
    });

    await act(async () => {
      await result.current.readThreadForWorkspace("ws-1", "thread-1", true, true);
    });
    expect(readThread).not.toHaveBeenCalled();
    expect(readThreadPage).toHaveBeenNthCalledWith(
      1,
      "ws-1",
      "thread-1",
      null,
      50,
      1 * 1024 * 1024,
    );
    expect(result.current.threadHistoryPageByThread["thread-1"]).toMatchObject({
      nextCursor: "cursor-1",
      hasMore: true,
      isLoading: false,
    });

    await act(async () => {
      expect(await result.current.loadOlderThreadHistory("ws-1", "thread-1")).toBe(true);
    });

    expect(readThreadPage).toHaveBeenNthCalledWith(
      2,
      "ws-1",
      "thread-1",
      "cursor-1",
      50,
      1 * 1024 * 1024,
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "prependThreadItems",
      threadId: "thread-1",
      items: olderItems,
    });
    expect(result.current.threadHistoryPageByThread["thread-1"]).toMatchObject({
      nextCursor: null,
      hasMore: false,
      isLoading: false,
    });
  });

  it("advances an older-page cursor without reporting duplicate items as inserted", async () => {
    const latestItems: ConversationItem[] = [
      { id: "item-1", kind: "message", role: "user", text: "question" },
      { id: "item-2", kind: "message", role: "assistant", text: "answer" },
    ];
    vi.mocked(readThreadPage)
      .mockResolvedValueOnce({
        codexMonitorHistoryPage: {
          snapshotId: "snapshot-1",
          nextCursor: "cursor-1",
          hasMore: true,
        },
        result: { thread: { id: "thread-1", turns: [{ items: [] }] } },
      })
      .mockResolvedValueOnce({
        codexMonitorHistoryPage: {
          snapshotId: "snapshot-1",
          nextCursor: "cursor-2",
          hasMore: true,
        },
        result: { thread: { id: "thread-1", turns: [{ items: [] }] } },
      });
    vi.mocked(buildItemsFromThread)
      .mockReturnValueOnce(latestItems)
      .mockReturnValueOnce(latestItems);

    const { result, dispatch } = renderActions({
      itemsByThread: { "thread-1": latestItems },
    });
    await act(async () => {
      await result.current.readThreadForWorkspace("ws-1", "thread-1", true, true);
    });
    dispatch.mockClear();

    await act(async () => {
      expect(await result.current.loadOlderThreadHistory("ws-1", "thread-1")).toBe(false);
    });

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "setThreadItems" }),
    );
    expect(result.current.threadHistoryPageByThread["thread-1"]).toMatchObject({
      nextCursor: "cursor-2",
      hasMore: true,
      isLoading: false,
    });
  });

  it("hydrates missing token usage after resume completes", async () => {
    let resolveUsage!: (value: Record<string, unknown> | null) => void;
    vi.mocked(getThreadTokenUsage).mockReturnValue(
      new Promise((resolve) => {
        resolveUsage = resolve;
      }),
    );
    vi.mocked(readThread).mockResolvedValue({
      result: { thread: { id: "thread-restored-usage" } },
    });
    vi.mocked(buildItemsFromThread).mockReturnValue([]);
    vi.mocked(mergeThreadItems).mockReturnValue([]);

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.resumeThreadForWorkspace(
        "ws-1",
        "thread-restored-usage",
      );
    });

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "setThreadTokenUsage" }),
    );

    await act(async () => {
      resolveUsage({
        total: { total_tokens: 42000 },
        last: { total_tokens: 1200 },
        model_context_window: 100000,
      });
      await Promise.resolve();
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadTokenUsage",
      threadId: "thread-restored-usage",
      tokenUsage: expect.objectContaining({
        total: expect.objectContaining({ totalTokens: 42000 }),
        last: expect.objectContaining({ totalTokens: 1200 }),
        modelContextWindow: 100000,
      }),
    });
  });

  it("does not let an unmarked read response terminate a local active turn", async () => {
    vi.mocked(readThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-1",
          turns: [{ id: "turn-live", status: "interrupted", items: [] }],
        },
      },
    });
    vi.mocked(buildItemsFromThread).mockReturnValue([]);

    const { result, dispatch } = renderActions({
      activeTurnIdByThread: { "thread-1": "turn-live" },
      threadStatusById: {
        "thread-1": {
          isProcessing: true,
          hasUnread: false,
          isReviewing: false,
          processingStartedAt: 10,
          lastDurationMs: null,
        },
      },
    });

    await act(async () => {
      await result.current.readThreadForWorkspace("ws-1", "thread-1", true, false);
    });

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "completeTurnExecution" }),
    );
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "markProcessing", isProcessing: false }),
    );
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "setThreadItems" }),
    );
  });

  it("accepts a terminal read after the backend confirms no active execution runtime", async () => {
    vi.mocked(readThread).mockResolvedValue({
      codexMonitorReadAuthority: "history-no-active-execution",
      result: {
        thread: {
          id: "thread-1",
          turns: [{ id: "turn-live", status: "interrupted", items: [] }],
        },
      },
    });
    vi.mocked(buildItemsFromThread).mockReturnValue([]);
    vi.mocked(isReviewingFromThread).mockReturnValue(false);

    const { result, dispatch } = renderActions({
      activeTurnIdByThread: { "thread-1": "turn-live" },
      threadStatusById: {
        "thread-1": {
          isProcessing: true,
          hasUnread: false,
          isReviewing: false,
          processingStartedAt: 10,
          lastDurationMs: null,
        },
      },
    });

    await act(async () => {
      await result.current.readThreadForWorkspace("ws-1", "thread-1", true, false);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "completeTurnExecution",
      threadId: "thread-1",
      turnId: "turn-live",
      status: "interrupted",
      timestamp: expect.any(Number),
    });
  });

  it("does not mark read-only history active from a stale empty latest turn", async () => {
    vi.mocked(readThreadPage).mockResolvedValue({
      codexMonitorReadAuthority: "history-no-active-execution",
      codexMonitorHistoryPage: {
        snapshotId: "snapshot-1",
        nextCursor: null,
        hasMore: false,
      },
      result: {
        thread: {
          id: "thread-ended",
          turns: [
            { id: "turn-complete", status: "completed", items: [{ id: "item-1" }] },
            { id: "turn-stale", status: "inProgress", items: [] },
          ],
        },
      },
    });
    vi.mocked(buildItemsFromThread).mockReturnValue([]);
    vi.mocked(isReviewingFromThread).mockReturnValue(false);

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.readThreadForWorkspace("ws-1", "thread-ended", true, false);
    });

    expect(readThread).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "markProcessing",
        threadId: "thread-ended",
        isProcessing: true,
      }),
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "markProcessing",
      threadId: "thread-ended",
      isProcessing: false,
      timestamp: expect.any(Number),
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setActiveTurnId",
      threadId: "thread-ended",
      turnId: null,
    });
  });

  it("keeps read-only execution-authority active turns processing", async () => {
    vi.mocked(readThreadPage).mockResolvedValue({
      codexMonitorReadAuthority: "execution",
      codexMonitorHistoryPage: {
        snapshotId: "snapshot-1",
        nextCursor: null,
        hasMore: false,
      },
      result: {
        thread: {
          id: "thread-live",
          turns: [{ id: "turn-live", status: "inProgress", items: [] }],
        },
      },
    });
    vi.mocked(buildItemsFromThread).mockReturnValue([]);
    vi.mocked(isReviewingFromThread).mockReturnValue(false);

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.readThreadForWorkspace("ws-1", "thread-live", true, false);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "markProcessing",
      threadId: "thread-live",
      isProcessing: true,
      timestamp: expect.any(Number),
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setActiveTurnId",
      threadId: "thread-live",
      turnId: "turn-live",
    });
  });

  it("does not overwrite live token usage during async restoration", async () => {
    let resolveUsage!: (value: Record<string, unknown> | null) => void;
    vi.mocked(getThreadTokenUsage).mockReturnValue(
      new Promise((resolve) => {
        resolveUsage = resolve;
      }),
    );
    vi.mocked(resumeThread).mockResolvedValue({
      result: { thread: { id: "thread-restored-usage" } },
    });
    vi.mocked(buildItemsFromThread).mockReturnValue([]);
    vi.mocked(mergeThreadItems).mockReturnValue([]);
    const tokenUsageRevisionByThreadRef = {
      current: { "ws-1:thread-restored-usage": 0 } as Record<string, number>,
    };
    const { result, dispatch } = renderActions({
      tokenUsageRevisionByThreadRef,
    });

    await act(async () => {
      await result.current.resumeThreadForWorkspace(
        "ws-1",
        "thread-restored-usage",
      );
    });
    tokenUsageRevisionByThreadRef.current["ws-1:thread-restored-usage"] = 1;

    await act(async () => {
      resolveUsage({ total: { total_tokens: 42000 } });
      await Promise.resolve();
    });

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "setThreadTokenUsage" }),
    );
  });

  it("merges server history with stale local items when resume has no overlap", async () => {
    const serverItem: ConversationItem = {
      id: "server-assistant-1",
      kind: "message",
      role: "assistant",
      text: "Server history",
    };
    const staleLocalItem: ConversationItem = {
      id: "local-user-stale",
      kind: "message",
      role: "user",
      text: "Stale local draft",
    };
    const mergedItems = [serverItem, staleLocalItem];

    vi.mocked(resumeThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-2",
          preview: "Server history",
          updated_at: 555,
        },
      },
    });
    vi.mocked(buildItemsFromThread).mockReturnValue([serverItem]);
    vi.mocked(isReviewingFromThread).mockReturnValue(false);

    const { result, dispatch } = renderActions({
      itemsByThread: { "thread-2": [staleLocalItem] },
    });

    await act(async () => {
      await result.current.resumeThreadForWorkspace("ws-1", "thread-2", true);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadItems",
      threadId: "thread-2",
      items: mergedItems,
    });
  });

  it("drops non-optimistic local cache when resume server history has no overlap", async () => {
    const serverItem: ConversationItem = {
      id: "server-assistant-1",
      kind: "message",
      role: "assistant",
      text: "Server history",
    };
    const staleLocalItem: ConversationItem = {
      id: "other-thread-assistant-1",
      kind: "message",
      role: "assistant",
      text: "Other thread history",
    };

    vi.mocked(resumeThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-2",
          preview: "Server history",
          updated_at: 555,
        },
      },
    });
    vi.mocked(buildItemsFromThread).mockReturnValue([serverItem]);
    vi.mocked(isReviewingFromThread).mockReturnValue(false);

    const { result, dispatch } = renderActions({
      itemsByThread: { "thread-2": [staleLocalItem] },
    });

    await act(async () => {
      await result.current.resumeThreadForWorkspace("ws-1", "thread-2", true);
    });

    expect(mergeThreadItems).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadItems",
      threadId: "thread-2",
      items: [serverItem],
    });
  });

  it("links resumed spawn subagent to its parent from thread source", async () => {
    vi.mocked(resumeThread).mockResolvedValue({
      result: {
        thread: {
          id: "child-thread",
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: "parent-thread",
                depth: 1,
              },
            },
          },
        },
      },
    });
    vi.mocked(buildItemsFromThread).mockReturnValue([]);
    vi.mocked(isReviewingFromThread).mockReturnValue(false);

    const {
      result,
      updateThreadParent,
      onSubagentThreadDetected,
      onSubagentTitleCandidate,
    } = renderActions();

    await act(async () => {
      await result.current.resumeThreadForWorkspace("ws-1", "child-thread", true);
    });

    expect(updateThreadParent).toHaveBeenCalledWith("parent-thread", ["child-thread"]);
    expect(onSubagentThreadDetected).toHaveBeenCalledWith("ws-1", "child-thread");
    expect(onSubagentTitleCandidate).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ id: "child-thread" }),
    );
  });

  it("preserves local items but hydrates status from resume", async () => {
    const localItem: ConversationItem = {
      id: "local-assistant-1",
      kind: "message",
      role: "assistant",
      text: "Local snapshot",
    };
    vi.mocked(resumeThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-1",
          preview: "Stale remote preview",
          updated_at: 1000,
          turns: [{ id: "turn-stale", status: "inProgress", items: [] }],
        },
      },
    });
    vi.mocked(buildItemsFromThread).mockReturnValue([]);
    vi.mocked(isReviewingFromThread).mockReturnValue(true);

    const { result, dispatch } = renderActions({
      itemsByThread: { "thread-1": [localItem] },
    });

    await act(async () => {
      await result.current.resumeThreadForWorkspace("ws-1", "thread-1", true);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "markProcessing",
      threadId: "thread-1",
      isProcessing: true,
      timestamp: expect.any(Number),
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setActiveTurnId",
      threadId: "thread-1",
      turnId: "turn-stale",
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "markReviewing",
      threadId: "thread-1",
      isReviewing: true,
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadItems",
      threadId: "thread-1",
      items: [localItem],
    });
  });

  it("clears stale local processing when completed resume preserves local items", async () => {
    const localItem: ConversationItem = {
      id: "local-assistant-1",
      kind: "message",
      role: "assistant",
      text: "Local snapshot",
    };
    vi.mocked(resumeThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-1",
          preview: "Done thread",
          updated_at: 1000,
          turns: [
            { id: "turn-1", status: "completed", items: [] },
            { id: "turn-2", status: "done", items: [] },
          ],
        },
      },
    });
    vi.mocked(buildItemsFromThread).mockReturnValue([]);
    vi.mocked(isReviewingFromThread).mockReturnValue(false);

    const { result, dispatch } = renderActions({
      itemsByThread: { "thread-1": [localItem] },
      activeTurnIdByThread: { "thread-1": "turn-stale-local" },
      threadStatusById: {
        "thread-1": {
          isProcessing: true,
          hasUnread: false,
          isReviewing: false,
          processingStartedAt: 10,
          lastDurationMs: null,
        },
      },
    });

    await act(async () => {
      await result.current.resumeThreadForWorkspace("ws-1", "thread-1", true);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "markProcessing",
      threadId: "thread-1",
      isProcessing: false,
      timestamp: expect.any(Number),
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setActiveTurnId",
      threadId: "thread-1",
      turnId: null,
    });
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "completeTurnExecution" }),
    );
  });

  it("completes the matching active execution summary from resumed history", async () => {
    vi.mocked(resumeThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-1",
          updated_at: 1000,
          turns: [{ id: "turn-2", status: "completed", items: [] }],
        },
      },
    });
    vi.mocked(buildItemsFromThread).mockReturnValue([]);
    vi.mocked(isReviewingFromThread).mockReturnValue(false);

    const { result, dispatch } = renderActions({
      activeTurnIdByThread: { "thread-1": "turn-2" },
      threadStatusById: {
        "thread-1": {
          isProcessing: true,
          hasUnread: false,
          isReviewing: false,
          processingStartedAt: 10,
          lastDurationMs: null,
        },
      },
    });

    await act(async () => {
      await result.current.resumeThreadForWorkspace("ws-1", "thread-1", true);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "completeTurnExecution",
      threadId: "thread-1",
      turnId: "turn-2",
      status: "completed",
      timestamp: expect.any(Number),
    });
  });

  it("clears processing state from resume when latest turns are completed", async () => {
    const localItem: ConversationItem = {
      id: "local-assistant-1",
      kind: "message",
      role: "assistant",
      text: "Local snapshot",
    };
    vi.mocked(resumeThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-1",
          preview: "Done thread",
          updated_at: 1000,
          turns: [
            { id: "turn-1", status: "completed", items: [] },
            { id: "turn-2", status: "completed", items: [] },
          ],
        },
      },
    });
    vi.mocked(buildItemsFromThread).mockReturnValue([]);
    vi.mocked(isReviewingFromThread).mockReturnValue(false);

    const { result, dispatch } = renderActions({
      itemsByThread: { "thread-1": [localItem] },
      threadStatusById: {
        "thread-1": {
          isProcessing: true,
          hasUnread: false,
          isReviewing: false,
          processingStartedAt: 10,
          lastDurationMs: null,
        },
      },
    });

    await act(async () => {
      await result.current.resumeThreadForWorkspace("ws-1", "thread-1", true, true);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "markProcessing",
      threadId: "thread-1",
      isProcessing: false,
      timestamp: expect.any(Number),
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setActiveTurnId",
      threadId: "thread-1",
      turnId: null,
    });
  });

  it("keeps local processing state when resume turn status is ambiguous", async () => {
    vi.mocked(resumeThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-1",
          preview: "Still running",
          updated_at: 1000,
          turns: [{ id: "turn-remote", status: "unknown_state", items: [] }],
        },
      },
    });
    vi.mocked(buildItemsFromThread).mockReturnValue([]);
    vi.mocked(isReviewingFromThread).mockReturnValue(false);

    const { result, dispatch } = renderActions({
      threadStatusById: {
        "thread-1": {
          isProcessing: true,
          hasUnread: false,
          isReviewing: false,
          processingStartedAt: 10,
          lastDurationMs: null,
        },
      },
      activeTurnIdByThread: {
        "thread-1": "turn-local",
      },
    });

    await act(async () => {
      await result.current.resumeThreadForWorkspace("ws-1", "thread-1", true, true);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "markProcessing",
      threadId: "thread-1",
      isProcessing: true,
      timestamp: expect.any(Number),
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setActiveTurnId",
      threadId: "thread-1",
      turnId: "turn-local",
    });
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "completeTurnExecution" }),
    );
  });

  it("uses latest local processing state while resume is in flight", async () => {
    let resolveResume: ((value: Record<string, unknown>) => void) | null = null;
    vi.mocked(resumeThread).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveResume = resolve;
        }),
    );
    vi.mocked(buildItemsFromThread).mockReturnValue([]);
    vi.mocked(isReviewingFromThread).mockReturnValue(false);

    const { args, result, rerender, dispatch } = renderActions({
      threadStatusById: {},
      activeTurnIdByThread: {},
    });

    let resumePromise: Promise<string | null> | null = null;
    await act(async () => {
      resumePromise = result.current.resumeThreadForWorkspace(
        "ws-1",
        "thread-1",
        true,
        true,
      );
    });

    args.threadStatusById = {
      "thread-1": {
        isProcessing: true,
        hasUnread: false,
        isReviewing: false,
        processingStartedAt: 10,
        lastDurationMs: null,
      },
    };
    args.activeTurnIdByThread = {
      "thread-1": "turn-local",
    };
    rerender();

    await act(async () => {
      resolveResume?.({
        result: {
          thread: {
            id: "thread-1",
            turns: [{ id: "turn-remote", status: "unknown_state", items: [] }],
          },
        },
      });
      await resumePromise;
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "markProcessing",
      threadId: "thread-1",
      isProcessing: true,
      timestamp: expect.any(Number),
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setActiveTurnId",
      threadId: "thread-1",
      turnId: "turn-local",
    });
  });

  it("hydrates processing state from in-progress turns on resume", async () => {
    vi.mocked(resumeThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-3",
          preview: "Working thread",
          updated_at: 1000,
          turns: [
            { id: "turn-1", status: "completed", items: [] },
            { id: "turn-2", status: "inProgress", items: [] },
          ],
        },
      },
    });
    vi.mocked(buildItemsFromThread).mockReturnValue([]);
    vi.mocked(isReviewingFromThread).mockReturnValue(false);

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.resumeThreadForWorkspace("ws-1", "thread-3", true);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "markProcessing",
      threadId: "thread-3",
      isProcessing: true,
      timestamp: expect.any(Number),
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setActiveTurnId",
      threadId: "thread-3",
      turnId: "turn-2",
    });
  });

  it("hydrates processing timestamp from resumed active turn start time", async () => {
    vi.mocked(resumeThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-3",
          preview: "Working thread",
          updated_at: 1000,
          turns: [
            {
              id: "turn-2",
              status: "inProgress",
              started_at: 1_700_000_000_000,
              items: [],
            },
          ],
        },
      },
    });
    vi.mocked(buildItemsFromThread).mockReturnValue([]);
    vi.mocked(isReviewingFromThread).mockReturnValue(false);

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.resumeThreadForWorkspace("ws-1", "thread-3", true);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "markProcessing",
      threadId: "thread-3",
      isProcessing: true,
      timestamp: 1_700_000_000_000,
    });
  });

  it("keeps resume loading true until overlapping resumes finish", async () => {
    let resolveFirst: ((value: unknown) => void) | null = null;
    let resolveSecond: ((value: unknown) => void) | null = null;
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const secondPromise = new Promise((resolve) => {
      resolveSecond = resolve;
    });
    vi.mocked(resumeThread)
      .mockReturnValueOnce(firstPromise as Promise<any>)
      .mockReturnValueOnce(secondPromise as Promise<any>);
    vi.mocked(buildItemsFromThread).mockReturnValue([]);
    vi.mocked(isReviewingFromThread).mockReturnValue(false);
    vi.mocked(getThreadTimestamp).mockReturnValue(0);

    const { result, dispatch } = renderActions();

    let callOne: Promise<string | null> | null = null;
    let callTwo: Promise<string | null> | null = null;
    await act(async () => {
      callOne = result.current.resumeThreadForWorkspace("ws-1", "thread-3", true);
      callTwo = result.current.resumeThreadForWorkspace("ws-1", "thread-3", true);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadResumeLoading",
      threadId: "thread-3",
      isLoading: true,
    });

    await act(async () => {
      resolveFirst?.({ result: { thread: { id: "thread-3" } } });
      await firstPromise;
    });

    expect(dispatch).not.toHaveBeenCalledWith({
      type: "setThreadResumeLoading",
      threadId: "thread-3",
      isLoading: false,
    });

    await act(async () => {
      resolveSecond?.({ result: { thread: { id: "thread-3" } } });
      await Promise.all([callOne, callTwo]);
    });

    const loadingFalseCalls = dispatch.mock.calls.filter(
      ([action]) =>
        action?.type === "setThreadResumeLoading" &&
        action?.threadId === "thread-3" &&
        action?.isLoading === false,
    );
    expect(loadingFalseCalls).toHaveLength(1);
  });

  it("lists threads for a workspace and persists activity", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "thread-1",
            cwd: "/tmp/codex",
            preview: "Remote preview",
            updated_at: 5000,
          },
          {
            id: "thread-2",
            cwd: "/other",
            preview: "Ignore",
            updated_at: 7000,
          },
        ],
        nextCursor: "cursor-1",
      },
    });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) => {
      const value = (thread as Record<string, unknown>).updated_at as number;
      return value ?? 0;
    });

    const { result, dispatch, threadActivityRef } = renderActions({
      getCustomName: (workspaceId, threadId) =>
        workspaceId === "ws-1" && threadId === "thread-1" ? "Custom" : undefined,
      threadActivityRef: { current: {} },
    });

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    expect(listThreads).toHaveBeenCalledWith(
      "ws-1",
      null,
      100,
      "updated_at",
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadListLoading",
      workspaceId: "ws-1",
      isLoading: true,
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreads",
      workspaceId: "ws-1",
      sortKey: "updated_at",
      preserveAnchors: true,
      threads: [
        {
          id: "thread-1",
          name: "Custom",
          updatedAt: 5000,
          createdAt: 0,
        },
      ],
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadListCursor",
      workspaceId: "ws-1",
      cursor: "cursor-1",
    });
    expect(saveThreadActivity).toHaveBeenCalledWith({
      "ws-1": { "thread-1": 5000 },
    });
    expect(threadActivityRef.current).toEqual({
      "ws-1": { "thread-1": 5000 },
    });
  });

  it("preserves verified threads when a refresh returns an abnormal empty page", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: { data: [], nextCursor: null },
    });
    vi.mocked(verifySessionThreads).mockResolvedValue({
      snapshot: {
        sourceId: "source-a",
        generation: 7,
        fingerprint: "snapshot-7",
        complete: true,
        scannedAt: 7000,
      },
      threads: [{ threadId: "thread-verified", presence: "present" }],
      diagnostics: [],
    });

    const { result, dispatch } = renderActions({
      threadsByWorkspace: {
        "ws-1": [
          { id: "thread-verified", name: "Verified", updatedAt: 5000 },
        ],
      },
      preserveSessionLibraryOnProviderSwitch: true,
      getThreadListRuntimeContext: () => ({
        sourceId: "source-a",
        runtimeGeneration: 3,
      }),
    });

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    expect(verifySessionThreads).toHaveBeenCalledWith({
      sourceId: "source-a",
      threadIds: ["thread-verified"],
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "setThreads",
        workspaceId: "ws-1",
        threads: [
          { id: "thread-verified", name: "Verified", updatedAt: 5000 },
        ],
      }),
    );
  });

  it("merges exact active sessions omitted by thread/list", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: { data: [], nextCursor: null },
    });
    const recovered: ManagedSession = {
      key: "source-a:thread-recovered",
      sourceId: "source-a",
      threadId: "thread-recovered",
      sourceKind: "vscode",
      cwd: "/tmp/codex",
      title: "Recovered",
      preview: null,
      createdAt: 4000,
      updatedAt: 5000,
      archivedAt: null,
      isArchived: false,
      parentThreadId: null,
      isSubagent: false,
      subagentNickname: null,
      subagentRole: null,
      projectExists: true,
      fileStatus: "mapped",
      fileConfidence: "exact",
    };
    vi.mocked(scanManagedSessions).mockResolvedValue({
      requestId: "scan",
      totalSessions: 1,
      diagnosticCount: 0,
      cancelled: false,
      sourceSnapshots: [],
    });
    vi.mocked(fetchManagedSessionsPage).mockResolvedValue({
      requestId: "scan",
      items: [recovered],
      diagnostics: [],
      total: 1,
      nextOffset: null,
    });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) =>
      Number(thread.updatedAt ?? thread.updated_at ?? 0),
    );
    vi.mocked(getThreadCreatedTimestamp).mockImplementation((thread) =>
      Number(thread.createdAt ?? thread.created_at ?? 0),
    );

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    expect(scanManagedSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceIds: ["source-a"],
        includeArchived: false,
      }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "setThreads",
        workspaceId: "ws-1",
        threads: [
          expect.objectContaining({
            id: "thread-recovered",
            name: "Recovered",
            updatedAt: 5000,
          }),
        ],
      }),
    );
  });

  it("falls back to the current configured source when the runtime source is stale", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: { data: [], nextCursor: null },
    });
    const recovered: ManagedSession = {
      key: "source-a:thread-recovered",
      sourceId: "source-a",
      threadId: "thread-recovered",
      sourceKind: "vscode",
      cwd: "/tmp/codex",
      title: "Recovered from current source",
      preview: null,
      createdAt: 4000,
      updatedAt: 5000,
      archivedAt: null,
      isArchived: false,
      parentThreadId: null,
      isSubagent: false,
      subagentNickname: null,
      subagentRole: null,
      projectExists: true,
      fileStatus: "mapped",
      fileConfidence: "exact",
    };
    vi.mocked(scanManagedSessions).mockResolvedValue({
      requestId: "scan",
      totalSessions: 1,
      diagnosticCount: 0,
      cancelled: false,
      sourceSnapshots: [],
    });
    vi.mocked(fetchManagedSessionsPage).mockResolvedValue({
      requestId: "scan",
      items: [recovered],
      diagnostics: [],
      total: 1,
      nextOffset: null,
    });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) =>
      Number(thread.updatedAt ?? thread.updated_at ?? 0),
    );
    vi.mocked(getThreadCreatedTimestamp).mockImplementation((thread) =>
      Number(thread.createdAt ?? thread.created_at ?? 0),
    );

    const { result, dispatch } = renderActions({
      getThreadListRuntimeContext: () => ({
        sourceId: "source-stale-runtime-id",
        runtimeGeneration: 3,
      }),
    });

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    expect(scanManagedSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceIds: ["source-a"],
        includeArchived: false,
      }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "setThreads",
        workspaceId: "ws-1",
        threads: [
          expect.objectContaining({
            id: "thread-recovered",
            name: "Recovered from current source",
          }),
        ],
      }),
    );
  });

  it("marks an uncovered thread stale until source verification completes", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: { data: [], nextCursor: null },
    });
    let resolveVerification!: (
      value: Awaited<ReturnType<typeof verifySessionThreads>>,
    ) => void;
    const pendingVerification = new Promise<
      Awaited<ReturnType<typeof verifySessionThreads>>
    >((resolve) => {
      resolveVerification = resolve;
    });
    vi.mocked(verifySessionThreads).mockReturnValue(pendingVerification);

    const { result, dispatch } = renderActions({
      threadsByWorkspace: {
        "ws-1": [
          { id: "thread-verified", name: "Verified", updatedAt: 5000 },
        ],
      },
      preserveSessionLibraryOnProviderSwitch: true,
      getThreadListRuntimeContext: () => ({
        sourceId: "source-a",
        runtimeGeneration: 3,
      }),
    });

    let request!: Promise<void>;
    act(() => {
      request = result.current.listThreadsForWorkspace(workspace);
    });
    await waitFor(() => expect(verifySessionThreads).toHaveBeenCalled());

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "setThreads",
        continuity: expect.objectContaining({
          staleThreadIds: ["thread-verified"],
        }),
      }),
    );

    resolveVerification({
      snapshot: {
        sourceId: "source-a",
        generation: 7,
        fingerprint: "snapshot-7",
        complete: true,
        scannedAt: 7000,
      },
      threads: [{ threadId: "thread-verified", presence: "present" }],
      diagnostics: [],
    });
    await act(async () => {
      await request;
    });

    const setThreadsActions = dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === "setThreads");
    const finalSetThreads = setThreadsActions[setThreadsActions.length - 1];
    expect(finalSetThreads).toEqual(
      expect.objectContaining({
        continuity: expect.objectContaining({ staleThreadIds: [] }),
      }),
    );
  });

  it("retains uncovered verified threads when the fetched page is incomplete", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "thread-fresh",
            cwd: workspace.path,
            preview: "Fresh",
            updated_at: 6000,
          },
        ],
        nextCursor: "cursor-more",
      },
    });
    vi.mocked(getThreadTimestamp).mockReturnValue(6000);

    const { result, dispatch } = renderActions({
      threadsByWorkspace: {
        "ws-1": [
          { id: "thread-verified", name: "Verified", updatedAt: 5000 },
        ],
      },
      preserveSessionLibraryOnProviderSwitch: true,
      getThreadListRuntimeContext: () => ({
        sourceId: "source-a",
        runtimeGeneration: 3,
      }),
    });

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace, { maxPages: 1 });
    });

    expect(verifySessionThreads).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "setThreads",
        workspaceId: "ws-1",
        threads: [
          {
            id: "thread-fresh",
            name: "Fresh",
            updatedAt: 6000,
            createdAt: 0,
          },
          { id: "thread-verified", name: "Verified", updatedAt: 5000 },
        ],
      }),
    );
  });

  it("removes a missing thread only after a complete source verification", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: { data: [], nextCursor: null },
    });
    vi.mocked(verifySessionThreads).mockResolvedValue({
      snapshot: {
        sourceId: "source-a",
        generation: 8,
        fingerprint: "snapshot-8",
        complete: true,
        scannedAt: 8000,
      },
      threads: [{ threadId: "thread-deleted", presence: "missing" }],
      diagnostics: [],
    });

    const { result, dispatch } = renderActions({
      threadsByWorkspace: {
        "ws-1": [
          { id: "thread-deleted", name: "Deleted", updatedAt: 5000 },
        ],
      },
      preserveSessionLibraryOnProviderSwitch: true,
      getThreadListRuntimeContext: () => ({
        sourceId: "source-a",
        runtimeGeneration: 3,
      }),
    });

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "setThreads",
        workspaceId: "ws-1",
        threads: [],
        continuity: expect.objectContaining({
          paginationComplete: true,
          staleThreadIds: [],
          verifiedSnapshot: expect.objectContaining({ generation: 8 }),
        }),
      }),
    );
  });

  it("retains a reported missing thread when the source snapshot is incomplete", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: { data: [], nextCursor: null },
    });
    vi.mocked(verifySessionThreads).mockResolvedValue({
      snapshot: {
        sourceId: "source-a",
        generation: 8,
        fingerprint: "snapshot-8",
        complete: false,
        scannedAt: 8000,
      },
      threads: [{ threadId: "thread-uncertain", presence: "missing" }],
      diagnostics: [],
    });

    const { result, dispatch } = renderActions({
      threadsByWorkspace: {
        "ws-1": [
          { id: "thread-uncertain", name: "Uncertain", updatedAt: 5000 },
        ],
      },
      preserveSessionLibraryOnProviderSwitch: true,
      getThreadListRuntimeContext: () => ({
        sourceId: "source-a",
        runtimeGeneration: 3,
      }),
    });

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    const setThreadsActions = dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === "setThreads");
    const finalSetThreads = setThreadsActions[setThreadsActions.length - 1];
    expect(finalSetThreads).toEqual(
      expect.objectContaining({
        threads: [
          { id: "thread-uncertain", name: "Uncertain", updatedAt: 5000 },
        ],
        continuity: expect.objectContaining({
          staleThreadIds: ["thread-uncertain"],
        }),
      }),
    );
  });

  it("ignores an older thread/list response after a newer request wins", async () => {
    let resolveFirst!: (value: Record<string, unknown>) => void;
    const first = new Promise<Record<string, unknown>>((resolve) => {
      resolveFirst = resolve;
    });
    vi.mocked(listThreads)
      .mockReturnValueOnce(first as ReturnType<typeof listThreads>)
      .mockResolvedValueOnce({
        result: {
          data: [
            {
              id: "thread-newer",
              cwd: workspace.path,
              preview: "Newer",
              updated_at: 7000,
            },
          ],
          nextCursor: null,
        },
      });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) =>
      Number((thread as Record<string, unknown>).updated_at ?? 0),
    );

    const { result, dispatch } = renderActions({
      preserveSessionLibraryOnProviderSwitch: true,
      getThreadListRuntimeContext: () => ({
        sourceId: "source-a",
        runtimeGeneration: 3,
      }),
    });
    let firstRequest!: Promise<void>;
    act(() => {
      firstRequest = result.current.listThreadsForWorkspace(workspace);
    });
    await waitFor(() => {
      expect(listThreads).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });
    resolveFirst({
      result: {
        data: [
          {
            id: "thread-older",
            cwd: workspace.path,
            preview: "Older",
            updated_at: 6000,
          },
        ],
        nextCursor: null,
      },
    });
    await act(async () => {
      await firstRequest;
    });

    const appliedThreadIds = dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === "setThreads")
      .flatMap((action) =>
        action.threads.map((thread: { id: string }) => thread.id),
      );
    expect(appliedThreadIds).toContain("thread-newer");
    expect(appliedThreadIds).not.toContain("thread-older");
  });

  it("lets a foreground refresh clear loading after a newer background refresh wins", async () => {
    let resolveFirst!: (value: Record<string, unknown>) => void;
    const first = new Promise<Record<string, unknown>>((resolve) => {
      resolveFirst = resolve;
    });
    vi.mocked(listThreads)
      .mockReturnValueOnce(first as ReturnType<typeof listThreads>)
      .mockResolvedValueOnce({
        result: { data: [], nextCursor: null },
      });
    const { result, dispatch } = renderActions({
      preserveSessionLibraryOnProviderSwitch: true,
      getThreadListRuntimeContext: () => ({
        sourceId: "source-a",
        runtimeGeneration: 3,
      }),
    });

    let foreground!: Promise<void>;
    act(() => {
      foreground = result.current.listThreadsForWorkspace(workspace);
    });
    await waitFor(() => expect(listThreads).toHaveBeenCalledTimes(1));
    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace, {
        preserveState: true,
      });
    });
    resolveFirst({ result: { data: [], nextCursor: null } });
    await act(async () => {
      await foreground;
    });

    const loadingActions = dispatch.mock.calls
      .map(([action]) => action)
      .filter(
        (action) =>
          action.type === "setThreadListLoading" &&
          action.workspaceId === "ws-1",
      );
    expect(loadingActions).toEqual([
      {
        type: "setThreadListLoading",
        workspaceId: "ws-1",
        isLoading: true,
      },
      {
        type: "setThreadListLoading",
        workspaceId: "ws-1",
        isLoading: false,
      },
    ]);
  });

  it("ignores a thread/list response from an older runtime generation", async () => {
    let resolveList!: (value: Record<string, unknown>) => void;
    const pending = new Promise<Record<string, unknown>>((resolve) => {
      resolveList = resolve;
    });
    vi.mocked(listThreads).mockReturnValue(
      pending as ReturnType<typeof listThreads>,
    );
    let runtimeGeneration = 3;
    const { result, dispatch } = renderActions({
      preserveSessionLibraryOnProviderSwitch: true,
      getThreadListRuntimeContext: () => ({
        sourceId: "source-a",
        runtimeGeneration,
      }),
    });
    let request!: Promise<void>;
    await act(async () => {
      request = result.current.listThreadsForWorkspace(workspace);
      await Promise.resolve();
    });
    runtimeGeneration = 4;
    resolveList({
      result: {
        data: [
          {
            id: "thread-stale-runtime",
            cwd: workspace.path,
            preview: "Stale",
            updated_at: 6000,
          },
        ],
        nextCursor: null,
      },
    });
    await act(async () => {
      await request;
    });

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "setThreads" }),
    );
  });

  it("does not carry a verified snapshot across a session source change", async () => {
    vi.mocked(listSessionSources).mockResolvedValue([
      {
        id: "source-a",
        name: "Source A",
        codexHomePath: "/tmp/codex-a",
        enabled: true,
        isCurrent: true,
        isDefault: true,
        discoveredAt: 0,
        lastScanAt: null,
        status: "ready",
        error: null,
      },
      {
        id: "source-b",
        name: "Source B",
        codexHomePath: "/tmp/codex-b",
        enabled: true,
        isCurrent: false,
        isDefault: false,
        discoveredAt: 0,
        lastScanAt: null,
        status: "ready",
        error: null,
      },
    ]);
    vi.mocked(listThreads)
      .mockResolvedValueOnce({
        result: {
          data: [
            {
              id: "thread-source-a",
              cwd: workspace.path,
              preview: "Source A",
              updated_at: 6000,
            },
          ],
          nextCursor: null,
        },
      })
      .mockResolvedValueOnce({
        result: { data: [], nextCursor: null },
      })
      .mockResolvedValueOnce({
        result: { data: [], nextCursor: null },
      });
    vi.mocked(getThreadTimestamp).mockReturnValue(6000);
    let runtimeContext = {
      sourceId: "source-a",
      runtimeGeneration: 3,
    };
    const { result, dispatch } = renderActions({
      preserveSessionLibraryOnProviderSwitch: true,
      getThreadListRuntimeContext: () => runtimeContext,
    });

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });
    runtimeContext = {
      sourceId: "source-b",
      runtimeGeneration: 4,
    };
    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    const setThreadsActions = dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === "setThreads");
    expect(setThreadsActions[setThreadsActions.length - 1]).toEqual(
      expect.objectContaining({
        threads: [],
        preserveAnchors: false,
        continuity: expect.objectContaining({ sourceId: "source-b" }),
      }),
    );
    expect(verifySessionThreads).not.toHaveBeenCalled();
  });

  it("does not treat an unavailable source lookup as a source change", async () => {
    vi.mocked(listThreads)
      .mockResolvedValueOnce({
        result: {
          data: [
            {
              id: "thread-source-a",
              cwd: workspace.path,
              preview: "Source A",
              updated_at: 6000,
            },
          ],
          nextCursor: null,
        },
      })
      .mockResolvedValueOnce({
        result: { data: [], nextCursor: null },
      });
    vi.mocked(listSessionSources)
      .mockResolvedValueOnce([
        {
          id: "source-a",
          name: "Default",
          codexHomePath: "/tmp/codex",
          enabled: true,
          isCurrent: true,
          isDefault: true,
          discoveredAt: 0,
          lastScanAt: null,
          status: "ready",
          error: null,
        },
      ])
      .mockRejectedValueOnce(new Error("source lookup unavailable"))
      .mockResolvedValueOnce([
        {
          id: "source-b",
          name: "Other",
          codexHomePath: "/tmp/other-codex",
          enabled: true,
          isCurrent: true,
          isDefault: false,
          discoveredAt: 0,
          lastScanAt: null,
          status: "ready",
          error: null,
        },
      ]);
    vi.mocked(getThreadTimestamp).mockReturnValue(6000);
    const { result, dispatch, rerender, args } = renderActions({
      preserveSessionLibraryOnProviderSwitch: true,
      getThreadListRuntimeContext: () => ({
        sourceId: null,
        runtimeGeneration: 0,
      }),
    });

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });
    args.threadsByWorkspace = {
      "ws-1": [
        { id: "thread-source-a", name: "Source A", updatedAt: 6000 },
      ],
    };
    rerender();
    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    const setThreadsActions = dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === "setThreads");
    const finalSetThreads = setThreadsActions[setThreadsActions.length - 1];
    expect(finalSetThreads).toEqual(
      expect.objectContaining({
        preserveAnchors: true,
        continuity: expect.objectContaining({ sourceId: null }),
      }),
    );

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });
    const changedSourceActions = dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === "setThreads");
    const changedSourceSetThreads =
      changedSourceActions[changedSourceActions.length - 1];
    expect(changedSourceSetThreads).toEqual(
      expect.objectContaining({
        threads: [],
        preserveAnchors: false,
        continuity: expect.objectContaining({ sourceId: "source-b" }),
      }),
    );
    expect(verifySessionThreads).not.toHaveBeenCalled();
  });

  it("keeps runtime-authoritative replacement when continuity is disabled", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: { data: [], nextCursor: null },
    });
    const { result, dispatch } = renderActions({
      threadsByWorkspace: {
        "ws-1": [{ id: "thread-old", name: "Old", updatedAt: 5000 }],
      },
      preserveSessionLibraryOnProviderSwitch: false,
    });

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    expect(verifySessionThreads).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreads",
      workspaceId: "ws-1",
      threads: [],
      sortKey: "updated_at",
      preserveAnchors: true,
      continuity: undefined,
    });
  });

  it("clears prior continuity metadata when continuity is disabled", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: { data: [], nextCursor: null },
    });
    const { result, dispatch } = renderActions({
      preserveSessionLibraryOnProviderSwitch: false,
      threadListContinuityByWorkspace: {
        "ws-1": {
          sourceId: "source-a",
          runtimeGeneration: 3,
          listGeneration: 1,
          requestId: "request-1",
          requestSequence: 1,
          paginationComplete: false,
          verifiedSnapshot: null,
          staleThreadIds: ["thread-old"],
        },
      },
    });

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "setThreads",
        workspaceId: "ws-1",
        continuity: null,
      }),
    );
  });

  it("uses fresh fetched data for active anchors outside top thread target", async () => {
    const data = Array.from({ length: 21 }, (_, index) => ({
      id: `thread-${index + 1}`,
      cwd: workspace.path,
      preview: `Thread ${index + 1} fresh`,
      updated_at: 5000 - index,
    }));
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data,
        nextCursor: null,
      },
    });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) => {
      const value = (thread as Record<string, unknown>).updated_at as number;
      return value ?? 0;
    });

    const { result, dispatch } = renderActions({
      threadsByWorkspace: {
        "ws-1": [{ id: "thread-21", name: "Thread 21 stale", updatedAt: 10 }],
      },
      activeThreadIdByWorkspace: { "ws-1": "thread-21" },
    });

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    const setThreadsAction = dispatch.mock.calls
      .map(([action]) => action)
      .find(
        (action) => action.type === "setThreads" && action.workspaceId === "ws-1",
      );
    expect(setThreadsAction).toBeTruthy();
    if (!setThreadsAction || setThreadsAction.type !== "setThreads") {
      return;
    }
    expect(setThreadsAction.threads).toHaveLength(21);
    expect(setThreadsAction.threads[20]?.id).toBe("thread-21");
    expect(setThreadsAction.threads[20]?.name).toBe("Thread 21 fresh");
    expect(setThreadsAction.threads[20]?.updatedAt).toBe(4980);
  });

  it("keeps processing activity fresh while rebuilding thread summaries", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "thread-processing",
            cwd: workspace.path,
            preview: "Processing",
            updated_at: 100,
          },
          {
            id: "thread-old",
            cwd: workspace.path,
            preview: "Old",
            updated_at: 800,
          },
        ],
        nextCursor: null,
      },
    });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) => {
      const value = (thread as Record<string, unknown>).updated_at as number;
      return value ?? 0;
    });

    const { result, dispatch } = renderActions({
      activeThreadIdByWorkspace: { "ws-1": "thread-processing" },
      threadStatusById: {
        "thread-processing": {
          isProcessing: true,
          hasUnread: false,
          isReviewing: false,
          processingStartedAt: 950,
          lastDurationMs: null,
        },
      },
    });

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    const setThreadsAction = dispatch.mock.calls
      .map(([action]) => action)
      .find(
        (action) => action.type === "setThreads" && action.workspaceId === "ws-1",
      );
    expect(setThreadsAction).toBeTruthy();
    if (!setThreadsAction || setThreadsAction.type !== "setThreads") {
      return;
    }
    expect(
      setThreadsAction.threads.map((thread: ThreadSummary) => thread.id),
    ).toEqual([
      "thread-processing",
      "thread-old",
    ]);
    expect(setThreadsAction.threads[0]?.updatedAt).toBe(950);
  });

  it("lists threads once and distributes results across workspaces", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "thread-1",
            cwd: "/tmp/codex",
            preview: "WS1 thread",
            updated_at: 5000,
          },
          {
            id: "thread-2",
            cwd: "/tmp/other",
            preview: "WS2 thread",
            updated_at: 4500,
          },
        ],
        nextCursor: null,
      },
    });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) => {
      const value = (thread as Record<string, unknown>).updated_at as number;
      return value ?? 0;
    });

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.listThreadsForWorkspaces([workspace, workspaceTwo]);
    });

    expect(listThreads).toHaveBeenCalledTimes(1);
    expect(listThreads).toHaveBeenCalledWith("ws-1", null, 100, "updated_at");
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreads",
      workspaceId: "ws-1",
      sortKey: "updated_at",
      preserveAnchors: true,
      threads: [
        {
          id: "thread-1",
          name: "WS1 thread",
          updatedAt: 5000,
          createdAt: 0,
        },
      ],
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreads",
      workspaceId: "ws-2",
      sortKey: "updated_at",
      preserveAnchors: true,
      threads: [
        {
          id: "thread-2",
          name: "WS2 thread",
          updatedAt: 4500,
          createdAt: 0,
        },
      ],
    });
  });

  it("reuses known workspaces during startup thread hydration", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [],
        nextCursor: null,
      },
    });
    const { result } = renderActions();

    await act(async () => {
      await result.current.listThreadsForWorkspaces([workspace], {
        knownWorkspaces: [workspace, workspaceTwo],
      });
    });

    expect(listWorkspaces).not.toHaveBeenCalled();
    expect(listThreads).toHaveBeenCalledWith("ws-1", null, 100, "updated_at");
  });

  it("records the refresh reason in thread list debug entries", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: { data: [], nextCursor: null },
    });
    const onDebug = vi.fn();
    const { result } = renderActions({ onDebug });

    await act(async () => {
      await result.current.listThreadsForWorkspaces([workspace], {
        refreshReason: "workspace_poll",
      });
    });

    expect(onDebug).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "thread/list",
        payload: expect.objectContaining({
          refreshReason: "workspace_poll",
        }),
      }),
    );
  });

  it("propagates thread list failures for authoritative event-gap recovery", async () => {
    vi.mocked(listThreads).mockRejectedValue(new Error("remote unavailable"));
    const { result } = renderActions();

    await expect(
      result.current.listThreadsForWorkspaces([workspace], {
        preserveState: true,
        refreshReason: "remote_event_gap",
        knownWorkspaces: [workspace],
        throwOnError: true,
      }),
    ).rejects.toThrow("remote unavailable");
  });

  it("assigns shared-root threads to a single target workspace when listing multiple workspaces", async () => {
    const workspaceAlias: WorkspaceInfo = {
      ...workspaceTwo,
      id: "ws-alias",
      path: workspace.path,
    };
    vi.mocked(listWorkspaces).mockResolvedValue([workspaceAlias, workspace]);
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "thread-shared-root",
            cwd: workspace.path,
            preview: "Shared root thread",
            updated_at: 5000,
          },
        ],
        nextCursor: null,
      },
    });
    vi.mocked(getThreadTimestamp).mockReturnValue(5000);

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.listThreadsForWorkspaces([workspace, workspaceAlias]);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreads",
      workspaceId: "ws-1",
      sortKey: "updated_at",
      preserveAnchors: true,
      threads: [
        {
          id: "thread-shared-root",
          name: "Shared root thread",
          updatedAt: 5000,
          createdAt: 0,
        },
      ],
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreads",
      workspaceId: "ws-alias",
      sortKey: "updated_at",
      preserveAnchors: true,
      threads: [],
    });
  });

  it("keeps matched project threads out of the local sessions workspace", async () => {
    vi.mocked(listThreads)
      .mockResolvedValueOnce({
        result: {
          data: [
          {
            id: "thread-parent",
            cwd: "/tmp/codex",
            preview: "Project parent",
            updated_at: 5000,
          },
          {
            id: "thread-child-a",
            cwd: "/tmp/codex",
            preview: "Project child prompt",
            updated_at: 4750,
            source: {
              subAgent: {
                thread_spawn: {
                  parent_thread_id: "thread-parent",
                  depth: 1,
                  agent_path: "/root/routing_audit",
                },
              },
            },
          },
          {
            id: "thread-child-b",
            cwd: "/tmp/codex",
            preview: "Second project child prompt",
            updated_at: 4700,
            source: {
              subAgent: {
                thread_spawn: {
                  parent_thread_id: "thread-parent",
                  depth: 1,
                  agent_path: "/root/release-review",
                },
              },
            },
          },
          {
            id: "thread-unmatched",
            cwd: "/tmp/outside",
            preview: "Unmatched local thread",
            updated_at: 4500,
          },
          ],
          nextCursor: null,
        },
      })
      .mockResolvedValueOnce({ result: { data: [], nextCursor: null } });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) => {
      const value = (thread as Record<string, unknown>).updated_at as number;
      return value ?? 0;
    });

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.listThreadsForWorkspaces([workspace, localCodexWorkspace]);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreads",
      workspaceId: "ws-1",
      sortKey: "updated_at",
      preserveAnchors: true,
      threads: [
        {
          id: "thread-parent",
          name: "Project parent",
          updatedAt: 5000,
          createdAt: 0,
        },
        {
          id: "thread-child-a",
          name: "routing audit",
          updatedAt: 4750,
          createdAt: 0,
          isSubagent: true,
        },
        {
          id: "thread-child-b",
          name: "release review",
          updatedAt: 4700,
          createdAt: 0,
          isSubagent: true,
        },
      ],
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreads",
      workspaceId: LOCAL_CODEX_WORKSPACE_ID,
      sortKey: "updated_at",
      preserveAnchors: true,
      threads: [
        {
          id: "thread-unmatched",
          name: "Unmatched local thread",
          updatedAt: 4500,
          createdAt: 0,
          cwd: "/tmp/outside",
        },
      ],
    });
  });

  it("keeps known project threads out when only the local sessions workspace is refreshed", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([workspace]);
    vi.mocked(listThreads)
      .mockResolvedValueOnce({
        result: {
          data: [
            {
              id: "thread-project",
              cwd: "/tmp/codex",
              preview: "Known project thread",
              updated_at: 5000,
            },
            {
              id: "thread-unmatched",
              cwd: "/tmp/outside",
              preview: "Unmatched local thread",
              updated_at: 4500,
            },
          ],
          nextCursor: null,
        },
      })
      .mockResolvedValueOnce({ result: { data: [], nextCursor: null } });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) => {
      const value = (thread as Record<string, unknown>).updated_at as number;
      return value ?? 0;
    });

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.listThreadsForWorkspaces([localCodexWorkspace]);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreads",
      workspaceId: LOCAL_CODEX_WORKSPACE_ID,
      sortKey: "updated_at",
      preserveAnchors: true,
      threads: [
        {
          id: "thread-unmatched",
          name: "Unmatched local thread",
          updatedAt: 4500,
          createdAt: 0,
          cwd: "/tmp/outside",
        },
      ],
    });
  });

  it("does not mirror live threads into local sessions when workspace lookup fails", async () => {
    vi.mocked(listWorkspaces).mockRejectedValue(new Error("workspace lookup failed"));
    vi.mocked(listThreads)
      .mockResolvedValueOnce({
        result: {
          data: [
            {
              id: "thread-unknown-owner",
              cwd: "/tmp/codex",
              preview: "Unknown owner",
              updated_at: 5000,
            },
          ],
          nextCursor: null,
        },
      })
      .mockResolvedValueOnce({ result: { data: [], nextCursor: null } });
    const onDebug = vi.fn();
    const { result, dispatch } = renderActions({ onDebug });

    await act(async () => {
      await result.current.listThreadsForWorkspaces([localCodexWorkspace]);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreads",
      workspaceId: LOCAL_CODEX_WORKSPACE_ID,
      sortKey: "updated_at",
      preserveAnchors: true,
      threads: [],
    });
    expect(onDebug).toHaveBeenCalledWith(
      expect.objectContaining({ label: "thread/list workspace lookup error" }),
    );
  });

  it("includes archived Codex threads in the local sessions workspace", async () => {
    vi.mocked(listThreads)
      .mockResolvedValueOnce({
        result: {
          data: [
            {
              id: "thread-live",
              cwd: "/tmp/codex",
              preview: "Live thread",
              updated_at: 5000,
            },
          ],
          nextCursor: null,
        },
      })
      .mockResolvedValueOnce({
        result: {
          data: [
            {
              id: "thread-archived",
              cwd: "/tmp/codex",
              preview: "Archived thread",
              updated_at: 4500,
            },
          ],
          nextCursor: null,
        },
      });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) => {
      const value = (thread as Record<string, unknown>).updated_at as number;
      return value ?? 0;
    });

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.listThreadsForWorkspaces([localCodexWorkspace]);
    });

    expect(listThreads).toHaveBeenNthCalledWith(
      1,
      LOCAL_CODEX_WORKSPACE_ID,
      null,
      100,
      "updated_at",
    );
    expect(listThreads).toHaveBeenNthCalledWith(
      2,
      LOCAL_CODEX_WORKSPACE_ID,
      null,
      100,
      "updated_at",
      true,
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreads",
      workspaceId: LOCAL_CODEX_WORKSPACE_ID,
      sortKey: "updated_at",
      preserveAnchors: true,
      threads: [
        {
          id: "thread-live",
          name: "Live thread",
          updatedAt: 5000,
          createdAt: 0,
          cwd: "/tmp/codex",
        },
        {
          id: "thread-archived",
          name: "Archived thread",
          updatedAt: 4500,
          createdAt: 0,
          cwd: "/tmp/codex",
        },
      ],
    });
  });

  it("does not restore archived Codex threads into normal workspace lists", async () => {
    vi.mocked(listThreads)
      .mockResolvedValueOnce({
        result: {
          data: [
            {
              id: "thread-live",
              cwd: "/tmp/codex",
              preview: "Live thread",
              updated_at: 5000,
            },
          ],
          nextCursor: null,
        },
      })
      .mockResolvedValueOnce({
        result: {
          data: [
            {
              id: "thread-archived",
              cwd: "/tmp/codex",
              preview: "Archived thread",
              updated_at: 4500,
            },
          ],
          nextCursor: null,
        },
      });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) => {
      const value = (thread as Record<string, unknown>).updated_at as number;
      return value ?? 0;
    });

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.listThreadsForWorkspaces([workspace, localCodexWorkspace]);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreads",
      workspaceId: "ws-1",
      sortKey: "updated_at",
      preserveAnchors: true,
      threads: [
        {
          id: "thread-live",
          name: "Live thread",
          updatedAt: 5000,
          createdAt: 0,
        },
      ],
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreads",
      workspaceId: LOCAL_CODEX_WORKSPACE_ID,
      sortKey: "updated_at",
      preserveAnchors: true,
      threads: [
        {
          id: "thread-archived",
          name: "Archived thread",
          updatedAt: 4500,
          createdAt: 0,
          cwd: "/tmp/codex",
        },
      ],
    });
  });

  it("fetches multiple pages by default", async () => {
    vi.mocked(listThreads)
      .mockResolvedValueOnce({
        result: {
          data: [
            {
              id: "thread-1",
              cwd: "/tmp/codex",
              preview: "First page",
              updated_at: 5000,
            },
          ],
          nextCursor: "cursor-1",
        },
      })
      .mockResolvedValueOnce({
        result: {
          data: [
            {
              id: "thread-2",
              cwd: "/tmp/codex",
              preview: "Second page",
              updated_at: 4900,
            },
          ],
          nextCursor: null,
        },
      });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) => {
      const value = (thread as Record<string, unknown>).updated_at as number;
      return value ?? 0;
    });

    const { result } = renderActions();

    await act(async () => {
      await result.current.listThreadsForWorkspaces([workspace]);
    });

    expect(listThreads).toHaveBeenCalledTimes(2);
    expect(listThreads).toHaveBeenNthCalledWith(1, "ws-1", null, 100, "updated_at");
    expect(listThreads).toHaveBeenNthCalledWith(
      2,
      "ws-1",
      "cursor-1",
      100,
      "updated_at",
    );
  });

  it("supports snake_case next_cursor in shared thread list responses", async () => {
    vi.mocked(listThreads)
      .mockResolvedValueOnce({
        result: {
          data: [
            {
              id: "thread-1",
              cwd: "/tmp/codex",
              preview: "First page",
              updated_at: 5000,
            },
          ],
          next_cursor: "cursor-legacy-1",
        },
      })
      .mockResolvedValueOnce({
        result: {
          data: [
            {
              id: "thread-2",
              cwd: "/tmp/codex",
              preview: "Second page",
              updated_at: 4900,
            },
          ],
          next_cursor: null,
        },
      });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) => {
      const value = (thread as Record<string, unknown>).updated_at as number;
      return value ?? 0;
    });

    const { result } = renderActions();

    await act(async () => {
      await result.current.listThreadsForWorkspaces([workspace]);
    });

    expect(listThreads).toHaveBeenCalledTimes(2);
    expect(listThreads).toHaveBeenNthCalledWith(
      2,
      "ws-1",
      "cursor-legacy-1",
      100,
      "updated_at",
    );
  });

  it("stores a per-workspace cursor boundary for older pagination", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      id: `thread-${index + 1}`,
      cwd: "/tmp/codex",
      preview: `Thread ${index + 1}`,
      updated_at: 5000 - index,
    }));
    const secondPage = Array.from({ length: 55 }, (_, index) => ({
      id: `thread-${index + 51}`,
      cwd: "/tmp/codex",
      preview: `Thread ${index + 51}`,
      updated_at: 4950 - index,
    }));
    vi.mocked(listThreads)
      .mockResolvedValueOnce({
        result: {
          data: firstPage,
          nextCursor: "cursor-1",
        },
      })
      .mockResolvedValueOnce({
        result: {
          data: secondPage,
          nextCursor: null,
        },
      });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) => {
      const value = (thread as Record<string, unknown>).updated_at as number;
      return value ?? 0;
    });

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadListCursor",
      workspaceId: "ws-1",
      cursor: "cursor-1",
    });
  });

  it("restores parent-child links from thread/list source metadata", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "parent-thread",
            cwd: "/tmp/codex",
            preview: "Parent",
            updated_at: 5000,
            source: "vscode",
          },
          {
            id: "child-thread",
            cwd: "/tmp/codex",
            preview: "Child",
            updated_at: 4500,
            source: {
              subAgent: {
                thread_spawn: {
                  parent_thread_id: "parent-thread",
                  depth: 1,
                },
              },
            },
          },
        ],
        nextCursor: null,
      },
    });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) => {
      const value = (thread as Record<string, unknown>).updated_at as number;
      return value ?? 0;
    });

    const { result, updateThreadParent, onSubagentThreadDetected } = renderActions();

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    expect(updateThreadParent).toHaveBeenCalledWith("parent-thread", ["child-thread"]);
    expect(onSubagentThreadDetected).toHaveBeenCalledWith("ws-1", "child-thread");
  });

  it("restores parent-child links from thread/list top-level parent metadata", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "child-thread-flat",
            cwd: "/tmp/codex",
            preview: "Child",
            updated_at: 4500,
            parent_thread_id: "parent-thread-flat",
          },
        ],
        nextCursor: null,
      },
    });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) => {
      const value = (thread as Record<string, unknown>).updated_at as number;
      return value ?? 0;
    });

    const { result, updateThreadParent, onSubagentThreadDetected } = renderActions();

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    expect(updateThreadParent).toHaveBeenCalledWith("parent-thread-flat", [
      "child-thread-flat",
    ]);
    expect(onSubagentThreadDetected).toHaveBeenCalledWith(
      "ws-1",
      "child-thread-flat",
    );
  });

  it("marks thread summaries as subagent when source indicates subagent", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "subagent-thread",
            cwd: "/tmp/codex",
            preview: "Review helper",
            updated_at: 4500,
            agent_nickname: "Atlas",
            agent_role: "reviewer",
            source: {
              sub_agent: "review",
            },
          },
        ],
        nextCursor: null,
      },
    });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) => {
      const value = (thread as Record<string, unknown>).updated_at as number;
      return value ?? 0;
    });

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreads",
      workspaceId: "ws-1",
      sortKey: "updated_at",
      preserveAnchors: true,
      threads: [
        {
          id: "subagent-thread",
          name: "Review helper",
          updatedAt: 4500,
          createdAt: 0,
          isSubagent: true,
          subagentNickname: "Atlas",
          subagentRole: "reviewer",
        },
      ],
    });
  });

  it("hides memory consolidation subagent threads from thread/list", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "memory-thread",
            cwd: "/tmp/codex",
            preview: "Memory helper",
            updated_at: 4500,
            source: {
              subagent: "memory_consolidation",
            },
          },
        ],
        nextCursor: null,
      },
    });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) => {
      const value = (thread as Record<string, unknown>).updated_at as number;
      return value ?? 0;
    });

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "hideThread",
      workspaceId: "ws-1",
      threadId: "memory-thread",
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreads",
      workspaceId: "ws-1",
      sortKey: "updated_at",
      preserveAnchors: true,
      threads: [],
    });
  });

  it("matches windows workspace threads client-side", async () => {
    const windowsWorkspace: WorkspaceInfo = {
      ...workspace,
      path: "C:\\Dev\\CodexMon",
    };
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "thread-win-1",
            cwd: "c:/dev/codexmon",
            preview: "Windows thread",
            updated_at: 5000,
          },
        ],
        nextCursor: null,
      },
    });
    vi.mocked(getThreadTimestamp).mockReturnValue(5000);

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.listThreadsForWorkspace(windowsWorkspace);
    });

    expect(listThreads).toHaveBeenCalledWith(
      "ws-1",
      null,
      100,
      "updated_at",
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreads",
      workspaceId: "ws-1",
      sortKey: "updated_at",
      preserveAnchors: true,
      threads: [
        {
          id: "thread-win-1",
          name: "Windows thread",
          updatedAt: 5000,
          createdAt: 0,
        },
      ],
    });
  });

  it("matches windows namespace-prefixed workspace threads client-side", async () => {
    const windowsWorkspace: WorkspaceInfo = {
      ...workspace,
      path: "C:\\Dev\\CodexMon",
    };
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "thread-win-ns-1",
            cwd: "\\\\?\\C:\\Dev\\CodexMon",
            preview: "Windows namespace thread",
            updated_at: 5000,
          },
        ],
        nextCursor: null,
      },
    });
    vi.mocked(getThreadTimestamp).mockReturnValue(5000);

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.listThreadsForWorkspace(windowsWorkspace);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreads",
      workspaceId: "ws-1",
      sortKey: "updated_at",
      preserveAnchors: true,
      threads: [
        {
          id: "thread-win-ns-1",
          name: "Windows namespace thread",
          updatedAt: 5000,
          createdAt: 0,
        },
      ],
    });
  });

  it("matches canonical-equivalent Windows workspace threads client-side", async () => {
    const windowsWorkspace: WorkspaceInfo = {
      ...workspace,
      path: "C:\\Users\\Administrator\\Documents\\11 服务器\\repo",
    };
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "thread-win-canonical-1",
            cwd: "\\\\?\\C:\\Users\\Administrator\\Documents\\11 服务器\\repo\\.\\subdir",
            preview: "Windows canonical thread",
            updated_at: 5000,
          },
        ],
        nextCursor: null,
      },
    });
    vi.mocked(getThreadTimestamp).mockReturnValue(5000);

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.listThreadsForWorkspace(windowsWorkspace);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreads",
      workspaceId: "ws-1",
      sortKey: "updated_at",
      preserveAnchors: true,
      threads: [
        {
          id: "thread-win-canonical-1",
          name: "Windows canonical thread",
          updatedAt: 5000,
          createdAt: 0,
        },
      ],
    });
  });

  it("matches nested workspace threads client-side", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "thread-nested-1",
            cwd: "/tmp/codex/subdir/project",
            preview: "Nested thread",
            updated_at: 5000,
          },
        ],
        nextCursor: null,
      },
    });
    vi.mocked(getThreadTimestamp).mockReturnValue(5000);

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreads",
      workspaceId: "ws-1",
      sortKey: "updated_at",
      preserveAnchors: true,
      threads: [
        {
          id: "thread-nested-1",
          name: "Nested thread",
          updatedAt: 5000,
          createdAt: 0,
        },
      ],
    });
  });

  it("does not absorb nested child workspace threads when reloading one workspace", async () => {
    const parentWorkspace: WorkspaceInfo = {
      ...workspace,
      id: "ws-parent",
      path: "/tmp/codex",
    };
    const childWorkspace: WorkspaceInfo = {
      ...workspaceTwo,
      id: "ws-child",
      path: "/tmp/codex/subdir",
    };
    vi.mocked(listWorkspaces).mockResolvedValue([parentWorkspace, childWorkspace]);
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "thread-child-only",
            cwd: "/tmp/codex/subdir/project",
            preview: "Child workspace thread",
            updated_at: 5000,
          },
        ],
        nextCursor: null,
      },
    });
    vi.mocked(getThreadTimestamp).mockReturnValue(5000);

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.listThreadsForWorkspace(parentWorkspace);
    });

    expect(listWorkspaces).toHaveBeenCalled();
    const parentSetThreadsAction = dispatch.mock.calls
      .map(([action]) => action)
      .find(
        (action) =>
          action?.type === "setThreads" &&
          action?.workspaceId === "ws-parent",
      ) as
      | { type: "setThreads"; threads: Array<{ id: string }>; workspaceId: string }
      | undefined;

    expect(parentSetThreadsAction?.threads.map((thread) => thread.id) ?? []).toEqual([]);
  });

  it("preserves list state when requested", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [],
        nextCursor: null,
      },
    });

    const { result, dispatch } = renderActions();

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace, {
        preserveState: true,
      });
    });

    expect(dispatch).not.toHaveBeenCalledWith({
      type: "setThreadListLoading",
      workspaceId: "ws-1",
      isLoading: true,
    });
  });

  it("requests created_at sorting when provided", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [],
        nextCursor: null,
      },
    });

    const { result } = renderActions({ threadSortKey: "created_at" });

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    expect(listThreads).toHaveBeenCalledWith(
      "ws-1",
      null,
      100,
      "created_at",
    );
  });

  it("loads older threads when a cursor is available", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "thread-2",
            cwd: "/tmp/codex",
            preview: "Older preview",
            updated_at: 4000,
          },
        ],
        nextCursor: null,
      },
    });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) => {
      const value = (thread as Record<string, unknown>).updated_at as number;
      return value ?? 0;
    });

    const { result, dispatch } = renderActions({
      threadsByWorkspace: {
        "ws-1": [{ id: "thread-1", name: "Agent 1", updatedAt: 6000 }],
      },
      threadListCursorByWorkspace: { "ws-1": "cursor-1" },
    });

    await act(async () => {
      await result.current.loadOlderThreadsForWorkspace(workspace);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadListPaging",
      workspaceId: "ws-1",
      isLoading: true,
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreads",
      workspaceId: "ws-1",
      sortKey: "updated_at",
      threads: [
        { id: "thread-1", name: "Agent 1", updatedAt: 6000 },
        { id: "thread-2", name: "Older preview", updatedAt: 4000, createdAt: 0 },
      ],
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadListCursor",
      workspaceId: "ws-1",
      cursor: null,
    });
  });

  it("supports snake_case next_cursor when loading older threads", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "thread-2",
            cwd: "/tmp/codex",
            preview: "Older preview",
            updated_at: 4000,
          },
        ],
        next_cursor: "cursor-legacy-next",
      },
    });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) => {
      const value = (thread as Record<string, unknown>).updated_at as number;
      return value ?? 0;
    });

    const { result, dispatch } = renderActions({
      threadsByWorkspace: {
        "ws-1": [{ id: "thread-1", name: "Agent 1", updatedAt: 6000 }],
      },
      threadListCursorByWorkspace: { "ws-1": "cursor-1" },
    });

    await act(async () => {
      await result.current.loadOlderThreadsForWorkspace(workspace);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadListCursor",
      workspaceId: "ws-1",
      cursor: "cursor-legacy-next",
    });
  });

  it("appends older local Codex sessions into the virtual sessions workspace", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "thread-local-older",
            cwd: "D:/Project/ThreadFleet",
            preview: "Older local Codex session",
            updated_at: 4000,
          },
        ],
        nextCursor: null,
      },
    });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) => {
      const value = (thread as Record<string, unknown>).updated_at as number;
      return value ?? 0;
    });

    const { result, dispatch } = renderActions({
      threadsByWorkspace: {
        [LOCAL_CODEX_WORKSPACE_ID]: [
          {
            id: "thread-local-current",
            name: "Current local Codex session",
            updatedAt: 6000,
            cwd: "D:/Project/ThreadFleet",
          },
        ],
      },
      threadListCursorByWorkspace: {
        [LOCAL_CODEX_WORKSPACE_ID]: "cursor-1",
      },
    });

    await act(async () => {
      await result.current.loadOlderThreadsForWorkspace(localCodexWorkspace);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreads",
      workspaceId: LOCAL_CODEX_WORKSPACE_ID,
      sortKey: "updated_at",
      threads: [
        {
          id: "thread-local-current",
          name: "Current local Codex session",
          updatedAt: 6000,
          cwd: "D:/Project/ThreadFleet",
        },
        {
          id: "thread-local-older",
          name: "Older local Codex session",
          updatedAt: 4000,
          createdAt: 0,
          cwd: "D:/Project/ThreadFleet",
        },
      ],
    });
  });

  it("excludes older known project threads from the local sessions workspace", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([workspace]);
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "thread-project-older",
            cwd: "/tmp/codex",
            preview: "Older project thread",
            updated_at: 4500,
          },
          {
            id: "thread-unmatched-older",
            cwd: "/tmp/outside",
            preview: "Older unmatched thread",
            updated_at: 4000,
          },
        ],
        nextCursor: null,
      },
    });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) => {
      const value = (thread as Record<string, unknown>).updated_at as number;
      return value ?? 0;
    });

    const { result, dispatch } = renderActions({
      threadsByWorkspace: {
        [LOCAL_CODEX_WORKSPACE_ID]: [
          { id: "thread-current", name: "Current", updatedAt: 6000 },
        ],
      },
      threadListCursorByWorkspace: {
        [LOCAL_CODEX_WORKSPACE_ID]: "cursor-1",
      },
    });

    await act(async () => {
      await result.current.loadOlderThreadsForWorkspace(localCodexWorkspace);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreads",
      workspaceId: LOCAL_CODEX_WORKSPACE_ID,
      sortKey: "updated_at",
      threads: [
        { id: "thread-current", name: "Current", updatedAt: 6000 },
        {
          id: "thread-unmatched-older",
          name: "Older unmatched thread",
          updatedAt: 4000,
          createdAt: 0,
          cwd: "/tmp/outside",
        },
      ],
    });
  });

  it("preserves the local paging cursor when workspace lookup fails", async () => {
    vi.mocked(listWorkspaces).mockRejectedValue(new Error("workspace lookup failed"));
    const onDebug = vi.fn();
    const { result, dispatch } = renderActions({
      threadListCursorByWorkspace: {
        [LOCAL_CODEX_WORKSPACE_ID]: "cursor-1",
      },
      onDebug,
    });

    await act(async () => {
      await result.current.loadOlderThreadsForWorkspace(localCodexWorkspace);
    });

    expect(listThreads).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadListCursor",
      workspaceId: LOCAL_CODEX_WORKSPACE_ID,
      cursor: "cursor-1",
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadListPaging",
      workspaceId: LOCAL_CODEX_WORKSPACE_ID,
      isLoading: false,
    });
    expect(onDebug).toHaveBeenCalledWith(
      expect.objectContaining({ label: "thread/list older workspace lookup error" }),
    );
  });

  it("treats page-start cursor marker as null when loading older threads", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [],
        nextCursor: null,
      },
    });

    const { result } = renderActions({
      threadsByWorkspace: {
        "ws-1": [{ id: "thread-1", name: "Agent 1", updatedAt: 6000 }],
      },
      threadListCursorByWorkspace: {
        "ws-1": "__codex_monitor_page_start__",
      },
    });

    await act(async () => {
      await result.current.loadOlderThreadsForWorkspace(workspace);
    });

    expect(listThreads).toHaveBeenCalledWith(
      "ws-1",
      null,
      100,
      "updated_at",
    );
  });

  it("matches windows workspace threads when loading older threads", async () => {
    const windowsWorkspace: WorkspaceInfo = {
      ...workspace,
      path: "C:\\Dev\\CodexMon",
    };
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "thread-win-older",
            cwd: "c:/dev/codexmon",
            preview: "Older windows preview",
            updated_at: 4000,
          },
        ],
        nextCursor: null,
      },
    });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) => {
      const value = (thread as Record<string, unknown>).updated_at as number;
      return value ?? 0;
    });

    const { result, dispatch } = renderActions({
      threadsByWorkspace: {
        "ws-1": [{ id: "thread-1", name: "Agent 1", updatedAt: 6000 }],
      },
      threadListCursorByWorkspace: { "ws-1": "cursor-1" },
    });

    await act(async () => {
      await result.current.loadOlderThreadsForWorkspace(windowsWorkspace);
    });

    expect(listThreads).toHaveBeenCalledWith(
      "ws-1",
      "cursor-1",
      100,
      "updated_at",
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreads",
      workspaceId: "ws-1",
      sortKey: "updated_at",
      threads: [
        { id: "thread-1", name: "Agent 1", updatedAt: 6000 },
        {
          id: "thread-win-older",
          name: "Older windows preview",
          updatedAt: 4000,
          createdAt: 0,
        },
      ],
    });
  });

  it("matches canonical-equivalent Windows workspace threads when loading older threads", async () => {
    const windowsWorkspace: WorkspaceInfo = {
      ...workspace,
      path: "C:\\Users\\Administrator\\Documents\\11 服务器\\repo",
    };
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "thread-win-canonical-older",
            cwd: "C:/Users/Administrator/Documents/11 服务器/other/../repo/subdir",
            preview: "Older canonical windows preview",
            updated_at: 4000,
          },
        ],
        nextCursor: null,
      },
    });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) => {
      const value = (thread as Record<string, unknown>).updated_at as number;
      return value ?? 0;
    });

    const { result, dispatch } = renderActions({
      threadsByWorkspace: {
        "ws-1": [{ id: "thread-1", name: "Agent 1", updatedAt: 6000 }],
      },
      threadListCursorByWorkspace: { "ws-1": "cursor-1" },
    });

    await act(async () => {
      await result.current.loadOlderThreadsForWorkspace(windowsWorkspace);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreads",
      workspaceId: "ws-1",
      sortKey: "updated_at",
      threads: [
        { id: "thread-1", name: "Agent 1", updatedAt: 6000 },
        {
          id: "thread-win-canonical-older",
          name: "Older canonical windows preview",
          updatedAt: 4000,
          createdAt: 0,
        },
      ],
    });
  });

  it("matches nested workspace threads when loading older threads", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "thread-nested-older",
            cwd: "/tmp/codex/subdir/project",
            preview: "Nested older preview",
            updated_at: 4000,
          },
        ],
        nextCursor: null,
      },
    });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) => {
      const value = (thread as Record<string, unknown>).updated_at as number;
      return value ?? 0;
    });

    const { result, dispatch } = renderActions({
      threadsByWorkspace: {
        "ws-1": [{ id: "thread-1", name: "Agent 1", updatedAt: 6000 }],
      },
      threadListCursorByWorkspace: { "ws-1": "cursor-1" },
    });

    await act(async () => {
      await result.current.loadOlderThreadsForWorkspace(workspace);
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreads",
      workspaceId: "ws-1",
      sortKey: "updated_at",
      threads: [
        { id: "thread-1", name: "Agent 1", updatedAt: 6000 },
        {
          id: "thread-nested-older",
          name: "Nested older preview",
          updatedAt: 4000,
          createdAt: 0,
        },
      ],
    });
  });

  it("does not absorb child-workspace threads when loading older threads", async () => {
    const parentWorkspace: WorkspaceInfo = {
      ...workspace,
      id: "ws-parent",
      path: "/tmp/codex",
    };
    const childWorkspace: WorkspaceInfo = {
      ...workspaceTwo,
      id: "ws-child",
      path: "/tmp/codex/subdir",
    };
    vi.mocked(listWorkspaces).mockResolvedValue([parentWorkspace, childWorkspace]);
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "thread-child-only",
            cwd: "/tmp/codex/subdir/project",
            preview: "Child workspace thread",
            updated_at: 4000,
          },
        ],
        nextCursor: null,
      },
    });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) => {
      const value = (thread as Record<string, unknown>).updated_at as number;
      return value ?? 0;
    });

    const { result, dispatch } = renderActions({
      threadsByWorkspace: {
        "ws-parent": [{ id: "thread-parent", name: "Parent", updatedAt: 6000 }],
      },
      threadListCursorByWorkspace: { "ws-parent": "cursor-1" },
    });

    await act(async () => {
      await result.current.loadOlderThreadsForWorkspace(parentWorkspace);
    });

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "setThreads",
        workspaceId: "ws-parent",
      }),
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "setThreadListCursor",
      workspaceId: "ws-parent",
      cursor: null,
    });
  });

  it("detects model metadata from list responses", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "thread-model-1",
            cwd: "/tmp/codex",
            preview: "Uses gpt-5",
            updated_at: 5000,
            model: "gpt-5-codex",
            reasoning_effort: "high",
          },
        ],
        nextCursor: null,
      },
    });
    vi.mocked(getThreadTimestamp).mockImplementation((thread) => {
      const value = (thread as Record<string, unknown>).updated_at as number;
      return value ?? 0;
    });

    const onThreadCodexMetadataDetected = vi.fn();
    const { result } = renderActions({ onThreadCodexMetadataDetected });

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    expect(onThreadCodexMetadataDetected).toHaveBeenCalledWith(
      "ws-1",
      "thread-model-1",
      { modelId: "gpt-5-codex", effort: "high" },
    );
  });

  it("detects model metadata when resuming a thread", async () => {
    vi.mocked(resumeThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-resume-model",
          preview: "resume preview",
          updated_at: 1200,
          turns: [
            {
              items: [
                {
                  type: "turnContext",
                  payload: {
                    info: {
                      model: "gpt-5.3-codex",
                      reasoning_effort: "medium",
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    });
    vi.mocked(buildItemsFromThread).mockReturnValue([]);
    vi.mocked(isReviewingFromThread).mockReturnValue(false);
    vi.mocked(getThreadTimestamp).mockReturnValue(1200);

    const onThreadCodexMetadataDetected = vi.fn();
    const { result } = renderActions({ onThreadCodexMetadataDetected });

    await act(async () => {
      await result.current.resumeThreadForWorkspace("ws-1", "thread-resume-model");
    });

    expect(onThreadCodexMetadataDetected).toHaveBeenCalledWith(
      "ws-1",
      "thread-resume-model",
      { modelId: "gpt-5.3-codex", effort: "medium" },
    );
  });

  it("archives threads and reports errors", async () => {
    vi.mocked(archiveThread).mockRejectedValue(new Error("nope"));
    const onDebug = vi.fn();
    const { result } = renderActions({ onDebug });

    await act(async () => {
      await result.current.archiveThread("ws-1", "thread-9");
    });

    expect(archiveThread).toHaveBeenCalledWith("ws-1", "thread-9");
    expect(onDebug).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "error",
        label: "thread/archive error",
        payload: "nope",
      }),
    );
  });

  it("blocks archive routing for a stale continuity entry", async () => {
    const onDebug = vi.fn();
    const { result } = renderActions({
      onDebug,
      threadListContinuityByWorkspace: {
        "ws-1": {
          sourceId: "source-a",
          runtimeGeneration: 3,
          listGeneration: 4,
          requestId: "request-4",
          requestSequence: 4,
          paginationComplete: false,
          verifiedSnapshot: null,
          staleThreadIds: ["thread-stale"],
        },
      },
    });

    await act(async () => {
      await result.current.archiveThread("ws-1", "thread-stale");
    });

    expect(archiveThread).not.toHaveBeenCalled();
    expect(onDebug).toHaveBeenCalledWith(
      expect.objectContaining({ label: "thread/archive blocked stale" }),
    );
  });
});
