import type { ThreadSummary } from "@/types";
import { insertThreadSummaryBySort } from "@threads/utils/threadSummaryOrder";
import type { ThreadAction, ThreadState } from "../useThreadsReducer";
import { prefersUpdatedSort } from "./common";

type ThreadStatus = ThreadState["threadStatusById"][string];

function statusEquals(previous: ThreadStatus, nextStatus: ThreadStatus) {
  return (
    previous.isProcessing === nextStatus.isProcessing &&
    previous.hasUnread === nextStatus.hasUnread &&
    previous.isReviewing === nextStatus.isReviewing &&
    previous.processingStartedAt === nextStatus.processingStartedAt &&
    previous.lastDurationMs === nextStatus.lastDurationMs
  );
}

function mergeThreadSummary(base: ThreadSummary, next: ThreadSummary): ThreadSummary {
  const baseUpdatedAt = base.updatedAt ?? 0;
  const nextUpdatedAt = next.updatedAt ?? 0;
  const preferred = nextUpdatedAt >= baseUpdatedAt ? next : base;
  const fallback = preferred === next ? base : next;
  const nameSource =
    preferred.nameIsFallback && !fallback.nameIsFallback
      ? fallback
      : preferred.name
        ? preferred
        : fallback;
  const { nameIsFallback: _ignored, ...merged } = {
    ...fallback,
    ...preferred,
  };
  return {
    ...merged,
    name: nameSource.name,
    ...(nameSource.nameIsFallback ? { nameIsFallback: true } : {}),
    updatedAt: Math.max(baseUpdatedAt, nextUpdatedAt),
  };
}

function dedupeThreadSummaries(threads: ThreadSummary[]) {
  const byId = new Map<string, ThreadSummary>();
  const orderedIds: string[] = [];
  threads.forEach((thread) => {
    if (!thread.id) {
      return;
    }
    const existing = byId.get(thread.id);
    if (!existing) {
      byId.set(thread.id, thread);
      orderedIds.push(thread.id);
      return;
    }
    byId.set(thread.id, mergeThreadSummary(existing, thread));
  });
  return orderedIds
    .map((id) => byId.get(id))
    .filter((thread): thread is ThreadSummary => Boolean(thread));
}

function getThreadRootId(
  threadId: string,
  presentThreadIds: Set<string>,
  threadParentById: ThreadState["threadParentById"],
) {
  let rootId = threadId;
  const visited = new Set<string>([threadId]);
  let parentId = threadParentById[threadId];
  while (parentId && presentThreadIds.has(parentId) && !visited.has(parentId)) {
    visited.add(parentId);
    rootId = parentId;
    parentId = threadParentById[parentId];
  }
  return rootId;
}

function getPendingThreadIds(state: ThreadState, workspaceId: string) {
  const pendingThreadIds = new Set<string>();
  state.approvals.forEach((approval) => {
    if (approval.workspace_id !== workspaceId) {
      return;
    }
    const threadId = String(
      approval.params?.threadId ?? approval.params?.thread_id ?? "",
    ).trim();
    if (threadId) {
      pendingThreadIds.add(threadId);
    }
  });
  state.userInputRequests.forEach((request) => {
    if (request.workspace_id === workspaceId && request.params.thread_id) {
      pendingThreadIds.add(request.params.thread_id);
    }
  });
  return pendingThreadIds;
}

function omitThreadKeys<T>(record: Record<string, T>, omittedIds: Set<string>) {
  let changed = false;
  const next: Record<string, T> = {};
  Object.entries(record).forEach(([threadId, value]) => {
    if (omittedIds.has(threadId)) {
      changed = true;
      return;
    }
    next[threadId] = value;
  });
  return changed ? next : record;
}

