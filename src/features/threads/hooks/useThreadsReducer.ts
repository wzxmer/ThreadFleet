import type {
  AccountSnapshot,
  ApprovalRequest,
  ConversationItem,
  RateLimitSnapshot,
  RequestUserInputRequest,
  ThreadListSortKey,
  ThreadSummary,
  ThreadTokenUsage,
  TurnExecutionSummary,
  TurnPlan,
} from "@/types";
import { CHAT_SCROLLBACK_DEFAULT } from "@utils/chatScrollback";
import type { ThreadListContinuityState } from "@threads/types";
import { reduceThreadItems } from "./threadReducer/threadItemsSlice";
import { reduceThreadLifecycle } from "./threadReducer/threadLifecycleSlice";
import { reduceThreadConfig } from "./threadReducer/threadConfigSlice";
import { reduceThreadQueue } from "./threadReducer/threadQueueSlice";
import { reduceThreadSnapshots } from "./threadReducer/threadSnapshotSlice";
import { reduceThreadExecutionSummaries } from "./threadReducer/threadExecutionSummarySlice";

type ThreadActivityStatus = {
  isProcessing: boolean;
  hasUnread: boolean;
  isReviewing: boolean;
  processingStartedAt: number | null;
  lastDurationMs: number | null;
};

export type ThreadHistoryRestoreState = "loading" | "failed";

export type ThreadState = {
  activeThreadIdByWorkspace: Record<string, string | null>;
  itemsByThread: Record<string, ConversationItem[]>;
  maxItemsPerThread: number | null;
  threadsByWorkspace: Record<string, ThreadSummary[]>;
  hiddenThreadIdsByWorkspace: Record<string, Record<string, true>>;
  threadParentById: Record<string, string>;
  threadStatusById: Record<string, ThreadActivityStatus>;
  threadResumeLoadingById: Record<string, boolean>;
  threadHistoryRestoreStateById: Record<string, ThreadHistoryRestoreState>;
  threadHistoryRecoveryAnchorThreadId: string | null;
  threadListLoadingByWorkspace: Record<string, boolean>;
  threadListPagingByWorkspace: Record<string, boolean>;
  threadListCursorByWorkspace: Record<string, string | null>;
  threadListFirstPageCursorByWorkspace: Record<string, string | null>;
  threadListContinuityByWorkspace: Record<
    string,
    ThreadListContinuityState | undefined
  >;
  threadSortKeyByWorkspace: Record<string, ThreadListSortKey>;
  activeTurnIdByThread: Record<string, string | null>;
  turnDiffByThread: Record<string, string>;
  turnExecutionSummaryByThread: Record<string, TurnExecutionSummary>;
  turnExecutionSummariesByThread: Record<string, TurnExecutionSummary[]>;
  approvals: ApprovalRequest[];
  userInputRequests: RequestUserInputRequest[];
  tokenUsageByThread: Record<string, ThreadTokenUsage>;
  completedContextCompactionIdsByThread: Record<string, Record<string, true>>;
  rateLimitsByWorkspace: Record<string, RateLimitSnapshot | null>;
  accountByWorkspace: Record<string, AccountSnapshot | null>;
  planByThread: Record<string, TurnPlan | null>;
  interruptedThreadById: Record<string, { timestamp: number }>;
  lastAgentMessageByThread: Record<string, { text: string; timestamp: number }>;
  pendingUserMessageReplacementByThread: Record<
    string,
    { messageId: string; text: string; images?: string[]; attachments?: string[] }
  >;
};

