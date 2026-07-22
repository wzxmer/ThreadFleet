import Archive from "lucide-react/dist/esm/icons/archive";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import Play from "lucide-react/dist/esm/icons/play";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import { useI18n } from "@/features/i18n/I18nProvider";
import { formatLocalDateTime, formatRelativeTimeShort } from "@/utils/time";
import { useSessionManagerContext } from "../context/SessionManagerContext";
import { SessionArchiveResultSummary } from "./SessionArchiveResultSummary";
import { SessionPermanentDeletePrompt } from "./SessionPermanentDeletePrompt";
import { SessionManagerConversation } from "./SessionManagerConversation";
import { SessionManagerOverview } from "./SessionManagerOverview";

function displayTime(value: number | null) {
  return value == null ? "-" : formatLocalDateTime(value, { includeSeconds: true });
}

export function SessionManagerWorkspace() {
  const { t } = useI18n();
  const { manager, focusedSession, sessionPreview, sessionPreviewLoading, sessionPreviewLoadingMore, sessionPreviewError, loadEarlierSessionPreview, resumingKey, resumeSession, deriveSession, currentWorkspace, pendingPermanentDeleteSessions, pendingPermanentDeleteChildCount, requestPermanentDelete, confirmPermanentDelete, cancelPermanentDelete } = useSessionManagerContext();
  const source = focusedSession ? manager.sources.find((candidate) => candidate.id === focusedSession.sourceId) : null;
  const focusedRelativeTime = focusedSession?.updatedAt ? formatRelativeTimeShort(focusedSession.updatedAt) : null;

  return (
    <section className="session-manager-workspace" aria-label={t("sessionManager.title")}>
      <header className="session-manager-workspace-header">
        <div className="session-manager-workspace-heading">
          <span className="session-manager-workspace-eyebrow">{t("sessionManager.resultCount")} {manager.filteredSessionCount} / {manager.totalSessionCount}</span>
          <h1>{focusedSession?.title ?? t("sessionManager.overview")}</h1>
        </div>
      </header>

      {manager.archiveResult && <SessionArchiveResultSummary result={manager.archiveResult} sources={manager.sources} onDismiss={manager.dismissArchiveResult} />}

      <div className={`session-manager-detail${focusedSession ? " is-session" : " is-overview"}`}>
        {!focusedSession ? <SessionManagerOverview stats={manager.stats} sources={manager.sources} /> : <>
          <div className="session-manager-conversation-preview">
            <SessionManagerConversation sessionKey={focusedSession.key} items={sessionPreview?.items ?? []} loading={sessionPreviewLoading} loadingMore={sessionPreviewLoadingMore} error={sessionPreviewError} incomplete={sessionPreview?.incomplete ?? false} fallback={focusedSession.preview} hasMore={sessionPreview?.nextCursor != null} onLoadEarlier={loadEarlierSessionPreview} />
          </div>
          <aside className="session-manager-detail-inspector" aria-label={t("sessionManager.sessionMetadata")}>
            <h2>{t("sessionManager.sessionMetadata")}</h2>
            <div className="session-manager-detail-metadata">
              <div><span>{t("sessionManager.lastUsed")}</span><strong title={focusedRelativeTime ?? undefined}>{displayTime(focusedSession.updatedAt)}</strong></div>
              <div><span>{t("sessionManager.createdAt")}</span><strong>{displayTime(focusedSession.createdAt)}</strong></div>
              <div><span>{t("sessionManager.archivedAt")}</span><strong>{displayTime(focusedSession.archivedAt)}</strong></div>
              <div><span>{t("sessionManager.sourceFilter")}</span><strong>{source?.name ?? focusedSession.sourceId}</strong></div>
              <div><span>{t("sessionManager.sessionType")}</span><strong>{focusedSession.isSubagent ? (focusedSession.subagentNickname ?? t("sessionManager.subagent")) : t("sessionManager.mainSession")}</strong></div>
              <div><span>{t("sessionManager.sessionId")}</span><strong>{focusedSession.threadId}</strong></div>
            </div>
            <div className="session-manager-detail-project">
              <span>{t("sessionManager.projectPath")}</span>
              <code title={focusedSession.cwd ?? undefined}>{focusedSession.cwd ?? t("sessionManager.unknownProject")}</code>
            </div>
            <div className="session-manager-detail-actions">
              <button type="button" className="primary" data-button-elevation="none" onClick={() => void resumeSession(focusedSession)} disabled={resumingKey === focusedSession.key} title={t("sessionManager.continueSession")}>
                <Play size={15} aria-hidden /><span>{resumingKey === focusedSession.key ? t("sessionManager.resuming") : t("sessionManager.resume")}</span>
              </button>
              <button type="button" data-button-elevation="none" onClick={() => deriveSession(focusedSession)} disabled={resumingKey === focusedSession.key || !currentWorkspace} title={t("sessionManager.deriveToCurrentProject")}>
                <GitBranch size={15} aria-hidden /><span>{t("sessionManager.derive")}</span>
              </button>
              {!focusedSession.isArchived && <button type="button" data-button-elevation="none" onClick={() => void manager.archiveSessions([focusedSession])} disabled={manager.archivingKeys.has(focusedSession.key)} title={t("sessionManager.archive")}>
                <Archive size={15} aria-hidden /><span>{t("sessionManager.archive")}</span>
              </button>}
              {focusedSession.isArchived && <button type="button" className="danger" data-button-elevation="none" onClick={() => void requestPermanentDelete([focusedSession])} disabled={manager.deletingKeys.has(focusedSession.key)} title={t("sessionManager.permanentDelete")}>
                <Trash2 size={15} aria-hidden /><span>{t("sessionManager.permanentDelete")}</span>
              </button>}
            </div>
          </aside>
        </>}
      </div>

      {pendingPermanentDeleteSessions && <SessionPermanentDeletePrompt session={pendingPermanentDeleteSessions[0]} sessions={pendingPermanentDeleteSessions} source={manager.sources.find((candidate) => candidate.id === pendingPermanentDeleteSessions[0]?.sourceId)} childCount={pendingPermanentDeleteChildCount} busy={manager.archivingKeys.size > 0 || manager.deletingKeys.size > 0} onCancel={cancelPermanentDelete} onConfirm={(cascade) => void confirmPermanentDelete(cascade)} />}
    </section>
  );
}
