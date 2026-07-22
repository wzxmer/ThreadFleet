import { useEffect, useMemo, useState, type MouseEvent } from "react";

import type { ThreadSummary } from "../../../types";
import type { ThreadStatusById } from "../../../utils/threadStatus";
import { useI18n } from "@/features/i18n/I18nProvider";
import { ThreadRow } from "./ThreadRow";
import { buildThreadRowVisibility } from "./threadRowVisibility";
import { countRootRows, splitRowsByRoot } from "./threadSearchUtils";
import { COLLAPSED_THREAD_ROOT_LIMIT } from "../hooks/useThreadRows";
import { useSubagentAutoCollapse } from "../hooks/useSubagentAutoCollapse";

type ThreadListRow = {
  thread: ThreadSummary;
  depth: number;
};

type ThreadListProps = {
  workspaceId: string;
  pinnedRows: ThreadListRow[];
  unpinnedRows: ThreadListRow[];
  totalThreadRoots: number;
  isExpanded: boolean;
  showExpandToggle?: boolean;
  nextCursor: string | null;
  isPaging: boolean;
  nested?: boolean;
  showLoadOlder?: boolean;
  activeWorkspaceId: string | null;
  activeThreadId: string | null;
  threadStatusById: ThreadStatusById;
  pendingUserInputKeys?: Set<string>;
  getThreadTime: (thread: ThreadSummary) => string | null;
  getThreadArgsBadge?: (workspaceId: string, threadId: string) => string | null;
  isThreadPinned: (workspaceId: string, threadId: string) => boolean;
  onToggleExpanded: (workspaceId: string) => void;
  onLoadOlderThreads: (workspaceId: string) => void;
  onSelectThread: (workspaceId: string, threadId: string) => void;
  onShowThreadMenu: (
    event: MouseEvent,
    workspaceId: string,
    threadId: string,
    canPin: boolean,
  ) => void;
  onToggleThreadPin?: (workspaceId: string, threadId: string, pinned: boolean) => void;
};