export function reduceThreadLifecycle(
  state: ThreadState,
  action: ThreadAction,
): ThreadState {
  switch (action.type) {
    case "setActiveThreadId":
      return {
        ...state,
        activeThreadIdByWorkspace: {
          ...state.activeThreadIdByWorkspace,
          [action.workspaceId]: action.threadId,
        },
        threadStatusById: action.threadId
          ? {
              ...state.threadStatusById,
              [action.threadId]: {
                isProcessing:
                  state.threadStatusById[action.threadId]?.isProcessing ?? false,
                hasUnread: false,
                isReviewing:
                  state.threadStatusById[action.threadId]?.isReviewing ?? false,
                processingStartedAt:
                  state.threadStatusById[action.threadId]?.processingStartedAt ??
                  null,
                lastDurationMs:
                  state.threadStatusById[action.threadId]?.lastDurationMs ?? null,
              },
            }
          : state.threadStatusById,
      };
    case "ensureThread": {
      const hidden =
        state.hiddenThreadIdsByWorkspace[action.workspaceId]?.[action.threadId] ??
        false;
      if (hidden) {
        return state;
      }
      const list = state.threadsByWorkspace[action.workspaceId] ?? [];
      if (list.some((thread) => thread.id === action.threadId)) {
        return state;
      }
      const thread: ThreadSummary = {
        id: action.threadId,
        name: "New Agent",
        updatedAt: 0,
      };
      return {
        ...state,
        threadsByWorkspace: {
          ...state.threadsByWorkspace,
          [action.workspaceId]: [thread, ...list],
        },
        threadStatusById: {
          ...state.threadStatusById,
          [action.threadId]: {
            isProcessing: false,
            hasUnread: false,
            isReviewing: false,
            processingStartedAt: null,
            lastDurationMs: null,
          },
        },
        activeThreadIdByWorkspace: {
          ...state.activeThreadIdByWorkspace,
          [action.workspaceId]:
            state.activeThreadIdByWorkspace[action.workspaceId] ?? action.threadId,
        },
      };
    }
    case "hideThread": {
      const hiddenForWorkspace =
        state.hiddenThreadIdsByWorkspace[action.workspaceId] ?? {};
      if (hiddenForWorkspace[action.threadId]) {
        return state;
      }

      const nextHiddenForWorkspace = {
        ...hiddenForWorkspace,
        [action.threadId]: true as const,
      };

      const list = state.threadsByWorkspace[action.workspaceId] ?? [];
      const filtered = list.filter((thread) => thread.id !== action.threadId);
      const nextActive =
        state.activeThreadIdByWorkspace[action.workspaceId] === action.threadId
          ? filtered[0]?.id ?? null
          : state.activeThreadIdByWorkspace[action.workspaceId] ?? null;

      return {
        ...state,
        hiddenThreadIdsByWorkspace: {
          ...state.hiddenThreadIdsByWorkspace,
          [action.workspaceId]: nextHiddenForWorkspace,
        },
        threadsByWorkspace: {
          ...state.threadsByWorkspace,
          [action.workspaceId]: filtered,
        },
        activeThreadIdByWorkspace: {
          ...state.activeThreadIdByWorkspace,
          [action.workspaceId]: nextActive,
        },
      };
    }
    case "removeThread": {
      const list = state.threadsByWorkspace[action.workspaceId] ?? [];
      const filtered = list.filter((thread) => thread.id !== action.threadId);
      const nextActive =
        state.activeThreadIdByWorkspace[action.workspaceId] === action.threadId
          ? filtered[0]?.id ?? null
          : state.activeThreadIdByWorkspace[action.workspaceId] ?? null;
      const { [action.threadId]: _, ...restItems } = state.itemsByThread;
      const { [action.threadId]: __, ...restStatus } = state.threadStatusById;
      const { [action.threadId]: ___, ...restTurns } = state.activeTurnIdByThread;
      const { [action.threadId]: ____, ...restDiffs } = state.turnDiffByThread;
      const { [action.threadId]: _____, ...restExecutionSummaries } =
        state.turnExecutionSummaryByThread;
      const { [action.threadId]: ______, ...restExecutionSummaryLists } =
        state.turnExecutionSummariesByThread;
      const { [action.threadId]: _______, ...restPlans } = state.planByThread;
      const { [action.threadId]: ________, ...restParents } = state.threadParentById;
      const { [action.threadId]: _________, ...restInterrupted } =
        state.interruptedThreadById;
      const {
        [action.threadId]: __________,
        ...restPendingUserMessageReplacement
      } = state.pendingUserMessageReplacementByThread;
      const {
        [action.threadId]: ___________,
        ...restCompletedContextCompactionIds
      } = state.completedContextCompactionIdsByThread;
      return {
        ...state,
        threadsByWorkspace: {
          ...state.threadsByWorkspace,
          [action.workspaceId]: filtered,
        },
        itemsByThread: restItems,
        threadStatusById: restStatus,
        activeTurnIdByThread: restTurns,
        turnDiffByThread: restDiffs,
        turnExecutionSummaryByThread: restExecutionSummaries,
        turnExecutionSummariesByThread: restExecutionSummaryLists,
        planByThread: restPlans,
        threadParentById: restParents,
        interruptedThreadById: restInterrupted,
        pendingUserMessageReplacementByThread: restPendingUserMessageReplacement,
        completedContextCompactionIdsByThread:
          restCompletedContextCompactionIds,
        activeThreadIdByWorkspace: {
          ...state.activeThreadIdByWorkspace,
          [action.workspaceId]: nextActive,
        },
      };
    }
    case "setThreadParent": {
      if (!action.parentId || action.parentId === action.threadId) {
        return state;
      }
      if (state.threadParentById[action.threadId] === action.parentId) {
        return state;
      }
      return {
        ...state,
        threadParentById: {
          ...state.threadParentById,
          [action.threadId]: action.parentId,
        },
      };
    }
    case "markProcessing": {
      const previous = state.threadStatusById[action.threadId];
      const wasProcessing = previous?.isProcessing ?? false;
      const startedAt = previous?.processingStartedAt ?? null;
      const lastDurationMs = previous?.lastDurationMs ?? null;
      const hasUnread = previous?.hasUnread ?? false;
      const isReviewing = previous?.isReviewing ?? false;
      if (action.isProcessing) {
        const nextStartedAt =
          wasProcessing && startedAt ? startedAt : action.timestamp;
        const nextStatus: ThreadStatus = {
          isProcessing: true,
          hasUnread,
          isReviewing,
          processingStartedAt: nextStartedAt,
          lastDurationMs,
        };
        if (previous && statusEquals(previous, nextStatus)) {
          return state;
        }
        return {
          ...state,
          threadStatusById: {
            ...state.threadStatusById,
            [action.threadId]: nextStatus,
          },
          interruptedThreadById: (() => {
            const { [action.threadId]: _, ...rest } = state.interruptedThreadById;
            return rest;
          })(),
        };
      }
      const nextDuration =
        wasProcessing && startedAt
          ? Math.max(0, action.timestamp - startedAt)
          : lastDurationMs ?? null;
      const nextStatus: ThreadStatus = {
        isProcessing: false,
        hasUnread,
        isReviewing,
        processingStartedAt: null,
        lastDurationMs: nextDuration,
      };
      if (previous && statusEquals(previous, nextStatus)) {
        return state;
      }
      return {
        ...state,
        threadStatusById: {
          ...state.threadStatusById,
          [action.threadId]: nextStatus,
        },
      };
    }
    case "markThreadInterrupted":
      return {
        ...state,
        interruptedThreadById: {
          ...state.interruptedThreadById,
          [action.threadId]: { timestamp: action.timestamp },
        },
      };
    case "clearThreadInterrupted": {
      if (!state.interruptedThreadById[action.threadId]) {
        return state;
      }
      const { [action.threadId]: _, ...rest } = state.interruptedThreadById;
      return {
        ...state,
        interruptedThreadById: rest,
      };
    }
    case "setActiveTurnId":
      return {
        ...state,
        activeTurnIdByThread: {
          ...state.activeTurnIdByThread,
          [action.threadId]: action.turnId,
        },
      };
    case "markReviewing": {
      const previous = state.threadStatusById[action.threadId];
      const nextStatus: ThreadStatus = {
        isProcessing: previous?.isProcessing ?? false,
        hasUnread: previous?.hasUnread ?? false,
        isReviewing: action.isReviewing,
        processingStartedAt: previous?.processingStartedAt ?? null,
        lastDurationMs: previous?.lastDurationMs ?? null,
      };
      if (previous && statusEquals(previous, nextStatus)) {
        return state;
      }
      return {
        ...state,
        threadStatusById: {
          ...state.threadStatusById,
          [action.threadId]: nextStatus,
        },
      };
    }
    case "markUnread": {
      const previous = state.threadStatusById[action.threadId];
      const nextStatus: ThreadStatus = {
        isProcessing: previous?.isProcessing ?? false,
        hasUnread: action.hasUnread,
        isReviewing: previous?.isReviewing ?? false,
        processingStartedAt: previous?.processingStartedAt ?? null,
        lastDurationMs: previous?.lastDurationMs ?? null,
      };
      if (previous && statusEquals(previous, nextStatus)) {
        return state;
      }
      return {
        ...state,
        threadStatusById: {
          ...state.threadStatusById,
          [action.threadId]: nextStatus,
        },
      };
    }
    case "setThreadName": {
      const list = state.threadsByWorkspace[action.workspaceId] ?? [];
      if (!list.length) {
        return state;
      }
      let didChange = false;
      const next = list.map((thread) => {
        if (
          thread.id !== action.threadId ||
          (thread.name === action.name && !thread.nameIsFallback)
        ) {
          return thread;
        }
        didChange = true;
        const { nameIsFallback: _ignored, ...resolvedThread } = thread;
        return { ...resolvedThread, name: action.name };
      });
      if (!didChange) {
        return state;
      }
      return {
        ...state,
        threadsByWorkspace: {
          ...state.threadsByWorkspace,
          [action.workspaceId]: next,
        },
      };
    }
    case "mergeThreadSummary": {
      const list = state.threadsByWorkspace[action.workspaceId] ?? [];
      if (!list.length) {
        return state;
      }
      let didChange = false;
      const next = list.map((thread) => {
        if (thread.id !== action.threadId) {
          return thread;
        }
        const patchEntries = Object.entries(action.patch).filter(
          ([, value]) => value !== undefined,
        ) as Array<[keyof typeof action.patch, NonNullable<(typeof action.patch)[keyof typeof action.patch]>]>;
        if (!patchEntries.length) {
          return thread;
        }
        let nextThread = thread;
        patchEntries.forEach(([key, value]) => {
          if (nextThread[key as keyof ThreadSummary] === value) {
            return;
          }
          nextThread = {
            ...nextThread,
            [key]: value,
          };
          didChange = true;
        });
        return nextThread;
      });
      if (!didChange) {
        return state;
      }
      return {
        ...state,
        threadsByWorkspace: {
          ...state.threadsByWorkspace,
          [action.workspaceId]: next,
        },
      };
    }
    case "setThreadTimestamp": {
      const list = state.threadsByWorkspace[action.workspaceId] ?? [];
      if (!list.length) {
        return state;
      }
      let didChange = false;
      const next = list.map((thread) => {
        if (thread.id !== action.threadId) {
          return thread;
        }
        const current = thread.updatedAt ?? 0;
        if (current >= action.timestamp) {
          return thread;
        }
        didChange = true;
        return { ...thread, updatedAt: action.timestamp };
      });
      if (!didChange) {
        return state;
      }
      const sorted = prefersUpdatedSort(state, action.workspaceId)
        ? [
            ...next.filter((thread) => thread.id === action.threadId),
            ...next.filter((thread) => thread.id !== action.threadId),
          ]
        : next;
      return {
        ...state,
        threadsByWorkspace: {
          ...state.threadsByWorkspace,
          [action.workspaceId]: sorted,
        },
      };
    }
    case "setThreads": {
      const currentContinuity =
        state.threadListContinuityByWorkspace[action.workspaceId];
      if (action.continuity && currentContinuity) {
        const isOlderRuntime =
          action.continuity.runtimeGeneration <
          currentContinuity.runtimeGeneration;
        const isOlderRequest =
          action.continuity.runtimeGeneration ===
            currentContinuity.runtimeGeneration &&
          action.continuity.requestSequence <
            currentContinuity.requestSequence;
        if (isOlderRuntime || isOlderRequest) {
          return state;
        }
      }
      const hidden = state.hiddenThreadIdsByWorkspace[action.workspaceId] ?? {};
      const nextContinuityByWorkspace =
        action.continuity === null
          ? {
              ...state.threadListContinuityByWorkspace,
              [action.workspaceId]: undefined,
            }
          : action.continuity
            ? {
                ...state.threadListContinuityByWorkspace,
                [action.workspaceId]: {
                  ...action.continuity,
                  staleThreadIds: action.continuity.staleThreadIds.filter(
                    (threadId) => !hidden[threadId],
                  ),
                },
              }
            : state.threadListContinuityByWorkspace;
      const existingThreads = state.threadsByWorkspace[action.workspaceId] ?? [];
      const existingById = new Map(
        existingThreads.map((thread) => [thread.id, thread] as const),
      );
      const visibleThreads = dedupeThreadSummaries(
        action.threads.filter((thread) => !hidden[thread.id]),
      ).map((thread) => {
        const existing = existingById.get(thread.id);
        if (!thread.nameIsFallback || !existing || existing.nameIsFallback) {
          return thread;
        }
        const { nameIsFallback: _ignored, ...resolvedThread } = thread;
        return {
          ...resolvedThread,
          name: existing.name,
        };
      });
      const freshenAnchorSummary = (summary: ThreadSummary) => {
        const lastMessageTimestamp =
          state.lastAgentMessageByThread[summary.id]?.timestamp ?? 0;
        const processingStartedAt =
          state.threadStatusById[summary.id]?.processingStartedAt ?? 0;
        const nextUpdatedAt = Math.max(
          summary.updatedAt ?? 0,
          lastMessageTimestamp,
          processingStartedAt,
        );
        if (nextUpdatedAt <= (summary.updatedAt ?? 0)) {
          return summary;
        }
        return {
          ...summary,
          updatedAt: nextUpdatedAt,
        };
      };
      const preserveAnchors = action.preserveAnchors === true;
      if (!preserveAnchors) {
        const currentActiveThreadId =
          state.activeThreadIdByWorkspace[action.workspaceId] ?? null;
        const activeThreadStillVisible = currentActiveThreadId
          ? visibleThreads.some((thread) => thread.id === currentActiveThreadId)
          : false;
        const activeThreadIsInFlight = Boolean(
          currentActiveThreadId &&
            (state.threadResumeLoadingById[currentActiveThreadId] ||
              state.threadStatusById[currentActiveThreadId]?.isProcessing),
        );
        const nextThreads = [...visibleThreads];
        if (!activeThreadStillVisible && activeThreadIsInFlight) {
          const activeSummary = (
            state.threadsByWorkspace[action.workspaceId] ?? []
          ).find((thread) => thread.id === currentActiveThreadId);
          if (activeSummary) {
            insertThreadSummaryBySort(
              nextThreads,
              freshenAnchorSummary(activeSummary),
              action.sortKey,
            );
          }
        }
        return {
          ...state,
          threadsByWorkspace: {
            ...state.threadsByWorkspace,
            [action.workspaceId]: nextThreads,
          },
          activeThreadIdByWorkspace: {
            ...state.activeThreadIdByWorkspace,
            [action.workspaceId]: activeThreadStillVisible
              ? currentActiveThreadId
              : activeThreadIsInFlight
                ? currentActiveThreadId
                : (visibleThreads[0]?.id ?? null),
          },
          threadSortKeyByWorkspace: {
            ...state.threadSortKeyByWorkspace,
            [action.workspaceId]: action.sortKey,
          },
          threadListContinuityByWorkspace: nextContinuityByWorkspace,
        };
      }
      const reconciled = [...visibleThreads];
      const includedIds = new Set(reconciled.map((thread) => thread.id));
      const appendExistingAnchor = (threadId: string | null | undefined) => {
        if (!threadId || hidden[threadId] || includedIds.has(threadId)) {
          return;
        }
        const summary = existingById.get(threadId);
        if (!summary) {
          return;
        }
        insertThreadSummaryBySort(
          reconciled,
          freshenAnchorSummary(summary),
          action.sortKey,
        );
        includedIds.add(threadId);
      };

      const activeThreadId = state.activeThreadIdByWorkspace[action.workspaceId];
      appendExistingAnchor(activeThreadId);
      existingThreads.forEach((thread) => {
        if (state.threadStatusById[thread.id]?.isProcessing) {
          appendExistingAnchor(thread.id);
        }
      });

      const seedThreadIds = [...includedIds];
      seedThreadIds.forEach((threadId) => {
        const visited = new Set<string>([threadId]);
        let parentId = state.threadParentById[threadId];
        while (parentId && !visited.has(parentId)) {
          visited.add(parentId);
          appendExistingAnchor(parentId);
          parentId = state.threadParentById[parentId];
        }
      });

      const anchorIds = new Set<string>();
      if (activeThreadId) {
        anchorIds.add(activeThreadId);
      }
      existingThreads.forEach((thread) => {
        if (
          state.threadStatusById[thread.id]?.isProcessing ||
          state.threadResumeLoadingById[thread.id]
        ) {
          anchorIds.add(thread.id);
        }
      });
      if (anchorIds.size > 0) {
        const presentAnchors = reconciled.filter((thread) =>
          anchorIds.has(thread.id),
        );
        if (presentAnchors.length > 0) {
          const presentAnchorIds = new Set(
            presentAnchors.map((thread) => thread.id),
          );
          const reordered = reconciled.filter(
            (thread) => !presentAnchorIds.has(thread.id),
          );
          presentAnchors.forEach((thread) => {
            insertThreadSummaryBySort(
              reordered,
              freshenAnchorSummary(thread),
              action.sortKey,
            );
          });
          reconciled.splice(0, reconciled.length, ...reordered);
        }
      }

      return {
        ...state,
        threadsByWorkspace: {
          ...state.threadsByWorkspace,
          [action.workspaceId]: reconciled,
        },
        threadSortKeyByWorkspace: {
          ...state.threadSortKeyByWorkspace,
          [action.workspaceId]: action.sortKey,
        },
        threadListContinuityByWorkspace: nextContinuityByWorkspace,
      };
    }
    case "setThreadListLoading":
      return {
        ...state,
        threadListLoadingByWorkspace: {
          ...state.threadListLoadingByWorkspace,
          [action.workspaceId]: action.isLoading,
        },
      };
    case "setThreadResumeLoading":
      return {
        ...state,
        threadResumeLoadingById: {
          ...state.threadResumeLoadingById,
          [action.threadId]: action.isLoading,
        },
      };
    case "setThreadListPaging":
      return {
        ...state,
        threadListPagingByWorkspace: {
          ...state.threadListPagingByWorkspace,
          [action.workspaceId]: action.isLoading,
        },
      };
    case "setThreadListCursor":
      return {
        ...state,
        threadListCursorByWorkspace: {
          ...state.threadListCursorByWorkspace,
          [action.workspaceId]: action.cursor,
        },
      };
    case "setThreadListFirstPageCursor":
      return {
        ...state,
        threadListFirstPageCursorByWorkspace: {
          ...state.threadListFirstPageCursorByWorkspace,
          [action.workspaceId]: action.cursor,
        },
      };
    case "compactThreadList": {
      const threads = state.threadsByWorkspace[action.workspaceId] ?? [];
      const presentThreadIds = new Set(threads.map((thread) => thread.id));
      const retainedRootIds = new Set<string>();
      for (const thread of threads) {
        const rootId = getThreadRootId(
          thread.id,
          presentThreadIds,
          state.threadParentById,
        );
        if (retainedRootIds.has(rootId)) {
          continue;
        }
        if (retainedRootIds.size >= Math.max(0, action.rootLimit)) {
          break;
        }
        retainedRootIds.add(rootId);
      }

      const retainedThreadIds = new Set<string>();
      threads.forEach((thread) => {
        const rootId = getThreadRootId(
          thread.id,
          presentThreadIds,
          state.threadParentById,
        );
        if (retainedRootIds.has(rootId)) {
          retainedThreadIds.add(thread.id);
        }
      });

      const anchorThreadIds = getPendingThreadIds(state, action.workspaceId);
      action.pinnedThreadIds.forEach((threadId) => anchorThreadIds.add(threadId));
      const activeThreadId = state.activeThreadIdByWorkspace[action.workspaceId];
      if (activeThreadId) {
        anchorThreadIds.add(activeThreadId);
      }
      threads.forEach((thread) => {
        const status = state.threadStatusById[thread.id];
        if (
          status?.isProcessing ||
          status?.isReviewing ||
          state.threadResumeLoadingById[thread.id]
        ) {
          anchorThreadIds.add(thread.id);
        }
      });

      anchorThreadIds.forEach((threadId) => {
        if (!presentThreadIds.has(threadId)) {
          return;
        }
        retainedThreadIds.add(threadId);
        const visited = new Set<string>([threadId]);
        let parentId = state.threadParentById[threadId];
        while (parentId && presentThreadIds.has(parentId) && !visited.has(parentId)) {
          visited.add(parentId);
          retainedThreadIds.add(parentId);
          parentId = state.threadParentById[parentId];
        }
      });

      const omittedThreadIds = new Set(
        threads
          .filter((thread) => !retainedThreadIds.has(thread.id))
          .map((thread) => thread.id),
      );
      const nextThreadParentById: ThreadState["threadParentById"] = {};
      Object.entries(state.threadParentById).forEach(([threadId, parentId]) => {
        if (!omittedThreadIds.has(threadId) && !omittedThreadIds.has(parentId)) {
          nextThreadParentById[threadId] = parentId;
        }
      });

      return {
        ...state,
        threadsByWorkspace: {
          ...state.threadsByWorkspace,
          [action.workspaceId]: threads.filter((thread) =>
            retainedThreadIds.has(thread.id),
          ),
        },
        threadListPagingByWorkspace: {
          ...state.threadListPagingByWorkspace,
          [action.workspaceId]: false,
        },
        threadListLoadingByWorkspace: {
          ...state.threadListLoadingByWorkspace,
          [action.workspaceId]: false,
        },
        threadListCursorByWorkspace: {
          ...state.threadListCursorByWorkspace,
          [action.workspaceId]:
            state.threadListFirstPageCursorByWorkspace[action.workspaceId] ?? null,
        },
        threadParentById: nextThreadParentById,
        threadStatusById: omitThreadKeys(
          state.threadStatusById,
          omittedThreadIds,
        ),
        threadResumeLoadingById: omitThreadKeys(
          state.threadResumeLoadingById,
          omittedThreadIds,
        ),
        lastAgentMessageByThread: omitThreadKeys(
          state.lastAgentMessageByThread,
          omittedThreadIds,
        ),
      };
    }
    default:
      return state;
  }
}
