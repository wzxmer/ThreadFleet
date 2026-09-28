import { useCallback, useEffect, useRef } from "react";
import type { Dispatch } from "react";
import {
  buildCollabExecutionBindingObservation,
  buildConversationItem,
} from "@utils/threadItems";
import type {
  CollabAgentRef,
  ConversationItem,
  ExecutionBindingObserveInput,
} from "@/types";
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

type StreamingDeltaKind =
  | "agent"
  | "reasoningSummary"
  | "reasoningContent"
  | "plan"
  | "toolOutput";

type PendingStreamingDelta = {
  kind: StreamingDeltaKind;
  workspaceId: string;
  threadId: string;
  itemId: string;
  deltas: string[];
  turnId?: string;
  hasCustomName?: boolean;
  createIfMissing?: boolean;
};

type StreamingDeltaInput = Omit<PendingStreamingDelta, "deltas"> & {
  delta: string;
};

type PendingItemUpsert = {
  workspaceId: string;
  threadId: string;
  item: ConversationItem;
  replaceExisting?: boolean;
  hasCustomName?: boolean;
};

const STREAMING_FLUSH_INTERVAL_MS = 50;

function shouldDeferItemPreparation(item: ConversationItem) {
  if (
    item.kind === "tool" &&
    (item.toolType === "collabToolCall" || item.toolType === "collabAgentToolCall")
  ) {
    return false;
  }
  return (
    item.kind === "tool" ||
    item.kind === "reasoning" ||
    item.kind === "diff" ||
    item.kind === "process" ||
    item.kind === "explore"
  );
}

