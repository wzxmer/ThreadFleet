import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ManagedSession, ManagedSessionPreviewItem, ManagedSessionPreviewResponse } from "@/types";
import { fetchManagedSessionPreview } from "@services/tauri";
import { useSessionManager } from "../hooks/useSessionManager";

type SessionManagerState = ReturnType<typeof useSessionManager>;

type SessionManagerContextValue = {
  active: boolean;
  setActive: (active: boolean) => void;
  manager: SessionManagerState;
  focusedSessionKey: string | null;
  focusedSession: ManagedSession | null;
  focusSession: (session: ManagedSession) => void;
  sessionPreview: ManagedSessionPreviewResponse | null;
  sessionPreviewLoading: boolean;
  sessionPreviewLoadingMore: boolean;
  sessionPreviewError: string | null;
  loadEarlierSessionPreview: () => Promise<void>;
  resumingKey: string | null;
  resumeSession: (session: ManagedSession) => Promise<void>;
  pendingResumeSession: ManagedSession | null;
  currentWorkspace: { name: string; path: string } | null;
  resumeInOriginalProject: () => Promise<void>;
  migrateToCurrentProject: () => void;
  cancelResumeChoice: () => void;
  deriveSession: (session: ManagedSession) => void;
  deriveSessions: (sessions: ManagedSession[]) => void;
  pendingPermanentDeleteSessions: ManagedSession[] | null;
  pendingPermanentDeleteChildCount: number;
  requestPermanentDelete: (sessions: ManagedSession[]) => Promise<void>;
  confirmPermanentDelete: (cascadeRequested: boolean) => Promise<void>;
  cancelPermanentDelete: () => void;
};

const SessionManagerContext = createContext<SessionManagerContextValue | null>(null);
const SESSION_CONTENT_LOAD_DELAY_MS = 80;
const SESSION_CONTENT_PAGE_SIZE = 40;

type Props = {
  active: boolean;
  onActiveChange: (active: boolean) => void;
  onResumeSession: (session: ManagedSession) => Promise<boolean>;
  onDeriveSession: (session: ManagedSession) => void;
  onDeriveSessions?: (sessions: ManagedSession[]) => void;
  currentWorkspace?: { name: string; path: string } | null;
  children: ReactNode;
};

function normalizeProjectPath(path: string | null | undefined) {
  return (path ?? "").trim().replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
}

function prependPreviewItems(
  older: ManagedSessionPreviewItem[],
  current: ManagedSessionPreviewItem[],
) {
  return [...older, ...current].filter((item, index, items) => (
    index === 0 || item.role !== items[index - 1]?.role || item.text !== items[index - 1]?.text
  ));
}

