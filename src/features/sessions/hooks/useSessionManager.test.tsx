// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedSession, SessionSource } from "@/types";
import { useSessionManager } from "./useSessionManager";

const listSessionSources = vi.fn();
const scanManagedSessions = vi.fn();
const fetchManagedSessionsPage = vi.fn();
const cancelSessionTask = vi.fn();
const searchManagedSessions = vi.fn();
const fetchSessionSearchResults = vi.fn();
const archiveManagedSessions = vi.fn();
const permanentlyDeleteManagedSession = vi.fn();

vi.mock("@services/tauri", () => ({
  listSessionSources: (...args: unknown[]) => listSessionSources(...args),
  scanManagedSessions: (...args: unknown[]) => scanManagedSessions(...args),
  fetchManagedSessionsPage: (...args: unknown[]) => fetchManagedSessionsPage(...args),
  cancelSessionTask: (...args: unknown[]) => cancelSessionTask(...args),
  searchManagedSessions: (...args: unknown[]) => searchManagedSessions(...args),
  fetchSessionSearchResults: (...args: unknown[]) => fetchSessionSearchResults(...args),
  archiveManagedSessions: (...args: unknown[]) => archiveManagedSessions(...args),
  permanentlyDeleteManagedSession: (...args: unknown[]) => permanentlyDeleteManagedSession(...args),
}));

const source: SessionSource = {
  id: "source-a",
  name: "Primary",
  codexHomePath: "C:/Users/test/.codex",
  enabled: true,
  isCurrent: true,
  isDefault: true,
  discoveredAt: 1,
  lastScanAt: null,
  status: "ready",
  error: null,
};

function session(overrides: Partial<ManagedSession>): ManagedSession {
  return {
    key: "source-a:thread-a",
    sourceId: "source-a",
    threadId: "thread-a",
    sourceKind: "cli",
    cwd: "C:/projects/alpha",
    title: "Alpha",
    preview: null,
    createdAt: 1,
    updatedAt: 2,
    archivedAt: null,
    isArchived: false,
    parentThreadId: null,
    isSubagent: false,
    subagentNickname: null,
    subagentRole: null,
    projectExists: true,
    fileStatus: "mapped",
    fileConfidence: "exact",
    ...overrides,
  };
}

afterEach(() => vi.clearAllMocks());

cancelSessionTask.mockResolvedValue(undefined);

