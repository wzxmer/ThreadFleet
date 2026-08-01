import { useCallback, useRef, useState } from "react";
import type { Dispatch, MutableRefObject } from "react";
import * as Sentry from "@sentry/react";
import type {
  AppMention,
  ComputerControlRouteDecision,
  CodexProviderKind,
  ComposerSendIntent,
  RateLimitSnapshot,
  CustomPromptOption,
  DebugEntry,
  ReviewTarget,
  SendMessageResult,
  ServiceTier,
  SkillOption,
  WorkflowAgentOption,
  WorkflowHostPreflightPreview,
  WorkflowAdditionalContext,
  WorkflowRuntimeMode,
  WorkspaceInfo,
} from "@/types";
import {
  compactThread as compactThreadService,
  createContentReference,
  promoteComposerImages,
  sendUserMessage as sendUserMessageService,
  steerTurn as steerTurnService,
  startReview as startReviewService,
  interruptTurn as interruptTurnService,
  getAppsList as getAppsListService,
  listMcpServerStatus as listMcpServerStatusService,
  readWorkspaceFile,
  rollbackThread as rollbackThreadService,
  workflowPreflightPreview as workflowPreflightPreviewService,
  computerControlPreflight as computerControlPreflightService,
} from "@services/tauri";
import { useI18n } from "@/features/i18n/I18nProvider";
import { buildWorkflowPreflightPreview } from "@/features/workflow/utils/workflowPreflight";
import { compileWorkflowAdditionalContext } from "@/features/workflow/utils/workflowContext";
import {
  buildContentReferencePrompt,
  estimateReferenceTokens,
  SMART_CONTENT_REFERENCE_TOKEN_THRESHOLD,
} from "@/features/messages/utils/messageReferences";
import { expandCustomPromptText } from "@utils/customPrompts";
import {
  attachmentDisplayName,
  attachmentNameFromDataUrl,
  isImageAttachment,
} from "@utils/attachments";
import {
  asString,
  extractReviewThreadId,
  extractRpcErrorMessage,
  parseReviewTarget,
} from "@threads/utils/threadNormalize";
import type { ThreadAction, ThreadState } from "./useThreadsReducer";
import { useReviewPrompt } from "./useReviewPrompt";
import {
  buildAppsLines,
  buildMcpStatusLines,
  buildReviewThreadTitle,
  buildStatusLines,
  buildTurnStartPayload,
  isStaleSteerTurnError,
  isThreadNotFoundError,
  parseFastCommand,
  resolveSendMessageOptions,
  type SendMessageOptions,
} from "./threadMessagingHelpers";

const TEXT_ATTACHMENT_EXTENSIONS = /\.(txt|md|markdown|json|jsonc|yaml|yml|toml|xml|html?|css|scss|sass|less|js|jsx|ts|tsx|mjs|cjs|rs|go|py|rb|php|java|kt|kts|swift|c|cc|cpp|cxx|h|hpp|cs|sh|bash|zsh|fish|ps1|bat|cmd|sql|csv|tsv|log|diff|patch|ini|env|gitignore|dockerfile)$/i;
const WORKFLOW_PREFLIGHT_TIMEOUT_MS = 1_500;
const COMPUTER_CONTROL_PREFLIGHT_TIMEOUT_MS = 1_500;
const PLAN_CONSISTENCY_CONTEXT: WorkflowAdditionalContext = {
  "cm.plan-consistency": {
    kind: "application",
    value:
      "If you use update_plan, keep step statuses current and issue one final plan update before the final response. Never mark unfinished work completed.",
  },
};

type OptimisticUserMessage = {
  id: string;
  timestamp: number;
  images: string[];
  attachments: string[];
  turnId?: string;
};

type PendingTurnStart = {
  requestId: string;
  startedAt: number;
};

type PendingTurnStartHandle = PendingTurnStart & {
  threadId: string;
};

function createOptimisticUserMessage(
  attachments: string[],
  replaceMessageId?: string,
): OptimisticUserMessage {
  const timestamp = Date.now();
  return {
    id: replaceMessageId ?? `local-user-${timestamp}`,
    timestamp,
    images: attachments.filter(isImageAttachment),
    attachments: attachments.filter((attachment) => !isImageAttachment(attachment)),
  };
}

async function workflowPreflightWithTimeout(
  promise: Promise<WorkflowHostPreflightPreview>,
) {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("workflow preflight timed out")),
          WORKFLOW_PREFLIGHT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function computerControlPreflightWithTimeout(
  promise: Promise<ComputerControlRouteDecision>,
) {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("computer control preflight timed out")),
          COMPUTER_CONTROL_PREFLIGHT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function escapeAttachedFileAttr(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function normalizePathForCompare(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function getWorkspaceRelativeAttachmentPath(workspacePath: string, path: string) {
  const normalizedWorkspace = normalizePathForCompare(workspacePath);
  const normalizedPath = normalizePathForCompare(path);
  const lowerWorkspace = normalizedWorkspace.toLowerCase();
  const lowerPath = normalizedPath.toLowerCase();
  if (lowerPath === lowerWorkspace) {
    return "";
  }
  if (!lowerPath.startsWith(`${lowerWorkspace}/`)) {
    return null;
  }
  return normalizedPath.slice(normalizedWorkspace.length + 1);
}

function decodeDataUrlTextAttachment(dataUrl: string): {
  name: string;
  content: string;
} | null {
  if (!dataUrl.startsWith("data:")) {
    return null;
  }
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) {
    return null;
  }
  const meta = dataUrl.slice("data:".length, commaIndex);
  if (meta.startsWith("image/")) {
    return null;
  }
  const encoded = dataUrl.slice(commaIndex + 1);
  const name = attachmentNameFromDataUrl(dataUrl) || "pasted-file";
  try {
    const bytes = meta.split(";").some((part) => part.toLowerCase() === "base64")
      ? Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(encoded));
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { name, content };
  } catch {
    return null;
  }
}

function contentReferenceKind(sourceName: string): "attachment" | "log" | "diff" {
  if (/\.log$/i.test(sourceName)) {
    return "log";
  }
  if (/\.(diff|patch)$/i.test(sourceName)) {
    return "diff";
  }
  return "attachment";
}

async function buildAttachmentContentBlock(
  workspaceId: string,
  sourceName: string,
  content: string,
) {
  if (estimateReferenceTokens(content) < SMART_CONTENT_REFERENCE_TOKEN_THRESHOLD) {
    return null;
  }
  const sourceKind = contentReferenceKind(sourceName);
  try {
    const reference = await createContentReference({
      workspaceId,
      sourceKind,
      sourceName,
      content,
    });
    return buildContentReferencePrompt({
      referenceId: reference.referenceId,
      path: reference.path,
      sourceKind,
      sourceName,
      characterCount: reference.characterCount,
      estimatedTokens: reference.estimatedTokens,
    });
  } catch {
    // Older remote daemons may not support content references yet. Preserve send behavior.
    return null;
  }
}

