import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { SendMessageResult, WorkspaceInfo } from "@/types";

const AUTO_CONTINUE_PROMPT =
  "The previous run ended unexpectedly. Continue the unfinished task from the current conversation state. Check existing results first and do not repeat work that is already complete.";
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000] as const;

export type ThreadAutoContinueStatus = {
  enabled: boolean;
  phase: "idle" | "waiting" | "sending" | "running";
  attempt: number;
  nextRetryAt: number | null;
};

type SendContinuation = (
  workspace: WorkspaceInfo,
  threadId: string,
  message: string,
) => Promise<SendMessageResult>;

type UseThreadAutoContinueOptions = {
  getWorkspace: (workspaceId: string) => WorkspaceInfo | null;
  isThreadProcessing: (threadId: string) => boolean;
  sendContinuationRef: MutableRefObject<SendContinuation | null>;
};

const EMPTY_STATUS: ThreadAutoContinueStatus = {
  enabled: false,
  phase: "idle",
  attempt: 0,
  nextRetryAt: null,
};

function retryDelay(attempt: number) {
  return RETRY_DELAYS_MS[Math.min(Math.max(attempt - 1, 0), RETRY_DELAYS_MS.length - 1)];
}

export function useThreadAutoContinue({
  getWorkspace,
  isThreadProcessing,
  sendContinuationRef,
}: UseThreadAutoContinueOptions) {
  const [statusByThread, setStatusByThread] = useState<Record<string, ThreadAutoContinueStatus>>({});
  const [statusByWorkspace, setStatusByWorkspace] = useState<
    Record<string, ThreadAutoContinueStatus>
  >({});
  const statusRef = useRef(statusByThread);
  const statusByWorkspaceRef = useRef(statusByWorkspace);
  const timerByThreadRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const expectedAutoStartRef = useRef(new Set<string>());
  const manuallyStoppedTurnRef = useRef(new Set<string>());
  const manualStopFenceByThreadRef = useRef(new Map<string, number>());

  statusRef.current = statusByThread;
  statusByWorkspaceRef.current = statusByWorkspace;

  const clearTimer = useCallback((threadId: string) => {
    const timer = timerByThreadRef.current.get(threadId);
    if (timer) {
      clearTimeout(timer);
      timerByThreadRef.current.delete(threadId);
    }
  }, []);

  const updateStatus = useCallback(
    (threadId: string, update: (current: ThreadAutoContinueStatus) => ThreadAutoContinueStatus) => {
      setStatusByThread((current) => {
        const next = { ...current, [threadId]: update(current[threadId] ?? EMPTY_STATUS) };
        statusRef.current = next;
        return next;
      });
    },
    [],
  );

  const scheduleRetryRef = useRef<
    ((workspaceId: string, threadId: string, attempt: number) => void) | null
  >(null);

  const scheduleRetry = useCallback(
    (workspaceId: string, threadId: string, attempt: number) => {
      clearTimer(threadId);
      const stopFence = manualStopFenceByThreadRef.current.get(threadId) ?? 0;
      if (!(statusRef.current[threadId] ?? EMPTY_STATUS).enabled) {
        return;
      }
      const delay = retryDelay(attempt);
      updateStatus(threadId, (status) => ({
        ...status,
        phase: "waiting",
        attempt,
        nextRetryAt: Date.now() + delay,
      }));
      const timer = setTimeout(async () => {
        timerByThreadRef.current.delete(threadId);
        if ((manualStopFenceByThreadRef.current.get(threadId) ?? 0) !== stopFence) {
          return;
        }
        if (!(statusRef.current[threadId] ?? EMPTY_STATUS).enabled) {
          return;
        }
        if (isThreadProcessing(threadId)) {
          scheduleRetryRef.current?.(workspaceId, threadId, attempt);
          return;
        }
        const workspace = getWorkspace(workspaceId);
        const sendContinuation = sendContinuationRef.current;
        if (!workspace || !sendContinuation) {
          scheduleRetryRef.current?.(workspaceId, threadId, attempt + 1);
          return;
        }
        if ((manualStopFenceByThreadRef.current.get(threadId) ?? 0) !== stopFence) {
          return;
        }
        expectedAutoStartRef.current.add(threadId);
        updateStatus(threadId, (status) => ({ ...status, phase: "sending", nextRetryAt: null }));
        try {
          const result = await sendContinuation(workspace, threadId, AUTO_CONTINUE_PROMPT);
          if ((manualStopFenceByThreadRef.current.get(threadId) ?? 0) !== stopFence) {
            expectedAutoStartRef.current.delete(threadId);
            return;
          }
          if (result?.status && result.status !== "sent") {
            expectedAutoStartRef.current.delete(threadId);
            scheduleRetryRef.current?.(workspaceId, threadId, attempt + 1);
            return;
          }
          updateStatus(threadId, (status) => ({ ...status, phase: "running", nextRetryAt: null }));
        } catch {
          expectedAutoStartRef.current.delete(threadId);
          if ((manualStopFenceByThreadRef.current.get(threadId) ?? 0) !== stopFence) {
            return;
          }
          scheduleRetryRef.current?.(workspaceId, threadId, attempt + 1);
        }
      }, delay);
      timerByThreadRef.current.set(threadId, timer);
    },
    [clearTimer, getWorkspace, isThreadProcessing, sendContinuationRef, updateStatus],
  );

  scheduleRetryRef.current = scheduleRetry;

  const setEnabled = useCallback(
    (threadId: string, enabled: boolean) => {
      clearTimer(threadId);
      expectedAutoStartRef.current.delete(threadId);
      updateStatus(threadId, () => ({ enabled, phase: "idle", attempt: 0, nextRetryAt: null }));
    },
    [clearTimer, updateStatus],
  );

  const onTurnStarted = useCallback(
    (_workspaceId: string, threadId: string) => {
      if (!statusRef.current[threadId]) {
        return;
      }
      clearTimer(threadId);
      if (expectedAutoStartRef.current.delete(threadId)) {
        updateStatus(threadId, (status) => ({ ...status, phase: "running", nextRetryAt: null }));
        return;
      }
      updateStatus(threadId, (status) => ({ ...status, phase: "idle", attempt: 0, nextRetryAt: null }));
    },
    [clearTimer, updateStatus],
  );

  const onTurnCompleted = useCallback(
    (_workspaceId: string, threadId: string) => {
      if (!statusRef.current[threadId]) {
        return;
      }
      clearTimer(threadId);
      expectedAutoStartRef.current.delete(threadId);
      updateStatus(threadId, (status) => ({ ...status, phase: "idle", attempt: 0, nextRetryAt: null }));
    },
    [clearTimer, updateStatus],
  );

  const onTurnError = useCallback(
    (workspaceId: string, threadId: string, turnId: string, payload: { willRetry: boolean }) => {
      if (manualStopFenceByThreadRef.current.has(threadId)) {
        if (turnId) {
          manuallyStoppedTurnRef.current.add(`${threadId}:${turnId}`);
        }
        return;
      }
      if (payload.willRetry) {
        return;
      }
      if (manuallyStoppedTurnRef.current.delete(`${threadId}:${turnId}`)) {
        return;
      }
      const status = statusRef.current[threadId] ?? EMPTY_STATUS;
      if (!status.enabled) {
        return;
      }
      expectedAutoStartRef.current.delete(threadId);
      scheduleRetry(workspaceId, threadId, status.attempt + 1);
    },
    [scheduleRetry],
  );

  const markManualStop = useCallback(
    (threadId: string, turnId: string | null) => {
      clearTimer(threadId);
      const nextFence =
        (manualStopFenceByThreadRef.current.get(threadId) ?? 0) + 1;
      manualStopFenceByThreadRef.current.set(threadId, nextFence);
      expectedAutoStartRef.current.delete(threadId);
      if (turnId) {
        manuallyStoppedTurnRef.current.add(`${threadId}:${turnId}`);
      }
      updateStatus(threadId, (status) => ({ ...status, phase: "idle", attempt: 0, nextRetryAt: null }));
    },
    [clearTimer, updateStatus],
  );

  const setWorkspaceEnabled = useCallback((workspaceId: string, enabled: boolean) => {
    const next = {
      ...statusByWorkspaceRef.current,
      [workspaceId]: { ...EMPTY_STATUS, enabled },
    };
    statusByWorkspaceRef.current = next;
    setStatusByWorkspace(next);
  }, []);

  const promoteWorkspaceToThread = useCallback((workspaceId: string, threadId: string) => {
    const pending = statusByWorkspaceRef.current[workspaceId];
    if (!pending) {
      return;
    }
    setStatusByThread((current) => {
      const next = { ...current, [threadId]: pending };
      statusRef.current = next;
      return next;
    });
    const { [workspaceId]: _removed, ...rest } = statusByWorkspaceRef.current;
    statusByWorkspaceRef.current = rest;
    setStatusByWorkspace(rest);
  }, []);

  const shouldContinueAfterError = useCallback(
    (threadId: string, turnId: string) =>
      (statusRef.current[threadId] ?? EMPTY_STATUS).enabled &&
      !manualStopFenceByThreadRef.current.has(threadId) &&
      !manuallyStoppedTurnRef.current.has(`${threadId}:${turnId}`),
    [],
  );

  const clearManualStop = useCallback((threadId: string) => {
    manualStopFenceByThreadRef.current.delete(threadId);
    for (const key of manuallyStoppedTurnRef.current) {
      if (key.startsWith(`${threadId}:`)) {
        manuallyStoppedTurnRef.current.delete(key);
      }
    }
  }, []);

  const clearThread = useCallback(
    (threadId: string) => {
      clearTimer(threadId);
      expectedAutoStartRef.current.delete(threadId);
      clearManualStop(threadId);
      setStatusByThread((current) => {
        if (!current[threadId]) {
          return current;
        }
        const { [threadId]: _, ...rest } = current;
        statusRef.current = rest;
        return rest;
      });
    },
    [clearManualStop, clearTimer],
  );

  useEffect(
    () => () => {
      timerByThreadRef.current.forEach((timer) => clearTimeout(timer));
      timerByThreadRef.current.clear();
    },
    [],
  );

  return {
    statusByThread,
    statusByWorkspace,
    setEnabled,
    setWorkspaceEnabled,
    promoteWorkspaceToThread,
    onTurnStarted,
    onTurnCompleted,
    onTurnError,
    markManualStop,
    clearManualStop,
    shouldContinueAfterError,
    clearThread,
  };
}
