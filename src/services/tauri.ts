import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  removeActive,
  type Options as NotificationOptions,
} from "@tauri-apps/plugin-notification";
import type {
  AppSettings,
  ArchiveManagedSessionsRequest,
  ArchiveManagedSessionsResponse,
  CodexProviderStatus,
  CodexProviderModel,
  CodexFunctionToolCapability,
  CredentialSelection,
  CodexSyncDiagnostics,
  CodexStatus,
  CodexUpdateResult,
  CodexDoctorResult,
  InstalledManagedCodex,
  DictationModelStatus,
  DictationSessionState,
  LocalUsageSnapshot,
  ManagedSessionPage,
  ManagedSessionPreviewRequest,
  ManagedSessionPreviewResponse,
  ManagedSessionCleanupPreview,
  ManagedSessionCleanupRequest,
  ManagedSessionCleanupResponse,
  ManagedSessionCleanupSchedulerRequest,
  ManagedSessionCleanupSchedulerResponse,
  ManagedSessionDerivationPreview,
  ManagedSessionPageRequest,
  ResumeManagedSessionRequest,
  ResumeManagedSessionResponse,
  PrepareManagedSessionDerivationRequest,
  PermanentlyDeleteManagedSessionRequest,
  PermanentlyDeleteManagedSessionResponse,
  SessionScanRequest,
  SessionScanSummary,
  SessionSearchProgress,
  SessionSearchRequest,
  SessionSearchResponse,
  SessionSource,
  SessionSourceUpdateRequest,
  VerifySessionThreadsRequest,
  VerifySessionThreadsResponse,
  TcpDaemonStatus,
  TailscaleDaemonCommandPreview,
  TailscaleStatus,
  WorkflowAdditionalContext,
  WorkflowHostPreflightPreview,
  WorkflowGateAdapterStatus,
  KnowledgeAdapterStatus,
  KnowledgeIntakeCaptureRequest,
  KnowledgeIntakeCaptureResponse,
  KnowledgeQueryResponse,
  KnowledgeTaskInitRequest,
  KnowledgeTaskInitResponse,
  NativeMenuLabels,
  WorkflowRuntimeMode,
  TrayLabels,
  TrayRecentThreadEntry,
  TraySessionUsage,
  WorkspaceInfo,
  WorkspaceRuntimeCodexArgsResult,
  AppMention,
  WorkspaceSettings,
  CandidateMatch,
  ShadowRouteAdvice,
  ShadowRouteRequest,
  ExecutionBindingObserveInput,
  ExecutionBindingQuery,
  ExecutionBindingRecord,
  ExecutionBindingRegisterInput,
  TurnExecutionSummary,
  ComputerControlCapabilitySnapshot,
  ComputerControlBackend,
  ComputerControlRouteDecision,
} from "../types";
import {
  buildThirdPartyUsageUrl,
  normalizeThirdPartyUsagePayload,
} from "@app/utils/thirdPartyKeyUsage";
import type { ThirdPartyKeyUsageSnapshot } from "@app/utils/thirdPartyKeyUsage";
import { readReasoningEffortMetadata } from "@utils/reasoningEfforts";
import { consumeDevSendUserMessageThreadNotFound } from "./devRuntimeFaults";
import type {
  GitFileDiff,
  GitFileStatus,
  GitCommitDiff,
  GitHubIssuesResponse,
  GitHubPullRequestComment,
  GitHubPullRequestDiff,
  GitHubPullRequestsResponse,
  GitLogResponse,
  ReviewTarget,
} from "../types";

function isMissingTauriInvokeError(error: unknown) {
  return (
    error instanceof TypeError &&
    (error.message.includes("reading 'invoke'") ||
      error.message.includes("reading \"invoke\""))
  );
}

export async function pickWorkspacePath(): Promise<string | null> {
  const selection = await open({ directory: true, multiple: false });
  if (!selection || Array.isArray(selection)) {
    return null;
  }
  return selection;
}

export async function pickWorkspacePaths(): Promise<string[]> {
  const selection = await open({ directory: true, multiple: true });
  if (!selection) {
    return [];
  }
  return Array.isArray(selection) ? selection : [selection];
}

