import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalUsageSnapshot } from "../../../types";
import { localUsageSnapshot } from "../../../services/tauri";

type LocalUsageState = {
  snapshot: LocalUsageSnapshot | null;
  isLoading: boolean;
  error: string | null;
};

const emptyState: LocalUsageState = {
  snapshot: null,
  isLoading: false,
  error: null,
};

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 0;
const AGGREGATE_USAGE_CACHE_KEY = "__all__";
const PERSISTENT_USAGE_CACHE_PREFIX = "codex-monitor:local-usage:v1:";
const localUsageCache = new Map<string, LocalUsageSnapshot>();

function usageCacheKey(workspacePath: string | null) {
  return workspacePath ?? AGGREGATE_USAGE_CACHE_KEY;
}

function persistentUsageCacheKey(workspacePath: string | null) {
  return `${PERSISTENT_USAGE_CACHE_PREFIX}${usageCacheKey(workspacePath)}`;
}

function readPersistentUsageCache(workspacePath: string | null) {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(persistentUsageCacheKey(workspacePath));
    return raw ? (JSON.parse(raw) as LocalUsageSnapshot) : null;
  } catch {
    return null;
  }
}

function writePersistentUsageCache(
  workspacePath: string | null,
  snapshot: LocalUsageSnapshot,
) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      persistentUsageCacheKey(workspacePath),
      JSON.stringify(snapshot),
    );
  } catch {
    // Local storage can be unavailable or quota-limited. In-memory cache still works.
  }
}

function readUsageCache(workspacePath: string | null) {
  const cacheKey = usageCacheKey(workspacePath);
  const memorySnapshot = localUsageCache.get(cacheKey);
  if (memorySnapshot) {
    return memorySnapshot;
  }
  const persistentSnapshot = readPersistentUsageCache(workspacePath);
  if (persistentSnapshot) {
    localUsageCache.set(cacheKey, persistentSnapshot);
  }
  return persistentSnapshot;
}

export function useLocalUsage(
  enabled: boolean,
  workspacePath: string | null,
  options?: {
    initialDelayMs?: number;
  },
) {
  const [state, setState] = useState<LocalUsageState>(() => ({
    ...emptyState,
    snapshot: readUsageCache(workspacePath),
  }));
  const requestIdRef = useRef(0);
  const enabledRef = useRef(enabled);
  const workspaceRef = useRef(workspacePath);
  const initialDelayMs = options?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;

  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled) {
      setState((prev) => ({ ...prev, isLoading: false }));
    }
  }, [enabled]);

  useEffect(() => {
    workspaceRef.current = workspacePath;
    const cachedSnapshot = readUsageCache(workspacePath);
    setState((prev) => ({
      ...prev,
      snapshot: cachedSnapshot,
      error: null,
    }));
  }, [workspacePath]);

  const refresh = useCallback(() => {
    if (!enabledRef.current) {
      return Promise.resolve();
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const requestWorkspacePath = workspaceRef.current;
    const cacheKey = usageCacheKey(requestWorkspacePath);
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    return localUsageSnapshot(30, requestWorkspacePath ?? undefined)
      .then((snapshot) => {
        if (requestIdRef.current !== requestId || !enabledRef.current) {
          return;
        }
        localUsageCache.set(cacheKey, snapshot);
        writePersistentUsageCache(requestWorkspacePath, snapshot);
        setState({ snapshot, isLoading: false, error: null });
      })
      .catch((err) => {
        if (requestIdRef.current !== requestId || !enabledRef.current) {
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        setState((prev) => ({ ...prev, isLoading: false, error: message }));
      });
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let timeoutId: ReturnType<typeof window.setTimeout> | null = null;
    let intervalId: ReturnType<typeof window.setInterval> | null = null;
    const startRefreshLoop = () => {
      refresh()?.catch(() => {});
      intervalId = window.setInterval(() => {
        refresh()?.catch(() => {});
      }, REFRESH_INTERVAL_MS);
    };
    if (initialDelayMs > 0) {
      timeoutId = window.setTimeout(startRefreshLoop, initialDelayMs);
    } else {
      startRefreshLoop();
    }
    return () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [enabled, initialDelayMs, refresh, workspacePath]);

  return { ...state, refresh };
}
