import type { MouseEvent } from "react";

import type { WorkspaceInfo } from "../../../types";
import { useI18n } from "@/features/i18n/I18nProvider";

type WorktreeCardProps = {
  worktree: WorkspaceInfo;
  isActive: boolean;
  isDeleting?: boolean;
  onShowWorktreeMenu: (event: MouseEvent, worktree: WorkspaceInfo) => void;
  onToggleWorkspaceCollapse: (workspaceId: string, collapsed: boolean) => void;
  onConnectWorkspace: (workspace: WorkspaceInfo) => void;
  children?: React.ReactNode;
};

export function WorktreeCard({
  worktree,
  isActive,
  isDeleting = false,
  onShowWorktreeMenu,
  onToggleWorkspaceCollapse,
  onConnectWorkspace,
  children,
}: WorktreeCardProps) {
  const { t } = useI18n();
  const worktreeCollapsed = worktree.settings.sidebarCollapsed;
  const worktreeBranch = worktree.worktree?.branch ?? "";
  const worktreeLabel = worktree.name?.trim() || worktreeBranch;
  const worktreeMeta =
    worktreeBranch && worktreeBranch !== worktreeLabel ? worktreeBranch : null;
  const contentCollapsedClass = worktreeCollapsed ? " collapsed" : "";
  const toggleWorktree = () => {
    if (!isDeleting) {
      onToggleWorkspaceCollapse(worktree.id, !worktreeCollapsed);
    }
  };

  return (
    <div className={`worktree-card${isDeleting ? " deleting" : ""}`}>
      <div
        className={`worktree-row ${isActive ? "active" : ""}${isDeleting ? " deleting" : ""}`}
        role="button"
        tabIndex={isDeleting ? -1 : 0}
        aria-disabled={isDeleting}
        onClick={toggleWorktree}
        onContextMenu={(event) => {
          if (!isDeleting) {
            onShowWorktreeMenu(event, worktree);
          }
        }}
        onKeyDown={(event) => {
          if (isDeleting) {
            return;
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleWorktree();
          }
        }}
      >
        <div className="worktree-copy">
          <div className="worktree-label">{worktreeLabel}</div>
          {worktreeMeta && <div className="worktree-meta">{worktreeMeta}</div>}
        </div>
        <div className="worktree-actions">
          {isDeleting ? (
            <div className="worktree-deleting" role="status" aria-live="polite">
              <span className="worktree-deleting-spinner" aria-hidden />
              <span className="worktree-deleting-label">{t("sidebar.deleting")}</span>
            </div>
          ) : (
            <>
              <button
                className={`worktree-toggle ${worktreeCollapsed ? "" : "expanded"}`}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleWorktree();
                }}
                data-tauri-drag-region="false"
                aria-label={
                  worktreeCollapsed ? t("sidebar.showAgents") : t("sidebar.hideAgents")
                }
                aria-expanded={!worktreeCollapsed}
              >
                <span className="worktree-toggle-icon">›</span>
              </button>
              {!worktree.connected && (
                <span
                  className="connect"
                  title={t("sidebar.connectContext")}
                  onClick={(event) => {
                    event.stopPropagation();
                    onConnectWorkspace(worktree);
                  }}
                >
                  {t("sidebar.connect")}
                </span>
              )}
            </>
          )}
        </div>
      </div>
      <div
        className={`worktree-card-content${contentCollapsedClass}`}
        aria-hidden={worktreeCollapsed}
        inert={worktreeCollapsed ? true : undefined}
      >
        <div className="worktree-card-content-inner">
          {worktreeCollapsed ? null : children}
        </div>
      </div>
    </div>
  );
}
