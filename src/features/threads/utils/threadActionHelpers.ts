import type {
  ConversationItem,
  ThreadListSortKey,
  ThreadSummary,
  WorkspaceInfo,
} from "@/types";
import {
  buildItemsFromThread,
  getThreadCreatedTimestamp,
  getThreadTimestamp,
  isReviewingFromThread,
  mergeThreadItems,
} from "@utils/threadItems";
import { getThreadDisplayTitle } from "@threads/utils/threadSummary";
import { insertThreadSummaryBySort } from "@threads/utils/threadSummaryOrder";
import { asString, normalizeRootPath } from "./threadNormalize";
import { getLatestTerminalTurnState, getResumedTurnState } from "./threadRpc";

function isWithinWorkspaceRoot(path: string, workspaceRoot: string) {
  if (!path || !workspaceRoot) {
    return false;
  }
  return (
    path === workspaceRoot ||
    (path.length > workspaceRoot.length &&
      path.startsWith(workspaceRoot) &&
      path.charCodeAt(workspaceRoot.length) === 47)
  );
}

export type WorkspacePathLookup = {
  workspaceIdsByPath: Record<string, string[]>;
  workspacePathsSorted: string[];
};

type ThreadRecord = Record<string, unknown>;
type ThreadStatusLookup = Record<
  string,
  { isProcessing?: boolean; processingStartedAt?: number | null } | undefined
>;

export type ResumeHydrationPlan = {
  keepLocalProcessing: boolean;
  lastMessageText: string | null;
  lastMessageTimestamp: number | null;
  mergedItems: ConversationItem[];
  processingTimestamp: number;
  resumedActiveTurnId: string | null;
  shouldHydrate: boolean;
  shouldMarkProcessing: boolean;
  terminalTurnId: string | null;
  terminalTurnStatus: "completed" | "interrupted" | "failed" | null;
  threadName: string | null;
  reviewing: boolean;
};

export type ThreadPreviewUpdate = {
  threadId: string;
  text: string;
  timestamp: number;
};

export type WorkspaceThreadListState = {
  didChangeActivity: boolean;
  nextActivityByThread: Record<string, number>;
  previewUpdates: ThreadPreviewUpdate[];
  summaries: ThreadSummary[];
  uniqueThreads: ThreadRecord[];
};

function isOptimisticLocalItem(item: ConversationItem) {
  return item.id.startsWith("local-user-");
}

function getResumeToolReconciliationKey(item: ConversationItem) {
  if (item.kind !== "tool" || !item.turnId) {
    return null;
  }
  return JSON.stringify([
    item.turnId,
    item.toolType,
    item.title.trim(),
    item.detail.trim(),
  ]);
}

function areEquivalentResumeItems(
  remote: ConversationItem,
  local: ConversationItem,
) {
  if (remote.kind !== local.kind) {
    return false;
  }
  if (remote.kind === "message" && local.kind === "message") {
    return (
      remote.role === local.role &&
      remote.text.trim() === local.text.trim() &&
      (!remote.phase || !local.phase || remote.phase === local.phase) &&
      JSON.stringify(remote.images ?? []) === JSON.stringify(local.images ?? []) &&
      JSON.stringify(remote.attachments ?? []) ===
        JSON.stringify(local.attachments ?? [])
    );
  }
  if (remote.kind === "tool" && local.kind === "tool") {
    return getResumeToolReconciliationKey(remote) === getResumeToolReconciliationKey(local);
  }
  if (remote.kind === "reasoning" && local.kind === "reasoning") {
    return (
      remote.summary.trim() === local.summary.trim() &&
      remote.content.trim() === local.content.trim()
    );
  }
  if (remote.kind === "diff" && local.kind === "diff") {
    return remote.title.trim() === local.title.trim() && remote.diff === local.diff;
  }
  if (remote.kind === "review" && local.kind === "review") {
    return remote.state === local.state && remote.text.trim() === local.text.trim();
  }
  return false;
}

