import type { ManagedSession, SessionSearchProgress, SessionSource } from "@/types";
import { useI18n } from "@/features/i18n/I18nProvider";
import { SessionManagerRow } from "./SessionManagerRow";
import { SessionManagerContextMenu, type ContextMenuBoundary } from "./SessionManagerContextMenu";
import { useCallback, useState } from "react";
import { buildManagedSessionTrees, type ManagedSessionTree } from "../utils/sessionHierarchy";

type Props = { sessions: ManagedSession[]; sources: SessionSource[]; selected: Set<string>; focusedKey?: string | null; compact?: boolean; localCount?: number; archivedCount?: number; resumingKey: string | null; archivingKeys: Set<string>; deletingKeys?: Set<string>; loading: boolean; loadingMore: boolean; error: string | null; hasMore: boolean; searchProgress?: SessionSearchProgress | null; onToggleSelected: (key: string) => void; onSelectSingle?: (key: string) => void; onFocus?: (session: ManagedSession) => void; onResume: (session: ManagedSession) => void; onArchive: (session: ManagedSession) => void; onArchiveSelected?: (sessions: ManagedSession[]) => void; onDerive: (session: ManagedSession) => void; onDeriveSelected?: (sessions: ManagedSession[]) => void; onPermanentDelete?: (sessions: ManagedSession[]) => void; onLoadMore: () => void };

export function SessionManagerList(props: Props) {
  const { t } = useI18n();
  const [contextMenu, setContextMenu] = useState<{ sessions: ManagedSession[]; x: number; y: number; boundary: ContextMenuBoundary } | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const showContextMenu = useCallback((event: React.MouseEvent, session: ManagedSession) => {
    event.preventDefault();
    props.onFocus?.(session);
    const targets = props.selected.has(session.key) ? props.sessions.filter((candidate) => props.selected.has(candidate.key)) : [session];
    const boundaryElement = event.currentTarget.closest<HTMLElement>("[data-session-manager-menu-boundary]");
    const boundary = boundaryElement?.getBoundingClientRect() ?? {
      left: 0,
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
    };
    setContextMenu({ sessions: targets, x: event.clientX, y: event.clientY, boundary });
  }, [props]);
  const sourceById = new Map(props.sources.map((source) => [source.id, source]));
  if (props.loading && props.sessions.length === 0) return <div className="session-manager-state">{t("sidebar.loading")}</div>;
  const trees = buildManagedSessionTrees(props.sessions);
  const active = trees.filter((tree) => !tree.root.isArchived);
  const archived = trees.filter((tree) => tree.root.isArchived);
  const renderGroup = (label: string, emptyLabel: string, groupTrees: ManagedSessionTree[], count: number) => (
    <section className="session-manager-group" aria-label={label}>
      <h2 className="session-manager-group-title"><span>{label}</span><strong>{count}</strong></h2>
      {groupTrees.length === 0 && <div className="session-manager-group-empty">{emptyLabel}</div>}
      {groupTrees.flatMap((tree) => tree.rows).map(({ session, depth }) => (
        <SessionManagerRow key={session.key} session={session} source={sourceById.get(session.sourceId)} depth={depth} selected={props.selected.has(session.key)} focused={props.focusedKey === session.key} compact={props.compact} resuming={props.resumingKey === session.key} archiving={props.archivingKeys.has(session.key)} deleting={props.deletingKeys?.has(session.key) ?? false} onToggleSelected={() => props.onToggleSelected(session.key)} onSelectSingle={props.onSelectSingle ? () => props.onSelectSingle?.(session.key) : undefined} onFocus={props.onFocus ? () => props.onFocus?.(session) : undefined} onResume={() => props.onResume(session)} onArchive={() => props.onArchive(session)} onDerive={() => props.onDerive(session)} onPermanentDelete={() => props.onPermanentDelete?.([session])} onContextMenu={showContextMenu} />
      ))}
    </section>
  );
  if (props.error && props.sessions.length === 0) return <div className="session-manager-state is-error">{props.error}</div>;
  return (
    <div className="session-manager-list">
      {contextMenu && <SessionManagerContextMenu sessions={contextMenu.sessions} x={contextMenu.x} y={contextMenu.y} boundary={contextMenu.boundary} busy={props.loading || props.loadingMore || props.resumingKey !== null || props.archivingKeys.size > 0 || Boolean(props.deletingKeys?.size)} onClose={closeContextMenu} onResume={props.onResume} onDerive={(sessions) => { if (props.onDeriveSelected) props.onDeriveSelected(sessions); else sessions.forEach(props.onDerive); }} onArchive={(sessions) => { if (props.onArchiveSelected) props.onArchiveSelected(sessions); else sessions.forEach(props.onArchive); }} onPermanentDelete={props.onPermanentDelete ?? (() => {})} />}
      {props.searchProgress && !props.searchProgress.completed && <div className="session-manager-search-progress">{t("sessionManager.searching")}</div>}
      {props.searchProgress?.incomplete && <div className="session-manager-search-progress is-warning">{t("sessionManager.searchIncomplete")}</div>}
      {props.loading && props.sessions.length > 0 && <div className="session-manager-search-progress">{t("sidebar.loading")}</div>}
      {props.error && props.sessions.length > 0 && <div className="session-manager-search-progress is-warning">{props.error}</div>}
      {props.sessions.length === 0 ? <div className="session-manager-state">{t("sessionManager.empty")}</div> : <>{renderGroup(t("sessionManager.activeGroup"), t("sessionManager.localEmpty"), active, props.localCount ?? active.length)}{renderGroup(t("sessionManager.archivedGroup"), t("sessionManager.archivedEmpty"), archived, props.archivedCount ?? archived.length)}</>}
      {props.hasMore && <button type="button" className="session-manager-load-more" onClick={props.onLoadMore} disabled={props.loadingMore}>{props.loadingMore ? t("sidebar.loading") : t("sessionManager.loadMore")}</button>}
    </div>
  );
}
