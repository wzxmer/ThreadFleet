import { useCallback, useMemo, useRef } from "react";
import type { DebugEntry } from "../../../types";
import { sendNotification } from "../../../services/tauri";
import { useAppServerEvents } from "../../app/hooks/useAppServerEvents";
import { useI18n } from "../../i18n/I18nProvider";

const DEFAULT_MIN_DURATION_MS = 60_000; // 1 minute
const MAX_BODY_LENGTH = 200;

type SystemNotificationOptions = {
  enabled: boolean;
  isWindowFocused: boolean;
  minDurationMs?: number;
  computerControlNotificationsEnabled?: boolean;
  subagentNotificationsEnabled?: boolean;
  isSubagentThread?: (workspaceId: string, threadId: string) => boolean;
  getWorkspaceName?: (workspaceId: string) => string | undefined;
  onDebug?: (entry: DebugEntry) => void;
};

function buildThreadKey(workspaceId: string, threadId: string) {
  return `${workspaceId}:${threadId}`;
}

function buildTurnKey(workspaceId: string, threadId: string, turnId: string) {
  return `${workspaceId}:${threadId}:${turnId}`;
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 1) + "…";
}

export function useAgentSystemNotifications({
  enabled,
  minDurationMs = DEFAULT_MIN_DURATION_MS,
  computerControlNotificationsEnabled = true,
  subagentNotificationsEnabled = false,
  isSubagentThread,
  getWorkspaceName,
  onDebug,
}: SystemNotificationOptions) {
  const turnStartById = useRef(new Map<string, number>());
  const turnStartByThread = useRef(new Map<string, number>());
  const lastNotifiedAtByThread = useRef(new Map<string, number>());
  const finalMessageByTurn = useRef(new Map<string, string>());
  const computerControlByThread = useRef(
    new Map<string, { turnId: string; taskKey: string }>(),
  );
  const computerControlStarted = useRef(new Set<string>());
  const computerControlEnded = useRef(new Set<string>());
  const { t } = useI18n();

  const notify = useCallback(
    async (
      title: string,
      body: string,
      label: "success" | "error",
      extra?: Record<string, unknown>,
    ) => {
      try {
        await sendNotification(title, body, {
          autoCancel: true,
          extra,
        });
        onDebug?.({
          id: `${Date.now()}-client-notification-${label}`,
          timestamp: Date.now(),
          source: "client",
          label: `notification/${label}`,
          payload: { title, body },
        });
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-notification-error`,
          timestamp: Date.now(),
          source: "error",
          label: "notification/error",
          payload: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [onDebug],
  );

  const consumeDuration = useCallback(
    (workspaceId: string, threadId: string, turnId: string) => {
      const threadKey = buildThreadKey(workspaceId, threadId);
      let startedAt: number | undefined;

      if (turnId) {
        const turnKey = buildTurnKey(workspaceId, threadId, turnId);
        startedAt = turnStartById.current.get(turnKey);
        turnStartById.current.delete(turnKey);
      }

      if (startedAt === undefined) {
        startedAt = turnStartByThread.current.get(threadKey);
      }

      if (startedAt !== undefined) {
        turnStartByThread.current.delete(threadKey);
        return Date.now() - startedAt;
      }

      return null;
    },
    [],
  );

  const recordStartIfMissing = useCallback(
    (workspaceId: string, threadId: string) => {
      const threadKey = buildThreadKey(workspaceId, threadId);
      if (!turnStartByThread.current.has(threadKey)) {
        turnStartByThread.current.set(threadKey, Date.now());
      }
    },
    [],
  );

  const shouldNotify = useCallback(
    (
      workspaceId: string,
      threadId: string,
      durationMs: number | null,
      threadKey: string,
    ) => {
      if (durationMs === null) {
        return false;
      }
      if (!enabled) {
        return false;
      }
      if (
        !subagentNotificationsEnabled &&
        isSubagentThread?.(workspaceId, threadId)
      ) {
        return false;
      }
      if (durationMs < minDurationMs) {
        return false;
      }
      const lastNotifiedAt = lastNotifiedAtByThread.current.get(threadKey);
      if (lastNotifiedAt && Date.now() - lastNotifiedAt < 1500) {
        return false;
      }
      lastNotifiedAtByThread.current.set(threadKey, Date.now());
      return true;
    },
    [
      enabled,
      isSubagentThread,
      minDurationMs,
      subagentNotificationsEnabled,
    ],
  );

  const getNotificationContent = useCallback(
    (workspaceId: string, threadId: string, turnId: string, fallbackBody: string) => {
      const title = getWorkspaceName?.(workspaceId) ?? "Agent Complete";
      const finalMessage = finalMessageByTurn.current.get(
        buildTurnKey(workspaceId, threadId, turnId),
      );
      const body = finalMessage
        ? truncateText(finalMessage, MAX_BODY_LENGTH)
        : fallbackBody;
      return { title, body };
    },
    [getWorkspaceName],
  );

  const handleTurnStarted = useCallback(
    (workspaceId: string, threadId: string, turnId: string) => {
      const startedAt = Date.now();
      const threadKey = buildThreadKey(workspaceId, threadId);
      turnStartByThread.current.set(threadKey, startedAt);
      const threadTurnPrefix = `${threadKey}:`;
      for (const key of finalMessageByTurn.current.keys()) {
        if (key.startsWith(threadTurnPrefix)) {
          finalMessageByTurn.current.delete(key);
        }
      }
      if (turnId) {
        const turnKey = buildTurnKey(workspaceId, threadId, turnId);
        turnStartById.current.set(turnKey, startedAt);
      }
    },
    [],
  );

  const handleComputerControlStarted = useCallback(
    (
      workspaceId: string,
      threadId: string,
      item: Record<string, unknown>,
      eventTurnId?: string,
    ) => {
      if (!computerControlNotificationsEnabled || !enabled) {
        return;
      }
      if (String(item.type ?? "") !== "mcpToolCall") {
        return;
      }
      const server = String(item.server ?? "").trim().toLowerCase();
      const tool = String(item.tool ?? "").trim().toLowerCase();
      if (server !== "windows-ui" && !tool.startsWith("mcp__windows-ui__")) {
        return;
      }

      const threadKey = buildThreadKey(workspaceId, threadId);
      const turnId =
        eventTurnId?.trim() || String(item.turnId ?? item.turn_id ?? "").trim();
      const existing = computerControlByThread.current.get(threadKey);
      const resolvedTurnId = turnId || existing?.turnId || "unknown";
      const taskKey =
        existing?.turnId === "unknown" && turnId
          ? existing.taskKey
          : buildTurnKey(workspaceId, threadId, resolvedTurnId);
      if (computerControlStarted.current.has(taskKey)) {
        if (existing?.turnId === "unknown" && turnId) {
          computerControlByThread.current.set(threadKey, {
            turnId: resolvedTurnId,
            taskKey,
          });
        }
        return;
      }
      computerControlByThread.current.set(threadKey, {
        turnId: resolvedTurnId,
        taskKey,
      });
      computerControlStarted.current.add(taskKey);
      void notify(
        t("notifications.computerControlStartedTitle"),
        t("notifications.computerControlStartedBody"),
        "success",
        {
          kind: "computer_control",
          phase: "started",
          workspaceId,
          threadId,
          turnId: resolvedTurnId,
        },
      );
    },
    [computerControlNotificationsEnabled, enabled, notify, t],
  );

  const handleComputerControlEnded = useCallback(
    (
      workspaceId: string,
      threadId: string,
      turnId: string,
      status: "completed" | "interrupted" | "failed",
    ) => {
      const threadKey = buildThreadKey(workspaceId, threadId);
      const active = computerControlByThread.current.get(threadKey);
      if (!active) {
        return false;
      }
      const resolvedTurnId = turnId.trim() || active.turnId;
      if (
        active.turnId !== "unknown" &&
        turnId.trim() &&
        active.turnId !== turnId.trim()
      ) {
        return false;
      }
      const taskKey = active.taskKey;
      const resolvedTaskKey = buildTurnKey(
        workspaceId,
        threadId,
        resolvedTurnId,
      );
      if (
        computerControlEnded.current.has(taskKey) ||
        computerControlEnded.current.has(resolvedTaskKey)
      ) {
        computerControlByThread.current.delete(threadKey);
        return true;
      }
      computerControlEnded.current.add(taskKey);
      computerControlEnded.current.add(resolvedTaskKey);
      computerControlStarted.current.add(resolvedTaskKey);
      computerControlByThread.current.delete(threadKey);
      if (!enabled) {
        return true;
      }
      const bodyKey =
        status === "completed"
          ? "notifications.computerControlCompletedBody"
          : status === "interrupted"
            ? "notifications.computerControlInterruptedBody"
            : "notifications.computerControlFailedBody";
      void notify(
        t("notifications.computerControlEndedTitle"),
        t(bodyKey),
        status === "completed" ? "success" : "error",
        {
          kind: "computer_control",
          phase: status,
          workspaceId,
          threadId,
          turnId: resolvedTurnId,
        },
      );
      return true;
    },
    [enabled, notify, t],
  );

  const handleTurnCompleted = useCallback(
    (
      workspaceId: string,
      threadId: string,
      turnId: string,
      status: "completed" | "interrupted" | "failed" = "completed",
    ) => {
      const computerControlEnded = handleComputerControlEnded(
        workspaceId,
        threadId,
        turnId,
        status,
      );
      const durationMs = consumeDuration(workspaceId, threadId, turnId);
      const threadKey = buildThreadKey(workspaceId, threadId);
      const turnKey = turnId ? buildTurnKey(workspaceId, threadId, turnId) : null;
      if (computerControlEnded) {
        if (turnKey) {
          finalMessageByTurn.current.delete(turnKey);
        }
        return;
      }
      if (!shouldNotify(workspaceId, threadId, durationMs, threadKey)) {
        if (turnKey) {
          finalMessageByTurn.current.delete(turnKey);
        }
        return;
      }
      const { title, body } = getNotificationContent(
        workspaceId,
        threadId,
        turnId,
        "Your agent has finished its task.",
      );
      void notify(title, body, "success", {
        kind: "thread",
        workspaceId,
        threadId,
      });
      if (turnKey) {
        finalMessageByTurn.current.delete(turnKey);
      }
    },
    [
      consumeDuration,
      getNotificationContent,
      handleComputerControlEnded,
      notify,
      shouldNotify,
    ],
  );

  const handleTurnError = useCallback(
    (
      workspaceId: string,
      threadId: string,
      turnId: string,
      payload: { message: string; willRetry: boolean },
    ) => {
      if (payload.willRetry) {
        return;
      }
      const computerControlEnded = handleComputerControlEnded(
        workspaceId,
        threadId,
        turnId,
        "failed",
      );
      const durationMs = consumeDuration(workspaceId, threadId, turnId);
      const threadKey = buildThreadKey(workspaceId, threadId);
      const turnKey = turnId ? buildTurnKey(workspaceId, threadId, turnId) : null;
      if (computerControlEnded) {
        if (turnKey) {
          finalMessageByTurn.current.delete(turnKey);
        }
        return;
      }
      if (!shouldNotify(workspaceId, threadId, durationMs, threadKey)) {
        if (turnKey) {
          finalMessageByTurn.current.delete(turnKey);
        }
        return;
      }
      const title = getWorkspaceName?.(workspaceId) ?? "Agent Error";
      const body = payload.message || "An error occurred.";
      void notify(title, truncateText(body, MAX_BODY_LENGTH), "error", {
        kind: "thread",
        workspaceId,
        threadId,
      });
      if (turnKey) {
        finalMessageByTurn.current.delete(turnKey);
      }
    },
    [
      consumeDuration,
      getWorkspaceName,
      handleComputerControlEnded,
      notify,
      shouldNotify,
    ],
  );

  const handleItemStarted = useCallback(
    (
      workspaceId: string,
      threadId: string,
      item: Record<string, unknown>,
      turnId?: string,
    ) => {
      recordStartIfMissing(workspaceId, threadId);
      handleComputerControlStarted(workspaceId, threadId, item, turnId);
    },
    [handleComputerControlStarted, recordStartIfMissing],
  );

  const handleThreadClosed = useCallback(
    (workspaceId: string, threadId: string) => {
      handleComputerControlEnded(workspaceId, threadId, "", "failed");
    },
    [handleComputerControlEnded],
  );

  const handleAgentMessageDelta = useCallback(
    (event: { workspaceId: string; threadId: string }) => {
      recordStartIfMissing(event.workspaceId, event.threadId);
    },
    [recordStartIfMissing],
  );

  const handleAgentMessageCompleted = useCallback(
    (event: {
      workspaceId: string;
      threadId: string;
      turnId?: string;
      phase?: string | null;
      text: string;
    }) => {
      if (event.turnId && event.phase === "final_answer" && event.text) {
        finalMessageByTurn.current.set(
          buildTurnKey(event.workspaceId, event.threadId, event.turnId),
          event.text,
        );
      }
    },
    [],
  );

  const handlers = useMemo(
    () => ({
      onTurnStarted: handleTurnStarted,
      onTurnCompleted: handleTurnCompleted,
      onTurnError: handleTurnError,
      onItemStarted: handleItemStarted,
      onThreadClosed: handleThreadClosed,
      onAgentMessageDelta: handleAgentMessageDelta,
      onAgentMessageCompleted: handleAgentMessageCompleted,
    }),
    [
      handleAgentMessageCompleted,
      handleAgentMessageDelta,
      handleThreadClosed,
      handleItemStarted,
      handleTurnCompleted,
      handleTurnError,
      handleTurnStarted,
    ],
  );

  useAppServerEvents(handlers);
}
