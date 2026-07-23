import { createPortal } from "react-dom";
import { useState, type MouseEvent, type MutableRefObject, type ReactNode } from "react";
import Copy from "lucide-react/dist/esm/icons/copy";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import Plus from "lucide-react/dist/esm/icons/plus";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw";

import type { ThreadSummary, WorkspaceInfo } from "../../../types";
import type { ThreadStatusById } from "../../../utils/threadStatus";
import { useI18n } from "@/features/i18n/I18nProvider";
import {
  PopoverMenuItem,
  PopoverSurface,
} from "../../design-system/components/popover/PopoverPrimitives";
import { ThreadList } from "./ThreadList";
import { ThreadLoading } from "./ThreadLoading";
import { WorkspaceCard } from "./WorkspaceCard";
import { WorkspaceGroup } from "./WorkspaceGroup";
import { WorktreeSection } from "./WorktreeSection";
import {
  countRootRows,
  splitRowsByRoot,
  threadMatchesQuery,
  workspaceMatchesQuery,
} from "./threadSearchUtils";
import {
  isLocalCodexWorkspaceId,
  LOCAL_CODEX_WORKSPACE_NAME,
} from "@/features/workspaces/domain/localCodexWorkspace";
import type {
  SidebarWorkspaceAddMenuAnchor,
  ThreadRowsResult,
  WorkspaceGroupSection,
} from "./sidebarTypes";

type SidebarWorkspaceGroupsProps = {
  groups: WorkspaceGroupSection[];
  hasWorkspaceGroups: boolean;
  collapsedGroups: Set<string>;
  ungroupedCollapseId: string;
  toggleGroupCollapse: (groupId: string) => void;
  cloneChildIds: Set<string>;
  clonesBySource: Map<string, WorkspaceInfo[]>;
  worktreesByParent: Map<string, WorkspaceInfo[]>;
  workspaceVisibleDuringSearchById: Map<string, boolean>;
  isSearchActive: boolean;
  normalizedQuery: string;
  renderHighlightedName: (name: string) => ReactNode;
  isWorkspaceMatch: (workspace: WorkspaceInfo) => boolean;
  deletingWorktreeIds: Set<string>;
  threadsByWorkspace: Record<string, ThreadSummary[]>;
  threadStatusById: ThreadStatusById;
  threadListLoadingByWorkspace: Record<string, boolean>;
  threadListPagingByWorkspace: Record<string, boolean>;
  threadListCursorByWorkspace: Record<string, string | null>;
  localCodexHiddenThreadIds: Set<string>;
  expandedWorkspaces: Set<string>;
  activeWorkspaceId: string | null;
  activeThreadId: string | null;
  pendingUserInputKeys?: Set<string>;
  getThreadRows: (
    threads: ThreadSummary[],
    isExpanded: boolean,
    workspaceId: string,
    getPinTimestamp: (workspaceId: string, threadId: string) => number | null,
    pinVersion?: number,
  ) => ThreadRowsResult;
  getThreadTime: (thread: ThreadSummary) => string | null;
  getThreadArgsBadge?: (workspaceId: string, threadId: string) => string | null;
  isThreadPinned: (workspaceId: string, threadId: string) => boolean;
  onToggleThreadPin?: (workspaceId: string, threadId: string, pinned: boolean) => void;
  getPinTimestamp: (workspaceId: string, threadId: string) => number | null;
  pinnedThreadsVersion: number;
  addMenuAnchor: SidebarWorkspaceAddMenuAnchor | null;
  addMenuRef: MutableRefObject<HTMLDivElement | null>;
  addMenuWidth: number;
  newAgentDraftWorkspaceId?: string | null;
  startingDraftThreadWorkspaceId?: string | null;
  onSelectWorkspace: (workspaceId: string) => void;
  onConnectWorkspace: (workspace: WorkspaceInfo) => void;
  onAddAgent: (workspace: WorkspaceInfo) => void;
  onAddWorktreeAgent: (workspace: WorkspaceInfo) => void;
  onAddCloneAgent: (workspace: WorkspaceInfo) => void;
  onResumeThreadById: (workspace: WorkspaceInfo) => void;
  onToggleWorkspaceCollapse: (workspaceId: string, collapsed: boolean) => void;
  onSelectThread: (workspaceId: string, threadId: string) => void;
  onSelectLocalCodexThread: (cwd: string, threadId: string) => void;
  onShowThreadMenu: (
    event: MouseEvent,
    workspaceId: string,
    threadId: string,
    canPin: boolean,
  ) => void;
  onShowWorkspaceMenu: (event: MouseEvent, workspaceId: string) => void;
  onShowWorktreeMenu: (event: MouseEvent, worktree: WorkspaceInfo) => void;
  onShowCloneMenu: (event: MouseEvent, worktree: WorkspaceInfo) => void;
  isWorkspaceFolderPinned: (workspaceId: string) => boolean;
  onToggleExpanded: (workspaceId: string) => void;
  onLoadOlderThreads: (workspaceId: string) => void;
  onToggleAddMenu: (anchor: SidebarWorkspaceAddMenuAnchor | null) => void;
};

