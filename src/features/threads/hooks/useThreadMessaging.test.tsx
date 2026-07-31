/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/react";
import {
  promoteComposerImages,
  sendUserMessage as sendUserMessageService,
  steerTurn as steerTurnService,
  startReview as startReviewService,
  interruptTurn as interruptTurnService,
  getAppsList as getAppsListService,
  listMcpServerStatus as listMcpServerStatusService,
  compactThread as compactThreadService,
  createContentReference,
  readWorkspaceFile,
  rollbackThread as rollbackThreadService,
  workflowPreflightPreview as workflowPreflightPreviewService,
  computerControlPreflight as computerControlPreflightService,
} from "@services/tauri";
import type { SendMessageResult, WorkspaceInfo } from "@/types";
import { useThreadMessaging } from "./useThreadMessaging";

vi.mock("@sentry/react", () => ({
  metrics: {
    count: vi.fn(),
  },
}));

vi.mock("@services/tauri", () => ({
  promoteComposerImages: vi.fn(),
  sendUserMessage: vi.fn(),
  steerTurn: vi.fn(),
  startReview: vi.fn(),
  interruptTurn: vi.fn(),
  getAppsList: vi.fn(),
  listMcpServerStatus: vi.fn(),
  compactThread: vi.fn(),
  createContentReference: vi.fn(),
  readWorkspaceFile: vi.fn(),
  rollbackThread: vi.fn(),
  workflowPreflightPreview: vi.fn(),
  computerControlPreflight: vi.fn(),
}));

vi.mock("./useReviewPrompt", () => ({
  useReviewPrompt: () => ({
    reviewPrompt: null,
    openReviewPrompt: vi.fn(),
    closeReviewPrompt: vi.fn(),
    showPresetStep: vi.fn(),
    choosePreset: vi.fn(),
    highlightedPresetIndex: 0,
    setHighlightedPresetIndex: vi.fn(),
    highlightedBranchIndex: 0,
    setHighlightedBranchIndex: vi.fn(),
    highlightedCommitIndex: 0,
    setHighlightedCommitIndex: vi.fn(),
    handleReviewPromptKeyDown: vi.fn(() => false),
    confirmBranch: vi.fn(),
    selectBranch: vi.fn(),
    selectBranchAtIndex: vi.fn(),
    selectCommit: vi.fn(),
    selectCommitAtIndex: vi.fn(),
    confirmCommit: vi.fn(),
    updateCustomInstructions: vi.fn(),
    confirmCustom: vi.fn(),
  }),
}));

