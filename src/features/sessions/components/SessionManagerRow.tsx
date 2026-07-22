import type { ManagedSession, SessionSource } from "@/types";
import { formatLocalDateTime, formatRelativeTimeShort } from "@/utils/time";
import { useI18n } from "@/features/i18n/I18nProvider";
import type { CSSProperties } from "react";

type Props = {
  session: ManagedSession;
  source?: SessionSource;
  depth?: number;
  selected: boolean;
  resuming: boolean;
  archiving: boolean;
  deleting: boolean;
  compact?: boolean;
  focused?: boolean;
  onToggleSelected: () => void;
  onSelectSingle?: () => void;
  onFocus?: () => void;
  onResume: () => void;
  onArchive: () => void;
  onDerive: () => void;
  onPermanentDelete: () => void;
  onContextMenu?: (event: React.MouseEvent, session: ManagedSession) => void;
};

export function SessionManagerRow({ session, source, depth = 0, selected, resuming, archiving, deleting, compact = false, focused = false, onToggleSelected, onSelectSingle, onFocus, onResume, onArchive, onDerive, onPermanentDelete, onContextMenu }: Props) {
  const { t } = useI18n();
  const absoluteTime = session.updatedAt
    ? formatLocalDateTime(session.updatedAt)
    : null;
  const relativeTime = session.updatedAt
    ? formatRelativeTimeShort(session.updatedAt)
    : null;
  const selectRow = () => {
    onSelectSingle?.();
    onFocus?.();
  };
  const handleRowClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button, input")) return;
    selectRow();
  };
  return (
    <div className={`session-manager-row${selected ? " is-selected" : ""}${focused ? " is-focused" : ""}${compact ? " is-compact" : ""}${depth > 0 ? " is-child" : ""}`} style={{ "--session-manager-depth": depth } as CSSProperties} onClick={handleRowClick} onContextMenu={(event) => onContextMenu?.(event, session)}>
      <button type="button" className="session-manager-row-select" data-button-elevation="none" onClick={onToggleSelected} aria-label={`${t("sessionManager.select")} ${session.title}`}>
        <input type="checkbox" checked={selected} readOnly tabIndex={-1} />
      </button>
      <button type="button" className="session-manager-row-content" data-button-elevation="none" onClick={selectRow} onDoubleClick={!resuming && onFocus ? onResume : undefined} aria-busy={resuming} aria-pressed={selected}>
        <span className="session-manager-row-title">{session.title}</span>
        <span className="session-manager-row-path">{session.cwd ?? t("sessionManager.unknownProject")}</span>
        {!compact && session.preview && <span className="session-manager-row-preview">{session.preview}</span>}
        <span className="session-manager-row-tags">
          <span>{source?.name ?? session.sourceId}</span>
          <span>{session.isSubagent ? (session.subagentNickname ?? t("sessionManager.subagent")) : t("sessionManager.mainSession")}</span>
          {!session.projectExists && <span className="is-warning">{t("sessionManager.projectMissing")}</span>}
        </span>
      </button>
      <span className="session-manager-row-time" title={relativeTime ?? undefined}>
        {absoluteTime ?? "—"}
      </span>
      {!compact && <span className="session-manager-row-actions">
        <button type="button" className="session-manager-row-resume" data-button-elevation="none" onClick={onResume} disabled={resuming || archiving || !session.projectExists}>
          {resuming ? t("sessionManager.resuming") : t("sessionManager.resume")}
        </button>
        <button type="button" className="session-manager-row-archive" data-button-elevation="none" onClick={onArchive} disabled={archiving || session.isArchived}>
          {archiving ? t("sessionManager.archiving") : t("sessionManager.archive")}
        </button>
        <button type="button" className="session-manager-row-derive" data-button-elevation="none" onClick={onDerive} disabled={archiving || resuming}>
          {t("sessionManager.derive")}
        </button>
        {session.isArchived && <button type="button" className="session-manager-row-delete" data-button-elevation="none" onClick={onPermanentDelete} disabled={deleting || archiving || resuming}>{deleting ? t("sessionManager.deleting") : t("sessionManager.permanentDelete")}</button>}
      </span>}
    </div>
  );
}
