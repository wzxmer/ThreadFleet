import FolderPlus from "lucide-react/dist/esm/icons/folder-plus";
import House from "lucide-react/dist/esm/icons/house";
import PanelLeftClose from "lucide-react/dist/esm/icons/panel-left-close";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import Search from "lucide-react/dist/esm/icons/search";
import type { RefObject } from "react";
import { useI18n } from "@/features/i18n/I18nProvider";
import { SidebarSearchBar } from "./SidebarSearchBar";

type SidebarHeaderProps = {
  onSelectHome: () => void;
  sessionManagerActive: boolean;
  onAddWorkspace: () => void;
  canCollapseSidebar: boolean;
  onCollapseSidebar: () => void;
  onFocusSearch: () => void;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onClearSearch: () => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
  onRefreshAllThreads: () => void;
  refreshDisabled?: boolean;
  refreshInProgress?: boolean;
};

export function SidebarHeader({
  onSelectHome,
  sessionManagerActive,
  onAddWorkspace,
  canCollapseSidebar,
  onCollapseSidebar,
  onFocusSearch,
  searchQuery,
  onSearchQueryChange,
  onClearSearch,
  searchInputRef,
  onRefreshAllThreads,
  refreshDisabled = false,
  refreshInProgress = false,
}: SidebarHeaderProps) {
  const { t } = useI18n();

  return (
    <div className="sidebar-header">
      <div className="sidebar-header-title">
        {sessionManagerActive && (
          <div className="sidebar-object-title" aria-hidden="true">
            <strong>{t("sidebar.sessionsTitle")}</strong>
          </div>
        )}
        <div className="sidebar-title-group">
          <button
            className="sidebar-title-add ds-tooltip-trigger"
            onClick={onAddWorkspace}
            data-button-elevation="none"
            data-tauri-drag-region="false"
            aria-label={t("sidebar.addProject")}
            data-tooltip={t("sidebar.addProject")}
            data-tooltip-align="start"
            data-tooltip-placement="bottom"
            type="button"
          >
            <FolderPlus aria-hidden />
          </button>
          <button
            className="ghost sidebar-refresh-toggle ds-tooltip-trigger"
            onClick={onRefreshAllThreads}
            data-button-elevation="none"
            data-tauri-drag-region="false"
            aria-label={sessionManagerActive ? t("sessionManager.refresh") : t("sidebar.refreshThreads")}
            type="button"
            title={sessionManagerActive ? t("sessionManager.refresh") : t("sidebar.refreshThreads")}
            data-tooltip={sessionManagerActive ? t("sessionManager.refresh") : t("sidebar.refreshThreads")}
            data-tooltip-align="start"
            data-tooltip-placement="bottom"
            disabled={refreshDisabled}
            aria-busy={refreshInProgress}
          >
            <RefreshCw
              className={refreshInProgress ? "sidebar-refresh-icon spinning" : "sidebar-refresh-icon"}
              aria-hidden
            />
          </button>
          <button
            className="sidebar-home-toggle ds-tooltip-trigger"
            onClick={onSelectHome}
            data-button-elevation="none"
            data-tauri-drag-region="false"
            aria-label={t("sidebar.openHome")}
            data-tooltip={t("sidebar.home")}
            data-tooltip-align="start"
            data-tooltip-placement="bottom"
            title={t("sidebar.home")}
            type="button"
          >
            <House aria-hidden />
          </button>
        </div>
      </div>
      <div className="sidebar-header-actions">
        {!sessionManagerActive && (
          <SidebarSearchBar
            isSearchOpen
            searchQuery={searchQuery}
            onSearchQueryChange={onSearchQueryChange}
            onClearSearch={onClearSearch}
            inputRef={searchInputRef}
            autoFocus={false}
          />
        )}
        {!sessionManagerActive && (
          <button
            className={`ghost sidebar-search-toggle ds-tooltip-trigger${searchQuery.trim() ? " is-active" : ""}`}
            onClick={onFocusSearch}
            data-button-elevation="none"
            data-tauri-drag-region="false"
            aria-label={t("sidebar.focusSearch")}
            data-tooltip={t("sidebar.searchThreads")}
            data-tooltip-align="end"
            data-tooltip-placement="bottom"
            type="button"
          >
            <Search aria-hidden />
          </button>
        )}
        {canCollapseSidebar && (
          <button
            className="ghost sidebar-collapse-toggle ds-tooltip-trigger"
            onClick={onCollapseSidebar}
            data-button-elevation="none"
            data-tauri-drag-region="false"
            aria-label={t("sidebar.hideThreadsSidebar")}
            title={t("sidebar.hideThreadsSidebar")}
            data-tooltip={t("sidebar.hideThreadsSidebar")}
            data-tooltip-align="end"
            data-tooltip-placement="bottom"
            type="button"
          >
            <PanelLeftClose aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}