export function ThreadList({
  workspaceId,
  pinnedRows,
  unpinnedRows,
  totalThreadRoots,
  isExpanded,
  showExpandToggle = true,
  nextCursor,
  isPaging,
  nested,
  showLoadOlder = true,
  activeWorkspaceId,
  activeThreadId,
  threadStatusById,
  pendingUserInputKeys,
  getThreadTime,
  getThreadArgsBadge,
  isThreadPinned,
  onLoadOlderThreads,
  onSelectThread,
  onShowThreadMenu,
  onToggleThreadPin,
}: ThreadListProps) {
  const { t } = useI18n();
  const [visibleRootLimit, setVisibleRootLimit] = useState(
    COLLAPSED_THREAD_ROOT_LIMIT,
  );
  useEffect(() => {
    setVisibleRootLimit(COLLAPSED_THREAD_ROOT_LIMIT);
  }, [workspaceId]);
  const indentUnit = nested ? 10 : 14;
  const pinnedRowsWithWorkspace = useMemo(
    () => pinnedRows.map((row) => ({ ...row, workspaceId })),
    [pinnedRows, workspaceId],
  );
  const unpinnedRowsWithWorkspace = useMemo(
    () => unpinnedRows.map((row) => ({ ...row, workspaceId })),
    [unpinnedRows, workspaceId],
  );
  const pinnedSubagentCollapse = useSubagentAutoCollapse(
    pinnedRowsWithWorkspace,
    threadStatusById,
    pendingUserInputKeys,
  );
  const unpinnedSubagentCollapse = useSubagentAutoCollapse(
    unpinnedRowsWithWorkspace,
    threadStatusById,
    pendingUserInputKeys,
  );

  const pinnedVisibility = useMemo(
    () =>
      buildThreadRowVisibility(
        pinnedRows,
        (row) => pinnedSubagentCollapse.isCollapsed(workspaceId, row.thread.id),
      ),
    [pinnedRows, pinnedSubagentCollapse, workspaceId],
  );
  const unpinnedVisibility = useMemo(
    () =>
      buildThreadRowVisibility(
        splitRowsByRoot(unpinnedRows)
          .slice(
            0,
            Math.max(
              0,
              (isExpanded ? totalThreadRoots : visibleRootLimit) -
                countRootRows(pinnedRows),
            ),
          )
          .flatMap((group) => group.rows),
        (row) => unpinnedSubagentCollapse.isCollapsed(workspaceId, row.thread.id),
      ),
    [
      isExpanded,
      pinnedRows,
      totalThreadRoots,
      unpinnedRows,
      unpinnedSubagentCollapse,
      visibleRootLimit,
      workspaceId,
    ],
  );

  const pinnedRootCount = countRootRows(pinnedRows);
  const visibleRootCount = pinnedRootCount + countRootRows(unpinnedVisibility.visibleRows);
  const hasMoreRoots = totalThreadRoots > visibleRootCount;
  const canCollapse =
    !isExpanded && visibleRootLimit > COLLAPSED_THREAD_ROOT_LIMIT && !hasMoreRoots;

  const handleShowMore = () => {
    setVisibleRootLimit((currentLimit) => {
      const effectiveLimit = Math.max(currentLimit, visibleRootCount);
      const nextLimit = effectiveLimit < 10 ? 10 : effectiveLimit + 10;
      return Math.min(totalThreadRoots, nextLimit);
    });
  };

  return (
    <div className={`thread-list${nested ? " thread-list-nested" : ""}`}>
      {pinnedVisibility.visibleRows.map((row) => (
        <ThreadRow
          key={row.thread.id}
          thread={row.thread}
          depth={row.depth}
          workspaceId={workspaceId}
          indentUnit={indentUnit}
          activeWorkspaceId={activeWorkspaceId}
          activeThreadId={activeThreadId}
          threadStatusById={threadStatusById}
          pendingUserInputKeys={pendingUserInputKeys}
          getThreadTime={getThreadTime}
          getThreadArgsBadge={getThreadArgsBadge}
          isThreadPinned={isThreadPinned}
          onSelectThread={onSelectThread}
          onShowThreadMenu={onShowThreadMenu}
          onToggleThreadPin={onToggleThreadPin}
          hasSubagentChildren={pinnedVisibility.rowsWithChildren.has(row)}
          subagentsExpanded={!pinnedSubagentCollapse.isCollapsed(workspaceId, row.thread.id)}
          onToggleSubagents={pinnedSubagentCollapse.toggle}
        />
      ))}
      {pinnedVisibility.visibleRows.length > 0 && unpinnedVisibility.visibleRows.length > 0 && (
        <div className="thread-list-separator" aria-hidden="true" />
      )}
      {unpinnedVisibility.visibleRows.map((row) => (
        <ThreadRow
          key={row.thread.id}
          thread={row.thread}
          depth={row.depth}
          workspaceId={workspaceId}
          indentUnit={indentUnit}
          activeWorkspaceId={activeWorkspaceId}
          activeThreadId={activeThreadId}
          threadStatusById={threadStatusById}
          pendingUserInputKeys={pendingUserInputKeys}
          getThreadTime={getThreadTime}
          getThreadArgsBadge={getThreadArgsBadge}
          isThreadPinned={isThreadPinned}
          onSelectThread={onSelectThread}
          onShowThreadMenu={onShowThreadMenu}
          onToggleThreadPin={onToggleThreadPin}
          hasSubagentChildren={unpinnedVisibility.rowsWithChildren.has(row)}
          subagentsExpanded={!unpinnedSubagentCollapse.isCollapsed(workspaceId, row.thread.id)}
          onToggleSubagents={unpinnedSubagentCollapse.toggle}
        />
      ))}
      {showExpandToggle && (hasMoreRoots || canCollapse) && (
        <button
          className="thread-more"
          onClick={(event) => {
            event.stopPropagation();
            if (hasMoreRoots) {
              handleShowMore();
            } else {
              setVisibleRootLimit(COLLAPSED_THREAD_ROOT_LIMIT);
            }
          }}
        >
          {hasMoreRoots ? t("sidebar.showMore") : t("sidebar.collapseList")}
        </button>
      )}
      {showLoadOlder &&
        nextCursor &&
        !hasMoreRoots && (
          <button
            className="thread-more"
            onClick={(event) => {
              event.stopPropagation();
              onLoadOlderThreads(workspaceId);
            }}
            disabled={isPaging}
          >
            {isPaging
              ? t("sidebar.loading")
              : totalThreadRoots === 0
                ? t("sidebar.searchOlderThreads")
                : t("sidebar.loadOlderThreads")}
          </button>
        )}
    </div>
  );
}