export async function pickImageFiles(): Promise<string[]> {
  const selection = await open({
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
  if (!selection) {
    return [];
  }
  return Array.isArray(selection) ? selection : [selection];
}

export async function pickAttachmentFiles(): Promise<string[]> {
  const selection = await open({ multiple: true });
  if (!selection) {
    return [];
  }
  return Array.isArray(selection) ? selection : [selection];
}

export async function exportMarkdownFile(
  content: string,
  defaultFileName = "plan.md",
): Promise<string | null> {
  const selection = await save({
    title: "Export plan as Markdown",
    defaultPath: defaultFileName,
    filters: [
      {
        name: "Markdown",
        extensions: ["md"],
      },
    ],
  });
  if (!selection) {
    return null;
  }
  await invoke("write_text_file", { path: selection, content });
  return selection;
}

export async function exportJsonFile(
  content: string,
  defaultFileName: string,
  title: string,
): Promise<string | null> {
  const selection = await save({
    title,
    defaultPath: defaultFileName,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!selection) return null;
  await invoke("write_text_file", { path: selection, content });
  return selection;
}

export async function pickConversationExportPath(
  format: "pdf" | "png",
  defaultFileName: string,
  title: string,
): Promise<string | null> {
  const selection = await save({
    title,
    defaultPath: defaultFileName,
    filters: [{ name: format === "pdf" ? "PDF" : "PNG", extensions: [format] }],
  });
  return selection || null;
}

const BINARY_WRITE_CHUNK_BYTES = 1024 * 1024;

type WriteBinaryFileOptions = {
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
};

function binaryWriteCancelledError() {
  const error = new Error("Binary file write cancelled");
  error.name = "AbortError";
  return error;
}

export async function writeBinaryFile(
  path: string,
  content: Uint8Array,
  options: WriteBinaryFileOptions = {},
): Promise<void> {
  if (content.length === 0) {
    throw new Error("Export content is empty");
  }
  const total = Math.ceil(content.length / BINARY_WRITE_CHUNK_BYTES);
  options.onProgress?.(0, total);
  try {
    for (let index = 0; index < total; index += 1) {
      if (options.signal?.aborted) throw binaryWriteCancelledError();
      const offset = index * BINARY_WRITE_CHUNK_BYTES;
      const chunk = content.subarray(offset, offset + BINARY_WRITE_CHUNK_BYTES);
      await invoke("write_binary_file_chunk", {
        path,
        content: Array.from(chunk),
        offset,
        totalLength: content.length,
      });
      options.onProgress?.(index + 1, total);
    }
  } catch (error) {
    try {
      await invoke("cancel_binary_file_write", { path });
    } catch {
      // Preserve the write or cancellation error; cleanup is best-effort.
    }
    throw error;
  }
}

export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  try {
    return await invoke<WorkspaceInfo[]>("list_workspaces");
  } catch (error) {
    if (isMissingTauriInvokeError(error)) {
      // In non-Tauri environments (e.g., Electron/web previews), the invoke
      // bridge may be missing. Treat this as "no workspaces" instead of crashing.
      console.warn("Tauri invoke bridge unavailable; returning empty workspaces list.");
      return [];
    }
    throw error;
  }
}

export async function getCodexConfigPath(): Promise<string> {
  return invoke<string>("get_codex_config_path");
}

export async function getCodexStatus(): Promise<CodexStatus> {
  return invoke<CodexStatus>("get_codex_status");
}

export async function getCodexSyncDiagnostics(): Promise<CodexSyncDiagnostics> {
  return invoke<CodexSyncDiagnostics>("get_codex_sync_diagnostics");
}

export type TextFileResponse = {
  exists: boolean;
  content: string;
  truncated: boolean;
};

export type GlobalAgentsResponse = TextFileResponse;
export type GlobalCodexConfigResponse = TextFileResponse;
export type AgentMdResponse = TextFileResponse;
export type AgentSummary = {
  name: string;
  description: string | null;
  developerInstructions: string | null;
  configFile: string;
  resolvedPath: string;
  managedByApp: boolean;
  fileExists: boolean;
};

export type AgentsSettings = {
  configPath: string;
  multiAgentEnabled: boolean;
  maxThreads: number;
  maxDepth: number;
  agents: AgentSummary[];
};

export type SetAgentsCoreInput = {
  multiAgentEnabled: boolean;
  maxThreads: number;
  maxDepth: number;
};

export type CreateAgentInput = {
  name: string;
  description?: string | null;
  developerInstructions?: string | null;
  template?: "blank" | string | null;
  model?: string | null;
  reasoningEffort?: string | null;
};

export type UpdateAgentInput = {
  originalName: string;
  name: string;
  description?: string | null;
  developerInstructions?: string | null;
  renameManagedFile?: boolean;
};

export type DeleteAgentInput = {
  name: string;
  deleteManagedFile?: boolean;
};

type FileScope = "workspace" | "global";
type FileKind = "agents" | "config";

async function fileRead(
  scope: FileScope,
  kind: FileKind,
  workspaceId?: string,
): Promise<TextFileResponse> {
  return invoke<TextFileResponse>("file_read", { scope, kind, workspaceId });
}

async function fileWrite(
  scope: FileScope,
  kind: FileKind,
  content: string,
  workspaceId?: string,
): Promise<void> {
  return invoke("file_write", { scope, kind, workspaceId, content });
}

export async function readImageAsDataUrl(path: string): Promise<string> {
  return invoke<string>("read_image_as_data_url", { path });
}

export async function saveComposerImages(
  workspaceId: string,
  ownerKey: string,
  images: string[],
): Promise<string[]> {
  return invoke<string[]>("save_composer_images", {
    workspaceId,
    ownerKey,
    images,
  });
}

export async function promoteComposerImages(
  workspaceId: string,
  threadId: string,
  images: string[],
): Promise<string[]> {
  return invoke<string[]>("promote_composer_images", {
    workspaceId,
    threadId,
    images,
  });
}

export type CreateMessageReferenceRequest = {
  workspaceId: string;
  sourceThreadId: string;
  sourceMessageId: string;
  sourceRole: "user" | "assistant";
  sourceTitle: string;
  content: string;
};

export type MessageReferenceResponse = {
  referenceId: string;
  path: string;
  characterCount: number;
  estimatedTokens: number;
};

export async function createMessageReference(
  request: CreateMessageReferenceRequest,
): Promise<MessageReferenceResponse> {
  return invoke<MessageReferenceResponse>("create_message_reference", { request });
}

export type CreateContentReferenceRequest = {
  workspaceId: string;
  sourceKind: "attachment" | "log" | "diff";
  sourceName: string;
  content: string;
};

export async function createContentReference(
  request: CreateContentReferenceRequest,
): Promise<MessageReferenceResponse> {
  return invoke<MessageReferenceResponse>("create_content_reference", { request });
}

export async function readGlobalAgentsMd(): Promise<GlobalAgentsResponse> {
  return fileRead("global", "agents");
}

export async function writeGlobalAgentsMd(content: string): Promise<void> {
  return fileWrite("global", "agents", content);
}

export async function readGlobalCodexConfigToml(): Promise<GlobalCodexConfigResponse> {
  return fileRead("global", "config");
}

export async function writeGlobalCodexConfigToml(content: string): Promise<void> {
  return fileWrite("global", "config", content);
}

export async function getAgentsSettings(): Promise<AgentsSettings> {
  return invoke<AgentsSettings>("get_agents_settings");
}

export async function setAgentsCoreSettings(
  input: SetAgentsCoreInput,
): Promise<AgentsSettings> {
  return invoke<AgentsSettings>("set_agents_core_settings", { input });
}

export async function createAgent(input: CreateAgentInput): Promise<AgentsSettings> {
  return invoke<AgentsSettings>("create_agent", { input });
}

export async function updateAgent(input: UpdateAgentInput): Promise<AgentsSettings> {
  return invoke<AgentsSettings>("update_agent", { input });
}

export async function deleteAgent(input: DeleteAgentInput): Promise<AgentsSettings> {
  return invoke<AgentsSettings>("delete_agent", { input });
}

export async function readAgentConfigToml(agentName: string): Promise<string> {
  return invoke<string>("read_agent_config_toml", { agentName });
}

export async function writeAgentConfigToml(
  agentName: string,
  content: string,
): Promise<void> {
  return invoke("write_agent_config_toml", { agentName, content });
}

export async function getConfigModel(workspaceId: string): Promise<string | null> {
  const response = await invoke<{ model?: string | null }>("get_config_model", {
    workspaceId,
  });
  const model = response?.model;
  if (typeof model !== "string") {
    return null;
  }
  const trimmed = model.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function getProviderStatus(workspaceId: string): Promise<CodexProviderStatus> {
  const response = await invoke<CodexProviderStatus>("get_provider_status", {
    workspaceId,
  });
  const normalizePositiveNumber = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  return {
    providerName:
      typeof response.providerName === "string" && response.providerName.trim()
        ? response.providerName.trim()
        : null,
    baseUrl:
      typeof response.baseUrl === "string" && response.baseUrl.trim()
        ? response.baseUrl.trim()
        : null,
    source: typeof response.source === "string" ? response.source : "unknown",
    isConfigured: Boolean(response.isConfigured),
    isThirdParty: Boolean(response.isThirdParty),
    autoCompactTokenLimit: normalizePositiveNumber(response.autoCompactTokenLimit),
    modelContextWindow: normalizePositiveNumber(response.modelContextWindow),
    error: typeof response.error === "string" && response.error.trim() ? response.error : null,
  };
}

export async function getThirdPartyKeyUsage(
  baseUrl: string,
  apiKey: string,
  usageProtocol: "auto" | "sub2" | "new-api" | "disabled" = "auto",
  newApiAccessToken?: string | null,
  newApiSessionCookie?: string | null,
): Promise<ThirdPartyKeyUsageSnapshot | null> {
  const usageUrl = buildThirdPartyUsageUrl(baseUrl);
  if (!usageUrl || (!apiKey.trim() && !newApiSessionCookie?.trim())) {
    return null;
  }
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const now = new Date();
  const dayStartUnix = Math.floor(
    new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1_000,
  );
  const response = await invoke<unknown>("third_party_key_usage", {
    baseUrl: usageUrl,
    apiKey,
    newApiAccessToken: newApiAccessToken?.trim() || null,
    newApiSessionCookie: newApiSessionCookie?.trim() || null,
    timezone,
    dayStartUnix,
    usageProtocol,
  });
  return normalizeThirdPartyUsagePayload(response);
}

export async function getWorkspaceThirdPartyKeyUsage(
  workspaceId: string,
): Promise<ThirdPartyKeyUsageSnapshot | null> {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const now = new Date();
  const dayStartUnix = Math.floor(
    new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1_000,
  );
  const response = await invoke<unknown>("workspace_third_party_key_usage", {
    workspaceId,
    timezone,
    dayStartUnix,
  });
  return normalizeThirdPartyUsagePayload(response);
}

function normalizeProviderModelPayload(payload: unknown): CodexProviderModel[] {
  const data =
    payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : [];
  return data
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      if (!id) {
        return null;
      }
      const name =
        typeof record.name === "string" && record.name.trim()
          ? record.name.trim()
          : null;
      const rawContext =
        record.context_window ?? record.contextWindow ?? record.max_context_tokens;
      const contextWindow =
        typeof rawContext === "number" && Number.isFinite(rawContext) && rawContext > 0
          ? Math.floor(rawContext)
          : null;
      return {
        id,
        name,
        contextWindow,
        ...readReasoningEffortMetadata(record),
      };
    })
    .filter((model): model is CodexProviderModel => model !== null);
}

export async function getProviderModels(
  baseUrl: string,
  apiKey: string,
): Promise<CodexProviderModel[]> {
  if (!baseUrl.trim() || !apiKey.trim()) {
    return [];
  }
  const response = await invoke<unknown>("provider_model_list", {
    baseUrl,
    apiKey,
  });
  return normalizeProviderModelPayload(response);
}

export async function providerSessionLogin(
  baseUrl: string,
  usageProtocol: "auto" | "sub2" | "new-api" | "disabled" = "auto",
): Promise<string> {
  return invoke<string>("provider_session_login", {
    baseUrl,
    usageProtocol,
  });
}

export async function probeProviderFunctionCalling(
  selection: CredentialSelection,
): Promise<CodexFunctionToolCapability> {
  return invoke<CodexFunctionToolCapability>("provider_function_tool_probe", { selection });
}

export async function addWorkspace(path: string): Promise<WorkspaceInfo> {
  return invoke<WorkspaceInfo>("add_workspace", { path });
}

export async function addWorkspaceFromGitUrl(
  url: string,
  destinationPath: string,
  targetFolderName: string | null,
): Promise<WorkspaceInfo> {
  return invoke<WorkspaceInfo>("add_workspace_from_git_url", {
    url,
    destinationPath,
    targetFolderName,
  });
}

export async function isWorkspacePathDir(path: string): Promise<boolean> {
  return invoke<boolean>("is_workspace_path_dir", { path });
}

export async function addClone(
  sourceWorkspaceId: string,
  copiesFolder: string,
  copyName: string,
): Promise<WorkspaceInfo> {
  return invoke<WorkspaceInfo>("add_clone", {
    sourceWorkspaceId,
    copiesFolder,
    copyName,
  });
}

export async function addWorktree(
  parentId: string,
  branch: string,
  name: string | null,
  copyAgentsMd = true,
): Promise<WorkspaceInfo> {
  return invoke<WorkspaceInfo>("add_worktree", { parentId, branch, name, copyAgentsMd });
}

export type WorktreeSetupStatus = {
  shouldRun: boolean;
  script: string | null;
};

export async function getWorktreeSetupStatus(
  workspaceId: string,
): Promise<WorktreeSetupStatus> {
  return invoke<WorktreeSetupStatus>("worktree_setup_status", { workspaceId });
}

export async function markWorktreeSetupRan(workspaceId: string): Promise<void> {
  return invoke("worktree_setup_mark_ran", { workspaceId });
}

export async function updateWorkspaceSettings(
  id: string,
  settings: WorkspaceSettings,
): Promise<WorkspaceInfo> {
  return invoke<WorkspaceInfo>("update_workspace_settings", { id, settings });
}

export async function removeWorkspace(id: string): Promise<void> {
  return invoke("remove_workspace", { id });
}

export async function removeWorktree(id: string): Promise<void> {
  return invoke("remove_worktree", { id });
}

export async function renameWorktree(
  id: string,
  branch: string,
): Promise<WorkspaceInfo> {
  return invoke<WorkspaceInfo>("rename_worktree", { id, branch });
}

export async function renameWorktreeUpstream(
  id: string,
  oldBranch: string,
  newBranch: string,
): Promise<void> {
  return invoke("rename_worktree_upstream", { id, oldBranch, newBranch });
}

export async function applyWorktreeChanges(workspaceId: string): Promise<void> {
  return invoke("apply_worktree_changes", { workspaceId });
}

export async function openWorkspaceIn(
  path: string,
  options: {
    appName?: string | null;
    command?: string | null;
    args?: string[];
    line?: number | null;
    column?: number | null;
  },
): Promise<void> {
  return invoke("open_workspace_in", {
    path,
    app: options.appName ?? null,
    command: options.command ?? null,
    args: options.args ?? [],
    line: options.line ?? null,
    column: options.column ?? null,
  });
}

export async function getOpenAppIcon(appName: string): Promise<string | null> {
  return invoke<string | null>("get_open_app_icon", { appName });
}

export async function connectWorkspace(id: string): Promise<void> {
  return invoke("connect_workspace", { id });
}

export async function setWorkspaceRuntimeCodexArgs(
  workspaceId: string,
  codexArgs: string | null,
): Promise<WorkspaceRuntimeCodexArgsResult> {
  return invoke("set_workspace_runtime_codex_args", {
    workspaceId,
    codexArgs,
  });
}

export async function startThread(
  workspaceId: string,
  tokenEfficiencyMode: "quality" | "balanced" | "economy" = "quality",
) {
  return invoke<any>("start_thread", { workspaceId, tokenEfficiencyMode });
}

export async function workflowPreflightPreview(
  workspaceId: string,
  task: string,
  providerKind: string,
  model: string | null,
  mode: Exclude<WorkflowRuntimeMode, "off">,
  workflowId: string | null = null,
): Promise<WorkflowHostPreflightPreview> {
  return invoke<WorkflowHostPreflightPreview>("workflow_preflight_preview", {
    workspaceId,
    task,
    providerKind,
    model,
    mode,
    workflowId,
  });
}

export async function workflowGateStatus(
  workspaceId: string,
  workflowId: string,
): Promise<WorkflowGateAdapterStatus> {
  return invoke<WorkflowGateAdapterStatus>("workflow_gate_status", {
    workspaceId,
    workflowId,
  });
}

export async function knowledgeStatus(): Promise<KnowledgeAdapterStatus> {
  return invoke<KnowledgeAdapterStatus>("knowledge_status");
}

export async function knowledgeQuery(
  query: string,
  projectId: string | null = null,
): Promise<KnowledgeQueryResponse> {
  return invoke<KnowledgeQueryResponse>("knowledge_query", { query, projectId });
}

export async function knowledgeIntakeCapture(
  input: KnowledgeIntakeCaptureRequest,
): Promise<KnowledgeIntakeCaptureResponse> {
  return invoke<KnowledgeIntakeCaptureResponse>("knowledge_intake_capture", { input });
}

export async function knowledgeTaskInit(
  input: KnowledgeTaskInitRequest,
): Promise<KnowledgeTaskInitResponse> {
  return invoke<KnowledgeTaskInitResponse>("knowledge_task_init", { input });
}

export async function forkThread(workspaceId: string, threadId: string) {
  return invoke<any>("fork_thread", { workspaceId, threadId });
}

export async function compactThread(workspaceId: string, threadId: string) {
  return invoke<any>("compact_thread", { workspaceId, threadId });
}

function isInlineImageUrl(image: string) {
  return (
    image.startsWith("data:") ||
    image.startsWith("http://") ||
    image.startsWith("https://")
  );
}

async function convertImagesToDataUrls(images: string[]): Promise<string[]> {
  return Promise.all(
    images.map(async (image) => {
      if (isInlineImageUrl(image)) {
        return image;
      }
      return readImageAsDataUrl(image);
    }),
  );
}

async function normalizeImagesForRpc(images?: string[]): Promise<string[] | null> {
  if (images == null) {
    return null;
  }
  if (images.length === 0) {
    return [];
  }
  const hasPathImages = images.some((image) => !isInlineImageUrl(image));
  if (!hasPathImages) {
    return images;
  }
  let settings: AppSettings;
  let mobileRuntime: boolean;
  try {
    [settings, mobileRuntime] = await Promise.all([getAppSettings(), isMobileRuntime()]);
  } catch (error) {
    if (isMissingTauriInvokeError(error)) {
      return images;
    }
    throw error;
  }
  if (settings.backendMode !== "remote" && !mobileRuntime) {
    return images;
  }
  return convertImagesToDataUrls(images);
}

export async function sendUserMessage(
  workspaceId: string,
  threadId: string,
  text: string,
  options?: {
    model?: string | null;
    effort?: string | null;
    serviceTier?: "fast" | "flex" | null | undefined;
    accessMode?: "read-only" | "current" | "full-access";
    images?: string[];
    collaborationMode?: Record<string, unknown> | null;
    appMentions?: AppMention[];
    additionalContext?: WorkflowAdditionalContext;
  },
) {
  const images = await normalizeImagesForRpc(options?.images);
  const payload: Record<string, unknown> = {
    workspaceId,
    threadId,
    text,
    model: options?.model ?? null,
    effort: options?.effort ?? null,
    accessMode: options?.accessMode ?? null,
    images,
  };
  if (options?.serviceTier !== undefined) {
    payload.serviceTier = options.serviceTier;
  }
  if (options?.collaborationMode) {
    payload.collaborationMode = options.collaborationMode;
  }
  if (options?.appMentions && options.appMentions.length > 0) {
    payload.appMentions = options.appMentions;
  }
  if (options?.additionalContext && Object.keys(options.additionalContext).length > 0) {
    payload.additionalContext = options.additionalContext;
  }
  const injectedFailure = consumeDevSendUserMessageThreadNotFound();
  if (injectedFailure) {
    return injectedFailure;
  }
  return invoke("send_user_message", payload);
}

export async function interruptTurn(
  workspaceId: string,
  threadId: string,
  turnId: string,
) {
  return invoke("turn_interrupt", { workspaceId, threadId, turnId });
}

export async function steerTurn(
  workspaceId: string,
  threadId: string,
  turnId: string,
  text: string,
  images?: string[],
  appMentions?: AppMention[],
  additionalContext?: WorkflowAdditionalContext,
) {
  const normalizedImages = await normalizeImagesForRpc(images);
  const payload: Record<string, unknown> = {
    workspaceId,
    threadId,
    turnId,
    text,
    images: normalizedImages,
  };
  if (appMentions && appMentions.length > 0) {
    payload.appMentions = appMentions;
  }
  if (additionalContext && Object.keys(additionalContext).length > 0) {
    payload.additionalContext = additionalContext;
  }
  return invoke("turn_steer", payload);
}

export async function startReview(
  workspaceId: string,
  threadId: string,
  target: ReviewTarget,
  delivery?: "inline" | "detached",
) {
  const payload: Record<string, unknown> = { workspaceId, threadId, target };
  if (delivery) {
    payload.delivery = delivery;
  }
  return invoke("start_review", payload);
}

export async function respondToServerRequest(
  workspaceId: string,
  requestId: number | string,
  decision: "accept" | "decline",
) {
  return invoke("respond_to_server_request", {
    workspaceId,
    requestId,
    result: { decision },
  });
}

export async function respondToUserInputRequest(
  workspaceId: string,
  requestId: number | string,
  answers: Record<string, { answers: string[] }>,
) {
  return invoke("respond_to_server_request", {
    workspaceId,
    requestId,
    result: { answers },
  });
}

export async function rememberApprovalRule(
  workspaceId: string,
  command: string[],
) {
  return invoke("remember_approval_rule", { workspaceId, command });
}

export async function getGitStatus(workspace_id: string): Promise<{
  branchName: string;
  files: GitFileStatus[];
  stagedFiles: GitFileStatus[];
  unstagedFiles: GitFileStatus[];
  totalAdditions: number;
  totalDeletions: number;
}> {
  return invoke("get_git_status", { workspaceId: workspace_id });
}

export type InitGitRepoResponse =
  | { status: "initialized"; commitError?: string }
  | { status: "already_initialized" }
  | { status: "needs_confirmation"; entryCount: number };

export async function initGitRepo(
  workspaceId: string,
  branch: string,
  force = false,
): Promise<InitGitRepoResponse> {
  return invoke<InitGitRepoResponse>("init_git_repo", { workspaceId, branch, force });
}

export type CreateGitHubRepoResponse =
  | { status: "ok"; repo: string; remoteUrl?: string | null }
  | {
      status: "partial";
      repo: string;
      remoteUrl?: string | null;
      pushError?: string | null;
      defaultBranchError?: string | null;
    };

export async function createGitHubRepo(
  workspaceId: string,
  repo: string,
  visibility: "private" | "public",
  branch?: string | null,
): Promise<CreateGitHubRepoResponse> {
  return invoke<CreateGitHubRepoResponse>("create_github_repo", {
    workspaceId,
    repo,
    visibility,
    branch,
  });
}

export async function listGitRoots(
  workspace_id: string,
  depth: number,
): Promise<string[]> {
  return invoke("list_git_roots", { workspaceId: workspace_id, depth });
}

export async function getGitDiffs(
  workspace_id: string,
): Promise<GitFileDiff[]> {
  return invoke("get_git_diffs", { workspaceId: workspace_id });
}

export async function getGitLog(
  workspace_id: string,
  limit = 40,
): Promise<GitLogResponse> {
  return invoke("get_git_log", { workspaceId: workspace_id, limit });
}

export async function getGitCommitDiff(
  workspace_id: string,
  sha: string,
): Promise<GitCommitDiff[]> {
  return invoke("get_git_commit_diff", { workspaceId: workspace_id, sha });
}

export async function getGitRemote(workspace_id: string): Promise<string | null> {
  return invoke("get_git_remote", { workspaceId: workspace_id });
}

export async function stageGitFile(workspaceId: string, path: string) {
  return invoke("stage_git_file", { workspaceId, path });
}

export async function stageGitAll(workspaceId: string): Promise<void> {
  return invoke("stage_git_all", { workspaceId });
}

export async function unstageGitFile(workspaceId: string, path: string) {
  return invoke("unstage_git_file", { workspaceId, path });
}

export async function revertGitFile(workspaceId: string, path: string) {
  return invoke("revert_git_file", { workspaceId, path });
}

export async function revertGitAll(workspaceId: string) {
  return invoke("revert_git_all", { workspaceId });
}

export async function commitGit(
  workspaceId: string,
  message: string,
): Promise<void> {
  return invoke("commit_git", { workspaceId, message });
}

export async function pushGit(workspaceId: string): Promise<void> {
  return invoke("push_git", { workspaceId });
}

export async function pullGit(workspaceId: string): Promise<void> {
  return invoke("pull_git", { workspaceId });
}

export async function fetchGit(workspaceId: string): Promise<void> {
  return invoke("fetch_git", { workspaceId });
}

export async function syncGit(workspaceId: string): Promise<void> {
  return invoke("sync_git", { workspaceId });
}

export async function getGitHubIssues(
  workspace_id: string,
): Promise<GitHubIssuesResponse> {
  return invoke("get_github_issues", { workspaceId: workspace_id });
}

export async function getGitHubPullRequests(
  workspace_id: string,
): Promise<GitHubPullRequestsResponse> {
  return invoke("get_github_pull_requests", { workspaceId: workspace_id });
}

export async function getGitHubPullRequestDiff(
  workspace_id: string,
  prNumber: number,
): Promise<GitHubPullRequestDiff[]> {
  return invoke("get_github_pull_request_diff", {
    workspaceId: workspace_id,
    prNumber,
  });
}

export async function getGitHubPullRequestComments(
  workspace_id: string,
  prNumber: number,
): Promise<GitHubPullRequestComment[]> {
  return invoke("get_github_pull_request_comments", {
    workspaceId: workspace_id,
    prNumber,
  });
}

export async function checkoutGitHubPullRequest(
  workspace_id: string,
  prNumber: number,
): Promise<void> {
  return invoke("checkout_github_pull_request", {
    workspaceId: workspace_id,
    prNumber,
  });
}

export async function localUsageSnapshot(
  days?: number,
  workspacePath?: string | null,
): Promise<LocalUsageSnapshot> {
  const payload: { days: number; workspacePath?: string } = { days: days ?? 30 };
  if (workspacePath) {
    payload.workspacePath = workspacePath;
  }
  return invoke("local_usage_snapshot", payload);
}

export async function getModelList(workspaceId: string) {
  return invoke<any>("model_list", { workspaceId });
}

export async function getExperimentalFeatureList(
  workspaceId: string,
  cursor?: string | null,
  limit?: number | null,
) {
  return invoke<any>("experimental_feature_list", { workspaceId, cursor, limit });
}

export async function setCodexFeatureFlag(
  featureKey: string,
  enabled: boolean,
): Promise<void> {
  return invoke("set_codex_feature_flag", { featureKey, enabled });
}

export async function generateRunMetadata(workspaceId: string, prompt: string) {
  return invoke<{ title: string; worktreeName: string }>("generate_run_metadata", {
    workspaceId,
    prompt,
  });
}

export async function getCollaborationModes(workspaceId: string) {
  return invoke<any>("collaboration_mode_list", { workspaceId });
}

export async function getAccountRateLimits(workspaceId: string) {
  return invoke<any>("account_rate_limits", { workspaceId });
}

export async function getAccountInfo(workspaceId: string) {
  return invoke<any>("account_read", { workspaceId });
}

export async function runCodexLogin(workspaceId: string) {
  return invoke<{ loginId: string; authUrl: string; raw?: unknown }>("codex_login", {
    workspaceId,
  });
}

export async function cancelCodexLogin(workspaceId: string) {
  return invoke<{ canceled: boolean; status?: string; raw?: unknown }>(
    "codex_login_cancel",
    { workspaceId },
  );
}

export async function getSkillsList(workspaceId: string) {
  return invoke<any>("skills_list", { workspaceId });
}

export async function getAppsList(
  workspaceId: string,
  cursor?: string | null,
  limit?: number | null,
  threadId?: string | null,
) {
  return invoke<any>("apps_list", { workspaceId, cursor, limit, threadId });
}

export async function taskCoordinationListGroups() {
  return invoke<any>("task_coordination_list_groups");
}

export async function executionRouterShadowPreview(
  input: ShadowRouteRequest,
): Promise<ShadowRouteAdvice> {
  return invoke<ShadowRouteAdvice>("execution_router_shadow_preview", { input });
}

export async function registerExecutionBinding(
  input: ExecutionBindingRegisterInput,
): Promise<ExecutionBindingRecord> {
  return invoke<ExecutionBindingRecord>("execution_binding_register", { input });
}

export async function observeExecutionBinding(
  input: ExecutionBindingObserveInput,
): Promise<ExecutionBindingRecord> {
  return invoke<ExecutionBindingRecord>("execution_binding_observe", { input });
}

export async function listExecutionBindings(
  input: ExecutionBindingQuery,
): Promise<ExecutionBindingRecord[]> {
  return invoke<ExecutionBindingRecord[]>("execution_binding_list", { input });
}

export async function taskCoordinationCreateGroup(group: unknown) {
  return invoke<any>("task_coordination_create_group", { group });
}

export async function taskCoordinationAcquireClaim(
  groupId: string,
  owner: unknown,
  kind: "file" | "directory" | "logical",
  resourceKey: string,
  access: "read" | "write" | "exclusive",
) {
  return invoke<any>("task_coordination_acquire_claim", {
    groupId,
    owner,
    kind,
    resourceKey,
    access,
  });
}

export async function taskCoordinationReleaseClaim(groupId: string, claimId: string) {
  return invoke<void>("task_coordination_release_claim", { groupId, claimId });
}

export async function taskCoordinationHeartbeat(groupId: string, threadKey: unknown) {
  return invoke<void>("task_coordination_heartbeat", { groupId, threadKey });
}

export async function taskCoordinationDetectCandidates(
  target: unknown,
  targetRepositoryId: string,
  targetTitle: string,
  knownThreads: unknown,
  seenPairs: unknown,
) {
  return invoke<CandidateMatch[]>("task_coordination_detect_candidates", {
    target,
    targetRepositoryId,
    targetTitle,
    knownThreads,
    seenPairs,
  });
}

export async function detectPython() {
  return invoke<{
    available: boolean;
    interpreterPath: string | null;
    version: string | null;
    source: string | null;
  }>("detect_python");
}

export async function getPromptsList(workspaceId: string) {
  return invoke<any>("prompts_list", { workspaceId });
}

export async function getWorkspacePromptsDir(workspaceId: string) {
  return invoke<string>("prompts_workspace_dir", { workspaceId });
}

export async function getGlobalPromptsDir(workspaceId: string) {
  return invoke<string>("prompts_global_dir", { workspaceId });
}

export async function createPrompt(
  workspaceId: string,
  data: {
    scope: "workspace" | "global";
    name: string;
    description?: string | null;
    argumentHint?: string | null;
    content: string;
  },
) {
  return invoke<any>("prompts_create", {
    workspaceId,
    scope: data.scope,
    name: data.name,
    description: data.description ?? null,
    argumentHint: data.argumentHint ?? null,
    content: data.content,
  });
}

export async function updatePrompt(
  workspaceId: string,
  data: {
    path: string;
    name: string;
    description?: string | null;
    argumentHint?: string | null;
    content: string;
  },
) {
  return invoke<any>("prompts_update", {
    workspaceId,
    path: data.path,
    name: data.name,
    description: data.description ?? null,
    argumentHint: data.argumentHint ?? null,
    content: data.content,
  });
}

export async function deletePrompt(workspaceId: string, path: string) {
  return invoke<any>("prompts_delete", { workspaceId, path });
}

export async function movePrompt(
  workspaceId: string,
  data: { path: string; scope: "workspace" | "global" },
) {
  return invoke<any>("prompts_move", {
    workspaceId,
    path: data.path,
    scope: data.scope,
  });
}

export async function getAppSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_app_settings");
}