type SidebarWorkspaceEntryProps = Omit<
  SidebarWorkspaceGroupsProps,
  | "groups"
  | "hasWorkspaceGroups"
  | "collapsedGroups"
  | "ungroupedCollapseId"
  | "toggleGroupCollapse"
> & {
  workspace: WorkspaceInfo;
  allWorkspaceGroups: WorkspaceGroupSection[];
};

type ThreadRowEntry = {
  thread: ThreadSummary;
  depth: number;
};

function normalizeLocalCodexProjectPath(path: string | null | undefined) {
  return (path ?? "").trim().replace(/\\/g, "/").replace(/\/+$/g, "");
}

function getLocalCodexProjectLabel(path: string, unknownLabel = "Unknown project") {
  if (!path) {
    return unknownLabel;
  }
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

function localCodexProjectMatchesQuery(path: string, label: string, query: string) {
  if (!query) {
    return true;
  }
  return path.toLowerCase().includes(query) || label.toLowerCase().includes(query);
}

function getVisibleLocalCodexThreadListState({
  rows,
  totalRoots,
  query,
  isSearchActive,
}: {
  rows: ThreadRowEntry[];
  totalRoots: number;
  query: string;
  isSearchActive: boolean;
}) {
  if (!isSearchActive) {
    return {
      visibleRows: rows,
      displayRootCount: totalRoots,
    };
  }

  const visibleRows = splitRowsByRoot(rows)
    .filter((group) => {
      const path = normalizeLocalCodexProjectPath(group.root.thread.cwd);
      const label = getLocalCodexProjectLabel(path);
      return (
        localCodexProjectMatchesQuery(path, label, query) ||
        group.rows.some((row) => threadMatchesQuery(row.thread, label, query))
      );
    })
    .flatMap((group) => group.rows);

  return {
    visibleRows,
    displayRootCount: countRootRows(visibleRows),
  };
}

function getVisibleThreadSections({
  pinnedRows,
  unpinnedRows,
  totalUnpinnedRoots,
  workspaceName,
  query,
  isSearchActive,
}: {
  pinnedRows: ThreadRowEntry[];
  unpinnedRows: ThreadRowEntry[];
  totalUnpinnedRoots: number;
  workspaceName: string;
  query: string;
  isSearchActive: boolean;
}) {
  const pinnedRootCount = countRootRows(pinnedRows);
  if (!isSearchActive || workspaceMatchesQuery(workspaceName, query)) {
    return {
      visiblePinnedRows: pinnedRows,
      visibleUnpinnedRows: unpinnedRows,
      displayRootCount: pinnedRootCount + totalUnpinnedRoots,
    };
  }

  const visiblePinnedRows = splitRowsByRoot(pinnedRows)
    .filter((group) =>
      group.rows.some((row) => threadMatchesQuery(row.thread, workspaceName, query)),
    )
    .flatMap((group) => group.rows);
  const visibleUnpinnedRows = splitRowsByRoot(unpinnedRows)
    .filter((group) =>
      group.rows.some((row) => threadMatchesQuery(row.thread, workspaceName, query)),
    )
    .flatMap((group) => group.rows);

  return {
    visiblePinnedRows,
    visibleUnpinnedRows,
    displayRootCount:
      countRootRows(visiblePinnedRows) + countRootRows(visibleUnpinnedRows),
  };
}

function groupLocalCodexRowsByProject(rows: ThreadRowEntry[], unknownLabel: string) {
  const groups = new Map<
    string,
    {
      key: string;
      label: string;
      path: string;
      rows: ThreadRowEntry[];
    }
  >();

  splitRowsByRoot(rows).forEach((rootGroup) => {
    const path = normalizeLocalCodexProjectPath(rootGroup.root.thread.cwd);
    const key = path || "__unknown__";
    const existing =
      groups.get(key) ??
      {
        key,
        label: getLocalCodexProjectLabel(path, unknownLabel),
        path,
        rows: [] as ThreadRowEntry[],
      };
    existing.rows.push(...rootGroup.rows);
    groups.set(key, existing);
  });

  return [...groups.values()];
}

function hideLocalCodexRowsByRootThreadId(
  rows: ThreadRowEntry[],
  hiddenThreadIds: Set<string>,
) {
  return splitRowsByRoot(rows)
    .filter((group) => !hiddenThreadIds.has(group.root.thread.id))
    .flatMap((group) => group.rows);
}

function resolveLocalCodexProjectWorkspaceId(
  path: string,
  groups: WorkspaceGroupSection[],
) {
  const normalizedPath = normalizeLocalCodexProjectPath(path).toLowerCase();
  if (!normalizedPath) {
    return null;
  }

  const candidates = groups
    .flatMap((group) => group.workspaces)
    .filter((workspace) => !isLocalCodexWorkspaceId(workspace.id))
    .map((workspace) => ({
      id: workspace.id,
      path: normalizeLocalCodexProjectPath(workspace.path).toLowerCase(),
    }))
    .filter((workspace) => workspace.path.length > 0)
    .sort((a, b) => b.path.length - a.path.length);

  return (
    candidates.find(
      (workspace) =>
        normalizedPath === workspace.path ||
        normalizedPath.startsWith(`${workspace.path}/`),
    )?.id ?? null
  );
}

function LocalCodexProjectThreadGroups({
  workspaceId,
  rows,
  nextCursor,
  isPaging,
  activeWorkspaceId,
  activeThreadId,
  threadStatusById,
  pendingUserInputKeys,
  getThreadTime,
  getThreadArgsBadge,
  isThreadPinned,
  onToggleThreadPin,
  isSearchActive,
  resolveProjectWorkspaceId,
  onToggleExpanded,
  onLoadOlderThreads,
  onSelectLocalCodexThread,
  onShowThreadMenu,
}: {
  workspaceId: string;
  rows: ThreadRowEntry[];
  nextCursor: string | null;
  isPaging: boolean;
  activeWorkspaceId: string | null;
  activeThreadId: string | null;
  threadStatusById: ThreadStatusById;
  pendingUserInputKeys?: Set<string>;
  getThreadTime: (thread: ThreadSummary) => string | null;
  getThreadArgsBadge?: (workspaceId: string, threadId: string) => string | null;
  isThreadPinned: (workspaceId: string, threadId: string) => boolean;
  onToggleThreadPin?: (workspaceId: string, threadId: string, pinned: boolean) => void;
  isSearchActive: boolean;
  resolveProjectWorkspaceId: (path: string) => string | null;
  onToggleExpanded: (workspaceId: string) => void;
  onLoadOlderThreads: (workspaceId: string) => void;
  onSelectLocalCodexThread: (cwd: string, threadId: string) => void;
  onShowThreadMenu: (
    event: MouseEvent,
    workspaceId: string,
    threadId: string,
    canPin: boolean,
  ) => void;
}) {
  const { t } = useI18n();
  const groups = groupLocalCodexRowsByProject(rows, t("sidebar.unknownProject"));
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<Set<string>>(
    () => new Set(),
  );

  const toggleProjectCollapse = (projectKey: string) => {
    setCollapsedProjectKeys((current) => {
      const next = new Set(current);
      if (next.has(projectKey)) {
        next.delete(projectKey);
      } else {
        next.add(projectKey);
      }
      return next;
    });
  };

  if (groups.length === 0 && nextCursor) {
    return (
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
          : isSearchActive
            ? t("sidebar.searchOlderThreads")
            : t("sidebar.loadOlderThreads")}
      </button>
    );
  }

  return (
    <>
      {groups.map((group) => {
        const rootCount = countRootRows(group.rows);
        const projectWorkspaceId = resolveProjectWorkspaceId(group.path);
        const isProjectCollapsed =
          !isSearchActive && collapsedProjectKeys.has(group.key);

        return (
          <div className="local-codex-project-group" key={group.key}>
            <button
              type="button"
              className={`sidebar-section-header local-codex-project-header local-codex-project-toggle${
                isProjectCollapsed ? "" : " expanded"
              }`}
              aria-expanded={!isProjectCollapsed}
              aria-label={`${
                isProjectCollapsed ? t("sidebar.expand") : t("sidebar.collapse")
              } ${group.label}`}
              onClick={(event) => {
                event.stopPropagation();
                toggleProjectCollapse(group.key);
              }}
            >
              <span className="workspace-toggle-icon" aria-hidden>
                ›
              </span>
              <div className="sidebar-section-title" title={group.path || undefined}>
                {group.label}
              </div>
              <div className="sidebar-section-count">{rootCount}</div>
            </button>
            {!isProjectCollapsed && (
              <ThreadList
                workspaceId={projectWorkspaceId ?? workspaceId}
                pinnedRows={[]}
                unpinnedRows={group.rows}
                totalThreadRoots={rootCount}
                isExpanded
                showExpandToggle={false}
                nextCursor={null}
                isPaging={isPaging}
                showLoadOlder={false}
                activeWorkspaceId={activeWorkspaceId}
                activeThreadId={activeThreadId}
                threadStatusById={threadStatusById}
                pendingUserInputKeys={pendingUserInputKeys}
                getThreadTime={getThreadTime}
                getThreadArgsBadge={getThreadArgsBadge}
                isThreadPinned={isThreadPinned}
                onToggleThreadPin={onToggleThreadPin}
                onToggleExpanded={onToggleExpanded}
                onLoadOlderThreads={onLoadOlderThreads}
                onSelectThread={(_workspaceId, threadId) =>
                  onSelectLocalCodexThread(group.path, threadId)
                }
                onShowThreadMenu={onShowThreadMenu}
              />
            )}
          </div>
        );
      })}
      {nextCursor && (
        <button
          className="thread-more"
          onClick={(event) => {
            event.stopPropagation();
            onLoadOlderThreads(workspaceId);
          }}
          disabled={isPaging}
        >
          {isPaging ? t("sidebar.loading") : t("sidebar.loadOlderThreads")}
        </button>
      )}
    </>
  );
}

