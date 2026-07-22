import Archive from "lucide-react/dist/esm/icons/archive";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import X from "lucide-react/dist/esm/icons/x";
import { useI18n } from "@/features/i18n/I18nProvider";
import { useSessionManagerContext } from "../context/SessionManagerContext";

export function SessionManagerBatchBar() {
  const { t } = useI18n();
  const { manager, deriveSessions, requestPermanentDelete } = useSessionManagerContext();
  const selected = manager.indexedSessions.filter((session) => manager.selectedSessionKeys.has(session.key));
  if (selected.length === 0) return null;
  const active = selected.filter((session) => !session.isArchived);
  const allArchived = active.length === 0;
  const busy = manager.archivingKeys.size > 0 || manager.deletingKeys.size > 0;
  return (
    <div className="session-manager-batch-bar">
      <span>{t("sessionManager.selectedCount")} <strong>{selected.length}</strong></span>
      <div>
        <button type="button" data-button-elevation="none" onClick={() => deriveSessions(selected)} disabled={busy} title={t("sessionManager.deriveSelectedToCurrentProject")}><GitBranch size={14} aria-hidden /></button>
        <button type="button" data-button-elevation="none" onClick={() => void manager.archiveSessions(active)} disabled={busy || active.length === 0} title={t("sessionManager.archiveSelected")}><Archive size={14} aria-hidden /></button>
        <button type="button" className="is-danger" data-button-elevation="none" onClick={() => void requestPermanentDelete(selected)} disabled={busy || !allArchived} title={t("sessionManager.permanentDeleteSelected")}><Trash2 size={14} aria-hidden /></button>
        <button type="button" data-button-elevation="none" onClick={manager.clearSelection} disabled={busy} title={t("sessionManager.clearSelection")}><X size={14} aria-hidden /></button>
      </div>
    </div>
  );
}