export async function listSessionSources(): Promise<SessionSource[]> {
  return invoke<SessionSource[]>("list_session_sources");
}

export async function updateSessionSource(
  request: SessionSourceUpdateRequest,
): Promise<SessionSource[]> {
  return invoke<SessionSource[]>("update_session_source", { request });
}

export async function scanManagedSessions(
  request: SessionScanRequest,
): Promise<SessionScanSummary> {
  return invoke<SessionScanSummary>("scan_managed_sessions", { request });
}

export async function fetchManagedSessionsPage(
  request: ManagedSessionPageRequest,
): Promise<ManagedSessionPage> {
  return invoke<ManagedSessionPage>("fetch_managed_sessions_page", { request });
}

export async function fetchManagedSessionPreview(
  request: ManagedSessionPreviewRequest,
): Promise<ManagedSessionPreviewResponse> {
  return invoke<ManagedSessionPreviewResponse>("fetch_managed_session_preview", { request });
}

export async function searchManagedSessions(
  request: SessionSearchRequest,
): Promise<SessionSearchProgress> {
  return invoke<SessionSearchProgress>("search_managed_sessions", { request });
}

export async function fetchSessionSearchResults(
  requestId: string,
): Promise<SessionSearchResponse> {
  return invoke<SessionSearchResponse>("fetch_session_search_results", { requestId });
}

