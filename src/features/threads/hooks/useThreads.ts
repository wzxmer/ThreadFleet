import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import * as Sentry from "@sentry/react";
import type {
  CollabAgentRef,
  CustomPromptOption,
  DebugEntry,
  CodexProviderKind,
  SendMessageResult,
  ServiceTier,
  SkillOption,
  WorkflowAgentOption,
  WorkflowRuntimeMode,
  TokenEfficiencyMode,
  ThreadListSortKey,
  WorkspaceInfo,
  SubagentCheckpointSyncMode,
  TurnExecutionSummary,
  ExecutionBindingObserveInput,
} from "@/types";
import { CHAT_SCROLLBACK_DEFAULT } from "@utils/chatScrollback";
import { useAppServerEvents } from "@app/hooks/useAppServerEvents";
import { initialState, threadReducer } from "./useThreadsReducer";
import { useThreadStorage } from "./useThreadStorage";
import { useThreadLinking } from "./useThreadLinking";
import { useThreadEventHandlers } from "./useThreadEventHandlers";
import { useThreadActions } from "./useThreadActions";
import { useThreadMessaging } from "./useThreadMessaging";
import { useThreadApprovals } from "./useThreadApprovals";
import { useThreadAccountInfo } from "./useThreadAccountInfo";
import { useThreadRateLimits } from "./useThreadRateLimits";
import { useThreadSelectors } from "./useThreadSelectors";
import { useThreadStatus } from "./useThreadStatus";
import { useThreadStallWarnings } from "./useThreadStallWarnings";
import { useThreadUserInput } from "./useThreadUserInput";
import { useThreadTitleAutogeneration } from "./useThreadTitleAutogeneration";
import { useSubagentCheckpointSync } from "./useSubagentCheckpointSync";
import { useDetachedReviewTracking } from "./useDetachedReviewTracking";
import { useThreadAutoContinue } from "./useThreadAutoContinue";
import { useResidentThreadHistory } from "./useResidentThreadHistory";
import {
  archiveThread as archiveThreadService,
  listSessionSources as listSessionSourcesService,
  listWorkspaces as listWorkspacesService,
  readThread as readThreadService,
  getTurnExecutionSummaries,
  upsertTurnExecutionSummary,
  observeExecutionBinding,
  setThreadName as setThreadNameService,
} from "@services/tauri";
import {
  makeCustomNameKey,
  saveCustomName,
} from "@threads/utils/threadStorage";
import { getParentThreadIdFromThread } from "@threads/utils/threadRpc";
import {
  buildThreadSummaryFromThread,
  extractThreadFromResponse,
  getThreadDisplayTitle,
} from "@threads/utils/threadSummary";
import { getSubagentDescendantThreadIds } from "@threads/utils/subagentTree";
import {
  buildWorkspacePathLookup,
  resolveWorkspaceIdForThreadPath,
} from "@threads/utils/threadActionHelpers";
import {
  clearActiveManagedSessionsCache,
  isSidebarManagedSessionCandidate,
  listActiveManagedSessionsCached,
} from "@threads/utils/activeManagedSessions";
import { LOCAL_CODEX_WORKSPACE_ID } from "@/features/workspaces/domain/localCodexWorkspace";
import type { ThreadListRuntimeContext } from "@threads/types";

type UseThreadsOptions = {
  activeWorkspace: WorkspaceInfo | null;
  workspaces?: WorkspaceInfo[];
  onWorkspaceConnected: (id: string) => void;
  onDebug?: (entry: DebugEntry) => void;
  ensureWorkspaceRuntimeCodexArgs?: (
    workspaceId: string,
    threadId: string | null,
  ) => Promise<void>;
  model?: string | null;
  workflowProviderKind?: CodexProviderKind;
  workflowRuntimeMode?: WorkflowRuntimeMode;
  computerControlRoutingEnabled?: boolean;
  workflowSkills?: SkillOption[];
  workflowAgents?: WorkflowAgentOption[];
  getWorkflowGateId?: (workspaceId: string, threadId: string) => string | null;
  tokenEfficiencyMode?: TokenEfficiencyMode;
  effort?: string | null;
  serviceTier?: ServiceTier | null | undefined;
  collaborationMode?: Record<string, unknown> | null;
  accessMode?: "read-only" | "current" | "full-access";
  onSelectServiceTier?: (tier: ServiceTier | null | undefined) => void;
  reviewDeliveryMode?: "inline" | "detached";
  steerEnabled?: boolean;
  subagentCheckpointSyncMode?: SubagentCheckpointSyncMode;
  threadTitleAutogenerationEnabled?: boolean;
  chatHistoryScrollbackItems?: number | null;
  autoArchiveThreadsEnabled?: boolean;
  autoArchiveThreadsDays?: number;
  customPrompts?: CustomPromptOption[];
  onMessageActivity?: () => void;
  threadSortKey?: ThreadListSortKey;
  preserveSessionLibraryOnProviderSwitch?: boolean;
  getThreadListRuntimeContext?: () => ThreadListRuntimeContext;
  onThreadCodexMetadataDetected?: (
    workspaceId: string,
    threadId: string,
    metadata: { modelId: string | null; effort: string | null },
  ) => void;
};

function buildWorkspaceThreadKey(workspaceId: string, threadId: string) {
  return `${workspaceId}:${threadId}`;
}

function getServerTurnIds(thread: Record<string, unknown>) {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  return new Set(
    turns
      .map((turn) =>
        turn && typeof turn === "object" && !Array.isArray(turn)
          ? String((turn as Record<string, unknown>).id ?? "").trim()
          : "",
      )
      .filter(Boolean),
  );
}