export function SessionManagerProvider({ active, onActiveChange, onResumeSession, onDeriveSession, onDeriveSessions, currentWorkspace = null, children }: Props) {
  const manager = useSessionManager(active, currentWorkspace?.path ?? null);
  const [focusedSessionKey, setFocusedSessionKey] = useState<string | null>(null);
  const [sessionPreview, setSessionPreview] = useState<ManagedSessionPreviewResponse | null>(null);
  const [sessionPreviewLoading, setSessionPreviewLoading] = useState(false);
  const [sessionPreviewLoadingMore, setSessionPreviewLoadingMore] = useState(false);
  const [sessionPreviewError, setSessionPreviewError] = useState<string | null>(null);
  const previewRequestRef = useRef(0);
  const [resumingKey, setResumingKey] = useState<string | null>(null);
  const [pendingResumeSession, setPendingResumeSession] = useState<ManagedSession | null>(null);
  const [pendingPermanentDeleteSessions, setPendingPermanentDeleteSessions] = useState<ManagedSession[] | null>(null);
  const [pendingPermanentDeleteChildCount, setPendingPermanentDeleteChildCount] = useState(0);
  const focusedSession = useMemo(
    () => manager.sessions.find((session) => session.key === focusedSessionKey) ?? null,
    [focusedSessionKey, manager.sessions],
  );
  const focusedSourceId = focusedSession?.sourceId ?? null;
  const focusedThreadId = focusedSession?.threadId ?? null;
  const focusSession = useCallback((session: ManagedSession) => {
    if (session.key === focusedSessionKey) return;
    previewRequestRef.current += 1;
    setSessionPreview(null);
    setSessionPreviewError(null);
    setSessionPreviewLoading(true);
    setSessionPreviewLoadingMore(false);
    setFocusedSessionKey(session.key);
  }, [focusedSessionKey]);
  useEffect(() => {
    if (!active) setFocusedSessionKey(null);
  }, [active]);
  useEffect(() => {
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    setSessionPreview(null);
    setSessionPreviewError(null);
    setSessionPreviewLoadingMore(false);
    if (!active || !focusedSourceId || !focusedThreadId) {
      setSessionPreviewLoading(false);
      return;
    }
    setSessionPreviewLoading(true);
    const timer = window.setTimeout(() => {
      void fetchManagedSessionPreview({
        sourceId: focusedSourceId,
        threadId: focusedThreadId,
        limit: SESSION_CONTENT_PAGE_SIZE,
      })
        .then((preview) => {
          if (previewRequestRef.current === requestId) {
            setSessionPreview({ ...preview, nextCursor: preview.nextCursor ?? null });
          }
        })
        .catch((caught) => {
          if (previewRequestRef.current === requestId) {
            setSessionPreviewError(caught instanceof Error ? caught.message : String(caught));
          }
        })
        .finally(() => {
          if (previewRequestRef.current === requestId) setSessionPreviewLoading(false);
        });
    }, SESSION_CONTENT_LOAD_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [active, focusedSourceId, focusedThreadId]);
  const loadEarlierSessionPreview = useCallback(async () => {
    const cursor = sessionPreview?.nextCursor ?? null;
    if (
      !active ||
      !focusedSourceId ||
      !focusedThreadId ||
      cursor === null ||
      sessionPreviewLoadingMore
    ) {
      return;
    }
    const requestId = previewRequestRef.current;
    setSessionPreviewLoadingMore(true);
    try {
      const older = await fetchManagedSessionPreview({
        sourceId: focusedSourceId,
        threadId: focusedThreadId,
        limit: SESSION_CONTENT_PAGE_SIZE,
        cursor,
      });
      if (previewRequestRef.current !== requestId) return;
      setSessionPreview((current) => current ? {
        openingMessage: current.openingMessage ?? older.openingMessage,
        items: prependPreviewItems(older.items, current.items),
        nextCursor: older.nextCursor ?? null,
        incomplete: current.incomplete || older.incomplete,
      } : current);
    } catch (caught) {
      if (previewRequestRef.current === requestId) {
        setSessionPreview((current) => current ? { ...current, incomplete: true } : current);
      }
    } finally {
      if (previewRequestRef.current === requestId) setSessionPreviewLoadingMore(false);
    }
  }, [active, focusedSourceId, focusedThreadId, sessionPreview?.nextCursor, sessionPreviewLoadingMore]);
  const resumeDirectly = useCallback(async (session: ManagedSession) => {
    setResumingKey(session.key);
    try {
      const resumed = await onResumeSession(session);
      if (resumed) onActiveChange(false);
    } finally {
      setResumingKey(null);
    }
  }, [onActiveChange, onResumeSession]);
  const resumeSession = useCallback(async (session: ManagedSession) => {
    if (!session.projectExists) {
      await resumeDirectly(session);
      return;
    }
    const sourcePath = normalizeProjectPath(session.cwd);
    const destinationPath = normalizeProjectPath(currentWorkspace?.path);
    if (sourcePath && destinationPath && sourcePath !== destinationPath) {
      setPendingResumeSession(session);
      return;
    }
    await resumeDirectly(session);
  }, [currentWorkspace?.path, resumeDirectly]);
  const resumeInOriginalProject = useCallback(async () => {
    if (!pendingResumeSession) return;
    const session = pendingResumeSession;
    setPendingResumeSession(null);
    await resumeDirectly(session);
  }, [pendingResumeSession, resumeDirectly]);
  const migrateToCurrentProject = useCallback(() => {
    if (!pendingResumeSession) return;
    const session = pendingResumeSession;
    setPendingResumeSession(null);
    onDeriveSession(session);
  }, [onDeriveSession, pendingResumeSession]);
  const deriveSessions = useCallback((sessions: ManagedSession[]) => {
    if (sessions.length === 0) return;
    if (onDeriveSessions) onDeriveSessions(sessions);
    else sessions.forEach(onDeriveSession);
  }, [onDeriveSession, onDeriveSessions]);
  const requestPermanentDelete = useCallback(async (sessions: ManagedSession[]) => {
    if (sessions.length === 0 || sessions.some((session) => !session.isArchived || session.archivedAt == null)) return;
    const counts = await Promise.all(sessions.map((session) => manager.getPermanentDeleteChildCount(session)));
    if (counts.some((count) => count == null)) return;
    setPendingPermanentDeleteChildCount(counts.reduce<number>((total, count) => total + (count ?? 0), 0));
    setPendingPermanentDeleteSessions(sessions);
  }, [manager]);
  const confirmPermanentDelete = useCallback(async (cascadeRequested: boolean) => {
    if (!pendingPermanentDeleteSessions) return;
    const response = await manager.permanentlyDeleteSessions(pendingPermanentDeleteSessions, cascadeRequested);
    if (response) setPendingPermanentDeleteSessions(null);
  }, [manager, pendingPermanentDeleteSessions]);

  const value = useMemo<SessionManagerContextValue>(() => ({
    active,
    setActive: onActiveChange,
    manager,
    focusedSessionKey: focusedSession?.key ?? null,
    focusedSession,
    focusSession,
    sessionPreview,
    sessionPreviewLoading,
    sessionPreviewLoadingMore,
    sessionPreviewError,
    loadEarlierSessionPreview,
    resumingKey,
    resumeSession,
    pendingResumeSession,
    currentWorkspace,
    resumeInOriginalProject,
    migrateToCurrentProject,
    cancelResumeChoice: () => setPendingResumeSession(null),
    deriveSession: onDeriveSession,
    deriveSessions,
    pendingPermanentDeleteSessions,
    pendingPermanentDeleteChildCount,
    requestPermanentDelete,
    confirmPermanentDelete,
    cancelPermanentDelete: () => setPendingPermanentDeleteSessions(null),
  }), [active, confirmPermanentDelete, currentWorkspace, deriveSessions, focusSession, focusedSession, loadEarlierSessionPreview, manager, migrateToCurrentProject, onActiveChange, onDeriveSession, pendingPermanentDeleteChildCount, pendingPermanentDeleteSessions, pendingResumeSession, requestPermanentDelete, resumeInOriginalProject, resumeSession, resumingKey, sessionPreview, sessionPreviewError, sessionPreviewLoading, sessionPreviewLoadingMore]);

  return <SessionManagerContext.Provider value={value}>{children}</SessionManagerContext.Provider>;
}

export function useSessionManagerContext() {
  const value = useContext(SessionManagerContext);
  if (!value) throw new Error("useSessionManagerContext must be used within SessionManagerProvider");
  return value;
}