function selectResumeMergeCandidates({
  localActiveTurnId,
  localItems,
  localStatus,
  remoteItems,
  resumedActiveTurnId,
  remoteTurnIds,
}: {
  localActiveTurnId: string | null;
  localItems: ConversationItem[];
  localStatus: { isProcessing?: boolean } | undefined;
  remoteItems: ConversationItem[];
  resumedActiveTurnId: string | null;
  remoteTurnIds: ReadonlySet<string>;
}) {
  const remoteItemIds = new Set(remoteItems.map((item) => item.id));
  const hasExactOverlap = localItems.some((item) => remoteItemIds.has(item.id));
  const preserveActiveTurn = Boolean(
    localActiveTurnId &&
      (localStatus?.isProcessing || resumedActiveTurnId === localActiveTurnId),
  );
  const remoteToolsByKey = new Map<string, ConversationItem[]>();
  remoteItems.forEach((item) => {
    const key = getResumeToolReconciliationKey(item);
    if (!key) {
      return;
    }
    const matches = remoteToolsByKey.get(key) ?? [];
    matches.push(item);
    remoteToolsByKey.set(key, matches);
  });
  const claimedRemoteToolIds = new Set<string>();

  return localItems.flatMap((item) => {
    if (remoteItemIds.has(item.id)) {
      claimedRemoteToolIds.add(item.id);
      return [item];
    }
    const toolKey = getResumeToolReconciliationKey(item);
    const matchingRemoteTool = toolKey
      ? remoteToolsByKey
          .get(toolKey)
          ?.find((remote) => !claimedRemoteToolIds.has(remote.id))
      : undefined;
    if (matchingRemoteTool) {
      claimedRemoteToolIds.add(matchingRemoteTool.id);
      return [
        {
          ...item,
          id: matchingRemoteTool.id,
          turnId: matchingRemoteTool.turnId ?? item.turnId,
        },
      ];
    }
    if (hasExactOverlap || isOptimisticLocalItem(item)) {
      return [item];
    }
    if (item.turnId && !remoteTurnIds.has(item.turnId)) {
      return [item];
    }
    return preserveActiveTurn &&
      (!item.turnId || item.turnId === localActiveTurnId)
      ? [item]
      : [];
  });
}

function mergeResumeItemsByTurn(
  remoteItems: ConversationItem[],
  localItems: ConversationItem[],
) {
  if (remoteItems.length === 0 || localItems.length === 0) {
    return remoteItems.length > 0 ? remoteItems : localItems;
  }
  const localItemsByTurn = new Map<string, ConversationItem[]>();
  localItems.forEach((item) => {
    if (!item.turnId) {
      return;
    }
    const turnItems = localItemsByTurn.get(item.turnId) ?? [];
    turnItems.push(item);
    localItemsByTurn.set(item.turnId, turnItems);
  });
  const consumedLocalIds = new Set<string>();
  const consumedTurnIds = new Set<string>();
  const merged: ConversationItem[] = [];

  for (let index = 0; index < remoteItems.length; ) {
    const turnId = remoteItems[index].turnId;
    if (!turnId) {
      const remoteItem = remoteItems[index];
      const matchingLocal = localItems.find((item) => item.id === remoteItem.id);
      merged.push(
        ...(matchingLocal
          ? mergeThreadItems([remoteItem], [matchingLocal])
          : [remoteItem]),
      );
      if (matchingLocal) {
        consumedLocalIds.add(matchingLocal.id);
      }
      index += 1;
      continue;
    }

    const remoteTurnItems: ConversationItem[] = [];
    while (index < remoteItems.length && remoteItems[index].turnId === turnId) {
      remoteTurnItems.push(remoteItems[index]);
      index += 1;
    }
    const localTurnItems = localItemsByTurn.get(turnId) ?? [];
    localTurnItems.forEach((item) => consumedLocalIds.add(item.id));
    consumedTurnIds.add(turnId);
    const localTurnItemIds = new Set(localTurnItems.map((item) => item.id));
    const localIsEnrichedSuperset =
      localTurnItems.length > remoteTurnItems.length &&
      remoteTurnItems.every((item) => localTurnItemIds.has(item.id));
    const consumedTurnLocalIndexes = new Set<number>();
    const remoteLocalIndexes = remoteTurnItems.map((remoteItem) => {
      const exactIndex = localTurnItems.findIndex(
        (localItem, localIndex) =>
          !consumedTurnLocalIndexes.has(localIndex) && localItem.id === remoteItem.id,
      );
      const equivalentIndex =
        exactIndex >= 0
          ? exactIndex
          : localTurnItems.findIndex(
              (localItem, localIndex) =>
                !consumedTurnLocalIndexes.has(localIndex) &&
                areEquivalentResumeItems(remoteItem, localItem),
            );
      if (equivalentIndex >= 0) {
        consumedTurnLocalIndexes.add(equivalentIndex);
      }
      return equivalentIndex;
    });
    const mergeRemoteItem = (remoteItem: ConversationItem, localIndex: number) => {
      if (localIndex < 0) {
        return remoteItem;
      }
      const localItem = localTurnItems[localIndex];
      return mergeThreadItems(
        [remoteItem],
        [{ ...localItem, id: remoteItem.id }],
      )[0];
    };
    if (localIsEnrichedSuperset) {
      const remoteIndexByLocalIndex = new Map(
        remoteLocalIndexes.map((localIndex, remoteIndex) => [localIndex, remoteIndex]),
      );
      const mergedTurnItems = localTurnItems.flatMap((localItem, localIndex) => {
        const remoteIndex = remoteIndexByLocalIndex.get(localIndex);
        return remoteIndex === undefined
          ? [localItem]
          : [mergeRemoteItem(remoteTurnItems[remoteIndex], localIndex)];
      });
      remoteTurnItems.forEach((remoteItem, remoteIndex) => {
        if (remoteLocalIndexes[remoteIndex] < 0) {
          mergedTurnItems.push(remoteItem);
        }
      });
      merged.push(...mergedTurnItems);
    } else {
      merged.push(
        ...remoteTurnItems.map((remoteItem, remoteIndex) =>
          mergeRemoteItem(remoteItem, remoteLocalIndexes[remoteIndex]),
        ),
      );
      localTurnItems.forEach((localItem, localIndex) => {
        if (!consumedTurnLocalIndexes.has(localIndex)) {
          merged.push(localItem);
        }
      });
    }
  }

  localItems.forEach((item) => {
    if (
      !consumedLocalIds.has(item.id) &&
      (!item.turnId || !consumedTurnIds.has(item.turnId))
    ) {
      merged.push(item);
    }
  });
  return merged;
}