function LocalCodexWorkspaceEntry({
  workspace,
  allWorkspaceGroups,
  isSearchActive,
  normalizedQuery,
  threadsByWorkspace,
  threadStatusById,
  threadListLoadingByWorkspace,
  threadListPagingByWorkspace,
  threadListCursorByWorkspace,
  localCodexHiddenThreadIds,
  expandedWorkspaces,
  activeWorkspaceId,
  activeThreadId,
  pendingUserInputKeys,
  getThreadRows,
  getThreadTime,
  getThreadArgsBadge,
  isThreadPinned,
  onToggleThreadPin,
  getPinTimestamp,
  pinnedThreadsVersion,
  onSelectLocalCodexThread,
  onShowThreadMenu,
  onToggleExpanded,
  onLoadOlderThreads,
}: SidebarWorkspaceEntryProps) {
  const { t } = useI18n();
  const threads = threadsByWorkspace[workspace.id] ?? [];
  const isExpanded = isSearchActive || expandedWorkspaces.has(workspace.id);
  const { pinnedRows, unpinnedRows } = getThreadRows(
    threads,
    true,
    workspace.id,
    getPinTimestamp,
    pinnedThreadsVersion,
  );
  const visiblePinnedRows = hideLocalCodexRowsByRootThreadId(
    pinnedRows,
    localCodexHiddenThreadIds,
  );
  const visibleUnpinnedRows = hideLocalCodexRowsByRootThreadId(
    unpinnedRows,
    localCodexHiddenThreadIds,
  );
  const nextCursor = threadListCursorByWorkspace[workspace.id] ?? null;
  const { visibleRows, displayRootCount } = getVisibleLocalCodexThreadListState({
    rows: [...visiblePinnedRows, ...visibleUnpinnedRows],
    totalRoots: countRootRows(visiblePinnedRows) + countRootRows(visibleUnpinnedRows),
    query: normalizedQuery,
    isSearchActive,
  });
  const isLoadingThreads = threadListLoadingByWorkspace[workspace.id] ?? false;
  const isPaging = threadListPagingByWorkspace[workspace.id] ?? false;
  const showThreadLoader = isLoadingThreads && threads.length === 0;
  const showThreadList = visibleRows.length > 0 || Boolean(nextCursor);
  const hasLoadedRows = displayRootCount > 0;

  return (
    <div className="local-codex-history">
      <button
        type="button"
        className={`local-codex-history-header${isExpanded ? " expanded" : ""}`}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? t("sidebar.collapse") : t("sidebar.expand")} ${
          LOCAL_CODEX_WORKSPACE_NAME
        }`}
        onClick={(event) => {
          event.stopPropagation();
          onToggleExpanded(workspace.id);
        }}
      >
        <span className="workspace-toggle-icon" aria-hidden>
          ›
        </span>
        <span className="local-codex-history-title">{LOCAL_CODEX_WORKSPACE_NAME}</span>
        <span className="local-codex-history-count">{displayRootCount}</span>
      </button>

      {isExpanded && (
        <div className="local-codex-history-content">
          <div className="local-codex-history-content-inner">
            {!workspace.connected && (
              <div className="workspace-local-empty">
                {t("sidebar.localHistoryConnectHint")}
              </div>
            )}
            {workspace.connected && !hasLoadedRows && !nextCursor && !showThreadLoader && (
              <div className="workspace-local-empty">{t("sidebar.noLocalHistory")}</div>
            )}
            {showThreadList && (
              <LocalCodexProjectThreadGroups
                workspaceId={workspace.id}
                rows={visibleRows}
                nextCursor={nextCursor}
                isPaging={isPaging}
                activeWorkspaceId={activeWorkspaceId}
                activeThreadId={activeThreadId}
                threadStatusById={threadStatusById}
                pendingUserInputKeys={pendingUserInputKeys}
                getThreadTime={getThreadTime}
                getThreadArgsBadge={getThreadArgsBadge}
                isThreadPinned={isThreadPinned}
                onToggleThreadPin={onToggleThreadPin}
                isSearchActive={isSearchActive}
                resolveProjectWorkspaceId={(path) =>
                  resolveLocalCodexProjectWorkspaceId(path, allWorkspaceGroups)
                }
                onToggleExpanded={onToggleExpanded}
                onLoadOlderThreads={onLoadOlderThreads}
                onSelectLocalCodexThread={onSelectLocalCodexThread}
                onShowThreadMenu={onShowThreadMenu}
              />
            )}
            {showThreadLoader && <ThreadLoading />}
          </div>
        </div>
      )}
    </div>
  );
}

function SidebarWorkspaceEntry({
  workspace,
  allWorkspaceGroups,
  cloneChildIds,
  clonesBySource,
  worktreesByParent,
  workspaceVisibleDuringSearchById,
  isSearchActive,
  normalizedQuery,
  renderHighlightedName,
  isWorkspaceMatch,
  deletingWorktreeIds,
  threadsByWorkspace,
  threadStatusById,
  threadListLoadingByWorkspace,
  threadListPagingByWorkspace,
  threadListCursorByWorkspace,
  localCodexHiddenThreadIds,
  expandedWorkspaces,
  activeWorkspaceId,
  activeThreadId,
  pendingUserInputKeys,
  getThreadRows,
  getThreadTime,
  getThreadArgsBadge,
  isThreadPinned,
  onToggleThreadPin,
  getPinTimestamp,
  pinnedThreadsVersion,
  addMenuAnchor,
  addMenuRef,
  addMenuWidth,
  newAgentDraftWorkspaceId,
  startingDraftThreadWorkspaceId,
  onSelectWorkspace,
  onConnectWorkspace,
  onAddAgent,
  onAddWorktreeAgent,
  onAddCloneAgent,
  onResumeThreadById,
  onToggleWorkspaceCollapse,
  onSelectThread,
  onSelectLocalCodexThread,
  onShowThreadMenu,
  onShowWorkspaceMenu,
  onShowWorktreeMenu,
  onShowCloneMenu,
  isWorkspaceFolderPinned,
  onToggleExpanded,
  onLoadOlderThreads,
  onToggleAddMenu,
}: SidebarWorkspaceEntryProps) {
  const { t } = useI18n();
  if (cloneChildIds.has(workspace.id)) {
    return null;
  }

  const threads = threadsByWorkspace[workspace.id] ?? [];
  const isLocalCodexWorkspace = isLocalCodexWorkspaceId(workspace.id);
  if (isLocalCodexWorkspace) {
    return (
      <LocalCodexWorkspaceEntry
        workspace={workspace}
        allWorkspaceGroups={allWorkspaceGroups}
        cloneChildIds={cloneChildIds}
        clonesBySource={clonesBySource}
        worktreesByParent={worktreesByParent}
        workspaceVisibleDuringSearchById={workspaceVisibleDuringSearchById}
        isSearchActive={isSearchActive}
        normalizedQuery={normalizedQuery}
        renderHighlightedName={renderHighlightedName}
        isWorkspaceMatch={isWorkspaceMatch}
        deletingWorktreeIds={deletingWorktreeIds}
        threadsByWorkspace={threadsByWorkspace}
        threadStatusById={threadStatusById}
        threadListLoadingByWorkspace={threadListLoadingByWorkspace}
        threadListPagingByWorkspace={threadListPagingByWorkspace}
        threadListCursorByWorkspace={threadListCursorByWorkspace}
        localCodexHiddenThreadIds={localCodexHiddenThreadIds}
        expandedWorkspaces={expandedWorkspaces}
        activeWorkspaceId={activeWorkspaceId}
        activeThreadId={activeThreadId}
        pendingUserInputKeys={pendingUserInputKeys}
        getThreadRows={getThreadRows}
        getThreadTime={getThreadTime}
        getThreadArgsBadge={getThreadArgsBadge}
        isThreadPinned={isThreadPinned}
        onToggleThreadPin={onToggleThreadPin}
        getPinTimestamp={getPinTimestamp}
        pinnedThreadsVersion={pinnedThreadsVersion}
        addMenuAnchor={addMenuAnchor}
        addMenuRef={addMenuRef}
        addMenuWidth={addMenuWidth}
        newAgentDraftWorkspaceId={newAgentDraftWorkspaceId}
        startingDraftThreadWorkspaceId={startingDraftThreadWorkspaceId}
        onSelectWorkspace={onSelectWorkspace}
        onConnectWorkspace={onConnectWorkspace}
        onAddAgent={onAddAgent}
        onAddWorktreeAgent={onAddWorktreeAgent}
        onAddCloneAgent={onAddCloneAgent}
        onResumeThreadById={onResumeThreadById}
        onToggleWorkspaceCollapse={onToggleWorkspaceCollapse}
        onSelectThread={onSelectThread}
        onSelectLocalCodexThread={onSelectLocalCodexThread}
        onShowThreadMenu={onShowThreadMenu}
        onShowWorkspaceMenu={onShowWorkspaceMenu}
        onShowWorktreeMenu={onShowWorktreeMenu}
        onShowCloneMenu={onShowCloneMenu}
        isWorkspaceFolderPinned={isWorkspaceFolderPinned}
        onToggleExpanded={onToggleExpanded}
        onLoadOlderThreads={onLoadOlderThreads}
        onToggleAddMenu={onToggleAddMenu}
      />
    );
  }

  const isCollapsed = workspace.settings.sidebarCollapsed;
  const isExpanded = expandedWorkspaces.has(workspace.id);
  const workspaceMatchesSearch = isWorkspaceMatch(workspace);
  const searchExpanded = isExpanded || isSearchActive;
  const {
    pinnedRows,
    unpinnedRows,
    totalRoots: totalThreadRoots,
  } = getThreadRows(
    threads,
    true,
    workspace.id,
    getPinTimestamp,
    pinnedThreadsVersion,
  );
  const nextCursor = threadListCursorByWorkspace[workspace.id] ?? null;
  const {
    visiblePinnedRows: filteredPinnedThreadRows,
    visibleUnpinnedRows: filteredThreadRows,
    displayRootCount: displayThreadRootCount,
  } = getVisibleThreadSections({
    pinnedRows,
    unpinnedRows,
    totalUnpinnedRoots: totalThreadRoots,
    workspaceName: workspace.name,
    query: normalizedQuery,
    isSearchActive,
  });
  const showThreadList =
    filteredPinnedThreadRows.length > 0 ||
    filteredThreadRows.length > 0 ||
    Boolean(nextCursor);
  const isLoadingThreads = threadListLoadingByWorkspace[workspace.id] ?? false;
  const showThreadLoader = isLoadingThreads && threads.length === 0;
  const isPaging = threadListPagingByWorkspace[workspace.id] ?? false;
  const clones = clonesBySource.get(workspace.id) ?? [];
  const visibleClones =
    isSearchActive && !workspaceMatchesSearch
      ? clones.filter((clone) => workspaceVisibleDuringSearchById.get(clone.id))
      : clones;
  const worktrees =
    isSearchActive && !workspaceMatchesSearch
      ? (worktreesByParent.get(workspace.id) ?? []).filter((worktree) =>
          workspaceVisibleDuringSearchById.get(worktree.id),
        )
      : (worktreesByParent.get(workspace.id) ?? []);
  const addMenuOpen = addMenuAnchor?.workspaceId === workspace.id;
  const isDraftNewAgent = newAgentDraftWorkspaceId === workspace.id;
  const isDraftRowActive =
    isDraftNewAgent &&
    workspace.id === activeWorkspaceId &&
    !activeThreadId;
  const draftStatusClass =
    startingDraftThreadWorkspaceId === workspace.id ? "processing" : "ready";

  return (
    <WorkspaceCard
      workspace={workspace}
      workspaceName={renderHighlightedName(workspace.name)}
      summary={
        displayThreadRootCount > 0
          ? `${displayThreadRootCount} ${t("sidebar.threadCountSuffix")}${
              threads[0] ? ` · ${t("sidebar.updatedAt")} ${getThreadTime(threads[0])}` : ""
            }`
          : t("sidebar.noThreads")
      }
      isActive={workspace.id === activeWorkspaceId}
      isCollapsed={isCollapsed}
      isPinned={isWorkspaceFolderPinned(workspace.id)}
      addMenuOpen={addMenuOpen}
      addMenuWidth={addMenuWidth}
      onAddAgent={onAddAgent}
      onShowWorkspaceMenu={onShowWorkspaceMenu}
      onToggleWorkspaceCollapse={onToggleWorkspaceCollapse}
      onConnectWorkspace={onConnectWorkspace}
      onToggleAddMenu={onToggleAddMenu}
    >
      {addMenuOpen && addMenuAnchor &&
        createPortal(
          <PopoverSurface
            className="workspace-add-menu"
            ref={addMenuRef}
            style={{
              top: addMenuAnchor.top,
              left: addMenuAnchor.left,
              width: addMenuAnchor.width,
            }}
          >
            <PopoverMenuItem
              className="workspace-add-option"
              onClick={(event) => {
                event.stopPropagation();
                onToggleAddMenu(null);
                onAddAgent(workspace);
              }}
              icon={<Plus aria-hidden />}
            >
              {t("sidebar.newAgent")}
            </PopoverMenuItem>
            <PopoverMenuItem
              className="workspace-add-option"
              onClick={(event) => {
                event.stopPropagation();
                onToggleAddMenu(null);
                onAddWorktreeAgent(workspace);
              }}
              icon={<GitBranch aria-hidden />}
            >
              {t("sidebar.newWorktreeAgent")}
            </PopoverMenuItem>
            <PopoverMenuItem
              className="workspace-add-option"
              onClick={(event) => {
                event.stopPropagation();
                onToggleAddMenu(null);
                onAddCloneAgent(workspace);
              }}
              icon={<Copy aria-hidden />}
            >
              {t("sidebar.newCloneAgent")}
            </PopoverMenuItem>
            <PopoverMenuItem
              className="workspace-add-option"
              onClick={(event) => {
                event.stopPropagation();
                onToggleAddMenu(null);
                onResumeThreadById(workspace);
              }}
              icon={<RotateCcw aria-hidden />}
            >
              {t("sidebar.resumeThreadById")}
            </PopoverMenuItem>
          </PopoverSurface>,
          document.body,
        )}
      {isDraftNewAgent && (
        <div
          className={`thread-row thread-row-draft${isDraftRowActive ? " active" : ""}`}
          onClick={() => onSelectWorkspace(workspace.id)}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelectWorkspace(workspace.id);
            }
          }}
        >
          <span className={`thread-status ${draftStatusClass}`} aria-hidden />
          <div className="thread-content">
            <div className="thread-headline">
              <span className="thread-name">{t("sidebar.draftNewAgent")}</span>
            </div>
          </div>
        </div>
      )}
      {visibleClones.length > 0 && (
        <WorktreeSection
          worktrees={visibleClones}
          deletingWorktreeIds={deletingWorktreeIds}
          threadsByWorkspace={threadsByWorkspace}
          threadStatusById={threadStatusById}
          threadListLoadingByWorkspace={threadListLoadingByWorkspace}
          threadListPagingByWorkspace={threadListPagingByWorkspace}
          threadListCursorByWorkspace={threadListCursorByWorkspace}
          expandedWorkspaces={expandedWorkspaces}
          parentCollapsed={isCollapsed}
          activeWorkspaceId={activeWorkspaceId}
          activeThreadId={activeThreadId}
          pendingUserInputKeys={pendingUserInputKeys}
          getThreadRows={getThreadRows}
          getThreadTime={getThreadTime}
          getThreadArgsBadge={getThreadArgsBadge}
          isThreadPinned={isThreadPinned}
          onToggleThreadPin={onToggleThreadPin}
          getPinTimestamp={getPinTimestamp}
          pinnedThreadsVersion={pinnedThreadsVersion}
          onConnectWorkspace={onConnectWorkspace}
          onToggleWorkspaceCollapse={onToggleWorkspaceCollapse}
          onSelectThread={onSelectThread}
          onShowThreadMenu={onShowThreadMenu}
          onShowWorktreeMenu={onShowCloneMenu}
          onToggleExpanded={onToggleExpanded}
          onLoadOlderThreads={onLoadOlderThreads}
          searchQuery={normalizedQuery}
          isSearchActive={isSearchActive}
          sectionLabel={t("sidebar.cloneAgents")}
          sectionIcon={<Copy className="worktree-header-icon" aria-hidden />}
          className="clone-section"
        />
      )}
      {worktrees.length > 0 && (
        <WorktreeSection
          worktrees={worktrees}
          deletingWorktreeIds={deletingWorktreeIds}
          threadsByWorkspace={threadsByWorkspace}
          threadStatusById={threadStatusById}
          threadListLoadingByWorkspace={threadListLoadingByWorkspace}
          threadListPagingByWorkspace={threadListPagingByWorkspace}
          threadListCursorByWorkspace={threadListCursorByWorkspace}
          expandedWorkspaces={expandedWorkspaces}
          parentCollapsed={isCollapsed}
          activeWorkspaceId={activeWorkspaceId}
          activeThreadId={activeThreadId}
          pendingUserInputKeys={pendingUserInputKeys}
          getThreadRows={getThreadRows}
          getThreadTime={getThreadTime}
          getThreadArgsBadge={getThreadArgsBadge}
          isThreadPinned={isThreadPinned}
          onToggleThreadPin={onToggleThreadPin}
          getPinTimestamp={getPinTimestamp}
          pinnedThreadsVersion={pinnedThreadsVersion}
          onConnectWorkspace={onConnectWorkspace}
          onToggleWorkspaceCollapse={onToggleWorkspaceCollapse}
          onSelectThread={onSelectThread}
          onShowThreadMenu={onShowThreadMenu}
          onShowWorktreeMenu={onShowWorktreeMenu}
          onToggleExpanded={onToggleExpanded}
          onLoadOlderThreads={onLoadOlderThreads}
          searchQuery={normalizedQuery}
          isSearchActive={isSearchActive}
        />
      )}
      {showThreadList && (
        <ThreadList
          workspaceId={workspace.id}
          pinnedRows={filteredPinnedThreadRows}
          unpinnedRows={filteredThreadRows}
          totalThreadRoots={displayThreadRootCount}
          isExpanded={searchExpanded}
          showExpandToggle={!isSearchActive}
          nextCursor={nextCursor}
          isPaging={isPaging}
          resetExpansionKey={isCollapsed}
          activeWorkspaceId={activeWorkspaceId}
          activeThreadId={activeThreadId}
          threadStatusById={threadStatusById}
          pendingUserInputKeys={pendingUserInputKeys}
          getThreadTime={getThreadTime}
          getThreadArgsBadge={getThreadArgsBadge}
          isThreadPinned={isThreadPinned}
          onToggleThreadPin={onToggleThreadPin}
          onToggleExpanded={onToggleExpanded}
          onLoadOlderThreads={onLoadOlderThreads}
          onSelectThread={onSelectThread}
          onShowThreadMenu={onShowThreadMenu}
        />
      )}
      {showThreadLoader && <ThreadLoading />}
    </WorkspaceCard>
  );
}

export function SidebarWorkspaceGroups({
  groups,
  hasWorkspaceGroups,
  collapsedGroups,
  ungroupedCollapseId,
  toggleGroupCollapse,
  ...entryProps
}: SidebarWorkspaceGroupsProps) {
  return groups.map((group) => {
    const showGroupHeader = Boolean(group.id) || hasWorkspaceGroups;
    const toggleId = group.id ?? (showGroupHeader ? ungroupedCollapseId : null);
    const isGroupCollapsed = Boolean(toggleId && collapsedGroups.has(toggleId));

    return (
      <WorkspaceGroup
        key={group.id ?? "ungrouped"}
        toggleId={toggleId}
        name={group.name}
        showHeader={showGroupHeader}
        isCollapsed={isGroupCollapsed}
        onToggleCollapse={toggleGroupCollapse}
      >
        {group.workspaces.map((workspace) => (
          <SidebarWorkspaceEntry
            key={workspace.id}
            workspace={workspace}
            allWorkspaceGroups={groups}
            {...entryProps}
          />
        ))}
      </WorkspaceGroup>
    );
  });
}
