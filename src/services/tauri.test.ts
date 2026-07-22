import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import * as notification from "@tauri-apps/plugin-notification";
import {
  exportMarkdownFile,
  addWorkspace,
  archiveManagedSessions,
  cleanupManagedSessionsNow,
  permanentlyDeleteManagedSession,
  previewManagedSessionCleanup,
  runManagedSessionCleanupScheduler,
  compactThread,
  createContentReference,
  createGitHubRepo,
  fetchGit,
  fetchManagedSessionsPage,
  fetchManagedSessionPreview,
  fetchSessionSearchResults,
  forkThread,
  getAppsList,
  getAgentsSettings,
  getExperimentalFeatureList,
  getGitHubIssues,
  getGitLog,
  getGitStatus,
  getOpenAppIcon,
  getThreadTokenUsage,
  getWorkspaceThirdPartyKeyUsage,
  getProviderModels,
  listThreads,
  listSessionSources,
  listMcpServerStatus,
  readThread,
  getTurnExecutionSummaries,
  upsertTurnExecutionSummary,
  resumeManagedSession,
  rollbackThread,
  scanManagedSessions,
  searchManagedSessions,
  readGlobalAgentsMd,
  readGlobalCodexConfigToml,
  listWorkspaces,
  openWorkspaceIn,
  prepareManagedSessionDerivation,
  readAgentMd,
  stageGitAll,
  respondToServerRequest,
  respondToUserInputRequest,
  sendUserMessage,
  steerTurn,
  sendNotification,
  sendTransientNotification,
  setCodexFeatureFlag,
  setAgentsCoreSettings,
  setNativeMenuLabels,
  setTrayLabels,
  setTrayRecentThreads,
  setTraySessionUsage,
  getReleasePlatform,
  startThread,
  workflowPreflightPreview,
  workflowGateStatus,
  knowledgeStatus,
  knowledgeQuery,
  executionRouterShadowPreview,
  registerExecutionBinding,
  observeExecutionBinding,
  listExecutionBindings,
  startReview,
  setThreadName,
  updateSessionSource,
  cancelSessionTask,
  tailscaleDaemonStart,
  tailscaleDaemonCommandPreview,
  tailscaleDaemonStatus,
  tailscaleDaemonStop,
  tailscaleStatus,
  pickImageFiles,
  pickAttachmentFiles,
  pickWorkspacePaths,
  writeGlobalAgentsMd,
  writeGlobalCodexConfigToml,
  createAgent,
  updateAgent,
  deleteAgent,
  readAgentConfigToml,
  readImageAsDataUrl,
  previewWindowsInstallerRepair,
  applyWindowsInstallerRepair,
  rollbackWindowsInstallerRepair,
  recoverWindowsInstallerRepair,
  saveComposerImages,
  promoteComposerImages,
  generateAgentDescription,
  writeAgentConfigToml,
  writeAgentMd,
} from "./tauri";
import type { TurnExecutionSummary } from "@/types";
import {
  armDevSendUserMessageThreadNotFoundOnce,
  clearDevRuntimeFaults,
} from "./devRuntimeFaults";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
  removeActive: vi.fn(),
}));

