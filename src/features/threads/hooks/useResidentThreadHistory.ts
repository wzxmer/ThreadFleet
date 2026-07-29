import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject } from "react";
import type { ApprovalRequest, RequestUserInputRequest } from "@/types";
import type { ThreadAction, ThreadState } from "./useThreadsReducer";

export const MAX_RESIDENT_THREAD_HISTORIES = 2;

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
  activeTurnIdByThread: ThreadState["activeTurnIdByThread"];
  approvals: ApprovalRequest[];
  userInputRequests: RequestUserInputRequest[];
  pendingUserMessageReplacementByThread: ThreadState["pendingUserMessageReplacementByThread"];
  loadedThreadsRef: MutableRefObject<Record<string, boolean>>;
  loadedThreadRuntimeKeyRef: MutableRefObject<Record<string, string>>;
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
  activeTurnIdByThread,
  approvals,
  userInputRequests,
  pendingUserMessageReplacementByThread,
}: Pick<
  UseResidentThreadHistoryOptions,
  | "activeThreadId"
  | "threadStatusById"
  | "threadResumeLoadingById"
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
  activeTurnIdByThread,
  approvals,
  userInputRequests,
  pendingUserMessageReplacementByThread,
  loadedThreadsRef,
  loadedThreadRuntimeKeyRef,
  dispatch,
  readThreadForWorkspace,
}: UseResidentThreadHistoryOptions) {
  const recentThreadIdsRef = useRef<string[]>([]);
  const evictedThreadIdsRef = useRef<Set<string>>(new Set());

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

    const protectedThreadIds = getProtectedResidentThreadIds({
      activeThreadId,
      threadStatusById,
      threadResumeLoadingById,
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
    threadResumeLoadingById,
    threadStatusById,
    userInputRequests,
  ]);

  const isThreadHistoryEvicted = useCallback(
    (threadId: string) => evictedThreadIdsRef.current.has(threadId),
    [],
  );

  const restoreThreadHistory = useCallback(
    async (workspaceId: string, threadId: string) => {
      const replaceLocal = evictedThreadIdsRef.current.has(threadId);
      const restoredThreadId = await readThreadForWorkspace(
        workspaceId,
        threadId,
        false,
        replaceLocal,
      );
      if (restoredThreadId) {
        evictedThreadIdsRef.current.delete(threadId);
      }
      return restoredThreadId;
    },
    [readThreadForWorkspace],
  );

  return { isThreadHistoryEvicted, restoreThreadHistory };
}