async function prepareMessageAttachmentsForSend({
  workspace,
  text,
  attachments,
}: {
  workspace: WorkspaceInfo;
  text: string;
  attachments: string[];
}): Promise<{ text: string; images: string[]; displayAttachments: string[] }> {
  const images: string[] = [];
  const attachedFileBlocks: string[] = [];
  const displayAttachments: string[] = [];

  for (const attachment of attachments) {
    if (isImageAttachment(attachment)) {
      images.push(attachment);
      continue;
    }

    displayAttachments.push(attachment);

    const dataText = decodeDataUrlTextAttachment(attachment);
    if (dataText) {
      if (new TextEncoder().encode(dataText.content).byteLength > 1024 * 1024) {
        throw new Error(
          `Attachment "${attachmentDisplayName(attachment)}" exceeds the inline text limit and was not sent.`,
        );
      }
      const contentReference = await buildAttachmentContentBlock(
        workspace.id,
        dataText.name,
        dataText.content,
      );
      if (contentReference) {
        attachedFileBlocks.push(contentReference);
        continue;
      }
      attachedFileBlocks.push(
        `<attached_file path="${escapeAttachedFileAttr(dataText.name)}" name="${escapeAttachedFileAttr(dataText.name)}">\n${dataText.content}\n</attached_file>`,
      );
      continue;
    }

    const relativePath = getWorkspaceRelativeAttachmentPath(workspace.path, attachment);
    if (!relativePath) {
      throw new Error(
        `Unsupported attachment "${attachmentDisplayName(attachment)}". Text attachments must be inside the current workspace; binary files are not sent.`,
      );
    }
    if (!TEXT_ATTACHMENT_EXTENSIONS.test(relativePath)) {
      throw new Error(
        `Unsupported attachment "${attachmentDisplayName(attachment)}". Only UTF-8 text files and images can be sent.`,
      );
    }
    const response = await readWorkspaceFile(workspace.id, relativePath);
    if (response.truncated) {
      throw new Error(
        `Attachment "${attachmentDisplayName(attachment)}" exceeds the inline text limit and was not sent.`,
      );
    }
    const contentReference = await buildAttachmentContentBlock(
      workspace.id,
      relativePath,
      response.content,
    );
    if (contentReference) {
      attachedFileBlocks.push(contentReference);
      continue;
    }
    attachedFileBlocks.push(
      `<attached_file path="${escapeAttachedFileAttr(relativePath)}" name="${escapeAttachedFileAttr(attachmentDisplayName(attachment))}">\n${response.content}\n</attached_file>`,
    );
  }

  return {
    text: attachedFileBlocks.length > 0
      ? [text, ...attachedFileBlocks].filter(Boolean).join("\n\n")
      : text,
    images,
    displayAttachments,
  };
}

type UseThreadMessagingOptions = {
  activeWorkspace: WorkspaceInfo | null;
  activeThreadId: string | null;
  accessMode?: "read-only" | "current" | "full-access";
  model?: string | null;
  workflowProviderKind?: CodexProviderKind;
  workflowRuntimeMode?: WorkflowRuntimeMode;
  computerControlRoutingEnabled?: boolean;
  workflowSkills?: SkillOption[];
  workflowAgents?: WorkflowAgentOption[];
  getWorkflowGateId?: (workspaceId: string, threadId: string) => string | null;
  effort?: string | null;
  serviceTier?: ServiceTier | null | undefined;
  collaborationMode?: Record<string, unknown> | null;
  onSelectServiceTier?: (tier: ServiceTier | null | undefined) => void;
  reviewDeliveryMode?: "inline" | "detached";
  steerEnabled: boolean;
  customPrompts: CustomPromptOption[];
  ensureWorkspaceRuntimeCodexArgs?: (
    workspaceId: string,
    threadId: string | null,
  ) => Promise<void>;
  threadStatusById: ThreadState["threadStatusById"];
  activeTurnIdByThread: ThreadState["activeTurnIdByThread"];
  rateLimitsByWorkspace: Record<string, RateLimitSnapshot | null>;
  pendingInterruptsRef: MutableRefObject<Set<string>>;
  dispatch: Dispatch<ThreadAction>;
  getCustomName: (workspaceId: string, threadId: string) => string | undefined;
  markProcessing: (
    threadId: string,
    isProcessing: boolean,
    timestamp?: number,
  ) => void;
  markReviewing: (threadId: string, isReviewing: boolean) => void;
  setActiveTurnId: (threadId: string, turnId: string | null) => void;
  recordThreadActivity: (
    workspaceId: string,
    threadId: string,
    timestamp?: number,
  ) => void;
  safeMessageActivity: () => void;
  onDebug?: (entry: DebugEntry) => void;
  pushThreadErrorMessage: (threadId: string, message: string) => void;
  ensureThreadForActiveWorkspace: () => Promise<string | null>;
  ensureThreadForWorkspace: (workspaceId: string) => Promise<string | null>;
  ensureThreadRuntimeForWorkspace?: (
    workspaceId: string,
    threadId: string,
    force?: boolean,
  ) => Promise<string | null>;
  refreshThread: (workspaceId: string, threadId: string) => Promise<string | null>;
  forkThreadForWorkspace: (
    workspaceId: string,
    threadId: string,
    options?: { activate?: boolean },
  ) => Promise<string | null>;
  updateThreadParent: (parentId: string, childIds: string[]) => void;
  registerDetachedReviewChild?: (
    workspaceId: string,
    parentId: string,
    childId: string,
  ) => void;
  renameThread?: (workspaceId: string, threadId: string, name: string) => void;
  onUserMessageCreated?: (
    workspaceId: string,
    threadId: string,
    text: string,
  ) => void;
  onUserTurnRequested?: (workspaceId: string, threadId: string) => void;
};