export async function cancelSessionTask(requestId: string): Promise<void> {
  return invoke("cancel_session_task", { requestId });
}
export async function isMobileRuntime(): Promise<boolean> {
  return invoke<boolean>("is_mobile_runtime");
}

export async function rollbackThread(
  workspaceId: string,
  threadId: string,
  numTurns = 1,
) {
  return invoke("rollback_thread", { workspaceId, threadId, numTurns });
}

export async function cleanupDownloadedReleaseAssets(): Promise<void> {
  return invoke("cleanup_downloaded_release_assets");
}

export async function windowsInstallerKind(): Promise<
  "msi" | "nsis" | "mixed" | "unknown"
> {
  return invoke<"msi" | "nsis" | "mixed" | "unknown">("windows_installer_kind");
}

export type WindowsInstallerFamily = "msi" | "nsis" | "unknown";
export type WindowsInstallerRegistryHive = "currentUser" | "localMachine";
export type WindowsInstallerRegistryView = "registry32" | "registry64";

export type WindowsInstallerRecordSummary = {
  family: WindowsInstallerFamily;
  hive: WindowsInstallerRegistryHive;
  view: WindowsInstallerRegistryView;
  displayVersion?: string | null;
  installLocation?: string | null;
};

export type WindowsInstallerRepairPreview = {
  status: "repairable" | "blocked" | "unsupported";
  recoveryRequired?: boolean;
  fingerprint?: string | null;
  currentVersion: string;
  records: WindowsInstallerRecordSummary[];
  blockers: string[];
  plannedActions: string[];
};

