import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject } from "react";
import type { ApprovalRequest, RequestUserInputRequest } from "@/types";
import type { ThreadAction, ThreadState } from "./useThreadsReducer";

export const MAX_RESIDENT_THREAD_HISTORIES = 2;
export const THREAD_HISTORY_RESTORE_RETRY_DELAYS_MS = [300, 1000] as const;

type ReadThreadForWorkspace = (
  workspaceId: string,
  threadId: string,
  force?: boolean,
  replaceLocal?: boolean,
) => Promise<string | null>;

type UseResidentThreadHistoryOptions = {
  activeThreadId: string | null;
  itemsByThread: ThreadState["itemsByThread"];
  itemsByThreadRef: MutableRefObject<ThreadState["itemsByThread"]>;
  threadStatusById: ThreadState["threadStatusById"];
  threadResumeLoadingById: ThreadState["threadResumeLoadingById"];
  threadHistoryRestoreStateById: ThreadState["threadHistoryRestoreStateById"];
  threadHistoryRecoveryAnchorThreadId: string | null;
  activeTurnIdByThread: ThreadState["activeTurnIdByThread"];
  approvals: ApprovalRequest[];
  userInputRequests: RequestUserInputRequest[];
  pendingUserMessageReplacementByThread: ThreadState["pendingUserMessageReplacementByThread"];
  loadedThreadsRef: MutableRefObject<Record<string, boolean>>;
  loadedThreadRuntimeKeyRef: MutableRefObject<Record<string, string>>;
  runtimeKey: string;
  dispatch: Dispatch<ThreadAction>;
  readThreadForWorkspace: ReadThreadForWorkspace;
};

function asThreadId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getApprovalThreadId(approval: ApprovalRequest) {
  const params = approval.params ?? {};
  return (
    asThreadId(params.thread_id) ??
    asThreadId(params.threadId) ??
    (params.turn && typeof params.turn === "object"
      ? asThreadId((params.turn as Record<string, unknown>).thread_id) ??
        asThreadId((params.turn as Record<string, unknown>).threadId)
      : null)
  );
}

export function getProtectedResidentThreadIds({
  activeThreadId,
  threadStatusById,
  threadResumeLoadingById,
  threadHistoryRestoreStateById,
  threadHistoryRecoveryAnchorThreadId,
  activeTurnIdByThread,
  approvals,
  userInputRequests,
  pendingUserMessageReplacementByThread,
}: Pick<
  UseResidentThreadHistoryOptions,
  | "activeThreadId"
  | "threadStatusById"
  | "threadResumeLoadingById"
  | "threadHistoryRestoreStateById"
  | "threadHistoryRecoveryAnchorThreadId"
  | "activeTurnIdByThread"
  | "approvals"
  | "userInputRequests"
  | "pendingUserMessageReplacementByThread"
>) {
  const protectedThreadIds = new Set<string>();
  if (activeThreadId) {
    protectedThreadIds.add(activeThreadId);
  }
  Object.entries(threadStatusById).forEach(([threadId, status]) => {
    if (status.isProcessing || status.isReviewing) {
      protectedThreadIds.add(threadId);
    }
  });
  Object.entries(threadResumeLoadingById).forEach(([threadId, isLoading]) => {
    if (isLoading) {
      protectedThreadIds.add(threadId);
    }
  });
  Object.entries(threadHistoryRestoreStateById).forEach(([threadId, state]) => {
    if (state === "loading") {
      protectedThreadIds.add(threadId);
    }
  });
  if (threadHistoryRecoveryAnchorThreadId) {
    protectedThreadIds.add(threadHistoryRecoveryAnchorThreadId);
  }
  Object.entries(activeTurnIdByThread).forEach(([threadId, turnId]) => {
    if (turnId) {
      protectedThreadIds.add(threadId);
    }
  });
  approvals.forEach((approval) => {
    const threadId = getApprovalThreadId(approval);
    if (threadId) {
      protectedThreadIds.add(threadId);
    }
  });
  userInputRequests.forEach((request) => {
    const threadId = asThreadId(request.params.thread_id);
    if (threadId) {
      protectedThreadIds.add(threadId);
    }
  });
  Object.keys(pendingUserMessageReplacementByThread).forEach((threadId) => {
    protectedThreadIds.add(threadId);
  });
  return protectedThreadIds;
}

export function selectResidentThreadEvictions(
  residentThreadIds: string[],
  recentThreadIds: string[],
  protectedThreadIds: ReadonlySet<string>,
  maxRecent = MAX_RESIDENT_THREAD_HISTORIES,
) {
  const keep = new Set(recentThreadIds.slice(-Math.max(0, maxRecent)));
  protectedThreadIds.forEach((threadId) => keep.add(threadId));
  return residentThreadIds.filter((threadId) => !keep.has(threadId));
}