export function buildWorkspacePathLookup(
  workspaces: WorkspaceInfo[],
): WorkspacePathLookup {
  const workspaceIdsByPath: Record<string, string[]> = {};
  const workspacePathsSorted: string[] = [];
  workspaces.forEach((workspace) => {
    const workspacePath = normalizeRootPath(workspace.path);
    if (!workspacePath) {
      return;
    }
    if (!workspaceIdsByPath[workspacePath]) {
      workspaceIdsByPath[workspacePath] = [];
      workspacePathsSorted.push(workspacePath);
    }
    workspaceIdsByPath[workspacePath].push(workspace.id);
  });
  workspacePathsSorted.sort((a, b) => b.length - a.length);
  return { workspaceIdsByPath, workspacePathsSorted };
}

export function resolveWorkspaceIdForThreadPath(
  path: string,
  lookup: WorkspacePathLookup,
  allowedWorkspaceIds?: Set<string>,
) {
  const normalizedPath = normalizeRootPath(path);
  if (!normalizedPath) {
    return null;
  }
  const matchedWorkspacePath = lookup.workspacePathsSorted.find((workspacePath) =>
    isWithinWorkspaceRoot(normalizedPath, workspacePath),
  );
  if (!matchedWorkspacePath) {
    return null;
  }
  const workspaceIds = lookup.workspaceIdsByPath[matchedWorkspacePath] ?? [];
  if (!allowedWorkspaceIds) {
    return workspaceIds[0] ?? null;
  }
  return (
    workspaceIds.find((workspaceId) => allowedWorkspaceIds.has(workspaceId)) ??
    null
  );
}

export function getThreadListNextCursor(result: Record<string, unknown>) {
  if (typeof result.nextCursor === "string") {
    return result.nextCursor;
  }
  if (typeof result.next_cursor === "string") {
    return result.next_cursor;
  }
  return null;
}

