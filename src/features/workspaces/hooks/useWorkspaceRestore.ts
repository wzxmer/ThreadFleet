import { useEffect, useRef, useState } from "react";
import type { WorkspaceInfo } from "../../../types";
import { isLocalCodexWorkspaceId } from "@/features/workspaces/domain/localCodexWorkspace";
import type { ThreadListRefreshReason } from "@threads/types";

const INITIAL_THREAD_LIST_FAST_MAX_PAGES = 1;
const INITIAL_WORKSPACE_CONNECT_CONCURRENCY = 3;

type WorkspaceRestoreOptions = {
  workspaces: WorkspaceInfo[];
  hasLoaded: boolean;
  connectWorkspace: (workspace: WorkspaceInfo) => Promise<void>;
  listThreadsForWorkspaces: (
    workspaces: WorkspaceInfo[],
    options?: {
      preserveState?: boolean;
      maxPages?: number;
      refreshReason?: ThreadListRefreshReason;
      knownWorkspaces?: WorkspaceInfo[];
    },
  ) => Promise<void>;
};

async function connectPendingWorkspaces(
  pending: WorkspaceInfo[],
  connectWorkspace: (workspace: WorkspaceInfo) => Promise<void>,
) {
  const connectedTargetsByIndex: Array<WorkspaceInfo | null> = Array.from({
    length: pending.length,
  }, () => null);
  let nextIndex = 0;
  const workerCount = Math.min(INITIAL_WORKSPACE_CONNECT_CONCURRENCY, pending.length);

  async function connectNext() {
    while (nextIndex < pending.length) {
      const index = nextIndex;
      nextIndex += 1;
      const workspace = pending[index];
      const wasConnected = workspace.connected;
      const isLocalCodexWorkspace = isLocalCodexWorkspaceId(workspace.id);
      try {
        if (!wasConnected && !isLocalCodexWorkspace) {
          await connectWorkspace(workspace);
        }
        connectedTargetsByIndex[index] = {
          ...workspace,
          connected: true,
        };
      } catch {
        // Silent: connection errors show in debug panel.
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, connectNext));
  return connectedTargetsByIndex.filter(
    (workspace): workspace is WorkspaceInfo => workspace !== null,
  );
}

export function useWorkspaceRestore({
  workspaces,
  hasLoaded,
  connectWorkspace,
  listThreadsForWorkspaces,
}: WorkspaceRestoreOptions) {
  const restoredWorkspaces = useRef(new Set<string>());
  const pendingRestoreBatches = useRef(0);
  const [initialRestoreComplete, setInitialRestoreComplete] = useState(false);

  useEffect(() => {
    if (!hasLoaded) {
      return;
    }
    const pending = workspaces.filter(
      (workspace) => !restoredWorkspaces.current.has(workspace.id),
    );
    if (pending.length === 0) {
      if (pendingRestoreBatches.current === 0) {
        setInitialRestoreComplete(true);
      }
      return;
    }
    pendingRestoreBatches.current += 1;
    pending.forEach((workspace) => {
      restoredWorkspaces.current.add(workspace.id);
    });
    void (async () => {
      const connectedTargets = await connectPendingWorkspaces(
        pending,
        connectWorkspace,
      );
      try {
        if (connectedTargets.length > 0) {
          await listThreadsForWorkspaces(connectedTargets, {
            maxPages: INITIAL_THREAD_LIST_FAST_MAX_PAGES,
            refreshReason: "initial_restore",
            knownWorkspaces: workspaces,
          });
        }
      } finally {
        pendingRestoreBatches.current -= 1;
        if (pendingRestoreBatches.current === 0) {
          setInitialRestoreComplete(true);
        }
      }
    })();
  }, [connectWorkspace, hasLoaded, listThreadsForWorkspaces, workspaces]);

  return initialRestoreComplete;
}