export type WindowsInstallerRepairResult = {
  transactionId?: string | null;
  status: "completed" | "rolledBack" | "unsupported";
  fingerprint?: string | null;
  message?: string | null;
};

export async function previewWindowsInstallerRepair(): Promise<WindowsInstallerRepairPreview> {
  return invoke<WindowsInstallerRepairPreview>("preview_windows_installer_repair");
}

export async function applyWindowsInstallerRepair(
  fingerprint: string,
  operationId: string,
): Promise<WindowsInstallerRepairResult> {
  return invoke<WindowsInstallerRepairResult>("apply_windows_installer_repair", {
    fingerprint,
    operationId,
  });
}

export async function rollbackWindowsInstallerRepair(
  transactionId: string,
  postFingerprint: string,
): Promise<WindowsInstallerRepairResult> {
  return invoke<WindowsInstallerRepairResult>("rollback_windows_installer_repair", {
    transactionId,
    postFingerprint,
  });
}

export async function recoverWindowsInstallerRepair(): Promise<WindowsInstallerRepairResult> {
  return invoke<WindowsInstallerRepairResult>("recover_windows_installer_repair");
}

export type InstallerMigrationPreparationInput = {
  version: string;
  artifactPath: string;
  artifactSize: number;
  artifactSha256: string;
};

