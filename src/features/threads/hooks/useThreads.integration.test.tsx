// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedSession, WorkspaceInfo } from "@/types";
import type { useAppServerEvents } from "@app/hooks/useAppServerEvents";
import { useThreadRows } from "@app/hooks/useThreadRows";
import {
  archiveThread,
  cancelSessionTask,
  createContentReference,
  fetchManagedSessionsPage,
  generateRunMetadata,
  getThreadTokenUsage,
  getTurnExecutionSummaries,
  interruptTurn,
  listSessionSources,
  listThreads,
  listWorkspaces,
  readThread,
  readThreadPage,
  resumeThread,
  scanManagedSessions,
  sendUserMessage as sendUserMessageService,
  setThreadName,
  startThread,
  startReview,
  upsertTurnExecutionSummary,
  steerTurn,
} from "@services/tauri";
import { STORAGE_KEY_DETACHED_REVIEW_LINKS } from "@threads/utils/threadStorage";
import { STORAGE_KEY_ACTIVE_THREADS } from "@utils/activeSelectionStorage";
import { LOCAL_CODEX_WORKSPACE_ID } from "@/features/workspaces/domain/localCodexWorkspace";
import {
  clearActiveManagedSessionsCache,
} from "@threads/utils/activeManagedSessions";
import { useQueuedSend } from "./useQueuedSend";
import { MAX_RESIDENT_THREAD_HISTORIES } from "./useResidentThreadHistory";
import { useThreads } from "./useThreads";

type AppServerHandlers = Parameters<typeof useAppServerEvents>[0];

let handlers: AppServerHandlers | null = null;

vi.mock("@app/hooks/useAppServerEvents", () => ({
  useAppServerEvents: (incoming: AppServerHandlers) => {
    handlers = incoming;
  },
}));

vi.mock("@services/tauri", () => ({
  respondToServerRequest: vi.fn(),
  respondToUserInputRequest: vi.fn(),
  rememberApprovalRule: vi.fn(),
  createContentReference: vi.fn(),
  sendUserMessage: vi.fn(),
  computerControlPreflight: vi.fn().mockResolvedValue({
    schemaVersion: 1,
    decisionId: "cmcc-integration-direct",
    taskKind: "direct",
    primaryBackend: "direct",
    availability: "ready",
    enforcement: "hard",
    reasonCodes: ["direct_task", "backend_ready"],
    executionHost: "local",
    snapshotAgeMs: 0,
    contextFragment: null,
  }),
  workflowPreflightPreview: vi.fn().mockResolvedValue({
    mode: "shadow",
    providerKind: "openai",
    model: null,
    taskLength: 0,
    rules: [],
    knowledgeCandidates: [],
    impacts: [],
    impactSummary: "",
    validationSuggestions: [],
    sourceErrors: [],
    knowledgeCacheHit: false,
    contextFragments: [],
  }),
  promoteComposerImages: vi.fn(async (_workspaceId, _threadId, images: string[]) =>
    images.map((_image, index) => `C:\\promoted\\image-${index + 1}.png`),
  ),
  steerTurn: vi.fn(),
  startReview: vi.fn(),
  startThread: vi.fn(),
  cancelSessionTask: vi.fn(),
  fetchManagedSessionsPage: vi.fn(),
  listSessionSources: vi.fn(),
  listThreads: vi.fn(),
  listWorkspaces: vi.fn(),
  resumeThread: vi.fn(),
  readThread: vi.fn(),
  readThreadPage: vi.fn(),
  scanManagedSessions: vi.fn(),
  archiveThread: vi.fn(),
  generateRunMetadata: vi.fn(),
  getThreadTokenUsage: vi.fn(),
  getTurnExecutionSummaries: vi.fn(),
  upsertTurnExecutionSummary: vi.fn(),
  setThreadName: vi.fn(),
  getAccountRateLimits: vi.fn(),
  getAccountInfo: vi.fn(),
  interruptTurn: vi.fn(),
}));

const workspace: WorkspaceInfo = {
  id: "ws-1",
  name: "ThreadFleet",
  path: "/tmp/codex",
  connected: true,
  settings: { sidebarCollapsed: false },
};
const DAY_MS = 24 * 60 * 60 * 1000;

const managedSession = (
  threadId: string,
  cwd: string,
  updatedAt: number,
  overrides: Partial<ManagedSession> = {},
): ManagedSession => ({
  key: `source-a:${threadId}`,
  sourceId: "source-a",
  threadId,
  sourceKind: "vscode",
  cwd,
  title: threadId,
  preview: null,
  createdAt: updatedAt,
  updatedAt,
  archivedAt: null,
  isArchived: false,
  parentThreadId: null,
  isSubagent: false,
  subagentNickname: null,
  subagentRole: null,
  projectExists: true,
  fileStatus: "mapped",
  fileConfidence: "exact",
  ...overrides,
});

