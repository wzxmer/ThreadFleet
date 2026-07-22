import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import type { ThreadState } from "./useThreadsReducer";

const TURN_STALL_WARNING_AFTER_MS = 10 * 60 * 1000;
const TURN_STALL_CHECK_INTERVAL_MS = 30 * 1000;

type UseThreadStallWarningsOptions = {
  threadStatusById: ThreadState["threadStatusById"];
  lastActivityAtByThreadRef?: MutableRefObject<Record<string, number>>;
  onReconcileThread?: (threadId: string) => void | Promise<void>;
  pushThreadErrorMessage: (threadId: string, message: string) => void;
  safeMessageActivity: () => void;
};

export function useThreadStallWarnings({
  threadStatusById,
  lastActivityAtByThreadRef,
  onReconcileThread,
  pushThreadErrorMessage,
  safeMessageActivity,
}: UseThreadStallWarningsOptions) {
  const warnedProcessingStartByThreadRef = useRef<Record<string, number>>({});

  useEffect(() => {
    const reconcileThread = (threadId: string) => {
      try {
        void Promise.resolve(onReconcileThread?.(threadId)).catch(() => {
          // Reconciliation is best-effort and must not break event handling.
        });
      } catch {
        // Reconciliation is best-effort and must not break event handling.
      }
    };

    const checkStalledThreads = () => {
      const now = Date.now();
      const activeThreadIds = new Set<string>();

      for (const [threadId, status] of Object.entries(threadStatusById)) {
        if (!status?.isProcessing || !status.processingStartedAt) {
          continue;
        }
        activeThreadIds.add(threadId);
        const lastActivityAt = Math.max(
          status.processingStartedAt,
          lastActivityAtByThreadRef?.current[threadId] ?? 0,
        );
        if (
          warnedProcessingStartByThreadRef.current[threadId] === lastActivityAt
        ) {
          continue;
        }
        if (now - lastActivityAt < TURN_STALL_WARNING_AFTER_MS) {
          continue;
        }
        warnedProcessingStartByThreadRef.current[threadId] = lastActivityAt;
        pushThreadErrorMessage(
          threadId,
          "Turn may be stalled: Codex has been working for over 10 minutes without a completion or error event.",
        );
        safeMessageActivity();
        reconcileThread(threadId);
      }

      for (const threadId of Object.keys(warnedProcessingStartByThreadRef.current)) {
        if (!activeThreadIds.has(threadId)) {
          delete warnedProcessingStartByThreadRef.current[threadId];
        }
      }
      if (lastActivityAtByThreadRef) {
        for (const threadId of Object.keys(lastActivityAtByThreadRef.current)) {
          if (!activeThreadIds.has(threadId)) {
            delete lastActivityAtByThreadRef.current[threadId];
          }
        }
      }
    };

    checkStalledThreads();
    const interval = window.setInterval(
      checkStalledThreads,
      TURN_STALL_CHECK_INTERVAL_MS,
    );
    return () => {
      window.clearInterval(interval);
    };
  }, [
    lastActivityAtByThreadRef,
    onReconcileThread,
    pushThreadErrorMessage,
    safeMessageActivity,
    threadStatusById,
  ]);
}