export type ThreadAction =
  | { type: "setActiveThreadId"; workspaceId: string; threadId: string | null }
  | { type: "setMaxItemsPerThread"; maxItemsPerThread: number | null }
  | { type: "ensureThread"; workspaceId: string; threadId: string }
  | { type: "hideThread"; workspaceId: string; threadId: string }
  | { type: "removeThread"; workspaceId: string; threadId: string }
  | { type: "setThreadParent"; threadId: string; parentId: string }
  | {
      type: "markProcessing";
      threadId: string;
      isProcessing: boolean;
      timestamp: number;
    }
  | { type: "markReviewing"; threadId: string; isReviewing: boolean }
  | { type: "markUnread"; threadId: string; hasUnread: boolean }
  | {
      type: "addAssistantMessage";
      threadId: string;
      text: string;
      turnId?: string;
    }
  | { type: "setThreadName"; workspaceId: string; threadId: string; name: string }
  | {
      type: "mergeThreadSummary";
      workspaceId: string;
      threadId: string;
      patch: Partial<
        Pick<
          ThreadSummary,
          | "isSubagent"
          | "subagentNickname"
          | "subagentRole"
          | "subagentCheckpointStatus"
          | "subagentCheckpointCount"
          | "createdAt"
        >
      >;
    }
  | {
      type: "setThreadTimestamp";
      workspaceId: string;
      threadId: string;
      timestamp: number;
    }
  | {
      type: "appendAgentDelta";
      workspaceId: string;
      threadId: string;
      itemId: string;
      delta: string;
      turnId?: string;
      hasCustomName: boolean;
    }
  | {
      type: "completeAgentMessage";
      workspaceId: string;
      threadId: string;
      itemId: string;
      turnId?: string;
      text: string;
      phase?: string | null;
      hasCustomName: boolean;
    }
  | {
      type: "upsertItem";
      workspaceId: string;
      threadId: string;
      item: ConversationItem;
      replaceExisting?: boolean;
      hasCustomName?: boolean;
    }
  | { type: "setItemTurnId"; threadId: string; itemId: string; turnId: string }
  | { type: "removeItem"; threadId: string; itemId: string }
  | {
      type: "setThreadItems";
      threadId: string;
      items: ConversationItem[];
      trimItems?: boolean;
    }
  | {
      type: "prependThreadItems";
      threadId: string;
      items: ConversationItem[];
    }
  | { type: "evictThreadItems"; threadIds: string[] }
  | {
      type: "appendReasoningSummary";
      threadId: string;
      itemId: string;
      delta: string;
    }
  | {
      type: "appendReasoningSummaryBoundary";
      threadId: string;
      itemId: string;
    }
  | { type: "appendReasoningContent"; threadId: string; itemId: string; delta: string }
  | { type: "appendPlanDelta"; threadId: string; itemId: string; delta: string }
  | { type: "appendToolOutput"; threadId: string; itemId: string; delta: string }
  | {
      type: "setThreads";
      workspaceId: string;
      threads: ThreadSummary[];
      sortKey: ThreadListSortKey;
      preserveAnchors?: boolean;
      continuity?: ThreadListContinuityState | null;
    }
  | {
      type: "setThreadListLoading";
      workspaceId: string;
      isLoading: boolean;
    }
  | {
      type: "setThreadResumeLoading";
      threadId: string;
      isLoading: boolean;
    }
  | {
      type: "setThreadHistoryRestoreState";
      threadId: string;
      state: ThreadHistoryRestoreState | null;
    }
  | { type: "setThreadHistoryRecoveryAnchor"; threadId: string }
  | { type: "clearThreadHistoryRecoveryAnchor"; threadId: string }
  | {
      type: "setThreadListPaging";
      workspaceId: string;
      isLoading: boolean;
    }
  | {
      type: "setThreadListCursor";
      workspaceId: string;
      cursor: string | null;
    }
  | {
      type: "setThreadListFirstPageCursor";
      workspaceId: string;
      cursor: string | null;
    }
  | {
      type: "compactThreadList";
      workspaceId: string;
      rootLimit: number;
      pinnedThreadIds: string[];
    }
  | { type: "addApproval"; approval: ApprovalRequest }
  | { type: "removeApproval"; requestId: number | string; workspaceId: string }
  | { type: "addUserInputRequest"; request: RequestUserInputRequest }
  | {
      type: "removeUserInputRequest";
      requestId: number | string;
      workspaceId: string;
    }
  | { type: "setThreadTokenUsage"; threadId: string; tokenUsage: ThreadTokenUsage }
  | {
      type: "setRateLimits";
      workspaceId: string;
      rateLimits: RateLimitSnapshot | null;
    }
  | {
      type: "setAccountInfo";
      workspaceId: string;
      account: AccountSnapshot | null;
    }
  | { type: "setActiveTurnId"; threadId: string; turnId: string | null }
  | { type: "setThreadTurnDiff"; threadId: string; diff: string }
  | {
      type: "startTurnExecution";
      workspaceId: string;
      threadId: string;
      turnId: string;
      executionId: string;
      modelId?: string | null;
      timestamp: number;
      continueExecution: boolean;
    }
  | {
      type: "updateTurnExecutionDiff";
      threadId: string;
      turnId: string;
      diff: string;
      timestamp: number;
    }
  | {
      type: "completeTurnExecution";
      threadId: string;
      turnId: string;
      status: Extract<TurnExecutionSummary["status"], "completed" | "interrupted" | "failed">;
      timestamp: number;
    }
  | {
      type: "hydrateTurnExecutionSummary";
      workspaceId: string;
      threadId: string;
      summary: TurnExecutionSummary;
    }
  | { type: "setThreadPlan"; threadId: string; plan: TurnPlan | null }
  | { type: "clearThreadPlan"; threadId: string }
  | { type: "markThreadInterrupted"; threadId: string; timestamp: number }
  | { type: "clearThreadInterrupted"; threadId: string }
  | {
      type: "setLastAgentMessage";
      threadId: string;
      text: string;
      timestamp: number;
    };

const emptyItems: Record<string, ConversationItem[]> = {};

export const initialState: ThreadState = {
  activeThreadIdByWorkspace: {},
  itemsByThread: emptyItems,
  maxItemsPerThread: CHAT_SCROLLBACK_DEFAULT,
  threadsByWorkspace: {},
  hiddenThreadIdsByWorkspace: {},
  threadParentById: {},
  threadStatusById: {},
  threadResumeLoadingById: {},
  threadHistoryRestoreStateById: {},
  threadHistoryRecoveryAnchorThreadId: null,
  threadListLoadingByWorkspace: {},
  threadListPagingByWorkspace: {},
  threadListCursorByWorkspace: {},
  threadListFirstPageCursorByWorkspace: {},
  threadListContinuityByWorkspace: {},
  threadSortKeyByWorkspace: {},
  activeTurnIdByThread: {},
  turnDiffByThread: {},
  turnExecutionSummaryByThread: {},
  turnExecutionSummariesByThread: {},
  approvals: [],
  userInputRequests: [],
  tokenUsageByThread: {},
  completedContextCompactionIdsByThread: {},
  rateLimitsByWorkspace: {},
  accountByWorkspace: {},
  planByThread: {},
  interruptedThreadById: {},
  lastAgentMessageByThread: {},
  pendingUserMessageReplacementByThread: {},
};

type ThreadSliceReducer = (state: ThreadState, action: ThreadAction) => ThreadState;

const threadSliceReducers: ThreadSliceReducer[] = [
  reduceThreadLifecycle,
  reduceThreadConfig,
  reduceThreadItems,
  reduceThreadQueue,
  reduceThreadSnapshots,
  reduceThreadExecutionSummaries,
];

export function threadReducer(state: ThreadState, action: ThreadAction): ThreadState {
  for (const reduceSlice of threadSliceReducers) {
    const nextState = reduceSlice(state, action);
    if (nextState !== state) {
      return nextState;
    }
  }
  return state;
}
