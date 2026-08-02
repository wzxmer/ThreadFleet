import { useCallback } from "react";
import type { Dispatch } from "react";
import {
  buildCollabExecutionBindingObservation,
  buildConversationItem,
} from "@utils/threadItems";
import type { CollabAgentRef, ExecutionBindingObserveInput } from "@/types";
import {
  buildItemForDisplay,
  handleConvertedItemEffects,
} from "./threadItemEventHelpers";
import type { ThreadAction } from "./useThreadsReducer";

type UseThreadItemEventsOptions = {
  activeThreadId: string | null;
  dispatch: Dispatch<ThreadAction>;
  getCustomName: (workspaceId: string, threadId: string) => string | undefined;
  markProcessing: (threadId: string, isProcessing: boolean) => void;
  markReviewing: (threadId: string, isReviewing: boolean) => void;
  getActiveTurnId?: (threadId: string) => string | null;
  safeMessageActivity: () => void;
  recordThreadActivity: (
    workspaceId: string,
    threadId: string,
    timestamp?: number,
  ) => void;
  applyCollabThreadLinks: (
    workspaceId: string,
    threadId: string,
    item: Record<string, unknown>,
  ) => void;
  hydrateSubagentThreads?: (
    workspaceId: string,
    receivers: CollabAgentRef[],
  ) => void | Promise<void>;
  onUserMessageCreated?: (
    workspaceId: string,
    threadId: string,
    text: string,
  ) => void | Promise<void>;
  onReviewExited?: (workspaceId: string, threadId: string) => void;
  onExecutionBindingObserved?: (input: ExecutionBindingObserveInput) => void;
  onThreadActivity?: (
    workspaceId: string,
    threadId: string,
    activityType?: "active" | "started" | "completed",
  ) => void;
};