export function buildResumeHydrationPlan({
  getCustomName,
  localActiveTurnId,
  localItems,
  localStatus,
  replaceLocal,
  thread,
  threadId,
  workspaceId,
}: {
  getCustomName: (workspaceId: string, threadId: string) => string | undefined;
  localActiveTurnId: string | null;
  localItems: ConversationItem[];
  localStatus: { isProcessing?: boolean } | undefined;
  replaceLocal: boolean;
  thread: ThreadRecord;
  threadId: string;
  workspaceId: string;
}): ResumeHydrationPlan {
  const items = buildItemsFromThread(thread);
  const resumedTurnState = getResumedTurnState(thread);
  const terminalTurnState = getLatestTerminalTurnState(thread);
  const keepLocalProcessing =
    (localStatus?.isProcessing ?? false) &&
    !resumedTurnState.activeTurnId &&
    !resumedTurnState.confidentNoActiveTurn;
  const resumedActiveTurnId = keepLocalProcessing
    ? localActiveTurnId
    : resumedTurnState.activeTurnId;
  const shouldMarkProcessing = keepLocalProcessing || Boolean(resumedActiveTurnId);
  const processingTimestamp = resumedTurnState.activeTurnStartedAtMs ?? Date.now();
  const remoteTurnIds = new Set(
    (Array.isArray(thread.turns) ? thread.turns : [])
      .map((turn) => asString((turn as ThreadRecord).id).trim())
      .filter(Boolean),
  );
  const mergeCandidates = selectResumeMergeCandidates({
    localActiveTurnId,
    localItems,
    localStatus,
    remoteItems: items,
    resumedActiveTurnId,
    remoteTurnIds,
  });
  const mergedItems =
    replaceLocal
      ? items
      : items.length > 0
        ? mergeCandidates.length > 0
          ? mergeResumeItemsByTurn(items, mergeCandidates)
          : items
        : localItems;
  const preview = asString(thread.preview ?? "");
  const customName = getCustomName(workspaceId, threadId);
  const threadName = !customName ? getThreadDisplayTitle(thread) : null;
  const lastAgentMessage = [...mergedItems]
    .reverse()
    .find(
      (item) => item.kind === "message" && item.role === "assistant",
    ) as ConversationItem | undefined;
  const lastMessageText =
    lastAgentMessage && lastAgentMessage.kind === "message"
      ? lastAgentMessage.text
      : preview;

  return {
    keepLocalProcessing,
    lastMessageText: lastMessageText || null,
    lastMessageTimestamp: lastMessageText ? getThreadTimestamp(thread) : null,
    mergedItems,
    processingTimestamp,
    resumedActiveTurnId,
    reviewing: isReviewingFromThread(thread),
    shouldHydrate: true,
    shouldMarkProcessing,
    terminalTurnId: terminalTurnState?.turnId ?? null,
    terminalTurnStatus: terminalTurnState?.status ?? null,
    threadName,
  };
}

