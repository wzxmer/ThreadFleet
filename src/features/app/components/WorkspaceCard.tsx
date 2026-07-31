import type { MouseEvent } from "react";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import Ellipsis from "lucide-react/dist/esm/icons/ellipsis";
import Folder from "lucide-react/dist/esm/icons/folder";
import Plus from "lucide-react/dist/esm/icons/plus";

import type { WorkspaceInfo } from "../../../types";
import { useI18n } from "@/features/i18n/I18nProvider";

type WorkspaceCardProps = {
  workspace: WorkspaceInfo;
  workspaceName?: React.ReactNode;
  threadCount?: number;
  summary?: string | null;
  isActive: boolean;
  isCollapsed: boolean;
  isPinned?: boolean;
  addMenuOpen: boolean;
  addMenuWidth: number;
  hideAddButton?: boolean;
  hideConnectButton?: boolean;
  onAddAgent: (workspace: WorkspaceInfo) => void;
  onShowWorkspaceMenu: (event: MouseEvent, workspaceId: string) => void;
  onToggleWorkspaceCollapse: (workspaceId: string, collapsed: boolean) => void;
  onConnectWorkspace: (workspace: WorkspaceInfo) => void;
  onToggleAddMenu: (anchor: {
    workspaceId: string;
    top: number;
    left: number;
    width: number;
  } | null) => void;
  children?: React.ReactNode;
};

export function WorkspaceCard({
  workspace,
  workspaceName,
  threadCount,
  summary = null,
  isActive,
  isCollapsed,
  isPinned = false,
  addMenuOpen,
  addMenuWidth,
  hideAddButton = false,
  hideConnectButton = false,
  onAddAgent,
  onShowWorkspaceMenu,
  onToggleWorkspaceCollapse,
  onConnectWorkspace,
  onToggleAddMenu,
  children,
}: WorkspaceCardProps) {
  const { t } = useI18n();
  const contentCollapsedClass = isCollapsed ? " collapsed" : "";
  const toggleWorkspace = () => {
    onToggleWorkspaceCollapse(workspace.id, !isCollapsed);
  };

  return (
    <div className="workspace-card">
      <div
        className={`workspace-row ${isActive ? "active" : ""}${isPinned ? " is-pinned" : ""}`}
        role="button"
        tabIndex={0}
        onClick={toggleWorkspace}
        onContextMenu={(event) => onShowWorkspaceMenu(event, workspace.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleWorkspace();
          }
        }}
      >
        <div className="workspace-copy">
          <div className="workspace-name-row">
            <div className="workspace-title">
              <button
                className={`workspace-toggle ${isCollapsed ? "" : "expanded"}`}
                data-button-elevation="none"
                onClick={(event) => {
                  event.stopPropagation();
                  toggleWorkspace();
                }}
                data-tauri-drag-region="false"
                aria-label={isCollapsed ? t("sidebar.showAgents") : t("sidebar.hideAgents")}
                aria-expanded={!isCollapsed}
              >
                <ChevronRight className="workspace-toggle-icon" aria-hidden />
              </button>
              <Folder className="workspace-folder-icon" aria-hidden />
              <span className="workspace-name">{workspaceName ?? workspace.name}</span>
              {typeof threadCount === "number" && (
                <span className="workspace-thread-count" aria-hidden>
                  {threadCount}
                </span>
              )}
            </div>
          </div>
          {summary && <div className="workspace-summary">{summary}</div>}
        </div>
        <div className="workspace-actions">
          {!hideAddButton && (
            <>
              <button
                className="ghost workspace-add workspace-add-direct"
                onClick={(event) => {
                  event.stopPropagation();
                  onAddAgent(workspace);
                }}
                data-tauri-drag-region="false"
                aria-label={t("sidebar.createNow")}
                title={t("sidebar.newAgent")}
              >
                <Plus size={14} aria-hidden />
              </button>
              <button
                className="ghost workspace-add workspace-more"
                onClick={(event) => {
                  event.stopPropagation();
                  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                  const left = Math.min(
                    Math.max(rect.left, 12),
                    window.innerWidth - addMenuWidth - 12,
                  );
                  const top = rect.bottom + 8;
                  onToggleAddMenu(
                    addMenuOpen
                      ? null
                      : {
                          workspaceId: workspace.id,
                          top,
                          left,
                          width: addMenuWidth,
                        },
                  );
                }}
                data-tauri-drag-region="false"
                aria-label={t("sidebar.moreAgentOptions")}
                title={t("sidebar.moreAgentOptions")}
                aria-expanded={addMenuOpen}
              >
                <Ellipsis size={15} aria-hidden />
              </button>
            </>
          )}
          {!hideConnectButton && !workspace.connected && (
            <span
              className="connect"
              title={t("sidebar.connectContext")}
              onClick={(event) => {
                event.stopPropagation();
                onConnectWorkspace(workspace);
              }}
            >
              {t("sidebar.connect")}
            </span>
          )}
        </div>
      </div>
      <div
        className={`workspace-card-content${contentCollapsedClass}`}
        aria-hidden={isCollapsed}
        inert={isCollapsed ? true : undefined}
      >
        <div className="workspace-card-content-inner">{children}</div>
      </div>
    </div>
  );
}