export function useThreadItemEvents({
  activeThreadId,
  dispatch,
  getCustomName,
  markProcessing,
  markReviewing,
  getActiveTurnId = () => null,
  safeMessageActivity,
  recordThreadActivity,
  applyCollabThreadLinks,
  hydrateSubagentThreads,
  onUserMessageCreated,
  onReviewExited,
  onExecutionBindingObserved,
  onThreadActivity,
}: UseThreadItemEventsOptions) {
  const handleItemUpdate = useCallback(
    (
      workspaceId: string,
      threadId: string,
      item: Record<string, unknown>,
      shouldMarkProcessing: boolean,
    ) => {
      dispatch({ type: "ensureThread", workspaceId, threadId });
      onThreadActivity?.(
        workspaceId,
        threadId,
        shouldMarkProcessing ? "started" : "completed",
      );
      if (shouldMarkProcessing) {
        markProcessing(threadId, true);
      }
      applyCollabThreadLinks(workspaceId, threadId, item);
      const itemType = String(item?.type ?? "");
      if (itemType === "enteredReviewMode") {
        markReviewing(threadId, true);
      } else if (itemType === "exitedReviewMode") {
        markReviewing(threadId, false);
        markProcessing(threadId, false);
        if (!shouldMarkProcessing) {
          onReviewExited?.(workspaceId, threadId);
        }
      }
      const itemForDisplay = buildItemForDisplay(item, shouldMarkProcessing);
      const bindingObservation = buildCollabExecutionBindingObservation(
        itemForDisplay,
        threadId,
      );
      if (bindingObservation) {
        try {
          onExecutionBindingObserved?.({
            workspaceId,
            ...bindingObservation,
            observedAtMs: Date.now(),
          });
        } catch {
          // Observation must not block app-server item rendering.
        }
      }
      const converted = buildConversationItem(itemForDisplay);
      handleConvertedItemEffects({
        converted,
        workspaceId,
        threadId,
        hydrateSubagentThreads,
        onUserMessageCreated,
      });
      if (converted) {
        dispatch({
          type: "upsertItem",
          workspaceId,
          threadId,
          item: {
            ...converted,
            turnId: getActiveTurnId(threadId) ?? undefined,
          },
          hasCustomName: Boolean(getCustomName(workspaceId, threadId)),
        });
      }
      safeMessageActivity();
    },
    [
      applyCollabThreadLinks,
      dispatch,
      getCustomName,
      getActiveTurnId,
      markProcessing,
      markReviewing,
      onReviewExited,
      onExecutionBindingObserved,
      onUserMessageCreated,
      onThreadActivity,
      hydrateSubagentThreads,
      safeMessageActivity,
    ],
  );

  const handleToolOutputDelta = useCallback(
    (workspaceId: string, threadId: string, itemId: string, delta: string) => {
      onThreadActivity?.(workspaceId, threadId, "active");
      markProcessing(threadId, true);
      dispatch({ type: "appendToolOutput", threadId, itemId, delta });
      safeMessageActivity();
    },
    [dispatch, markProcessing, onThreadActivity, safeMessageActivity],
  );

  const handleTerminalInteraction = useCallback(
    (workspaceId: string, threadId: string, itemId: string, stdin: string) => {
      if (!stdin) {
        return;
      }
      const normalized = stdin.replace(/\r\n/g, "\n");
      const suffix = normalized.endsWith("\n") ? "" : "\n";
      handleToolOutputDelta(
        workspaceId,
        threadId,
        itemId,
        `\n[stdin]\n${normalized}${suffix}`,
      );
    },
    [handleToolOutputDelta],
  );

  const onAgentMessageDelta = useCallback(
    ({
      workspaceId,
      threadId,
      itemId,
      turnId: eventTurnId,
      delta,
    }: {
      workspaceId: string;
      threadId: string;
      itemId: string;
      turnId?: string;
      delta: string;
    }) => {
      dispatch({ type: "ensureThread", workspaceId, threadId });
      onThreadActivity?.(workspaceId, threadId, "active");
      markProcessing(threadId, true);
      const hasCustomName = Boolean(getCustomName(workspaceId, threadId));
      const turnId = eventTurnId?.trim() || getActiveTurnId(threadId);
      dispatch({
        type: "appendAgentDelta",
        workspaceId,
        threadId,
        itemId,
        delta,
        ...(turnId ? { turnId } : {}),
        hasCustomName,
      });
    },
    [dispatch, getActiveTurnId, getCustomName, markProcessing, onThreadActivity],
  );

  const onAgentMessageCompleted = useCallback(
    ({
      workspaceId,
      threadId,
      itemId,
      turnId,
      phase,
      text,
    }: {
      workspaceId: string;
      threadId: string;
      itemId: string;
      turnId?: string;
      phase?: string | null;
      text: string;
    }) => {
      const timestamp = Date.now();
      dispatch({ type: "ensureThread", workspaceId, threadId });
      onThreadActivity?.(workspaceId, threadId, "active");
      const hasCustomName = Boolean(getCustomName(workspaceId, threadId));
      dispatch({
        type: "completeAgentMessage",
        workspaceId,
        threadId,
        itemId,
        turnId,
        phase,
        text,
        hasCustomName,
      });
      dispatch({
        type: "setThreadTimestamp",
        workspaceId,
        threadId,
        timestamp,
      });
      dispatch({
        type: "setLastAgentMessage",
        threadId,
        text,
        timestamp,
      });
      recordThreadActivity(workspaceId, threadId, timestamp);
      safeMessageActivity();
      if (threadId !== activeThreadId) {
        dispatch({ type: "markUnread", threadId, hasUnread: true });
      }
    },
    [
      activeThreadId,
      dispatch,
      getCustomName,
      onThreadActivity,
      recordThreadActivity,
      safeMessageActivity,
    ],
  );

  const onItemStarted = useCallback(
    (workspaceId: string, threadId: string, item: Record<string, unknown>) => {
      handleItemUpdate(workspaceId, threadId, item, true);
    },
    [handleItemUpdate],
  );

  const onItemCompleted = useCallback(
    (workspaceId: string, threadId: string, item: Record<string, unknown>) => {
      handleItemUpdate(workspaceId, threadId, item, false);
    },
    [handleItemUpdate],
  );

  const onReasoningSummaryDelta = useCallback(
    (workspaceId: string, threadId: string, itemId: string, delta: string) => {
      onThreadActivity?.(workspaceId, threadId, "active");
      dispatch({ type: "appendReasoningSummary", threadId, itemId, delta });
    },
    [dispatch, onThreadActivity],
  );

  const onReasoningSummaryBoundary = useCallback(
    (workspaceId: string, threadId: string, itemId: string) => {
      onThreadActivity?.(workspaceId, threadId, "active");
      dispatch({ type: "appendReasoningSummaryBoundary", threadId, itemId });
    },
    [dispatch, onThreadActivity],
  );

  const onReasoningTextDelta = useCallback(
    (workspaceId: string, threadId: string, itemId: string, delta: string) => {
      onThreadActivity?.(workspaceId, threadId, "active");
      dispatch({ type: "appendReasoningContent", threadId, itemId, delta });
    },
    [dispatch, onThreadActivity],
  );

  const onPlanDelta = useCallback(
    (workspaceId: string, threadId: string, itemId: string, delta: string) => {
      onThreadActivity?.(workspaceId, threadId, "active");
      dispatch({ type: "appendPlanDelta", threadId, itemId, delta });
    },
    [dispatch, onThreadActivity],
  );

  const onCommandOutputDelta = useCallback(
    (workspaceId: string, threadId: string, itemId: string, delta: string) => {
      handleToolOutputDelta(workspaceId, threadId, itemId, delta);
    },
    [handleToolOutputDelta],
  );

  const onTerminalInteraction = useCallback(
    (workspaceId: string, threadId: string, itemId: string, stdin: string) => {
      handleTerminalInteraction(workspaceId, threadId, itemId, stdin);
    },
    [handleTerminalInteraction],
  );

  const onFileChangeOutputDelta = useCallback(
    (workspaceId: string, threadId: string, itemId: string, delta: string) => {
      handleToolOutputDelta(workspaceId, threadId, itemId, delta);
    },
    [handleToolOutputDelta],
  );

  return {
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
  };
}
