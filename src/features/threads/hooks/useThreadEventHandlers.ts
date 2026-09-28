import { useCallback, useMemo, useRef } from "react";
import type { Dispatch, MutableRefObject } from "react";
import type {
  AppServerEvent,
  CollabAgentRef,
  ConversationItem,
  DebugEntry,
  RateLimitSnapshot,
  TurnPlan,
  ExecutionBindingObserveInput,
} from "@/types";
import {
  getAppServerRawMethod,
  getAppServerThreadId,
} from "@utils/appServerEvents";
import { useThreadApprovalEvents } from "./useThreadApprovalEvents";
import { useThreadHookEvents } from "./useThreadHookEvents";
import { useThreadItemEvents } from "./useThreadItemEvents";
import { useThreadTurnEvents } from "./useThreadTurnEvents";
import { useThreadUserInputEvents } from "./useThreadUserInputEvents";
import type { ThreadAction } from "./useThreadsReducer";

type ThreadEventHandlersOptions = {
  activeThreadId: string | null;
  dispatch: Dispatch<ThreadAction>;
  getItemsForThread: (threadId: string) => ConversationItem[];
  planByThreadRef: MutableRefObject<Record<string, TurnPlan | null>>;
  getCurrentRateLimits?: (workspaceId: string) => RateLimitSnapshot | null;
  getCustomName: (workspaceId: string, threadId: string) => string | undefined;
  isThreadHidden: (workspaceId: string, threadId: string) => boolean;
  setThreadLoaded: (threadId: string, isLoaded: boolean) => void;
  markProcessing: (threadId: string, isProcessing: boolean) => void;
  markReviewing: (threadId: string, isReviewing: boolean) => void;
  setActiveTurnId: (threadId: string, turnId: string | null) => void;
  getActiveTurnId: (threadId: string) => string | null;
  safeMessageActivity: () => void;
  recordThreadActivity: (
    workspaceId: string,
    threadId: string,
    timestamp?: number,
  ) => void;
  recordTurnActivity?: (
    workspaceId: string,
    threadId: string,
    timestamp?: number,
  ) => void;
  shouldContinueAfterError?: (threadId: string, turnId: string) => boolean;
  reconcilePlan?: (workspaceId: string, threadId: string) => Promise<void>;
  executionModelId?: string | null;
  onUserMessageCreated?: (
    workspaceId: string,
    threadId: string,
    text: string,
  ) => void | Promise<void>;
  pushThreadErrorMessage: (
    threadId: string,
    message: string,
    turnId?: string,
  ) => void;
  onDebug?: (entry: DebugEntry) => void;
  onWorkspaceConnected: (workspaceId: string) => void;
  applyCollabThreadLinks: (
    workspaceId: string,
    threadId: string,
    item: Record<string, unknown>,
  ) => void;
  hydrateSubagentThreads?: (
    workspaceId: string,
    receivers: CollabAgentRef[],
  ) => void | Promise<void>;
  onReviewExited?: (workspaceId: string, threadId: string) => void;
  onExecutionBindingObserved?: (input: ExecutionBindingObserveInput) => void;
  approvalAllowlistRef: MutableRefObject<Record<string, string[][]>>;
  pendingInterruptsRef: MutableRefObject<Set<string>>;
};

type ThreadActivityType = "active" | "started" | "completed";
type ThreadActivityHandler = (
  workspaceId: string,
  threadId: string,
  activityType?: ThreadActivityType,
) => void;

const STREAMING_DELTA_METHODS = new Set([
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
]);