export function buildWorkspaceThreadListState({
  activeThreadId,
  activityByThread,
  buildThreadSummary,
  existingThreadIds,
  matchingThreads,
  requestedSortKey,
  threadListTargetCount,
  threadParentById,
  threadStatusById,
  workspaceId,
}: {
  activeThreadId: string | null | undefined;
  activityByThread: Record<string, number>;
  buildThreadSummary: (
    workspaceId: string,
    thread: ThreadRecord,
    fallbackIndex: number,
  ) => ThreadSummary | null;
  existingThreadIds: string[];
  matchingThreads: ThreadRecord[];
  requestedSortKey: ThreadListSortKey;
  threadListTargetCount: number;
  threadParentById: Record<string, string | undefined>;
  threadStatusById: ThreadStatusLookup;
  workspaceId: string;
}): WorkspaceThreadListState {
  const uniqueById = new Map<string, ThreadRecord>();
  matchingThreads.forEach((thread) => {
    const id = String(thread.id ?? "");
    if (id && !uniqueById.has(id)) {
      uniqueById.set(id, thread);
    }
  });

  const uniqueThreads = Array.from(uniqueById.values());
  const nextActivityByThread = { ...activityByThread };
  let didChangeActivity = false;
  uniqueThreads.forEach((thread) => {
    const threadId = String(thread.id ?? "");
    if (!threadId) {
      return;
    }
    const timestamp = getThreadTimestamp(thread);
    if (timestamp > (nextActivityByThread[threadId] ?? 0)) {
      nextActivityByThread[threadId] = timestamp;
      didChangeActivity = true;
    }
  });
  const getEffectiveActivity = (threadId: string, timestamp: number) =>
    Math.max(
      nextActivityByThread[threadId] ?? 0,
      threadStatusById[threadId]?.processingStartedAt ?? 0,
      timestamp,
    );

  if (requestedSortKey === "updated_at") {
    uniqueThreads.sort((a, b) => {
      const aId = String(a.id ?? "");
      const bId = String(b.id ?? "");
      const aCreated = getThreadTimestamp(a);
      const bCreated = getThreadTimestamp(b);
      const aActivity = getEffectiveActivity(aId, aCreated);
      const bActivity = getEffectiveActivity(bId, bCreated);
      return bActivity - aActivity;
    });
  } else {
    uniqueThreads.sort((a, b) => {
      const delta = getThreadCreatedTimestamp(b) - getThreadCreatedTimestamp(a);
      if (delta !== 0) {
        return delta;
      }
      const aId = String(a.id ?? "");
      const bId = String(b.id ?? "");
      return aId.localeCompare(bId);
    });
  }

  const summaryById = new Map<string, ThreadSummary>();
  uniqueThreads.forEach((thread, index) => {
    const summary = buildThreadSummary(workspaceId, thread, index);
    if (!summary) {
      return;
    }
    const effectiveUpdatedAt = getEffectiveActivity(summary.id, summary.updatedAt);
    summaryById.set(
      summary.id,
      effectiveUpdatedAt > summary.updatedAt
        ? { ...summary, updatedAt: effectiveUpdatedAt }
        : summary,
    );
  });

  const presentThreadIds = new Set(
    uniqueThreads.map((thread) => String(thread.id ?? "")).filter(Boolean),
  );
  const selectedRootIds = new Set<string>();
  const firstPageThreads = uniqueThreads.filter((thread) => {
    const threadId = String(thread.id ?? "");
    let rootId = threadId;
    const visited = new Set<string>([threadId]);
    let parentId = threadParentById[threadId];
    while (parentId && presentThreadIds.has(parentId) && !visited.has(parentId)) {
      visited.add(parentId);
      rootId = parentId;
      parentId = threadParentById[parentId];
    }
    if (selectedRootIds.has(rootId)) {
      return true;
    }
    if (selectedRootIds.size >= threadListTargetCount) {
      return false;
    }
    selectedRootIds.add(rootId);
    return true;
  });

  const summaries = firstPageThreads
    .map((thread) => summaryById.get(String(thread.id ?? "")) ?? null)
    .filter((entry): entry is ThreadSummary => Boolean(entry));
  const includedIds = new Set(summaries.map((thread) => thread.id));
  const appendFreshAnchor = (threadId: string | null | undefined) => {
    if (!threadId || includedIds.has(threadId)) {
      return;
    }
    const summary = summaryById.get(threadId);
    if (!summary) {
      return;
    }
    insertThreadSummaryBySort(summaries, summary, requestedSortKey);
    includedIds.add(threadId);
  };

  appendFreshAnchor(activeThreadId);

  const workspaceThreadIds = new Set<string>([
    ...Array.from(summaryById.keys()),
    ...existingThreadIds,
  ]);
  if (activeThreadId) {
    workspaceThreadIds.add(activeThreadId);
  }
  workspaceThreadIds.forEach((threadId) => {
    if (threadStatusById[threadId]?.isProcessing) {
      appendFreshAnchor(threadId);
    }
  });

  const seedThreadIds = [...includedIds];
  seedThreadIds.forEach((threadId) => {
    const visited = new Set<string>([threadId]);
    let parentId = threadParentById[threadId];
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      appendFreshAnchor(parentId);
      parentId = threadParentById[parentId];
    }
  });

  const previewUpdates = uniqueThreads
    .filter((thread) => includedIds.has(String(thread.id ?? "")))
    .map((thread) => {
      const threadId = String(thread.id ?? "");
      const text = asString(thread.preview ?? "").trim();
      if (!threadId || !text) {
        return null;
      }
      return {
        threadId,
        text,
        timestamp: getThreadTimestamp(thread),
      };
    })
    .filter((entry): entry is ThreadPreviewUpdate => Boolean(entry));

  return {
    didChangeActivity,
    nextActivityByThread,
    previewUpdates,
    summaries,
    uniqueThreads,
  };
}