describe("tauri invoke wrappers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearDevRuntimeFaults();
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "is_macos_debug_build") {
        return false;
      }
      if (command === "get_app_settings") {
        return { backendMode: "local" };
      }
      if (command === "is_mobile_runtime") {
        return false;
      }
      return undefined;
    });
  });

  it("keeps turn execution summary IPC scoped to workspace and thread", async () => {
    const invokeMock = vi.mocked(invoke);
    const summary: TurnExecutionSummary = {
      schemaVersion: 1,
      executionId: "execution-1",
      workspaceId: "ws-1",
      threadId: "thread-1",
      turnId: "turn-1",
      turnChain: ["turn-1"],
      status: "completed",
      startedAtMs: 10,
      endedAtMs: 20,
      workingDurationMs: 10,
      addedLines: 2,
      deletedLines: 1,
      diffRevision: 1,
      recordRevision: 2,
      updatedAtMs: 20,
    };

    await getTurnExecutionSummaries("ws-1", "thread-1");
    await upsertTurnExecutionSummary(summary);

    expect(invokeMock).toHaveBeenNthCalledWith(1, "turn_execution_summary_get", {
      input: { workspaceId: "ws-1", threadId: "thread-1" },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "turn_execution_summary_upsert", {
      input: { summary },
    });
  });

  it("forwards execution binding registration, observation, and query inputs", async () => {
    const invokeMock = vi.mocked(invoke);
    const registerInput = {
      workspaceId: "ws-1",
      parentThreadId: "parent-1",
      collabToolCallId: "call-1",
      activePlanRevision: 2,
      approvedPlan: {
        planId: "plan-1",
        planRevision: 2,
        planHash: "a".repeat(64),
        approvalReceiptId: "receipt-1",
        nodeId: "node-1",
        taskFingerprint: "b".repeat(64),
      },
      expected: { modelId: "gpt-5.6-luna", reasoningEffort: "low" },
      provider: {
        activeProviderId: "openai",
        selectedProviderId: "openai",
        selectedModelId: "gpt-5.6-luna",
        selectedReasoningEffort: "low",
        models: [
          {
            providerId: "openai",
            modelId: "gpt-5.6-luna",
            verified: true,
            supportedReasoningEfforts: ["low", "medium"],
          },
        ],
      },
      registeredAtMs: 10,
      expiresAtMs: 60_010,
    };
    const observeInput = {
      workspaceId: "ws-1",
      parentThreadId: "parent-1",
      collabToolCallId: "call-1",
      senderThreadId: "parent-1",
      receiverThreadIds: ["child-1"],
      actual: { modelId: "gpt-5.6-luna", reasoningEffort: "low" },
      observedAtMs: 20,
    };
    const query = {
      workspaceId: "ws-1",
      parentThreadId: "parent-1",
      collabToolCallId: "call-1",
    };

    await registerExecutionBinding(registerInput);
    await observeExecutionBinding(observeInput);
    await listExecutionBindings(query);

    expect(invokeMock).toHaveBeenNthCalledWith(1, "execution_binding_register", {
      input: registerInput,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "execution_binding_observe", {
      input: observeInput,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "execution_binding_list", {
      input: query,
    });
  });

  it("forwards token efficiency mode when starting a thread", async () => {
    const invokeMock = vi.mocked(invoke);

    await startThread("ws-1", "balanced");

    expect(invokeMock).toHaveBeenCalledWith("start_thread", {
      workspaceId: "ws-1",
      tokenEfficiencyMode: "balanced",
    });
  });

  it("forwards workflow runtime mode to host preflight", async () => {
    const invokeMock = vi.mocked(invoke);

    await workflowPreflightPreview(
      "ws-1",
      "fix provider routing",
      "opencode",
      "minimax-m3",
      "shadow",
    );

    expect(invokeMock).toHaveBeenCalledWith("workflow_preflight_preview", {
      workspaceId: "ws-1",
      task: "fix provider routing",
      providerKind: "opencode",
      model: "minimax-m3",
      mode: "shadow",
      workflowId: null,
    });
  });

  it("forwards an explicit external workflow binding to host preflight", async () => {
    const invokeMock = vi.mocked(invoke);

    await workflowPreflightPreview(
      "ws-1",
      "continue approved implementation",
      "openai",
      "gpt-5.6-terra",
      "active",
      "wf-bound-1",
    );

    expect(invokeMock).toHaveBeenCalledWith("workflow_preflight_preview", {
      workspaceId: "ws-1",
      task: "continue approved implementation",
      providerKind: "openai",
      model: "gpt-5.6-terra",
      mode: "active",
      workflowId: "wf-bound-1",
    });
  });

  it("forwards an explicit workflow ID to the external gate adapter", async () => {
    const invokeMock = vi.mocked(invoke);

    await workflowGateStatus("ws-1", "wf-explicit-1");

    expect(invokeMock).toHaveBeenCalledWith("workflow_gate_status", {
      workspaceId: "ws-1",
      workflowId: "wf-explicit-1",
    });
  });

  it("uses the read-only knowledge status adapter", async () => {
    const invokeMock = vi.mocked(invoke);

    await knowledgeStatus();

    expect(invokeMock).toHaveBeenCalledWith("knowledge_status");
  });

  it("passes knowledge query scope without exposing provider credentials", async () => {
    const invokeMock = vi.mocked(invoke);

    await knowledgeQuery("review the knowledge architecture", "dev-knowledge-base");

    expect(invokeMock).toHaveBeenCalledWith("knowledge_query", {
      query: "review the knowledge architecture",
      projectId: "dev-knowledge-base",
    });
  });

  it("forwards shadow router input without activating dispatch", async () => {
    const invokeMock = vi.mocked(invoke);
    const input = {
      task: {
        complexity: "low" as const,
        risk: "low" as const,
        parallelizable: false,
        requiresWrite: false,
      },
      provider: {
        activeProviderId: "provider-a",
        selectedProviderId: "provider-a",
        selectedModelId: "model-a",
        selectedReasoningEffort: "high",
        models: [
          {
            providerId: "provider-a",
            modelId: "model-a",
            verified: true,
            supportedReasoningEfforts: ["high"],
          },
        ],
      },
      runtime: {
        activeSlots: 0,
        depth: 0,
        rootTokensUsed: 0,
        subtaskTokensEstimate: 1_000,
        elapsedMs: 0,
        retryCount: 0,
        fallbackCount: 0,
      },
      coordination: null,
    };

    await executionRouterShadowPreview(input);

    expect(invokeMock).toHaveBeenCalledWith("execution_router_shadow_preview", {
      input,
    });
  });

  it("forwards approved expected and actual bindings to shadow audit", async () => {
    const invokeMock = vi.mocked(invoke);
    const input = {
      task: {
        complexity: "low" as const,
        risk: "low" as const,
        parallelizable: false,
        requiresWrite: false,
      },
      provider: {
        activeProviderId: "openai",
        selectedProviderId: "openai",
        selectedModelId: "gpt-5.6-luna",
        selectedReasoningEffort: "low",
        models: [{
          providerId: "openai",
          modelId: "gpt-5.6-luna",
          verified: true,
          supportedReasoningEfforts: ["low", "medium"],
        }],
      },
      runtime: {
        activeSlots: 0,
        depth: 0,
        rootTokensUsed: 0,
        subtaskTokensEstimate: 1_000,
        elapsedMs: 0,
        retryCount: 0,
        fallbackCount: 0,
      },
      coordination: null,
      binding: {
        approvedPlan: {
          planId: "plan-routing",
          planRevision: 2,
          planHash: "a".repeat(64),
          approvalReceiptId: "receipt-plan-routing",
          nodeId: "node-transform",
          taskFingerprint: "b".repeat(64),
        },
        expected: { modelId: "gpt-5.6-luna", reasoningEffort: "low" },
        actual: { modelId: "gpt-5.6-luna", reasoningEffort: "low" },
      },
    };

    await executionRouterShadowPreview(input);

    expect(invokeMock).toHaveBeenCalledWith("execution_router_shadow_preview", {
      input,
    });
  });

  it("creates content references through the shared request contract", async () => {
    const invokeMock = vi.mocked(invoke);
    const request = {
      workspaceId: "ws-1",
      sourceKind: "diff" as const,
      sourceName: "changes.diff",
      content: "large diff",
    };

    await createContentReference(request);

    expect(invokeMock).toHaveBeenCalledWith("create_content_reference", { request });
  });

  it("forwards workflow additional context to start and steer", async () => {
    const invokeMock = vi.mocked(invoke);
    const additionalContext = {
      "cm.workflow": { kind: "application" as const, value: "workflow context" },
    };

    await sendUserMessage("ws-1", "thread-1", "hello", { additionalContext });
    await steerTurn("ws-1", "thread-1", "turn-1", "follow up", [], [], additionalContext);

    expect(invokeMock).toHaveBeenCalledWith(
      "send_user_message",
      expect.objectContaining({ additionalContext }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "turn_steer",
      expect.objectContaining({ additionalContext }),
    );
  });

  it("uses path-only payload for addWorkspace", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({ id: "ws-1" });

    await addWorkspace("/tmp/project");

    expect(invokeMock).toHaveBeenCalledWith("add_workspace", {
      path: "/tmp/project",
    });
  });

  it("forwards Windows installer repair contracts without exposing internals", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock
      .mockResolvedValueOnce({ status: "repairable", fingerprint: "preview-token" })
      .mockResolvedValueOnce({
        status: "completed",
        transactionId: "transaction-token",
        fingerprint: "post-token",
      })
      .mockResolvedValueOnce({ status: "rolledBack", fingerprint: "pre-token" });

    await previewWindowsInstallerRepair();
    await applyWindowsInstallerRepair("preview-token", "operation-token");
    await rollbackWindowsInstallerRepair("transaction-token", "post-token");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "preview_windows_installer_repair");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "apply_windows_installer_repair", {
      fingerprint: "preview-token",
      operationId: "operation-token",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "rollback_windows_installer_repair", {
      transactionId: "transaction-token",
      postFingerprint: "post-token",
    });
  });

  it("recovers incomplete Windows installer repair transactions without arguments", async () => {
    const invokeMock = vi.mocked(invoke);

    await recoverWindowsInstallerRepair();

    expect(invokeMock).toHaveBeenCalledWith("recover_windows_installer_repair");
  });

  it("returns an empty list when workspace picker is cancelled", async () => {
    const openMock = vi.mocked(open);
    openMock.mockResolvedValueOnce(null);

    await expect(pickWorkspacePaths()).resolves.toEqual([]);
  });

  it("wraps a single workspace selection in an array", async () => {
    const openMock = vi.mocked(open);
    openMock.mockResolvedValueOnce("/tmp/project");

    await expect(pickWorkspacePaths()).resolves.toEqual(["/tmp/project"]);
  });

  it("returns multiple workspace selections as-is", async () => {
    const openMock = vi.mocked(open);
    openMock.mockResolvedValueOnce(["/tmp/one", "/tmp/two"]);

    await expect(pickWorkspacePaths()).resolves.toEqual(["/tmp/one", "/tmp/two"]);
  });

  it("includes heic and heif in the image picker filter", async () => {
    const openMock = vi.mocked(open);
    openMock.mockResolvedValueOnce(["/tmp/photo.heic", "/tmp/photo.heif"]);

    await expect(pickImageFiles()).resolves.toEqual([
      "/tmp/photo.heic",
      "/tmp/photo.heif",
    ]);

    expect(openMock).toHaveBeenCalledWith({
      multiple: true,
      filters: [
        {
          name: "Images",
          extensions: [
            "png",
            "jpg",
            "jpeg",
            "gif",
            "webp",
            "bmp",
            "tiff",
            "tif",
            "heic",
            "heif",
          ],
        },
      ],
    });
  });

  it("forwards session manager contracts", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValue(undefined);

    await listSessionSources();
    await updateSessionSource({
      action: "rename",
      sourceId: "source-a",
      name: "Work",
    });
    await scanManagedSessions({
      requestId: "scan-a",
      sourceIds: ["source-a"],
      includeArchived: false,
    });
    await fetchManagedSessionsPage({ requestId: "scan-a", offset: 0, limit: 50 });
    await fetchManagedSessionPreview({ sourceId: "source-a", threadId: "thread-a", full: true });
    await searchManagedSessions({ requestId: "search-a", query: "alpha", sourceIds: [], includeArchived: true, includeSubagents: false });
    await fetchSessionSearchResults("search-a");
    await cancelSessionTask("scan-a");
    await resumeManagedSession({ sourceId: "source-a", threadId: "thread-a" });
    await archiveManagedSessions({
      items: [{ sourceId: "source-a", threadId: "thread-a" }],
    });
    await permanentlyDeleteManagedSession({ sourceId: "source-a", threadId: "thread-a", archivedAt: 123, cascadeRequested: false });
    const cleanupRequest = { retentionDays: 30 as const, protectedThreadIds: ["thread-a"] };
    await previewManagedSessionCleanup(cleanupRequest);
    await cleanupManagedSessionsNow(cleanupRequest);
    const schedulerRequest = { protectedThreadIds: ["thread-a"] };
    await runManagedSessionCleanupScheduler(schedulerRequest);
    await prepareManagedSessionDerivation({ sourceId: "source-a", threadId: "thread-a" });

    expect(invokeMock).toHaveBeenCalledWith("list_session_sources");
    expect(invokeMock).toHaveBeenCalledWith("update_session_source", {
      request: { action: "rename", sourceId: "source-a", name: "Work" },
    });
    expect(invokeMock).toHaveBeenCalledWith("scan_managed_sessions", {
      request: {
        requestId: "scan-a",
        sourceIds: ["source-a"],
        includeArchived: false,
      },
    });
    expect(invokeMock).toHaveBeenCalledWith("fetch_managed_sessions_page", {
      request: { requestId: "scan-a", offset: 0, limit: 50 },
    });
    expect(invokeMock).toHaveBeenCalledWith("fetch_managed_session_preview", {
      request: { sourceId: "source-a", threadId: "thread-a", full: true },
    });
    expect(invokeMock).toHaveBeenCalledWith("search_managed_sessions", {
      request: { requestId: "search-a", query: "alpha", sourceIds: [], includeArchived: true, includeSubagents: false },
    });
    expect(invokeMock).toHaveBeenCalledWith("fetch_session_search_results", { requestId: "search-a" });
    expect(invokeMock).toHaveBeenCalledWith("cancel_session_task", {
      requestId: "scan-a",
    });
    expect(invokeMock).toHaveBeenCalledWith("resume_managed_session", {
      request: { sourceId: "source-a", threadId: "thread-a" },
    });
    expect(invokeMock).toHaveBeenCalledWith("archive_managed_sessions", {
      request: {
        items: [{ sourceId: "source-a", threadId: "thread-a" }],
      },
    });
    expect(invokeMock).toHaveBeenCalledWith("permanently_delete_managed_session", {
      request: { sourceId: "source-a", threadId: "thread-a", archivedAt: 123, cascadeRequested: false },
    });
    expect(invokeMock).toHaveBeenCalledWith("preview_managed_session_cleanup", {
      request: cleanupRequest,
    });
    expect(invokeMock).toHaveBeenCalledWith("cleanup_managed_sessions_now", {
      request: cleanupRequest,
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "run_managed_session_cleanup_scheduler",
      { request: schedulerRequest },
    );
    expect(invokeMock).toHaveBeenCalledWith("prepare_managed_session_derivation", {
      request: { sourceId: "source-a", threadId: "thread-a" },
    });
  });

  it("opens an unfiltered attachment picker", async () => {
    const openMock = vi.mocked(open);
    openMock.mockResolvedValueOnce(["/tmp/notes.md", "/tmp/data.json"]);

    await expect(pickAttachmentFiles()).resolves.toEqual([
      "/tmp/notes.md",
      "/tmp/data.json",
    ]);

    expect(openMock).toHaveBeenCalledWith({ multiple: true });
  });

  it("returns null when markdown export is cancelled", async () => {
    const saveMock = vi.mocked(save);
    const invokeMock = vi.mocked(invoke);
    saveMock.mockResolvedValueOnce(null);

    await expect(exportMarkdownFile("# Plan")).resolves.toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith(
      "write_text_file",
      expect.anything(),
    );
  });

  it("writes markdown to the selected path", async () => {
    const saveMock = vi.mocked(save);
    const invokeMock = vi.mocked(invoke);
    saveMock.mockResolvedValueOnce("/tmp/plan.md");

    await expect(exportMarkdownFile("# Plan", "my-plan.md")).resolves.toBe("/tmp/plan.md");

    expect(saveMock).toHaveBeenCalledWith({
      title: "Export plan as Markdown",
      defaultPath: "my-plan.md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    expect(invokeMock).toHaveBeenCalledWith("write_text_file", {
      path: "/tmp/plan.md",
      content: "# Plan",
    });
  });

  it("maps workspace_id to workspaceId for git status", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({
      branchName: "main",
      files: [],
      stagedFiles: [],
      unstagedFiles: [],
      totalAdditions: 0,
      totalDeletions: 0,
    });

    await getGitStatus("ws-1");

    expect(invokeMock).toHaveBeenCalledWith("get_git_status", {
      workspaceId: "ws-1",
    });
  });

  it("maps args for createGitHubRepo", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({ status: "ok", repo: "me/repo" });

    await createGitHubRepo("ws-77", "me/repo", "private", "main");

    expect(invokeMock).toHaveBeenCalledWith("create_github_repo", {
      workspaceId: "ws-77",
      repo: "me/repo",
      visibility: "private",
      branch: "main",
    });
  });

  it("maps workspace_id to workspaceId for GitHub issues", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({ total: 0, issues: [] });

    await getGitHubIssues("ws-2");

    expect(invokeMock).toHaveBeenCalledWith("get_github_issues", {
      workspaceId: "ws-2",
    });
  });

  it("returns an empty list when the Tauri invoke bridge is missing", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockRejectedValueOnce(
      new TypeError("Cannot read properties of undefined (reading 'invoke')"),
    );

    await expect(listWorkspaces()).resolves.toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith("list_workspaces");
  });

  it("applies default limit for git log", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({
      total: 0,
      entries: [],
      ahead: 0,
      behind: 0,
      aheadEntries: [],
      behindEntries: [],
      upstream: null,
    });

    await getGitLog("ws-3");

    expect(invokeMock).toHaveBeenCalledWith("get_git_log", {
      workspaceId: "ws-3",
      limit: 40,
    });
  });

  it("maps workspaceId and threadId for fork_thread", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await forkThread("ws-9", "thread-9");

    expect(invokeMock).toHaveBeenCalledWith("fork_thread", {
      workspaceId: "ws-9",
      threadId: "thread-9",
    });
  });

  it("maps workspaceId and threadId for compact_thread", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await compactThread("ws-10", "thread-10");

    expect(invokeMock).toHaveBeenCalledWith("compact_thread", {
      workspaceId: "ws-10",
      threadId: "thread-10",
    });
  });

  it("maps workspaceId/threadId/name for set_thread_name", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await setThreadName("ws-9", "thread-9", "New Name");

    expect(invokeMock).toHaveBeenCalledWith("set_thread_name", {
      workspaceId: "ws-9",
      threadId: "thread-9",
      name: "New Name",
    });
  });

  it("maps workspaceId/cursor/limit for list_mcp_server_status", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await listMcpServerStatus("ws-10", "cursor-1", 25);

    expect(invokeMock).toHaveBeenCalledWith("list_mcp_server_status", {
      workspaceId: "ws-10",
      cursor: "cursor-1",
      limit: 25,
    });
  });

  it("maps workspaceId/cursor/limit/sortKey for list_threads", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await listThreads("ws-10", "cursor-1", 25, "updated_at");

    expect(invokeMock).toHaveBeenCalledWith("list_threads", {
      workspaceId: "ws-10",
      cursor: "cursor-1",
      limit: 25,
      sortKey: "updated_at",
    });
  });

  it("maps workspaceId/threadId for read_thread", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await readThread("ws-10", "thread-1");

    expect(invokeMock).toHaveBeenCalledWith("read_thread", {
      workspaceId: "ws-10",
      threadId: "thread-1",
    });
  });

  it("consumes the dev thread-not-found send fault exactly once", async () => {
    const invokeMock = vi.mocked(invoke);

    expect(armDevSendUserMessageThreadNotFoundOnce("runtime-e2e-probe")).toBe(true);

    await expect(sendUserMessage("ws-1", "thread-1", "first")).resolves.toEqual({
      error: {
        code: -32600,
        message: "thread not found: runtime-e2e-probe",
      },
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "send_user_message",
      expect.anything(),
    );

    await sendUserMessage("ws-1", "thread-1", "second");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(
      "send_user_message",
      expect.objectContaining({ text: "second" }),
    );
  });

  it("maps workspaceId/threadId for get_thread_token_usage", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce(null);

    await getThreadTokenUsage("ws-10", "thread-1");

    expect(invokeMock).toHaveBeenCalledWith("get_thread_token_usage", {
      workspaceId: "ws-10",
      threadId: "thread-1",
    });
  });

  it("maps entries for set_tray_recent_threads", async () => {
    const invokeMock = vi.mocked(invoke);
    const entries = [
      {
        workspaceId: "ws-1",
        workspaceLabel: "Workspace",
        threadId: "thread-1",
        threadLabel: "Alpha",
        updatedAt: 10,
      },
    ];

    await setTrayRecentThreads(entries);

    expect(invokeMock).toHaveBeenCalledWith("set_tray_recent_threads", {
      entries,
    });
  });

  it("maps workspaceId/threadId/numTurns for rollback_thread", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await rollbackThread("ws-9", "thread-9", 1);

    expect(invokeMock).toHaveBeenCalledWith("rollback_thread", {
      workspaceId: "ws-9",
      threadId: "thread-9",
      numTurns: 1,
    });
  });

  it("maps workspaceId and timezone for workspace third-party usage", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({
      balance: 12.5,
      usage: { today: { actual_cost: 1.25 } },
    });

    await getWorkspaceThirdPartyKeyUsage("ws-usage");

    expect(invokeMock).toHaveBeenCalledWith("workspace_third_party_key_usage", {
      workspaceId: "ws-usage",
      timezone: expect.any(String),
    });
  });

  it("maps labels for set_tray_labels", async () => {
    const invokeMock = vi.mocked(invoke);
    const labels = {
      open: "打开 ThreadFleet",
      hide: "隐藏窗口",
      checkUpdates: "检查更新",
      launchAtStartup: "开机启动",
      restart: "重启",
      quit: "退出",
    };

    await setTrayLabels(labels);

    expect(invokeMock).toHaveBeenCalledWith("set_tray_labels", {
      labels,
    });
  });

  it("preserves provider model reasoning levels including xhigh", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({
      data: [{
        id: "reasoning-model",
        name: "Reasoning Model",
        context_window: 128000,
        supported_reasoning_efforts: [
          "high",
          { reasoning_effort: "xhigh", description: "Extra high" },
        ],
        default_reasoning_effort: "xhigh",
      }],
    });

    await expect(getProviderModels("https://api.example.com/v1", "secret")).resolves.toEqual([
      {
        id: "reasoning-model",
        name: "Reasoning Model",
        contextWindow: 128000,
        supportedReasoningEfforts: [
          { reasoningEffort: "high", description: "" },
          { reasoningEffort: "xhigh", description: "Extra high" },
        ],
        defaultReasoningEffort: "xhigh",
      },
    ]);
  });

  it("maps localized labels for the native menu", async () => {
    const invokeMock = vi.mocked(invoke);
    const labels = {
      about: "关于 ThreadFleet",
      checkForUpdates: "检查更新...",
      settings: "设置...",
      services: "服务",
      hide: "隐藏 ThreadFleet",
      hideOthers: "隐藏其他窗口",
      quit: "退出 ThreadFleet",
      file: "文件",
      newAgent: "新建 Agent",
      newWorktreeAgent: "新建 Worktree Agent",
      newCloneAgent: "新建 Clone Agent",
      addWorkspace: "添加工作区...",
      addWorkspaceFromUrl: "从 URL 添加工作区...",
      closeWindow: "关闭窗口",
      edit: "编辑",
      undo: "撤销",
      redo: "重做",
      cut: "剪切",
      copy: "复制",
      paste: "粘贴",
      selectAll: "全选",
      composer: "编写器",
      cycleModel: "切换模型",
      cycleAccess: "切换访问模式",
      cycleReasoning: "切换推理模式",
      cycleCollaboration: "切换协作模式",
      view: "视图",
      toggleProjectsSidebar: "切换项目侧栏",
      toggleGitSidebar: "切换 Git 侧栏",
      toggleDebugPanel: "切换调试面板",
      toggleTerminal: "切换终端",
      nextAgent: "下一个 Agent",
      previousAgent: "上一个 Agent",
      nextWorkspace: "下一个工作区",
      previousWorkspace: "上一个工作区",
      toggleFullScreen: "切换全屏",
      window: "窗口",
      minimize: "最小化",
      maximize: "最大化",
      help: "帮助",
    };

    await setNativeMenuLabels(labels);

    expect(invokeMock).toHaveBeenCalledWith("menu_set_labels", { labels });
  });

  it("reads the native release platform", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce("macos-aarch64");

    await expect(getReleasePlatform()).resolves.toBe("macos-aarch64");
    expect(invokeMock).toHaveBeenCalledWith("release_platform");
  });

  it("maps usage for set_tray_session_usage", async () => {
    const invokeMock = vi.mocked(invoke);
    const usage = {
      sessionLabel: "12% used · Resets 2 hours",
      weeklyLabel: "67% used · Resets in 2 days",
    };

    await setTraySessionUsage(usage);

    expect(invokeMock).toHaveBeenCalledWith("set_tray_session_usage", {
      usage,
    });
  });

  it("maps workspaceId/cursor/limit/threadId for apps_list", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await getAppsList("ws-11", "cursor-1", 25, "thread-11");

    expect(invokeMock).toHaveBeenCalledWith("apps_list", {
      workspaceId: "ws-11",
      cursor: "cursor-1",
      limit: 25,
      threadId: "thread-11",
    });
  });

  it("maps workspaceId/cursor/limit for experimental_feature_list", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await getExperimentalFeatureList("ws-11", "cursor-2", 50);

    expect(invokeMock).toHaveBeenCalledWith("experimental_feature_list", {
      workspaceId: "ws-11",
      cursor: "cursor-2",
      limit: 50,
    });
  });

  it("maps feature key and enabled for set_codex_feature_flag", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce(undefined);

    await setCodexFeatureFlag("apps", true);

    expect(invokeMock).toHaveBeenCalledWith("set_codex_feature_flag", {
      featureKey: "apps",
      enabled: true,
    });
  });

  it("invokes stage_git_all", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await stageGitAll("ws-6");

    expect(invokeMock).toHaveBeenCalledWith("stage_git_all", {
      workspaceId: "ws-6",
    });
  });

  it("invokes fetch_git", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await fetchGit("ws-7");

    expect(invokeMock).toHaveBeenCalledWith("fetch_git", {
      workspaceId: "ws-7",
    });
  });

  it("maps openWorkspaceIn options", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await openWorkspaceIn("/tmp/project", {
      appName: "Xcode",
      args: ["--reuse-window"],
    });

    expect(invokeMock).toHaveBeenCalledWith("open_workspace_in", {
      path: "/tmp/project",
      app: "Xcode",
      command: null,
      args: ["--reuse-window"],
      line: null,
      column: null,
    });
  });

  it("passes line-aware openWorkspaceIn options", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await openWorkspaceIn("/tmp/project/src/App.tsx", {
      command: "code",
      args: ["--reuse-window"],
      line: 33,
      column: 7,
    });

    expect(invokeMock).toHaveBeenCalledWith("open_workspace_in", {
      path: "/tmp/project/src/App.tsx",
      app: null,
      command: "code",
      args: ["--reuse-window"],
      line: 33,
      column: 7,
    });
  });

  it("invokes get_open_app_icon", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce("data:image/png;base64,abc");

    await getOpenAppIcon("Xcode");

    expect(invokeMock).toHaveBeenCalledWith("get_open_app_icon", {
      appName: "Xcode",
    });
  });

  it("invokes tailscale wrappers", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValue(undefined);

    await tailscaleStatus();
    await tailscaleDaemonCommandPreview();
    await tailscaleDaemonStart();
    await tailscaleDaemonStop();
    await tailscaleDaemonStatus();

    expect(invokeMock).toHaveBeenCalledWith("tailscale_status");
    expect(invokeMock).toHaveBeenCalledWith("tailscale_daemon_command_preview");
    expect(invokeMock).toHaveBeenCalledWith("tailscale_daemon_start");
    expect(invokeMock).toHaveBeenCalledWith("tailscale_daemon_stop");
    expect(invokeMock).toHaveBeenCalledWith("tailscale_daemon_status");
  });

  it("reads agent.md for a workspace", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({ exists: true, content: "# Agent", truncated: false });

    await readAgentMd("ws-agent");

    expect(invokeMock).toHaveBeenCalledWith("file_read", {
      scope: "workspace",
      kind: "agents",
      workspaceId: "ws-agent",
    });
  });

  it("writes agent.md for a workspace", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await writeAgentMd("ws-agent", "# Agent");

    expect(invokeMock).toHaveBeenCalledWith("file_write", {
      scope: "workspace",
      kind: "agents",
      workspaceId: "ws-agent",
      content: "# Agent",
    });
  });

  it("reads global AGENTS.md", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({ exists: true, content: "# Global", truncated: false });

    await readGlobalAgentsMd();

    expect(invokeMock).toHaveBeenCalledWith("file_read", {
      scope: "global",
      kind: "agents",
      workspaceId: undefined,
    });
  });

  it("writes global AGENTS.md", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await writeGlobalAgentsMd("# Global");

    expect(invokeMock).toHaveBeenCalledWith("file_write", {
      scope: "global",
      kind: "agents",
      workspaceId: undefined,
      content: "# Global",
    });
  });

  it("reads global config.toml", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({ exists: true, content: "model = \"gpt-5\"", truncated: false });

    await readGlobalCodexConfigToml();

    expect(invokeMock).toHaveBeenCalledWith("file_read", {
      scope: "global",
      kind: "config",
      workspaceId: undefined,
    });
  });

  it("writes global config.toml", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await writeGlobalCodexConfigToml("model = \"gpt-5\"");

    expect(invokeMock).toHaveBeenCalledWith("file_write", {
      scope: "global",
      kind: "config",
      workspaceId: undefined,
      content: "model = \"gpt-5\"",
    });
  });

  it("reads agents settings", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({
      configPath: "/Users/me/.codex/config.toml",
      multiAgentEnabled: true,
      maxThreads: 6,
      maxDepth: 1,
      agents: [],
    });

    await getAgentsSettings();

    expect(invokeMock).toHaveBeenCalledWith("get_agents_settings");
  });

  it("updates core agents settings", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({
      configPath: "/Users/me/.codex/config.toml",
      multiAgentEnabled: false,
      maxThreads: 4,
      maxDepth: 3,
      agents: [],
    });

    await setAgentsCoreSettings({
      multiAgentEnabled: false,
      maxThreads: 4,
      maxDepth: 3,
    });

    expect(invokeMock).toHaveBeenCalledWith("set_agents_core_settings", {
      input: { multiAgentEnabled: false, maxThreads: 4, maxDepth: 3 },
    });
  });

  it("creates an agent", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await createAgent({
      name: "researcher",
      description: "Research-focused role",
      developerInstructions: "Investigate root cause first.",
      template: "blank",
      model: "gpt-5-codex",
      reasoningEffort: "medium",
    });

    expect(invokeMock).toHaveBeenCalledWith("create_agent", {
      input: {
        name: "researcher",
        description: "Research-focused role",
        developerInstructions: "Investigate root cause first.",
        template: "blank",
        model: "gpt-5-codex",
        reasoningEffort: "medium",
      },
    });
  });

  it("updates an agent", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await updateAgent({
      originalName: "researcher",
      name: "code_reviewer",
      description: "Review-focused role",
      developerInstructions: "Focus on correctness and regression risk.",
      renameManagedFile: true,
    });

    expect(invokeMock).toHaveBeenCalledWith("update_agent", {
      input: {
        originalName: "researcher",
        name: "code_reviewer",
        description: "Review-focused role",
        developerInstructions: "Focus on correctness and regression risk.",
        renameManagedFile: true,
      },
    });
  });

  it("deletes an agent", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await deleteAgent({
      name: "researcher",
      deleteManagedFile: true,
    });

    expect(invokeMock).toHaveBeenCalledWith("delete_agent", {
      input: {
        name: "researcher",
        deleteManagedFile: true,
      },
    });
  });

  it("reads an agent config file", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce("model = \"gpt-5-codex\"");

    await readAgentConfigToml("researcher");

    expect(invokeMock).toHaveBeenCalledWith("read_agent_config_toml", {
      agentName: "researcher",
    });
  });

  it("writes an agent config file", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await writeAgentConfigToml("researcher", "model = \"gpt-5-codex\"");

    expect(invokeMock).toHaveBeenCalledWith("write_agent_config_toml", {
      agentName: "researcher",
      content: "model = \"gpt-5-codex\"",
    });
  });

  it("generates an improved agent description", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({
      description: "Stabilizes flaky test suites",
      developerInstructions:
        "Reproduce failures first.\nPrefer deterministic fixes.\nAdd targeted coverage.",
    });

    await generateAgentDescription("ws-agent", "tests");

    expect(invokeMock).toHaveBeenCalledWith("generate_agent_description", {
      workspaceId: "ws-agent",
      description: "tests",
    });
  });

  it("fills sendUserMessage defaults in payload", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await sendUserMessage("ws-4", "thread-1", "hello", {
      accessMode: "full-access",
      images: ["image.png"],
    });

    expect(invokeMock).toHaveBeenLastCalledWith("send_user_message", {
      workspaceId: "ws-4",
      threadId: "thread-1",
      text: "hello",
      model: null,
      effort: null,
      accessMode: "full-access",
      images: ["image.png"],
    });
  });

  it("preserves explicit null serviceTier overrides", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await sendUserMessage("ws-4", "thread-1", "hello", {
      serviceTier: null,
    });

    expect(invokeMock).toHaveBeenLastCalledWith("send_user_message", {
      workspaceId: "ws-4",
      threadId: "thread-1",
      text: "hello",
      model: null,
      effort: null,
      serviceTier: null,
      accessMode: null,
      images: null,
    });
  });

  it("maps read_image_as_data_url", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce("data:image/png;base64,abc");

    await readImageAsDataUrl("/tmp/image.png");

    expect(invokeMock).toHaveBeenCalledWith("read_image_as_data_url", {
      path: "/tmp/image.png",
    });
  });

  it("converts image paths before send_user_message in remote mode", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "is_macos_debug_build") {
        return false;
      }
      if (command === "get_app_settings") {
        return { backendMode: "remote" };
      }
      if (command === "is_mobile_runtime") {
        return false;
      }
      if (command === "read_image_as_data_url") {
        return "data:image/png;base64,abc";
      }
      return undefined;
    });

    await sendUserMessage("ws-4", "thread-1", "hello", {
      images: ["/tmp/image.png"],
    });

    expect(invokeMock).toHaveBeenLastCalledWith("send_user_message", {
      workspaceId: "ws-4",
      threadId: "thread-1",
      text: "hello",
      model: null,
      effort: null,
      accessMode: null,
      images: ["data:image/png;base64,abc"],
    });
  });

  it("includes app mentions when sending a message", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await sendUserMessage("ws-4", "thread-1", "hello $calendar", {
      appMentions: [{ name: "Calendar", path: "app://connector_calendar" }],
    });

    expect(invokeMock).toHaveBeenCalledWith("send_user_message", {
      workspaceId: "ws-4",
      threadId: "thread-1",
      text: "hello $calendar",
      model: null,
      effort: null,
      accessMode: null,
      images: null,
      appMentions: [{ name: "Calendar", path: "app://connector_calendar" }],
    });
  });

  it("invokes turn_steer for steer payloads", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await steerTurn("ws-4", "thread-1", "turn-2", "continue", ["image.png"]);

    expect(invokeMock).toHaveBeenCalledWith("turn_steer", {
      workspaceId: "ws-4",
      threadId: "thread-1",
      turnId: "turn-2",
      text: "continue",
      images: ["image.png"],
    });
  });

  it("converts image paths before turn_steer in remote mode", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "is_macos_debug_build") {
        return false;
      }
      if (command === "get_app_settings") {
        return { backendMode: "remote" };
      }
      if (command === "is_mobile_runtime") {
        return false;
      }
      if (command === "read_image_as_data_url") {
        return "data:image/jpeg;base64,xyz";
      }
      return undefined;
    });

    await steerTurn("ws-4", "thread-1", "turn-2", "continue", ["/tmp/image.jpg"]);

    expect(invokeMock).toHaveBeenCalledWith("turn_steer", {
      workspaceId: "ws-4",
      threadId: "thread-1",
      turnId: "turn-2",
      text: "continue",
      images: ["data:image/jpeg;base64,xyz"],
    });
  });

  it("converts image paths on mobile even in local backend mode", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "is_macos_debug_build") {
        return false;
      }
      if (command === "get_app_settings") {
        return { backendMode: "local" };
      }
      if (command === "is_mobile_runtime") {
        return true;
      }
      if (command === "read_image_as_data_url") {
        return "data:image/png;base64,mobile";
      }
      return undefined;
    });

    await sendUserMessage("ws-4", "thread-1", "hello", {
      images: ["/private/var/mobile/sample.png"],
    });

    expect(invokeMock).toHaveBeenLastCalledWith("send_user_message", {
      workspaceId: "ws-4",
      threadId: "thread-1",
      text: "hello",
      model: null,
      effort: null,
      accessMode: null,
      images: ["data:image/png;base64,mobile"],
    });
  });

  it("fails when image conversion fails for send_user_message", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "is_macos_debug_build") {
        return false;
      }
      if (command === "get_app_settings") {
        return { backendMode: "remote" };
      }
      if (command === "is_mobile_runtime") {
        return false;
      }
      if (command === "read_image_as_data_url") {
        throw new Error("conversion failed");
      }
      return undefined;
    });

    await expect(
      sendUserMessage("ws-4", "thread-1", "hello", { images: ["/tmp/image.png"] }),
    ).rejects.toThrow("conversion failed");
    expect(invokeMock).not.toHaveBeenCalledWith("send_user_message", expect.anything());
  });

  it("omits delivery when starting reviews without override", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await startReview("ws-5", "thread-2", { type: "uncommittedChanges" });

    expect(invokeMock).toHaveBeenCalledWith("start_review", {
      workspaceId: "ws-5",
      threadId: "thread-2",
      target: { type: "uncommittedChanges" },
    });
  });

  it("includes delivery when starting detached reviews", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await startReview("ws-5", "thread-2", { type: "uncommittedChanges" }, "detached");

    expect(invokeMock).toHaveBeenCalledWith("start_review", {
      workspaceId: "ws-5",
      threadId: "thread-2",
      target: { type: "uncommittedChanges" },
      delivery: "detached",
    });
  });

  it("nests decisions for server request responses", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await respondToServerRequest("ws-6", 101, "accept");

    expect(invokeMock).toHaveBeenCalledWith("respond_to_server_request", {
      workspaceId: "ws-6",
      requestId: 101,
      result: { decision: "accept" },
    });
  });

  it("nests answers for user input responses", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    await respondToUserInputRequest("ws-7", 202, {
      confirm_path: { answers: ["Yes"] },
    });

    expect(invokeMock).toHaveBeenCalledWith("respond_to_server_request", {
      workspaceId: "ws-7",
      requestId: 202,
      result: {
        answers: {
          confirm_path: { answers: ["Yes"] },
        },
      },
    });
  });

  it("passes through multiple user input answers", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({});

    const answers = {
      confirm_path: { answers: ["Yes"] },
      notes: { answers: ["First line", "Second line"] },
    };

    await respondToUserInputRequest("ws-8", 303, answers);

    expect(invokeMock).toHaveBeenCalledWith("respond_to_server_request", {
      workspaceId: "ws-8",
      requestId: 303,
      result: {
        answers,
      },
    });
  });

  it("sends a notification without re-requesting permission when already granted", async () => {
    const isPermissionGrantedMock = vi.mocked(notification.isPermissionGranted);
    const requestPermissionMock = vi.mocked(notification.requestPermission);
    const sendNotificationMock = vi.mocked(notification.sendNotification);
    isPermissionGrantedMock.mockResolvedValueOnce(true);

    await sendNotification("Hello", "World");

    expect(isPermissionGrantedMock).toHaveBeenCalledTimes(1);
    expect(requestPermissionMock).not.toHaveBeenCalled();
    expect(sendNotificationMock).toHaveBeenCalledWith({
      title: "Hello",
      body: "World",
    });
  });

  it("passes extra metadata when provided", async () => {
    const isPermissionGrantedMock = vi.mocked(notification.isPermissionGranted);
    const sendNotificationMock = vi.mocked(notification.sendNotification);
    isPermissionGrantedMock.mockResolvedValueOnce(true);

    await sendNotification("Hello", "World", {
      extra: { kind: "thread", workspaceId: "ws-1", threadId: "t-1" },
    });

    expect(sendNotificationMock).toHaveBeenCalledWith({
      title: "Hello",
      body: "World",
      extra: { kind: "thread", workspaceId: "ws-1", threadId: "t-1" },
    });
  });

  it("maps session-aware composer image storage", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce(["/home/.codex/image.png"]);

    await saveComposerImages("ws-1", "draft-ws-1", ["/tmp/image.png"]);

    expect(invokeMock).toHaveBeenCalledWith("save_composer_images", {
      workspaceId: "ws-1",
      ownerKey: "draft-ws-1",
      images: ["/tmp/image.png"],
    });
  });

  it("maps composer image promotion", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce(["/home/.codex/image.png"]);

    await promoteComposerImages("ws-1", "thread-1", ["/tmp/image.png"]);

    expect(invokeMock).toHaveBeenCalledWith("promote_composer_images", {
      workspaceId: "ws-1",
      threadId: "thread-1",
      images: ["/tmp/image.png"],
    });
  });

  it("removes a transient notification after its duration", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const isPermissionGrantedMock = vi.mocked(notification.isPermissionGranted);
    const sendNotificationMock = vi.mocked(notification.sendNotification);
    const removeActiveMock = vi.mocked(notification.removeActive);
    isPermissionGrantedMock.mockResolvedValueOnce(true);
    removeActiveMock.mockResolvedValueOnce();

    await sendTransientNotification("Update", "Already current", 3000);

    const payload = sendNotificationMock.mock.calls[0]?.[0];
    if (typeof payload === "string" || !payload) {
      throw new Error("Expected object notification payload");
    }
    expect(payload).toMatchObject({
      title: "Update",
      body: "Already current",
      autoCancel: true,
      id: expect.any(Number),
    });
    expect(removeActiveMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    await Promise.resolve();
    await Promise.resolve();

    expect(removeActiveMock).toHaveBeenCalledWith([{ id: payload?.id }]);
    vi.useRealTimers();
  });

  it("requests permission once when needed and sends on grant", async () => {
    const isPermissionGrantedMock = vi.mocked(notification.isPermissionGranted);
    const requestPermissionMock = vi.mocked(notification.requestPermission);
    const sendNotificationMock = vi.mocked(notification.sendNotification);
    isPermissionGrantedMock.mockResolvedValueOnce(false);
    requestPermissionMock.mockResolvedValueOnce("granted");

    await sendNotification("Grant", "Please");

    expect(isPermissionGrantedMock).toHaveBeenCalledTimes(1);
    expect(requestPermissionMock).toHaveBeenCalledTimes(1);
    expect(sendNotificationMock).toHaveBeenCalledWith({
      title: "Grant",
      body: "Please",
    });
  });

  it("does not send and warns when permission is denied", async () => {
    const isPermissionGrantedMock = vi.mocked(notification.isPermissionGranted);
    const requestPermissionMock = vi.mocked(notification.requestPermission);
    const sendNotificationMock = vi.mocked(notification.sendNotification);
    const invokeMock = vi.mocked(invoke);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    isPermissionGrantedMock.mockResolvedValueOnce(false);
    requestPermissionMock.mockResolvedValueOnce("denied");

    await sendNotification("Denied", "Nope");

    expect(isPermissionGrantedMock).toHaveBeenCalledTimes(1);
    expect(requestPermissionMock).toHaveBeenCalledTimes(1);
    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "Notification permission not granted.",
      { permission: "denied" },
    );
    expect(invokeMock).toHaveBeenCalledWith("send_notification_fallback", {
      title: "Denied",
      body: "Nope",
    });
    warnSpy.mockRestore();
  });

  it("falls back when the notification plugin throws", async () => {
    const isPermissionGrantedMock = vi.mocked(notification.isPermissionGranted);
    const invokeMock = vi.mocked(invoke);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    isPermissionGrantedMock.mockRejectedValueOnce(new Error("boom"));

    await sendNotification("Plugin", "Failed");

    expect(invokeMock).toHaveBeenCalledWith("send_notification_fallback", {
      title: "Plugin",
      body: "Failed",
    });
    warnSpy.mockRestore();
  });

  it("prefers the fallback on macOS debug builds", async () => {
    const isPermissionGrantedMock = vi.mocked(notification.isPermissionGranted);
    const invokeMock = vi.mocked(invoke);

    invokeMock.mockImplementation(async (command: string) => {
      if (command === "is_macos_debug_build") {
        return true;
      }
      if (command === "send_notification_fallback") {
        return undefined;
      }
      return undefined;
    });

    await sendNotification("Dev", "Fallback");

    expect(invokeMock).toHaveBeenCalledWith("is_macos_debug_build");
    expect(invokeMock).toHaveBeenCalledWith("send_notification_fallback", {
      title: "Dev",
      body: "Fallback",
    });
    expect(isPermissionGrantedMock).not.toHaveBeenCalled();
  });
});
