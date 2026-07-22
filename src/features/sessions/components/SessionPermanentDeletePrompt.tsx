import { useState } from "react";
import type { ManagedSession, SessionSource } from "@/types";
import { useI18n } from "@/features/i18n/I18nProvider";
import { ModalShell } from "@/features/design-system/components/modal/ModalShell";

type Props = { session: ManagedSession; sessions?: ManagedSession[]; source?: SessionSource; childCount: number; busy: boolean; onCancel: () => void; onConfirm: (cascade: boolean) => void };

export function SessionPermanentDeletePrompt({ session, sessions = [session], source, childCount, busy, onCancel, onConfirm }: Props) {
  const { t } = useI18n();
  const [acknowledged, setAcknowledged] = useState(false);
  const [cascade, setCascade] = useState(false);
  return <ModalShell className="session-delete-modal" onBackdropClick={busy ? undefined : onCancel} ariaLabel={t("sessionManager.permanentDeleteTitle")}>
    <div className="ds-modal-title">{t("sessionManager.permanentDeleteTitle")}</div>
    <div className="session-delete-risk">{t("sessionManager.permanentDeleteWarning")}</div>
    <div className="session-delete-metadata">
      <div><span>{t("sessionManager.deleteTarget")}</span><strong>{sessions.length > 1 ? `${sessions.length} ${t("sessionManager.sessionsSelected")}` : session.title}</strong></div>
      <div><span>{t("sessionManager.deleteSource")}</span><strong>{source?.name ?? session.sourceId}</strong></div>
      <div><span>{t("sessionManager.deleteArchivedAt")}</span><strong>{session.archivedAt ? new Date(session.archivedAt).toLocaleString() : "-"}</strong></div>
      <div><span>{t("sessionManager.deleteChildrenImpact")}</span><strong>{childCount}</strong></div>
    </div>
    <div className="session-delete-ids">{sessions.map((item) => item.threadId).join("\n")}</div>
    {childCount > 0 && <label className="session-delete-check"><input type="checkbox" checked={cascade} onChange={(event) => setCascade(event.target.checked)} />{t("sessionManager.deleteChildren")} ({childCount})</label>}
    <label className="session-delete-check is-acknowledgement"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />{t("sessionManager.permanentDeleteAcknowledge")}</label>
    <div className="ds-modal-actions"><button type="button" className="ghost ds-modal-button" onClick={onCancel} disabled={busy}>{t("common.cancel")}</button><button type="button" className="primary ds-modal-button" onClick={() => onConfirm(cascade)} disabled={busy || !acknowledged}>{busy ? t("sessionManager.deleting") : t("sessionManager.permanentDeleteConfirm")}</button></div>
  </ModalShell>;
}
