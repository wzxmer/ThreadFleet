import { useCallback, useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import type { DebugEntry, SubagentCheckpointSyncMode } from "@/types";
import { steerTurn } from "@services/tauri";
import type { ThreadState } from "./useThreadsReducer";
import {
  buildCheckpointInjection,
  checkpointThrottleMs,
  createSubagentCheckpoint,
  checkpointResultKey,
  checkpointTextEquivalent,
  shouldCreateCheckpoint,
  type SubagentCheckpoint,
} from "@threads/utils/subagentCheckpoints";

type AgentMessageCompletedEvent = {
  workspaceId: string;
  threadId: string;
  itemId: string;
  text: string;
};

type LatestAgentMessage = AgentMessageCompletedEvent & {
  turnId: string | null;
};

type UseSubagentCheckpointSyncOptions = {
  mode: SubagentCheckpointSyncMode;
  threadParentByIdRef: MutableRefObject<ThreadState["threadParentById"]>;
  threadStatusByIdRef: MutableRefObject<ThreadState["threadStatusById"]>;
  activeTurnIdByThreadRef: MutableRefObject<ThreadState["activeTurnIdByThread"]>;
  getChildName?: (workspaceId: string, threadId: string) => string | null;
  onStatusChange?: (
    workspaceId: string,
    parentThreadId: string,
    status: "pending" | "delivered" | "failed",
    deliveredCount: number,
  ) => void;
  onDebug?: (entry: DebugEntry) => void;
};

const MAX_DELIVERY_ATTEMPTS = 3;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isStaleTurnError(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes("no active turn") ||
    (normalized.includes("active turn") && normalized.includes("not found"));
}

export function useSubagentCheckpointSync({
  mode,
  threadParentByIdRef,
  threadStatusByIdRef,
  activeTurnIdByThreadRef,
  getChildName,
  onStatusChange,
  onDebug,
}: UseSubagentCheckpointSyncOptions) {
  const modeRef = useRef(mode);
  const deliveryEpochRef = useRef(0);
  const pendingByParentRef = useRef<Record<string, SubagentCheckpoint[]>>({});
  const deliveredIdsRef = useRef(new Set<string>());
  const deliveredByResultKeyRef = useRef(new Map<string, SubagentCheckpoint>());
  const progressCountByTurnRef = useRef<Record<string, number>>({});
  const sequenceByChildRef = useRef<Record<string, number>>({});
  const activeTurnByChildRef = useRef<Record<string, string | null>>({});
  const latestAgentMessageRef = useRef<Record<string, LatestAgentMessage>>({});
  const lastDeliveredAtByParentRef = useRef<Record<string, number>>({});
  const deliveryInFlightByParentRef = useRef<Record<string, boolean>>({});
  const flushTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  modeRef.current = mode;

  useEffect(() => {
    if (mode !== "off") return;
    deliveryEpochRef.current += 1;
    Object.values(flushTimersRef.current).forEach(clearTimeout);
    flushTimersRef.current = {};
    pendingByParentRef.current = {};
    latestAgentMessageRef.current = {};
    activeTurnByChildRef.current = {};
    progressCountByTurnRef.current = {};
  }, [mode]);

  const emitDebug = useCallback(
    (label: string, payload: Record<string, unknown>) => {
      onDebug?.({
        id: `${Date.now()}-subagent-checkpoint-${label}`,
        timestamp: Date.now(),
        source: "client",
        label: `subagent checkpoint ${label}`,
        payload,
      });
    },
    [onDebug],
  );

  const enqueue = useCallback((checkpoint: SubagentCheckpoint) => {
    const pending = pendingByParentRef.current[checkpoint.parentThreadId] ?? [];
    const resultKey = checkpointResultKey(checkpoint);
    const existingIndex = pending.findIndex(
      (item) => checkpointResultKey(item) === resultKey,
    );
    if (existingIndex < 0) {
      pendingByParentRef.current[checkpoint.parentThreadId] = [...pending, checkpoint];
      return;
    }
    const existing = pending[existingIndex];
    if (
      existing.id === checkpoint.id ||
      existing.kind === "final" ||
      (existing.kind === "progress" && checkpoint.kind === "progress")
    ) {
      pendingByParentRef.current[checkpoint.parentThreadId] = pending.map((item, index) =>
        index === existingIndex && checkpoint.kind === "progress" ? checkpoint : item,
      );
      return;
    }
    pendingByParentRef.current[checkpoint.parentThreadId] = pending.map((item, index) =>
      index === existingIndex ? checkpoint : item,
    );
  }, []);

  const flushParent = useCallback(
    async (parentThreadId: string) => {
      if (modeRef.current === "off" || deliveryInFlightByParentRef.current[parentThreadId]) {
        return;
      }
      const turnId = activeTurnIdByThreadRef.current[parentThreadId] ?? null;
      const isProcessing = threadStatusByIdRef.current[parentThreadId]?.isProcessing ?? false;
      const pending = pendingByParentRef.current[parentThreadId] ?? [];
      if (!turnId || !isProcessing || pending.length === 0) {
        return;
      }

      const eligiblePending =
        modeRef.current === "finalOnly"
          ? pending.filter((checkpoint) => checkpoint.kind === "final")
          : pending;
      if (eligiblePending.length === 0) {
        pendingByParentRef.current[parentThreadId] = [];
        return;
      }

      const now = Date.now();
      const hasFinal = eligiblePending.some((checkpoint) => checkpoint.kind === "final");
      const throttleMs = checkpointThrottleMs(modeRef.current);
      const elapsed = now - (lastDeliveredAtByParentRef.current[parentThreadId] ?? 0);
      if (!hasFinal && elapsed < throttleMs) {
        if (!flushTimersRef.current[parentThreadId]) {
          flushTimersRef.current[parentThreadId] = setTimeout(() => {
            delete flushTimersRef.current[parentThreadId];
            void flushParent(parentThreadId);
          }, throttleMs - elapsed);
        }
        return;
      }

      deliveryInFlightByParentRef.current[parentThreadId] = true;
      const deliveryEpoch = deliveryEpochRef.current;
      const deliveryIsCurrent = () => deliveryEpoch === deliveryEpochRef.current && modeRef.current !== "off";
      const batch = [...eligiblePending].sort((left, right) => left.sequence - right.sequence);
      pendingByParentRef.current[parentThreadId] = [];
      const text = batch
        .map((checkpoint) =>
          buildCheckpointInjection(
            checkpoint,
            getChildName?.(checkpoint.workspaceId, checkpoint.childThreadId),
          ),
        )
        .join("\n\n");
      try {
        await steerTurn(batch[0].workspaceId, parentThreadId, turnId, text);
        if (!deliveryIsCurrent()) return;
        batch.forEach((checkpoint) => {
          deliveredIdsRef.current.add(checkpoint.id);
          deliveredByResultKeyRef.current.set(checkpointResultKey(checkpoint), checkpoint);
        });
        lastDeliveredAtByParentRef.current[parentThreadId] = Date.now();
        onStatusChange?.(
          batch[0].workspaceId,
          parentThreadId,
          "delivered",
          batch.length,
        );
        emitDebug("delivered", {
          parentThreadId,
          turnId,
          checkpointIds: batch.map((checkpoint) => checkpoint.id),
        });
      } catch (error) {
        if (!deliveryIsCurrent()) return;
        const message = errorMessage(error);
        const staleTurn = isStaleTurnError(message);
        const retryBatch = batch
          .map((checkpoint) => ({
            ...checkpoint,
            attempts: checkpoint.attempts + 1,
            lastError: message,
          }))
          .filter((checkpoint) => staleTurn || checkpoint.attempts < MAX_DELIVERY_ATTEMPTS);
        pendingByParentRef.current[parentThreadId] = [
          ...retryBatch,
          ...(pendingByParentRef.current[parentThreadId] ?? []),
        ];
        onStatusChange?.(
          batch[0].workspaceId,
          parentThreadId,
          staleTurn ? "pending" : "failed",
          0,
        );
        if (!staleTurn && retryBatch.length > 0 && !flushTimersRef.current[parentThreadId]) {
          const retryDelayMs = Math.min(4_000, 1_000 * retryBatch[0].attempts);
          flushTimersRef.current[parentThreadId] = setTimeout(() => {
            delete flushTimersRef.current[parentThreadId];
            void flushParent(parentThreadId);
          }, retryDelayMs);
        }
        emitDebug(staleTurn ? "queued" : "failed", {
          parentThreadId,
          turnId,
          error: message,
          checkpointIds: batch.map((checkpoint) => checkpoint.id),
        });
      } finally {
        deliveryInFlightByParentRef.current[parentThreadId] = false;
      }
    },
    [
      activeTurnIdByThreadRef,
      emitDebug,
      getChildName,
      onStatusChange,
      threadStatusByIdRef,
    ],
  );

  const submitCheckpoint = useCallback(
    (checkpoint: SubagentCheckpoint | null) => {
      if (modeRef.current === "off" || !checkpoint || deliveredIdsRef.current.has(checkpoint.id)) {
        return;
      }
      const resultKey = checkpointResultKey(checkpoint);
      const delivered = deliveredByResultKeyRef.current.get(resultKey);
      if (
        delivered &&
        (delivered.kind === "final" ||
          (checkpoint.kind === "final" &&
            checkpointTextEquivalent(delivered.text, checkpoint.text)))
      ) {
        return;
      }
      enqueue(checkpoint);
      const turnId = activeTurnIdByThreadRef.current[checkpoint.parentThreadId] ?? null;
      const isProcessing =
        threadStatusByIdRef.current[checkpoint.parentThreadId]?.isProcessing ?? false;
      if (!turnId || !isProcessing) {
        onStatusChange?.(
          checkpoint.workspaceId,
          checkpoint.parentThreadId,
          "pending",
          0,
        );
      }
      void flushParent(checkpoint.parentThreadId);
    },
    [
      activeTurnIdByThreadRef,
      enqueue,
      flushParent,
      onStatusChange,
      threadStatusByIdRef,
    ],
  );

  const onAgentMessageCompleted = useCallback(
    (event: AgentMessageCompletedEvent) => {
      if (modeRef.current === "off") return;
      const parentThreadId = threadParentByIdRef.current[event.threadId];
      if (!parentThreadId) {
        return;
      }
      const childTurnId = activeTurnByChildRef.current[event.threadId] ?? null;
      latestAgentMessageRef.current[event.threadId] = { ...event, turnId: childTurnId };
      const turnKey = `${event.threadId}:${childTurnId ?? "pending"}`;
      const progressCount = progressCountByTurnRef.current[turnKey] ?? 0;
      if (!shouldCreateCheckpoint({ mode: modeRef.current, kind: "progress", progressCount })) {
        return;
      }
      const sequence = (sequenceByChildRef.current[event.threadId] ?? 0) + 1;
      sequenceByChildRef.current[event.threadId] = sequence;
      progressCountByTurnRef.current[turnKey] = progressCount + 1;
      submitCheckpoint(
        createSubagentCheckpoint({
          workspaceId: event.workspaceId,
          parentThreadId,
          childThreadId: event.threadId,
          childTurnId,
          sourceItemId: event.itemId,
          kind: "progress",
          text: event.text,
          sequence,
        }),
      );
    },
    [submitCheckpoint, threadParentByIdRef],
  );

  const onTurnStarted = useCallback(
    (workspaceId: string, threadId: string, turnId: string) => {
      if (modeRef.current === "off") return;
      activeTurnByChildRef.current[threadId] = turnId;
      void flushParent(threadId);
      emitDebug("turn-started", { workspaceId, threadId, turnId });
    },
    [emitDebug, flushParent],
  );

  const onTurnCompleted = useCallback(
    (workspaceId: string, threadId: string, turnId: string) => {
      if (modeRef.current === "off") return;
      const parentThreadId = threadParentByIdRef.current[threadId];
      const latest = latestAgentMessageRef.current[threadId];
      activeTurnByChildRef.current[threadId] = null;
      if (!parentThreadId || !latest || (latest.turnId && latest.turnId !== turnId)) {
        return;
      }
      const sequence = (sequenceByChildRef.current[threadId] ?? 0) + 1;
      sequenceByChildRef.current[threadId] = sequence;
      submitCheckpoint(
        createSubagentCheckpoint({
          workspaceId,
          parentThreadId,
          childThreadId: threadId,
          childTurnId: turnId,
          sourceItemId: latest.itemId,
          kind: "final",
          text: latest.text,
          sequence,
        }),
      );
    },
    [submitCheckpoint, threadParentByIdRef],
  );

  const clearThread = useCallback((threadId: string) => {
    delete pendingByParentRef.current[threadId];
    delete activeTurnByChildRef.current[threadId];
    delete latestAgentMessageRef.current[threadId];
    const timer = flushTimersRef.current[threadId];
    if (timer) {
      clearTimeout(timer);
      delete flushTimersRef.current[threadId];
    }
    Object.keys(pendingByParentRef.current).forEach((parentThreadId) => {
      pendingByParentRef.current[parentThreadId] = pendingByParentRef.current[
        parentThreadId
      ].filter((checkpoint) => checkpoint.childThreadId !== threadId);
    });
    deliveredByResultKeyRef.current.forEach((checkpoint, key) => {
      if (checkpoint.childThreadId === threadId) {
        deliveredByResultKeyRef.current.delete(key);
      }
    });
  }, []);

  const clearWorkspace = useCallback((workspaceId: string) => {
    Object.keys(pendingByParentRef.current).forEach((parentThreadId) => {
      pendingByParentRef.current[parentThreadId] = pendingByParentRef.current[
        parentThreadId
      ].filter((checkpoint) => checkpoint.workspaceId !== workspaceId);
    });
    deliveredByResultKeyRef.current.forEach((checkpoint, key) => {
      if (checkpoint.workspaceId === workspaceId) {
        deliveredByResultKeyRef.current.delete(key);
      }
    });
  }, []);

  useEffect(
    () => () => {
      Object.values(flushTimersRef.current).forEach(clearTimeout);
    },
    [],
  );

  return {
    onAgentMessageCompleted,
    onTurnStarted,
    onTurnCompleted,
    clearThread,
    clearWorkspace,
    flushParent,
  };
}