function isSameStreamingDelta(
  left: PendingStreamingDelta,
  right: StreamingDeltaInput,
) {
  return (
    left.kind === right.kind &&
    left.threadId === right.threadId &&
    left.itemId === right.itemId
  );
}

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
  const pendingStreamingDeltasRef = useRef<PendingStreamingDelta[]>([]);
  const pendingItemUpsertsRef = useRef<PendingItemUpsert[]>([]);
  const ensuredStreamingThreadsRef = useRef<Set<string>>(new Set());
  const processingStreamingThreadsRef = useRef<Set<string>>(new Set());
  const streamingFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const itemUpsertFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushItemUpserts = useCallback(() => {
    if (itemUpsertFlushTimerRef.current !== null) {
      clearTimeout(itemUpsertFlushTimerRef.current);
      itemUpsertFlushTimerRef.current = null;
    }
    const pending = pendingItemUpsertsRef.current;
    if (pending.length === 0) {
      return;
    }
    pendingItemUpsertsRef.current = [];
    const grouped = new Map<string, PendingItemUpsert[]>();
    pending.forEach((entry) => {
      const key = `${entry.workspaceId}:${entry.threadId}`;
      const group = grouped.get(key);
      if (group) {
        group.push(entry);
      } else {
        grouped.set(key, [entry]);
      }
    });
    grouped.forEach((items) => {
      dispatch({
        type: "upsertItems",
        items,
      });
    });
  }, [dispatch]);

  const scheduleItemUpsertFlush = useCallback(() => {
    if (itemUpsertFlushTimerRef.current !== null) {
      return;
    }
    itemUpsertFlushTimerRef.current = setTimeout(() => {
      itemUpsertFlushTimerRef.current = null;
      flushItemUpserts();
    }, STREAMING_FLUSH_INTERVAL_MS);
  }, [flushItemUpserts]);

  const queueItemUpsert = useCallback(
    ({
      workspaceId,
      threadId,
      item,
      replaceExisting,
      hasCustomName,
    }: PendingItemUpsert) => {
      pendingItemUpsertsRef.current.push({
        workspaceId,
        threadId,
        item,
        ...(replaceExisting ? { replaceExisting } : {}),
        ...(hasCustomName !== undefined ? { hasCustomName } : {}),
      });
      scheduleItemUpsertFlush();
    },
    [scheduleItemUpsertFlush],
  );

  const flushStreamingDeltas = useCallback(() => {
    if (streamingFlushTimerRef.current !== null) {
      clearTimeout(streamingFlushTimerRef.current);
      streamingFlushTimerRef.current = null;
    }
    const pending = pendingStreamingDeltasRef.current;
    if (pending.length === 0) {
      return;
    }
    pendingStreamingDeltasRef.current = [];
    pending.forEach((entry) => {
      if (entry.kind === "agent") {
        dispatch({
          type: "appendAgentDelta",
          workspaceId: entry.workspaceId,
          threadId: entry.threadId,
          itemId: entry.itemId,
          delta: entry.deltas,
          ...(entry.turnId ? { turnId: entry.turnId } : {}),
          hasCustomName: Boolean(entry.hasCustomName),
        });
        return;
      }
      const actionType =
        entry.kind === "reasoningSummary"
          ? "appendReasoningSummary"
          : entry.kind === "reasoningContent"
            ? "appendReasoningContent"
            : entry.kind === "plan"
              ? "appendPlanDelta"
              : "appendToolOutput";
      dispatch({
        type: actionType,
        threadId: entry.threadId,
        itemId: entry.itemId,
        delta: entry.deltas,
        ...(entry.createIfMissing ? { createIfMissing: true } : {}),
      });
    });
  }, [dispatch]);

  const resetStreamingThreadState = useCallback(
    (workspaceId: string, threadId: string) => {
      flushStreamingDeltas();
      const threadKey = `${workspaceId}:${threadId}`;
      ensuredStreamingThreadsRef.current.delete(threadKey);
      processingStreamingThreadsRef.current.delete(threadKey);
    },
    [flushStreamingDeltas],
  );

  const scheduleStreamingFlush = useCallback(() => {
    if (streamingFlushTimerRef.current !== null) {
      return;
    }
    streamingFlushTimerRef.current = setTimeout(() => {
      streamingFlushTimerRef.current = null;
      flushStreamingDeltas();
    }, STREAMING_FLUSH_INTERVAL_MS);
  }, [flushStreamingDeltas]);

  const queueStreamingDelta = useCallback(
    ({
      kind,
      workspaceId,
      threadId,
      itemId,
      delta,
      turnId,
      hasCustomName,
      createIfMissing,
    }: StreamingDeltaInput) => {
      const pending = pendingStreamingDeltasRef.current;
      const incoming: StreamingDeltaInput = {
        kind,
        workspaceId,
        threadId,
        itemId,
        delta,
        turnId,
        hasCustomName,
        createIfMissing,
      };
      const existing = pending[pending.length - 1];
      if (existing && isSameStreamingDelta(existing, incoming)) {
        existing.deltas.push(delta);
        if (turnId) {
          existing.turnId = turnId;
        }
        if (hasCustomName !== undefined) {
          existing.hasCustomName = hasCustomName;
        }
      } else {
        pending.push({ ...incoming, deltas: [delta] });
      }
      scheduleStreamingFlush();
    },
    [scheduleStreamingFlush],
  );

  useEffect(
    () => () => {
      flushItemUpserts();
      flushStreamingDeltas();
    },
    [flushItemUpserts, flushStreamingDeltas],
  );

  const handleItemUpdate = useCallback(
    (
      workspaceId: string,
      threadId: string,
      item: Record<string, unknown>,
      shouldMarkProcessing: boolean,
      eventTurnId?: string,
    ) => {
      flushStreamingDeltas();
      if (!shouldMarkProcessing) {
        resetStreamingThreadState(workspaceId, threadId);
      }
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
        const turnId =
          eventTurnId?.trim() ||
          String(item.turnId ?? item.turn_id ?? "").trim() ||
          getActiveTurnId(threadId) ||
          undefined;
        const upsert = {
          workspaceId,
          threadId,
          item: {
            ...converted,
            ...(turnId ? { turnId } : {}),
          },
          hasCustomName: Boolean(getCustomName(workspaceId, threadId)),
        } satisfies PendingItemUpsert;
        if (shouldDeferItemPreparation(converted)) {
          queueItemUpsert(upsert);
        } else {
          flushItemUpserts();
          dispatch({ type: "upsertItem", ...upsert });
        }
      }
      safeMessageActivity();
    },
    [
      applyCollabThreadLinks,
      dispatch,
      getCustomName,
      getActiveTurnId,
      flushItemUpserts,
      markProcessing,
      markReviewing,
      onReviewExited,
      onExecutionBindingObserved,
      onUserMessageCreated,
      onThreadActivity,
      hydrateSubagentThreads,
      flushStreamingDeltas,
      queueItemUpsert,
      resetStreamingThreadState,
      safeMessageActivity,
    ],
  );

  const handleToolOutputDelta = useCallback(
    (workspaceId: string, threadId: string, itemId: string, delta: string) => {
      onThreadActivity?.(workspaceId, threadId, "active");
      const threadKey = `${workspaceId}:${threadId}`;
      if (!processingStreamingThreadsRef.current.has(threadKey)) {
        processingStreamingThreadsRef.current.add(threadKey);
        markProcessing(threadId, true);
      }
      queueStreamingDelta({
        kind: "toolOutput",
        workspaceId,
        threadId,
        itemId,
        delta,
        createIfMissing: true,
      });
      safeMessageActivity();
    },
    [markProcessing, onThreadActivity, queueStreamingDelta, safeMessageActivity],
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
      const threadKey = `${workspaceId}:${threadId}`;
      if (!ensuredStreamingThreadsRef.current.has(threadKey)) {
        ensuredStreamingThreadsRef.current.add(threadKey);
        dispatch({ type: "ensureThread", workspaceId, threadId });
      }
      onThreadActivity?.(workspaceId, threadId, "active");
      if (!processingStreamingThreadsRef.current.has(threadKey)) {
        processingStreamingThreadsRef.current.add(threadKey);
        markProcessing(threadId, true);
      }
      const hasCustomName = Boolean(getCustomName(workspaceId, threadId));
      const turnId = eventTurnId?.trim() || getActiveTurnId(threadId);
      queueStreamingDelta({
        kind: "agent",
        workspaceId,
        threadId,
        itemId,
        delta,
        ...(turnId ? { turnId } : {}),
        hasCustomName,
      });
    },
    [dispatch, getActiveTurnId, getCustomName, markProcessing, onThreadActivity, queueStreamingDelta],
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
      flushItemUpserts();
      resetStreamingThreadState(workspaceId, threadId);
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
      flushItemUpserts,
      onThreadActivity,
      recordThreadActivity,
      resetStreamingThreadState,
      safeMessageActivity,
    ],
  );

  const onItemStarted = useCallback(
    (
      workspaceId: string,
      threadId: string,
      item: Record<string, unknown>,
      eventTurnId?: string,
    ) => {
      handleItemUpdate(workspaceId, threadId, item, true, eventTurnId);
    },
    [handleItemUpdate],
  );

  const onItemCompleted = useCallback(
    (
      workspaceId: string,
      threadId: string,
      item: Record<string, unknown>,
      eventTurnId?: string,
    ) => {
      handleItemUpdate(workspaceId, threadId, item, false, eventTurnId);
    },
    [handleItemUpdate],
  );

  const onReasoningSummaryDelta = useCallback(
    (workspaceId: string, threadId: string, itemId: string, delta: string) => {
      onThreadActivity?.(workspaceId, threadId, "active");
      queueStreamingDelta({ kind: "reasoningSummary", workspaceId, threadId, itemId, delta });
    },
    [onThreadActivity, queueStreamingDelta],
  );

  const onReasoningSummaryBoundary = useCallback(
    (workspaceId: string, threadId: string, itemId: string) => {
      flushStreamingDeltas();
      onThreadActivity?.(workspaceId, threadId, "active");
      dispatch({ type: "appendReasoningSummaryBoundary", threadId, itemId });
    },
    [dispatch, flushStreamingDeltas, onThreadActivity],
  );

  const onReasoningTextDelta = useCallback(
    (workspaceId: string, threadId: string, itemId: string, delta: string) => {
      onThreadActivity?.(workspaceId, threadId, "active");
      queueStreamingDelta({ kind: "reasoningContent", workspaceId, threadId, itemId, delta });
    },
    [onThreadActivity, queueStreamingDelta],
  );

  const onPlanDelta = useCallback(
    (workspaceId: string, threadId: string, itemId: string, delta: string) => {
      onThreadActivity?.(workspaceId, threadId, "active");
      queueStreamingDelta({ kind: "plan", workspaceId, threadId, itemId, delta });
    },
    [onThreadActivity, queueStreamingDelta],
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
    flushItemUpserts,
    flushStreamingDeltas,
    resetStreamingThreadState,
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