export type InstallerMigrationPreparationResult = {
  targetVersion: string;
  expiresAtUnixMs: number;
  sourceMetadataItems: number;
};

export type InstallerMigrationRecoveryStatus = {
  recoveryRequired: boolean;
  targetVersion?: string | null;
};

export type InstallerMigrationDiagnosticCode =
  | "completed"
  | "rolledBack"
  | "contractRejected"
  | "manifestRejected"
  | "ownershipBlocked"
  | "backendFailure"
  | "interrupted"
  | "migrationFailed"
  | "rollbackFailed"
  | "runtimeDisabled"
  | "unsupportedPlatform";

export type InstallerMigrationExecutionResult = {
  status:
    | "completed"
    | "rolledBack"
    | "blocked"
    | "interrupted"
    | "invalid"
    | "failed"
    | "rollbackFailed"
    | "unsupported";
  diagnosticCode: InstallerMigrationDiagnosticCode;
  transactionId?: string | null;
  rebootRequired: boolean;
  message?: string | null;
};

export type InstallerMigrationCapability = {
  platformSupported: boolean;
  runtimeEnabled: boolean;
  remoteExecutionAllowed: false;
  reason?: string | null;
};

export async function getWindowsInstallerMigrationCapability(): Promise<InstallerMigrationCapability> {
  return invoke<InstallerMigrationCapability>(
    "windows_installer_migration_capability",
  );
}

export async function getWindowsInstallerMigrationRecoveryStatus(): Promise<InstallerMigrationRecoveryStatus> {
  return invoke<InstallerMigrationRecoveryStatus>(
    "windows_installer_migration_recovery_status",
  );
}

export async function prepareWindowsInstallerMigration(
  input: InstallerMigrationPreparationInput,
): Promise<InstallerMigrationPreparationResult> {
  return invoke<InstallerMigrationPreparationResult>(
    "prepare_windows_installer_migration",
    { input },
  );
}

export async function executeWindowsInstallerMigration(): Promise<InstallerMigrationExecutionResult> {
  return invoke<InstallerMigrationExecutionResult>("execute_windows_installer_migration");
}

export async function downloadAndOpenReleaseAsset(
  urls: string[],
  fileName: string,
  requestId: string,
  expectedSize?: number,
  expectedSha256?: string,
): Promise<{ path: string }> {
  return invoke<{ path: string }>("download_and_open_release_asset", {
    urls,
    fileName,
    requestId,
    expectedSize,
    expectedSha256,
  });
}

export async function updateAppSettings(settings: AppSettings): Promise<AppSettings> {
  return invoke<AppSettings>("update_app_settings", { settings });
}

export async function listSystemFonts(): Promise<string[]> {
  return invoke<string[]>("list_system_fonts");
}