export function useResidentThreadHistory({
  activeThreadId,
  itemsByThread,
  itemsByThreadRef,
  threadStatusById,
  threadResumeLoadingById,
  threadHistoryRestoreStateById,
  threadHistoryRecoveryAnchorThreadId,
  activeTurnIdByThread,
  approvals,
  userInputRequests,
  pendingUserMessageReplacementByThread,
  loadedThreadsRef,
  loadedThreadRuntimeKeyRef,
  runtimeKey,
  dispatch,
  readThreadForWorkspace,
}: UseResidentThreadHistoryOptions) {
  const recentThreadIdsRef = useRef<string[]>([]);
  const evictedThreadIdsRef = useRef<Set<string>>(new Set());
  const restoreInFlightByThreadRef = useRef<Map<string, Promise<string | null>>>(
    new Map(),
  );

  useEffect(() => {
    const residentThreadIds = Object.keys(itemsByThread);
    const residentSet = new Set(residentThreadIds);
    const recentThreadIds = recentThreadIdsRef.current.filter((threadId) =>
      residentSet.has(threadId),
    );
    const recentSet = new Set(recentThreadIds);
    residentThreadIds.forEach((threadId) => {
      if (!recentSet.has(threadId)) {
        recentThreadIds.push(threadId);
      }
    });
    if (activeThreadId && residentSet.has(activeThreadId)) {
      const activeIndex = recentThreadIds.indexOf(activeThreadId);
      if (activeIndex >= 0) {
        recentThreadIds.splice(activeIndex, 1);
      }
      recentThreadIds.push(activeThreadId);
    }

    const anchorRuntimeKey = threadHistoryRecoveryAnchorThreadId
      ? loadedThreadRuntimeKeyRef.current[threadHistoryRecoveryAnchorThreadId]
      : null;
    const recoveryAnchorThreadId =
      threadHistoryRecoveryAnchorThreadId &&
      (!anchorRuntimeKey || anchorRuntimeKey === runtimeKey)
        ? threadHistoryRecoveryAnchorThreadId
        : null;
    if (threadHistoryRecoveryAnchorThreadId && !recoveryAnchorThreadId) {
      dispatch({
        type: "clearThreadHistoryRecoveryAnchor",
        threadId: threadHistoryRecoveryAnchorThreadId,
      });
    }

    const protectedThreadIds = getProtectedResidentThreadIds({
      activeThreadId,
      threadStatusById,
      threadResumeLoadingById,
      threadHistoryRestoreStateById,
      threadHistoryRecoveryAnchorThreadId: recoveryAnchorThreadId,
      activeTurnIdByThread,
      approvals,
      userInputRequests,
      pendingUserMessageReplacementByThread,
    });
    const evictedThreadIds = selectResidentThreadEvictions(
      residentThreadIds,
      recentThreadIds,
      protectedThreadIds,
    );
    if (evictedThreadIds.length === 0) {
      recentThreadIdsRef.current = recentThreadIds;
      return;
    }

    const nextItemsByThread = { ...itemsByThreadRef.current };
    evictedThreadIds.forEach((threadId) => {
      delete nextItemsByThread[threadId];
      loadedThreadsRef.current[threadId] = false;
      delete loadedThreadRuntimeKeyRef.current[threadId];
      evictedThreadIdsRef.current.add(threadId);
    });
    itemsByThreadRef.current = nextItemsByThread;
    recentThreadIdsRef.current = recentThreadIds.filter(
      (threadId) => !evictedThreadIdsRef.current.has(threadId),
    );
    dispatch({ type: "evictThreadItems", threadIds: evictedThreadIds });
  }, [
    activeThreadId,
    activeTurnIdByThread,
    approvals,
    dispatch,
    itemsByThread,
    itemsByThreadRef,
    loadedThreadRuntimeKeyRef,
    loadedThreadsRef,
    pendingUserMessageReplacementByThread,
    runtimeKey,
    threadHistoryRecoveryAnchorThreadId,
    threadHistoryRestoreStateById,
    threadResumeLoadingById,
    threadStatusById,
    userInputRequests,
  ]);

  const isThreadHistoryEvicted = useCallback(
    (threadId: string) => evictedThreadIdsRef.current.has(threadId),
    [],
  );

  const restoreThreadHistory = useCallback(
    (workspaceId: string, threadId: string) => {
      const restoreKey = `${workspaceId}:${threadId}`;
      const existingRestore = restoreInFlightByThreadRef.current.get(restoreKey);
      if (existingRestore) {
        return existingRestore;
      }

      const restorePromise = (async () => {
        dispatch({
          type: "setThreadHistoryRestoreState",
          threadId,
          state: "loading",
        });
        const replaceLocal = evictedThreadIdsRef.current.has(threadId);
        for (
          let attempt = 0;
          attempt <= THREAD_HISTORY_RESTORE_RETRY_DELAYS_MS.length;
          attempt += 1
        ) {
          const restoredThreadId = await readThreadForWorkspace(
            workspaceId,
            threadId,
            attempt > 0,
            replaceLocal,
          );
          if (restoredThreadId) {
            evictedThreadIdsRef.current.delete(threadId);
            dispatch({
              type: "setThreadHistoryRestoreState",
              threadId,
              state: null,
            });
            return restoredThreadId;
          }
          const retryDelay = THREAD_HISTORY_RESTORE_RETRY_DELAYS_MS[attempt];
          if (retryDelay !== undefined) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, retryDelay);
            });
          }
        }
        dispatch({
          type: "setThreadHistoryRestoreState",
          threadId,
          state: "failed",
        });
        return null;
      })();

      restoreInFlightByThreadRef.current.set(restoreKey, restorePromise);
      void restorePromise.finally(() => {
        if (restoreInFlightByThreadRef.current.get(restoreKey) === restorePromise) {
          restoreInFlightByThreadRef.current.delete(restoreKey);
        }
      });
      return restorePromise;
    },
    [dispatch, readThreadForWorkspace],
  );

  return { isThreadHistoryEvicted, restoreThreadHistory };
}