describe("useThreadMessaging telemetry", () => {
  const workspace: WorkspaceInfo = {
    id: "ws-1",
    name: "Workspace",
    path: "/tmp/workspace",
    connected: true,
    settings: {
      sidebarCollapsed: false,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(promoteComposerImages).mockImplementation(
      async (_workspaceId, _threadId, images) => images,
    );
    vi.mocked(sendUserMessageService).mockResolvedValue({
      result: {
        turn: { id: "turn-1" },
      },
    } as unknown as Awaited<ReturnType<typeof sendUserMessageService>>);
    vi.mocked(steerTurnService).mockResolvedValue(
      {
        result: {
          turnId: "turn-1",
        },
      } as unknown as Awaited<ReturnType<typeof steerTurnService>>,
    );
    vi.mocked(startReviewService).mockResolvedValue(
      {} as Awaited<ReturnType<typeof startReviewService>>,
    );
    vi.mocked(interruptTurnService).mockResolvedValue(
      {} as Awaited<ReturnType<typeof interruptTurnService>>,
    );
    vi.mocked(getAppsListService).mockResolvedValue(
      {} as Awaited<ReturnType<typeof getAppsListService>>,
    );
    vi.mocked(listMcpServerStatusService).mockResolvedValue(
      {} as Awaited<ReturnType<typeof listMcpServerStatusService>>,
    );
    vi.mocked(compactThreadService).mockResolvedValue(
      {} as Awaited<ReturnType<typeof compactThreadService>>,
    );
    vi.mocked(createContentReference).mockResolvedValue({
      referenceId: "content-ref-1",
      path: "C:/Codex/references/content-ref-1/content.md",
      characterCount: 9_000,
      estimatedTokens: 2_250,
    });
    vi.mocked(rollbackThreadService).mockResolvedValue({});
    vi.mocked(workflowPreflightPreviewService).mockResolvedValue({
      mode: "active",
      providerKind: "opencode",
      model: "minimax-m3",
      taskLength: 5,
      rules: [{ path: "/tmp/workspace/AGENTS.md", kind: "AGENTS.md", scope: "workspace" }],
      knowledgeCandidates: [
        { path: "D:/DevKnowledgeBase/project.md", title: "Project", score: 8, matchedTerms: ["hello"] },
      ],
      impacts: [],
      impactSummary: "capability-runtime",
      validationSuggestions: ["npm run test"],
      sourceErrors: [],
      knowledgeCacheHit: true,
      contextFragments: [
        { sourceId: "cm.rule.0", kind: "application", value: "project rules" },
        {
          sourceId: "cm.workflow.completion",
          kind: "application",
          value: "run focused validation and review the task-owned changed diff",
        },
        {
          sourceId: "cm.computer-control",
          kind: "application",
          value: "untrusted workflow collision",
        },
      ],
      completionPlan: {
        required: true,
        phase: "focused_validation",
        validations: [{
          id: "validation-1",
          kind: "command",
          instruction: "npm run typecheck",
          status: "pending",
          sourceAreas: ["project-baseline"],
        }],
        changedDiffReview: {
          required: true,
          status: "pending",
          scope: "task-owned-changed-diff",
        },
        knowledgeCapture: {
          status: "evaluate",
          category: "checkpoint",
          reason: "validated reusable conclusions only",
          submissionMode: "candidate-only-concurrency-safe",
        },
      },
    });
    vi.mocked(readWorkspaceFile).mockResolvedValue({
      content: "file body",
      truncated: false,
    });
  });

  it("records prompt_sent once for one message send", async () => {
    vi.mocked(computerControlPreflightService).mockResolvedValueOnce({
      schemaVersion: 1,
      decisionId: "cmcc-reserved-context",
      taskKind: "native_windows",
      primaryBackend: "windows_ui",
      availability: "ready",
      enforcement: "hard",
      reasonCodes: ["native_windows_task", "backend_ready"],
      executionHost: "local",
      snapshotAgeMs: 0,
      contextFragment:
        '{"decisionId":"cmcc-reserved-context","primaryBackend":"windows_ui"}',
    });
    const ensureWorkspaceRuntimeCodexArgs = vi.fn(async () => undefined);
    const ensureThreadRuntimeForWorkspace = vi.fn(
      async () => "thread-1",
    );
    const onDebug = vi.fn();
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: "minimax-m3",
        workflowProviderKind: "opencode",
        workflowRuntimeMode: "active",
        workflowSkills: [
          {
            name: "public-check",
            path: "/skills/public-check",
            triggerKeywords: ["hello"],
            instructions: "Run the public check.",
          },
        ],
        getWorkflowGateId: vi.fn(() => "wf-thread-1"),
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: false,
        customPrompts: [],
        ensureWorkspaceRuntimeCodexArgs,
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch: vi.fn(),
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug,
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadRuntimeForWorkspace,
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.sendUserMessageToThread(
        workspace,
        "thread-1",
        "hello",
        [],
      );
    });

    expect(Sentry.metrics.count).toHaveBeenCalledTimes(1);
    expect(Sentry.metrics.count).toHaveBeenCalledWith(
      "prompt_sent",
      1,
      expect.objectContaining({
        attributes: expect.objectContaining({
          workspace_id: "ws-1",
          thread_id: "thread-1",
          has_images: "false",
          text_length: "5",
        }),
      }),
    );
    expect(ensureWorkspaceRuntimeCodexArgs).toHaveBeenCalledTimes(1);
    expect(ensureWorkspaceRuntimeCodexArgs).toHaveBeenCalledWith("ws-1", "thread-1");
    expect(ensureThreadRuntimeForWorkspace).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
    );
    expect(
      ensureWorkspaceRuntimeCodexArgs.mock.invocationCallOrder[0],
    ).toBeLessThan(ensureThreadRuntimeForWorkspace.mock.invocationCallOrder[0]);
    expect(
      ensureThreadRuntimeForWorkspace.mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(sendUserMessageService).mock.invocationCallOrder[0]);
    expect(onDebug).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "workflow/preflight",
        payload: expect.objectContaining({
          mode: "active",
          providerKind: "opencode",
          model: "minimax-m3",
          triggerSummary: "public-check",
          triggeredSkills: [
            expect.objectContaining({
              skillName: "public-check",
              scope: "public",
              compatibility: "compatible",
            }),
          ],
        }),
      }),
    );
    expect(workflowPreflightPreviewService).toHaveBeenCalledWith(
      "ws-1",
      "hello",
      "opencode",
      "minimax-m3",
      "active",
      "wf-thread-1",
    );
    const hostDebugEntry = onDebug.mock.calls
      .map(([entry]) => entry)
      .find((entry) => entry.label === "workflow/host preflight");
    expect(hostDebugEntry).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          knowledgePaths: ["D:/DevKnowledgeBase/project.md"],
          impactSummary: "capability-runtime",
          knowledgeCacheHit: true,
          completionPlan: expect.objectContaining({
            required: true,
            phase: "focused_validation",
            changedDiffReview: expect.objectContaining({ status: "pending" }),
            knowledgeCapture: expect.objectContaining({ status: "evaluate" }),
          }),
        }),
      }),
    );
    expect(JSON.stringify(hostDebugEntry?.payload)).not.toContain("hello");
    expect(sendUserMessageService).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      "hello",
      expect.objectContaining({
        additionalContext: expect.objectContaining({
          "cm.rule.0": { kind: "application", value: "project rules" },
          "cm.workflow.completion": expect.objectContaining({
            kind: "application",
            value: expect.stringContaining("task-owned changed diff"),
          }),
          "cm.computer-control": {
            kind: "application",
            value: expect.stringContaining("windows_ui"),
          },
          "cm.skill.0": expect.objectContaining({
            kind: "application",
            value: expect.stringContaining("public-check"),
          }),
        }),
      }),
    );
  });

  it("runs shadow preflight without applying workflow context", async () => {
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: "minimax-m3",
        workflowProviderKind: "opencode",
        workflowRuntimeMode: "shadow",
        workflowSkills: [{
          name: "public-check",
          path: "/skills/public-check",
          triggerKeywords: ["hello"],
          instructions: "Run the public check.",
        }],
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: false,
        customPrompts: [],
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch: vi.fn(),
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.sendUserMessageToThread(workspace, "thread-1", "hello", []);
    });

    expect(workflowPreflightPreviewService).toHaveBeenCalledWith(
      "ws-1",
      "hello",
      "opencode",
      "minimax-m3",
      "shadow",
      null,
    );
    expect(sendUserMessageService).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      "hello",
      expect.objectContaining({
        additionalContext: {
          "cm.plan-consistency": {
            kind: "application",
            value: expect.stringContaining("final plan update"),
          },
        },
      }),
    );
  });

  it("applies computer-control context even when workflow runtime mode is off", async () => {
    vi.mocked(computerControlPreflightService).mockResolvedValueOnce({
      schemaVersion: 1,
      decisionId: "cmcc-native",
      taskKind: "native_windows",
      primaryBackend: "windows_ui",
      availability: "ready",
      enforcement: "hard",
      reasonCodes: ["native_windows_task", "backend_ready"],
      executionHost: "local",
      snapshotAgeMs: 0,
      contextFragment: '{"decisionId":"cmcc-native","primaryBackend":"windows_ui"}',
    });
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        workflowRuntimeMode: "off",
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: false,
        customPrompts: [],
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch: vi.fn(),
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.sendUserMessageToThread(workspace, "thread-1", "hello", []);
    });

    expect(workflowPreflightPreviewService).not.toHaveBeenCalled();
    expect(computerControlPreflightService).toHaveBeenCalledWith(
      "ws-1",
      "hello",
      expect.stringMatching(/^cmcc-/),
    );
    expect(sendUserMessageService).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      "hello",
      expect.objectContaining({
        additionalContext: {
          "cm.plan-consistency": {
            kind: "application",
            value: expect.stringContaining("final plan update"),
          },
          "cm.computer-control": {
            kind: "application",
            value: expect.stringContaining("windows_ui"),
          },
        },
      }),
    );
  });

  it("does not block sending when host workflow preflight fails", async () => {
    vi.mocked(workflowPreflightPreviewService).mockRejectedValueOnce(
      new Error("preflight unavailable"),
    );
    vi.mocked(computerControlPreflightService).mockRejectedValueOnce(
      new Error("unknown command: computer_control_preflight"),
    );
    const onDebug = vi.fn();
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: false,
        customPrompts: [],
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch: vi.fn(),
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug,
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    await act(async () => {
      await expect(
        result.current.sendUserMessageToThread(workspace, "thread-1", "hello", []),
      ).resolves.toEqual({ status: "sent" });
    });

    expect(sendUserMessageService).toHaveBeenCalledTimes(1);
    expect(onDebug).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "workflow/host preflight error",
        payload: "preflight unavailable",
      }),
    );
    expect(onDebug).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "computer-control/preflight error",
        payload: "unknown command: computer_control_preflight",
      }),
    );
  });

  it("shows draft images before promotion and updates them before sending", async () => {
    const dispatch = vi.fn();
    let resolvePromotion: (images: string[]) => void = () => {};
    vi.mocked(promoteComposerImages).mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePromotion = resolve;
      }),
    );
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: false,
        customPrompts: [],
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch,
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    let sendPromise!: Promise<SendMessageResult>;
    act(() => {
      sendPromise = result.current.sendUserMessageToThread(
        workspace,
        "thread-1",
        "image",
        ["/home/.codex/codex-monitor/attachments/pending/draft/image.png"],
      );
    });
    vi.mocked(computerControlPreflightService).mockResolvedValue({
      schemaVersion: 1,
      decisionId: "cmcc-test",
      taskKind: "direct",
      primaryBackend: "direct",
      availability: "ready",
      enforcement: "hard",
      reasonCodes: ["direct_task", "backend_ready"],
      executionHost: "local",
      snapshotAgeMs: 0,
    });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "upsertItem",
        item: expect.objectContaining({
          images: [
            "/home/.codex/codex-monitor/attachments/pending/draft/image.png",
          ],
        }),
      }),
    );
    expect(sendUserMessageService).not.toHaveBeenCalled();

    resolvePromotion([
      "/home/.codex/codex-monitor/attachments/sessions/thread/image.png",
    ]);
    await act(async () => {
      await sendPromise;
    });

    expect(promoteComposerImages).toHaveBeenCalledWith("ws-1", "thread-1", [
      "/home/.codex/codex-monitor/attachments/pending/draft/image.png",
    ]);
    expect(sendUserMessageService).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      "image",
      expect.objectContaining({
        images: [
          "/home/.codex/codex-monitor/attachments/sessions/thread/image.png",
        ],
      }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "upsertItem",
        item: expect.objectContaining({
          images: [
            "/home/.codex/codex-monitor/attachments/sessions/thread/image.png",
          ],
        }),
      }),
    );
  });

  it("notifies title autogeneration when a new user message starts a turn", async () => {
    const onUserMessageCreated = vi.fn();
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: false,
        customPrompts: [],
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch: vi.fn(),
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
        onUserMessageCreated,
      }),
    );

    await act(async () => {
      await result.current.sendUserMessage("hello title");
    });

    expect(onUserMessageCreated).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      "hello title",
    );
  });

  it("does not synthesize context compaction before normal sends", async () => {
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: false,
        customPrompts: [],
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch: vi.fn(),
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    await act(async () => {
      const sendResult = await result.current.sendUserMessageToThread(
        workspace,
        "thread-1",
        "hello",
        [],
      );
      expect(sendResult).toEqual({ status: "sent" });
    });

    expect(compactThreadService).not.toHaveBeenCalled();
    expect(sendUserMessageService).toHaveBeenCalledTimes(1);
  });

  it("optimistically inserts the user message before turn/start resolves", async () => {
    let resolveSend: (value: Awaited<ReturnType<typeof sendUserMessageService>>) => void =
      () => {};
    vi.mocked(sendUserMessageService).mockReturnValue(
      new Promise((resolve) => {
        resolveSend = resolve;
      }) as ReturnType<typeof sendUserMessageService>,
    );
    const dispatch = vi.fn();
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: false,
        customPrompts: [],
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch,
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    let sendPromise!: Promise<SendMessageResult>;
    act(() => {
      sendPromise = result.current.sendUserMessageToThread(
        workspace,
        "thread-1",
        "show immediately",
        [],
      );
    });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "upsertItem",
        workspaceId: "ws-1",
        threadId: "thread-1",
        item: expect.objectContaining({
          kind: "message",
          role: "user",
          text: "show immediately",
        }),
      }),
    );

    resolveSend({
      result: {
        turn: { id: "turn-1" },
      },
    } as Awaited<ReturnType<typeof sendUserMessageService>>);
    await act(async () => {
      await sendPromise;
    });
  });

  it("reuses the computer-control decision id when steering the same active turn", async () => {
    const useMessaging = (active: boolean) =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        workflowRuntimeMode: "off",
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: true,
        customPrompts: [],
        threadStatusById: active
          ? {
            "thread-1": {
              isProcessing: true,
              hasUnread: false,
              isReviewing: false,
              processingStartedAt: 1,
              lastDurationMs: null,
            },
          }
          : {},
        activeTurnIdByThread: active ? { "thread-1": "turn-1" } : {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch: vi.fn(),
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      });
    const { result, rerender } = renderHook(
      ({ active }) => useMessaging(active),
      { initialProps: { active: false } },
    );

    await act(async () => {
      await result.current.sendUserMessageToThread(workspace, "thread-1", "first", []);
    });
    rerender({ active: true });
    await act(async () => {
      await result.current.sendUserMessageToThread(workspace, "thread-1", "follow up", []);
    });

    const decisionIds = vi
      .mocked(computerControlPreflightService)
      .mock.calls.map((call) => call[2]);
    expect(decisionIds).toHaveLength(2);
    expect(decisionIds[1]).toBe(decisionIds[0]);
    expect(steerTurnService).toHaveBeenCalledTimes(1);
  });

  it("exposes a pending turn start immediately while runtime preparation is unresolved", async () => {
    let resolveRuntimePreflight: () => void = () => {};
    const ensureWorkspaceRuntimeCodexArgs = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRuntimePreflight = resolve;
        }),
    );
    const markProcessing = vi.fn();
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: false,
        customPrompts: [],
        ensureWorkspaceRuntimeCodexArgs,
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch: vi.fn(),
        getCustomName: vi.fn(() => undefined),
        markProcessing,
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    let sendPromise!: Promise<SendMessageResult>;
    act(() => {
      sendPromise = result.current.sendUserMessage("show working immediately");
    });

    const pendingStartedAt =
      result.current.pendingTurnStartByThread["thread-1"]?.startedAt;
    expect(result.current.pendingTurnStartByThread["thread-1"]).toEqual(
      expect.objectContaining({ startedAt: expect.any(Number) }),
    );
    expect(markProcessing).not.toHaveBeenCalled();
    expect(sendUserMessageService).not.toHaveBeenCalled();

    resolveRuntimePreflight();
    await act(async () => {
      await sendPromise;
    });

    expect(markProcessing).toHaveBeenCalledWith(
      "thread-1",
      true,
      pendingStartedAt,
    );
    expect(result.current.pendingTurnStartByThread["thread-1"]).toBeUndefined();
  });

  it("optimistically inserts the active-thread message before resume resolves", async () => {
    let resolveThread: (threadId: string | null) => void = () => {};
    const ensureThreadForActiveWorkspace = vi.fn(
      () => new Promise<string | null>((resolve) => {
        resolveThread = resolve;
      }),
    );
    const dispatch = vi.fn();
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: false,
        customPrompts: [],
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch,
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace,
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    let sendPromise!: Promise<SendMessageResult>;
    act(() => {
      sendPromise = result.current.sendUserMessage("show before resume");
    });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "upsertItem",
        workspaceId: "ws-1",
        threadId: "thread-1",
        item: expect.objectContaining({
          kind: "message",
          role: "user",
          text: "show before resume",
        }),
      }),
    );
    expect(sendUserMessageService).not.toHaveBeenCalled();

    resolveThread("thread-1");
    await act(async () => {
      await sendPromise;
    });

    const upserts = dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === "upsertItem");
    expect(upserts).toHaveLength(2);
    expect(upserts[1]).toEqual(
      expect.objectContaining({
        item: expect.objectContaining({ id: upserts[0]?.item.id }),
      }),
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "setItemTurnId",
      threadId: "thread-1",
      itemId: upserts[0]?.item.id,
      turnId: "turn-1",
    });
  });

  it("removes the optimistic active-thread message when resume is blocked", async () => {
    const dispatch = vi.fn();
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: false,
        customPrompts: [],
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch,
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace: vi.fn(async () => null),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    let sendResult;
    await act(async () => {
      sendResult = await result.current.sendUserMessage("blocked resume");
    });

    const optimisticAction = dispatch.mock.calls
      .map(([action]) => action)
      .find((action) => action.type === "upsertItem");
    expect(sendResult).toEqual({ status: "blocked" });
    expect(optimisticAction).toBeDefined();
    expect(dispatch).toHaveBeenCalledWith({
      type: "removeItem",
      threadId: "thread-1",
      itemId: optimisticAction?.item.id,
    });
    expect(sendUserMessageService).not.toHaveBeenCalled();
  });

  it("removes the optimistic active-thread message when resume rejects", async () => {
    const dispatch = vi.fn();
    const resumeError = new Error("resume failed");
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: false,
        customPrompts: [],
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch,
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace: vi.fn(async () => {
          throw resumeError;
        }),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    let caughtError: unknown;
    await act(async () => {
      try {
        await result.current.sendUserMessage("failed resume");
      } catch (error) {
        caughtError = error;
      }
    });

    const optimisticAction = dispatch.mock.calls
      .map(([action]) => action)
      .find((action) => action.type === "upsertItem");
    expect(caughtError).toBe(resumeError);
    expect(optimisticAction).toBeDefined();
    expect(dispatch).toHaveBeenCalledWith({
      type: "removeItem",
      threadId: "thread-1",
      itemId: optimisticAction?.item.id,
    });
    expect(sendUserMessageService).not.toHaveBeenCalled();
  });

  it("does not insert an optimistic message before runtime preflight succeeds", async () => {
    const dispatch = vi.fn();
    const ensureWorkspaceRuntimeCodexArgs = vi.fn(async () => {
      throw new Error(
        "Cannot restart the Codex runtime while another thread is processing.",
      );
    });
    const pushThreadErrorMessage = vi.fn();
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: false,
        customPrompts: [],
        ensureWorkspaceRuntimeCodexArgs,
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch,
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage,
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    let sendResult;
    await act(async () => {
      sendResult = await result.current.sendUserMessage("继续");
    });

    expect(sendResult).toEqual({ status: "blocked" });
    expect(ensureWorkspaceRuntimeCodexArgs).toHaveBeenCalledWith("ws-1", "thread-1");
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "upsertItem" }),
    );
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "removeItem" }),
    );
    expect(pushThreadErrorMessage).toHaveBeenCalledWith(
      "thread-1",
      "Cannot restart the Codex runtime while another thread is processing.",
    );
    expect(result.current.pendingTurnStartByThread["thread-1"]).toBeUndefined();
    expect(sendUserMessageService).not.toHaveBeenCalled();
  });

  it("resumes the thread runtime and retries turn/start once when the thread is missing", async () => {
    vi.mocked(sendUserMessageService)
      .mockResolvedValueOnce({
        error: {
          code: -32600,
          message: "thread not found: eb8cbfc2-1a24-4f91-a29d-058915de4192",
        },
      } as Awaited<ReturnType<typeof sendUserMessageService>>)
      .mockResolvedValueOnce({
        result: { turn: { id: "turn-recovered" } },
      } as Awaited<ReturnType<typeof sendUserMessageService>>);
    const dispatch = vi.fn();
    const pushThreadErrorMessage = vi.fn();
    const ensureThreadRuntimeForWorkspace = vi.fn(async () => "thread-1");
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: false,
        customPrompts: [],
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch,
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage,
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadRuntimeForWorkspace,
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    let sendResult;
    await act(async () => {
      sendResult = await result.current.sendUserMessage("继续");
    });

    const optimisticAction = dispatch.mock.calls
      .map(([action]) => action)
      .find((action) => action.type === "upsertItem");
    expect(sendResult).toEqual({ status: "sent" });
    expect(rollbackThreadService).not.toHaveBeenCalled();
    expect(sendUserMessageService).toHaveBeenCalledTimes(2);
    expect(ensureThreadRuntimeForWorkspace).toHaveBeenNthCalledWith(
      1,
      "ws-1",
      "thread-1",
    );
    expect(ensureThreadRuntimeForWorkspace).toHaveBeenNthCalledWith(
      2,
      "ws-1",
      "thread-1",
      true,
    );
    expect(pushThreadErrorMessage).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: "setItemTurnId",
      threadId: "thread-1",
      itemId: optimisticAction?.item.id,
      turnId: "turn-recovered",
    });
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "removeItem",
        threadId: "thread-1",
        itemId: optimisticAction?.item.id,
      }),
    );
  });

  it("reuses the original message id when resending an edited message", async () => {
    const dispatch = vi.fn();
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: false,
        customPrompts: [],
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch,
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.sendUserMessage("edited text", [], [], {
        replaceMessageId: "msg-edit-user-1",
      });
    });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "upsertItem",
        item: expect.objectContaining({
          id: "msg-edit-user-1",
          text: "edited text",
        }),
        replaceExisting: true,
      }),
    );
  });

  it("rolls back and refreshes before retrying an edited failed message", async () => {
    const callOrder: string[] = [];
    vi.mocked(rollbackThreadService).mockImplementation(async () => {
      callOrder.push("rollback");
      return {};
    });
    vi.mocked(sendUserMessageService).mockImplementation(async () => {
      callOrder.push("send");
      return { result: { turn: { id: "turn-retry" } } } as Awaited<
        ReturnType<typeof sendUserMessageService>
      >;
    });
    const dispatch = vi.fn();
    const refreshThread = vi.fn(async () => {
      callOrder.push("refresh");
      return "thread-1";
    });
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: false,
        customPrompts: [],
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch,
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread,
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.retryEditedUserMessage("edited retry", [], {
        replaceMessageId: "msg-failed-user",
      });
    });

    expect(rollbackThreadService).toHaveBeenCalledWith("ws-1", "thread-1", 1);
    expect(callOrder).toEqual(["rollback", "refresh", "send"]);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "upsertItem",
        item: expect.objectContaining({ id: "msg-failed-user", text: "edited retry" }),
        replaceExisting: true,
      }),
    );
  });

  it("does not resend when rollback fails", async () => {
    vi.mocked(rollbackThreadService).mockRejectedValue(new Error("rollback unavailable"));
    const pushThreadErrorMessage = vi.fn();
    const refreshThread = vi.fn(async () => "thread-1");
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: false,
        customPrompts: [],
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch: vi.fn(),
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage,
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread,
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.retryEditedUserMessage("edited retry");
    });

    expect(refreshThread).not.toHaveBeenCalled();
    expect(sendUserMessageService).not.toHaveBeenCalled();
    expect(pushThreadErrorMessage).toHaveBeenCalledWith(
      "thread-1",
      "Failed to retry edited message: rollback unavailable",
    );
  });

  it("optimistically inserts steer messages while a turn is processing", async () => {
    let resolveSteer: (value: Awaited<ReturnType<typeof steerTurnService>>) => void =
      () => {};
    vi.mocked(steerTurnService).mockReturnValue(
      new Promise((resolve) => {
        resolveSteer = resolve;
      }) as ReturnType<typeof steerTurnService>,
    );
    const dispatch = vi.fn();
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: true,
        customPrompts: [],
        threadStatusById: {
          "thread-1": {
            isProcessing: true,
            isReviewing: false,
            hasUnread: false,
            processingStartedAt: null,
            lastDurationMs: null,
          },
        },
        activeTurnIdByThread: { "thread-1": "turn-active" },
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch,
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    const sendPromise = result.current.sendUserMessageToThread(
      workspace,
      "thread-1",
      "guide while running",
      [],
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "upsertItem",
        workspaceId: "ws-1",
        threadId: "thread-1",
        item: expect.objectContaining({
          kind: "message",
          role: "user",
          text: "guide while running",
        }),
      }),
    );

    resolveSteer({
      result: {
        turnId: "turn-active",
      },
    } as Awaited<ReturnType<typeof steerTurnService>>);
    await act(async () => {
      await sendPromise;
    });
  });

  it("forwards explicit app mentions to turn/start", async () => {
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: false,
        customPrompts: [],
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch: vi.fn(),
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.sendUserMessage("hello $calendar", [], [
        { name: "Calendar App", path: "app://connector_calendar" },
      ]);
    });

    expect(sendUserMessageService).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      "hello $calendar",
      expect.objectContaining({
        appMentions: [{ name: "Calendar App", path: "app://connector_calendar" }],
      }),
    );
  });

  it("forwards the selected service tier to turn/start", async () => {
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        serviceTier: "fast",
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: false,
        customPrompts: [],
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch: vi.fn(),
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.sendUserMessage("hello");
    });

    expect(sendUserMessageService).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      "hello",
      expect.objectContaining({
        serviceTier: "fast",
      }),
    );
  });

  it("omits service tier when no override is selected", async () => {
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        serviceTier: undefined,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: false,
        customPrompts: [],
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch: vi.fn(),
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.sendUserMessage("hello");
    });

    expect(sendUserMessageService).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      "hello",
      expect.not.objectContaining({
        serviceTier: expect.anything(),
      }),
    );
  });

  it("does not forward service tier to review/start", async () => {
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        serviceTier: "fast",
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: false,
        customPrompts: [],
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch: vi.fn(),
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.startUncommittedReview();
    });

    expect(startReviewService).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      { type: "uncommittedChanges" },
      "inline",
    );
  });

  it("toggles fast mode through the built-in handler", async () => {
    const dispatch = vi.fn();
    const onSelectServiceTier = vi.fn();
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        serviceTier: null,
        collaborationMode: null,
        onSelectServiceTier,
        reviewDeliveryMode: "inline",
        steerEnabled: false,
        customPrompts: [],
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch,
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.startFast("/fast on");
    });

    expect(onSelectServiceTier).toHaveBeenCalledWith("fast");
    expect(dispatch).toHaveBeenCalledWith({
      type: "addAssistantMessage",
      threadId: "thread-1",
      text: "Fast mode enabled.",
    });
  });

  it("uses turn/steer when steer mode is enabled and an active turn is present", async () => {
    const dispatch = vi.fn();
    const ensureWorkspaceRuntimeCodexArgs = vi.fn(async () => undefined);
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: true,
        customPrompts: [],
        ensureWorkspaceRuntimeCodexArgs,
        workflowRuntimeMode: "active",
        threadStatusById: {
          "thread-1": {
            isProcessing: true,
            isReviewing: false,
            hasUnread: false,
            processingStartedAt: 0,
            lastDurationMs: null,
          },
        },
        activeTurnIdByThread: {
          "thread-1": "turn-1",
        },
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch,
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.sendUserMessageToThread(
        workspace,
        "thread-1",
        "steer this",
        [],
      );
    });

    expect(steerTurnService).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      "turn-1",
      "steer this",
      [],
      [],
      expect.objectContaining({
        "cm.rule.0": { kind: "application", value: "project rules" },
      }),
    );
    expect(sendUserMessageService).not.toHaveBeenCalled();
    expect(ensureWorkspaceRuntimeCodexArgs).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "upsertItem",
        item: expect.objectContaining({
          kind: "message",
          role: "user",
          text: "steer this",
        }),
      }),
    );
  });

  it("resets stale processing state when turn/steer reports no active turn", async () => {
    const pushThreadErrorMessage = vi.fn();
    const markProcessing = vi.fn();
    const setActiveTurnId = vi.fn();
    const dispatch = vi.fn();
    vi.mocked(steerTurnService).mockResolvedValueOnce({
      error: { message: "no active turn to steer" },
    } as unknown as Awaited<ReturnType<typeof steerTurnService>>);

    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: true,
        customPrompts: [],
        threadStatusById: {
          "thread-1": {
            isProcessing: true,
            isReviewing: false,
            hasUnread: false,
            processingStartedAt: 0,
            lastDurationMs: null,
          },
        },
        activeTurnIdByThread: {
          "thread-1": "turn-1",
        },
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch,
        getCustomName: vi.fn(() => undefined),
        markProcessing,
        markReviewing: vi.fn(),
        setActiveTurnId,
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage,
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    await act(async () => {
      const sendResult = await result.current.sendUserMessageToThread(
        workspace,
        "thread-1",
        "steer should fail",
        [],
      );
      expect(sendResult).toEqual({ status: "steer_failed" });
    });

    expect(steerTurnService).toHaveBeenCalledTimes(1);
    expect(sendUserMessageService).not.toHaveBeenCalled();
    expect(markProcessing).toHaveBeenCalledWith(
      "thread-1",
      true,
      expect.any(Number),
    );
    expect(markProcessing).toHaveBeenCalledWith("thread-1", false);
    expect(setActiveTurnId).toHaveBeenCalledWith("thread-1", null);
    expect(pushThreadErrorMessage).toHaveBeenCalledWith(
      "thread-1",
      "Turn steer failed: no active turn to steer",
    );
    const optimisticMessage = vi.mocked(dispatch).mock.calls.find(
      ([action]) => action.type === "upsertItem",
    )?.[0];
    expect(optimisticMessage).toEqual(
      expect.objectContaining({
        item: expect.objectContaining({ id: expect.stringMatching(/^local-user-/) }),
      }),
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "removeItem",
      threadId: "thread-1",
      itemId: optimisticMessage?.item.id,
    });
  });

  it("inlines UTF-8 workspace text attachments before sending", async () => {
    const dispatch = vi.fn();
    vi.mocked(readWorkspaceFile).mockResolvedValueOnce({
      content: "# Notes\nhello",
      truncated: false,
    });
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: false,
        customPrompts: [],
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch,
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.sendUserMessageToThread(
        workspace,
        "thread-1",
        "please read",
        ["/tmp/workspace/docs/notes.md"],
      );
    });

    expect(readWorkspaceFile).toHaveBeenCalledWith("ws-1", "docs/notes.md");
    expect(sendUserMessageService).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      expect.stringContaining('<attached_file path="docs/notes.md" name="notes.md">'),
      expect.objectContaining({ images: [] }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "upsertItem",
        item: expect.objectContaining({
          text: "please read",
          attachments: ["/tmp/workspace/docs/notes.md"],
        }),
      }),
    );
  });

  it("inlines UTF-8 TSV workspace text attachments before sending", async () => {
    const dispatch = vi.fn();
    const tsvContent = [
      "20260731004453694\treplace\t过窄\tglfh\t+",
      "20260731004453694\tmove\t国债\tglfhi\t-",
      "20260731004453694\tdelete\t国债\tglfh\t!",
    ].join("\n");
    vi.mocked(readWorkspaceFile).mockResolvedValueOnce({
      content: tsvContent,
      truncated: false,
    });
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: false,
        customPrompts: [],
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch,
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.sendUserMessageToThread(
        workspace,
        "thread-1",
        "please inspect ops",
        ["/tmp/workspace/zzc_state/runtime_ops.tsv"],
      );
    });

    expect(readWorkspaceFile).toHaveBeenCalledWith(
      "ws-1",
      "zzc_state/runtime_ops.tsv",
    );
    expect(sendUserMessageService).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      expect.stringContaining(
        '<attached_file path="zzc_state/runtime_ops.tsv" name="runtime_ops.tsv">',
      ),
      expect.objectContaining({ images: [] }),
    );
    expect(sendUserMessageService).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      expect.stringContaining("20260731004453694\treplace\t过窄\tglfh\t+"),
      expect.objectContaining({ images: [] }),
    );
  });

  it("replaces large log attachments with content-addressed references", async () => {
    const dispatch = vi.fn();
    const largeLog = "log line\n".repeat(1_000);
    vi.mocked(readWorkspaceFile).mockResolvedValueOnce({
      content: largeLog,
      truncated: false,
    });
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: false,
        customPrompts: [],
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch,
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.sendUserMessageToThread(
        workspace,
        "thread-1",
        "inspect failure",
        ["/tmp/workspace/build.log"],
      );
    });

    expect(createContentReference).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sourceKind: "log",
      sourceName: "build.log",
      content: largeLog,
    });
    const sendCalls = vi.mocked(sendUserMessageService).mock.calls;
    const sentText = sendCalls[sendCalls.length - 1]?.[2] ?? "";
    expect(sentText).toContain("<content_reference");
    expect(sentText).toContain('source_kind="log"');
    expect(sentText).not.toContain(largeLog);

    vi.mocked(createContentReference).mockRejectedValueOnce(new Error("method unavailable"));
    vi.mocked(readWorkspaceFile).mockResolvedValueOnce({
      content: largeLog,
      truncated: false,
    });
    await act(async () => {
      await result.current.sendUserMessageToThread(
        workspace,
        "thread-1",
        "inspect with old daemon",
        ["/tmp/workspace/build.log"],
      );
    });
    const fallbackCalls = vi.mocked(sendUserMessageService).mock.calls;
    const fallbackText = fallbackCalls[fallbackCalls.length - 1]?.[2] ?? "";
    expect(fallbackText).toContain(largeLog);
  });

  it("blocks unsupported binary attachments instead of dropping them silently", async () => {
    const pushThreadErrorMessage = vi.fn();
    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: false,
        customPrompts: [],
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch: vi.fn(),
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage,
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    await act(async () => {
      const sendResult = await result.current.sendUserMessageToThread(
        workspace,
        "thread-1",
        "please read",
        ["/tmp/workspace/archive.zip"],
      );
      expect(sendResult).toEqual({ status: "blocked" });
    });

    expect(sendUserMessageService).not.toHaveBeenCalled();
    expect(pushThreadErrorMessage).toHaveBeenCalledWith(
      "thread-1",
      expect.stringContaining("Unsupported attachment"),
    );
  });

  it("keeps processing state for non-stale turn/steer rpc errors", async () => {
    const pushThreadErrorMessage = vi.fn();
    const markProcessing = vi.fn();
    const setActiveTurnId = vi.fn();
    vi.mocked(steerTurnService).mockResolvedValueOnce({
      error: { message: "steer request timed out" },
    } as unknown as Awaited<ReturnType<typeof steerTurnService>>);

    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: true,
        customPrompts: [],
        threadStatusById: {
          "thread-1": {
            isProcessing: true,
            isReviewing: false,
            hasUnread: false,
            processingStartedAt: 0,
            lastDurationMs: null,
          },
        },
        activeTurnIdByThread: {
          "thread-1": "turn-1",
        },
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch: vi.fn(),
        getCustomName: vi.fn(() => undefined),
        markProcessing,
        markReviewing: vi.fn(),
        setActiveTurnId,
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage,
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    await act(async () => {
      const sendResult = await result.current.sendUserMessageToThread(
        workspace,
        "thread-1",
        "steer timeout",
        [],
      );
      expect(sendResult).toEqual({ status: "steer_failed" });
    });

    expect(steerTurnService).toHaveBeenCalledTimes(1);
    expect(sendUserMessageService).not.toHaveBeenCalled();
    expect(markProcessing).toHaveBeenCalledWith(
      "thread-1",
      true,
      expect.any(Number),
    );
    expect(markProcessing).not.toHaveBeenCalledWith("thread-1", false);
    expect(setActiveTurnId).not.toHaveBeenCalledWith("thread-1", null);
    expect(pushThreadErrorMessage).toHaveBeenCalledWith(
      "thread-1",
      "Turn steer failed: steer request timed out",
    );
  });

  it("returns steer_failed and keeps processing state when turn/steer throws", async () => {
    const pushThreadErrorMessage = vi.fn();
    const markProcessing = vi.fn();
    const setActiveTurnId = vi.fn();
    vi.mocked(steerTurnService).mockRejectedValueOnce(
      new Error("steer network failure"),
    );

    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-1",
        accessMode: "current",
        model: null,
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "inline",
        steerEnabled: true,
        customPrompts: [],
        threadStatusById: {
          "thread-1": {
            isProcessing: true,
            isReviewing: false,
            hasUnread: false,
            processingStartedAt: 0,
            lastDurationMs: null,
          },
        },
        activeTurnIdByThread: {
          "thread-1": "turn-1",
        },
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch: vi.fn(),
        getCustomName: vi.fn(() => undefined),
        markProcessing,
        markReviewing: vi.fn(),
        setActiveTurnId,
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage,
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-1"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-1"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    await act(async () => {
      const sendResult = await result.current.sendUserMessageToThread(
        workspace,
        "thread-1",
        "steer exception",
        [],
      );
      expect(sendResult).toEqual({ status: "steer_failed" });
    });

    expect(sendUserMessageService).not.toHaveBeenCalled();
    expect(markProcessing).toHaveBeenCalledWith(
      "thread-1",
      true,
      expect.any(Number),
    );
    expect(markProcessing).not.toHaveBeenCalledWith("thread-1", false);
    expect(setActiveTurnId).not.toHaveBeenCalledWith("thread-1", null);
    expect(pushThreadErrorMessage).toHaveBeenCalledWith(
      "thread-1",
      "Turn steer failed: steer network failure",
    );
  });

  it("routes uncommitted review to an explicit workspace override", async () => {
    const ensureThreadForActiveWorkspace = vi.fn(async () => "thread-active");
    const ensureThreadForWorkspace = vi.fn(async () => "thread-override");

    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-active",
        accessMode: "current",
        model: null,
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "detached",
        steerEnabled: false,
        customPrompts: [],
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch: vi.fn(),
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace,
        ensureThreadForWorkspace,
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.startUncommittedReview("ws-2");
    });

    expect(ensureThreadForActiveWorkspace).not.toHaveBeenCalled();
    expect(ensureThreadForWorkspace).toHaveBeenCalledWith("ws-2");
    expect(startReviewService).toHaveBeenCalledWith(
      "ws-2",
      "thread-override",
      { type: "uncommittedChanges" },
      "detached",
    );
  });

  it("names detached commit review child threads from commit context", async () => {
    vi.mocked(startReviewService).mockResolvedValueOnce({
      result: {
        review_thread_id: "thread-review-1",
      },
    } as unknown as Awaited<ReturnType<typeof startReviewService>>);
    const renameThread = vi.fn();

    const { result } = renderHook(() =>
      useThreadMessaging({
        activeWorkspace: workspace,
        activeThreadId: "thread-parent",
        accessMode: "current",
        model: null,
        effort: null,
        collaborationMode: null,
        reviewDeliveryMode: "detached",
        steerEnabled: false,
        customPrompts: [],
        threadStatusById: {},
        activeTurnIdByThread: {},
        rateLimitsByWorkspace: {},
        pendingInterruptsRef: { current: new Set<string>() },
        dispatch: vi.fn(),
        getCustomName: vi.fn(() => undefined),
        markProcessing: vi.fn(),
        markReviewing: vi.fn(),
        setActiveTurnId: vi.fn(),
        recordThreadActivity: vi.fn(),
        safeMessageActivity: vi.fn(),
        onDebug: vi.fn(),
        pushThreadErrorMessage: vi.fn(),
        ensureThreadForActiveWorkspace: vi.fn(async () => "thread-parent"),
        ensureThreadForWorkspace: vi.fn(async () => "thread-parent"),
        refreshThread: vi.fn(async () => null),
        forkThreadForWorkspace: vi.fn(async () => null),
        updateThreadParent: vi.fn(),
        renameThread,
      }),
    );

    await act(async () => {
      await result.current.startReview(
        "/review commit abcdef1234567890 Tighten sidebar commit selection",
      );
    });

    expect(renameThread).toHaveBeenCalledWith(
      "ws-1",
      "thread-review-1",
      "Review abcdef1: Tighten sidebar commit…",
    );
  });
});
