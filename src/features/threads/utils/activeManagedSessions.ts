import type { ManagedSession } from "@/types";
import {
  cancelSessionTask,
  fetchManagedSessionsPage,
  scanManagedSessions,
} from "@services/tauri";

const ACTIVE_SESSION_CACHE_TTL_MS = 60_000;
const ACTIVE_SESSION_PAGE_SIZE = 200;
const SIDEBAR_VISIBLE_SUBAGENT_SOURCE_KINDS = new Set([
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
]);

type CacheEntry = {
  expiresAt: number;
  promise: Promise<ManagedSession[]>;
};

const cacheBySourceId = new Map<string, CacheEntry>();
let requestSequence = 0;

function cacheKey(sourceId: string | null): string {
  return sourceId?.trim() || "__all_active_sources__";
}

async function scanActiveManagedSessions(
  sourceId: string | null,
): Promise<ManagedSession[]> {
  requestSequence += 1;
  const requestId = `sidebar-active-${Date.now()}-${requestSequence}`;
  try {
    const summary = await scanManagedSessions({
      requestId,
      ...(sourceId ? { sourceIds: [sourceId] } : {}),
      includeArchived: false,
    });
    if (summary.cancelled) {
      return [];
    }
    const sessions: ManagedSession[] = [];
    let offset = 0;
    do {
      const page = await fetchManagedSessionsPage({
        requestId,
        offset,
        limit: ACTIVE_SESSION_PAGE_SIZE,
      });
      sessions.push(...page.items);
      if (page.nextOffset === null) {
        break;
      }
      offset = page.nextOffset;
    } while (offset < summary.totalSessions);
    return sessions.filter((session) => !session.isArchived);
  } finally {
    await cancelSessionTask(requestId).catch(() => undefined);
  }
}

export function listActiveManagedSessionsCached(
  sourceId: string | null,
): Promise<ManagedSession[]> {
  const key = cacheKey(sourceId);
  const now = Date.now();
  const cached = cacheBySourceId.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }
  const promise = scanActiveManagedSessions(sourceId).catch((error) => {
    cacheBySourceId.delete(key);
    throw error;
  });
  cacheBySourceId.set(key, {
    expiresAt: now + ACTIVE_SESSION_CACHE_TTL_MS,
    promise,
  });
  return promise;
}

export function clearActiveManagedSessionsCache(sourceId?: string | null): void {
  if (sourceId === undefined) {
    cacheBySourceId.clear();
    return;
  }
  cacheBySourceId.delete(cacheKey(sourceId));
}

export function isSidebarManagedSessionCandidate(
  session: ManagedSession,
): boolean {
  return (
    !session.isArchived &&
    session.fileStatus === "mapped" &&
    session.fileConfidence === "exact" &&
    (!session.isSubagent ||
      SIDEBAR_VISIBLE_SUBAGENT_SOURCE_KINDS.has(session.sourceKind ?? ""))
  );
}

export function managedSessionToThreadRecord(
  session: ManagedSession,
): Record<string, unknown> {
  const source = session.parentThreadId
    ? {
        subAgent: {
          thread_spawn: {
            parent_thread_id: session.parentThreadId,
            ...(session.subagentNickname
              ? { agent_nickname: session.subagentNickname }
              : {}),
            ...(session.subagentRole ? { agent_role: session.subagentRole } : {}),
          },
        },
      }
    : session.sourceKind;
  return {
    id: session.threadId,
    title: session.title,
    preview: session.preview ?? "",
    cwd: session.cwd ?? "",
    createdAt: session.createdAt ?? 0,
    updatedAt: session.updatedAt ?? session.createdAt ?? 0,
    parentThreadId: session.parentThreadId,
    source,
  };
}
