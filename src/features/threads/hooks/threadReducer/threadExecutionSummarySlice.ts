import type { TurnExecutionSummary } from "@/types";
import type { ThreadAction, ThreadState } from "../useThreadsReducer";

function countDiffLines(diff: string) {
  let addedLines = 0;
  let deletedLines = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      addedLines += 1;
    } else if (line.startsWith("-")) {
      deletedLines += 1;
    }
  }
  return { addedLines, deletedLines };
}

function withSummary(
  state: ThreadState,
  threadId: string,
  summary: TurnExecutionSummary,
  updateCurrent = true,
): ThreadState {
  const existing = state.turnExecutionSummariesByThread[threadId] ?? [];
  const summaries = [
    ...existing.filter((candidate) => candidate.executionId !== summary.executionId),
    summary,
  ]
    .sort((left, right) => left.startedAtMs - right.startedAtMs)
    .slice(-32);
  return {
    ...state,
    turnExecutionSummaryByThread: updateCurrent
      ? {
          ...state.turnExecutionSummaryByThread,
          [threadId]: summary,
        }
      : state.turnExecutionSummaryByThread,
    turnExecutionSummariesByThread: {
      ...state.turnExecutionSummariesByThread,
      [threadId]: summaries,
    },
  };
}

export function reduceThreadExecutionSummaries(
  state: ThreadState,
  action: ThreadAction,
): ThreadState {
  switch (action.type) {
    case "startTurnExecution": {
      const current = state.turnExecutionSummaryByThread[action.threadId];
      if (current?.status === "active") {
        if (current.turnId === action.turnId) {
          return state;
        }
        if (action.continueExecution) {
          return withSummary(state, action.threadId, {
            ...current,
            turnId: action.turnId,
            turnChain: current.turnChain.includes(action.turnId)
              ? current.turnChain
              : [...current.turnChain, action.turnId],
            modelId: current.modelId ?? action.modelId ?? null,
            recordRevision: current.recordRevision + 1,
            updatedAtMs: action.timestamp,
          });
        }
      }
      return withSummary(state, action.threadId, {
        schemaVersion: 1,
        executionId: action.executionId,
        workspaceId: action.workspaceId,
        threadId: action.threadId,
        turnId: action.turnId,
        turnChain: [action.turnId],
        modelId: action.modelId ?? null,
        status: "active",
        startedAtMs: action.timestamp,
        endedAtMs: null,
        workingDurationMs: null,
        addedLines: null,
        deletedLines: null,
        diffRevision: 0,
        recordRevision: 1,
        updatedAtMs: action.timestamp,
      });
    }
    case "updateTurnExecutionDiff": {
      const current = state.turnExecutionSummaryByThread[action.threadId];
      if (
        !current ||
        current.status !== "active" ||
        current.turnId !== action.turnId
      ) {
        return state;
      }
      const { addedLines, deletedLines } = countDiffLines(action.diff);
      return withSummary(state, action.threadId, {
        ...current,
        addedLines,
        deletedLines,
        diffRevision: current.diffRevision + 1,
        recordRevision: current.recordRevision + 1,
        updatedAtMs: action.timestamp,
      });
    }
    case "completeTurnExecution": {
      const current = state.turnExecutionSummaryByThread[action.threadId];
      if (!current || current.turnId !== action.turnId) {
        return state;
      }
      if (current.status !== "active") {
        if (action.status !== current.status) {
          return state;
        }
        return withSummary(state, action.threadId, {
          ...current,
          status: action.status,
          recordRevision: current.recordRevision + 1,
          updatedAtMs: action.timestamp,
        });
      }
      return withSummary(state, action.threadId, {
        ...current,
        status: action.status,
        endedAtMs: action.timestamp,
        workingDurationMs: Math.max(0, action.timestamp - current.startedAtMs),
        recordRevision: current.recordRevision + 1,
        updatedAtMs: action.timestamp,
      });
    }
    case "hydrateTurnExecutionSummary": {
      const summary = action.summary;
      if (
        summary.status === "active" ||
        summary.workspaceId !== action.workspaceId ||
        summary.threadId !== action.threadId
      ) {
        return state;
      }
      const current = state.turnExecutionSummaryByThread[action.threadId];
      if (
        current &&
        current.executionId === summary.executionId &&
        (current.status === "active" ||
          current.recordRevision > summary.recordRevision ||
          (current.recordRevision === summary.recordRevision &&
            current.updatedAtMs >= summary.updatedAtMs))
      ) {
        return state;
      }
      const shouldUpdateCurrent =
        !current ||
        (current.status !== "active" && summary.updatedAtMs > current.updatedAtMs);
      return withSummary(state, action.threadId, summary, shouldUpdateCurrent);
    }
    default:
      return state;
  }
}
