import type { CSSProperties, MouseEvent } from "react";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import Pin from "lucide-react/dist/esm/icons/pin";
import PinOff from "lucide-react/dist/esm/icons/pin-off";
import { useI18n } from "@/features/i18n/I18nProvider";

import type { ThreadSummary } from "../../../types";
import { getThreadStatusClass, type ThreadStatusById } from "../../../utils/threadStatus";

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function getSubagentPillToneStyle(
  workspaceId: string,
  nickname: string | null | undefined,
  role: string | null | undefined,
  threadId: string,
) {
  const identity = [workspaceId, nickname ?? role ?? threadId].join(":");
  const hash = hashString(identity);
  const hue = hash % 360;
  const saturation = 68 + (hash % 12);
  const accent = 52 + ((hash >> 3) % 10);
  return {
    "--thread-subagent-pill-hue": `${hue}`,
    "--thread-subagent-pill-saturation": `${saturation}%`,
    "--thread-subagent-pill-accent": `${accent}%`,
  } as CSSProperties;
}

function formatSubagentRoleLabel(role: string | null | undefined) {
  const normalized = (role ?? "").trim();
  if (!normalized) {
    return null;
  }
  return normalized
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

type ThreadRowProps = {
  thread: ThreadSummary;
  depth: number;
  workspaceId: string;
  indentUnit: number;
  activeWorkspaceId: string | null;
  activeThreadId: string | null;
  threadStatusById: ThreadStatusById;
  pendingUserInputKeys?: Set<string>;
  workspaceLabel?: string | null;
  getThreadTime: (thread: ThreadSummary) => string | null;
  getThreadArgsBadge?: (workspaceId: string, threadId: string) => string | null;
  isThreadPinned: (workspaceId: string, threadId: string) => boolean;
  onSelectThread: (workspaceId: string, threadId: string) => void;
  onShowThreadMenu: (
    event: MouseEvent,
    workspaceId: string,
    threadId: string,
    canPin: boolean,
  ) => void;
  onToggleThreadPin?: (workspaceId: string, threadId: string, pinned: boolean) => void;
  hasSubagentChildren?: boolean;
  subagentsExpanded?: boolean;
  onToggleSubagents?: (workspaceId: string, threadId: string) => void;
  showPinnedLabel?: boolean;
};

export function ThreadRow({
  thread,
  depth,
  workspaceId,
  indentUnit,
  activeWorkspaceId,
  activeThreadId,
  threadStatusById,
  pendingUserInputKeys,
  workspaceLabel,
  getThreadTime,
  getThreadArgsBadge,
  isThreadPinned,
  onSelectThread,
  onShowThreadMenu,
  onToggleThreadPin,
  hasSubagentChildren = false,
  subagentsExpanded = true,
  onToggleSubagents,
  showPinnedLabel = true,
}: ThreadRowProps) {
  const { t } = useI18n();
  const relativeTime = getThreadTime(thread);
  const badge = getThreadArgsBadge?.(workspaceId, thread.id) ?? null;
  const modelBadge =
    thread.modelId && thread.modelId.trim().length > 0
      ? thread.effort && thread.effort.trim().length > 0
        ? `${thread.modelId} · ${thread.effort}`
        : thread.modelId
      : null;
  const indentStyle =
    depth > 0
      ? ({ "--thread-indent": `${depth * indentUnit}px` } as CSSProperties)
      : undefined;
  const hasPendingUserInput = Boolean(
    pendingUserInputKeys?.has(`${workspaceId}:${thread.id}`),
  );
  const statusClass = getThreadStatusClass(
    threadStatusById[thread.id],
    hasPendingUserInput,
  );
  const statusLabel =
    statusClass === "reviewing"
      ? t("threads.statusReviewing")
      : statusClass === "waiting"
        ? t("threads.statusWaiting")
        : statusClass === "processing"
          ? t("threads.statusRunning")
          : null;
  const checkpointStatusLabel =
    thread.subagentCheckpointStatus === "pending"
      ? t("threads.checkpointPending")
      : thread.subagentCheckpointStatus === "delivered"
        ? t("threads.checkpointDelivered").replace(
            "{count}",
            String(thread.subagentCheckpointCount ?? 0),
          )
        : thread.subagentCheckpointStatus === "failed"
          ? t("threads.checkpointFailed")
          : null;
  const subagentLabel =
    thread.isSubagent && (thread.subagentNickname || thread.subagentRole)
      ? thread.subagentNickname ?? thread.subagentRole ?? null
      : null;
  const subagentTitle =
    thread.subagentNickname && thread.subagentRole
      ? `${thread.subagentNickname} · ${thread.subagentRole}`
      : subagentLabel;
  const subagentRoleLabel =
    thread.subagentNickname && thread.subagentRole
      ? formatSubagentRoleLabel(thread.subagentRole)
      : null;
  const subagentPillStyle = subagentLabel
    ? getSubagentPillToneStyle(
        workspaceId,
        thread.subagentNickname,
        thread.subagentRole,
        thread.id,
      )
    : undefined;
  const effectiveWorkspaceLabel = depth > 0 ? null : workspaceLabel;
  const contextLabel = badge ?? modelBadge;
  const canPin = depth === 0;
  const isPinned = canPin && isThreadPinned(workspaceId, thread.id);
  const canToggleSubagents = hasSubagentChildren && Boolean(onToggleSubagents);
  const hasDetails = Boolean(
    effectiveWorkspaceLabel ||
      subagentLabel ||
      contextLabel ||
      checkpointStatusLabel ||
      isPinned,
  );

  return (
    <div
      className={`thread-row ${
        workspaceId === activeWorkspaceId && thread.id === activeThreadId
          ? "active"
          : ""
      }${hasDetails ? " has-details" : ""}${
        hasDetails ? " has-secondary-line" : ""
      }${canToggleSubagents ? " has-subagent-children" : ""}${
        depth > 0 ? " is-nested" : ""
      }${isPinned ? " is-pinned" : ""}`}
      style={indentStyle}
      onClick={() => onSelectThread(workspaceId, thread.id)}
      onContextMenu={(event) => onShowThreadMenu(event, workspaceId, thread.id, canPin)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelectThread(workspaceId, thread.id);
        }
      }}
    >
      <span className={`thread-status ${statusClass}`} aria-hidden />
      <div className="thread-content">
        <div className="thread-headline">
          <span className="thread-name">{thread.name}</span>
        </div>
        {hasDetails && (
          <div className="thread-details">
            {effectiveWorkspaceLabel && (
              <span className="thread-workspace-label" title={effectiveWorkspaceLabel}>
                {effectiveWorkspaceLabel}
              </span>
            )}
            {subagentLabel && (
              <span
                className="thread-subagent-pill"
                title={subagentTitle ?? undefined}
                style={subagentPillStyle}
              >
                {subagentLabel}
              </span>
            )}
            {subagentRoleLabel && (
              <span className="thread-subagent-role" title={thread.subagentRole ?? undefined}>
                {subagentRoleLabel}
              </span>
            )}
            {checkpointStatusLabel && (
              <span className="thread-context-label" title={checkpointStatusLabel}>
                {checkpointStatusLabel}
              </span>
            )}
            {contextLabel && (
              <span className="thread-context-label" title={contextLabel}>
                {contextLabel}
              </span>
            )}
            {showPinnedLabel && isPinned && <span className="thread-pinned-label">Pinned</span>}
          </div>
        )}
      </div>
      {statusLabel && (
        <span className={`thread-state-chip ${statusClass}`}>{statusLabel}</span>
      )}
      <div className={`thread-meta${canToggleSubagents ? " has-subagent-toggle" : ""}`}>
        {canPin && onToggleThreadPin && (
          <button
            type="button"
            className={`thread-pin-button${isPinned ? " is-pinned" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              onToggleThreadPin(workspaceId, thread.id, isPinned);
            }}
            data-tauri-drag-region="false"
            aria-label={isPinned ? t("sidebar.unpinThread") : t("sidebar.pinThread")}
            title={isPinned ? t("sidebar.unpin") : t("sidebar.pin")}
            aria-pressed={isPinned}
          >
            {isPinned ? (
              <PinOff size={13} aria-hidden />
            ) : (
              <Pin size={13} aria-hidden />
            )}
          </button>
        )}
        {canToggleSubagents ? (
          <button
            type="button"
            className={`thread-subagent-time-toggle ${subagentsExpanded ? "expanded" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              onToggleSubagents?.(workspaceId, thread.id);
            }}
            data-tauri-drag-region="false"
            aria-label={subagentsExpanded ? "Hide sub-agents" : "Show sub-agents"}
            aria-expanded={subagentsExpanded}
          >
            <span className="thread-subagent-time-label">{relativeTime ?? "Now"}</span>
            <span className="thread-subagent-toggle-icon" aria-hidden>
              <ChevronRight size={14} strokeWidth={2.25} />
            </span>
          </button>
        ) : (
          relativeTime && <span className="thread-time">{relativeTime}</span>
        )}
      </div>
    </div>
  );
}