export async function tailscaleStatus(): Promise<TailscaleStatus> {
  return invoke<TailscaleStatus>("tailscale_status");
}

export async function tailscaleDaemonCommandPreview(): Promise<TailscaleDaemonCommandPreview> {
  return invoke<TailscaleDaemonCommandPreview>("tailscale_daemon_command_preview");
}

export async function tailscaleDaemonStart(): Promise<TcpDaemonStatus> {
  return invoke<TcpDaemonStatus>("tailscale_daemon_start");
}

export async function tailscaleDaemonStop(): Promise<TcpDaemonStatus> {
  return invoke<TcpDaemonStatus>("tailscale_daemon_stop");
}

export async function tailscaleDaemonStatus(): Promise<TcpDaemonStatus> {
  return invoke<TcpDaemonStatus>("tailscale_daemon_status");
}

type MenuAcceleratorUpdate = {
  id: string;
  accelerator: string | null;
};

export async function setMenuAccelerators(
  updates: MenuAcceleratorUpdate[],
): Promise<void> {
  return invoke("menu_set_accelerators", { updates });
}

export async function downloadReleaseAsset(
  urls: string[],
  fileName: string,
  requestId: string,
  expectedSize?: number,
  expectedSha256?: string,
): Promise<{ path: string }> {
  return invoke<{ path: string }>("download_release_asset", {
    urls,
    fileName,
    requestId,
    expectedSize,
    expectedSha256,
  });
}

export async function setNativeMenuLabels(labels: NativeMenuLabels): Promise<void> {
  return invoke("menu_set_labels", { labels });
}

export async function runCodexDoctor(
  codexBin: string | null,
  codexArgs: string | null,
): Promise<CodexDoctorResult> {
  return invoke<CodexDoctorResult>("codex_doctor", { codexBin, codexArgs });
}

export async function runCodexUpdate(
  codexBin: string | null,
  codexArgs: string | null,
): Promise<CodexUpdateResult> {
  return invoke<CodexUpdateResult>("codex_update", { codexBin, codexArgs });
}

export async function getWorkspaceFiles(workspaceId: string) {
  return invoke<string[]>("list_workspace_files", { workspaceId });
}

export async function readWorkspaceFile(
  workspaceId: string,
  path: string,
): Promise<{ content: string; truncated: boolean }> {
  return invoke<{ content: string; truncated: boolean }>("read_workspace_file", {
    workspaceId,
    path,
  });
}

export async function readAgentMd(workspaceId: string): Promise<AgentMdResponse> {
  return fileRead("workspace", "agents", workspaceId);
}

export async function writeAgentMd(workspaceId: string, content: string): Promise<void> {
  return fileWrite("workspace", "agents", content, workspaceId);
}

export async function listGitBranches(workspaceId: string) {
  return invoke<any>("list_git_branches", { workspaceId });
}

export async function checkoutGitBranch(workspaceId: string, name: string) {
  return invoke("checkout_git_branch", { workspaceId, name });
}

export async function createGitBranch(workspaceId: string, name: string) {
  return invoke("create_git_branch", { workspaceId, name });
}

function withModelId(modelId?: string | null) {
  return modelId ? { modelId } : {};
}

export async function getDictationModelStatus(
  modelId?: string | null,
): Promise<DictationModelStatus> {
  return invoke<DictationModelStatus>(
    "dictation_model_status",
    withModelId(modelId),
  );
}

export async function downloadDictationModel(
  modelId?: string | null,
): Promise<DictationModelStatus> {
  return invoke<DictationModelStatus>(
    "dictation_download_model",
    withModelId(modelId),
  );
}

export async function cancelDictationDownload(
  modelId?: string | null,
): Promise<DictationModelStatus> {
  return invoke<DictationModelStatus>(
    "dictation_cancel_download",
    withModelId(modelId),
  );
}

export async function removeDictationModel(
  modelId?: string | null,
): Promise<DictationModelStatus> {
  return invoke<DictationModelStatus>(
    "dictation_remove_model",
    withModelId(modelId),
  );
}

export async function startDictation(
  preferredLanguage: string | null,
): Promise<DictationSessionState> {
  return invoke("dictation_start", { preferredLanguage });
}

export async function requestDictationPermission(): Promise<boolean> {
  return invoke("dictation_request_permission");
}

export async function stopDictation(): Promise<DictationSessionState> {
  return invoke("dictation_stop");
}

export async function cancelDictation(): Promise<DictationSessionState> {
  return invoke("dictation_cancel");
}

export async function openTerminalSession(
  workspaceId: string,
  terminalId: string,
  cols: number,
  rows: number,
): Promise<{ id: string }> {
  return invoke("terminal_open", { workspaceId, terminalId, cols, rows });
}

export async function writeTerminalSession(
  workspaceId: string,
  terminalId: string,
  data: string,
): Promise<void> {
  return invoke("terminal_write", { workspaceId, terminalId, data });
}

export async function resizeTerminalSession(
  workspaceId: string,
  terminalId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("terminal_resize", { workspaceId, terminalId, cols, rows });
}

export async function closeTerminalSession(
  workspaceId: string,
  terminalId: string,
): Promise<void> {
  return invoke("terminal_close", { workspaceId, terminalId });
}

export async function installManagedCodex(
  urls: string[],
  fileName: string,
  requestId: string,
  version: string,
  expectedSize: number,
  expectedSha256: string,
): Promise<InstalledManagedCodex> {
  return invoke<InstalledManagedCodex>("install_managed_codex", {
    urls,
    fileName,
    requestId,
    version,
    expectedSize,
    expectedSha256,
  });
}

export async function getManagedCodexPlatform(): Promise<string> {
  return invoke<string>("managed_codex_platform");
}

export async function getReleasePlatform(): Promise<string> {
  return invoke<string>("release_platform");
}

export async function openExternalTerminal(workspaceId: string): Promise<void> {
  return invoke("terminal_open_external", { workspaceId });
}

export async function getSystemTerminalFont(): Promise<string | null> {
  return invoke<string | null>("get_system_terminal_font");
}

export async function listThreads(
  workspaceId: string,
  cursor?: string | null,
  limit?: number | null,
  sortKey?: "created_at" | "updated_at" | null,
  archived?: boolean | null,
) {
  return invoke<any>("list_threads", {
    workspaceId,
    cursor,
    limit,
    sortKey,
    archived,
  });
}

export async function listMcpServerStatus(
  workspaceId: string,
  cursor?: string | null,
  limit?: number | null,
) {
  return invoke<any>("list_mcp_server_status", { workspaceId, cursor, limit });
}

export async function resumeThread(workspaceId: string, threadId: string) {
  return invoke<any>("resume_thread", { workspaceId, threadId });
}

export async function getComputerControlStatus(
  workspaceId: string,
  forceRefresh = false,
): Promise<ComputerControlCapabilitySnapshot> {
  return invoke<ComputerControlCapabilitySnapshot>("computer_control_status", {
    workspaceId,
    forceRefresh,
  });
}

export async function computerControlPreflight(
  workspaceId: string,
  task: string,
  decisionId: string,
  explicitBackend?: ComputerControlBackend | null,
): Promise<ComputerControlRouteDecision> {
  return invoke<ComputerControlRouteDecision>("computer_control_preflight", {
    workspaceId,
    task,
    decisionId,
    explicitBackend: explicitBackend ?? null,
  });
}