export function useThreadMessaging({
  activeWorkspace,
  activeThreadId,
  accessMode,
  model,
  workflowProviderKind = "openai",
  workflowRuntimeMode = "shadow",
  computerControlRoutingEnabled = true,
  workflowSkills = [],
  workflowAgents = [],
  getWorkflowGateId,
  effort,
  serviceTier,
  collaborationMode,
  onSelectServiceTier,
  reviewDeliveryMode = "inline",
  steerEnabled,
  customPrompts,
  ensureWorkspaceRuntimeCodexArgs,
  threadStatusById,
  activeTurnIdByThread,
  rateLimitsByWorkspace,
  pendingInterruptsRef,
  dispatch,
  getCustomName,
  markProcessing,
  markReviewing,
  setActiveTurnId,
  recordThreadActivity,
  safeMessageActivity,
  onDebug,
  pushThreadErrorMessage,
  ensureThreadForActiveWorkspace,
  ensureThreadForWorkspace,
  ensureThreadRuntimeForWorkspace,
  refreshThread,
  forkThreadForWorkspace,
  updateThreadParent,
  registerDetachedReviewChild,
  renameThread,
  onUserMessageCreated,
  onUserTurnRequested,
}: UseThreadMessagingOptions) {
  const { t } = useI18n();
  const interruptInFlightRef = useRef(new Set<string>());
  const pendingTurnStartSequenceRef = useRef(0);
  const computerControlDecisionByThreadRef = useRef(
    new Map<string, { turnId: string | null; decisionId: string }>(),
  );
  const [pendingTurnStartByThread, setPendingTurnStartByThread] = useState<
    Record<string, PendingTurnStart>
  >({});
  const beginPendingTurnStart = useCallback(
    (threadId: string): PendingTurnStartHandle => {
      pendingTurnStartSequenceRef.current += 1;
      const pending = {
        threadId,
        requestId: `${threadId}-${Date.now()}-${pendingTurnStartSequenceRef.current}`,
        startedAt: Date.now(),
      };
      setPendingTurnStartByThread((current) => ({
        ...current,
        [threadId]: {
          requestId: pending.requestId,
          startedAt: pending.startedAt,
        },
      }));
      return pending;
    },
    [],
  );
  const clearPendingTurnStart = useCallback((pending: PendingTurnStartHandle | null) => {
    if (!pending) {
      return;
    }
    setPendingTurnStartByThread((current) => {
      if (current[pending.threadId]?.requestId !== pending.requestId) {
        return current;
      }
      const { [pending.threadId]: _, ...rest } = current;
      return rest;
    });
  }, []);
  const upsertOptimisticUserMessage = useCallback(
    (
      workspace: WorkspaceInfo,
      threadId: string,
      text: string,
      message: OptimisticUserMessage,
      replaceExisting: boolean,
    ) => {
      const customThreadName = getCustomName(workspace.id, threadId) ?? null;
      dispatch({
        type: "upsertItem",
        workspaceId: workspace.id,
        threadId,
        item: {
          id: message.id,
          kind: "message",
          role: "user",
          text,
          createdAt: message.timestamp,
          images: message.images,
          attachments: message.attachments,
          turnId: message.turnId,
        },
        replaceExisting,
        hasCustomName: Boolean(customThreadName),
      });
    },
    [dispatch, getCustomName],
  );

  const insertOptimisticUserMessage = useCallback(
    (
      workspace: WorkspaceInfo,
      threadId: string,
      text: string,
      attachments: string[],
      replaceMessageId?: string,
      existingMessage?: OptimisticUserMessage,
    ): OptimisticUserMessage => {
      const message =
        existingMessage ?? createOptimisticUserMessage(attachments, replaceMessageId);
      upsertOptimisticUserMessage(
        workspace,
        threadId,
        text,
        message,
        Boolean(replaceMessageId),
      );
      recordThreadActivity(workspace.id, threadId, message.timestamp);
      dispatch({
        type: "setThreadTimestamp",
        workspaceId: workspace.id,
        threadId,
        timestamp: message.timestamp,
      });
      safeMessageActivity();
      return message;
    },
    [
      dispatch,
      recordThreadActivity,
      safeMessageActivity,
      upsertOptimisticUserMessage,
    ],
  );

  const sendMessageToThread = useCallback(
    async (
      workspace: WorkspaceInfo,
      threadId: string,
      text: string,
      images: string[] = [],
      options?: SendMessageOptions,
      existingOptimisticMessage?: OptimisticUserMessage,
      existingPendingTurnStart?: PendingTurnStartHandle | null,
    ): Promise<SendMessageResult> => {
      const messageText = text.trim();
      if (!messageText && images.length === 0) {
        return { status: "blocked" };
      }
      let finalText = messageText;
      if (!options?.skipPromptExpansion) {
        const promptExpansion = expandCustomPromptText(messageText, customPrompts);
        if (promptExpansion && "error" in promptExpansion) {
          pushThreadErrorMessage(threadId, promptExpansion.error);
          safeMessageActivity();
          return { status: "blocked" };
        }
        finalText = promptExpansion?.expanded ?? messageText;
      }
      const isProcessing = threadStatusById[threadId]?.isProcessing ?? false;
      const activeTurnId = activeTurnIdByThread[threadId] ?? null;
      const {
        resolvedModel,
        resolvedEffort,
        resolvedServiceTier,
        sanitizedCollaborationMode,
        resolvedAccessMode,
        appMentions,
        sendIntent,
        shouldSteer,
        requestMode,
      } = resolveSendMessageOptions({
        options,
        defaults: {
          accessMode,
          model,
          effort,
          serviceTier,
          collaborationMode,
          steerEnabled,
          isProcessing,
          activeTurnId,
        },
      });
      let pendingTurnStart: PendingTurnStartHandle | null = null;
      if (!shouldSteer && requestMode === "start") {
        if (existingPendingTurnStart?.threadId === threadId) {
          pendingTurnStart = existingPendingTurnStart;
        } else {
          clearPendingTurnStart(existingPendingTurnStart ?? null);
          pendingTurnStart = beginPendingTurnStart(threadId);
        }
      } else {
        clearPendingTurnStart(existingPendingTurnStart ?? null);
      }
      if (!shouldSteer && requestMode === "start") {
        onUserTurnRequested?.(workspace.id, threadId);
      }
      if (
        !shouldSteer &&
        !options?.skipRuntimePreflight &&
        ensureWorkspaceRuntimeCodexArgs
      ) {
        try {
          await ensureWorkspaceRuntimeCodexArgs(workspace.id, threadId);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          onDebug?.({
            id: `${Date.now()}-client-turn-runtime-preflight-error`,
            timestamp: Date.now(),
            source: "error",
            label: "turn/runtime preflight error",
            payload: errorMessage,
          });
          pushThreadErrorMessage(threadId, errorMessage);
          safeMessageActivity();
          clearPendingTurnStart(pendingTurnStart);
          return { status: "blocked" };
        }
      }
      if (!shouldSteer && ensureThreadRuntimeForWorkspace) {
        let resumedThreadId: string | null;
        try {
          resumedThreadId = await ensureThreadRuntimeForWorkspace(
            workspace.id,
            threadId,
          );
        } catch (error) {
          clearPendingTurnStart(pendingTurnStart);
          throw error;
        }
        if (!resumedThreadId) {
          pushThreadErrorMessage(threadId, t("threads.runtimeResumeFailed"));
          safeMessageActivity();
          clearPendingTurnStart(pendingTurnStart);
          return { status: "blocked" };
        }
      }
      const optimisticMessage = existingOptimisticMessage ??
        insertOptimisticUserMessage(
          workspace,
          threadId,
          finalText,
          images,
          options?.replaceMessageId,
        );
      if (existingOptimisticMessage) {
        upsertOptimisticUserMessage(
          workspace,
          threadId,
          finalText,
          optimisticMessage,
          Boolean(options?.replaceMessageId),
        );
      }
      const removeStartOptimisticMessage = () => {
        if (options?.replaceMessageId) {
          return;
        }
        dispatch({
          type: "removeItem",
          threadId,
          itemId: optimisticMessage.id,
        });
      };
      let preparedAttachments: {
        text: string;
        images: string[];
        displayAttachments: string[];
      };
      if (images.some((attachment) => !isImageAttachment(attachment))) {
        try {
          preparedAttachments = await prepareMessageAttachmentsForSend({
            workspace,
            text: finalText,
            attachments: images,
          });
        } catch (error) {
          pushThreadErrorMessage(
            threadId,
            error instanceof Error ? error.message : String(error),
          );
          safeMessageActivity();
          clearPendingTurnStart(pendingTurnStart);
          removeStartOptimisticMessage();
          return { status: "blocked" };
        }
      } else {
        preparedAttachments = {
          text: finalText,
          images,
          displayAttachments: [],
        };
      }
      if (preparedAttachments.images.length > 0) {
        try {
          const promotedImages = await promoteComposerImages(
            workspace.id,
            threadId,
            preparedAttachments.images,
          );
          preparedAttachments = {
            ...preparedAttachments,
            images: promotedImages,
          };
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          pushThreadErrorMessage(
            threadId,
            `${t("composer.attachmentPersistFailed")} ${detail}`,
          );
          safeMessageActivity();
          clearPendingTurnStart(pendingTurnStart);
          removeStartOptimisticMessage();
          return { status: "blocked" };
        }
      }
      const attachmentsChanged =
        preparedAttachments.images.length !== optimisticMessage.images.length ||
        preparedAttachments.displayAttachments.length !==
          optimisticMessage.attachments.length ||
        preparedAttachments.images.some(
          (image, index) => image !== optimisticMessage.images[index],
        ) ||
        preparedAttachments.displayAttachments.some(
          (attachment, index) => attachment !== optimisticMessage.attachments[index],
        );
      if (attachmentsChanged) {
        upsertOptimisticUserMessage(
          workspace,
          threadId,
          finalText,
          {
            ...optimisticMessage,
            images: preparedAttachments.images,
            attachments: preparedAttachments.displayAttachments,
          },
          Boolean(options?.replaceMessageId),
        );
      }
      const existingComputerControlDecision =
        computerControlDecisionByThreadRef.current.get(threadId);
      const computerControlDecisionId =
        shouldSteer &&
          activeTurnId &&
          existingComputerControlDecision?.turnId === activeTurnId
          ? existingComputerControlDecision.decisionId
          : `cmcc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      computerControlDecisionByThreadRef.current.set(threadId, {
        turnId: shouldSteer ? activeTurnId : null,
        decisionId: computerControlDecisionId,
      });
      const computerControlPreviewPromise: Promise<{
        decision: ComputerControlRouteDecision | null;
        error: unknown;
      }> = computerControlRoutingEnabled
        ? computerControlPreflightWithTimeout(
          computerControlPreflightService(
            workspace.id,
            finalText,
            computerControlDecisionId,
          ),
        ).then(
          (decision) => ({ decision, error: null }),
          (error: unknown) => ({ decision: null, error }),
        )
        : Promise.resolve({ decision: null, error: null });
      const workflowEnabled = workflowRuntimeMode !== "off";
      const workflowPreview = workflowEnabled
        ? buildWorkflowPreflightPreview({
          task: finalText,
          skills: workflowSkills,
          providerKind: workflowProviderKind,
          model: resolvedModel ?? null,
          mode: workflowRuntimeMode,
        })
        : null;
      if (workflowPreview) {
        onDebug?.({
          id: `${Date.now()}-client-workflow-preflight`,
          timestamp: Date.now(),
          source: "client",
          label: "workflow/preflight",
          payload: workflowPreview,
        });
      }
      const hostPreviewPromise: Promise<{
        preview: WorkflowHostPreflightPreview | null;
        error: unknown;
      }> = workflowEnabled
        ? workflowPreflightWithTimeout(
          workflowPreflightPreviewService(
            workspace.id,
            finalText,
            workflowProviderKind,
            resolvedModel ?? null,
            workflowRuntimeMode,
            getWorkflowGateId?.(workspace.id, threadId) ?? null,
          ),
        ).then(
          (preview) => ({ preview, error: null }),
          (error: unknown) => ({ preview: null, error }),
        )
        : Promise.resolve({ preview: null, error: null });
      Sentry.metrics.count("prompt_sent", 1, {
        attributes: {
          workspace_id: workspace.id,
          thread_id: threadId,
          has_images: preparedAttachments.images.length > 0 ? "true" : "false",
          text_length: String(preparedAttachments.text.length),
          model: resolvedModel ?? "unknown",
          effort: resolvedEffort ?? "unknown",
          service_tier: resolvedServiceTier ?? "default",
          collaboration_mode: sanitizedCollaborationMode ?? "unknown",
          send_intent: sendIntent,
        },
      });
      const customThreadName = getCustomName(workspace.id, threadId) ?? null;
      markProcessing(
        threadId,
        true,
        pendingTurnStart?.startedAt ?? optimisticMessage.timestamp,
      );
      clearPendingTurnStart(pendingTurnStart);
      if (!options?.replaceMessageId && requestMode === "start") {
        void onUserMessageCreated?.(workspace.id, threadId, finalText);
      }
      onDebug?.({
        id: `${Date.now()}-${shouldSteer ? "client-turn-steer" : "client-turn-start"}`,
        timestamp: Date.now(),
        source: "client",
        label: shouldSteer ? "turn/steer" : "turn/start",
        payload: {
          workspaceId: workspace.id,
          threadId,
          turnId: activeTurnId,
          text: preparedAttachments.text,
          images: preparedAttachments.images,
          model: resolvedModel,
          effort: resolvedEffort,
          serviceTier: resolvedServiceTier,
          collaborationMode: sanitizedCollaborationMode,
          sendIntent,
          threadCustomName: customThreadName,
        },
      });
      try {
        const computerControlPreviewResult = await computerControlPreviewPromise;
        const computerControlDecision = computerControlPreviewResult.decision;
        if (computerControlDecision) {
          onDebug?.({
            id: `${Date.now()}-client-computer-control-preflight`,
            timestamp: Date.now(),
            source: "client",
            label: "computer-control/preflight",
            payload: {
              decisionId: computerControlDecision.decisionId,
              taskKind: computerControlDecision.taskKind,
              primaryBackend: computerControlDecision.primaryBackend,
              availability: computerControlDecision.availability,
              enforcement: computerControlDecision.enforcement,
              executionHost: computerControlDecision.executionHost,
              contextApplied: Boolean(computerControlDecision.contextFragment),
            },
          });
        } else if (computerControlPreviewResult.error) {
          const error = computerControlPreviewResult.error;
          onDebug?.({
            id: `${Date.now()}-client-computer-control-preflight-error`,
            timestamp: Date.now(),
            source: "error",
            label: "computer-control/preflight error",
            payload:
              extractRpcErrorMessage(error) ??
              (error instanceof Error ? error.message : String(error)),
          });
        }
        let hostPreview: WorkflowHostPreflightPreview | null = null;
        const hostPreviewResult = await hostPreviewPromise;
        if (hostPreviewResult.preview) {
          hostPreview = hostPreviewResult.preview;
          onDebug?.({
            id: `${Date.now()}-client-workflow-host-preflight`,
            timestamp: Date.now(),
            source: "client",
            label: "workflow/host preflight",
            payload: {
              mode: hostPreview.mode,
              providerKind: hostPreview.providerKind,
              model: hostPreview.model,
              taskLength: hostPreview.taskLength,
              rulePaths: hostPreview.rules.map((rule) => rule.path),
              knowledgePaths: hostPreview.knowledgeCandidates.map((candidate) => candidate.path),
              impactSummary: hostPreview.impactSummary,
              validationSummary: hostPreview.validationSuggestions.join(", "),
              sourceErrors: hostPreview.sourceErrors,
              knowledgeCacheHit: hostPreview.knowledgeCacheHit,
              workflowGate: hostPreview.workflowGate ?? null,
              contextPlan: hostPreview.contextPlan ?? null,
              completionPlan: hostPreview.completionPlan
                ? {
                  required: hostPreview.completionPlan.required,
                  phase: hostPreview.completionPlan.phase,
                  validations: hostPreview.completionPlan.validations.map((gate) => ({
                    id: gate.id,
                    kind: gate.kind,
                    instruction: gate.instruction,
                    status: gate.status,
                  })),
                  changedDiffReview: hostPreview.completionPlan.changedDiffReview,
                  knowledgeCapture: {
                    status: hostPreview.completionPlan.knowledgeCapture.status,
                    category: hostPreview.completionPlan.knowledgeCapture.category,
                    submissionMode: hostPreview.completionPlan.knowledgeCapture.submissionMode,
                  },
                }
                : null,
            },
          });
        } else if (hostPreviewResult.error) {
          const error = hostPreviewResult.error;
          const errorMessage =
            extractRpcErrorMessage(error) ??
            (error instanceof Error ? error.message : String(error));
          onDebug?.({
            id: `${Date.now()}-client-workflow-host-preflight-error`,
            timestamp: Date.now(),
            source: "error",
            label: "workflow/host preflight error",
            payload: errorMessage,
          });
        }
        const workflowContext = workflowPreview
          ? compileWorkflowAdditionalContext({
            task: finalText,
            preview: workflowPreview,
            hostPreview,
            skills: workflowSkills,
            agents: workflowAgents,
          })
          : {
            additionalContext: {},
            selectedAgents: [],
            includedSkills: [],
            blockedSkills: [],
            omittedSources: [],
            truncatedSources: [],
            contextSummary: "off",
          };
        const appliedWorkflowContext = workflowRuntimeMode === "active"
          ? workflowContext.additionalContext
          : {};
        const computerControlContext: WorkflowAdditionalContext =
          computerControlDecision?.contextFragment
            ? {
              "cm.computer-control": {
                kind: "application",
                value: computerControlDecision.contextFragment,
              },
            }
            : {};
        const appliedAdditionalContext: WorkflowAdditionalContext = {
          ...PLAN_CONSISTENCY_CONTEXT,
          ...appliedWorkflowContext,
          ...computerControlContext,
        };
        if (workflowPreview) {
          onDebug?.({
            id: `${Date.now()}-client-workflow-context-compiled`,
            timestamp: Date.now(),
            source: "client",
            label: "workflow/context compiled",
            payload: {
              mode: workflowRuntimeMode,
              applied: workflowRuntimeMode === "active",
              summary: workflowContext.contextSummary,
              sourceIds: Object.keys(workflowContext.additionalContext),
              contextFingerprint: hostPreview?.contextPlan?.contextFingerprint ?? null,
            },
          });
        }
        const turnStartPayload = {
          ...buildTurnStartPayload({
            model: resolvedModel,
            effort: resolvedEffort,
            serviceTier: resolvedServiceTier,
            collaborationMode: sanitizedCollaborationMode,
            accessMode: resolvedAccessMode,
            images: preparedAttachments.images,
            appMentions,
          }),
          ...(Object.keys(appliedAdditionalContext).length > 0
            ? { additionalContext: appliedAdditionalContext }
            : {}),
        };
        const sendTurnStartRequest = async () =>
          (await sendUserMessageService(
            workspace.id,
            threadId,
            preparedAttachments.text,
            turnStartPayload,
          )) as Record<string, unknown>;
        let turnStartRecoveryAttempted = false;
        const recoverMissingThreadRuntime = async (error: unknown) => {
          if (
            turnStartRecoveryAttempted ||
            !ensureThreadRuntimeForWorkspace ||
            !isThreadNotFoundError(error)
          ) {
            return false;
          }
          turnStartRecoveryAttempted = true;
          onDebug?.({
            id: `${Date.now()}-client-turn-start-runtime-recovery`,
            timestamp: Date.now(),
            source: "client",
            label: "turn/start runtime recovery",
            payload: {
              workspaceId: workspace.id,
              threadId,
              error: error instanceof Error ? error.message : String(error),
            },
          });
          const resumedThreadId = await ensureThreadRuntimeForWorkspace(
            workspace.id,
            threadId,
            true,
          );
          if (!resumedThreadId) {
            return false;
          }
          upsertOptimisticUserMessage(
            workspace,
            threadId,
            finalText,
            {
              ...optimisticMessage,
              images: preparedAttachments.images,
              attachments: preparedAttachments.displayAttachments,
            },
            Boolean(options?.replaceMessageId),
          );
          markProcessing(threadId, true, optimisticMessage.timestamp);
          return true;
        };

        let response: Record<string, unknown> = shouldSteer
          ? (await (appMentions.length > 0 ||
            Object.keys(appliedAdditionalContext).length > 0
            ? steerTurnService(
              workspace.id,
              threadId,
              activeTurnId ?? "",
              preparedAttachments.text,
              preparedAttachments.images,
              appMentions,
              appliedAdditionalContext,
            )
            : steerTurnService(
              workspace.id,
              threadId,
              activeTurnId ?? "",
              preparedAttachments.text,
              preparedAttachments.images,
            ))) as Record<string, unknown>
          : await (async () => {
            try {
              return await sendTurnStartRequest();
            } catch (error) {
              if (!(await recoverMissingThreadRuntime(error))) {
                throw error;
              }
              return sendTurnStartRequest();
            }
          })();

        let rpcError = extractRpcErrorMessage(response);
        if (
          requestMode === "start" &&
          rpcError &&
          await recoverMissingThreadRuntime(rpcError)
        ) {
          response = await sendTurnStartRequest();
          rpcError = extractRpcErrorMessage(response);
        }

        onDebug?.({
          id: `${Date.now()}-${requestMode === "steer" ? "server-turn-steer" : "server-turn-start"}`,
          timestamp: Date.now(),
          source: "server",
          label: requestMode === "steer" ? "turn/steer response" : "turn/start response",
          payload: response,
        });
        if (rpcError) {
          if (requestMode !== "steer") {
            markProcessing(threadId, false);
            setActiveTurnId(threadId, null);
            pushThreadErrorMessage(threadId, `Turn failed to start: ${rpcError}`);
            safeMessageActivity();
            removeStartOptimisticMessage();
            return { status: "blocked" };
          }
          if (isStaleSteerTurnError(rpcError)) {
            markProcessing(threadId, false);
            setActiveTurnId(threadId, null);
          }
          dispatch({
            type: "removeItem",
            threadId,
            itemId: optimisticMessage.id,
          });
          pushThreadErrorMessage(
            threadId,
            `Turn steer failed: ${rpcError}`,
          );
          safeMessageActivity();
          return { status: "steer_failed" };
        }
        if (requestMode === "steer") {
          const result = (response?.result ?? response) as Record<string, unknown>;
          const steeredTurnId = asString(result?.turnId ?? result?.turn_id ?? "");
          if (steeredTurnId) {
            setActiveTurnId(threadId, steeredTurnId);
            computerControlDecisionByThreadRef.current.set(threadId, {
              turnId: steeredTurnId,
              decisionId: computerControlDecisionId,
            });
          }
          return { status: "sent" };
        }
        const result = (response?.result ?? response) as Record<string, unknown>;
        const turn = (result?.turn ?? response?.turn ?? null) as
          | Record<string, unknown>
          | null;
        const turnId = asString(turn?.id ?? "");
        if (!turnId) {
          markProcessing(threadId, false);
          setActiveTurnId(threadId, null);
          pushThreadErrorMessage(threadId, "Turn failed to start.");
          safeMessageActivity();
          removeStartOptimisticMessage();
          return { status: "blocked" };
        }
        dispatch({
          type: "setItemTurnId",
          threadId,
          itemId: optimisticMessage.id,
          turnId,
        });
        setActiveTurnId(threadId, turnId);
        computerControlDecisionByThreadRef.current.set(threadId, {
          turnId,
          decisionId: computerControlDecisionId,
        });
        return { status: "sent" };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (requestMode !== "steer") {
          markProcessing(threadId, false);
          setActiveTurnId(threadId, null);
          removeStartOptimisticMessage();
        } else if (isStaleSteerTurnError(errorMessage)) {
          markProcessing(threadId, false);
          setActiveTurnId(threadId, null);
        }
        if (requestMode === "steer") {
          dispatch({
            type: "removeItem",
            threadId,
            itemId: optimisticMessage.id,
          });
        }
        onDebug?.({
          id: `${Date.now()}-${requestMode === "steer" ? "client-turn-steer-error" : "client-turn-start-error"}`,
          timestamp: Date.now(),
          source: "error",
          label: requestMode === "steer" ? "turn/steer error" : "turn/start error",
          payload: errorMessage,
        });
        pushThreadErrorMessage(
          threadId,
          requestMode === "steer"
            ? `Turn steer failed: ${errorMessage}`
            : errorMessage,
        );
        safeMessageActivity();
        return { status: requestMode === "steer" ? "steer_failed" : "blocked" };
      }
    },
    [
      accessMode,
      beginPendingTurnStart,
      clearPendingTurnStart,
      collaborationMode,
      computerControlRoutingEnabled,
      customPrompts,
      dispatch,
      effort,
      serviceTier,
      ensureWorkspaceRuntimeCodexArgs,
      ensureThreadRuntimeForWorkspace,
      activeTurnIdByThread,
      getCustomName,
      insertOptimisticUserMessage,
      markProcessing,
      model,
      workflowProviderKind,
      workflowRuntimeMode,
      workflowSkills,
      workflowAgents,
      getWorkflowGateId,
      onDebug,
      pushThreadErrorMessage,
      safeMessageActivity,
      setActiveTurnId,
      steerEnabled,
      threadStatusById,
      onUserMessageCreated,
      onUserTurnRequested,
      t,
      upsertOptimisticUserMessage,
    ],
  );

  const sendUserMessage = useCallback(
    async (
      text: string,
      images: string[] = [],
      appMentions: AppMention[] = [],
      options?: { sendIntent?: ComposerSendIntent; replaceMessageId?: string },
    ): Promise<SendMessageResult> => {
      if (!activeWorkspace) {
        return { status: "blocked" };
      }
      const messageText = text.trim();
      if (!messageText && images.length === 0) {
        return { status: "blocked" };
      }
      const promptExpansion = expandCustomPromptText(messageText, customPrompts);
      if (promptExpansion && "error" in promptExpansion) {
        if (activeThreadId) {
          pushThreadErrorMessage(activeThreadId, promptExpansion.error);
          safeMessageActivity();
        } else {
          onDebug?.({
            id: `${Date.now()}-client-prompt-expand-error`,
            timestamp: Date.now(),
            source: "error",
            label: "prompt/expand error",
            payload: promptExpansion.error,
          });
        }
        return { status: "blocked" };
      }
      const finalText = promptExpansion?.expanded ?? messageText;
      const pendingTurnStart =
        activeThreadId && !threadStatusById[activeThreadId]?.isProcessing
        ? beginPendingTurnStart(activeThreadId)
        : null;
      let runtimePreflightComplete = false;
      if (
        activeThreadId &&
        !threadStatusById[activeThreadId]?.isProcessing &&
        ensureWorkspaceRuntimeCodexArgs
      ) {
        try {
          await ensureWorkspaceRuntimeCodexArgs(activeWorkspace.id, activeThreadId);
          runtimePreflightComplete = true;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          onDebug?.({
            id: `${Date.now()}-client-turn-runtime-preflight-error`,
            timestamp: Date.now(),
            source: "error",
            label: "turn/runtime preflight error",
            payload: errorMessage,
          });
          pushThreadErrorMessage(activeThreadId, errorMessage);
          safeMessageActivity();
          clearPendingTurnStart(pendingTurnStart);
          return { status: "blocked" };
        }
      }
      const pendingOptimisticMessage = createOptimisticUserMessage(
        images,
        options?.replaceMessageId,
      );
      const optimisticMessage = activeThreadId
        ? insertOptimisticUserMessage(
          activeWorkspace,
          activeThreadId,
          finalText,
          images,
          options?.replaceMessageId,
          pendingOptimisticMessage,
        )
        : pendingOptimisticMessage;
      let optimisticThreadId = activeThreadId;
      const discardOptimisticMessage = () => {
        if (optimisticThreadId) {
          dispatch({
            type: "removeItem",
            threadId: optimisticThreadId,
            itemId: optimisticMessage.id,
          });
        }
      };
      let threadId: string | null;
      try {
        threadId = await ensureThreadForActiveWorkspace();
      } catch (error) {
        discardOptimisticMessage();
        clearPendingTurnStart(pendingTurnStart);
        throw error;
      }
      if (!threadId) {
        discardOptimisticMessage();
        clearPendingTurnStart(pendingTurnStart);
        return { status: "blocked" };
      }
      optimisticThreadId = threadId;
      let result: SendMessageResult;
      try {
        result = await sendMessageToThread(activeWorkspace, threadId, finalText, images, {
          skipPromptExpansion: true,
          skipRuntimePreflight: runtimePreflightComplete,
          appMentions,
          sendIntent: options?.sendIntent,
          replaceMessageId: options?.replaceMessageId,
        }, optimisticMessage, pendingTurnStart);
      } finally {
        clearPendingTurnStart(pendingTurnStart);
      }
      if (result.status === "blocked") {
        discardOptimisticMessage();
      }
      return result;
    },
    [
      activeThreadId,
      activeWorkspace,
      beginPendingTurnStart,
      clearPendingTurnStart,
      customPrompts,
      dispatch,
      ensureThreadForActiveWorkspace,
      ensureWorkspaceRuntimeCodexArgs,
      insertOptimisticUserMessage,
      onDebug,
      pushThreadErrorMessage,
      safeMessageActivity,
      sendMessageToThread,
      threadStatusById,
    ],
  );

  const retryEditedUserMessage = useCallback(
    async (
      text: string,
      images: string[] = [],
      options?: { replaceMessageId?: string },
    ): Promise<SendMessageResult> => {
      if (!activeWorkspace || !activeThreadId) {
        return { status: "blocked" };
      }
      try {
        await rollbackThreadService(activeWorkspace.id, activeThreadId, 1);
        const refreshedThreadId = await refreshThread(activeWorkspace.id, activeThreadId);
        if (!refreshedThreadId) {
          pushThreadErrorMessage(
            activeThreadId,
            "Thread rollback succeeded, but the refreshed history could not be loaded.",
          );
          safeMessageActivity();
          return { status: "blocked" };
        }
        return sendMessageToThread(activeWorkspace, activeThreadId, text, images, {
          replaceMessageId: options?.replaceMessageId,
        });
      } catch (error) {
        pushThreadErrorMessage(
          activeThreadId,
          `Failed to retry edited message: ${error instanceof Error ? error.message : String(error)}`,
        );
        safeMessageActivity();
        return { status: "blocked" };
      }
    },
    [
      activeThreadId,
      activeWorkspace,
      pushThreadErrorMessage,
      refreshThread,
      safeMessageActivity,
      sendMessageToThread,
    ],
  );

  const sendUserMessageToThread = useCallback(
    async (
      workspace: WorkspaceInfo,
      threadId: string,
      text: string,
      images: string[] = [],
      options?: SendMessageOptions,
    ): Promise<SendMessageResult> => {
      return sendMessageToThread(workspace, threadId, text, images, options);
    },
    [sendMessageToThread],
  );

  const interruptTurn = useCallback(async () => {
    if (!activeWorkspace || !activeThreadId) {
      return;
    }
    if (interruptInFlightRef.current.has(activeThreadId)) {
      return;
    }
    const activeTurnId = activeTurnIdByThread[activeThreadId] ?? null;
    const turnId = activeTurnId ?? "pending";
    const timestamp = Date.now();
    if (!activeTurnId) {
      pendingInterruptsRef.current.add(activeThreadId);
      markProcessing(activeThreadId, false);
      setActiveTurnId(activeThreadId, null);
      dispatch({
        type: "markThreadInterrupted",
        threadId: activeThreadId,
        timestamp,
      });
    }
    onDebug?.({
      id: `${Date.now()}-client-turn-interrupt`,
      timestamp: Date.now(),
      source: "client",
      label: "turn/interrupt",
      payload: {
        workspaceId: activeWorkspace.id,
        threadId: activeThreadId,
        turnId,
        queued: !activeTurnId,
      },
    });
    interruptInFlightRef.current.add(activeThreadId);
    try {
      const response = await interruptTurnService(
        activeWorkspace.id,
        activeThreadId,
        turnId,
      );
      if (activeTurnId) {
        dispatch({
          type: "completeTurnExecution",
          threadId: activeThreadId,
          turnId: activeTurnId,
          status: "interrupted",
          timestamp: Date.now(),
        });
        markProcessing(activeThreadId, false);
        setActiveTurnId(activeThreadId, null);
        dispatch({
          type: "markThreadInterrupted",
          threadId: activeThreadId,
          timestamp: Date.now(),
        });
      }
      onDebug?.({
        id: `${Date.now()}-server-turn-interrupt`,
        timestamp: Date.now(),
        source: "server",
        label: "turn/interrupt response",
        payload: response,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      onDebug?.({
        id: `${Date.now()}-client-turn-interrupt-error`,
        timestamp: Date.now(),
        source: "error",
        label: "turn/interrupt error",
        payload: errorMessage,
      });
      pushThreadErrorMessage(activeThreadId, errorMessage);
      safeMessageActivity();
    } finally {
      interruptInFlightRef.current.delete(activeThreadId);
    }
  }, [
    activeThreadId,
    activeTurnIdByThread,
    activeWorkspace,
    dispatch,
    markProcessing,
    onDebug,
    pendingInterruptsRef,
    pushThreadErrorMessage,
    safeMessageActivity,
    setActiveTurnId,
  ]);

  const startReviewTarget = useCallback(
    async (target: ReviewTarget, workspaceIdOverride?: string): Promise<boolean> => {
      const workspaceId = workspaceIdOverride ?? activeWorkspace?.id ?? null;
      if (!workspaceId) {
        return false;
      }
      const threadId = workspaceIdOverride
        ? await ensureThreadForWorkspace(workspaceId)
        : await ensureThreadForActiveWorkspace();
      if (!threadId) {
        return false;
      }

      const lockParentThread = reviewDeliveryMode !== "detached";
      if (lockParentThread) {
        markProcessing(threadId, true);
        markReviewing(threadId, true);
        safeMessageActivity();
      }
      onDebug?.({
        id: `${Date.now()}-client-review-start`,
        timestamp: Date.now(),
        source: "client",
        label: "review/start",
        payload: {
          workspaceId,
          threadId,
          target,
        },
      });
      try {
        const response = await startReviewService(
          workspaceId,
          threadId,
          target,
          reviewDeliveryMode,
        );
        onDebug?.({
          id: `${Date.now()}-server-review-start`,
          timestamp: Date.now(),
          source: "server",
          label: "review/start response",
          payload: response,
        });
        const rpcError = extractRpcErrorMessage(response);
        if (rpcError) {
          if (lockParentThread) {
            markProcessing(threadId, false);
            markReviewing(threadId, false);
            setActiveTurnId(threadId, null);
          }
          pushThreadErrorMessage(threadId, `Review failed to start: ${rpcError}`);
          safeMessageActivity();
          return false;
        }
        const reviewThreadId = extractReviewThreadId(response);
        if (reviewThreadId && reviewThreadId !== threadId) {
          updateThreadParent(threadId, [reviewThreadId]);
          if (reviewDeliveryMode === "detached") {
            registerDetachedReviewChild?.(workspaceId, threadId, reviewThreadId);
            const reviewTitle = buildReviewThreadTitle(target);
            if (reviewTitle && !getCustomName(workspaceId, reviewThreadId)) {
              renameThread?.(workspaceId, reviewThreadId, reviewTitle);
            }
          }
        }
        return true;
      } catch (error) {
        if (lockParentThread) {
          markProcessing(threadId, false);
          markReviewing(threadId, false);
        }
        onDebug?.({
          id: `${Date.now()}-client-review-start-error`,
          timestamp: Date.now(),
          source: "error",
          label: "review/start error",
          payload: error instanceof Error ? error.message : String(error),
        });
        pushThreadErrorMessage(
          threadId,
          error instanceof Error ? error.message : String(error),
        );
        safeMessageActivity();
        return false;
      }
    },
    [
      activeWorkspace,
      ensureThreadForActiveWorkspace,
      ensureThreadForWorkspace,
      getCustomName,
      markProcessing,
      markReviewing,
      onDebug,
      pushThreadErrorMessage,
      safeMessageActivity,
      setActiveTurnId,
      reviewDeliveryMode,
      registerDetachedReviewChild,
      renameThread,
      updateThreadParent,
    ],
  );

  const {
    reviewPrompt,
    openReviewPrompt,
    closeReviewPrompt,
    showPresetStep,
    choosePreset,
    highlightedPresetIndex,
    setHighlightedPresetIndex,
    highlightedBranchIndex,
    setHighlightedBranchIndex,
    highlightedCommitIndex,
    setHighlightedCommitIndex,
    handleReviewPromptKeyDown,
    confirmBranch,
    selectBranch,
    selectBranchAtIndex,
    selectCommit,
    selectCommitAtIndex,
    confirmCommit,
    updateCustomInstructions,
    confirmCustom,
  } = useReviewPrompt({
    activeWorkspace,
    activeThreadId,
    onDebug,
    startReviewTarget,
  });

  const startReview = useCallback(
    async (text: string) => {
      if (!activeWorkspace || !text.trim()) {
        return;
      }
      const trimmed = text.trim();
      const rest = trimmed.replace(/^\/review\b/i, "").trim();
      if (!rest) {
        openReviewPrompt();
        return;
      }

      const target = parseReviewTarget(trimmed);
      await startReviewTarget(target);
    },
    [
      activeWorkspace,
      openReviewPrompt,
      startReviewTarget,
    ],
  );

  const startUncommittedReview = useCallback(
    async (workspaceId?: string | null) => {
      const workspaceOverride = workspaceId ?? undefined;
      await startReviewTarget({ type: "uncommittedChanges" }, workspaceOverride);
    },
    [startReviewTarget],
  );

  const startStatus = useCallback(
    async (_text: string) => {
      if (!activeWorkspace) {
        return;
      }
      const threadId = await ensureThreadForActiveWorkspace();
      if (!threadId) {
        return;
      }

      const lines = buildStatusLines({
        model,
        serviceTier,
        effort,
        accessMode,
        collaborationMode,
        rateLimits: rateLimitsByWorkspace[activeWorkspace.id] ?? null,
      });
      const timestamp = Date.now();
      recordThreadActivity(activeWorkspace.id, threadId, timestamp);
      dispatch({
        type: "addAssistantMessage",
        threadId,
        text: lines.join("\n"),
      });
      safeMessageActivity();
    },
    [
      accessMode,
      activeWorkspace,
      collaborationMode,
      dispatch,
      effort,
      ensureThreadForActiveWorkspace,
      model,
      serviceTier,
      rateLimitsByWorkspace,
      recordThreadActivity,
      safeMessageActivity,
    ],
  );

  const startFast = useCallback(
    async (text: string) => {
      if (!activeWorkspace) {
        return;
      }
      const threadId = await ensureThreadForActiveWorkspace();
      if (!threadId) {
        return;
      }

      const action = parseFastCommand(text);
      const isEnabled = serviceTier === "fast";
      let nextTier = serviceTier ?? null;
      let message = "";

      if (action === "invalid") {
        message = "Usage: /fast, /fast on, /fast off, or /fast status.";
      } else if (action === "status") {
        message = `Fast mode is ${isEnabled ? "on" : "off"}.`;
      } else {
        nextTier =
          action === "on"
            ? "fast"
            : action === "off"
              ? null
              : isEnabled
                ? null
                : "fast";
        onSelectServiceTier?.(nextTier);
        message = `Fast mode ${nextTier === "fast" ? "enabled" : "disabled"}.`;
      }

      const timestamp = Date.now();
      recordThreadActivity(activeWorkspace.id, threadId, timestamp);
      dispatch({
        type: "addAssistantMessage",
        threadId,
        text: message,
      });
      safeMessageActivity();
    },
    [
      activeWorkspace,
      dispatch,
      ensureThreadForActiveWorkspace,
      onSelectServiceTier,
      recordThreadActivity,
      safeMessageActivity,
      serviceTier,
    ],
  );

  const startMcp = useCallback(
    async (_text: string) => {
      if (!activeWorkspace) {
        return;
      }
      const threadId = await ensureThreadForActiveWorkspace();
      if (!threadId) {
        return;
      }

      try {
        const response = (await listMcpServerStatusService(
          activeWorkspace.id,
          null,
          null,
        )) as Record<string, unknown> | null;
        const result = (response?.result ?? response) as
          | Record<string, unknown>
          | null;
        const data = Array.isArray(result?.data)
          ? (result?.data as Array<Record<string, unknown>>)
          : [];
        const lines = buildMcpStatusLines(data);

        const timestamp = Date.now();
        recordThreadActivity(activeWorkspace.id, threadId, timestamp);
        dispatch({
          type: "addAssistantMessage",
          threadId,
          text: lines.join("\n"),
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to load MCP status.";
        dispatch({
          type: "addAssistantMessage",
          threadId,
          text: `MCP tools:\n- ${message}`,
        });
      } finally {
        safeMessageActivity();
      }
    },
    [
      activeWorkspace,
      dispatch,
      ensureThreadForActiveWorkspace,
      recordThreadActivity,
      safeMessageActivity,
    ],
  );

  const startApps = useCallback(
    async (_text: string) => {
      if (!activeWorkspace) {
        return;
      }
      const threadId = await ensureThreadForActiveWorkspace();
      if (!threadId) {
        return;
      }

      try {
        const response = (await getAppsListService(
          activeWorkspace.id,
          null,
          100,
          threadId,
        )) as Record<string, unknown> | null;
        const result = (response?.result ?? response) as
          | Record<string, unknown>
          | null;
        const data = Array.isArray(result?.data)
          ? (result?.data as Array<Record<string, unknown>>)
          : [];
        const lines = buildAppsLines(data);

        const timestamp = Date.now();
        recordThreadActivity(activeWorkspace.id, threadId, timestamp);
        dispatch({
          type: "addAssistantMessage",
          threadId,
          text: lines.join("\n"),
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to load apps.";
        dispatch({
          type: "addAssistantMessage",
          threadId,
          text: `Apps:\n- ${message}`,
        });
      } finally {
        safeMessageActivity();
      }
    },
    [
      activeWorkspace,
      dispatch,
      ensureThreadForActiveWorkspace,
      recordThreadActivity,
      safeMessageActivity,
    ],
  );

  const startFork = useCallback(
    async (text: string) => {
      if (!activeWorkspace || !activeThreadId) {
        return;
      }
      const trimmed = text.trim();
      const rest = trimmed.replace(/^\/fork\b/i, "").trim();
      const threadId = await forkThreadForWorkspace(activeWorkspace.id, activeThreadId);
      if (!threadId) {
        return;
      }
      updateThreadParent(activeThreadId, [threadId]);
      if (rest) {
        await sendMessageToThread(activeWorkspace, threadId, rest, []);
      }
    },
    [
      activeThreadId,
      activeWorkspace,
      forkThreadForWorkspace,
      sendMessageToThread,
      updateThreadParent,
    ],
  );

  const startResume = useCallback(
    async (_text: string) => {
      if (!activeWorkspace) {
        return;
      }
      if (activeThreadId && threadStatusById[activeThreadId]?.isProcessing) {
        return;
      }
      const threadId = activeThreadId ?? (await ensureThreadForActiveWorkspace());
      if (!threadId) {
        return;
      }
      await refreshThread(activeWorkspace.id, threadId);
      safeMessageActivity();
    },
    [
      activeThreadId,
      activeWorkspace,
      ensureThreadForActiveWorkspace,
      refreshThread,
      safeMessageActivity,
      threadStatusById,
    ],
  );

  const startCompact = useCallback(
    async (_text: string) => {
      if (!activeWorkspace) {
        return;
      }
      const threadId = activeThreadId ?? (await ensureThreadForActiveWorkspace());
      if (!threadId) {
        return;
      }
      try {
        await compactThreadService(activeWorkspace.id, threadId);
      } catch (error) {
        pushThreadErrorMessage(
          threadId,
          error instanceof Error
            ? error.message
            : "Failed to start context compaction.",
        );
      } finally {
        safeMessageActivity();
      }
    },
    [
      activeThreadId,
      activeWorkspace,
      ensureThreadForActiveWorkspace,
      pushThreadErrorMessage,
      safeMessageActivity,
    ],
  );

  return {
    pendingTurnStartByThread,
    interruptTurn,
    retryEditedUserMessage,
    sendUserMessage,
    sendUserMessageToThread,
    startFork,
    startReview,
    startUncommittedReview,
    startResume,
    startCompact,
    startApps,
    startMcp,
    startFast,
    startStatus,
    reviewPrompt,
    openReviewPrompt,
    closeReviewPrompt,
    showPresetStep,
    choosePreset,
    highlightedPresetIndex,
    setHighlightedPresetIndex,
    highlightedBranchIndex,
    setHighlightedBranchIndex,
    highlightedCommitIndex,
    setHighlightedCommitIndex,
    handleReviewPromptKeyDown,
    confirmBranch,
    selectBranch,
    selectBranchAtIndex,
    selectCommit,
    selectCommitAtIndex,
    confirmCommit,
    updateCustomInstructions,
    confirmCustom,
  };
}