describe("useSessionManager", () => {
  it("starts source discovery and the initial scan concurrently", async () => {
    let resolveSources: ((sources: SessionSource[]) => void) | undefined;
    listSessionSources.mockReturnValue(new Promise<SessionSource[]>((resolve) => {
      resolveSources = resolve;
    }));
    scanManagedSessions.mockResolvedValue({ requestId: "scan", totalSessions: 0, diagnosticCount: 0, cancelled: false });
    fetchManagedSessionsPage.mockResolvedValue({ requestId: "scan", items: [], diagnostics: [], total: 0, nextOffset: null });

    const { result } = renderHook(() => useSessionManager(true));
    await act(async () => Promise.resolve());

    expect(listSessionSources).toHaveBeenCalledTimes(1);
    expect(scanManagedSessions).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSources?.([source]);
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it("stores scroll position without rerendering the session manager", () => {
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useSessionManager(false);
    });

    expect(renderCount).toBe(1);
    act(() => result.current.setScrollOffset(320));

    expect(renderCount).toBe(1);
    expect(result.current.getScrollOffset()).toBe(320);
  });

  it("replaces batch selection when selecting a row directly", () => {
    const { result } = renderHook(() => useSessionManager(false));

    act(() => {
      result.current.toggleSelected("source-a:thread-a");
      result.current.toggleSelected("source-a:thread-b");
    });
    expect(Array.from(result.current.selectedSessionKeys)).toEqual([
      "source-a:thread-a",
      "source-a:thread-b",
    ]);

    act(() => result.current.selectSingle("source-a:thread-b"));
    expect(Array.from(result.current.selectedSessionKeys)).toEqual([
      "source-a:thread-b",
    ]);
  });

  it("keeps filters local and includes every session type by default", async () => {
    listSessionSources.mockResolvedValue([source]);
    scanManagedSessions.mockResolvedValue({ requestId: "scan", totalSessions: 3, diagnosticCount: 0, cancelled: false });
    fetchManagedSessionsPage.mockResolvedValue({
      requestId: "scan",
      items: [
        session({}),
        session({ key: "source-a:archived", threadId: "archived", title: "Archived", isArchived: true }),
        session({ key: "source-a:child", threadId: "child", title: "Z", isSubagent: true }),
      ],
      diagnostics: [],
      total: 3,
      nextOffset: null,
    });

    const { result } = renderHook(() => useSessionManager(true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sessions.map((item) => item.title)).toEqual(["Alpha", "Z", "Archived"]);

    act(() => result.current.setStatusFilter("archived"));
    expect(result.current.sessions.map((item) => item.title)).toEqual(["Archived"]);
    act(() => result.current.setShowSubagents(true));
    act(() => result.current.setStatusFilter("all"));
    act(() => result.current.setQuery("z"));
    expect(result.current.sessions.map((item) => item.title)).toEqual(["Z"]);
  });

  it("indexes every metadata page before filtering while keeping rendering paged", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 6, 22, 15, 30));
    const firstPage = Array.from({ length: 100 }, (_, index) => session({
      key: `source-a:older-${index}`,
      threadId: `older-${index}`,
      title: `Older ${index}`,
      updatedAt: new Date(2026, 6, 20, 12, index % 60).getTime(),
    }));
    const today = session({
      key: "source-a:today",
      threadId: "today",
      title: "Today",
      updatedAt: new Date(2026, 6, 22, 8, 30).getTime(),
    });
    listSessionSources.mockResolvedValue([source]);
    scanManagedSessions.mockResolvedValue({ requestId: "scan", totalSessions: 101, diagnosticCount: 0, cancelled: false });
    fetchManagedSessionsPage
      .mockResolvedValueOnce({ requestId: "scan", items: [...firstPage, firstPage[0]], diagnostics: [], total: 101, nextOffset: 100 })
      .mockResolvedValueOnce({ requestId: "scan", items: [firstPage[0], today, today], diagnostics: [], total: 101, nextOffset: null });

    const { result, rerender } = renderHook(({ enabled }) => useSessionManager(enabled), { initialProps: { enabled: true } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.indexedSessions).toHaveLength(101);
    expect(result.current.totalSessionCount).toBe(101);

    act(() => result.current.setDatePreset("today"));
    expect(result.current.filteredSessionCount).toBe(1);
    expect(result.current.sessions.map((item) => item.title)).toEqual(["Today"]);

    act(() => result.current.setDatePreset("all"));
    expect(result.current.sessions).toHaveLength(100);
    expect(result.current.nextOffset).toBe(100);
    await act(async () => result.current.loadMore());
    expect(result.current.sessions).toHaveLength(101);

    rerender({ enabled: false });
    await waitFor(() => expect(cancelSessionTask).toHaveBeenCalled());
    vi.useRealTimers();
  });
  it("starts content search at two characters and cancels stale queries", async () => {
    listSessionSources.mockResolvedValue([source]);
    scanManagedSessions.mockResolvedValue({ requestId: "scan", totalSessions: 1, diagnosticCount: 0, cancelled: false });
    fetchManagedSessionsPage.mockResolvedValue({ requestId: "scan", items: [session({})], diagnostics: [], total: 1, nextOffset: null });
    searchManagedSessions.mockResolvedValue({ requestId: "search", scannedSources: 0, totalSources: 1, scannedFiles: 0, totalFiles: 1, completed: false, cancelled: false, incomplete: false });
    fetchSessionSearchResults.mockResolvedValue({
      results: [{ session: session({ title: "Content match" }), matches: [{ field: "userMessage", snippet: "needle" }], incomplete: false }],
      progress: { requestId: "search", scannedSources: 1, totalSources: 1, scannedFiles: 1, totalFiles: 1, completed: true, cancelled: false, incomplete: false },
    });

    const { result } = renderHook(() => useSessionManager(true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.setQuery("n"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(searchManagedSessions).not.toHaveBeenCalled();

    act(() => result.current.setQuery("ne"));
    act(() => result.current.setQuery("needle"));
    await waitFor(() => expect(searchManagedSessions).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.sessions[0]?.title).toBe("Content match"));
    expect(result.current.sessions[0]?.preview).toBe("needle");
    expect(cancelSessionTask.mock.calls.some(([requestId]) => String(requestId).startsWith("session-search-"))).toBe(true);
  });

  it("refreshes successful archives and keeps failed items selected", async () => {
    const second = session({ key: "source-a:thread-b", threadId: "thread-b", title: "Beta" });
    listSessionSources.mockResolvedValue([source]);
    scanManagedSessions.mockResolvedValue({ requestId: "scan", totalSessions: 2, diagnosticCount: 0, cancelled: false });
    fetchManagedSessionsPage
      .mockResolvedValueOnce({ requestId: "scan", items: [session({}), second], diagnostics: [], total: 2, nextOffset: null })
      .mockResolvedValueOnce({ requestId: "scan-next", items: [second], diagnostics: [], total: 1, nextOffset: null });
    archiveManagedSessions.mockResolvedValue({
      results: [
        { sourceId: "source-a", threadId: "thread-a", success: true, archivedAt: 10, error: null },
        { sourceId: "source-a", threadId: "thread-b", success: false, archivedAt: null, error: "failed" },
      ],
      successCount: 1,
      failureCount: 1,
    });

    const { result } = renderHook(() => useSessionManager(true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.toggleSelected("source-a:thread-a"));
    act(() => result.current.toggleSelected("source-a:thread-b"));
    await act(async () => {
      await result.current.archiveSessions(result.current.sessions);
    });

    expect(archiveManagedSessions).toHaveBeenCalledWith({
      items: [
        { sourceId: "source-a", threadId: "thread-a" },
        { sourceId: "source-a", threadId: "thread-b" },
      ],
    });
    expect(result.current.archiveResult?.failureCount).toBe(1);
    expect([...result.current.selectedSessionKeys]).toEqual(["source-a:thread-b"]);
  });

  it("does not permanently delete an active session", async () => {
    const active = session({});
    listSessionSources.mockResolvedValue([source]);
    scanManagedSessions.mockResolvedValue({ requestId: "scan", totalSessions: 1, diagnosticCount: 0, cancelled: false });
    fetchManagedSessionsPage.mockResolvedValue({ requestId: "scan", items: [active], diagnostics: [], total: 1, nextOffset: null });
    permanentlyDeleteManagedSession.mockResolvedValue({
      results: [{ sourceId: "source-a", threadId: "thread-a", success: true, error: null }],
      successCount: 1,
      failureCount: 0,
    });

    const { result } = renderHook(() => useSessionManager(true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.permanentlyDeleteSessions([active], true);
    });

    expect(archiveManagedSessions).not.toHaveBeenCalled();
    expect(permanentlyDeleteManagedSession).not.toHaveBeenCalled();
  });

  it("refreshes successful batch deletes and keeps transport failures selected", async () => {
    const archivedA = session({ isArchived: true, archivedAt: 10 });
    const archivedB = session({ key: "source-a:thread-b", threadId: "thread-b", title: "Beta", isArchived: true, archivedAt: 11 });
    listSessionSources.mockResolvedValue([source]);
    scanManagedSessions.mockResolvedValue({ requestId: "scan", totalSessions: 2, diagnosticCount: 0, cancelled: false });
    fetchManagedSessionsPage
      .mockResolvedValueOnce({ requestId: "scan", items: [archivedA, archivedB], diagnostics: [], total: 2, nextOffset: null })
      .mockResolvedValueOnce({ requestId: "scan", items: [archivedB], diagnostics: [], total: 1, nextOffset: null });
    permanentlyDeleteManagedSession
      .mockResolvedValueOnce({ results: [{ sourceId: "source-a", threadId: "thread-a", success: true, error: null }], successCount: 1, failureCount: 0 })
      .mockRejectedValueOnce(new Error("transport failed"));

    const { result } = renderHook(() => useSessionManager(true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.permanentlyDeleteSessions([archivedA, archivedB], false);
    });

    expect([...result.current.selectedSessionKeys]).toEqual(["source-a:thread-b"]);
    expect(result.current.error).toBe("transport failed");
  });

  it("does not issue a duplicate child delete when cascading a selected parent", async () => {
    const parent = session({ isArchived: true, archivedAt: 10 });
    const child = session({
      key: "source-a:thread-child",
      threadId: "thread-child",
      parentThreadId: "thread-a",
      isArchived: true,
      archivedAt: 11,
    });
    listSessionSources.mockResolvedValue([source]);
    scanManagedSessions.mockResolvedValue({ requestId: "scan", totalSessions: 2, diagnosticCount: 0, cancelled: false });
    fetchManagedSessionsPage
      .mockResolvedValueOnce({ requestId: "scan", items: [parent, child], diagnostics: [], total: 2, nextOffset: null })
      .mockResolvedValueOnce({ requestId: "scan", items: [], diagnostics: [], total: 0, nextOffset: null });
    permanentlyDeleteManagedSession.mockResolvedValue({
      results: [
        { sourceId: "source-a", threadId: "thread-a", success: true, error: null },
        { sourceId: "source-a", threadId: "thread-child", success: true, error: null },
      ],
      successCount: 2,
      failureCount: 0,
    });

    const { result } = renderHook(() => useSessionManager(true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.permanentlyDeleteSessions([parent, child], true);
    });

    expect(permanentlyDeleteManagedSession).toHaveBeenCalledTimes(1);
    expect(permanentlyDeleteManagedSession).toHaveBeenCalledWith({
      sourceId: "source-a",
      threadId: "thread-a",
      archivedAt: 10,
      cascadeRequested: true,
    });
  });
});