export function useThreadEventHandlers({
  activeThreadId,
  dispatch,
  getItemsForThread,
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
  executionModelId,
  onUserMessageCreated,
  pushThreadErrorMessage,
  onDebug,
  onWorkspaceConnected,
  applyCollabThreadLinks,
  hydrateSubagentThreads,
  onReviewExited,
  onExecutionBindingObserved,
  approvalAllowlistRef,
  pendingInterruptsRef,
}: ThreadEventHandlersOptions) {
  const onThreadActivityRef = useRef<ThreadActivityHandler | null>(null);
  const handleThreadActivity = useCallback(
    (
      workspaceId: string,
      threadId: string,
      activityType?: ThreadActivityType,
    ) => {
      onThreadActivityRef.current?.(workspaceId, threadId, activityType);
    },
    [],
  );

  const onApprovalRequest = useThreadApprovalEvents({
    dispatch,
    approvalAllowlistRef,
  });
  const onRequestUserInput = useThreadUserInputEvents({ dispatch });
  const {
    onHookStarted: handleHookStarted,
    onHookCompleted: handleHookCompleted,
  } = useThreadHookEvents({
    dispatch,
    getItemsForThread,
    safeMessageActivity,
  });
  const onHookStarted = useCallback(
    ({
      workspaceId,
      threadId,
      turnId,
      run,
    }: {
      workspaceId: string;
      threadId: string;
      turnId: string | null;
      run: Record<string, unknown>;
    }) => {
      handleHookStarted(workspaceId, threadId, turnId, run);
    },
    [handleHookStarted],
  );
  const onHookCompleted = useCallback(
    ({
      workspaceId,
      threadId,
      turnId,
      run,
    }: {
      workspaceId: string;
      threadId: string;
      turnId: string | null;
      run: Record<string, unknown>;
    }) => {
      handleHookCompleted(workspaceId, threadId, turnId, run);
    },
    [handleHookCompleted],
  );

  const {
    onAgentMessageDelta,
    onAgentMessageCompleted,
    onItemStarted,
    onItemCompleted,
    onReasoningSummaryDelta,
    onReasoningSummaryBoundary,
    onReasoningTextDelta,
    onPlanDelta,
    onCommandOutputDelta,
    onTerminalInteraction,
    onFileChangeOutputDelta,
    flushItemUpserts,
    flushStreamingDeltas,
    resetStreamingThreadState,
  } = useThreadItemEvents({
    activeThreadId,
    dispatch,
    getCustomName,
    getActiveTurnId,
    markProcessing,
    markReviewing,
    safeMessageActivity,
    recordThreadActivity,
    applyCollabThreadLinks,
    hydrateSubagentThreads,
    onUserMessageCreated,
    onReviewExited,
    onExecutionBindingObserved,
    onThreadActivity: handleThreadActivity,
  });

  const {
    onThreadStarted,
    onThreadNameUpdated,
    onThreadArchived,
    onThreadUnarchived,
    onTurnStarted: handleTurnStarted,
    onTurnCompleted: handleTurnCompleted,
    onThreadStatusChanged: handleThreadStatusChanged,
    onThreadClosed: handleThreadClosed,
    onThreadActivity,
    onTurnPlanUpdated,
    onTurnDiffUpdated,
    onThreadTokenUsageUpdated,
    onAccountRateLimitsUpdated,
    onTurnError: handleTurnError,
    getLatestKnownActiveTurnId,
  } = useThreadTurnEvents({
    dispatch,
    planByThreadRef,
    getCurrentRateLimits,
    getCustomName,
    isThreadHidden,
    setThreadLoaded,
    markProcessing,
    markReviewing,
    setActiveTurnId,
    getActiveTurnId,
    pendingInterruptsRef,
    pushThreadErrorMessage,
    safeMessageActivity,
    recordThreadActivity,
    shouldContinueAfterError,
    reconcilePlan,
    executionModelId,
  });
  onThreadActivityRef.current = onThreadActivity;

  const onTurnStarted = useCallback(
    (workspaceId: string, threadId: string, turnId: string) => {
      flushItemUpserts();
      resetStreamingThreadState(workspaceId, threadId);
      handleTurnStarted(workspaceId, threadId, turnId);
    },
    [flushItemUpserts, handleTurnStarted, resetStreamingThreadState],
  );

  const onTurnCompleted = useCallback(
    (
      workspaceId: string,
      threadId: string,
      turnId: string,
      status?: "completed" | "interrupted" | "failed",
    ) => {
      const activeTurnId = getLatestKnownActiveTurnId(threadId);
      if (!turnId || !activeTurnId || turnId === activeTurnId) {
        flushItemUpserts();
        resetStreamingThreadState(workspaceId, threadId);
      }
      handleTurnCompleted(workspaceId, threadId, turnId, status);
    },
    [
      getLatestKnownActiveTurnId,
      flushItemUpserts,
      handleTurnCompleted,
      resetStreamingThreadState,
    ],
  );

  const onThreadStatusChanged = useCallback(
    (workspaceId: string, threadId: string, status: Record<string, unknown>) => {
      const statusType = String(
        status.type ?? status.statusType ?? status.status_type ?? "",
      )
        .trim()
        .toLowerCase();
      if (statusType !== "active") {
        flushItemUpserts();
        resetStreamingThreadState(workspaceId, threadId);
      }
      handleThreadStatusChanged(workspaceId, threadId, status);
    },
    [flushItemUpserts, handleThreadStatusChanged, resetStreamingThreadState],
  );

  const onThreadClosed = useCallback(
    (workspaceId: string, threadId: string) => {
      flushItemUpserts();
      resetStreamingThreadState(workspaceId, threadId);
      handleThreadClosed(workspaceId, threadId);
    },
    [flushItemUpserts, handleThreadClosed, resetStreamingThreadState],
  );

  const onTurnError = useCallback(
    (
      workspaceId: string,
      threadId: string,
      turnId: string,
      payload: { message: string; willRetry: boolean },
    ) => {
      const activeTurnId = getLatestKnownActiveTurnId(threadId);
      if (!turnId || !activeTurnId || turnId === activeTurnId) {
        flushItemUpserts();
        resetStreamingThreadState(workspaceId, threadId);
      }
      handleTurnError(workspaceId, threadId, turnId, payload);
    },
    [
      flushItemUpserts,
      getLatestKnownActiveTurnId,
      handleTurnError,
      resetStreamingThreadState,
    ],
  );

  const onBackgroundThreadAction = useCallback(
    (workspaceId: string, threadId: string, action: string) => {
      if (action !== "hide") {
        return;
      }
      dispatch({ type: "hideThread", workspaceId, threadId });
    },
    [dispatch],
  );

  const onAppServerEvent = useCallback(
    (event: AppServerEvent) => {
      const method = getAppServerRawMethod(event) ?? "";
      if (!STREAMING_DELTA_METHODS.has(method)) {
        flushStreamingDeltas();
      }
      const isTurnActivity =
        method.startsWith("item/") ||
        method.startsWith("turn/") ||
        method.startsWith("hook/") ||
        method === "error" ||
        method === "thread/status/changed" ||
        method === "thread/tokenUsage/updated";
      if (isTurnActivity) {
        const threadId = getAppServerThreadId(event);
        if (threadId) {
          recordTurnActivity?.(event.workspace_id, threadId, Date.now());
        }
      }
      const inferredSource = method === "codex/stderr" ? "stderr" : "event";
      onDebug?.({
        id: `${Date.now()}-server-event`,
        timestamp: Date.now(),
        source: inferredSource,
        label: method || "event",
        payload: event,
      });
    },
    [flushStreamingDeltas, onDebug, recordTurnActivity],
  );

  const handlers = useMemo(
    () => ({
      onWorkspaceConnected,
      onApprovalRequest,
      onRequestUserInput,
      onHookStarted,
      onHookCompleted,
      onBackgroundThreadAction,
      onAppServerEvent,
      onAgentMessageDelta,
      onAgentMessageCompleted,
      onItemStarted,
      onItemCompleted,
      onReasoningSummaryDelta,
      onReasoningSummaryBoundary,
      onReasoningTextDelta,
      onPlanDelta,
      onCommandOutputDelta,
      onTerminalInteraction,
      onFileChangeOutputDelta,
      onThreadStarted,
      onThreadNameUpdated,
      onThreadArchived,
      onThreadUnarchived,
      onTurnStarted,
      onTurnCompleted,
      onThreadStatusChanged,
      onThreadClosed,
      onTurnPlanUpdated,
      onTurnDiffUpdated,
      onThreadTokenUsageUpdated,
      onAccountRateLimitsUpdated,
      onTurnError,
      getLatestKnownActiveTurnId,
    }),
    [
      onWorkspaceConnected,
      onApprovalRequest,
      onRequestUserInput,
      onHookStarted,
      onHookCompleted,
      onBackgroundThreadAction,
      onAppServerEvent,
      onAgentMessageDelta,
      onAgentMessageCompleted,
      onItemStarted,
      onItemCompleted,
      onReasoningSummaryDelta,
      onReasoningSummaryBoundary,
      onReasoningTextDelta,
      onPlanDelta,
      onCommandOutputDelta,
      onTerminalInteraction,
      onFileChangeOutputDelta,
      onThreadStarted,
      onThreadNameUpdated,
      onThreadArchived,
      onThreadUnarchived,
      onTurnStarted,
      onTurnCompleted,
      onThreadStatusChanged,
      onThreadClosed,
      onTurnPlanUpdated,
      onTurnDiffUpdated,
      onThreadTokenUsageUpdated,
      onAccountRateLimitsUpdated,
      onTurnError,
      getLatestKnownActiveTurnId,
    ],
  );

  return handlers;
}
