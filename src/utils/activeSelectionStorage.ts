export const STORAGE_KEY_ACTIVE_WORKSPACE = "codexmonitor.activeWorkspaceId";
export const STORAGE_KEY_ACTIVE_THREADS = "codexmonitor.activeThreadIdsByWorkspace";

export type ActiveThreadSelectionMap = Record<string, string | null>;

function readStorageValue(key: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorageValue(key: string, value: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Best-effort UI state persistence.
  }
}

export function loadActiveWorkspaceId(): string | null {
  const raw = readStorageValue(STORAGE_KEY_ACTIVE_WORKSPACE);
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" && parsed.trim() ? parsed.trim() : null;
  } catch {
    return raw.trim() || null;
  }
}

export function saveActiveWorkspaceId(workspaceId: string | null): void {
  writeStorageValue(
    STORAGE_KEY_ACTIVE_WORKSPACE,
    JSON.stringify(workspaceId?.trim() || null),
  );
}

export function loadActiveThreadSelections(): ActiveThreadSelectionMap {
  const raw = readStorageValue(STORAGE_KEY_ACTIVE_THREADS);
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const result: ActiveThreadSelectionMap = {};
    Object.entries(parsed).forEach(([workspaceId, threadId]) => {
      if (!workspaceId) {
        return;
      }
      if (threadId === null) {
        result[workspaceId] = null;
        return;
      }
      if (typeof threadId === "string" && threadId.trim()) {
        result[workspaceId] = threadId.trim();
      }
    });
    return result;
  } catch {
    return {};
  }
}

export function saveActiveThreadSelections(
  selections: ActiveThreadSelectionMap,
): void {
  const normalized: ActiveThreadSelectionMap = {};
  Object.entries(selections).forEach(([workspaceId, threadId]) => {
    if (!workspaceId) {
      return;
    }
    if (threadId === null) {
      normalized[workspaceId] = null;
      return;
    }
    if (typeof threadId === "string" && threadId.trim()) {
      normalized[workspaceId] = threadId.trim();
    }
  });
  writeStorageValue(STORAGE_KEY_ACTIVE_THREADS, JSON.stringify(normalized));
}