export async function getThreadTokenUsage(
  workspaceId: string,
  threadId: string,
): Promise<Record<string, unknown> | null> {
  return invoke<Record<string, unknown> | null>("get_thread_token_usage", {
    workspaceId,
    threadId,
  });
}

export async function resumeManagedSession(
  request: ResumeManagedSessionRequest,
): Promise<ResumeManagedSessionResponse> {
  return invoke<ResumeManagedSessionResponse>("resume_managed_session", { request });
}

export async function archiveManagedSessions(
  request: ArchiveManagedSessionsRequest,
): Promise<ArchiveManagedSessionsResponse> {
  return invoke<ArchiveManagedSessionsResponse>("archive_managed_sessions", { request });
}

export async function permanentlyDeleteManagedSession(
  request: PermanentlyDeleteManagedSessionRequest,
): Promise<PermanentlyDeleteManagedSessionResponse> {
  return invoke<PermanentlyDeleteManagedSessionResponse>("permanently_delete_managed_session", { request });
}

export async function previewManagedSessionCleanup(
  request: ManagedSessionCleanupRequest,
): Promise<ManagedSessionCleanupPreview> {
  return invoke<ManagedSessionCleanupPreview>("preview_managed_session_cleanup", { request });
}

export async function cleanupManagedSessionsNow(
  request: ManagedSessionCleanupRequest,
): Promise<ManagedSessionCleanupResponse> {
  return invoke<ManagedSessionCleanupResponse>("cleanup_managed_sessions_now", { request });
}

export async function runManagedSessionCleanupScheduler(
  request: ManagedSessionCleanupSchedulerRequest,
): Promise<ManagedSessionCleanupSchedulerResponse> {
  return invoke<ManagedSessionCleanupSchedulerResponse>(
    "run_managed_session_cleanup_scheduler",
    { request },
  );
}

export async function prepareManagedSessionDerivation(
  request: PrepareManagedSessionDerivationRequest,
): Promise<ManagedSessionDerivationPreview> {
  return invoke<ManagedSessionDerivationPreview>("prepare_managed_session_derivation", { request });
}

export async function readThread(workspaceId: string, threadId: string) {
  return invoke<any>("read_thread", { workspaceId, threadId });
}

export async function readThreadPage(
  workspaceId: string,
  threadId: string,
  cursor?: string | null,
  itemLimit?: number | null,
  byteLimit?: number | null,
) {
  return invoke<any>("read_thread_page", {
    workspaceId,
    threadId,
    cursor,
    itemLimit,
    byteLimit,
  });
}

export async function verifySessionThreads(
  request: VerifySessionThreadsRequest,
): Promise<VerifySessionThreadsResponse> {
  return invoke<VerifySessionThreadsResponse>("verify_session_threads", { request });
}

export async function getTurnExecutionSummaries(
  workspaceId: string,
  threadId: string,
): Promise<TurnExecutionSummary[]> {
  return invoke<TurnExecutionSummary[]>("turn_execution_summary_get", {
    input: { workspaceId, threadId },
  });
}

export async function upsertTurnExecutionSummary(
  summary: TurnExecutionSummary,
): Promise<TurnExecutionSummary> {
  return invoke<TurnExecutionSummary>("turn_execution_summary_upsert", {
    input: { summary },
  });
}

export async function threadLiveSubscribe(workspaceId: string, threadId: string) {
  return invoke<any>("thread_live_subscribe", { workspaceId, threadId });
}

export async function threadLiveUnsubscribe(workspaceId: string, threadId: string) {
  return invoke<any>("thread_live_unsubscribe", { workspaceId, threadId });
}

export async function archiveThread(workspaceId: string, threadId: string) {
  return invoke<any>("archive_thread", { workspaceId, threadId });
}

export async function setThreadName(
  workspaceId: string,
  threadId: string,
  name: string,
) {
  return invoke<any>("set_thread_name", { workspaceId, threadId, name });
}

export async function setTrayRecentThreads(entries: TrayRecentThreadEntry[]) {
  return invoke<void>("set_tray_recent_threads", { entries });
}

export async function setTrayLabels(labels: TrayLabels) {
  return invoke<void>("set_tray_labels", { labels });
}

export async function setTraySessionUsage(usage: TraySessionUsage | null) {
  return invoke<void>("set_tray_session_usage", { usage });
}

export async function generateCommitMessage(
  workspaceId: string,
  commitMessageModelId: string | null,
): Promise<string> {
  return invoke("generate_commit_message", { workspaceId, commitMessageModelId });
}

export type GeneratedAgentConfiguration = {
  description: string;
  developerInstructions: string;
};

export async function generateAgentDescription(
  workspaceId: string,
  description: string,
): Promise<GeneratedAgentConfiguration> {
  return invoke("generate_agent_description", { workspaceId, description });
}

export type AppBuildType = "debug" | "release";

export async function getAppBuildType(): Promise<AppBuildType> {
  return invoke<AppBuildType>("app_build_type");
}

export async function sendNotification(
  title: string,
  body: string,
  options?: {
    id?: number;
    group?: string;
    actionTypeId?: string;
    sound?: string;
    autoCancel?: boolean;
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  const macosDebugBuild = await invoke<boolean>("is_macos_debug_build").catch(
    () => false,
  );
  const attemptFallback = async () => {
    try {
      await invoke("send_notification_fallback", { title, body });
      return true;
    } catch (error) {
      console.warn("Notification fallback failed.", { error });
      return false;
    }
  };

  // In dev builds on macOS, the notification plugin can silently fail because
  // the process is not a bundled app. Prefer the native AppleScript fallback.
  if (macosDebugBuild) {
    await attemptFallback();
    return;
  }

  try {
    const notification = await import("@tauri-apps/plugin-notification");
    let permissionGranted = await notification.isPermissionGranted();
    if (!permissionGranted) {
      const permission = await notification.requestPermission();
      permissionGranted = permission === "granted";
      if (!permissionGranted) {
        console.warn("Notification permission not granted.", { permission });
        await attemptFallback();
        return;
      }
    }
    if (permissionGranted) {
      const payload: NotificationOptions = { title, body };
      if (options?.id !== undefined) {
        payload.id = options.id;
      }
      if (options?.group !== undefined) {
        payload.group = options.group;
      }
      if (options?.actionTypeId !== undefined) {
        payload.actionTypeId = options.actionTypeId;
      }
      if (options?.sound !== undefined) {
        payload.sound = options.sound;
      }
      if (options?.autoCancel !== undefined) {
        payload.autoCancel = options.autoCancel;
      }
      if (options?.extra !== undefined) {
        payload.extra = options.extra;
      }
      await notification.sendNotification(payload);
      return;
    }
  } catch (error) {
    console.warn("Notification plugin failed.", { error });
  }

  await attemptFallback();
}

let transientNotificationId = Math.floor(Date.now() % 2_000_000_000);

export async function sendTransientNotification(
  title: string,
  body: string,
  durationMs: number,
): Promise<void> {
  transientNotificationId = (transientNotificationId + 1) % 2_000_000_000;
  const id = transientNotificationId;
  await sendNotification(title, body, { id, autoCancel: true });
  globalThis.setTimeout(() => {
    void removeActive([{ id }]).catch(() => {
      // Fallback notifications and unsupported runtimes cannot be removed explicitly.
    });
  }, durationMs);
}