describe("useThreads UX integration", () => {
  let now: number;
  let nowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    handlers = null;
    localStorage.clear();
    vi.clearAllMocks();
    clearActiveManagedSessionsCache();
    vi.mocked(readThread).mockReset();
    vi.mocked(readThreadPage).mockRejectedValue(new Error("unknown command"));
    vi.mocked(listWorkspaces).mockResolvedValue([]);
    vi.mocked(listSessionSources).mockResolvedValue([
      {
        id: "source-a",
        name: "Default",
        codexHomePath: "/tmp/codex-home",
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
    vi.mocked(getThreadTokenUsage).mockResolvedValue(null);
    vi.mocked(getTurnExecutionSummaries).mockResolvedValue([]);
    vi.mocked(upsertTurnExecutionSummary).mockImplementation(async (summary) => summary);
    now = 1000;
    nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now++);
  });

  afterEach(() => {
    vi.useRealTimers();
    nowSpy.mockRestore();
  });

  it("restores the persisted active thread for the workspace", async () => {
    localStorage.setItem(
      STORAGE_KEY_ACTIVE_THREADS,
      JSON.stringify({ "ws-1": "thread-persisted" }),
    );

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    await waitFor(() => {
      expect(result.current.activeThreadId).toBe("thread-persisted");
    });
  });

  it("loads history for a persisted active thread after its initial list arrives", async () => {
    localStorage.setItem(
      STORAGE_KEY_ACTIVE_THREADS,
      JSON.stringify({ "ws-1": "thread-persisted" }),
    );
    vi.mocked(listWorkspaces).mockResolvedValue([workspace]);
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "thread-persisted",
            cwd: "/tmp/codex",
            name: "Persisted thread",
            preview: "Persisted preview",
            updated_at: 2000,
          },
        ],
        nextCursor: null,
      },
    });
    vi.mocked(readThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-persisted",
          turns: [
            {
              items: [
                {
                  type: "userMessage",
                  id: "persisted-user-1",
                  content: [{ type: "text", text: "Continue" }],
                },
                {
                  type: "agentMessage",
                  id: "persisted-assistant-1",
                  text: "Restored answer",
                },
              ],
            },
          ],
        },
      },
    });

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledWith("ws-1", "thread-persisted");
      expect(
        result.current.activeItems.some(
          (item) =>
            item.kind === "message" &&
            item.role === "assistant" &&
            item.text === "Restored answer",
        ),
      ).toBe(true);
    });
    expect(readThread).toHaveBeenCalledTimes(1);
  });

  it("does not restore the persisted thread after the user starts a new draft", async () => {
    localStorage.setItem(
      STORAGE_KEY_ACTIVE_THREADS,
      JSON.stringify({ "ws-1": "thread-persisted" }),
    );
    vi.mocked(listWorkspaces).mockResolvedValue([workspace]);
    vi.mocked(listThreads).mockResolvedValue({
      result: { data: [], nextCursor: null },
    });

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      result.current.setActiveThreadId(null);
    });
    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    expect(result.current.activeThreadId).toBeNull();
    expect(readThread).not.toHaveBeenCalled();
  });

  it("reads selected threads when no local items exist", async () => {
    vi.mocked(readThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-2",
          preview: "Remote preview",
          updated_at: 9999,
          turns: [
            {
              items: [
                {
                  type: "userMessage",
                  id: "server-user-1",
                  content: [{ type: "text", text: "Hello" }],
                },
                {
                  type: "agentMessage",
                  id: "assistant-1",
                  text: "Hello world",
                },
                {
                  type: "enteredReviewMode",
                  id: "review-1",
                },
              ],
            },
          ],
        },
      },
    });

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    expect(handlers).not.toBeNull();

    act(() => {
      result.current.setActiveThreadId("thread-2");
    });

    await waitFor(() => {
      expect(vi.mocked(readThread)).toHaveBeenCalledWith("ws-1", "thread-2");
    });

    await waitFor(() => {
      expect(result.current.threadStatusById["thread-2"]?.isReviewing).toBe(true);
    });

    const activeItems = result.current.activeItems;
    const assistantMerged = activeItems.find(
      (item) =>
        item.kind === "message" &&
        item.role === "assistant" &&
        item.id === "assistant-1",
    );
    expect(assistantMerged?.kind).toBe("message");
    if (assistantMerged?.kind === "message") {
      expect(assistantMerged.text).toBe("Hello world");
    }
  });

  it("does not let window focus reconcile an active turn from history", async () => {
    vi.mocked(readThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-focus",
          updated_at: 9999,
          turns: [],
        },
      },
    });

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      result.current.setActiveThreadId("thread-focus");
    });
    await waitFor(() => {
      expect(vi.mocked(readThread)).toHaveBeenCalledWith("ws-1", "thread-focus");
    });

    act(() => {
      handlers?.onTurnStarted?.("ws-1", "thread-focus", "turn-focus");
    });
    expect(result.current.threadStatusById["thread-focus"]?.isProcessing).toBe(true);
    expect(result.current.turnExecutionSummaryByThread["thread-focus"]?.status).toBe(
      "active",
    );

    vi.mocked(readThread).mockClear();
    vi.mocked(readThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-focus",
          updated_at: 10_000,
          turns: [{ id: "turn-focus", status: "completed", items: [] }],
        },
      },
    });

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect(vi.mocked(readThread)).not.toHaveBeenCalled();
    expect(result.current.threadStatusById["thread-focus"]?.isProcessing).toBe(true);
    expect(result.current.turnExecutionSummaryByThread["thread-focus"]?.status).toBe(
      "active",
    );
  });

  it("hydrates subagent titles discovered while reading parent history", async () => {
    vi.mocked(readThread).mockResolvedValueOnce({
      result: {
        thread: {
          id: "thread-parent-resume",
          preview: "Parent thread",
          turns: [
            {
              items: [
                {
                  id: "activity-child-resume",
                  type: "subAgentActivity",
                  kind: "started",
                  agentThreadId: "thread-child-resume",
                  agentPath: "/root/check_package_info",
                },
              ],
            },
          ],
        },
      },
    });
    vi.mocked(readThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-child-resume",
          threadName: "检查包信息",
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: "thread-parent-resume",
                agent_path: "/root/check_package_info",
              },
            },
          },
          turns: [],
        },
      },
    });

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      result.current.setActiveThreadId("thread-parent-resume");
    });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledWith("ws-1", "thread-child-resume");
    });
    await waitFor(() => {
      expect(
        result.current.threadsByWorkspace["ws-1"]?.find(
          (thread) => thread.id === "thread-child-resume",
        )?.name,
      ).toBe("检查包信息");
    });
  });

  it("applies runtime codex args before start but not read-only selection resume", async () => {
    const ensureWorkspaceRuntimeCodexArgs = vi.fn(async () => undefined);
    vi.mocked(startThread).mockResolvedValue({
      result: { thread: { id: "thread-new" } },
    } as Awaited<ReturnType<typeof startThread>>);
    vi.mocked(readThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-2",
          preview: "Remote preview",
          updated_at: 9999,
          turns: [],
        },
      },
    });

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
        ensureWorkspaceRuntimeCodexArgs,
      }),
    );

    await act(async () => {
      await result.current.startThread();
    });

    expect(ensureWorkspaceRuntimeCodexArgs).toHaveBeenCalledWith("ws-1", null);
    expect(vi.mocked(startThread)).toHaveBeenCalledWith("ws-1", "quality");
    const startEnsureCallOrder = ensureWorkspaceRuntimeCodexArgs.mock.invocationCallOrder[0];
    const startThreadCallOrder = vi.mocked(startThread).mock.invocationCallOrder[0];
    expect(startEnsureCallOrder).toBeLessThan(startThreadCallOrder);

    ensureWorkspaceRuntimeCodexArgs.mockClear();

    act(() => {
      result.current.setActiveThreadId("thread-2");
    });

    await waitFor(() => {
      expect(vi.mocked(readThread)).toHaveBeenCalledWith("ws-1", "thread-2");
    });
    expect(ensureWorkspaceRuntimeCodexArgs).not.toHaveBeenCalled();
  });

  it("applies runtime codex args before direct startThreadForWorkspace calls", async () => {
    const ensureWorkspaceRuntimeCodexArgs = vi.fn(async () => undefined);
    vi.mocked(startThread).mockResolvedValue({
      result: { thread: { id: "thread-direct-new" } },
    } as Awaited<ReturnType<typeof startThread>>);

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
        ensureWorkspaceRuntimeCodexArgs,
      }),
    );

    await act(async () => {
      await result.current.startThreadForWorkspace("ws-1", { activate: false });
    });

    expect(ensureWorkspaceRuntimeCodexArgs).toHaveBeenCalledWith("ws-1", null);
    expect(vi.mocked(startThread)).toHaveBeenCalledWith("ws-1", "quality");

    const ensureCallOrder = ensureWorkspaceRuntimeCodexArgs.mock.invocationCallOrder[0];
    const startThreadCallOrder = vi.mocked(startThread).mock.invocationCallOrder[0];
    expect(ensureCallOrder).toBeLessThan(startThreadCallOrder);
  });

  it("bounds resident histories and reloads an evicted thread on selection", async () => {
    vi.mocked(readThread).mockImplementation(async (_workspaceId, threadId) => ({
      result: {
        thread: {
          id: threadId,
          turns: [
            {
              items: [
                {
                  type: "agentMessage",
                  id: `message-${threadId}`,
                  text: `history for ${threadId}`,
                },
              ],
            },
          ],
        },
      },
    }) as Awaited<ReturnType<typeof readThread>>);
    const totalThreads = MAX_RESIDENT_THREAD_HISTORIES + 3;
    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    for (let index = 1; index <= totalThreads; index += 1) {
      const threadId = `resident-${index}`;
      act(() => {
        result.current.setActiveThreadId(threadId);
      });
      await waitFor(() => {
        expect(result.current.activeItems.some((item) => item.id === `message-${threadId}`))
          .toBe(true);
      });
    }

    await waitFor(() => {
      expect(Object.keys(result.current.itemsByThread)).toHaveLength(
        MAX_RESIDENT_THREAD_HISTORIES,
      );
    });
    expect(result.current.itemsByThread["resident-1"]).toBeUndefined();
    expect(result.current.itemsByThread[`resident-${totalThreads}`]).toBeDefined();

    act(() => {
      result.current.setActiveThreadId("resident-1");
    });
    await waitFor(() => {
      expect(
        vi.mocked(readThread).mock.calls.filter(
          ([workspaceId, threadId]) =>
            workspaceId === "ws-1" && threadId === "resident-1",
        ),
      ).toHaveLength(2);
    });
    await waitFor(() => {
      expect(
        result.current.activeItems.some(
          (item) => item.id === "message-resident-1",
        ),
      ).toBe(true);
    });
  });

  it("does not reactivate a first-send thread after the user switches away", async () => {
    let resolveStart!: (value: Awaited<ReturnType<typeof startThread>>) => void;
    vi.mocked(startThread).mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    vi.mocked(readThread).mockResolvedValue({
      result: { thread: { id: "thread-other", turns: [] } },
    });
    vi.mocked(sendUserMessageService).mockResolvedValue({
      result: { turn: { id: "turn-background" } },
    } as Awaited<ReturnType<typeof sendUserMessageService>>);

    const { result } = renderHook(() =>
      useThreads({ activeWorkspace: workspace, onWorkspaceConnected: vi.fn() }),
    );

    let sendPromise!: Promise<unknown>;
    act(() => {
      sendPromise = result.current.sendUserMessage("start in background");
    });
    await waitFor(() => {
      expect(startThread).toHaveBeenCalledTimes(1);
    });

    act(() => {
      result.current.setActiveThreadId("thread-other");
    });
    await waitFor(() => {
      expect(result.current.activeThreadId).toBe("thread-other");
    });

    resolveStart({
      result: { thread: { id: "thread-first-send" } },
    } as Awaited<ReturnType<typeof startThread>>);
    await act(async () => {
      await sendPromise;
    });

    expect(result.current.activeThreadId).toBe("thread-other");
    expect(sendUserMessageService).toHaveBeenCalledWith(
      "ws-1",
      "thread-first-send",
      "start in background",
      expect.any(Object),
    );
  });

  it("does not resurrect an optimistic user message when the echo precedes turn/start", async () => {
    let resolveSend!: (
      value: Awaited<ReturnType<typeof sendUserMessageService>>,
    ) => void;
    vi.mocked(readThread).mockResolvedValue({
      result: { thread: { id: "thread-race", turns: [] } },
    });
    vi.mocked(sendUserMessageService).mockReturnValue(
      new Promise((resolve) => {
        resolveSend = resolve;
      }),
    );

    const { result } = renderHook(() =>
      useThreads({ activeWorkspace: workspace, onWorkspaceConnected: vi.fn() }),
    );
    act(() => {
      result.current.setActiveThreadId("thread-race");
    });
    await waitFor(() => {
      expect(result.current.activeThreadId).toBe("thread-race");
      expect(readThread).toHaveBeenCalledWith("ws-1", "thread-race");
    });

    let sendPromise!: Promise<unknown>;
    act(() => {
      sendPromise = result.current.sendUserMessage("single optimistic message", [
        "data:image/png;base64,ORIGINAL",
      ]);
    });
    await waitFor(() => {
      expect(sendUserMessageService).toHaveBeenCalledTimes(1);
      expect(
        result.current.activeItems.filter(
          (item) => item.kind === "message" && item.role === "user",
        ),
      ).toHaveLength(1);
    });

    act(() => {
      handlers?.onItemStarted?.("ws-1", "thread-race", {
        type: "userMessage",
        id: "server-user-race",
        content: [
          { type: "text", text: "single optimistic message" },
          { type: "image", path: "C:\\promoted\\image-1.png" },
        ],
      });
    });
    await waitFor(() => {
      expect(
        result.current.activeItems.filter(
          (item) => item.kind === "message" && item.role === "user",
        ),
      ).toEqual([expect.objectContaining({ id: "server-user-race" })]);
    });

    resolveSend({
      result: { turn: { id: "turn-race" } },
    } as Awaited<ReturnType<typeof sendUserMessageService>>);
    await act(async () => {
      await sendPromise;
    });

    expect(
      result.current.activeItems.filter(
        (item) => item.kind === "message" && item.role === "user",
      ),
    ).toEqual([expect.objectContaining({ id: "server-user-race" })]);
  });

  it("reconciles content-reference echoes with optimistic attachment messages", async () => {
    let resolveSend!: (
      value: Awaited<ReturnType<typeof sendUserMessageService>>,
    ) => void;
    vi.mocked(readThread).mockResolvedValue({
      result: { thread: { id: "thread-content-reference", turns: [] } },
    });
    vi.mocked(createContentReference).mockResolvedValueOnce({
      referenceId: "content-ref-1",
      path: "C:/Codex/references/content-ref-1/content.md",
      characterCount: 9_000,
      estimatedTokens: 2_250,
    });
    vi.mocked(sendUserMessageService).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSend = resolve;
      }),
    );

    const { result } = renderHook(() =>
      useThreads({ activeWorkspace: workspace, onWorkspaceConnected: vi.fn() }),
    );
    act(() => {
      result.current.setActiveThreadId("thread-content-reference");
    });
    await waitFor(() => {
      expect(result.current.activeThreadId).toBe("thread-content-reference");
      expect(readThread).toHaveBeenCalledWith("ws-1", "thread-content-reference");
    });

    const attachmentName = "pasted-text-20260723-205500-786.txt";
    const attachment = `data:text/plain;name="${attachmentName}";base64,${btoa(
      "large content\n".repeat(1_000),
    )}`;
    let sendPromise!: Promise<unknown>;
    act(() => {
      sendPromise = result.current.sendUserMessage("请分析", [attachment]);
    });
    await waitFor(() => {
      expect(sendUserMessageService).toHaveBeenCalledTimes(1);
    });

    const sentText = vi.mocked(sendUserMessageService).mock.calls[0]?.[2] ?? "";
    expect(sentText).toContain("<content_reference");
    act(() => {
      handlers?.onItemStarted?.("ws-1", "thread-content-reference", {
        type: "userMessage",
        id: "server-user-content-reference",
        content: [{ type: "text", text: sentText }],
      });
    });
    await waitFor(() => {
      expect(
        result.current.activeItems.filter(
          (item) => item.kind === "message" && item.role === "user",
        ),
      ).toEqual([
        expect.objectContaining({
          id: "server-user-content-reference",
          text: "请分析",
          attachments: [attachmentName],
        }),
      ]);
    });

    resolveSend({
      result: { turn: { id: "turn-content-reference" } },
    } as Awaited<ReturnType<typeof sendUserMessageService>>);
    await act(async () => {
      await sendPromise;
    });
  });

  it("reads selected thread without invoking a failing runtime preflight", async () => {
    const ensureWorkspaceRuntimeCodexArgs = vi.fn(async () => {
      throw new Error("runtime sync failed");
    });
    vi.mocked(readThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-2",
          preview: "Remote preview",
          updated_at: 9999,
          turns: [],
        },
      },
    });

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
        ensureWorkspaceRuntimeCodexArgs,
      }),
    );

    act(() => {
      result.current.setActiveThreadId("thread-2");
    });

    await waitFor(() => {
      expect(vi.mocked(readThread)).toHaveBeenCalledWith("ws-1", "thread-2");
    });
    expect(ensureWorkspaceRuntimeCodexArgs).not.toHaveBeenCalled();
  });

  it("does not block selected thread history on runtime codex args preflight", async () => {
    const ensureWorkspaceRuntimeCodexArgs = vi.fn(
      () => new Promise<void>(() => undefined),
    );
    vi.mocked(readThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-2",
          preview: "Remote preview",
          updated_at: 9999,
          turns: [],
        },
      },
    });

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
        ensureWorkspaceRuntimeCodexArgs,
      }),
    );

    act(() => {
      result.current.setActiveThreadId("thread-2");
    });

    await waitFor(() => {
      expect(vi.mocked(readThread)).toHaveBeenCalledWith("ws-1", "thread-2");
    });
    expect(ensureWorkspaceRuntimeCodexArgs).not.toHaveBeenCalled();
  });

  it("does not preflight runtime codex args on selection while a workspace thread is processing", async () => {
    const ensureWorkspaceRuntimeCodexArgs = vi.fn(async () => undefined);
    vi.mocked(readThread).mockImplementation(async (_workspaceId, threadId) => ({
      result: {
        thread: {
          id: threadId,
          preview: `Thread ${threadId}`,
          updated_at: 9999,
          turns: [],
        },
      },
    }));

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
        ensureWorkspaceRuntimeCodexArgs,
      }),
    );

    act(() => {
      result.current.setActiveThreadId("thread-1");
    });

    await waitFor(() => {
      expect(vi.mocked(readThread)).toHaveBeenCalledWith("ws-1", "thread-1");
    });

    vi.mocked(readThread).mockClear();
    ensureWorkspaceRuntimeCodexArgs.mockClear();

    act(() => {
      handlers?.onTurnStarted?.("ws-1", "thread-1", "turn-1");
    });

    await waitFor(() => {
      expect(result.current.threadStatusById["thread-1"]?.isProcessing).toBe(true);
    });

    act(() => {
      result.current.setActiveThreadId("thread-2");
    });

    await waitFor(() => {
      expect(vi.mocked(readThread)).toHaveBeenCalledWith("ws-1", "thread-2");
    });

    expect(ensureWorkspaceRuntimeCodexArgs).not.toHaveBeenCalled();
  });

  it("does not preflight runtime codex args on selection when a hidden thread is processing", async () => {
    const ensureWorkspaceRuntimeCodexArgs = vi.fn(async () => undefined);
    vi.mocked(readThread).mockImplementation(async (_workspaceId, threadId) => ({
      result: {
        thread: {
          id: threadId,
          preview: `Thread ${threadId}`,
          updated_at: 9999,
          turns: [],
        },
      },
    }));

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
        ensureWorkspaceRuntimeCodexArgs,
      }),
    );

    act(() => {
      handlers?.onTurnStarted?.("ws-1", "thread-hidden", "turn-hidden-1");
      handlers?.onBackgroundThreadAction?.("ws-1", "thread-hidden", "hide");
    });

    await waitFor(() => {
      expect(result.current.threadStatusById["thread-hidden"]?.isProcessing).toBe(true);
    });

    act(() => {
      result.current.setActiveThreadId("thread-2");
    });

    await waitFor(() => {
      expect(vi.mocked(readThread)).toHaveBeenCalledWith("ws-1", "thread-2");
    });

    expect(ensureWorkspaceRuntimeCodexArgs).not.toHaveBeenCalled();
  });

  it("preflights runtime codex args on send when another workspace thread is processing", async () => {
    const ensureWorkspaceRuntimeCodexArgs = vi.fn(async () => undefined);
    const threadResponse = async (_workspaceId: string, threadId: string) => ({
      result: {
        thread: {
          id: threadId,
          preview: `Thread ${threadId}`,
          updated_at: 9999,
          turns: [],
        },
      },
    });
    vi.mocked(readThread).mockImplementation(threadResponse);
    vi.mocked(resumeThread).mockImplementation(threadResponse);
    vi.mocked(sendUserMessageService).mockResolvedValue({
      result: { turn: { id: "turn-target-1" } },
    } as Awaited<ReturnType<typeof sendUserMessageService>>);

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
        ensureWorkspaceRuntimeCodexArgs,
      }),
    );

    act(() => {
      result.current.setActiveThreadId("thread-busy");
    });

    await waitFor(() => {
      expect(vi.mocked(readThread)).toHaveBeenCalledWith("ws-1", "thread-busy");
    });

    act(() => {
      handlers?.onTurnStarted?.("ws-1", "thread-busy", "turn-busy-1");
    });

    await waitFor(() => {
      expect(result.current.threadStatusById["thread-busy"]?.isProcessing).toBe(true);
    });

    ensureWorkspaceRuntimeCodexArgs.mockClear();

    await act(async () => {
      await result.current.sendUserMessageToThread(
        workspace,
        "thread-target",
        "hello target",
      );
    });

    expect(ensureWorkspaceRuntimeCodexArgs).toHaveBeenCalledWith(
      "ws-1",
      "thread-target",
    );
    const sendCalls = vi.mocked(sendUserMessageService).mock.calls;
    const sendCall = sendCalls[sendCalls.length - 1];
    expect(sendCall?.[0]).toBe("ws-1");
    expect(sendCall?.[1]).toBe("thread-target");
    expect(sendCall?.[2]).toBe("hello target");
  });

  it("resumes a loaded thread after the runtime generation advances before sending", async () => {
    let runtimeContext = {
      sourceId: "source-a",
      runtimeGeneration: 3,
    };
    const ensureWorkspaceRuntimeCodexArgs = vi.fn(async () => undefined);
    const threadResponse = async (_workspaceId: string, threadId: string) => ({
      result: {
        thread: {
          id: threadId,
          preview: `Thread ${threadId}`,
          updated_at: 9999,
          turns: [],
        },
      },
    });
    vi.mocked(resumeThread).mockImplementation(threadResponse);
    vi.mocked(sendUserMessageService).mockResolvedValue({
      result: { turn: { id: "turn-after-provider-switch" } },
    } as Awaited<ReturnType<typeof sendUserMessageService>>);

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
        ensureWorkspaceRuntimeCodexArgs,
        getThreadListRuntimeContext: () => runtimeContext,
      }),
    );

    await act(async () => {
      await result.current.resumeThreadById("ws-1", "thread-provider-switch");
    });
    expect(resumeThread).toHaveBeenCalledTimes(1);

    vi.mocked(resumeThread).mockClear();
    runtimeContext = {
      sourceId: "source-a",
      runtimeGeneration: 4,
    };

    await act(async () => {
      await result.current.sendUserMessage("continue after provider switch");
    });

    expect(ensureWorkspaceRuntimeCodexArgs).toHaveBeenCalledWith(
      "ws-1",
      "thread-provider-switch",
    );
    expect(resumeThread).toHaveBeenCalledWith(
      "ws-1",
      "thread-provider-switch",
    );
    expect(vi.mocked(resumeThread).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sendUserMessageService).mock.invocationCallOrder[0],
    );
  });

  it("blocks a send when the runtime cannot switch away from a busy Provider", async () => {
    const ensureWorkspaceRuntimeCodexArgs = vi.fn(async () => {
      throw new Error(
        "Cannot restart the Codex runtime while another thread is processing.",
      );
    });
    vi.mocked(readThread).mockImplementation(async (_workspaceId, threadId) => ({
      result: {
        thread: {
          id: threadId,
          preview: `Thread ${threadId}`,
          updated_at: 9999,
          turns: [],
        },
      },
    }));
    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
        ensureWorkspaceRuntimeCodexArgs,
      }),
    );

    act(() => {
      result.current.setActiveThreadId("thread-busy");
    });
    await waitFor(() => {
      expect(vi.mocked(readThread)).toHaveBeenCalledWith("ws-1", "thread-busy");
    });
    act(() => {
      handlers?.onTurnStarted?.("ws-1", "thread-busy", "turn-busy-1");
    });
    await waitFor(() => {
      expect(result.current.threadStatusById["thread-busy"]?.isProcessing).toBe(true);
    });

    ensureWorkspaceRuntimeCodexArgs.mockClear();
    let sendResult: Awaited<
      ReturnType<typeof result.current.sendUserMessageToThread>
    > | null = null;
    await act(async () => {
      sendResult = await result.current.sendUserMessageToThread(
        workspace,
        "thread-target",
        "hello target",
      );
    });

    expect(ensureWorkspaceRuntimeCodexArgs).toHaveBeenCalledWith(
      "ws-1",
      "thread-target",
    );
    expect(vi.mocked(sendUserMessageService)).not.toHaveBeenCalled();
    expect(sendResult).toEqual({ status: "blocked" });
    expect(result.current.itemsByThread["thread-target"] ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "message", role: "user", text: "hello target" }),
      ]),
    );
  });

  it("does not synthesize continuation turns after final turn errors", () => {
    renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        workspaces: [workspace],
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      handlers?.onTurnError?.("ws-1", "thread-1", "turn-1", {
        message: "unexpected status 502 Bad Gateway",
        willRetry: false,
      });
    });

    expect(sendUserMessageService).not.toHaveBeenCalled();
  });

  it("does not start a thread when runtime codex args sync fails", async () => {
    const ensureWorkspaceRuntimeCodexArgs = vi.fn(async () => {
      throw new Error("runtime sync failed");
    });
    vi.mocked(startThread).mockResolvedValue({
      result: { thread: { id: "thread-new" } },
    } as Awaited<ReturnType<typeof startThread>>);

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
        ensureWorkspaceRuntimeCodexArgs,
      }),
    );

    let threadId: string | null = "pending";
    await act(async () => {
      threadId = await result.current.startThread();
    });

    expect(ensureWorkspaceRuntimeCodexArgs).toHaveBeenCalledWith("ws-1", null);
    expect(vi.mocked(startThread)).not.toHaveBeenCalled();
    expect(threadId).toBeNull();
  });

  it("defers trimming until scrollback settings hydrate", async () => {
    const totalItems = 240;
    const items = Array.from({ length: totalItems }, (_, index) =>
      index % 2 === 0
        ? {
            type: "userMessage",
            id: `server-user-${index}`,
            content: [{ type: "text", text: `User ${index}` }],
          }
        : {
            type: "agentMessage",
            id: `server-assistant-${index}`,
            text: `Assistant ${index}`,
          },
    );

    vi.mocked(readThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-scrollback",
          preview: "Remote preview",
          updated_at: 9999,
          turns: [
            {
              items,
            },
          ],
        },
      },
    });

    const { result, rerender } = renderHook(
      ({ scrollbackItems }) =>
        useThreads({
          activeWorkspace: workspace,
          onWorkspaceConnected: vi.fn(),
          chatHistoryScrollbackItems: scrollbackItems,
        }),
      {
        initialProps: {
          scrollbackItems: null as number | null,
        },
      },
    );

    expect(handlers).not.toBeNull();

    act(() => {
      result.current.setActiveThreadId("thread-scrollback");
    });

    await waitFor(() => {
      expect(vi.mocked(readThread)).toHaveBeenCalledWith(
        "ws-1",
        "thread-scrollback",
      );
    });

    await waitFor(() => {
      expect(result.current.activeItems).toHaveLength(totalItems);
    });

    rerender({ scrollbackItems: 200 });

    await waitFor(() => {
      expect(result.current.activeItems).toHaveLength(200);
    });
  });

  it("reads selected history without resuming the execution runtime", async () => {
    let resolveUsage!: (value: Record<string, unknown> | null) => void;
    let resolveSummaries!: (value: []) => void;
    vi.mocked(getThreadTokenUsage).mockReturnValue(
      new Promise((resolve) => {
        resolveUsage = resolve;
      }),
    );
    vi.mocked(getTurnExecutionSummaries).mockReturnValue(
      new Promise((resolve) => {
        resolveSummaries = resolve;
      }),
    );
    vi.mocked(readThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-fast-history",
          turns: [
            {
              id: "turn-fast-history",
              items: [
                {
                  type: "agentMessage",
                  id: "assistant-fast-history",
                  text: "History is ready",
                },
              ],
            },
          ],
        },
      },
    });

    const { result } = renderHook(() =>
      useThreads({ activeWorkspace: workspace, onWorkspaceConnected: vi.fn() }),
    );

    act(() => {
      result.current.setActiveThreadId("thread-fast-history");
    });

    await waitFor(() => {
      expect(result.current.activeItems).toEqual([
        expect.objectContaining({
          id: "assistant-fast-history",
          kind: "message",
          role: "assistant",
          text: "History is ready",
        }),
      ]);
      expect(
        result.current.threadResumeLoadingById["thread-fast-history"],
      ).toBe(false);
    });
    expect(getThreadTokenUsage).toHaveBeenCalledWith(
      "ws-1",
      "thread-fast-history",
    );
    expect(readThread).toHaveBeenCalledWith("ws-1", "thread-fast-history");
    expect(resumeThread).not.toHaveBeenCalled();

    await act(async () => {
      resolveUsage(null);
      resolveSummaries([]);
      await Promise.resolve();
    });
  });

  it("reloads and replaces selected history when the session runtime changes", async () => {
    let runtimeContext = {
      sourceId: "source-a",
      runtimeGeneration: 1,
    };
    vi.mocked(readThread)
      .mockResolvedValueOnce({
        result: {
          thread: {
            id: "thread-shared",
            turns: [
              {
                id: "turn-source-a",
                items: [
                  {
                    type: "agentMessage",
                    id: "assistant-source-a",
                    text: "Source A history",
                  },
                ],
              },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        result: {
          thread: {
            id: "thread-shared",
            turns: [
              {
                id: "turn-source-b",
                items: [
                  {
                    type: "agentMessage",
                    id: "assistant-source-b",
                    text: "Source B history",
                  },
                ],
              },
            ],
          },
        },
      });

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
        getThreadListRuntimeContext: () => runtimeContext,
      }),
    );

    act(() => {
      result.current.setActiveThreadId("thread-shared");
    });
    await waitFor(() => {
      expect(result.current.activeItems).toEqual([
        expect.objectContaining({
          id: "assistant-source-a",
          text: "Source A history",
        }),
      ]);
    });

    vi.mocked(readThread).mockClear();
    runtimeContext = {
      sourceId: "source-b",
      runtimeGeneration: 2,
    };

    act(() => {
      result.current.setActiveThreadId("thread-shared");
    });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledWith("ws-1", "thread-shared");
    });
    await waitFor(() => {
      expect(result.current.activeItems).toEqual([
        expect.objectContaining({
          id: "assistant-source-b",
          text: "Source B history",
        }),
      ]);
    });
  });

  it("hydrates every matching terminal execution summary on read", async () => {
    vi.mocked(readThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-summary-hydrate",
          preview: "Remote preview",
          turns: [{ id: "turn-1", items: [] }, { id: "turn-2", items: [] }],
        },
      },
    });
    vi.mocked(getTurnExecutionSummaries).mockResolvedValue([
      {
        schemaVersion: 1,
        executionId: "execution-2",
        workspaceId: "ws-1",
        threadId: "thread-summary-hydrate",
        turnId: "turn-2",
        turnChain: ["turn-1", "turn-2"],
        status: "completed",
        startedAtMs: 200,
        endedAtMs: 300,
        workingDurationMs: 100,
        addedLines: 2,
        deletedLines: 1,
        diffRevision: 1,
        recordRevision: 3,
        updatedAtMs: 300,
      },
      {
        schemaVersion: 1,
        executionId: "execution-1",
        workspaceId: "ws-1",
        threadId: "thread-summary-hydrate",
        turnId: "turn-1",
        turnChain: ["turn-1"],
        status: "interrupted",
        startedAtMs: 100,
        endedAtMs: 150,
        workingDurationMs: 50,
        addedLines: 1,
        deletedLines: 0,
        diffRevision: 1,
        recordRevision: 2,
        updatedAtMs: 150,
      },
    ]);

    const { result } = renderHook(() =>
      useThreads({ activeWorkspace: workspace, onWorkspaceConnected: vi.fn() }),
    );
    act(() => {
      result.current.setActiveThreadId("thread-summary-hydrate");
    });

    await waitFor(() => {
      expect(result.current.turnExecutionSummariesByThread["thread-summary-hydrate"]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ executionId: "execution-1" }),
          expect.objectContaining({ executionId: "execution-2" }),
        ]),
      );
    });
  });

  it("auto-archives inactive old threads", async () => {
    now = Date.UTC(2026, 0, 10);
    vi.mocked(scanManagedSessions).mockResolvedValue({
      requestId: "scan",
      totalSessions: 3,
      diagnosticCount: 0,
      cancelled: false,
      sourceSnapshots: [],
    });
    vi.mocked(fetchManagedSessionsPage).mockResolvedValue({
      requestId: "scan",
      items: [
        managedSession("thread-fresh", "/tmp/codex", now - DAY_MS),
        managedSession("thread-old", "/tmp/codex", now - 5 * DAY_MS),
        managedSession("thread-other-workspace", "/tmp/other", now - 5 * DAY_MS),
      ],
      diagnostics: [],
      total: 3,
      nextOffset: null,
    });
    vi.mocked(archiveThread).mockResolvedValue({});

    renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        workspaces: [workspace],
        autoArchiveThreadsEnabled: true,
        autoArchiveThreadsDays: 3,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    await waitFor(() => {
      expect(vi.mocked(archiveThread)).toHaveBeenCalledWith("ws-1", "thread-old");
    });
    expect(vi.mocked(archiveThread)).not.toHaveBeenCalledWith("ws-1", "thread-fresh");
    expect(vi.mocked(archiveThread)).not.toHaveBeenCalledWith(
      "ws-1",
      "thread-other-workspace",
    );
  });

  it("clears the active-session cache after a partial auto-archive failure", async () => {
    now = Date.UTC(2026, 0, 10);
    vi.mocked(scanManagedSessions).mockResolvedValue({
      requestId: "scan",
      totalSessions: 2,
      diagnosticCount: 0,
      cancelled: false,
      sourceSnapshots: [],
    });
    vi.mocked(fetchManagedSessionsPage).mockResolvedValue({
      requestId: "scan",
      items: [
        managedSession("thread-old-a", "/tmp/codex", now - 5 * DAY_MS),
        managedSession("thread-old-b", "/tmp/codex", now - 5 * DAY_MS),
      ],
      diagnostics: [],
      total: 2,
      nextOffset: null,
    });
    vi.mocked(archiveThread)
      .mockRejectedValue(new Error("archive failed"))
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("archive failed"));

    renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        workspaces: [workspace],
        autoArchiveThreadsEnabled: true,
        autoArchiveThreadsDays: 3,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    await waitFor(() => {
      expect(vi.mocked(archiveThread)).toHaveBeenCalledWith(
        "ws-1",
        "thread-old-b",
      );
    });
    await waitFor(() => {
      expect(vi.mocked(scanManagedSessions)).toHaveBeenCalledTimes(2);
    });
  });

  it("does not scan the local Codex history workspace during auto archive", async () => {
    now = Date.UTC(2026, 0, 10);
    const localCodexWorkspace: WorkspaceInfo = {
      id: LOCAL_CODEX_WORKSPACE_ID,
      name: "本机 Codex 历史会话",
      path: "",
      connected: true,
      settings: { sidebarCollapsed: false },
    };
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "thread-local-old",
            cwd: "/tmp/codex",
            updated_at: now - 5 * DAY_MS,
          },
        ],
        nextCursor: null,
      },
    });
    vi.mocked(archiveThread).mockResolvedValue({});

    renderHook(() =>
      useThreads({
        activeWorkspace: localCodexWorkspace,
        workspaces: [localCodexWorkspace],
        autoArchiveThreadsEnabled: true,
        autoArchiveThreadsDays: 3,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.mocked(archiveThread)).not.toHaveBeenCalled();
    expect(vi.mocked(scanManagedSessions)).not.toHaveBeenCalled();
  });

  it("auto-archives old local Codex history threads that do not belong to a workspace", async () => {
    now = Date.UTC(2026, 0, 10);
    const localCodexWorkspace: WorkspaceInfo = {
      id: LOCAL_CODEX_WORKSPACE_ID,
      name: "本机 Codex 历史会话",
      path: "",
      connected: true,
      settings: { sidebarCollapsed: false },
    };
    vi.mocked(scanManagedSessions).mockResolvedValue({
      requestId: "scan",
      totalSessions: 3,
      diagnosticCount: 0,
      cancelled: false,
      sourceSnapshots: [],
    });
    vi.mocked(fetchManagedSessionsPage).mockResolvedValue({
      requestId: "scan",
      items: [
        managedSession("thread-local-old", "/tmp/untracked-project", now - 5 * DAY_MS),
        managedSession("thread-project-old", "/tmp/codex", now - 5 * DAY_MS),
        managedSession(
          "thread-known-project-old",
          "/tmp/known-project",
          now - 5 * DAY_MS,
        ),
      ],
      diagnostics: [],
      total: 3,
      nextOffset: null,
    });
    vi.mocked(listWorkspaces).mockResolvedValue([
      {
        id: "ws-known",
        name: "Known Project",
        path: "/tmp/known-project",
        connected: false,
        settings: { sidebarCollapsed: false },
      },
    ]);
    vi.mocked(archiveThread).mockResolvedValue({});

    renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        workspaces: [workspace, localCodexWorkspace],
        autoArchiveThreadsEnabled: true,
        autoArchiveThreadsDays: 3,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    await waitFor(() => {
      expect(vi.mocked(archiveThread)).toHaveBeenCalledWith(
        "ws-1",
        "thread-local-old",
      );
    });
    expect(vi.mocked(archiveThread)).toHaveBeenCalledWith("ws-1", "thread-project-old");
    expect(vi.mocked(archiveThread)).not.toHaveBeenCalledWith(
      "ws-1",
      "thread-known-project-old",
    );
  });

  it("skips active and pinned threads during auto archive", async () => {
    now = Date.UTC(2026, 0, 10);
    vi.mocked(scanManagedSessions).mockResolvedValue({
      requestId: "scan",
      totalSessions: 3,
      diagnosticCount: 0,
      cancelled: false,
      sourceSnapshots: [],
    });
    vi.mocked(fetchManagedSessionsPage).mockResolvedValue({
      requestId: "scan",
      items: [
        managedSession("thread-active", "/tmp/codex", now - 5 * DAY_MS),
        managedSession("thread-pinned", "/tmp/codex", now - 5 * DAY_MS),
        managedSession("thread-old", "/tmp/codex", now - 5 * DAY_MS),
      ],
      diagnostics: [],
      total: 3,
      nextOffset: null,
    });
    vi.mocked(archiveThread).mockResolvedValue({});

    const { result, rerender } = renderHook(
      ({ autoArchiveThreadsEnabled }) =>
        useThreads({
          activeWorkspace: workspace,
          workspaces: [workspace],
          autoArchiveThreadsEnabled,
          autoArchiveThreadsDays: 3,
          onWorkspaceConnected: vi.fn(),
        }),
      { initialProps: { autoArchiveThreadsEnabled: false } },
    );

    act(() => {
      result.current.setActiveThreadId("thread-active");
      result.current.pinThread("ws-1", "thread-pinned");
    });

    rerender({ autoArchiveThreadsEnabled: true });

    await waitFor(() => {
      expect(vi.mocked(archiveThread)).toHaveBeenCalledWith("ws-1", "thread-old");
    });
    expect(vi.mocked(archiveThread)).not.toHaveBeenCalledWith(
      "ws-1",
      "thread-active",
    );
    expect(vi.mocked(archiveThread)).not.toHaveBeenCalledWith(
      "ws-1",
      "thread-pinned",
    );
  });

  it("bounds hydrated history after scrollback settings are available", async () => {
    const totalItems = 240;
    const items = Array.from({ length: totalItems }, (_, index) =>
      index % 2 === 0
        ? {
            type: "userMessage",
            id: `server-user-${index}`,
            content: [{ type: "text", text: `User ${index}` }],
          }
        : {
            type: "agentMessage",
            id: `server-assistant-${index}`,
            text: `Assistant ${index}`,
          },
    );

    vi.mocked(readThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-long-history",
          preview: "Remote preview",
          updated_at: 9999,
          turns: [{ items }],
        },
      },
    });

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
        chatHistoryScrollbackItems: 200,
      }),
    );

    act(() => {
      result.current.setActiveThreadId("thread-long-history");
    });

    await waitFor(() => {
      expect(result.current.activeItems).toHaveLength(200);
    });
    expect(result.current.activeItems[0]?.id).toBe("server-user-40");
  });

  it("keeps the latest plan visible when a new turn starts", () => {
    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      handlers?.onTurnPlanUpdated?.("ws-1", "thread-1", "turn-1", {
        explanation: " Plan note ",
        plan: [{ step: "Do it", status: "in_progress" }],
      });
    });

    expect(result.current.planByThread["thread-1"]).toMatchObject({
      turnId: "turn-1",
      explanation: "Plan note",
      steps: [{ step: "Do it", status: "inProgress" }],
    });

    act(() => {
      handlers?.onTurnStarted?.("ws-1", "thread-1", "turn-2");
    });

    expect(result.current.planByThread["thread-1"]).toMatchObject({
      turnId: "turn-1",
      explanation: "Plan note",
      steps: [{ step: "Do it", status: "inProgress" }],
    });
  });

  it("stores turn diff updates from app-server events", () => {
    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      handlers?.onTurnDiffUpdated?.(
        "ws-1",
        "thread-1",
        "diff --git a/src/a.ts b/src/a.ts",
      );
    });

    expect(result.current.turnDiffByThread["thread-1"]).toBe(
      "diff --git a/src/a.ts b/src/a.ts",
    );
  });

  it("persists a terminal execution summary without blocking turn completion", async () => {
    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      handlers?.onTurnStarted?.("ws-1", "thread-1", "turn-1");
      handlers?.onTurnDiffUpdated?.("ws-1", "thread-1", "+added\n-removed");
      handlers?.onTurnCompleted?.("ws-1", "thread-1", "turn-1", "completed");
    });

    expect(result.current.turnExecutionSummaryByThread["thread-1"]).toMatchObject({
      turnId: "turn-1",
      status: "completed",
      addedLines: 1,
      deletedLines: 1,
    });
    await waitFor(() => {
      expect(upsertTurnExecutionSummary).toHaveBeenLastCalledWith(
        expect.objectContaining({
          workspaceId: "ws-1",
          threadId: "thread-1",
          turnId: "turn-1",
          status: "completed",
        }),
      );
    });
  });

  it("does not resume selected threads that already have local items", async () => {
    vi.mocked(resumeThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-3",
          preview: "Remote preview",
          updated_at: 9999,
          turns: [
            {
              items: [
                {
                  type: "userMessage",
                  id: "server-user-1",
                  content: [{ type: "text", text: "Remote hello" }],
                },
                {
                  type: "agentMessage",
                  id: "server-assistant-1",
                  text: "Remote response",
                },
              ],
            },
          ],
        },
      },
    });
    const ensureWorkspaceRuntimeCodexArgs = vi.fn(async () => undefined);

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
        ensureWorkspaceRuntimeCodexArgs,
      }),
    );

    expect(handlers).not.toBeNull();

    act(() => {
      handlers?.onAgentMessageCompleted?.({
        workspaceId: "ws-1",
        threadId: "thread-3",
        itemId: "local-assistant-1",
        text: "Local response",
      });
    });

    act(() => {
      result.current.setActiveThreadId("thread-3");
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.mocked(resumeThread)).not.toHaveBeenCalled();
    expect(ensureWorkspaceRuntimeCodexArgs).not.toHaveBeenCalled();

    const activeItems = result.current.activeItems;
    const hasLocal = activeItems.some(
      (item) =>
        item.kind === "message" &&
        item.role === "assistant" &&
        item.id === "local-assistant-1",
    );
    const hasRemote = activeItems.some(
      (item) => item.kind === "message" && item.id === "server-user-1",
    );
    expect(hasLocal).toBe(true);
    expect(hasRemote).toBe(false);
  });

  it("clears empty plan updates to null", () => {
    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      handlers?.onTurnPlanUpdated?.("ws-1", "thread-1", "turn-1", {
        explanation: "   ",
        plan: [],
      });
    });

    expect(result.current.planByThread["thread-1"]).toBeNull();
  });

  it("normalizes plan step status values", () => {
    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      handlers?.onTurnPlanUpdated?.("ws-1", "thread-1", "turn-1", {
        explanation: "",
        plan: [
          { step: "Step 1", status: "in_progress" },
          { step: "Step 2", status: "in-progress" },
          { step: "Step 3", status: "in progress" },
          { step: "Step 4", status: "completed" },
          { step: "Step 5", status: "unknown" },
        ],
      });
    });

    expect(result.current.planByThread["thread-1"]).toMatchObject({
      turnId: "turn-1",
      explanation: null,
      steps: [
        { step: "Step 1", status: "inProgress" },
        { step: "Step 2", status: "inProgress" },
        { step: "Step 3", status: "inProgress" },
        { step: "Step 4", status: "completed" },
        { step: "Step 5", status: "pending" },
      ],
    });
  });

  it("replaces the plan when a new turn updates it", () => {
    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      handlers?.onTurnPlanUpdated?.("ws-1", "thread-1", "turn-1", {
        explanation: "First plan",
        plan: [{ step: "Step 1", status: "pending" }],
      });
      handlers?.onTurnPlanUpdated?.("ws-1", "thread-1", "turn-2", {
        explanation: "Next plan",
        plan: [{ step: "Step 2", status: "completed" }],
      });
    });

    expect(result.current.planByThread["thread-1"]).toMatchObject({
      turnId: "turn-2",
      explanation: "Next plan",
      steps: [{ step: "Step 2", status: "completed" }],
    });
  });

  it("keeps plans isolated per thread", () => {
    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      handlers?.onTurnPlanUpdated?.("ws-1", "thread-1", "turn-1", {
        explanation: "Thread 1 plan",
        plan: [{ step: "Step 1", status: "pending" }],
      });
      handlers?.onTurnPlanUpdated?.("ws-1", "thread-2", "turn-2", {
        explanation: "Thread 2 plan",
        plan: [{ step: "Step 2", status: "completed" }],
      });
    });

    expect(result.current.planByThread["thread-1"]).toMatchObject({
      turnId: "turn-1",
      explanation: "Thread 1 plan",
      steps: [{ step: "Step 1", status: "pending" }],
    });
    expect(result.current.planByThread["thread-2"]).toMatchObject({
      turnId: "turn-2",
      explanation: "Thread 2 plan",
      steps: [{ step: "Step 2", status: "completed" }],
    });
  });

  it("clears completed plans when a turn finishes", () => {
    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      handlers?.onTurnPlanUpdated?.("ws-1", "thread-1", "turn-1", {
        explanation: "All done",
        plan: [{ step: "Step 1", status: "completed" }],
      });
    });

    expect(result.current.planByThread["thread-1"]).toMatchObject({
      turnId: "turn-1",
      explanation: "All done",
      steps: [{ step: "Step 1", status: "completed" }],
    });

    act(() => {
      handlers?.onTurnCompleted?.("ws-1", "thread-1", "turn-1");
    });

    expect(result.current.planByThread["thread-1"]).toBeNull();
  });

  it("reconciles once and marks remaining plan steps stale on turn completion", async () => {
    vi.mocked(readThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-1",
          turns: [],
        },
      },
    });
    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      handlers?.onTurnPlanUpdated?.("ws-1", "thread-1", "turn-1", {
        explanation: "Still in progress",
        plan: [{ step: "Step 1", status: "in_progress" }],
      });
    });

    act(() => {
      handlers?.onTurnCompleted?.("ws-1", "thread-1", "turn-1");
      handlers?.onTurnCompleted?.("ws-1", "thread-1", "turn-1");
    });

    await waitFor(() => {
      expect(result.current.planByThread["thread-1"]).toMatchObject({
        turnId: "turn-1",
        explanation: "Still in progress",
        steps: [{ step: "Step 1", status: "inProgress" }],
        syncState: "stale",
      });
    });
    expect(readThread).toHaveBeenCalledTimes(1);
    expect(readThread).toHaveBeenCalledWith("ws-1", "thread-1");
  });

  it("interrupts immediately even before a turn id is available", async () => {
    const interruptMock = vi.mocked(interruptTurn);
    interruptMock.mockResolvedValue({ result: {} });

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      result.current.setActiveThreadId("thread-1");
    });

    await act(async () => {
      await result.current.interruptTurn();
    });

    expect(interruptMock).toHaveBeenCalledWith("ws-1", "thread-1", "pending");
    expect(result.current.interruptedThreadById["thread-1"]).toEqual(
      expect.objectContaining({ timestamp: expect.any(Number) }),
    );
    expect(
      result.current.activeItems.some(
        (item) => item.kind === "message" && item.text === "Session stopped.",
      ),
    ).toBe(false);

    act(() => {
      handlers?.onTurnStarted?.("ws-1", "thread-1", "turn-1");
    });

    await waitFor(() => {
      expect(interruptMock).toHaveBeenCalledWith("ws-1", "thread-1", "turn-1");
    });
    expect(interruptMock).toHaveBeenCalledTimes(2);
  });

  it("keeps queued sends blocked while request user input is pending", async () => {
    vi.mocked(sendUserMessageService)
      .mockResolvedValueOnce({
        result: { turn: { id: "turn-1" } },
      } as Awaited<ReturnType<typeof sendUserMessageService>>)
      .mockResolvedValueOnce({
        result: { turn: { id: "turn-2" } },
      } as Awaited<ReturnType<typeof sendUserMessageService>>);
    const connectWorkspace = vi.fn().mockResolvedValue(undefined);
    const clearActiveImages = vi.fn();

    const { result } = renderHook(() => {
      const threads = useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      });
      const threadId = threads.activeThreadId;
      const status = threadId ? threads.threadStatusById[threadId] : undefined;
      const queued = useQueuedSend({
        activeThreadId: threadId,
        activeTurnId: threadId ? threads.activeTurnIdByThread[threadId] ?? null : null,
        isProcessing: status?.isProcessing ?? false,
        isReviewing: status?.isReviewing ?? false,
        steerEnabled: false,
        followUpMessageBehavior: "queue",
        appsEnabled: true,
        activeWorkspace: workspace,
        connectWorkspace,
        startThreadForWorkspace: threads.startThreadForWorkspace,
        sendUserMessage: threads.sendUserMessage,
        sendUserMessageToThread: threads.sendUserMessageToThread,
        startFork: threads.startFork,
        startReview: threads.startReview,
        startResume: threads.startResume,
        startCompact: threads.startCompact,
        startApps: threads.startApps,
        startMcp: threads.startMcp,
        startFast: threads.startFast,
        startStatus: threads.startStatus,
        clearActiveImages,
      });
      return { threads, queued };
    });

    expect(handlers).not.toBeNull();

    act(() => {
      result.current.threads.setActiveThreadId("thread-1");
    });

    await act(async () => {
      await result.current.threads.sendUserMessage("Start running turn");
    });

    await waitFor(() => {
      expect(result.current.threads.threadStatusById["thread-1"]?.isProcessing).toBe(true);
      expect(result.current.threads.activeTurnIdByThread["thread-1"]).toBe("turn-1");
      expect(sendUserMessageService).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await result.current.queued.handleSend("Queued during turn");
    });

    expect(result.current.queued.activeQueue).toHaveLength(1);
    expect(sendUserMessageService).toHaveBeenCalledTimes(1);

    act(() => {
      handlers?.onRequestUserInput?.({
        workspace_id: "ws-1",
        request_id: "request-1",
        params: {
          thread_id: "thread-1",
          turn_id: "turn-1",
          item_id: "item-1",
          questions: [],
        },
      });
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.queued.activeQueue).toHaveLength(1);
    expect(sendUserMessageService).toHaveBeenCalledTimes(1);

    act(() => {
      handlers?.onTurnCompleted?.("ws-1", "thread-1", "turn-1");
    });

    await waitFor(() => {
      expect(sendUserMessageService).toHaveBeenCalledTimes(2);
    });
    const queuedCall = vi.mocked(sendUserMessageService).mock.calls[1];
    expect(queuedCall?.[0]).toBe("ws-1");
    expect(queuedCall?.[1]).toBe("thread-1");
    expect(queuedCall?.[2]).toBe("Queued during turn");
  });

  it("keeps active turn id after request user input so interrupt targets the running turn", async () => {
    const interruptMock = vi.mocked(interruptTurn);
    interruptMock.mockResolvedValue({ result: {} });

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      result.current.setActiveThreadId("thread-1");
      handlers?.onTurnStarted?.("ws-1", "thread-1", "turn-1");
      handlers?.onRequestUserInput?.({
        workspace_id: "ws-1",
        request_id: "request-1",
        params: {
          thread_id: "thread-1",
          turn_id: "turn-1",
          item_id: "item-1",
          questions: [],
        },
      });
    });

    await act(async () => {
      await result.current.interruptTurn();
    });

    expect(interruptMock).toHaveBeenCalledWith("ws-1", "thread-1", "turn-1");
    expect(interruptMock).not.toHaveBeenCalledWith("ws-1", "thread-1", "pending");
  });

  it("interrupts the newest live turn before reducer state catches up", async () => {
    const interruptMock = vi.mocked(interruptTurn);
    interruptMock.mockResolvedValue({ result: {} });

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      result.current.setActiveThreadId("thread-1");
      handlers?.onTurnStarted?.("ws-1", "thread-1", "turn-stale");
    });

    await act(async () => {
      handlers?.onTurnStarted?.("ws-1", "thread-1", "turn-current");
      await result.current.interruptTurn();
    });

    expect(interruptMock).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      "turn-current",
    );
  });

  it("keeps the turn active until interrupt completion is confirmed", async () => {
    let resolveInterrupt!: (value: Awaited<ReturnType<typeof interruptTurn>>) => void;
    vi.mocked(interruptTurn).mockReturnValue(
      new Promise((resolve) => {
        resolveInterrupt = resolve;
      }),
    );

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      result.current.setActiveThreadId("thread-1");
      handlers?.onTurnStarted?.("ws-1", "thread-1", "turn-1");
    });

    let interruptPromise!: Promise<void>;
    act(() => {
      interruptPromise = result.current.interruptTurn();
    });

    expect(result.current.threadStatusById["thread-1"]?.isProcessing).toBe(true);
    expect(result.current.activeTurnIdByThread["thread-1"]).toBe("turn-1");

    resolveInterrupt({ result: {} });
    await act(async () => {
      await interruptPromise;
    });

    expect(result.current.threadStatusById["thread-1"]?.isProcessing).toBe(false);
    expect(result.current.activeTurnIdByThread["thread-1"]).toBeNull();
  });

  it("keeps the turn active when interrupt completion cannot be confirmed", async () => {
    vi.mocked(interruptTurn).mockRejectedValue(
      new Error("Turn interruption was acknowledged, but completion could not be confirmed."),
    );

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      result.current.setActiveThreadId("thread-1");
      handlers?.onTurnStarted?.("ws-1", "thread-1", "turn-1");
    });

    await act(async () => {
      await result.current.interruptTurn();
    });

    expect(result.current.threadStatusById["thread-1"]?.isProcessing).toBe(true);
    expect(result.current.activeTurnIdByThread["thread-1"]).toBe("turn-1");
    expect(result.current.itemsByThread["thread-1"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "message",
          role: "assistant",
          text: "Turn interruption was acknowledged, but completion could not be confirmed.",
        }),
      ]),
    );
  });

  it("uses turn steer after request user input when the turn is still active", async () => {
    vi.mocked(steerTurn).mockResolvedValue({
      result: { turnId: "turn-1" },
    } as Awaited<ReturnType<typeof steerTurn>>);
    vi.mocked(sendUserMessageService).mockResolvedValue({
      result: { turn: { id: "turn-2" } },
    } as Awaited<ReturnType<typeof sendUserMessageService>>);

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
        steerEnabled: true,
      }),
    );

    act(() => {
      result.current.setActiveThreadId("thread-1");
      handlers?.onTurnStarted?.("ws-1", "thread-1", "turn-1");
      handlers?.onRequestUserInput?.({
        workspace_id: "ws-1",
        request_id: "request-1",
        params: {
          thread_id: "thread-1",
          turn_id: "turn-1",
          item_id: "item-1",
          questions: [],
        },
      });
    });

    expect(result.current.threadStatusById["thread-1"]?.isProcessing).toBe(true);
    expect(result.current.activeTurnIdByThread["thread-1"]).toBe("turn-1");

    await act(async () => {
      await result.current.sendUserMessage("Steer after user input");
    });

    expect(vi.mocked(steerTurn).mock.calls[0]?.slice(0, 5)).toEqual([
      "ws-1",
      "thread-1",
      "turn-1",
      "Steer after user input",
      [],
    ]);
    expect(sendUserMessageService).not.toHaveBeenCalled();
  });

  it("links detached review thread to its parent", async () => {
    vi.mocked(startReview).mockResolvedValue({
      result: { reviewThreadId: "thread-review-1" },
    });

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
        reviewDeliveryMode: "detached",
      }),
    );

    act(() => {
      result.current.setActiveThreadId("thread-parent");
    });

    await act(async () => {
      await result.current.startReview("/review check this");
    });

    await waitFor(() => {
      expect(vi.mocked(startReview)).toHaveBeenCalledWith(
        "ws-1",
        "thread-parent",
        expect.any(Object),
        "detached",
      );
    });

    expect(result.current.threadParentById["thread-review-1"]).toBe("thread-parent");
  });

  it("keeps detached collab review threads under the original parent", async () => {
    vi.mocked(startReview).mockResolvedValue({
      result: { reviewThreadId: "thread-review-1" },
    });

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
        reviewDeliveryMode: "detached",
      }),
    );

    act(() => {
      result.current.setActiveThreadId("thread-parent");
    });

    await act(async () => {
      await result.current.startReview("/review check this");
    });

    expect(result.current.threadParentById["thread-review-1"]).toBe("thread-parent");

    act(() => {
      handlers?.onItemCompleted?.("ws-1", "thread-parent", {
        type: "collabToolCall",
        id: "item-collab-1",
        senderThreadId: "thread-review-1",
        newThreadId: "thread-review-2",
      });
    });

    expect(result.current.threadParentById["thread-review-2"]).toBe("thread-review-1");

    const { result: threadRowsResult } = renderHook(() =>
      useThreadRows(result.current.threadParentById),
    );
    const rows = threadRowsResult.current.getThreadRows(
      [
        { id: "thread-parent", name: "Parent", updatedAt: 3 },
        { id: "thread-review-2", name: "Review Child", updatedAt: 2 },
      ],
      true,
      "ws-1",
      () => null,
    );
    expect(rows.unpinnedRows.map((row) => [row.thread.id, row.depth])).toEqual([
      ["thread-parent", 0],
      ["thread-review-2", 1],
    ]);
  });

  it("classifies live spawned threads from thread source metadata", () => {
    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      handlers?.onThreadStarted?.("ws-1", {
        id: "thread-child-live",
        preview: "Child live",
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: "thread-parent-live",
              depth: 1,
            },
          },
        },
      });
    });

    expect(result.current.threadParentById["thread-child-live"]).toBe("thread-parent-live");
    expect(result.current.isSubagentThread("ws-1", "thread-child-live")).toBe(true);
  });

  it("generates a language-matched title when a listed subagent only has a task slug", async () => {
    vi.mocked(generateRunMetadata).mockResolvedValue({
      title: "分支清理审查",
      worktreeName: "chore/branch-cleanup-audit",
    });
    vi.mocked(listWorkspaces).mockResolvedValue([workspace]);
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "thread-parent-title",
            cwd: "/tmp/codex",
            name: "完善 Context 与 Provider 跨层反馈链",
            preview: "父会话预览",
            updated_at: 5000,
          },
          {
            id: "thread-child-title",
            cwd: "/tmp/codex",
            name: null,
            preview: "继承的父会话旧消息",
            updated_at: 4900,
            source: {
              subAgent: {
                thread_spawn: {
                  parent_thread_id: "thread-parent-title",
                  agent_path: "/root/branch_cleanup_audit",
                },
              },
            },
          },
        ],
        nextCursor: null,
      },
    });
    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    await waitFor(() => {
      expect(setThreadName).toHaveBeenCalledWith(
        "ws-1",
        "thread-child-title",
        "分支清理审查",
      );
    });
    expect(
      result.current.threadsByWorkspace["ws-1"]?.find(
        (thread) => thread.id === "thread-child-title",
      )?.name,
    ).toBe("分支清理审查");
  });

  it("keeps live subagent nickname and role in sidebar summaries from thread started", () => {
    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      handlers?.onThreadStarted?.("ws-1", {
        id: "thread-child-live-meta",
        preview: "Review helper",
        agent_nickname: "Atlas",
        agent_role: "reviewer",
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: "thread-parent-live",
              depth: 1,
            },
          },
        },
      });
    });

    expect(
      result.current.threadsByWorkspace["ws-1"]?.find(
        (thread) => thread.id === "thread-child-live-meta",
      ),
    ).toMatchObject({
      id: "thread-child-live-meta",
      isSubagent: true,
      subagentNickname: "Atlas",
      subagentRole: "reviewer",
    });
  });

  it("classifies live spawned threads from top-level parent thread metadata", () => {
    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      handlers?.onThreadStarted?.("ws-1", {
        id: "thread-child-live-flat-parent",
        preview: "Child live flat parent",
        parent_thread_id: "thread-parent-live-flat",
      });
    });

    expect(result.current.threadParentById["thread-child-live-flat-parent"]).toBe(
      "thread-parent-live-flat",
    );
    expect(result.current.isSubagentThread("ws-1", "thread-child-live-flat-parent")).toBe(
      true,
    );
  });

  it("classifies live spawned threads from collab tool events", () => {
    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      handlers?.onItemCompleted?.("ws-1", "thread-parent-live", {
        type: "collabToolCall",
        id: "item-collab-live",
        senderThreadId: "thread-parent-live",
        newThreadId: "thread-child-live-collab",
      });
    });

    expect(result.current.threadParentById["thread-child-live-collab"]).toBe(
      "thread-parent-live",
    );
    expect(result.current.isSubagentThread("ws-1", "thread-child-live-collab")).toBe(true);
  });

  it("generates a language-matched title from live subagent activity metadata", async () => {
    vi.mocked(generateRunMetadata).mockResolvedValue({
      title: "检查包名称",
      worktreeName: "chore/check-package-name",
    });
    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      handlers?.onThreadStarted?.("ws-1", {
        id: "thread-parent-live-title",
        name: "只读子会话验收",
      });
    });
    act(() => {
      handlers?.onItemCompleted?.("ws-1", "thread-parent-live-title", {
        type: "subAgentActivity",
        id: "item-subagent-activity",
        kind: "started",
        agentThreadId: "thread-child-live-title",
        agentPath: "/root/check_package_name",
      });
    });

    await waitFor(() => {
      expect(setThreadName).toHaveBeenCalledWith(
        "ws-1",
        "thread-child-live-title",
        "检查包名称",
      );
    });
    expect(result.current.threadParentById["thread-child-live-title"]).toBe(
      "thread-parent-live-title",
    );
    expect(
      result.current.threadsByWorkspace["ws-1"]?.find(
        (thread) => thread.id === "thread-child-live-title",
      )?.name,
    ).toBe("检查包名称");
  });

  it("classifies live spawned threads from spawn tool payloads with link hints", () => {
    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      handlers?.onItemCompleted?.("ws-1", "thread-parent-live", {
        type: "mcpToolCall",
        id: "item-spawn-link-hints",
        tool: "spawn_agent",
        sender_thread_id: "thread-parent-live",
        new_thread_id: "thread-child-live-spawn-hint",
      });
    });

    expect(result.current.threadParentById["thread-child-live-spawn-hint"]).toBe(
      "thread-parent-live",
    );
    expect(result.current.isSubagentThread("ws-1", "thread-child-live-spawn-hint")).toBe(
      true,
    );
  });

  it("classifies collab receivers from receiver_agents metadata", () => {
    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      handlers?.onItemCompleted?.("ws-1", "thread-parent-live", {
        type: "collabToolCall",
        id: "item-collab-receiver-agents",
        sender_thread_id: "thread-parent-live",
        receiver_agents: [
          {
            thread_id: "thread-child-live-agent-ref",
            agent_nickname: "Robie",
            agent_role: "explorer",
          },
        ],
      });
    });

    expect(result.current.threadParentById["thread-child-live-agent-ref"]).toBe(
      "thread-parent-live",
    );
    expect(result.current.isSubagentThread("ws-1", "thread-child-live-agent-ref")).toBe(
      true,
    );
  });

  it("enriches live collab spawn rows as soon as thread started metadata arrives", () => {
    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      handlers?.onThreadStarted?.("ws-1", {
        id: "thread-parent-live",
        preview: "Parent thread",
        updatedAt: 1_700_000_000_100,
      });
      result.current.setActiveThreadId("thread-parent-live");
    });

    act(() => {
      handlers?.onItemCompleted?.("ws-1", "thread-parent-live", {
        type: "collabAgentToolCall",
        id: "item-spawn-live",
        tool: "spawn_agent",
        status: "completed",
        sender_thread_id: "thread-parent-live",
        receiver_thread_ids: ["thread-child-live"],
        prompt: "Inspect the failing tests",
        agent_statuses: [
          {
            thread_id: "thread-child-live",
            status: "completed",
          },
        ],
      });
    });

    expect(result.current.activeItems).toContainEqual(
      expect.objectContaining({
        id: "item-spawn-live",
        kind: "tool",
        detail: "From thread-parent-live → thread-child-live",
        output: "Inspect the failing tests\n\nthread-child-live: completed",
      }),
    );

    act(() => {
      handlers?.onThreadStarted?.("ws-1", {
        id: "thread-child-live",
        preview: "Review helper",
        updatedAt: 1_700_000_000_200,
        agentNickname: "Atlas",
        agentRole: "reviewer",
        source: {
          subAgent: "thread_spawn",
        },
      });
    });

    expect(result.current.threadsByWorkspace["ws-1"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "thread-child-live",
          isSubagent: true,
          subagentNickname: "Atlas",
          subagentRole: "reviewer",
        }),
      ]),
    );

    expect(result.current.activeItems).toContainEqual(
      expect.objectContaining({
        id: "item-spawn-live",
        kind: "tool",
        detail: "From thread-parent-live → Atlas [reviewer]",
        output: "Inspect the failing tests\n\nAtlas [reviewer]: completed",
        collabReceiver: {
          threadId: "thread-child-live",
          nickname: "Atlas",
          role: "reviewer",
        },
      }),
    );
  });

  it("hydrates live collab spawn rows from thread/read when the event only has ids", async () => {
    vi.mocked(resumeThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-parent-read",
          preview: "Parent thread",
          updatedAt: 1_700_000_000_100,
          turns: [],
        },
      },
    });
    vi.mocked(readThread).mockResolvedValue({
      result: {
        thread: {
          id: "thread-child-read",
          preview: "Review helper",
          updatedAt: 1_700_000_000_300,
          agentNickname: "Atlas",
          agentRole: "reviewer",
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: "thread-parent-read",
                depth: 1,
              },
            },
          },
        },
      },
    });

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      handlers?.onThreadStarted?.("ws-1", {
        id: "thread-parent-read",
        preview: "Parent thread",
        updatedAt: 1_700_000_000_100,
      });
      result.current.setActiveThreadId("thread-parent-read");
    });

    act(() => {
      handlers?.onItemCompleted?.("ws-1", "thread-parent-read", {
        type: "collabAgentToolCall",
        id: "item-spawn-read",
        tool: "spawn_agent",
        status: "completed",
        sender_thread_id: "thread-parent-read",
        receiver_thread_ids: ["thread-child-read"],
        prompt: "Inspect the failing tests",
        agent_statuses: [
          {
            thread_id: "thread-child-read",
            status: "completed",
          },
        ],
      });
    });

    await waitFor(() => {
      expect(vi.mocked(readThread)).toHaveBeenCalledWith("ws-1", "thread-child-read");
    });

    await waitFor(() => {
      expect(result.current.threadsByWorkspace["ws-1"]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "thread-child-read",
            isSubagent: true,
            subagentNickname: "Atlas",
            subagentRole: "reviewer",
          }),
        ]),
      );
    });

    expect(result.current.activeItems).toContainEqual(
      expect.objectContaining({
        id: "item-spawn-read",
        kind: "tool",
        detail: "From thread-parent-read → Atlas [reviewer]",
        output: "Inspect the failing tests\n\nAtlas [reviewer]: completed",
        collabReceiver: {
          threadId: "thread-child-read",
          nickname: "Atlas",
          role: "reviewer",
        },
      }),
    );
  });

  it("cascades archive to subagent descendants when parent archived", async () => {
    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    act(() => {
      handlers?.onThreadStarted?.("ws-1", { id: "thread-parent", preview: "Parent" });
      handlers?.onThreadStarted?.("ws-1", {
        id: "thread-child",
        preview: "Child",
        source: {
          subAgent: {
            thread_spawn: { parent_thread_id: "thread-parent", depth: 1 },
          },
        },
      });
      handlers?.onThreadStarted?.("ws-1", {
        id: "thread-grandchild",
        preview: "Grandchild",
        source: {
          subAgent: {
            thread_spawn: { parent_thread_id: "thread-child", depth: 2 },
          },
        },
      });
    });

    expect(result.current.threadParentById["thread-child"]).toBe("thread-parent");
    expect(result.current.threadParentById["thread-grandchild"]).toBe("thread-child");
    expect(result.current.isSubagentThread("ws-1", "thread-child")).toBe(true);
    expect(result.current.isSubagentThread("ws-1", "thread-grandchild")).toBe(true);

    act(() => {
      handlers?.onThreadArchived?.("ws-1", "thread-parent");
    });

    await waitFor(() => {
      expect(vi.mocked(archiveThread)).toHaveBeenCalledWith("ws-1", "thread-child");
      expect(vi.mocked(archiveThread)).toHaveBeenCalledWith(
        "ws-1",
        "thread-grandchild",
      );
    });
    expect(vi.mocked(archiveThread)).not.toHaveBeenCalledWith("ws-1", "thread-parent");
    expect(vi.mocked(archiveThread)).toHaveBeenCalledTimes(2);

    vi.mocked(archiveThread).mockClear();

    act(() => {
      handlers?.onThreadArchived?.("ws-1", "thread-child");
    });

    expect(vi.mocked(archiveThread)).not.toHaveBeenCalled();
  });

  it("does not archive detached review children when parent archived", async () => {
    vi.mocked(startReview).mockResolvedValue({
      result: { reviewThreadId: "thread-review-1" },
    });

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
        reviewDeliveryMode: "detached",
      }),
    );

    act(() => {
      result.current.setActiveThreadId("thread-parent");
    });

    await act(async () => {
      await result.current.startReview("/review check this");
    });

    await waitFor(() => {
      expect(result.current.threadParentById["thread-review-1"]).toBe("thread-parent");
    });
    expect(result.current.isSubagentThread("ws-1", "thread-review-1")).toBe(false);

    act(() => {
      handlers?.onThreadStarted?.("ws-1", {
        id: "thread-child",
        preview: "Child",
        source: {
          subAgent: {
            thread_spawn: { parent_thread_id: "thread-parent", depth: 1 },
          },
        },
      });
    });

    vi.mocked(archiveThread).mockClear();

    act(() => {
      handlers?.onThreadArchived?.("ws-1", "thread-parent");
    });

    await waitFor(() => {
      expect(vi.mocked(archiveThread)).toHaveBeenCalledWith("ws-1", "thread-child");
    });
    expect(vi.mocked(archiveThread)).not.toHaveBeenCalledWith("ws-1", "thread-review-1");
  });

  it("archives subagent descendants spawned from detached review threads when parent archived", async () => {
    vi.mocked(startReview).mockResolvedValue({
      result: { reviewThreadId: "thread-review-1" },
    });

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
        reviewDeliveryMode: "detached",
      }),
    );

    act(() => {
      result.current.setActiveThreadId("thread-parent");
    });

    await act(async () => {
      await result.current.startReview("/review check this");
    });

    await waitFor(() => {
      expect(result.current.threadParentById["thread-review-1"]).toBe("thread-parent");
    });

    act(() => {
      handlers?.onThreadStarted?.("ws-1", {
        id: "thread-review-subagent",
        preview: "Review subagent",
        source: {
          subAgent: {
            thread_spawn: { parent_thread_id: "thread-review-1", depth: 1 },
          },
        },
      });
    });

    expect(result.current.isSubagentThread("ws-1", "thread-review-subagent")).toBe(true);
    expect(result.current.threadParentById["thread-review-subagent"]).toBe("thread-review-1");

    vi.mocked(archiveThread).mockClear();

    act(() => {
      handlers?.onThreadArchived?.("ws-1", "thread-parent");
    });

    await waitFor(() => {
      expect(vi.mocked(archiveThread)).toHaveBeenCalledWith(
        "ws-1",
        "thread-review-subagent",
      );
    });
    expect(vi.mocked(archiveThread)).not.toHaveBeenCalledWith("ws-1", "thread-review-1");
  });

  it("keeps parent unlocked and pings parent when detached child exits", async () => {
    vi.mocked(startReview).mockResolvedValue({
      result: { reviewThreadId: "thread-review-1" },
    });

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
        reviewDeliveryMode: "detached",
      }),
    );

    act(() => {
      result.current.setActiveThreadId("thread-parent");
    });

    await act(async () => {
      await result.current.startReview("/review check this");
    });

    expect(result.current.threadStatusById["thread-parent"]?.isReviewing).toBe(false);
    expect(result.current.threadStatusById["thread-parent"]?.isProcessing).toBe(false);
    expect(
      result.current.activeItems.some(
        (item) =>
          item.kind === "message" &&
          item.role === "assistant" &&
          item.text.includes("Detached review started.") &&
          item.text.includes("[Open review thread](/thread/thread-review-1)"),
      ),
    ).toBe(true);

    act(() => {
      handlers?.onItemCompleted?.("ws-1", "thread-review-1", {
        type: "exitedReviewMode",
        id: "review-exit-1",
      });
    });

    expect(result.current.threadStatusById["thread-parent"]?.isReviewing).toBe(false);
    expect(result.current.threadStatusById["thread-parent"]?.isProcessing).toBe(false);
    expect(
      result.current.activeItems.some(
        (item) =>
          item.kind === "message" &&
          item.role === "assistant" &&
          item.text.includes("Detached review completed.") &&
          item.text.includes("[Open review thread](/thread/thread-review-1)"),
      ),
    ).toBe(true);
  });

  it("preserves parent turn state when detached child exits", async () => {
    vi.mocked(startReview).mockResolvedValue({
      result: { reviewThreadId: "thread-review-1" },
    });

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
        reviewDeliveryMode: "detached",
      }),
    );

    act(() => {
      result.current.setActiveThreadId("thread-parent");
    });

    await act(async () => {
      await result.current.startReview("/review check this");
    });

    act(() => {
      handlers?.onTurnStarted?.("ws-1", "thread-parent", "turn-parent-1");
    });

    expect(result.current.threadStatusById["thread-parent"]?.isProcessing).toBe(true);
    expect(result.current.activeTurnIdByThread["thread-parent"]).toBe("turn-parent-1");

    act(() => {
      handlers?.onItemCompleted?.("ws-1", "thread-review-1", {
        type: "exitedReviewMode",
        id: "review-exit-1",
      });
    });

    expect(result.current.threadStatusById["thread-parent"]?.isProcessing).toBe(true);
    expect(result.current.activeTurnIdByThread["thread-parent"]).toBe("turn-parent-1");
    expect(
      result.current.activeItems.some(
        (item) =>
          item.kind === "message" &&
          item.role === "assistant" &&
          item.text.includes("Detached review completed.") &&
          item.text.includes("[Open review thread](/thread/thread-review-1)"),
      ),
    ).toBe(true);
  });

  it("does not stack detached completion messages when exit is emitted multiple times", async () => {
    vi.mocked(startReview).mockResolvedValue({
      result: { reviewThreadId: "thread-review-1" },
    });

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
        reviewDeliveryMode: "detached",
      }),
    );

    act(() => {
      result.current.setActiveThreadId("thread-parent");
    });

    await act(async () => {
      await result.current.startReview("/review check this");
    });

    act(() => {
      handlers?.onItemCompleted?.("ws-1", "thread-review-1", {
        type: "exitedReviewMode",
        id: "review-exit-1",
      });
      handlers?.onItemCompleted?.("ws-1", "thread-review-1", {
        type: "exitedReviewMode",
        id: "review-exit-1",
      });
    });

    const notices = result.current.activeItems.filter(
      (item) =>
        item.kind === "message" &&
        item.role === "assistant" &&
        item.text.includes("Detached review completed.") &&
        item.text.includes("[Open review thread](/thread/thread-review-1)"),
    );
    expect(notices).toHaveLength(1);
  });

  it("does not post detached completion notice for generic linked child reviews", () => {
    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
        reviewDeliveryMode: "detached",
      }),
    );

    act(() => {
      result.current.setActiveThreadId("thread-parent");
    });

    act(() => {
      handlers?.onItemCompleted?.("ws-1", "thread-parent", {
        type: "collabToolCall",
        id: "item-collab-link-1",
        senderThreadId: "thread-parent",
        newThreadId: "thread-linked-1",
      });
    });

    act(() => {
      handlers?.onItemCompleted?.("ws-1", "thread-linked-1", {
        type: "exitedReviewMode",
        id: "review-exit-linked-1",
      });
    });

    expect(
      result.current.activeItems.some(
        (item) =>
          item.kind === "message" &&
          item.role === "assistant" &&
          item.text.includes("[Open review thread](/thread/thread-linked-1)"),
      ),
    ).toBe(false);
  });

  it("restores detached review parent links after relaunch", async () => {
    vi.mocked(startReview).mockResolvedValue({
      result: { reviewThreadId: "thread-review-1" },
    });
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "thread-parent",
            preview: "Parent",
            updated_at: 10,
            cwd: workspace.path,
          },
          {
            id: "thread-review-1",
            preview: "Detached review",
            updated_at: 9,
            cwd: workspace.path,
          },
        ],
        nextCursor: null,
      },
    });

    const first = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
        reviewDeliveryMode: "detached",
      }),
    );

    act(() => {
      first.result.current.setActiveThreadId("thread-parent");
    });

    await act(async () => {
      await first.result.current.startReview("/review check this");
    });

    expect(first.result.current.threadParentById["thread-review-1"]).toBe("thread-parent");
    expect(localStorage.getItem(STORAGE_KEY_DETACHED_REVIEW_LINKS)).toContain(
      "thread-review-1",
    );

    first.unmount();

    const second = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    await act(async () => {
      await second.result.current.listThreadsForWorkspace(workspace);
    });

    await waitFor(() => {
      expect(second.result.current.threadParentById["thread-review-1"]).toBe(
        "thread-parent",
      );
    });
  });

  it("does not create a parent link for inline reviews", async () => {
    vi.mocked(startReview).mockResolvedValue({
      result: { reviewThreadId: "thread-parent" },
    });

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
        reviewDeliveryMode: "inline",
      }),
    );

    act(() => {
      result.current.setActiveThreadId("thread-parent");
    });

    await act(async () => {
      await result.current.startReview("/review check this");
    });

    await waitFor(() => {
      expect(vi.mocked(startReview)).toHaveBeenCalledWith(
        "ws-1",
        "thread-parent",
        expect.any(Object),
        "inline",
      );
    });

    expect(result.current.threadParentById["thread-parent"]).toBeUndefined();
    expect(localStorage.getItem(STORAGE_KEY_DETACHED_REVIEW_LINKS)).toBeNull();
  });

  it("orders thread lists, applies custom names, and keeps pin ordering stable", async () => {
    const listThreadsMock = vi.mocked(listThreads);
    listThreadsMock.mockResolvedValue({
      result: {
        data: [
          {
            id: "thread-a",
            preview: "Alpha",
            updated_at: 1000,
            cwd: workspace.path,
          },
          {
            id: "thread-b",
            preview: "Beta",
            updated_at: 3000,
            cwd: workspace.path,
          },
          {
            id: "thread-c",
            preview: "Gamma",
            updated_at: 2000,
            cwd: workspace.path,
          },
        ],
        nextCursor: null,
      },
    });

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    const { result: threadRowsResult } = renderHook(() =>
      useThreadRows(result.current.threadParentById),
    );

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    const initialOrder =
      result.current.threadsByWorkspace["ws-1"]?.map((thread) => thread.id) ?? [];
    expect(initialOrder).toEqual(["thread-b", "thread-c", "thread-a"]);

    act(() => {
      result.current.renameThread("ws-1", "thread-b", "Custom Beta");
    });
    expect(vi.mocked(setThreadName)).toHaveBeenCalledWith(
      "ws-1",
      "thread-b",
      "Custom Beta",
    );

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    const renamed = result.current.threadsByWorkspace["ws-1"]?.find(
      (thread) => thread.id === "thread-b",
    );
    expect(renamed?.name).toBe("Custom Beta");

    now = 5000;
    act(() => {
      result.current.pinThread("ws-1", "thread-c");
    });
    now = 6000;
    act(() => {
      result.current.pinThread("ws-1", "thread-a");
    });

    const { pinnedRows, unpinnedRows } = threadRowsResult.current.getThreadRows(
      result.current.threadsByWorkspace["ws-1"] ?? [],
      true,
      "ws-1",
      result.current.getPinTimestamp,
    );

    expect(pinnedRows.map((row) => row.thread.id)).toEqual([
      "thread-c",
      "thread-a",
    ]);
    expect(unpinnedRows.map((row) => row.thread.id)).toEqual(["thread-b"]);
  });

  it("keeps fallback-completed background threads ordered across stale list refreshes", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      result: {
        data: [
          {
            id: "thread-newer",
            preview: "Newer",
            updated_at: 1_700_000_003,
            cwd: workspace.path,
          },
          {
            id: "thread-running",
            preview: "Running",
            updated_at: 1_700_000_001,
            cwd: workspace.path,
          },
        ],
        nextCursor: null,
      },
    });

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });
    expect(result.current.threadsByWorkspace["ws-1"]?.map((thread) => thread.id)).toEqual([
      "thread-newer",
      "thread-running",
    ]);

    now = 1_700_000_010_000;
    act(() => {
      handlers?.onTurnStarted?.("ws-1", "thread-running", "turn-running");
    });
    await waitFor(() => {
      expect(result.current.threadStatusById["thread-running"]?.isProcessing).toBe(true);
    });

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });
    expect(result.current.threadsByWorkspace["ws-1"]?.map((thread) => thread.id)).toEqual([
      "thread-running",
      "thread-newer",
    ]);

    act(() => {
      handlers?.onThreadStatusChanged?.("ws-1", "thread-running", { type: "idle" });
    });
    await waitFor(() => {
      expect(result.current.threadStatusById["thread-running"]?.isProcessing).toBe(false);
    });

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });
    expect(result.current.threadsByWorkspace["ws-1"]?.map((thread) => thread.id)).toEqual([
      "thread-running",
      "thread-newer",
    ]);
    expect(result.current.threadsByWorkspace["ws-1"]?.[0]?.updatedAt).toBeGreaterThan(
      1_700_000_003_000,
    );
  });

  it("keeps parent rows anchored when refresh only returns subagent children", async () => {
    vi.mocked(listThreads)
      .mockResolvedValueOnce({
        result: {
          data: [
            {
              id: "thread-parent-anchor",
              preview: "Parent",
              updated_at: 2000,
              cwd: workspace.path,
            },
            {
              id: "thread-child-anchor",
              preview: "Child",
              updated_at: 3000,
              cwd: workspace.path,
              source: {
                subAgent: {
                  thread_spawn: {
                    parent_thread_id: "thread-parent-anchor",
                    depth: 1,
                  },
                },
              },
            },
          ],
          nextCursor: null,
        },
      })
      .mockResolvedValueOnce({
        result: {
          data: [
            {
              id: "thread-child-anchor",
              preview: "Child",
              updated_at: 3500,
              cwd: workspace.path,
              source: {
                subAgent: {
                  thread_spawn: {
                    parent_thread_id: "thread-parent-anchor",
                    depth: 1,
                  },
                },
              },
            },
          ],
          nextCursor: null,
        },
      });

    const { result } = renderHook(() =>
      useThreads({
        activeWorkspace: workspace,
        onWorkspaceConnected: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    await waitFor(() => {
      expect(result.current.threadParentById["thread-child-anchor"]).toBe(
        "thread-parent-anchor",
      );
    });

    await act(async () => {
      await result.current.listThreadsForWorkspace(workspace);
    });

    expect(vi.mocked(listThreads)).toHaveBeenCalledTimes(2);
    expect(result.current.threadsByWorkspace["ws-1"]?.map((thread) => thread.id)).toEqual(
      ["thread-child-anchor", "thread-parent-anchor"],
    );

    const { result: threadRowsResult } = renderHook(() =>
      useThreadRows(result.current.threadParentById),
    );
    const rows = threadRowsResult.current.getThreadRows(
      result.current.threadsByWorkspace["ws-1"] ?? [],
      true,
      "ws-1",
      () => null,
    );
    expect(rows.unpinnedRows.map((row) => [row.thread.id, row.depth])).toEqual([
      ["thread-parent-anchor", 0],
      ["thread-child-anchor", 1],
    ]);
  });
});
