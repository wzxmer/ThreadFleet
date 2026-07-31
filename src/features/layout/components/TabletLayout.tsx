import type { MouseEvent, ReactNode } from "react";
import type { ActivePanel } from "./panelTypes";
import { MainTopbar } from "../../app/components/MainTopbar";
import { ChatPane } from "./ChatPane";

type TabletLayoutProps = {
  tabletNavNode: ReactNode;
  approvalToastsNode: ReactNode;
  updateToastNode: ReactNode;
  errorToastsNode: ReactNode;
  settingsOpen: boolean;
  settingsNode: ReactNode;
  activePanel: ActivePanel;
  libraryOpen: boolean;
  homeNode: ReactNode;
  showHome: boolean;
  showWorkspace: boolean;
  showProjects: boolean;
  sidebarNode: ReactNode;
  tabletTab: "projects" | "codex" | "git" | "log";
  onSidebarResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  topbarLeftNode: ReactNode;
  topbarActionsNode?: ReactNode;
  messagesNode: ReactNode;
  composerNode: ReactNode;
  gitDiffPanelNode: ReactNode;
  gitDiffViewerNode: ReactNode;
  compactEmptyCodexNode: ReactNode;
  terminalDockNode: ReactNode;
  debugPanelNode: ReactNode;
};

export function TabletLayout({
  tabletNavNode,
  approvalToastsNode,
  updateToastNode,
  errorToastsNode,
  settingsOpen,
  settingsNode,
  activePanel,
  libraryOpen,
  homeNode,
  showHome,
  showWorkspace,
  showProjects,
  sidebarNode,
  tabletTab,
  onSidebarResizeStart,
  topbarLeftNode,
  topbarActionsNode,
  messagesNode,
  composerNode,
  gitDiffPanelNode,
  gitDiffViewerNode,
  compactEmptyCodexNode,
  terminalDockNode,
  debugPanelNode,
}: TabletLayoutProps) {
  const showSettingsPanel = settingsOpen || activePanel === "settings";
  const showLibraryPanel = libraryOpen || activePanel === "library";
  const showHomePanel = activePanel === "home" || showLibraryPanel;
  const showSessionsPanel = activePanel === "sessions";
  const showGitPanel = activePanel === "git";
  const showTerminalPanel = activePanel === "terminal";
  const showActivityPanel = activePanel === "activity" || tabletTab === "log";
  const showSidebarPanel = showSessionsPanel ? showProjects : showLibraryPanel;
  return (
    <>
      {tabletNavNode}
      {showSidebarPanel ? (
        <>
          <div className="tablet-projects">{sidebarNode}</div>
          <div
            className="projects-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize projects"
            onMouseDown={onSidebarResizeStart}
          />
        </>
      ) : null}
      <section className="tablet-main">
        {approvalToastsNode}
        {updateToastNode}
        {errorToastsNode}
        {showSettingsPanel ? (
          <div className="settings-surface-host">{settingsNode}</div>
        ) : null}
        {!showSettingsPanel && showHomePanel && showHome && homeNode}
        {!showSettingsPanel && (showSessionsPanel || showGitPanel || showActivityPanel) && (
          <>
            {(showSessionsPanel || showGitPanel) && (
              <MainTopbar
                leftNode={topbarLeftNode}
                actionsNode={topbarActionsNode}
                className="tablet-topbar"
              />
            )}
            {showSessionsPanel && showWorkspace && (
              <div className="content tablet-content">
                <ChatPane messagesNode={messagesNode} composerNode={composerNode} />
              </div>
            )}
            {showSessionsPanel && !showWorkspace && (
              <div className="tablet-empty-session-surface">{compactEmptyCodexNode}</div>
            )}
            {showGitPanel && (
              <div className="tablet-git">
                {gitDiffPanelNode}
                <div className="tablet-git-viewer">{gitDiffViewerNode}</div>
              </div>
            )}
            {showActivityPanel && debugPanelNode}
          </>
        )}
        {!showSettingsPanel && showTerminalPanel && (
          <div className="tablet-terminal-surface">{terminalDockNode}</div>
        )}
      </section>
    </>
  );
}
