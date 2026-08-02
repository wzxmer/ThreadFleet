import { useCallback, useRef, useState } from "react";
import type { Dispatch, MutableRefObject } from "react";
import type {
  DebugEntry,
  ThreadListSortKey,
  ThreadSummary,
  TokenEfficiencyMode,
  WorkspaceInfo,
  TurnExecutionSummary,
} from "@/types";
import {
  archiveThread as archiveThreadService,
  forkThread as forkThreadService,
  getThreadTokenUsage as getThreadTokenUsageService,
  listSessionSources as listSessionSourcesService,
  listThreads as listThreadsService,
  listWorkspaces as listWorkspacesService,
  readThread as readThreadService,
  readThreadPage as readThreadPageService,
  resumeThread as resumeThreadService,
  startThread as startThreadService,
  verifySessionThreads as verifySessionThreadsService,
} from "@services/tauri";
import { LOCAL_CODEX_WORKSPACE_ID } from "@/features/workspaces/domain/localCodexWorkspace";
import { buildItemsFromThread, getThreadTimestamp } from "@utils/threadItems";
import { extractThreadCodexMetadata } from "@threads/utils/threadCodexMetadata";
import {
  buildThreadSummaryFromThread,
  extractThreadFromResponse,
} from "@threads/utils/threadSummary";
import {
  asString,
  extractTokenUsageFromResponse,
  normalizeTokenUsage,
} from "@threads/utils/threadNormalize";
import {
  getParentThreadIdFromThread,
  getThreadReadAuthority,
  shouldHideSubagentThreadFromSidebar,
} from "@threads/utils/threadRpc";
import { saveThreadActivity } from "@threads/utils/threadStorage";
import {
  isSidebarManagedSessionCandidate,
  listActiveManagedSessionsCached,
  managedSessionToThreadRecord,
} from "@threads/utils/activeManagedSessions";
import {
  buildResumeHydrationPlan,
  buildWorkspacePathLookup,
  buildWorkspaceThreadListState,
  getThreadListNextCursor,
  resolveWorkspaceIdForThreadPath,
} from "@threads/utils/threadActionHelpers";
import type { ThreadAction, ThreadState } from "./useThreadsReducer";
import type {
  ThreadListContinuityState,
  ThreadListRefreshReason,
  ThreadListRuntimeContext,
  ThreadListVerifiedCache,
} from "@threads/types";

const THREAD_LIST_PAGE_SIZE = 100;
const THREAD_LIST_TARGET_COUNT = THREAD_LIST_PAGE_SIZE;
const THREAD_LIST_MAX_PAGES_OLDER = 6;
const THREAD_LIST_MAX_PAGES_DEFAULT = 6;
const THREAD_LIST_CURSOR_PAGE_START = "__codex_monitor_page_start__";
const THREAD_HISTORY_INITIAL_ITEMS = 50;
const THREAD_HISTORY_INITIAL_BYTES = 1 * 1024 * 1024;
const THREAD_HISTORY_OLDER_ITEMS = 50;
const THREAD_HISTORY_OLDER_BYTES = 1 * 1024 * 1024;

export type ThreadHistoryPageState = {
  nextCursor: string | null;
  hasMore: boolean;
  isLoading: boolean;
  snapshotId: string | null;
};

function extractThreadHistoryPageState(
  response: Record<string, unknown> | null,
): ThreadHistoryPageState | null {
  const page = response?.codexMonitorHistoryPage;
  if (!page || typeof page !== "object") {
    return null;
  }
  const value = page as Record<string, unknown>;
  return {
    nextCursor: typeof value.nextCursor === "string" ? value.nextCursor : null,
    hasMore: value.hasMore === true,
    isLoading: false,
    snapshotId: typeof value.snapshotId === "string" ? value.snapshotId : null,
  };
}

type UseThreadActionsOptions = {
  dispatch: Dispatch<ThreadAction>;
  itemsByThread: ThreadState["itemsByThread"];
  threadsByWorkspace: ThreadState["threadsByWorkspace"];
  activeThreadIdByWorkspace: ThreadState["activeThreadIdByWorkspace"];
  activeTurnIdByThread: ThreadState["activeTurnIdByThread"];
  threadParentById: ThreadState["threadParentById"];
  threadListCursorByWorkspace: ThreadState["threadListCursorByWorkspace"];
  threadListContinuityByWorkspace?: ThreadState["threadListContinuityByWorkspace"];
  threadStatusById: ThreadState["threadStatusById"];
  threadSortKey: ThreadListSortKey;
  preserveSessionLibraryOnProviderSwitch?: boolean;
  getThreadListRuntimeContext?: () => ThreadListRuntimeContext;
  tokenEfficiencyMode: TokenEfficiencyMode;
  onDebug?: (entry: DebugEntry) => void;
  getCustomName: (workspaceId: string, threadId: string) => string | undefined;
  threadActivityRef: MutableRefObject<Record<string, Record<string, number>>>;
  loadedThreadsRef: MutableRefObject<Record<string, boolean>>;
  loadedThreadRuntimeKeyRef: MutableRefObject<Record<string, string>>;
  replaceOnResumeRef: MutableRefObject<Record<string, boolean>>;
  tokenUsageRevisionByThreadRef: MutableRefObject<Record<string, number>>;
  applyCollabThreadLinksFromThread: (
    workspaceId: string,
    threadId: string,
    thread: Record<string, unknown>,
  ) => string[];
  hydrateSubagentThreads: (
    workspaceId: string,
    receivers: Array<{ threadId: string }>,
  ) => Promise<void>;
  updateThreadParent: (parentId: string, childIds: string[]) => void;
  onSubagentThreadDetected: (workspaceId: string, threadId: string) => void;
  onSubagentTitleCandidate?: (
    workspaceId: string,
    thread: Record<string, unknown>,
  ) => void;
  onThreadCodexMetadataDetected?: (
    workspaceId: string,
    threadId: string,
    metadata: { modelId: string | null; effort: string | null },
  ) => void;
  hydrateTurnExecutionSummary?: (
    workspaceId: string,
    threadId: string,
    thread: Record<string, unknown>,
  ) => Promise<TurnExecutionSummary | null>;
};

