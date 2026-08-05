import { useCallback } from "react";

import type { WorkspaceInfo, WorkspaceSettings } from "../../../types";

type AppTab = "home" | "projects" | "codex" | "git" | "log";

type UseSidebarLayoutActionsOptions = {
  openSettings: () => void;
  resetPullRequestSelection: () => void;
  clearDraftState: () => void;
  clearDraftStateIfDifferentWorkspace: (workspaceId: string) => void;
  selectHome: () => void;
  exitDiffView: () => void;
  selectWorkspace: (workspaceId: string) => void;
  setActiveThreadId: (threadId: string | null, workspaceId?: string) => void;
  activeWorkspaceId: string | null;
  activeThreadId: string | null;
  connectWorkspace: (workspace: WorkspaceInfo) => Promise<void>;
  isCompact: boolean;
  setActiveTab: (tab: AppTab) => void;
  workspacesById: Map<string, WorkspaceInfo>;
  updateWorkspaceSettings: (
    workspaceId: string,
    patch: Partial<WorkspaceSettings>,
  ) => void | Promise<unknown>;
  removeThread: (workspaceId: string, threadId: string) => void;
  clearDraftForThread: (threadId: string) => void;
  removeImagesForThread: (threadId: string) => void;
  refreshThread: (workspaceId: string, threadId: string) => void | Promise<unknown>;
  handleRenameThread: (workspaceId: string, threadId: string) => void;
  removeWorkspace: (workspaceId: string) => void | Promise<unknown>;
  removeWorktree: (workspaceId: string) => void | Promise<unknown>;
  loadOlderThreadsForWorkspace: (workspace: WorkspaceInfo) => void | Promise<unknown>;
  compactThreadListForWorkspace: (workspaceId: string) => void;
  listThreadsForWorkspace: (workspace: WorkspaceInfo) => void | Promise<unknown>;
};

export function useSidebarLayoutActions({
  openSettings,
  resetPullRequestSelection,
  clearDraftState,
  clearDraftStateIfDifferentWorkspace,
  selectHome,
  exitDiffView,
  selectWorkspace,
  setActiveThreadId,
  activeWorkspaceId,
  activeThreadId,
  connectWorkspace,
  isCompact,
  setActiveTab,
  workspacesById,
  updateWorkspaceSettings,
  removeThread,
  clearDraftForThread,
  removeImagesForThread,
  refreshThread,
  handleRenameThread,
  removeWorkspace,
  removeWorktree,
  loadOlderThreadsForWorkspace,
  compactThreadListForWorkspace,
  listThreadsForWorkspace,
}: UseSidebarLayoutActionsOptions) {
  const onOpenSettings = useCallback(() => {
    openSettings();
  }, [openSettings]);

  const onSelectHome = useCallback(() => {
    resetPullRequestSelection();
    clearDraftState();
    selectHome();
  }, [resetPullRequestSelection, clearDraftState, selectHome]);

  const onSelectWorkspace = useCallback(
    (workspaceId: string) => {
      exitDiffView();
      resetPullRequestSelection();
      clearDraftStateIfDifferentWorkspace(workspaceId);
      selectWorkspace(workspaceId);
      setActiveThreadId(null, workspaceId);
    },
    [
      exitDiffView,
      resetPullRequestSelection,
      clearDraftStateIfDifferentWorkspace,
      selectWorkspace,
      setActiveThreadId,
    ],
  );

  const onConnectWorkspace = useCallback(
    async (workspace: WorkspaceInfo) => {
      await connectWorkspace(workspace);
      if (isCompact) {
        setActiveTab("codex");
      }
    },
    [connectWorkspace, isCompact, setActiveTab],
  );

  const onToggleWorkspaceCollapse = useCallback(
    (workspaceId: string, collapsed: boolean) => {
      const target = workspacesById.get(workspaceId);
      if (!target) {
        return;
      }
      void updateWorkspaceSettings(workspaceId, {
        sidebarCollapsed: collapsed,
      });
      if (collapsed) {
        compactThreadListForWorkspace(workspaceId);
        workspacesById.forEach((workspace) => {
          if (
            workspace.parentId === workspaceId ||
            workspace.settings.cloneSourceWorkspaceId === workspaceId
          ) {
            compactThreadListForWorkspace(workspace.id);
          }
        });
      }
    },
    [compactThreadListForWorkspace, updateWorkspaceSettings, workspacesById],
  );

  const onSelectThread = useCallback(
    (workspaceId: string, threadId: string) => {
      if (workspaceId === activeWorkspaceId && threadId === activeThreadId) {
        if (isCompact) {
          setActiveTab("codex");
        }
        return;
      }
      exitDiffView();
      resetPullRequestSelection();
      clearDraftState();
      selectWorkspace(workspaceId);
      setActiveThreadId(threadId, workspaceId);
      if (isCompact) {
        setActiveTab("codex");
      }
    },
    [
      activeThreadId,
      activeWorkspaceId,
      clearDraftState,
      exitDiffView,
      isCompact,
      resetPullRequestSelection,
      selectWorkspace,
      setActiveTab,
      setActiveThreadId,
    ],
  );

  const onDeleteThread = useCallback(
    (workspaceId: string, threadId: string) => {
      removeThread(workspaceId, threadId);
      clearDraftForThread(threadId);
      removeImagesForThread(threadId);
    },
    [clearDraftForThread, removeImagesForThread, removeThread],
  );

  const onSyncThread = useCallback(
    (workspaceId: string, threadId: string) => {
      void refreshThread(workspaceId, threadId);
    },
    [refreshThread],
  );

  const onRenameThread = useCallback(
    (workspaceId: string, threadId: string) => {
      handleRenameThread(workspaceId, threadId);
    },
    [handleRenameThread],
  );

  const onDeleteWorkspace = useCallback(
    (workspaceId: string) => {
      void removeWorkspace(workspaceId);
    },
    [removeWorkspace],
  );

  const onDeleteWorktree = useCallback(
    (workspaceId: string) => {
      void removeWorktree(workspaceId);
    },
    [removeWorktree],
  );

  const onLoadOlderThreads = useCallback(
    (workspaceId: string) => {
      const workspace = workspacesById.get(workspaceId);
      if (!workspace) {
        return;
      }
      void loadOlderThreadsForWorkspace(workspace);
    },
    [loadOlderThreadsForWorkspace, workspacesById],
  );

  const onReloadWorkspaceThreads = useCallback(
    (workspaceId: string) => {
      const workspace = workspacesById.get(workspaceId);
      if (!workspace) {
        return;
      }
      void listThreadsForWorkspace(workspace);
    },
    [listThreadsForWorkspace, workspacesById],
  );

  return {
    onOpenSettings,
    onSelectHome,
    onSelectWorkspace,
    onConnectWorkspace,
    onToggleWorkspaceCollapse,
    onSelectThread,
    onDeleteThread,
    onSyncThread,
    onRenameThread,
    onDeleteWorkspace,
    onDeleteWorktree,
    onLoadOlderThreads,
    onReloadWorkspaceThreads,
  };
}
