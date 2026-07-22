import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArchiveManagedSessionsResponse, ManagedSession, SessionScanDiagnostic, SessionSearchProgress, SessionSearchResult, SessionSource } from "@/types";
import { archiveManagedSessions, cancelSessionTask, fetchManagedSessionsPage, fetchSessionSearchResults, listSessionSources, permanentlyDeleteManagedSession, scanManagedSessions, searchManagedSessions } from "@services/tauri";
import {
  buildSessionManagerStats,
  filterAndSortManagedSessions,
  getSessionProjectOptions,
  type SessionManagerDateField,
  type SessionManagerDatePreset,
  type SessionManagerFilterState,
  type SessionManagerProjectMode,
  type SessionManagerSortDirection,
  type SessionManagerSortField,
  type SessionManagerStorageFilter,
  type SessionManagerTypeFilter,
} from "../utils/sessionManagerFilters";

const PAGE_LIMIT = 100;
const CONTENT_SEARCH_DELAY_MS = 250;

export type SessionManagerStatusFilter = "all" | "active" | "archived" | "missing";

export function useSessionManager(enabled: boolean, currentProjectPath: string | null = null) {
  const [sources, setSources] = useState<SessionSource[]>([]);
  const [sessions, setSessions] = useState<ManagedSession[]>([]);
  const [totalSessionCount, setTotalSessionCount] = useState(0);
  const [diagnostics, setDiagnostics] = useState<SessionScanDiagnostic[]>([]);
  const [query, setQuery] = useState("");
  const [dateField, setDateField] = useState<SessionManagerDateField>("updatedAt");
  const [datePreset, setDatePreset] = useState<SessionManagerDatePreset>("all");
  const [customDateStart, setCustomDateStart] = useState("");
  const [customDateEnd, setCustomDateEnd] = useState("");
  const [storageFilter, setStorageFilter] = useState<SessionManagerStorageFilter>("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [sessionTypeFilter, setSessionTypeFilter] = useState<SessionManagerTypeFilter>("all");
  const [projectMode, setProjectMode] = useState<SessionManagerProjectMode>("all");
  const [projectPaths, setProjectPaths] = useState<string[]>([]);
  const [sourceKindFilter, setSourceKindFilter] = useState("all");
  const [fileStatusFilter, setFileStatusFilter] = useState("all");
  const [fileConfidenceFilter, setFileConfidenceFilter] = useState("all");
  const [subagentQuery, setSubagentQuery] = useState("");
  const [sortField, setSortField] = useState<SessionManagerSortField>("updatedAt");
  const [sortDirection, setSortDirection] = useState<SessionManagerSortDirection>("desc");
  const [selectedSessionKeys, setSelectedSessionKeys] = useState<Set<string>>(new Set());
  const [visibleLimit, setVisibleLimit] = useState(PAGE_LIMIT);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollOffsetRef = useRef(0);
  const [searchResults, setSearchResults] = useState<SessionSearchResult[] | null>(null);
  const [searchProgress, setSearchProgress] = useState<SessionSearchProgress | null>(null);
  const [archiveResult, setArchiveResult] = useState<ArchiveManagedSessionsResponse | null>(null);
  const [archivingKeys, setArchivingKeys] = useState<Set<string>>(new Set());
  const [deletingKeys, setDeletingKeys] = useState<Set<string>>(new Set());
  const scanRequestIdRef = useRef<string | null>(null);
  const searchRequestIdRef = useRef<string | null>(null);
  const getScrollOffset = useCallback(() => scrollOffsetRef.current, []);
  const setScrollOffset = useCallback((offset: number) => {
    scrollOffsetRef.current = offset;
  }, []);

  const refresh = useCallback(async () => {
    const previousRequestId = scanRequestIdRef.current;
    if (previousRequestId) void cancelSessionTask(previousRequestId).catch(() => {});
    const requestId = `session-scan-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    scanRequestIdRef.current = requestId;
    setLoading(true);
    setError(null);
    setSearchResults(null);
    setSearchProgress(null);
    try {
      const [nextSources] = await Promise.all([
        listSessionSources(),
        scanManagedSessions({ requestId }),
      ]);
      if (scanRequestIdRef.current !== requestId) return;
      setSources(nextSources);
      const firstPage = await fetchManagedSessionsPage({ requestId, offset: 0, limit: PAGE_LIMIT });
      const indexed: ManagedSession[] = [];
      const seen = new Set<string>();
      const appendUnique = (items: ManagedSession[]) => {
        items.forEach((session) => {
          if (seen.has(session.key)) return;
          seen.add(session.key);
          indexed.push(session);
        });
      };
      appendUnique(firstPage.items);
      let offset = firstPage.nextOffset;
      while (offset !== null) {
        const page = await fetchManagedSessionsPage({ requestId, offset, limit: PAGE_LIMIT });
        if (scanRequestIdRef.current !== requestId) return;
        appendUnique(page.items);
        offset = page.nextOffset;
      }
      if (scanRequestIdRef.current !== requestId) return;
      setSessions(indexed);
      setTotalSessionCount(firstPage.total);
      setDiagnostics(firstPage.diagnostics);
      setVisibleLimit(PAGE_LIMIT);
      setSelectedSessionKeys(new Set());
    } catch (caught) {
      if (scanRequestIdRef.current === requestId) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (scanRequestIdRef.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    return () => {
      for (const requestId of [scanRequestIdRef.current, searchRequestIdRef.current]) {
        if (requestId) void cancelSessionTask(requestId).catch(() => {});
      }
    };
  }, [enabled, refresh]);

  useEffect(() => {
    const normalizedQuery = query.trim();
    const previousRequestId = searchRequestIdRef.current;
    if (previousRequestId) {
      void cancelSessionTask(previousRequestId).catch(() => {});
      searchRequestIdRef.current = null;
    }
    setSearchResults(null);
    setSearchProgress(null);
    if (!enabled || loading || normalizedQuery.length < 2 || sessions.length === 0) return;

    const requestId = `session-search-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    searchRequestIdRef.current = requestId;
    const timer = window.setTimeout(async () => {
      setSearchProgress({ requestId, scannedSources: 0, totalSources: sourceFilter === "all" ? sources.length : 1, scannedFiles: 0, totalFiles: null, completed: false, cancelled: false, incomplete: false });
      try {
        const progress = await searchManagedSessions({
          requestId,
          query: normalizedQuery,
          sourceIds: sourceFilter === "all" ? [] : [sourceFilter],
          includeArchived: storageFilter !== "local",
          includeSubagents: sessionTypeFilter !== "main",
        });
        if (searchRequestIdRef.current !== requestId) return;
        setSearchProgress(progress);
        while (searchRequestIdRef.current === requestId) {
          const response = await fetchSessionSearchResults(requestId);
          if (searchRequestIdRef.current !== requestId) return;
          setSearchResults(response.results);
          setSearchProgress(response.progress);
          if (response.progress.completed || response.progress.cancelled) break;
          await new Promise((resolve) => window.setTimeout(resolve, 75));
        }
      } catch (caught) {
        if (searchRequestIdRef.current === requestId) setError(caught instanceof Error ? caught.message : String(caught));
      }
    }, CONTENT_SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, loading, query, sessions.length, sessionTypeFilter, sourceFilter, sources.length, storageFilter]);

  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      setVisibleLimit((current) => current + PAGE_LIMIT);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore]);

  const filterState = useMemo<SessionManagerFilterState>(() => ({
    query: searchResults ? "" : query,
    dateField,
    datePreset,
    customDateStart,
    customDateEnd,
    storage: storageFilter,
    sourceId: sourceFilter,
    sessionType: sessionTypeFilter,
    projectMode,
    projectPaths,
    currentProjectPath,
    sourceKind: sourceKindFilter,
    fileStatus: fileStatusFilter,
    fileConfidence: fileConfidenceFilter,
    subagentQuery,
    sortField,
    sortDirection,
  }), [currentProjectPath, customDateEnd, customDateStart, dateField, datePreset, fileConfidenceFilter, fileStatusFilter, projectMode, projectPaths, query, searchResults, sessionTypeFilter, sortDirection, sortField, sourceFilter, sourceKindFilter, storageFilter, subagentQuery]);

  const allFilteredSessions = useMemo(() => {
    const candidates = searchResults?.map((result) => ({
      ...result.session,
      preview: result.matches.find((match) => match.field === "userMessage" || match.field === "agentReply")?.snippet ?? result.session.preview,
    })) ?? sessions;
    return filterAndSortManagedSessions(candidates, filterState);
  }, [filterState, searchResults, sessions]);

  const hasNarrowingFilter = Boolean(query.trim()) || datePreset !== "all" || storageFilter !== "all" || sourceFilter !== "all" || sessionTypeFilter !== "all" || projectMode !== "all" || sourceKindFilter !== "all" || fileStatusFilter !== "all" || fileConfidenceFilter !== "all" || Boolean(subagentQuery.trim());
  const filteredSessions = useMemo(() => {
    if (hasNarrowingFilter) return allFilteredSessions;
    const local = allFilteredSessions.filter((session) => !session.isArchived).slice(0, visibleLimit);
    const archived = allFilteredSessions.filter((session) => session.isArchived).slice(0, visibleLimit);
    return [...local, ...archived];
  }, [allFilteredSessions, hasNarrowingFilter, visibleLimit]);
  const stats = useMemo(() => buildSessionManagerStats(allFilteredSessions), [allFilteredSessions]);
  const projectOptions = useMemo(() => getSessionProjectOptions(sessions), [sessions]);
  const sourceKindOptions = useMemo(() => Array.from(new Set(sessions.map((session) => session.sourceKind).filter((value): value is string => Boolean(value)))).sort(), [sessions]);
  const fileStatusOptions = useMemo(() => Array.from(new Set(sessions.map((session) => session.fileStatus))).sort(), [sessions]);
  const fileConfidenceOptions = useMemo(() => Array.from(new Set(sessions.map((session) => session.fileConfidence))).sort(), [sessions]);
  const nextOffset = !hasNarrowingFilter && (stats.local > visibleLimit || stats.archived > visibleLimit) ? visibleLimit : null;

  const filterSignature = [query, dateField, datePreset, customDateStart, customDateEnd, storageFilter, sourceFilter, sessionTypeFilter, projectMode, projectPaths.join("\u0000"), sourceKindFilter, fileStatusFilter, fileConfidenceFilter, subagentQuery].join("\u0001");
  useEffect(() => {
    setVisibleLimit((current) => current === PAGE_LIMIT ? current : PAGE_LIMIT);
    setSelectedSessionKeys((current) => current.size === 0 ? current : new Set());
  }, [filterSignature]);

  const showSubagents = sessionTypeFilter !== "main";
  const setShowSubagents = useCallback((show: boolean) => setSessionTypeFilter(show ? "all" : "main"), []);
  const statusFilter: SessionManagerStatusFilter = projectMode === "missing"
    ? "missing"
    : storageFilter === "local"
      ? "active"
      : storageFilter === "archived"
        ? "archived"
        : "all";
  const setStatusFilter = useCallback((value: SessionManagerStatusFilter) => {
    if (value === "missing") {
      setProjectMode("missing");
      setStorageFilter("all");
      return;
    }
    setProjectMode((current) => current === "missing" ? "all" : current);
    setStorageFilter(value === "active" ? "local" : value);
  }, []);
  const toggleProjectPath = useCallback((path: string) => {
    setProjectPaths((current) => {
      const next = current.includes(path) ? current.filter((item) => item !== path) : [...current, path];
      setProjectMode(next.length > 0 ? "selected" : "all");
      return next;
    });
  }, []);
  const clearFilters = useCallback(() => {
    setQuery("");
    setDateField("updatedAt");
    setDatePreset("all");
    setCustomDateStart("");
    setCustomDateEnd("");
    setStorageFilter("all");
    setSourceFilter("all");
    setSessionTypeFilter("all");
    setProjectMode("all");
    setProjectPaths([]);
    setSourceKindFilter("all");
    setFileStatusFilter("all");
    setFileConfidenceFilter("all");
    setSubagentQuery("");
    setSortField("updatedAt");
    setSortDirection("desc");
  }, []);
  const activeFilterCount = [
    datePreset !== "all",
    storageFilter !== "all",
    sourceFilter !== "all",
    sessionTypeFilter !== "all",
    projectMode !== "all",
    sourceKindFilter !== "all",
    fileStatusFilter !== "all",
    fileConfidenceFilter !== "all",
    subagentQuery.trim().length > 0,
  ].filter(Boolean).length;

  const toggleSelected = useCallback((key: string) => {
    setSelectedSessionKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const selectSingle = useCallback((key: string) => {
    setSelectedSessionKeys((current) =>
      current.size === 1 && current.has(key) ? current : new Set([key]),
    );
  }, []);

  const clearSelection = useCallback(() => setSelectedSessionKeys(new Set()), []);

  const archiveSessions = useCallback(async (targets: ManagedSession[]) => {
    const archiveable = targets.filter((session) => !session.isArchived);
    if (archiveable.length === 0) return null;
    const keys = new Set(archiveable.map((session) => session.key));
    setArchivingKeys(keys);
    setError(null);
    try {
      const response = await archiveManagedSessions({
        items: archiveable.map((session) => ({
          sourceId: session.sourceId,
          threadId: session.threadId,
        })),
      });
      setArchiveResult(response);
      const failedKeys = new Set(
        response.results
          .filter((result) => !result.success)
          .map((result) => `${result.sourceId}:${result.threadId}`),
      );
      if (response.successCount > 0) {
        await refresh();
        setSelectedSessionKeys(failedKeys);
      }
      return response;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    } finally {
      setArchivingKeys(new Set());
    }
  }, [refresh]);

  const permanentlyDeleteSession = useCallback(async (session: ManagedSession, cascadeRequested: boolean) => {
    if (!session.isArchived || session.archivedAt == null) return null;
    setDeletingKeys(new Set([session.key]));
    setError(null);
    try {
      const response = await permanentlyDeleteManagedSession({ sourceId: session.sourceId, threadId: session.threadId, archivedAt: session.archivedAt, cascadeRequested });
      const deleteError = response.results.find((result) => result.error)?.error;
      if (deleteError) setError(deleteError);
      await refresh();
      setSelectedSessionKeys(new Set());
      return response;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    } finally {
      setDeletingKeys(new Set());
    }
  }, [refresh]);

  const permanentlyDeleteSessions = useCallback(async (targets: ManagedSession[], cascadeRequested: boolean) => {
    const readyToDelete = targets.filter((session) => session.isArchived && session.archivedAt != null);
    if (readyToDelete.length === 0) return null;
    const readyTargetKeys = new Set(
      readyToDelete.map((session) => `${session.sourceId}:${session.threadId}`),
    );
    const deleteRequests = cascadeRequested
      ? readyToDelete.filter((session) => (
        !session.parentThreadId ||
        !readyTargetKeys.has(`${session.sourceId}:${session.parentThreadId}`)
      ))
      : readyToDelete;
    setDeletingKeys(new Set(readyToDelete.map((session) => session.key)));
    setError(null);
    try {
      const settledResponses = await Promise.allSettled(deleteRequests.map((session) => permanentlyDeleteManagedSession({
        sourceId: session.sourceId,
        threadId: session.threadId,
        archivedAt: session.archivedAt as number,
        cascadeRequested,
      })));
      const responses = settledResponses.flatMap((item) => item.status === "fulfilled" ? [item.value] : []);
      const results = responses.flatMap((response) => response.results);
      settledResponses.forEach((item, index) => {
        if (item.status === "rejected") {
          const session = deleteRequests[index];
          results.push({
            sourceId: session.sourceId,
            threadId: session.threadId,
            success: false,
            error: item.reason instanceof Error ? item.reason.message : String(item.reason),
          });
        }
      });
      const response = {
        results,
        successCount: responses.reduce((count, item) => count + item.successCount, 0),
        failureCount: responses.reduce((count, item) => count + item.failureCount, 0) + settledResponses.filter((item) => item.status === "rejected").length,
      };
      const failure = results.find((result) => result.error)?.error;
      await refresh();
      if (failure) setError(failure);
      setSelectedSessionKeys(new Set([
        ...results.filter((result) => !result.success).map((result) => `${result.sourceId}:${result.threadId}`),
      ]));
      return response;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    } finally {
      setDeletingKeys(new Set());
    }
  }, [refresh]);

  const getPermanentDeleteChildCount = useCallback(async (session: ManagedSession) => {
    try {
      return sessions.filter((candidate) => candidate.sourceId === session.sourceId && candidate.parentThreadId === session.threadId).length;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    }
  }, [sessions]);

  return {
    sources,
    sessions: filteredSessions,
    allFilteredSessions,
    indexedSessions: sessions,
    totalSessionCount,
    filteredSessionCount: allFilteredSessions.length,
    stats,
    projectOptions,
    sourceKindOptions,
    fileStatusOptions,
    fileConfidenceOptions,
    diagnostics,
    query,
    setQuery,
    dateField,
    setDateField,
    datePreset,
    setDatePreset,
    customDateStart,
    setCustomDateStart,
    customDateEnd,
    setCustomDateEnd,
    storageFilter,
    setStorageFilter,
    sourceFilter,
    setSourceFilter,
    sessionTypeFilter,
    setSessionTypeFilter,
    projectMode,
    setProjectMode,
    currentProjectPath,
    projectPaths,
    toggleProjectPath,
    sourceKindFilter,
    setSourceKindFilter,
    fileStatusFilter,
    setFileStatusFilter,
    fileConfidenceFilter,
    setFileConfidenceFilter,
    subagentQuery,
    setSubagentQuery,
    sortField,
    setSortField,
    sortDirection,
    setSortDirection,
    activeFilterCount,
    clearFilters,
    showSubagents,
    setShowSubagents,
    statusFilter,
    setStatusFilter,
    selectedSessionKeys,
    toggleSelected,
    selectSingle,
    clearSelection,
    nextOffset: query.trim().length >= 2 ? null : nextOffset,
    loading,
    loadingMore,
    error,
    refresh,
    loadMore,
    getScrollOffset,
    setScrollOffset,
    searchProgress,
    archiveResult,
    dismissArchiveResult: () => setArchiveResult(null),
    archivingKeys,
    archiveSessions,
    deletingKeys,
    permanentlyDeleteSession,
    permanentlyDeleteSessions,
    getPermanentDeleteChildCount,
  };
}

export type SessionManagerState = ReturnType<typeof useSessionManager>;