export function useThreadActions({
  dispatch,
  itemsByThread,
  threadsByWorkspace,
  activeThreadIdByWorkspace,
  activeTurnIdByThread,
  threadParentById,
  threadListCursorByWorkspace,
  threadListContinuityByWorkspace = {},
  threadStatusById,
  threadSortKey,
  preserveSessionLibraryOnProviderSwitch = false,
  getThreadListRuntimeContext = () => ({
    sourceId: null,
    runtimeGeneration: 0,
  }),
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
  hydrateTurnExecutionSummary = async () => null,
}: UseThreadActionsOptions) {
  const localArchivedCursorByWorkspaceRef = useRef<Record<string, string | null>>({});
  const threadListRequestSequenceRef = useRef<Record<string, number>>({});
  const threadListLoadingOwnerRef = useRef<
    Record<string, { refresh?: number; paging?: number } | undefined>
  >({});
  const threadListVerifiedCacheRef = useRef<
    Record<string, ThreadListVerifiedCache | undefined>
  >({});
  const threadListGenerationRef = useRef<Record<string, number>>({});
  const threadListRequestIdRef = useRef(0);
  const resumeInFlightByThreadRef = useRef<Record<string, number>>({});
  const resumeGenerationByThreadRef = useRef<Record<string, number>>({});
  const resumeAppliedGenerationByThreadRef = useRef<Record<string, number>>({});
  const readOnlyLoadedThreadsRef = useRef<Record<string, true>>({});
  const tokenUsageHydrationInFlightRef = useRef<Record<string, true>>({});
  const [threadHistoryPageByThread, setThreadHistoryPageByThread] = useState<
    Record<string, ThreadHistoryPageState>
  >({});
  const threadStatusByIdRef = useRef(threadStatusById);
  const activeTurnIdByThreadRef = useRef(activeTurnIdByThread);
  const getCurrentThreadRuntimeKey = useCallback(() => {
    const context = getThreadListRuntimeContext();
    return `${context.sourceId ?? ""}:${context.runtimeGeneration}`;
  }, [getThreadListRuntimeContext]);
  threadStatusByIdRef.current = threadStatusById;
  activeTurnIdByThreadRef.current = activeTurnIdByThread;

  const applyThreadMetadata = useCallback(
    (
      workspaceId: string,
      threadId: string,
      thread: Record<string, unknown>,
      options?: { notifySubagent?: boolean },
    ) => {
      const codexMetadata = extractThreadCodexMetadata(thread);
      if (codexMetadata.modelId || codexMetadata.effort) {
        onThreadCodexMetadataDetected?.(workspaceId, threadId, codexMetadata);
      }
      const sourceParentId = getParentThreadIdFromThread(thread);
      if (sourceParentId) {
        updateThreadParent(sourceParentId, [threadId]);
        onSubagentTitleCandidate?.(workspaceId, thread);
        if (options?.notifySubagent) {
          onSubagentThreadDetected(workspaceId, threadId);
        }
      }
    },
    [
      onSubagentThreadDetected,
      onSubagentTitleCandidate,
      onThreadCodexMetadataDetected,
      updateThreadParent,
    ],
  );

  const dispatchPreviewMessage = useCallback(
    (threadId: string, text: string, timestamp: number) => {
      dispatch({
        type: "setLastAgentMessage",
        threadId,
        text,
        timestamp,
      });
    },
    [dispatch],
  );

  const extractThreadId = useCallback(
    (response: Record<string, unknown> | null | undefined) => {
      const thread = extractThreadFromResponse(response);
      return String(thread?.id ?? "");
    },
    [],
  );

  const startThreadForWorkspace = useCallback(
    async (workspaceId: string, options?: { activate?: boolean }) => {
      const shouldActivate = options?.activate !== false;
      const requestRuntimeKey = getCurrentThreadRuntimeKey();
      onDebug?.({
        id: `${Date.now()}-client-thread-start`,
        timestamp: Date.now(),
        source: "client",
        label: "thread/start",
        payload: { workspaceId, tokenEfficiencyMode },
      });
      try {
        const response = await startThreadService(workspaceId, tokenEfficiencyMode);
        onDebug?.({
          id: `${Date.now()}-server-thread-start`,
          timestamp: Date.now(),
          source: "server",
          label: "thread/start response",
          payload: response,
        });
        const threadId = extractThreadId(response);
        if (threadId) {
          dispatch({ type: "ensureThread", workspaceId, threadId });
          if (shouldActivate) {
            dispatch({ type: "setActiveThreadId", workspaceId, threadId });
          }
          loadedThreadsRef.current[threadId] = true;
          loadedThreadRuntimeKeyRef.current[threadId] = requestRuntimeKey;
          delete readOnlyLoadedThreadsRef.current[threadId];
          return threadId;
        }
        return null;
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-thread-start-error`,
          timestamp: Date.now(),
          source: "error",
          label: "thread/start error",
          payload: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    [
      dispatch,
      extractThreadId,
      getCurrentThreadRuntimeKey,
      loadedThreadRuntimeKeyRef,
      loadedThreadsRef,
      onDebug,
      tokenEfficiencyMode,
    ],
  );

  const resumeThreadForWorkspace = useCallback(
    async (
      workspaceId: string,
      threadId: string,
      force = false,
      replaceLocal = false,
      requireThreadResponse = false,
      readOnly = false,
    ) => {
      if (!threadId) {
        return null;
      }
      const requestRuntimeKey = getCurrentThreadRuntimeKey();
      const previousRuntimeKey = loadedThreadRuntimeKeyRef.current[threadId];
      const loadedInCurrentRuntime =
        loadedThreadsRef.current[threadId] &&
        previousRuntimeKey === requestRuntimeKey;
      if (
        !force &&
        loadedInCurrentRuntime &&
        (readOnly || !readOnlyLoadedThreadsRef.current[threadId])
      ) {
        return threadId;
      }
      const status = threadStatusByIdRef.current[threadId];
      if (
        status?.isProcessing &&
        loadedInCurrentRuntime &&
        (readOnly || !readOnlyLoadedThreadsRef.current[threadId]) &&
        !force
      ) {
        onDebug?.({
          id: `${Date.now()}-client-thread-resume-skipped`,
          timestamp: Date.now(),
          source: "client",
          label: "thread/resume skipped",
          payload: { workspaceId, threadId, reason: "active-turn" },
        });
        return threadId;
      }
      const requestLabel = readOnly ? "thread/read" : "thread/resume";
      onDebug?.({
        id: `${Date.now()}-client-thread-resume`,
        timestamp: Date.now(),
        source: "client",
        label: requestLabel,
        payload: { workspaceId, threadId },
      });
      const resumeKey = `${workspaceId}:${threadId}`;
      const resumeGeneration = (resumeGenerationByThreadRef.current[resumeKey] ?? 0) + 1;
      resumeGenerationByThreadRef.current[resumeKey] = resumeGeneration;
      const tokenUsageRevisionAtStart =
        tokenUsageRevisionByThreadRef.current[resumeKey] ?? 0;
      const inFlightCount =
        (resumeInFlightByThreadRef.current[threadId] ?? 0) + 1;
      resumeInFlightByThreadRef.current[threadId] = inFlightCount;
      if (inFlightCount === 1) {
        dispatch({ type: "setThreadResumeLoading", threadId, isLoading: true });
      }
      try {
        let response: Record<string, unknown> | null;
        if (readOnly) {
          try {
            response = (await readThreadPageService(
              workspaceId,
              threadId,
              null,
              THREAD_HISTORY_INITIAL_ITEMS,
              THREAD_HISTORY_INITIAL_BYTES,
            )) as Record<string, unknown> | null;
          } catch (pageError) {
            onDebug?.({
              id: `${Date.now()}-client-thread-read-page-fallback`,
              timestamp: Date.now(),
              source: "client",
              label: "thread/read page fallback",
              payload: pageError instanceof Error ? pageError.message : String(pageError),
            });
            response = (await readThreadService(
              workspaceId,
              threadId,
            )) as Record<string, unknown> | null;
          }
          const pageState = extractThreadHistoryPageState(response);
          setThreadHistoryPageByThread((previous) => {
            if (!pageState) {
              const { [threadId]: _, ...rest } = previous;
              return rest;
            }
            return { ...previous, [threadId]: pageState };
          });
        } else {
          response = (await resumeThreadService(
            workspaceId,
            threadId,
          )) as Record<string, unknown> | null;
        }
        onDebug?.({
          id: `${Date.now()}-server-thread-resume`,
          timestamp: Date.now(),
          source: "server",
          label: `${requestLabel} response`,
          payload: response,
        });
        if (readOnly) {
          readOnlyLoadedThreadsRef.current[threadId] = true;
        } else {
          delete readOnlyLoadedThreadsRef.current[threadId];
        }
        const thread = extractThreadFromResponse(response);
        if (!thread && requireThreadResponse) {
          return null;
        }
        if (thread) {
          const localActiveTurnId =
            activeTurnIdByThreadRef.current[threadId] ?? null;
          const threadReadAuthority = getThreadReadAuthority(response);
          if (readOnly && localActiveTurnId && !threadReadAuthority) {
            onDebug?.({
              id: `${Date.now()}-client-thread-read-legacy-active-skipped`,
              timestamp: Date.now(),
              source: "client",
              label: "thread/read active-state hydration skipped",
              payload: {
                workspaceId,
                threadId,
                reason: "missing-read-authority",
              },
            });
            loadedThreadsRef.current[threadId] = true;
            loadedThreadRuntimeKeyRef.current[threadId] = requestRuntimeKey;
            return threadId;
          }
          if (
            resumeGeneration <
            (resumeAppliedGenerationByThreadRef.current[resumeKey] ?? 0)
          ) {
            return threadId;
          }
          void hydrateTurnExecutionSummary(workspaceId, threadId, thread);
          dispatch({ type: "ensureThread", workspaceId, threadId });
          const tokenUsage = extractTokenUsageFromResponse(response, thread);
          if (
            tokenUsage &&
            (tokenUsageRevisionByThreadRef.current[resumeKey] ?? 0) ===
              tokenUsageRevisionAtStart
          ) {
            tokenUsageRevisionByThreadRef.current[resumeKey] =
              tokenUsageRevisionAtStart + 1;
            dispatch({
              type: "setThreadTokenUsage",
              threadId,
              tokenUsage: normalizeTokenUsage(tokenUsage),
            });
          } else if (
            !tokenUsage &&
            !tokenUsageHydrationInFlightRef.current[resumeKey]
          ) {
            tokenUsageHydrationInFlightRef.current[resumeKey] = true;
            void getThreadTokenUsageService(workspaceId, threadId)
              .then((restoredTokenUsage) => {
                if (
                  !restoredTokenUsage ||
                  (tokenUsageRevisionByThreadRef.current[resumeKey] ?? 0) !==
                    tokenUsageRevisionAtStart
                ) {
                  return;
                }
                tokenUsageRevisionByThreadRef.current[resumeKey] =
                  tokenUsageRevisionAtStart + 1;
                dispatch({
                  type: "setThreadTokenUsage",
                  threadId,
                  tokenUsage: normalizeTokenUsage(restoredTokenUsage),
                });
              })
              .catch((error) => {
                onDebug?.({
                  id: `${Date.now()}-client-thread-token-usage-hydrate-error`,
                  timestamp: Date.now(),
                  source: "error",
                  label: "thread/token-usage hydrate error",
                  payload: {
                    workspaceId,
                    threadId,
                    error:
                      error instanceof Error ? error.message : String(error),
                  },
                });
              })
              .finally(() => {
                delete tokenUsageHydrationInFlightRef.current[resumeKey];
              });
          }
          applyThreadMetadata(workspaceId, threadId, thread, {
            notifySubagent: true,
          });
          const childThreadIds = applyCollabThreadLinksFromThread(
            workspaceId,
            threadId,
            thread,
          );
          void hydrateSubagentThreads(
            workspaceId,
            childThreadIds.map((childThreadId) => ({ threadId: childThreadId })),
          );
          const localItems = itemsByThread[threadId] ?? [];
          const shouldReplaceRuntimeSnapshot =
            readOnly &&
            localItems.length > 0 &&
            (!previousRuntimeKey || previousRuntimeKey !== requestRuntimeKey);
          const shouldReplace =
            replaceLocal ||
            replaceOnResumeRef.current[threadId] === true ||
            shouldReplaceRuntimeSnapshot;
          if (shouldReplace) {
            replaceOnResumeRef.current[threadId] = false;
          }
          const hydrationPlan = buildResumeHydrationPlan({
            thread,
            workspaceId,
            threadId,
            replaceLocal: shouldReplace,
            localItems,
            localStatus: threadStatusByIdRef.current[threadId],
            localActiveTurnId: activeTurnIdByThreadRef.current[threadId] ?? null,
            getCustomName,
          });
          const canTrustHydratedActiveTurn =
            !readOnly || threadReadAuthority === "execution";
          const shouldMarkProcessing =
            hydrationPlan.shouldMarkProcessing && canTrustHydratedActiveTurn;
          const resumedActiveTurnId = shouldMarkProcessing
            ? hydrationPlan.resumedActiveTurnId
            : null;
          if (!hydrationPlan.shouldHydrate) {
            loadedThreadsRef.current[threadId] = true;
            loadedThreadRuntimeKeyRef.current[threadId] = requestRuntimeKey;
            return threadId;
          }
          if (hydrationPlan.shouldMarkProcessing && !canTrustHydratedActiveTurn) {
            onDebug?.({
              id: `${Date.now()}-client-thread-read-stale-active-ignored`,
              timestamp: Date.now(),
              source: "client",
              label: "thread/read stale active ignored",
              payload: {
                workspaceId,
                threadId,
                readAuthority: threadReadAuthority,
              },
            });
          }
          if (hydrationPlan.keepLocalProcessing && shouldMarkProcessing) {
            onDebug?.({
              id: `${Date.now()}-client-thread-resume-keep-processing`,
              timestamp: Date.now(),
              source: "client",
              label: "thread/resume keep-processing",
              payload: { workspaceId, threadId },
            });
          }
          if (
            !hydrationPlan.shouldMarkProcessing &&
            localActiveTurnId &&
            hydrationPlan.terminalTurnId === localActiveTurnId &&
            hydrationPlan.terminalTurnStatus
          ) {
            dispatch({
              type: "completeTurnExecution",
              threadId,
              turnId: localActiveTurnId,
              status: hydrationPlan.terminalTurnStatus,
              timestamp: Date.now(),
            });
          }
          dispatch({
            type: "markProcessing",
            threadId,
            isProcessing: shouldMarkProcessing,
            timestamp: shouldMarkProcessing
              ? hydrationPlan.processingTimestamp
              : Date.now(),
          });
          dispatch({
            type: "setActiveTurnId",
            threadId,
            turnId: resumedActiveTurnId,
          });
          dispatch({
            type: "markReviewing",
            threadId,
            isReviewing: hydrationPlan.reviewing,
          });
          if (shouldReplace || hydrationPlan.mergedItems.length > 0) {
            dispatch({
              type: "setThreadItems",
              threadId,
              items: hydrationPlan.mergedItems,
            });
          }
          if (hydrationPlan.threadName) {
            dispatch({
              type: "setThreadName",
              workspaceId,
              threadId,
              name: hydrationPlan.threadName,
            });
          }
          if (
            hydrationPlan.lastMessageText &&
            hydrationPlan.lastMessageTimestamp !== null
          ) {
            dispatchPreviewMessage(
              threadId,
              hydrationPlan.lastMessageText,
              hydrationPlan.lastMessageTimestamp,
            );
          }
          resumeAppliedGenerationByThreadRef.current[resumeKey] = resumeGeneration;
        }
        loadedThreadsRef.current[threadId] = true;
        loadedThreadRuntimeKeyRef.current[threadId] = requestRuntimeKey;
        return threadId;
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-thread-resume-error`,
          timestamp: Date.now(),
          source: "error",
          label: `${requestLabel} error`,
          payload: error instanceof Error ? error.message : String(error),
        });
        return null;
      } finally {
        const nextCount = Math.max(
          0,
          (resumeInFlightByThreadRef.current[threadId] ?? 1) - 1,
        );
        if (nextCount === 0) {
          delete resumeInFlightByThreadRef.current[threadId];
          dispatch({ type: "setThreadResumeLoading", threadId, isLoading: false });
        } else {
          resumeInFlightByThreadRef.current[threadId] = nextCount;
        }
      }
    },
    [
      applyThreadMetadata,
      applyCollabThreadLinksFromThread,
      dispatchPreviewMessage,
      dispatch,
      getCustomName,
      hydrateSubagentThreads,
      hydrateTurnExecutionSummary,
      itemsByThread,
      getCurrentThreadRuntimeKey,
      loadedThreadRuntimeKeyRef,
      loadedThreadsRef,
      onDebug,
      replaceOnResumeRef,
      tokenUsageRevisionByThreadRef,
    ],
  );

  const readThreadForWorkspace = useCallback(
    async (
      workspaceId: string,
      threadId: string,
      force = false,
      replaceLocal = false,
    ) =>
      resumeThreadForWorkspace(
        workspaceId,
        threadId,
        force,
        replaceLocal,
        false,
        true,
      ),
    [resumeThreadForWorkspace],
  );

  const loadOlderThreadHistory = useCallback(
    async (workspaceId: string, threadId: string) => {
      const pageState = threadHistoryPageByThread[threadId];
      if (!pageState?.hasMore || !pageState.nextCursor || pageState.isLoading) {
        return false;
      }
      const requestedCursor = pageState.nextCursor;
      setThreadHistoryPageByThread((previous) => ({
        ...previous,
        [threadId]: { ...pageState, isLoading: true },
      }));
      try {
        const response = (await readThreadPageService(
          workspaceId,
          threadId,
          requestedCursor,
          THREAD_HISTORY_OLDER_ITEMS,
          THREAD_HISTORY_OLDER_BYTES,
        )) as Record<string, unknown> | null;
        const thread = extractThreadFromResponse(response);
        const nextPageState = extractThreadHistoryPageState(response);
        if (!thread || !nextPageState) {
          throw new Error("Thread history page response is incomplete");
        }
        const olderItems = buildItemsFromThread(thread);
        const currentItems = itemsByThread[threadId] ?? [];
        const currentIds = new Set(currentItems.map((item) => item.id));
        const uniqueOlderItems = olderItems.filter(
          (item) => !currentIds.has(item.id),
        );
        if (uniqueOlderItems.length > 0) {
          dispatch({
            type: "prependThreadItems",
            threadId,
            items: uniqueOlderItems,
          });
        }
        setThreadHistoryPageByThread((previous) => ({
          ...previous,
          [threadId]: nextPageState,
        }));
        return uniqueOlderItems.length > 0;
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-thread-read-page-error`,
          timestamp: Date.now(),
          source: "error",
          label: "thread/read page error",
          payload: error instanceof Error ? error.message : String(error),
        });
        setThreadHistoryPageByThread((previous) => {
          const current = previous[threadId];
          if (!current || current.nextCursor !== requestedCursor) {
            return previous;
          }
          return {
            ...previous,
            [threadId]: { ...current, isLoading: false },
          };
        });
        return false;
      }
    },
    [dispatch, itemsByThread, onDebug, threadHistoryPageByThread],
  );

  const ensureThreadRuntimeForWorkspace = useCallback(
    async (workspaceId: string, threadId: string, force = false) => {
      if (force) {
        delete loadedThreadsRef.current[threadId];
        delete loadedThreadRuntimeKeyRef.current[threadId];
      }
      return resumeThreadForWorkspace(workspaceId, threadId, force);
    },
    [loadedThreadRuntimeKeyRef, loadedThreadsRef, resumeThreadForWorkspace],
  );

  const forkThreadForWorkspace = useCallback(
    async (
      workspaceId: string,
      threadId: string,
      options?: { activate?: boolean },
    ) => {
      if (!threadId) {
        return null;
      }
      const shouldActivate = options?.activate !== false;
      onDebug?.({
        id: `${Date.now()}-client-thread-fork`,
        timestamp: Date.now(),
        source: "client",
        label: "thread/fork",
        payload: { workspaceId, threadId },
      });
      try {
        const response = await forkThreadService(workspaceId, threadId);
        onDebug?.({
          id: `${Date.now()}-server-thread-fork`,
          timestamp: Date.now(),
          source: "server",
          label: "thread/fork response",
          payload: response,
        });
        const forkedThreadId = extractThreadId(response);
        if (!forkedThreadId) {
          return null;
        }
        dispatch({ type: "ensureThread", workspaceId, threadId: forkedThreadId });
        if (shouldActivate) {
          dispatch({
            type: "setActiveThreadId",
            workspaceId,
            threadId: forkedThreadId,
          });
        }
        loadedThreadsRef.current[forkedThreadId] = false;
        delete loadedThreadRuntimeKeyRef.current[forkedThreadId];
        await resumeThreadForWorkspace(workspaceId, forkedThreadId, true, true);
        return forkedThreadId;
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-thread-fork-error`,
          timestamp: Date.now(),
          source: "error",
          label: "thread/fork error",
          payload: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
    [
      dispatch,
      extractThreadId,
      loadedThreadRuntimeKeyRef,
      loadedThreadsRef,
      onDebug,
      resumeThreadForWorkspace,
    ],
  );

  const refreshThread = useCallback(
    async (workspaceId: string, threadId: string) => {
      if (!threadId) {
        return null;
      }
      replaceOnResumeRef.current[threadId] = true;
      return readThreadForWorkspace(workspaceId, threadId, true, true);
    },
    [readThreadForWorkspace, replaceOnResumeRef],
  );

  const resumeThreadById = useCallback(
    async (workspaceId: string, rawThreadId: string) => {
      const threadId = rawThreadId.trim();
      if (!workspaceId || !threadId) {
        return null;
      }
      const resumedThreadId = await resumeThreadForWorkspace(
        workspaceId,
        threadId,
        true,
        true,
        true,
      );
      if (!resumedThreadId) {
        return null;
      }
      dispatch({ type: "setActiveThreadId", workspaceId, threadId: resumedThreadId });
      return resumedThreadId;
    },
    [dispatch, resumeThreadForWorkspace],
  );

  const resetWorkspaceThreads = useCallback(
    (workspaceId: string) => {
      const threadIds = new Set<string>();
      const list = threadsByWorkspace[workspaceId] ?? [];
      list.forEach((thread) => threadIds.add(thread.id));
      const activeThread = activeThreadIdByWorkspace[workspaceId];
      if (activeThread) {
        threadIds.add(activeThread);
      }
      threadIds.forEach((threadId) => {
        loadedThreadsRef.current[threadId] = false;
        delete loadedThreadRuntimeKeyRef.current[threadId];
        delete readOnlyLoadedThreadsRef.current[threadId];
      });
    },
    [
      activeThreadIdByWorkspace,
      loadedThreadRuntimeKeyRef,
      loadedThreadsRef,
      threadsByWorkspace,
    ],
  );

  const buildThreadSummary = useCallback(
    (
      workspaceId: string,
      thread: Record<string, unknown>,
      fallbackIndex: number,
    ): ThreadSummary | null =>
      buildThreadSummaryFromThread({
        workspaceId,
        thread,
        fallbackIndex,
        getCustomName,
      }),
    [getCustomName],
  );

  const resolveThreadListSourceId = useCallback(
    async (runtimeContext: ThreadListRuntimeContext) => {
      try {
        const sources = await listSessionSourcesService();
        const runtimeSource = runtimeContext.sourceId
          ? sources.find(
              (source) => source.enabled && source.id === runtimeContext.sourceId,
            )
          : null;
        if (runtimeSource) {
          return runtimeSource.id;
        }
        return (
          sources.find((source) => source.enabled && source.isCurrent)?.id ??
          sources.find((source) => source.enabled && source.isDefault)?.id ??
          sources.find((source) => source.enabled)?.id ??
          null
        );
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-thread-list-source-error`,
          timestamp: Date.now(),
          source: "error",
          label: "thread/list source error",
          payload: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
    [onDebug],
  );

  const beginThreadListRequest = useCallback((
    workspaceIds: string[],
    kind: "refresh" | "paging",
    manageLoading = true,
  ) => {
    const requestSequence = threadListRequestIdRef.current + 1;
    threadListRequestIdRef.current = requestSequence;
    const requestId = `thread-list-${Date.now()}-${requestSequence}`;
    workspaceIds.forEach((workspaceId) => {
      threadListRequestSequenceRef.current[workspaceId] = requestSequence;
      if (manageLoading) {
        threadListLoadingOwnerRef.current[workspaceId] = {
          ...threadListLoadingOwnerRef.current[workspaceId],
          [kind]: requestSequence,
        };
      }
    });
    return { requestId, requestSequence };
  }, []);

  const isThreadListLoadingOwner = useCallback(
    (
      workspaceId: string,
      requestSequence: number,
      kind: "refresh" | "paging",
    ) => {
      return (
        threadListLoadingOwnerRef.current[workspaceId]?.[kind] ===
        requestSequence
      );
    },
    [],
  );

  const isThreadListRequestCurrent = useCallback(
    (
      workspaceId: string,
      requestSequence: number,
      runtimeContext: ThreadListRuntimeContext,
      sourceId: string | null,
    ) => {
      if (
        threadListRequestSequenceRef.current[workspaceId] !== requestSequence
      ) {
        return false;
      }
      const currentRuntime = getThreadListRuntimeContext();
      if (currentRuntime.runtimeGeneration !== runtimeContext.runtimeGeneration) {
        return false;
      }
      if (runtimeContext.sourceId) {
        return currentRuntime.sourceId === runtimeContext.sourceId;
      }
      return !currentRuntime.sourceId || currentRuntime.sourceId === sourceId;
    },
    [getThreadListRuntimeContext],
  );

  const listThreadsForWorkspaces = useCallback(
    async (
      workspaces: WorkspaceInfo[],
      options?: {
        preserveState?: boolean;
        sortKey?: ThreadListSortKey;
        maxPages?: number;
        refreshReason?: ThreadListRefreshReason;
        knownWorkspaces?: WorkspaceInfo[];
      },
    ) => {
      const targets = workspaces.filter((workspace) => workspace.id);
      if (targets.length === 0) {
        return;
      }
      const targetWorkspaceIds = new Set(
        targets.map((workspace) => workspace.id),
      );
      const includeLocalCodexSessions = targetWorkspaceIds.has(
        LOCAL_CODEX_WORKSPACE_ID,
      );
      const includeUnmatchedLocalCodexSessions = !includeLocalCodexSessions;
      const requestWorkspaceIds = [
        ...targetWorkspaceIds,
        ...(includeUnmatchedLocalCodexSessions
          ? [LOCAL_CODEX_WORKSPACE_ID]
          : []),
      ];
      const preserveState = options?.preserveState ?? false;
      const requestedSortKey = options?.sortKey ?? threadSortKey;
      const maxPages = Math.max(1, options?.maxPages ?? THREAD_LIST_MAX_PAGES_DEFAULT);
      const refreshReason = options?.refreshReason ?? "unknown";
      const knownWorkspacesFromOptions = options?.knownWorkspaces ?? null;
      const runtimeContext = getThreadListRuntimeContext();
      const { requestId, requestSequence } = beginThreadListRequest(
        requestWorkspaceIds,
        "refresh",
        !preserveState,
      );
      const sourceId = await resolveThreadListSourceId(runtimeContext);
      if (
        !targets.some((workspace) =>
          isThreadListRequestCurrent(
            workspace.id,
            requestSequence,
            runtimeContext,
            sourceId,
          ),
        )
      ) {
        if (!preserveState) {
          targets.forEach((workspace) => {
            if (
              isThreadListLoadingOwner(
                workspace.id,
                requestSequence,
                "refresh",
              )
            ) {
              dispatch({
                type: "setThreadListLoading",
                workspaceId: workspace.id,
                isLoading: false,
              });
            }
          });
        }
        return;
      }
      if (!preserveState) {
        targets.forEach((workspace) => {
          dispatch({
            type: "setThreadListLoading",
            workspaceId: workspace.id,
            isLoading: true,
          });
          dispatch({
            type: "setThreadListCursor",
            workspaceId: workspace.id,
            cursor: null,
          });
        });
      }
      onDebug?.({
        id: `${Date.now()}-client-thread-list`,
        timestamp: Date.now(),
        source: "client",
        label: "thread/list",
        payload: {
          workspaceIds: targets.map((workspace) => workspace.id),
          requestId,
          sourceId,
          runtimeGeneration: runtimeContext.runtimeGeneration,
          preserveState,
          maxPages,
          refreshReason,
        },
      });
      try {
        const matchingThreadsByWorkspace: Record<string, Record<string, unknown>[]> = {};
        let workspacePathLookup = buildWorkspacePathLookup(targets);
        let knownWorkspaces: WorkspaceInfo[] = knownWorkspacesFromOptions ?? [];
        let workspaceLookupComplete = Boolean(knownWorkspacesFromOptions);
        if (!knownWorkspacesFromOptions) {
          try {
            knownWorkspaces = await listWorkspacesService();
            workspaceLookupComplete = true;
          } catch (error) {
            workspacePathLookup = buildWorkspacePathLookup(targets);
            onDebug?.({
              id: `${Date.now()}-client-thread-list-workspace-lookup-error`,
              timestamp: Date.now(),
              source: "client",
              label: "thread/list workspace lookup error",
              payload: { error: String(error) },
            });
          }
        }
        if (knownWorkspaces.length > 0) {
          workspacePathLookup = buildWorkspacePathLookup([
            ...targets,
            ...knownWorkspaces,
          ]);
        }
        const uniqueThreadIdsByWorkspace: Record<string, Set<string>> = {};
        const hiddenThreadIdsByWorkspace: Record<string, Set<string>> = {};
        const resumeCursorByWorkspace: Record<string, string | null> = {};
        targets.forEach((workspace) => {
          matchingThreadsByWorkspace[workspace.id] = [];
          uniqueThreadIdsByWorkspace[workspace.id] = new Set<string>();
          hiddenThreadIdsByWorkspace[workspace.id] = new Set<string>();
          resumeCursorByWorkspace[workspace.id] = null;
        });
        if (includeUnmatchedLocalCodexSessions) {
          matchingThreadsByWorkspace[LOCAL_CODEX_WORKSPACE_ID] = [];
          uniqueThreadIdsByWorkspace[LOCAL_CODEX_WORKSPACE_ID] = new Set<string>();
          hiddenThreadIdsByWorkspace[LOCAL_CODEX_WORKSPACE_ID] = new Set<string>();
          resumeCursorByWorkspace[LOCAL_CODEX_WORKSPACE_ID] = null;
        }
        const requestWorkspace =
          targets.find((workspace) => workspace.connected && workspace.id !== LOCAL_CODEX_WORKSPACE_ID) ??
          knownWorkspaces.find((workspace) => workspace.connected && workspace.id !== LOCAL_CODEX_WORKSPACE_ID) ??
          targets.find((workspace) => workspace.connected) ??
          targets[0];
        let pagesFetched = 0;
        let cursor: string | null = null;
        let archivedCursor: string | null = null;
        let unmatchedThreadCount = 0;
        const unmatchedThreadSamples: Array<{ id: string; cwd: string }> = [];
        const processThreadListPage = (
          data: Record<string, unknown>[],
          pageCursor: string | null,
          localCodexOnly = false,
        ) => {
          data.forEach((thread) => {
            const workspaceId = resolveWorkspaceIdForThreadPath(
              String(thread?.cwd ?? ""),
              workspacePathLookup,
            );
            const targetWorkspaceIdsForThread = localCodexOnly
              ? [LOCAL_CODEX_WORKSPACE_ID]
              : workspaceId && targetWorkspaceIds.has(workspaceId)
                ? [workspaceId]
                : !workspaceId && workspaceLookupComplete
                  ? [LOCAL_CODEX_WORKSPACE_ID]
                  : [];
            if (!workspaceId) {
              unmatchedThreadCount += 1;
              if (unmatchedThreadSamples.length < 5) {
                unmatchedThreadSamples.push({
                  id: String(thread?.id ?? ""),
                  cwd: String(thread?.cwd ?? ""),
                });
              }
            }
            if (targetWorkspaceIdsForThread.length === 0) {
              return;
            }
            const threadId = String(thread?.id ?? "");
            if (threadId && shouldHideSubagentThreadFromSidebar(thread.source)) {
              targetWorkspaceIdsForThread.forEach((targetWorkspaceId) => {
                hiddenThreadIdsByWorkspace[targetWorkspaceId]?.add(threadId);
              });
              return;
            }
            targetWorkspaceIdsForThread.forEach((targetWorkspaceId) => {
              matchingThreadsByWorkspace[targetWorkspaceId]?.push(thread);
              if (!threadId) {
                return;
              }
              const uniqueThreadIds = uniqueThreadIdsByWorkspace[targetWorkspaceId];
              if (!uniqueThreadIds || uniqueThreadIds.has(threadId)) {
                return;
              }
              uniqueThreadIds.add(threadId);
              if (
                uniqueThreadIds.size > THREAD_LIST_TARGET_COUNT &&
                resumeCursorByWorkspace[targetWorkspaceId] === null
              ) {
                resumeCursorByWorkspace[targetWorkspaceId] =
                  pageCursor ?? THREAD_LIST_CURSOR_PAGE_START;
              }
            });
          });
        };
        do {
          const pageCursor = cursor;
          pagesFetched += 1;
          const response =
            (await listThreadsService(
              requestWorkspace.id,
              cursor,
              THREAD_LIST_PAGE_SIZE,
              requestedSortKey,
            )) as Record<string, unknown>;
          onDebug?.({
            id: `${Date.now()}-server-thread-list`,
            timestamp: Date.now(),
            source: "server",
            label: "thread/list response",
            payload: response,
          });
          const result = (response.result ?? response) as Record<string, unknown>;
          const data = Array.isArray(result?.data)
            ? (result.data as Record<string, unknown>[])
            : [];
          const nextCursor = getThreadListNextCursor(result);
          processThreadListPage(data, pageCursor);
          cursor = nextCursor;
          if (pagesFetched >= maxPages) {
            break;
          }
        } while (cursor);
        if (sourceId) {
          try {
            const managedSessions = await listActiveManagedSessionsCached(sourceId);
            if (
              !targets.some((workspace) =>
                isThreadListRequestCurrent(
                  workspace.id,
                  requestSequence,
                  runtimeContext,
                  sourceId,
                ),
              )
            ) {
              return;
            }
            const fallbackThreads = managedSessions
              .filter(isSidebarManagedSessionCandidate)
              .map(managedSessionToThreadRecord);
            processThreadListPage(fallbackThreads, null);
            onDebug?.({
              id: `${Date.now()}-client-thread-list-managed-fallback`,
              timestamp: Date.now(),
              source: "client",
              label: "thread/list managed fallback",
              payload: { sourceId, candidateCount: fallbackThreads.length },
            });
          } catch (error) {
            onDebug?.({
              id: `${Date.now()}-client-thread-list-managed-fallback-error`,
              timestamp: Date.now(),
              source: "error",
              label: "thread/list managed fallback error",
              payload: error instanceof Error ? error.message : String(error),
            });
          }
        }
        const livePaginationComplete = cursor === null;
        let archivedPaginationComplete = true;
        if (includeLocalCodexSessions) {
          let archivedPagesFetched = 0;
          do {
            const pageCursor = archivedCursor;
            archivedPagesFetched += 1;
            const response =
              (await listThreadsService(
                requestWorkspace.id,
                archivedCursor,
                THREAD_LIST_PAGE_SIZE,
                requestedSortKey,
                true,
              )) as Record<string, unknown>;
            onDebug?.({
              id: `${Date.now()}-server-thread-list-archived`,
              timestamp: Date.now(),
              source: "server",
              label: "thread/list archived response",
              payload: response,
            });
            const result = (response.result ?? response) as Record<string, unknown>;
            const data = Array.isArray(result?.data)
              ? (result.data as Record<string, unknown>[])
              : [];
            processThreadListPage(data, pageCursor, true);
            archivedCursor = getThreadListNextCursor(result);
            if (archivedPagesFetched >= maxPages) {
              break;
            }
          } while (archivedCursor);
          archivedPaginationComplete = archivedCursor === null;
          localArchivedCursorByWorkspaceRef.current[LOCAL_CODEX_WORKSPACE_ID] =
            archivedCursor;
        }
        const paginationComplete =
          livePaginationComplete &&
          archivedPaginationComplete &&
          workspaceLookupComplete;

        if (unmatchedThreadCount > 0) {
          onDebug?.({
            id: `${Date.now()}-client-thread-list-diagnostics`,
            timestamp: Date.now(),
            source: "client",
            label: "thread/list diagnostics",
            payload: {
              unmatchedThreadCount,
              unmatchedThreadSamples,
              fallbackWorkspaceId: LOCAL_CODEX_WORKSPACE_ID,
              targetWorkspaceIds: targets.map((workspace) => workspace.id),
            },
          });
        }

        const nextThreadActivity = { ...threadActivityRef.current };
        let didChangeAnyActivity = false;
        const hasUnmatchedLocalCodexThreads =
          (matchingThreadsByWorkspace[LOCAL_CODEX_WORKSPACE_ID]?.length ?? 0) > 0;
        const outputTargets = includeUnmatchedLocalCodexSessions && hasUnmatchedLocalCodexThreads
          ? [
              ...targets,
              {
                id: LOCAL_CODEX_WORKSPACE_ID,
              } as WorkspaceInfo,
            ]
          : targets;
        for (const workspace of outputTargets) {
          if (
            !isThreadListRequestCurrent(
              workspace.id,
              requestSequence,
              runtimeContext,
              sourceId,
            )
          ) {
            continue;
          }
          const isUnmatchedLocalFallback =
            includeUnmatchedLocalCodexSessions &&
            workspace.id === LOCAL_CODEX_WORKSPACE_ID;
          const matchingThreads = matchingThreadsByWorkspace[workspace.id] ?? [];
          const activityByThread = nextThreadActivity[workspace.id] ?? {};
          const threadListState = buildWorkspaceThreadListState({
            workspaceId: workspace.id,
            matchingThreads,
            activityByThread,
            requestedSortKey,
            buildThreadSummary,
            activeThreadId: activeThreadIdByWorkspace[workspace.id],
            existingThreadIds: (threadsByWorkspace[workspace.id] ?? []).map(
              (thread) => thread.id,
            ),
            threadStatusById,
            threadParentById,
            threadListTargetCount: THREAD_LIST_TARGET_COUNT,
          });
          let summaries = threadListState.summaries;
          let continuity: ThreadListContinuityState | null | undefined =
            !preserveSessionLibraryOnProviderSwitch &&
            threadListContinuityByWorkspace[workspace.id]
              ? null
              : undefined;
          let preserveAnchors = true;
          hiddenThreadIdsByWorkspace[workspace.id]?.forEach((threadId) => {
            dispatch({ type: "hideThread", workspaceId: workspace.id, threadId });
          });
          if (preserveSessionLibraryOnProviderSwitch) {
            const cached = threadListVerifiedCacheRef.current[workspace.id];
            const sourceChanged = Boolean(
              cached?.sourceId &&
                sourceId &&
                cached.sourceId !== sourceId,
            );
            const baseThreads = sourceChanged
              ? []
              : (threadsByWorkspace[workspace.id] ?? []);
            const freshIds = new Set(summaries.map((thread) => thread.id));
            const uncoveredThreads = baseThreads.filter(
              (thread) => !freshIds.has(thread.id),
            );
            let retainedThreads = uncoveredThreads;
            let staleThreadIds = uncoveredThreads.map((thread) => thread.id);
            let verifiedSnapshot = sourceChanged
              ? null
              : (cached?.verifiedSnapshot ?? null);

            if (
              paginationComplete &&
              sourceId &&
              uncoveredThreads.length > 0
            ) {
              const staleListGeneration =
                (threadListGenerationRef.current[workspace.id] ?? 0) + 1;
              threadListGenerationRef.current[workspace.id] =
                staleListGeneration;
              dispatch({
                type: "setThreads",
                workspaceId: workspace.id,
                threads: [...summaries, ...uncoveredThreads],
                sortKey: requestedSortKey,
                preserveAnchors: !sourceChanged,
                continuity: {
                  sourceId,
                  runtimeGeneration: runtimeContext.runtimeGeneration,
                  listGeneration: staleListGeneration,
                  requestId,
                  requestSequence,
                  paginationComplete,
                  verifiedSnapshot,
                  staleThreadIds,
                },
              });
              const presenceByThreadId = new Map<
                string,
                "present" | "missing" | "unknown"
              >();
              try {
                for (
                  let offset = 0;
                  offset < uncoveredThreads.length;
                  offset += 256
                ) {
                  const threadIds = uncoveredThreads
                    .slice(offset, offset + 256)
                    .map((thread) => thread.id);
                  const verification = await verifySessionThreadsService({
                    sourceId,
                    threadIds,
                  });
                  if (
                    !isThreadListRequestCurrent(
                      workspace.id,
                      requestSequence,
                      runtimeContext,
                      sourceId,
                    )
                  ) {
                    break;
                  }
                  if (verification.snapshot.sourceId !== sourceId) {
                    throw new Error(
                      `Session source changed during verification: ${verification.snapshot.sourceId}`,
                    );
                  }
                  verifiedSnapshot = verification.snapshot;
                  verification.threads.forEach((thread) => {
                    presenceByThreadId.set(
                      thread.threadId,
                      thread.presence === "missing" &&
                        !verification.snapshot.complete
                        ? "unknown"
                        : thread.presence,
                    );
                  });
                }
                retainedThreads = uncoveredThreads.filter(
                  (thread) => presenceByThreadId.get(thread.id) !== "missing",
                );
                staleThreadIds = retainedThreads
                  .filter(
                    (thread) =>
                      presenceByThreadId.get(thread.id) !== "present",
                  )
                  .map((thread) => thread.id);
              } catch (error) {
                retainedThreads = uncoveredThreads;
                staleThreadIds = uncoveredThreads.map((thread) => thread.id);
                onDebug?.({
                  id: `${Date.now()}-client-thread-list-verification-error`,
                  timestamp: Date.now(),
                  source: "error",
                  label: "thread/list verification error",
                  payload: {
                    requestId,
                    workspaceId: workspace.id,
                    sourceId,
                    error: error instanceof Error ? error.message : String(error),
                  },
                });
              }
            }

            if (
              !isThreadListRequestCurrent(
                workspace.id,
                requestSequence,
                runtimeContext,
                sourceId,
              )
            ) {
              continue;
            }
            summaries = [...summaries, ...retainedThreads];
            const listGeneration =
              (threadListGenerationRef.current[workspace.id] ?? 0) + 1;
            threadListGenerationRef.current[workspace.id] = listGeneration;
            continuity = {
              sourceId,
              runtimeGeneration: runtimeContext.runtimeGeneration,
              listGeneration,
              requestId,
              requestSequence,
              paginationComplete,
              verifiedSnapshot,
              staleThreadIds,
            };
            threadListVerifiedCacheRef.current[workspace.id] = {
              sourceId: sourceId ?? cached?.sourceId ?? null,
              verifiedSnapshot,
            };
            preserveAnchors = !sourceChanged;
          }

          threadListState.uniqueThreads.forEach((thread) => {
            const threadId = String(thread?.id ?? "");
            if (!threadId) {
              return;
            }
            applyThreadMetadata(workspace.id, threadId, thread, {
              notifySubagent: true,
            });
          });
          if (threadListState.didChangeActivity && !isUnmatchedLocalFallback) {
            nextThreadActivity[workspace.id] = threadListState.nextActivityByThread;
            didChangeAnyActivity = true;
          }
          dispatch({
            type: "setThreads",
            workspaceId: workspace.id,
            threads: summaries,
            sortKey: requestedSortKey,
            preserveAnchors,
            continuity,
          });
          dispatch({
            type: "setThreadListCursor",
            workspaceId: workspace.id,
            cursor:
              resumeCursorByWorkspace[workspace.id] ??
              cursor ??
              (workspace.id === LOCAL_CODEX_WORKSPACE_ID && archivedCursor
                ? THREAD_LIST_CURSOR_PAGE_START
                : null),
          });
          threadListState.previewUpdates.forEach(({ threadId, text, timestamp }) => {
            dispatchPreviewMessage(threadId, text, timestamp);
          });
        }
        if (didChangeAnyActivity) {
          threadActivityRef.current = nextThreadActivity;
          saveThreadActivity(nextThreadActivity);
        }
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-thread-list-error`,
          timestamp: Date.now(),
          source: "error",
          label: "thread/list error",
          payload: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (!preserveState) {
          targets.forEach((workspace) => {
            if (
              !isThreadListLoadingOwner(
                workspace.id,
                requestSequence,
                "refresh",
              )
            ) {
              return;
            }
            dispatch({
              type: "setThreadListLoading",
              workspaceId: workspace.id,
              isLoading: false,
            });
          });
        }
      }
    },
    [
      applyThreadMetadata,
      beginThreadListRequest,
      buildThreadSummary,
      dispatchPreviewMessage,
      dispatch,
      getThreadListRuntimeContext,
      onDebug,
      isThreadListRequestCurrent,
      isThreadListLoadingOwner,
      preserveSessionLibraryOnProviderSwitch,
      resolveThreadListSourceId,
      activeThreadIdByWorkspace,
      threadParentById,
      threadActivityRef,
      threadStatusById,
      threadSortKey,
      threadListContinuityByWorkspace,
      threadsByWorkspace,
    ],
  );

  const listThreadsForWorkspace = useCallback(
    async (
      workspace: WorkspaceInfo,
      options?: {
        preserveState?: boolean;
        sortKey?: ThreadListSortKey;
        maxPages?: number;
        refreshReason?: ThreadListRefreshReason;
      },
    ) => {
      await listThreadsForWorkspaces([workspace], options);
    },
    [listThreadsForWorkspaces],
  );

  const loadOlderThreadsForWorkspace = useCallback(
    async (workspace: WorkspaceInfo) => {
      const requestedSortKey = threadSortKey;
      const cursorValue = threadListCursorByWorkspace[workspace.id] ?? null;
      if (!cursorValue) {
        return;
      }
      const runtimeContext = getThreadListRuntimeContext();
      const { requestId, requestSequence } = beginThreadListRequest(
        [workspace.id],
        "paging",
      );
      const sourceId = await resolveThreadListSourceId(runtimeContext);
      if (
        !isThreadListRequestCurrent(
          workspace.id,
          requestSequence,
          runtimeContext,
          sourceId,
        )
      ) {
        return;
      }
      const nextCursor =
        cursorValue === THREAD_LIST_CURSOR_PAGE_START ? null : cursorValue;
      let workspacePathLookup = buildWorkspacePathLookup([workspace]);
      const existing = threadsByWorkspace[workspace.id] ?? [];
      dispatch({
        type: "setThreadListPaging",
        workspaceId: workspace.id,
        isLoading: true,
      });
      onDebug?.({
        id: `${Date.now()}-client-thread-list-older`,
        timestamp: Date.now(),
        source: "client",
        label: "thread/list older",
        payload: {
          workspaceId: workspace.id,
          cursor: cursorValue,
          requestId,
          sourceId,
          runtimeGeneration: runtimeContext.runtimeGeneration,
        },
      });
      try {
        const hiddenThreadIds = new Set<string>();
        let requestWorkspaceId = workspace.id;
        let workspaceLookupComplete = false;
        try {
          const knownWorkspaces = await listWorkspacesService();
          workspaceLookupComplete = true;
          if (knownWorkspaces.length > 0) {
            workspacePathLookup = buildWorkspacePathLookup([
              workspace,
              ...knownWorkspaces,
            ]);
            if (workspace.id === LOCAL_CODEX_WORKSPACE_ID) {
              requestWorkspaceId =
                knownWorkspaces.find(
                  (entry) => entry.connected && entry.id !== LOCAL_CODEX_WORKSPACE_ID,
                )?.id ?? requestWorkspaceId;
            }
          }
        } catch (error) {
          workspacePathLookup = buildWorkspacePathLookup([workspace]);
          onDebug?.({
            id: `${Date.now()}-client-thread-list-older-workspace-lookup-error`,
            timestamp: Date.now(),
            source: "client",
            label: "thread/list older workspace lookup error",
            payload: { error: String(error), workspaceId: workspace.id },
          });
        }
        if (
          workspace.id === LOCAL_CODEX_WORKSPACE_ID &&
          !workspaceLookupComplete
        ) {
          dispatch({
            type: "setThreadListCursor",
            workspaceId: workspace.id,
            cursor: cursorValue,
          });
          return;
        }
        const matchingThreads: Record<string, unknown>[] = [];
        const maxPagesWithoutMatch = THREAD_LIST_MAX_PAGES_OLDER;
        let pagesFetched = 0;
        let cursor: string | null = nextCursor;
        do {
          pagesFetched += 1;
          const response =
            (await listThreadsService(
              requestWorkspaceId,
              cursor,
              THREAD_LIST_PAGE_SIZE,
              requestedSortKey,
            )) as Record<string, unknown>;
          if (
            !isThreadListRequestCurrent(
              workspace.id,
              requestSequence,
              runtimeContext,
              sourceId,
            )
          ) {
            return;
          }
          onDebug?.({
            id: `${Date.now()}-server-thread-list-older`,
            timestamp: Date.now(),
            source: "server",
            label: "thread/list older response",
            payload: response,
          });
          const result = (response.result ?? response) as Record<string, unknown>;
          const data = Array.isArray(result?.data)
            ? (result.data as Record<string, unknown>[])
            : [];
          const next = getThreadListNextCursor(result);
          matchingThreads.push(
            ...data.filter(
              (thread) => {
                const owningWorkspaceId = resolveWorkspaceIdForThreadPath(
                  String(thread?.cwd ?? ""),
                  workspacePathLookup,
                );
                if (workspace.id === LOCAL_CODEX_WORKSPACE_ID) {
                  const threadId = String(thread?.id ?? "");
                  if (threadId && shouldHideSubagentThreadFromSidebar(thread.source)) {
                    hiddenThreadIds.add(threadId);
                    return false;
                  }
                  return workspaceLookupComplete && !owningWorkspaceId;
                }
                if (owningWorkspaceId !== workspace.id) {
                  return false;
                }
                const threadId = String(thread?.id ?? "");
                if (threadId && shouldHideSubagentThreadFromSidebar(thread.source)) {
                  hiddenThreadIds.add(threadId);
                  return false;
                }
                return true;
              },
            ),
          );
          cursor = next;
          if (matchingThreads.length === 0 && pagesFetched >= maxPagesWithoutMatch) {
            break;
          }
          if (pagesFetched >= THREAD_LIST_MAX_PAGES_OLDER) {
            break;
          }
        } while (cursor && matchingThreads.length < THREAD_LIST_TARGET_COUNT);
        let archivedCursor =
          workspace.id === LOCAL_CODEX_WORKSPACE_ID
            ? (localArchivedCursorByWorkspaceRef.current[workspace.id] ?? null)
            : null;
        if (workspace.id === LOCAL_CODEX_WORKSPACE_ID && archivedCursor) {
          let archivedPagesFetched = 0;
          do {
            archivedPagesFetched += 1;
            const response =
              (await listThreadsService(
                requestWorkspaceId,
                archivedCursor,
                THREAD_LIST_PAGE_SIZE,
                requestedSortKey,
                true,
              )) as Record<string, unknown>;
            if (
              !isThreadListRequestCurrent(
                workspace.id,
                requestSequence,
                runtimeContext,
                sourceId,
              )
            ) {
              return;
            }
            onDebug?.({
              id: `${Date.now()}-server-thread-list-older-archived`,
              timestamp: Date.now(),
              source: "server",
              label: "thread/list older archived response",
              payload: response,
            });
            const result = (response.result ?? response) as Record<string, unknown>;
            const data = Array.isArray(result?.data)
              ? (result.data as Record<string, unknown>[])
              : [];
            const next = getThreadListNextCursor(result);
            matchingThreads.push(
              ...data.filter((thread) => {
                const threadId = String(thread?.id ?? "");
                if (threadId && shouldHideSubagentThreadFromSidebar(thread.source)) {
                  hiddenThreadIds.add(threadId);
                  return false;
                }
                return true;
              }),
            );
            archivedCursor = next;
            if (archivedPagesFetched >= THREAD_LIST_MAX_PAGES_OLDER) {
              break;
            }
          } while (archivedCursor && matchingThreads.length < THREAD_LIST_TARGET_COUNT);
          localArchivedCursorByWorkspaceRef.current[workspace.id] = archivedCursor;
        }

        if (sourceId && workspaceLookupComplete) {
          try {
            const managedSessions = await listActiveManagedSessionsCached(sourceId);
            managedSessions
              .filter(isSidebarManagedSessionCandidate)
              .map(managedSessionToThreadRecord)
              .forEach((thread) => {
                const owningWorkspaceId = resolveWorkspaceIdForThreadPath(
                  String(thread.cwd ?? ""),
                  workspacePathLookup,
                );
                const belongsToWorkspace =
                  workspace.id === LOCAL_CODEX_WORKSPACE_ID
                    ? !owningWorkspaceId
                    : owningWorkspaceId === workspace.id;
                if (belongsToWorkspace) {
                  matchingThreads.push(thread);
                }
              });
          } catch (error) {
            onDebug?.({
              id: `${Date.now()}-client-thread-list-older-managed-fallback-error`,
              timestamp: Date.now(),
              source: "error",
              label: "thread/list older managed fallback error",
              payload: error instanceof Error ? error.message : String(error),
            });
          }
        }

        const existingIds = new Set(existing.map((thread) => thread.id));
        const additions: ThreadSummary[] = [];
        matchingThreads.forEach((thread) => {
          const id = String(thread?.id ?? "");
          if (!id || existingIds.has(id)) {
            return;
          }
          applyThreadMetadata(workspace.id, id, thread);
          const summary = buildThreadSummary(
            workspace.id,
            thread,
            existing.length + additions.length,
          );
          if (!summary) {
            return;
          }
          additions.push(summary);
          existingIds.add(id);
        });

        if (
          !isThreadListRequestCurrent(
            workspace.id,
            requestSequence,
            runtimeContext,
            sourceId,
          )
        ) {
          return;
        }
        hiddenThreadIds.forEach((threadId) => {
          dispatch({ type: "hideThread", workspaceId: workspace.id, threadId });
        });
        const currentContinuity =
          threadListContinuityByWorkspace[workspace.id];
        const continuity = preserveSessionLibraryOnProviderSwitch
          ? {
              sourceId,
              runtimeGeneration: runtimeContext.runtimeGeneration,
              listGeneration:
                (threadListGenerationRef.current[workspace.id] ??
                  currentContinuity?.listGeneration ??
                  0) + 1,
              requestId,
              requestSequence,
              paginationComplete:
                currentContinuity?.paginationComplete ?? false,
              verifiedSnapshot:
                currentContinuity?.verifiedSnapshot ?? null,
              staleThreadIds: currentContinuity?.staleThreadIds ?? [],
            }
          : undefined;
        if (continuity) {
          threadListGenerationRef.current[workspace.id] =
            continuity.listGeneration;
        }
        if (additions.length > 0 || continuity) {
          dispatch({
            type: "setThreads",
            workspaceId: workspace.id,
            threads: [...existing, ...additions],
            sortKey: requestedSortKey,
            ...(continuity
              ? { preserveAnchors: true, continuity }
              : {}),
          });
        }
        dispatch({
          type: "setThreadListCursor",
          workspaceId: workspace.id,
          cursor:
            cursor ??
            (workspace.id === LOCAL_CODEX_WORKSPACE_ID && archivedCursor
              ? THREAD_LIST_CURSOR_PAGE_START
              : null),
        });
        matchingThreads.forEach((thread) => {
          const threadId = String(thread?.id ?? "");
          const preview = asString(thread?.preview ?? "").trim();
          if (!threadId || !preview) {
            return;
          }
          dispatch({
            type: "setLastAgentMessage",
            threadId,
            text: preview,
            timestamp: getThreadTimestamp(thread),
          });
        });
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-thread-list-older-error`,
          timestamp: Date.now(),
          source: "error",
          label: "thread/list older error",
          payload: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (
          isThreadListLoadingOwner(
            workspace.id,
            requestSequence,
            "paging",
          )
        ) {
          dispatch({
            type: "setThreadListPaging",
            workspaceId: workspace.id,
            isLoading: false,
          });
        }
      }
    },
    [
      applyThreadMetadata,
      beginThreadListRequest,
      buildThreadSummary,
      dispatch,
      onDebug,
      getThreadListRuntimeContext,
      isThreadListRequestCurrent,
      isThreadListLoadingOwner,
      preserveSessionLibraryOnProviderSwitch,
      resolveThreadListSourceId,
      threadListContinuityByWorkspace,
      threadListCursorByWorkspace,
      threadsByWorkspace,
      threadSortKey,
    ],
  );

  const archiveThread = useCallback(
    async (workspaceId: string, threadId: string) => {
      if (
        threadListContinuityByWorkspace[workspaceId]?.staleThreadIds.includes(
          threadId,
        )
      ) {
        onDebug?.({
          id: `${Date.now()}-client-thread-archive-stale`,
          timestamp: Date.now(),
          source: "client",
          label: "thread/archive blocked stale",
          payload: { workspaceId, threadId },
        });
        return;
      }
      try {
        await archiveThreadService(workspaceId, threadId);
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-thread-archive-error`,
          timestamp: Date.now(),
          source: "error",
          label: "thread/archive error",
          payload: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [onDebug, threadListContinuityByWorkspace],
  );

  return {
    startThreadForWorkspace,
    forkThreadForWorkspace,
    resumeThreadForWorkspace,
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
  };
}