const CASCADE_ARCHIVE_SKIP_TTL_MS = 120_000;
const AUTO_ARCHIVE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export function useThreads({
  activeWorkspace,
  workspaces = activeWorkspace ? [activeWorkspace] : [],
  onWorkspaceConnected,
  onDebug,
  ensureWorkspaceRuntimeCodexArgs,
  model,
  workflowProviderKind = "openai",
  workflowRuntimeMode = "shadow",
  computerControlRoutingEnabled = true,
  workflowSkills = [],
  workflowAgents = [],
  getWorkflowGateId,
  tokenEfficiencyMode = "quality",
  effort,
  serviceTier,
  collaborationMode,
  accessMode,
  onSelectServiceTier,
  reviewDeliveryMode = "inline",
  steerEnabled = false,
  subagentCheckpointSyncMode = "checkpoints",
  threadTitleAutogenerationEnabled = true,
  chatHistoryScrollbackItems,
  autoArchiveThreadsEnabled = false,
  autoArchiveThreadsDays = 7,
  customPrompts = [],
  onMessageActivity,
  threadSortKey = "updated_at",
  preserveSessionLibraryOnProviderSwitch = false,
  getThreadListRuntimeContext = () => ({
    sourceId: null,
    runtimeGeneration: 0,
  }),
  onThreadCodexMetadataDetected,
}: UseThreadsOptions) {
  const maxItemsPerThread =
    chatHistoryScrollbackItems === undefined
      ? CHAT_SCROLLBACK_DEFAULT
      : chatHistoryScrollbackItems;

  const [state, dispatch] = useReducer(
    threadReducer,
    maxItemsPerThread,
    (initialMaxItemsPerThread) => ({
      ...initialState,
      maxItemsPerThread: initialMaxItemsPerThread,
    }),
  );
  useEffect(() => {
    dispatch({ type: "setMaxItemsPerThread", maxItemsPerThread });
  }, [dispatch, maxItemsPerThread]);
  const loadedThreadsRef = useRef<Record<string, boolean>>({});
  const loadedThreadRuntimeKeyRef = useRef<Record<string, string>>({});
  const replaceOnResumeRef = useRef<Record<string, boolean>>({});
  const pendingInterruptsRef = useRef<Set<string>>(new Set());
  const planByThreadRef = useRef(state.planByThread);
  const planReconcileRef = useRef<
    ((workspaceId: string, threadId: string) => Promise<void>) | null
  >(null);
  const itemsByThreadRef = useRef(state.itemsByThread);
  const threadsByWorkspaceRef = useRef(state.threadsByWorkspace);
  const activeThreadIdByWorkspaceRef = useRef(state.activeThreadIdByWorkspace);
  const activeTurnIdByThreadRef = useRef(state.activeTurnIdByThread);
  const threadStatusByIdRef = useRef(state.threadStatusById);
  const subagentThreadByWorkspaceThreadRef = useRef<Record<string, true>>({});
  const threadParentByIdRef = useRef(state.threadParentById);
  const cascadeArchiveSkipRef = useRef<Record<string, number>>({});
  const subagentHydrationInFlightRef = useRef<Record<string, true>>({});
  const tokenUsageRevisionByThreadRef = useRef<Record<string, number>>({});
  const autoArchiveInFlightRef = useRef(false);
  const lastTurnActivityAtByThreadRef = useRef<Record<string, number>>({});
  const stallReconcileInFlightRef = useRef<Set<string>>(new Set());
  const persistedExecutionRevisionRef = useRef<Record<string, number>>({});
  const workspacesRef = useRef(workspaces);
  const autoContinueSendRef = useRef<
    | ((
        workspace: WorkspaceInfo,
        threadId: string,
        message: string,
      ) => Promise<SendMessageResult>)
    | null
  >(null);
  workspacesRef.current = workspaces;
  planByThreadRef.current = state.planByThread;
  itemsByThreadRef.current = state.itemsByThread;
  threadsByWorkspaceRef.current = state.threadsByWorkspace;
  activeThreadIdByWorkspaceRef.current = state.activeThreadIdByWorkspace;
  activeTurnIdByThreadRef.current = state.activeTurnIdByThread;
  threadStatusByIdRef.current = state.threadStatusById;
  threadParentByIdRef.current = state.threadParentById;
  const rateLimitsByWorkspaceRef = useRef(state.rateLimitsByWorkspace);
  rateLimitsByWorkspaceRef.current = state.rateLimitsByWorkspace;
  const { approvalAllowlistRef, handleApprovalDecision, handleApprovalRemember } =
    useThreadApprovals({ dispatch, onDebug });
  const { handleUserInputSubmit } = useThreadUserInput({ dispatch });
  const {
    customNamesRef,
    threadActivityRef,
    pinnedThreadsVersion,
    getCustomName,
    recordThreadActivity,
    pinThread,
    unpinThread,
    isThreadPinned,
    getPinTimestamp,
  } = useThreadStorage();

  const activeWorkspaceId = activeWorkspace?.id ?? null;
  const activeWorkspaceIdRef = useRef(activeWorkspaceId);
  const threadSelectionRevisionByWorkspaceRef = useRef<Record<string, number>>({});
  activeWorkspaceIdRef.current = activeWorkspaceId;
  const getWorkspaceForAutoContinue = useCallback(
    (workspaceId: string) =>
      workspacesRef.current.find((workspace) => workspace.id === workspaceId) ?? null,
    [],
  );
  const isThreadProcessingForAutoContinue = useCallback(
    (threadId: string) =>
      Boolean(
        threadStatusByIdRef.current[threadId]?.isProcessing ||
          activeTurnIdByThreadRef.current[threadId],
      ),
    [],
  );
  const {
    statusByThread: autoContinueStatusByThread,
    setEnabled: setThreadAutoContinueEnabled,
    onTurnStarted: handleAutoContinueTurnStarted,
    onTurnCompleted: handleAutoContinueTurnCompleted,
    onTurnError: handleAutoContinueTurnError,
    markManualStop: markAutoContinueManualStop,
    clearManualStop: clearAutoContinueManualStop,
    shouldContinueAfterError,
    clearThread: clearAutoContinueThread,
  } = useThreadAutoContinue({
    getWorkspace: getWorkspaceForAutoContinue,
    isThreadProcessing: isThreadProcessingForAutoContinue,
    sendContinuationRef: autoContinueSendRef,
  });
  const { activeThreadId, activeItems } = useThreadSelectors({
    activeWorkspaceId,
    activeThreadIdByWorkspace: state.activeThreadIdByWorkspace,
    itemsByThread: state.itemsByThread,
    threadsByWorkspace: state.threadsByWorkspace,
  });

  const getCurrentRateLimits = useCallback(
    (workspaceId: string) => rateLimitsByWorkspaceRef.current[workspaceId] ?? null,
    [],
  );

  const hydrateTurnExecutionSummary = useCallback(
    async (
      workspaceId: string,
      threadId: string,
      thread: Record<string, unknown>,
    ): Promise<TurnExecutionSummary | null> => {
      try {
        const serverTurnIds = getServerTurnIds(thread);
        if (serverTurnIds.size === 0) {
          return null;
        }
        const summaries = await getTurnExecutionSummaries(workspaceId, threadId);
        const matchingSummaries = summaries.filter(
          (candidate) =>
            candidate.status !== "active" &&
            candidate.workspaceId === workspaceId &&
            candidate.threadId === threadId &&
            candidate.turnChain.some((turnId) => serverTurnIds.has(turnId)),
        );
        if (matchingSummaries.length === 0) {
          return null;
        }
        matchingSummaries.forEach((summary) => {
          dispatch({
            type: "hydrateTurnExecutionSummary",
            workspaceId,
            threadId,
            summary,
          });
        });
        return matchingSummaries[0] ?? null;
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-turn-execution-summary-hydrate-error`,
          timestamp: Date.now(),
          source: "error",
          label: "turn execution summary hydrate error",
          payload: {
            workspaceId,
            threadId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        return null;
      }
    },
    [dispatch, onDebug],
  );

  useEffect(() => {
    Object.values(state.turnExecutionSummariesByThread)
      .flat()
      .forEach((summary) => {
        const key = `${summary.workspaceId}:${summary.threadId}:${summary.executionId}`;
        if ((persistedExecutionRevisionRef.current[key] ?? 0) >= summary.recordRevision) {
          return;
        }
        persistedExecutionRevisionRef.current[key] = summary.recordRevision;
        void upsertTurnExecutionSummary(summary).catch((error) => {
          delete persistedExecutionRevisionRef.current[key];
          onDebug?.({
            id: `${Date.now()}-client-turn-execution-summary-upsert-error`,
            timestamp: Date.now(),
            source: "error",
            label: "turn execution summary upsert error",
            payload: {
              workspaceId: summary.workspaceId,
              threadId: summary.threadId,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        });
      });
  }, [onDebug, state.turnExecutionSummariesByThread]);

  const handleExecutionBindingObserved = useCallback(
    (input: ExecutionBindingObserveInput) => {
      void observeExecutionBinding(input).catch((error) => {
        onDebug?.({
          id: `${Date.now()}-client-execution-binding-observe-error`,
          timestamp: Date.now(),
          source: "error",
          label: "execution binding observe error",
          payload: {
            workspaceId: input.workspaceId,
            parentThreadId: input.parentThreadId,
            collabToolCallId: input.collabToolCallId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      });
    },
    [onDebug],
  );

  const { refreshAccountRateLimits } = useThreadRateLimits({
    activeWorkspaceId,
    activeWorkspaceConnected: activeWorkspace?.connected,
    getCurrentRateLimits,
    dispatch,
    onDebug,
  });
  const { refreshAccountInfo } = useThreadAccountInfo({
    activeWorkspaceId,
    activeWorkspaceConnected: activeWorkspace?.connected,
    dispatch,
    onDebug,
  });

  const { markProcessing, markReviewing, setActiveTurnId } = useThreadStatus({
    dispatch,
  });

  const pushThreadErrorMessage = useCallback(
    (threadId: string, message: string, turnId?: string) => {
      dispatch({
        type: "addAssistantMessage",
        threadId,
        text: message,
        turnId,
      });
      if (threadId !== activeThreadId) {
        dispatch({ type: "markUnread", threadId, hasUnread: true });
      }
    },
    [activeThreadId, dispatch],
  );

  const safeMessageActivity = useCallback(() => {
    try {
      void onMessageActivity?.();
    } catch {
      // Ignore refresh errors to avoid breaking the UI.
    }
  }, [onMessageActivity]);

  const recordTurnActivity = useCallback(
    (_workspaceId: string, threadId: string, timestamp = Date.now()) => {
      lastTurnActivityAtByThreadRef.current[threadId] = timestamp;
    },
    [],
  );

  const setThreadLoaded = useCallback((threadId: string, isLoaded: boolean) => {
    loadedThreadsRef.current[threadId] = isLoaded;
    if (!isLoaded) {
      delete loadedThreadRuntimeKeyRef.current[threadId];
    }
  }, []);

  const renameThread = useCallback(
    (workspaceId: string, threadId: string, newName: string) => {
      saveCustomName(workspaceId, threadId, newName);
      const key = makeCustomNameKey(workspaceId, threadId);
      customNamesRef.current[key] = newName;
      dispatch({ type: "setThreadName", workspaceId, threadId, name: newName });
      void Promise.resolve(
        setThreadNameService(workspaceId, threadId, newName),
      ).catch((error) => {
        onDebug?.({
          id: `${Date.now()}-client-thread-rename-error`,
          timestamp: Date.now(),
          source: "error",
          label: "thread/name/set error",
          payload: error instanceof Error ? error.message : String(error),
        });
      });
    },
    [customNamesRef, dispatch, onDebug],
  );

  const persistGeneratedThreadTitle = useCallback(
    (workspaceId: string, threadId: string, title: string) => {
      dispatch({ type: "setThreadName", workspaceId, threadId, name: title });
      void Promise.resolve(setThreadNameService(workspaceId, threadId, title)).catch(
        (error) => {
          onDebug?.({
            id: `${Date.now()}-client-generated-thread-title-error`,
            timestamp: Date.now(),
            source: "error",
            label: "thread/generated title set error",
            payload: error instanceof Error ? error.message : String(error),
          });
        },
      );
    },
    [dispatch, onDebug],
  );

  const onSubagentThreadDetected = useCallback(
    (workspaceId: string, threadId: string) => {
      if (!workspaceId || !threadId) {
        return;
      }
      subagentThreadByWorkspaceThreadRef.current[
        buildWorkspaceThreadKey(workspaceId, threadId)
      ] = true;
    },
    [],
  );

  const isSubagentThread = useCallback(
    (workspaceId: string, threadId: string) =>
      Boolean(
        subagentThreadByWorkspaceThreadRef.current[
          buildWorkspaceThreadKey(workspaceId, threadId)
        ],
      ),
    [],
  );

  const {
    onUserMessageCreated,
    onSubagentThreadDetected: onSubagentTitleCandidate,
  } = useThreadTitleAutogeneration({
    enabled: threadTitleAutogenerationEnabled,
    itemsByThreadRef,
    threadsByWorkspace: state.threadsByWorkspace,
    threadsByWorkspaceRef,
    getCustomName,
    renameThread,
    persistGeneratedTitle: persistGeneratedThreadTitle,
    onDebug,
  });

  const { applyCollabThreadLinks, applyCollabThreadLinksFromThread, updateThreadParent } =
    useThreadLinking({
      dispatch,
      threadParentById: state.threadParentById,
      onSubagentThreadDetected,
      onSubagentThreadMetadata: onSubagentTitleCandidate,
    });

  const handleWorkspaceConnected = useCallback(
    (workspaceId: string) => {
      onWorkspaceConnected(workspaceId);
      void refreshAccountRateLimits(workspaceId);
      void refreshAccountInfo(workspaceId);
    },
    [onWorkspaceConnected, refreshAccountRateLimits, refreshAccountInfo],
  );

  const handleAccountUpdated = useCallback(
    (workspaceId: string) => {
      void refreshAccountRateLimits(workspaceId);
      void refreshAccountInfo(workspaceId);
    },
    [refreshAccountRateLimits, refreshAccountInfo],
  );

  const isThreadHidden = useCallback(
    (workspaceId: string, threadId: string) =>
      Boolean(state.hiddenThreadIdsByWorkspace[workspaceId]?.[threadId]),
    [state.hiddenThreadIdsByWorkspace],
  );

  const getActiveTurnId = useCallback(
    (threadId: string) => activeTurnIdByThreadRef.current[threadId] ?? null,
    [],
  );

  const { registerDetachedReviewChild, handleReviewExited } =
    useDetachedReviewTracking({
      activeThreadId,
      dispatch,
      recordThreadActivity,
      safeMessageActivity,
      threadsByWorkspace: state.threadsByWorkspace,
      threadParentById: state.threadParentById,
      updateThreadParent,
    });

  const hydrateSubagentThreads = useCallback(
    async (workspaceId: string, receivers: CollabAgentRef[]) => {
      if (!workspaceId || receivers.length === 0) {
        return;
      }
      const uniqueThreadIds = Array.from(
        new Set(
          receivers
            .map((receiver) => receiver.threadId.trim())
            .filter((threadId) => threadId.length > 0),
        ),
      );
      if (uniqueThreadIds.length === 0) {
        return;
      }

      await Promise.all(
        uniqueThreadIds.map(async (threadId) => {
          const key = buildWorkspaceThreadKey(workspaceId, threadId);
          if (subagentHydrationInFlightRef.current[key]) {
            return;
          }
          const existingThread = threadsByWorkspaceRef.current[workspaceId]?.find(
            (thread) => thread.id === threadId,
          );
          if (existingThread?.subagentNickname && existingThread.subagentRole) {
            return;
          }

          subagentHydrationInFlightRef.current[key] = true;
          try {
            const response = await readThreadService(workspaceId, threadId);
            const thread = extractThreadFromResponse(response);
            if (!thread) {
              return;
            }
            await hydrateTurnExecutionSummary(workspaceId, threadId, thread);
            const fallbackIndex =
              threadsByWorkspaceRef.current[workspaceId]?.length ?? 0;
            const summary = buildThreadSummaryFromThread({
              workspaceId,
              thread,
              fallbackIndex,
              getCustomName,
            });
            if (!summary) {
              return;
            }

            dispatch({ type: "ensureThread", workspaceId, threadId: summary.id });
            const displayTitle = getThreadDisplayTitle(thread);
            const customName = getCustomName(workspaceId, summary.id);
            if (displayTitle || customName) {
              dispatch({
                type: "setThreadName",
                workspaceId,
                threadId: summary.id,
                name: summary.name,
              });
            }
            dispatch({
              type: "mergeThreadSummary",
              workspaceId,
              threadId: summary.id,
              patch: {
                ...(summary.isSubagent ? { isSubagent: true } : {}),
                ...(summary.subagentNickname
                  ? { subagentNickname: summary.subagentNickname }
                  : {}),
                ...(summary.subagentRole ? { subagentRole: summary.subagentRole } : {}),
                ...(summary.createdAt !== undefined ? { createdAt: summary.createdAt } : {}),
              },
            });
            if (summary.updatedAt > 0) {
              dispatch({
                type: "setThreadTimestamp",
                workspaceId,
                threadId: summary.id,
                timestamp: summary.updatedAt,
              });
            }
            const parentThreadId = getParentThreadIdFromThread(thread);
            if (parentThreadId) {
              updateThreadParent(parentThreadId, [summary.id]);
              void onSubagentTitleCandidate(workspaceId, thread);
            }
            if (summary.isSubagent) {
              onSubagentThreadDetected(workspaceId, summary.id);
            }
          } catch (error) {
            onDebug?.({
              id: `${Date.now()}-client-thread-read-error`,
              timestamp: Date.now(),
              source: "error",
              label: "thread/read error",
              payload: {
                workspaceId,
                threadId,
                error: error instanceof Error ? error.message : String(error),
              },
            });
          } finally {
            delete subagentHydrationInFlightRef.current[key];
          }
        }),
      );
    },
    [
      dispatch,
      getCustomName,
      hydrateTurnExecutionSummary,
      onDebug,
      onSubagentThreadDetected,
      onSubagentTitleCandidate,
      updateThreadParent,
    ],
  );

  const subagentCheckpointSync = useSubagentCheckpointSync({
    mode: subagentCheckpointSyncMode,
    threadParentByIdRef,
    threadStatusByIdRef,
    activeTurnIdByThreadRef,
    getChildName: (workspaceId, threadId) => {
      const summary = threadsByWorkspaceRef.current[workspaceId]?.find(
        (thread) => thread.id === threadId,
      );
      return summary ? getThreadDisplayTitle(summary) : null;
    },
    onStatusChange: (workspaceId, parentThreadId, status, deliveredCount) => {
      const parentSummary = threadsByWorkspaceRef.current[workspaceId]?.find(
        (thread) => thread.id === parentThreadId,
      );
      dispatch({
        type: "mergeThreadSummary",
        workspaceId,
        threadId: parentThreadId,
        patch: {
          subagentCheckpointStatus: status,
          subagentCheckpointCount:
            (parentSummary?.subagentCheckpointCount ?? 0) + deliveredCount,
        },
      });
    },
    onDebug,
  });

  const reconcilePlan = useCallback((workspaceId: string, threadId: string) => {
    return planReconcileRef.current?.(workspaceId, threadId) ?? Promise.resolve();
  }, []);

  const threadHandlers = useThreadEventHandlers({
    activeThreadId,
    dispatch,
    getItemsForThread: (threadId) => itemsByThreadRef.current[threadId] ?? [],
    planByThreadRef,
    getCurrentRateLimits,
    getCustomName,
    isThreadHidden,
    setThreadLoaded,
    markProcessing,
    markReviewing,
    setActiveTurnId,
    getActiveTurnId,
    safeMessageActivity,
    recordThreadActivity,
    recordTurnActivity,
    shouldContinueAfterError,
    reconcilePlan,
    executionModelId: model,
    onUserMessageCreated,
    pushThreadErrorMessage,
    onDebug,
    onWorkspaceConnected: handleWorkspaceConnected,
    applyCollabThreadLinks,
    hydrateSubagentThreads,
    onReviewExited: handleReviewExited,
    onExecutionBindingObserved: handleExecutionBindingObserved,
    approvalAllowlistRef,
    pendingInterruptsRef,
  });

  const handleAccountLoginCompleted = useCallback(
    (workspaceId: string) => {
      handleAccountUpdated(workspaceId);
    },
    [handleAccountUpdated],
  );

  const handleThreadStarted = useCallback(
    (workspaceId: string, thread: Record<string, unknown>) => {
      threadHandlers.onThreadStarted(workspaceId, thread);
      const threadId = String(thread.id ?? "").trim();
      if (!threadId) {
        return;
      }
      const parentThreadId = getParentThreadIdFromThread(thread);
      if (!parentThreadId) {
        return;
      }
      updateThreadParent(parentThreadId, [threadId]);
      onSubagentThreadDetected(workspaceId, threadId);
      void onSubagentTitleCandidate(workspaceId, thread);
    },
    [
      onSubagentThreadDetected,
      onSubagentTitleCandidate,
      threadHandlers,
      updateThreadParent,
    ],
  );

  const handleThreadArchived = useCallback(
    (workspaceId: string, threadId: string) => {
      if (!workspaceId || !threadId) {
        return;
      }
      threadHandlers.onThreadArchived?.(workspaceId, threadId);
      clearAutoContinueThread(threadId);
      subagentCheckpointSync.clearThread(threadId);
      unpinThread(workspaceId, threadId);

      const skipKey = buildWorkspaceThreadKey(workspaceId, threadId);
      const skipAt = cascadeArchiveSkipRef.current[skipKey] ?? null;
      if (skipAt !== null) {
        delete cascadeArchiveSkipRef.current[skipKey];
        if (
          skipAt > 0 &&
          Date.now() - skipAt >= 0 &&
          Date.now() - skipAt < CASCADE_ARCHIVE_SKIP_TTL_MS
        ) {
          return;
        }
      }

      const descendants = getSubagentDescendantThreadIds({
        rootThreadId: threadId,
        threadParentById: threadParentByIdRef.current,
        isSubagentThread: (candidateId) =>
          isSubagentThread(workspaceId, candidateId),
      });
      if (descendants.length === 0) {
        return;
      }

      onDebug?.({
        id: `${Date.now()}-client-thread-archive-cascade`,
        timestamp: Date.now(),
        source: "client",
        label: "thread/archive cascade",
        payload: { workspaceId, rootThreadId: threadId, descendantCount: descendants.length },
      });

      const now = Date.now();
      Object.entries(cascadeArchiveSkipRef.current).forEach(([key, timestamp]) => {
        if (now - timestamp >= CASCADE_ARCHIVE_SKIP_TTL_MS) {
          delete cascadeArchiveSkipRef.current[key];
        }
      });

      void (async () => {
        for (const descendantId of descendants) {
          const descendantKey = buildWorkspaceThreadKey(workspaceId, descendantId);
          cascadeArchiveSkipRef.current[descendantKey] = Date.now();
          try {
            await archiveThreadService(workspaceId, descendantId);
          } catch (error) {
            delete cascadeArchiveSkipRef.current[descendantKey];
            onDebug?.({
              id: `${Date.now()}-client-thread-archive-cascade-error`,
              timestamp: Date.now(),
              source: "error",
              label: "thread/archive cascade error",
              payload: {
                workspaceId,
                rootThreadId: threadId,
                threadId: descendantId,
                error: error instanceof Error ? error.message : String(error),
              },
            });
          }
        }
      })();
    },
    [clearAutoContinueThread, isSubagentThread, onDebug, subagentCheckpointSync, threadHandlers, unpinThread],
  );

  const handleThreadUnarchived = useCallback(
    (workspaceId: string, threadId: string) => {
      threadHandlers.onThreadUnarchived?.(workspaceId, threadId);
    },
    [threadHandlers],
  );

  const handleTurnStarted = useCallback(
    (workspaceId: string, threadId: string, turnId: string) => {
      threadHandlers.onTurnStarted?.(workspaceId, threadId, turnId);
      handleAutoContinueTurnStarted(workspaceId, threadId);
      subagentCheckpointSync.onTurnStarted(workspaceId, threadId, turnId);
    },
    [handleAutoContinueTurnStarted, subagentCheckpointSync, threadHandlers],
  );

  const handleThreadTokenUsageUpdated = useCallback(
    (
      workspaceId: string,
      threadId: string,
      tokenUsage: Record<string, unknown> | null,
    ) => {
      const key = buildWorkspaceThreadKey(workspaceId, threadId);
      tokenUsageRevisionByThreadRef.current[key] =
        (tokenUsageRevisionByThreadRef.current[key] ?? 0) + 1;
      threadHandlers.onThreadTokenUsageUpdated?.(workspaceId, threadId, tokenUsage);
    },
    [threadHandlers],
  );

  const handleTurnCompleted = useCallback(
    (
      workspaceId: string,
      threadId: string,
      turnId: string,
      status?: "completed" | "interrupted" | "failed",
    ) => {
      threadHandlers.onTurnCompleted?.(workspaceId, threadId, turnId, status);
      handleAutoContinueTurnCompleted(workspaceId, threadId);
      subagentCheckpointSync.onTurnCompleted(workspaceId, threadId, turnId);
    },
    [handleAutoContinueTurnCompleted, subagentCheckpointSync, threadHandlers],
  );

  const handleAgentMessageCompleted = useCallback(
    (event: {
      workspaceId: string;
      threadId: string;
      itemId: string;
      turnId?: string;
      phase?: string | null;
      text: string;
    }) => {
      threadHandlers.onAgentMessageCompleted?.(event);
      subagentCheckpointSync.onAgentMessageCompleted(event);
    },
    [subagentCheckpointSync, threadHandlers],
  );

  const handleTurnError = useCallback(
    (
      workspaceId: string,
      threadId: string,
      turnId: string,
      payload: { message: string; willRetry: boolean },
    ) => {
      threadHandlers.onTurnError?.(workspaceId, threadId, turnId, payload);
      handleAutoContinueTurnError(workspaceId, threadId, turnId, payload);
    },
    [handleAutoContinueTurnError, threadHandlers],
  );

  const handleThreadClosed = useCallback(
    (workspaceId: string, threadId: string) => {
      threadHandlers.onThreadClosed?.(workspaceId, threadId);
      subagentCheckpointSync.clearThread(threadId);
      clearAutoContinueThread(threadId);
    },
    [clearAutoContinueThread, subagentCheckpointSync, threadHandlers],
  );

  const handlers = useMemo(
    () => ({
      ...threadHandlers,
      onAgentMessageCompleted: handleAgentMessageCompleted,
      onThreadStarted: handleThreadStarted,
      onThreadArchived: handleThreadArchived,
      onThreadUnarchived: handleThreadUnarchived,
      onTurnStarted: handleTurnStarted,
      onThreadTokenUsageUpdated: handleThreadTokenUsageUpdated,
      onTurnCompleted: handleTurnCompleted,
      onTurnError: handleTurnError,
      onThreadClosed: handleThreadClosed,
      onAccountUpdated: handleAccountUpdated,
      onAccountLoginCompleted: handleAccountLoginCompleted,
    }),
    [
      threadHandlers,
      handleAgentMessageCompleted,
      handleThreadStarted,
      handleThreadArchived,
      handleThreadUnarchived,
      handleTurnStarted,
      handleThreadTokenUsageUpdated,
      handleTurnCompleted,
      handleTurnError,
      handleThreadClosed,
      handleAccountUpdated,
      handleAccountLoginCompleted,
    ],
  );

  useAppServerEvents(handlers);

  const {
    startThreadForWorkspace: startThreadForWorkspaceInternal,
    forkThreadForWorkspace,
    readThreadForWorkspace,
    loadOlderThreadHistory,
    threadHistoryPageByThread,
    ensureThreadRuntimeForWorkspace,
    resumeThreadById,
    refreshThread,
    resetWorkspaceThreads,
    listThreadsForWorkspaces,
    listThreadsForWorkspace,
    loadOlderThreadsForWorkspace,
    archiveThread,
  } = useThreadActions({
    dispatch,
    itemsByThread: state.itemsByThread,
    threadsByWorkspace: state.threadsByWorkspace,
    activeThreadIdByWorkspace: state.activeThreadIdByWorkspace,
    activeTurnIdByThread: state.activeTurnIdByThread,
    threadParentById: state.threadParentById,
    threadListCursorByWorkspace: state.threadListCursorByWorkspace,
    threadListContinuityByWorkspace: state.threadListContinuityByWorkspace,
    threadStatusById: state.threadStatusById,
    threadSortKey,
    preserveSessionLibraryOnProviderSwitch,
    getThreadListRuntimeContext,
    tokenEfficiencyMode,
    onDebug,
    getCustomName,
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
    onThreadCodexMetadataDetected,
    hydrateTurnExecutionSummary,
  });

  planReconcileRef.current = async (workspaceId, threadId) => {
    await readThreadForWorkspace(workspaceId, threadId, true, false);
  };

  const findWorkspaceIdForThread = useCallback((threadId: string) => {
    for (const [workspaceId, threads] of Object.entries(
      threadsByWorkspaceRef.current,
    )) {
      if (threads.some((thread) => thread.id === threadId)) {
        return workspaceId;
      }
    }
    for (const [workspaceId, activeId] of Object.entries(
      activeThreadIdByWorkspaceRef.current,
    )) {
      if (activeId === threadId) {
        return workspaceId;
      }
    }
    return null;
  }, []);

  const reconcileStalledThread = useCallback(
    async (threadId: string) => {
      const workspaceId = findWorkspaceIdForThread(threadId);
      if (!workspaceId) {
        return;
      }
      const reconcileKey = `${workspaceId}:${threadId}`;
      if (stallReconcileInFlightRef.current.has(reconcileKey)) {
        return;
      }
      stallReconcileInFlightRef.current.add(reconcileKey);
      try {
        await readThreadForWorkspace(workspaceId, threadId, true, false);
      } finally {
        stallReconcileInFlightRef.current.delete(reconcileKey);
      }
    },
    [findWorkspaceIdForThread, readThreadForWorkspace],
  );

  useThreadStallWarnings({
    threadStatusById: state.threadStatusById,
    lastActivityAtByThreadRef: lastTurnActivityAtByThreadRef,
    onReconcileThread: reconcileStalledThread,
    pushThreadErrorMessage,
    safeMessageActivity,
  });

  const { isThreadHistoryEvicted, restoreThreadHistory } =
    useResidentThreadHistory({
      activeThreadId,
      itemsByThread: state.itemsByThread,
      itemsByThreadRef,
      threadStatusById: state.threadStatusById,
      threadResumeLoadingById: state.threadResumeLoadingById,
      activeTurnIdByThread: state.activeTurnIdByThread,
      approvals: state.approvals,
      userInputRequests: state.userInputRequests,
      pendingUserMessageReplacementByThread:
        state.pendingUserMessageReplacementByThread,
      loadedThreadsRef,
      loadedThreadRuntimeKeyRef,
      dispatch,
      readThreadForWorkspace,
    });

  useEffect(() => {
    if (!autoArchiveThreadsEnabled) {
      return;
    }
    const normalizedDays = [3, 5, 7, 15, 30].includes(autoArchiveThreadsDays)
      ? autoArchiveThreadsDays
      : 7;
    const connectedWorkspaces = workspaces.filter(
      (workspace) =>
        workspace.id &&
        workspace.connected &&
        workspace.id !== LOCAL_CODEX_WORKSPACE_ID,
    );
    const localCodexWorkspace = workspaces.find(
      (workspace) => workspace.id === LOCAL_CODEX_WORKSPACE_ID && workspace.connected,
    );
    if (connectedWorkspaces.length === 0) {
      return;
    }
    let cancelled = false;
    let workspacePathLookup = buildWorkspacePathLookup(connectedWorkspaces);
    let workspaceIds = new Set(connectedWorkspaces.map((workspace) => workspace.id));

    const runAutoArchive = async () => {
      if (autoArchiveInFlightRef.current || cancelled) {
        return;
      }
      autoArchiveInFlightRef.current = true;
      const cutoff = Date.now() - normalizedDays * DAY_MS;
      let archivedCount = 0;
      let archivedLocalCodexCount = 0;
      let currentSourceId: string | null = null;
      try {
        try {
          const knownWorkspaces = await listWorkspacesService();
          const knownProjectWorkspaces = knownWorkspaces.filter(
            (workspace) =>
              workspace.id && workspace.id !== LOCAL_CODEX_WORKSPACE_ID,
          );
          if (knownProjectWorkspaces.length > 0) {
            workspacePathLookup = buildWorkspacePathLookup([
              ...connectedWorkspaces,
              ...knownProjectWorkspaces,
            ]);
            workspaceIds = new Set([
              ...connectedWorkspaces.map((workspace) => workspace.id),
              ...knownProjectWorkspaces.map((workspace) => workspace.id),
            ]);
          }
        } catch {
          workspacePathLookup = buildWorkspacePathLookup(connectedWorkspaces);
          workspaceIds = new Set(connectedWorkspaces.map((workspace) => workspace.id));
        }
        const sources = await listSessionSourcesService();
        const currentSource =
          sources.find((source) => source.enabled && source.isCurrent) ??
          sources.find((source) => source.enabled && source.isDefault) ??
          sources.find((source) => source.enabled);
        if (!currentSource) {
          return;
        }
        currentSourceId = currentSource.id;
        const sessions = await listActiveManagedSessionsCached(currentSource.id);
        const connectedWorkspaceById = new Map(
          connectedWorkspaces.map((workspace) => [workspace.id, workspace]),
        );
        const requestWorkspace = connectedWorkspaces[0];
        for (const session of sessions) {
          if (cancelled) {
            break;
          }
          if (!isSidebarManagedSessionCandidate(session)) {
            continue;
          }
          const threadId = session.threadId;
          const updatedAt = session.updatedAt ?? session.createdAt ?? 0;
          if (!threadId || !updatedAt || updatedAt > cutoff) {
            continue;
          }
          const owningWorkspaceId = resolveWorkspaceIdForThreadPath(
            session.cwd ?? "",
            workspacePathLookup,
            workspaceIds,
          );
          const targetWorkspaceId = owningWorkspaceId ?? LOCAL_CODEX_WORKSPACE_ID;
          if (!owningWorkspaceId && !localCodexWorkspace) {
            continue;
          }
          if (owningWorkspaceId && !connectedWorkspaceById.has(owningWorkspaceId)) {
            continue;
          }
          if (
            activeThreadIdByWorkspaceRef.current[targetWorkspaceId] === threadId ||
            threadStatusByIdRef.current[threadId]?.isProcessing ||
            activeTurnIdByThreadRef.current[threadId] ||
            isThreadPinned(targetWorkspaceId, threadId)
          ) {
            continue;
          }
          await archiveThread(owningWorkspaceId ?? requestWorkspace.id, threadId);
          if (owningWorkspaceId) {
            archivedCount += 1;
          } else {
            archivedLocalCodexCount += 1;
          }
        }
        if (archivedCount > 0) {
          onDebug?.({
            id: `${Date.now()}-client-auto-archive-threads`,
            timestamp: Date.now(),
            source: "client",
            label: "thread/auto-archive",
            payload: { archivedCount, days: normalizedDays },
          });
        }
        if (archivedLocalCodexCount > 0) {
          onDebug?.({
            id: `${Date.now()}-client-auto-archive-local-codex-threads`,
            timestamp: Date.now(),
            source: "client",
            label: "thread/auto-archive local Codex",
            payload: { archivedCount: archivedLocalCodexCount, days: normalizedDays },
          });
        }
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-auto-archive-threads-error`,
          timestamp: Date.now(),
          source: "error",
          label: "thread/auto-archive error",
          payload: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (currentSourceId && (archivedCount > 0 || archivedLocalCodexCount > 0)) {
          clearActiveManagedSessionsCache(currentSourceId);
        }
        autoArchiveInFlightRef.current = false;
      }
    };

    void runAutoArchive();
    const interval = window.setInterval(runAutoArchive, AUTO_ARCHIVE_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [
    archiveThread,
    autoArchiveThreadsDays,
    autoArchiveThreadsEnabled,
    isThreadPinned,
    onDebug,
    workspaces,
  ]);

  const ensureWorkspaceRuntimeCodexArgsBestEffort = useCallback(
    async (workspaceId: string, threadId: string | null, phase: string) => {
      if (!ensureWorkspaceRuntimeCodexArgs) {
        return true;
      }
      try {
        await ensureWorkspaceRuntimeCodexArgs(workspaceId, threadId);
        return true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        onDebug?.({
          id: `${Date.now()}-client-thread-runtime-codex-args-sync-error`,
          timestamp: Date.now(),
          source: "error",
          label: "thread/runtime-codex-args sync error",
          payload: `${phase}: ${detail}`,
        });
        return false;
      }
    },
    [ensureWorkspaceRuntimeCodexArgs, onDebug],
  );

  const startThreadForWorkspace = useCallback(
    async (workspaceId: string, options?: { activate?: boolean }) => {
      const runtimeReady = await ensureWorkspaceRuntimeCodexArgsBestEffort(
        workspaceId,
        null,
        "start",
      );
      if (!runtimeReady) {
        return null;
      }
      return startThreadForWorkspaceInternal(workspaceId, options);
    },
    [ensureWorkspaceRuntimeCodexArgsBestEffort, startThreadForWorkspaceInternal],
  );

  const startThread = useCallback(async () => {
    if (!activeWorkspaceId) {
      return null;
    }
    return startThreadForWorkspace(activeWorkspaceId);
  }, [activeWorkspaceId, startThreadForWorkspace]);

  const ensureThreadForActiveWorkspace = useCallback(async () => {
    if (!activeWorkspace) {
      return null;
    }
    let threadId = activeThreadId;
    if (!threadId) {
      const workspaceId = activeWorkspace.id;
      const selectionRevision =
        threadSelectionRevisionByWorkspaceRef.current[workspaceId] ?? 0;
      threadId = await startThreadForWorkspace(workspaceId, { activate: false });
      if (!threadId) {
        return null;
      }
      const selectionStayedOnDraft =
        activeWorkspaceIdRef.current === workspaceId &&
        (activeThreadIdByWorkspaceRef.current[workspaceId] ?? null) === null &&
        (threadSelectionRevisionByWorkspaceRef.current[workspaceId] ?? 0) ===
          selectionRevision;
      if (selectionStayedOnDraft) {
        dispatch({ type: "setActiveThreadId", workspaceId, threadId });
      }
    } else if (
      !loadedThreadsRef.current[threadId] ||
      isThreadHistoryEvicted(threadId)
    ) {
      await restoreThreadHistory(activeWorkspace.id, threadId);
    }
    return threadId;
  }, [
    activeWorkspace,
    activeThreadId,
    dispatch,
    isThreadHistoryEvicted,
    restoreThreadHistory,
    startThreadForWorkspace,
  ]);

  const ensureThreadForWorkspace = useCallback(
    async (workspaceId: string) => {
      const currentActiveThreadId = state.activeThreadIdByWorkspace[workspaceId] ?? null;
      const shouldActivate = workspaceId === activeWorkspaceId;
      let threadId = currentActiveThreadId;
      if (!threadId) {
        threadId = await startThreadForWorkspace(workspaceId, {
          activate: shouldActivate,
        });
        if (!threadId) {
          return null;
        }
      } else if (
        !loadedThreadsRef.current[threadId] ||
        isThreadHistoryEvicted(threadId)
      ) {
        await restoreThreadHistory(workspaceId, threadId);
      }
      if (shouldActivate && currentActiveThreadId !== threadId) {
        dispatch({ type: "setActiveThreadId", workspaceId, threadId });
      }
      return threadId;
    },
    [
      activeWorkspaceId,
      dispatch,
      loadedThreadsRef,
      isThreadHistoryEvicted,
      restoreThreadHistory,
      startThreadForWorkspace,
      state.activeThreadIdByWorkspace,
    ],
  );

  const {
    pendingTurnStartByThread,
    interruptTurn: interruptTurnRaw,
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
  } = useThreadMessaging({
    activeWorkspace,
    activeThreadId,
    accessMode,
    model,
    workflowProviderKind,
    workflowRuntimeMode,
    computerControlRoutingEnabled,
    workflowSkills,
    workflowAgents,
    getWorkflowGateId,
    effort,
    serviceTier,
    collaborationMode,
    onSelectServiceTier,
    reviewDeliveryMode,
    steerEnabled,
    customPrompts,
    ensureWorkspaceRuntimeCodexArgs,
    threadStatusById: state.threadStatusById,
    activeTurnIdByThread: state.activeTurnIdByThread,
    rateLimitsByWorkspace: state.rateLimitsByWorkspace,
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
    onUserTurnRequested: (_workspaceId, threadId) =>
      clearAutoContinueManualStop(threadId),
  });
  autoContinueSendRef.current = (workspace, threadId, message) =>
    sendUserMessageToThread(workspace, threadId, message, [], {
      skipPromptExpansion: true,
      sendIntent: "queue",
    });
  const interruptTurn = useCallback(() => {
    if (activeThreadId) {
      markAutoContinueManualStop(
        activeThreadId,
        activeTurnIdByThreadRef.current[activeThreadId] ?? null,
      );
    }
    return interruptTurnRaw();
  }, [activeThreadId, interruptTurnRaw, markAutoContinueManualStop]);

  const hasLocalThreadSnapshot = useCallback(
    (threadId: string | null) => {
      if (!threadId) {
        return false;
      }
      return (
        loadedThreadsRef.current[threadId] === true ||
        (itemsByThreadRef.current[threadId]?.length ?? 0) > 0
      );
    },
    [itemsByThreadRef, loadedThreadsRef],
  );

  const setActiveThreadId = useCallback(
    (threadId: string | null, workspaceId?: string) => {
      const targetId = workspaceId ?? activeWorkspaceId;
      if (!targetId) {
        return;
      }
      threadSelectionRevisionByWorkspaceRef.current[targetId] =
        (threadSelectionRevisionByWorkspaceRef.current[targetId] ?? 0) + 1;
      const currentThreadId = state.activeThreadIdByWorkspace[targetId] ?? null;
      dispatch({ type: "setActiveThreadId", workspaceId: targetId, threadId });
      if (threadId && currentThreadId !== threadId) {
        Sentry.metrics.count("thread_switched", 1, {
          attributes: {
            workspace_id: targetId,
            thread_id: threadId,
            reason: "select",
          },
        });
      }
      if (threadId) {
        void (async () => {
          const historyWasEvicted = isThreadHistoryEvicted(threadId);
          const hasLocalSnapshot = hasLocalThreadSnapshot(threadId);
          if (hasLocalSnapshot && !historyWasEvicted) {
            loadedThreadsRef.current[threadId] = true;
            return;
          }
          await restoreThreadHistory(targetId, threadId);
        })();
      }
    },
    [
      activeWorkspaceId,
      hasLocalThreadSnapshot,
      isThreadHistoryEvicted,
      loadedThreadsRef,
      restoreThreadHistory,
      state.activeThreadIdByWorkspace,
    ],
  );

  const removeThread = useCallback(
    (workspaceId: string, threadId: string) => {
      if (
        state.threadListContinuityByWorkspace[
          workspaceId
        ]?.staleThreadIds.includes(threadId)
      ) {
        onDebug?.({
          id: `${Date.now()}-client-thread-remove-stale`,
          timestamp: Date.now(),
          source: "client",
          label: "thread/remove blocked stale",
          payload: { workspaceId, threadId },
        });
        return;
      }
      unpinThread(workspaceId, threadId);
      subagentCheckpointSync.clearThread(threadId);
      dispatch({ type: "removeThread", workspaceId, threadId });
      void archiveThread(workspaceId, threadId);
    },
    [
      archiveThread,
      onDebug,
      state.threadListContinuityByWorkspace,
      subagentCheckpointSync,
      unpinThread,
    ],
  );

  return {
    activeThreadId,
    setActiveThreadId,
    hasLocalThreadSnapshot,
    activeItems,
    itemsByThread: state.itemsByThread,
    approvals: state.approvals,
    userInputRequests: state.userInputRequests,
    threadsByWorkspace: state.threadsByWorkspace,
    threadParentById: state.threadParentById,
    isSubagentThread,
    threadStatusById: state.threadStatusById,
    pendingTurnStartByThread,
    threadResumeLoadingById: state.threadResumeLoadingById,
    threadListLoadingByWorkspace: state.threadListLoadingByWorkspace,
    threadListPagingByWorkspace: state.threadListPagingByWorkspace,
    threadListCursorByWorkspace: state.threadListCursorByWorkspace,
    threadListContinuityByWorkspace: state.threadListContinuityByWorkspace,
    activeTurnIdByThread: state.activeTurnIdByThread,
    turnDiffByThread: state.turnDiffByThread,
    turnExecutionSummaryByThread: state.turnExecutionSummaryByThread,
    turnExecutionSummariesByThread: state.turnExecutionSummariesByThread,
    tokenUsageByThread: state.tokenUsageByThread,
    completedContextCompactionIdsByThread:
      state.completedContextCompactionIdsByThread,
    rateLimitsByWorkspace: state.rateLimitsByWorkspace,
    accountByWorkspace: state.accountByWorkspace,
    planByThread: state.planByThread,
    interruptedThreadById: state.interruptedThreadById,
    autoContinueStatusByThread,
    lastAgentMessageByThread: state.lastAgentMessageByThread,
    pinnedThreadsVersion,
    refreshAccountRateLimits,
    refreshAccountInfo,
    interruptTurn,
    setThreadAutoContinueEnabled,
    retryEditedUserMessage,
    removeThread,
    pinThread,
    unpinThread,
    isThreadPinned,
    getPinTimestamp,
    renameThread,
    startThread,
    startThreadForWorkspace,
    forkThreadForWorkspace,
    listThreadsForWorkspaces,
    listThreadsForWorkspace,
    refreshThread,
    resumeThreadById,
    resetWorkspaceThreads,
    loadOlderThreadsForWorkspace,
    loadOlderThreadHistory,
    threadHistoryPageByThread,
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
    handleApprovalDecision,
    handleApprovalRemember,
    handleUserInputSubmit,
  };
}
