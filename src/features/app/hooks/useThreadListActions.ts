import { useCallback } from "react";
import type { ThreadListSortKey, WorkspaceInfo } from "../../../types";
import { LOCAL_CODEX_WORKSPACE_ID } from "@/features/workspaces/domain/localCodexWorkspace";
import type { ThreadListRefreshReason } from "@threads/types";

type ListThreadsOptions = {
  sortKey?: ThreadListSortKey;
  refreshReason?: ThreadListRefreshReason;
};

type UseThreadListActionsOptions = {
  threadListSortKey: ThreadListSortKey;
  setThreadListSortKey: (sortKey: ThreadListSortKey) => void;
  workspaces: WorkspaceInfo[];
  refreshWorkspaces: () => Promise<WorkspaceInfo[] | undefined>;
  connectWorkspace: (workspace: WorkspaceInfo) => Promise<void>;
  listThreadsForWorkspaces: (
    workspaces: WorkspaceInfo[],
    options?: ListThreadsOptions,
  ) => void | Promise<void>;
  resetWorkspaceThreads: (workspaceId: string) => void;
};

export function useThreadListActions({
  threadListSortKey,
  setThreadListSortKey,
  workspaces,
  refreshWorkspaces,
  connectWorkspace,
  listThreadsForWorkspaces,
  resetWorkspaceThreads,
}: UseThreadListActionsOptions) {
  const handleSetThreadListSortKey = useCallback(
    (nextSortKey: ThreadListSortKey) => {
      if (nextSortKey === threadListSortKey) {
        return;
      }
      setThreadListSortKey(nextSortKey);
      const connectedWorkspaces = workspaces;
      if (connectedWorkspaces.length > 0) {
        void listThreadsForWorkspaces(connectedWorkspaces, {
          sortKey: nextSortKey,
          refreshReason: "sort_change",
        });
      }
    },
    [threadListSortKey, setThreadListSortKey, workspaces, listThreadsForWorkspaces],
  );

  const handleRefreshAllWorkspaceThreads = useCallback(async () => {
    const refreshed = await refreshWorkspaces();
    const localCodexWorkspace = workspaces.find(
      (workspace) => workspace.id === LOCAL_CODEX_WORKSPACE_ID,
    );
    const source =
      refreshed && localCodexWorkspace
        ? [...refreshed, localCodexWorkspace]
        : refreshed ?? workspaces;
    const connectedWorkspaces: WorkspaceInfo[] = [];
    for (const workspace of source) {
      if (workspace.connected || workspace.id === LOCAL_CODEX_WORKSPACE_ID) {
        connectedWorkspaces.push(workspace);
        continue;
      }
      try {
        await connectWorkspace(workspace);
        connectedWorkspaces.push({ ...workspace, connected: true });
      } catch {
        connectedWorkspaces.push(workspace);
      }
    }
    connectedWorkspaces.forEach((workspace) => {
      resetWorkspaceThreads(workspace.id);
    });
    if (connectedWorkspaces.length > 0) {
      await listThreadsForWorkspaces(connectedWorkspaces, {
        refreshReason: "manual_refresh",
      });
    }
  }, [
    refreshWorkspaces,
    workspaces,
    connectWorkspace,
    resetWorkspaceThreads,
    listThreadsForWorkspaces,
  ]);

  return {
    handleSetThreadListSortKey,
    handleRefreshAllWorkspaceThreads,
  };
}
