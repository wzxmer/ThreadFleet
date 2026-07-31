import type { ReactNode } from "react";
import { MainTopbar } from "../../app/components/MainTopbar";
import { ChatPane } from "./ChatPane";

type PhoneLayoutProps = {
  approvalToastsNode: ReactNode;
  updateToastNode: ReactNode;
  errorToastsNode: ReactNode;
  settingsOpen: boolean;
  settingsNode: ReactNode;
  tabBarNode: ReactNode;
  homeNode: ReactNode;
  sidebarNode: ReactNode;
  activeTab: "home" | "projects" | "codex" | "git" | "log";
  activeWorkspace: boolean;
  showGitDetail: boolean;
  compactEmptyCodexNode: ReactNode;
  compactEmptyGitNode: ReactNode;
  compactGitBackNode: ReactNode;
  topbarLeftNode: ReactNode;
  topbarActionsNode?: ReactNode;
  messagesNode: ReactNode;
  composerNode: ReactNode;
  gitDiffPanelNode: ReactNode;
  gitDiffViewerNode: ReactNode;
  debugPanelNode: ReactNode;
};

export function PhoneLayout({
  approvalToastsNode,
  updateToastNode,
  errorToastsNode,
  settingsOpen,
  settingsNode,
  tabBarNode,
  homeNode,
  sidebarNode,
  activeTab,
  activeWorkspace,
  showGitDetail,
  compactEmptyCodexNode,
  compactEmptyGitNode,
  compactGitBackNode,
  topbarLeftNode,
  topbarActionsNode,
  messagesNode,
  composerNode,
  gitDiffPanelNode,
  gitDiffViewerNode,
  debugPanelNode,
}: PhoneLayoutProps) {
  return (
    <div className="compact-shell">
      {approvalToastsNode}
      {updateToastNode}
      {errorToastsNode}
      {settingsOpen ? (
        <div className="compact-panel">{settingsNode}</div>
      ) : (
        <>
      {activeTab === "home" && <div className="compact-panel">{homeNode}</div>}
      {activeTab === "projects" && <div className="compact-panel">{sidebarNode}</div>}
      {activeTab === "codex" && (
        <div className="compact-panel">
          {activeWorkspace ? (
            <>
              <MainTopbar
                leftNode={topbarLeftNode}
                actionsNode={topbarActionsNode}
                className="compact-topbar"
              />
              <div className="content compact-content">
                <ChatPane messagesNode={messagesNode} composerNode={composerNode} />
              </div>
            </>
          ) : (
            compactEmptyCodexNode
          )}
        </div>
      )}
      {activeTab === "git" && (
        <div className="compact-panel">
          {!activeWorkspace && compactEmptyGitNode}
          {activeWorkspace && (
            <>
              <MainTopbar
                leftNode={topbarLeftNode}
                actionsNode={topbarActionsNode}
                className="compact-topbar"
              />
              {compactGitBackNode}
              {showGitDetail ? (
                <div className="compact-git-viewer">{gitDiffViewerNode}</div>
              ) : (
                <div className="compact-git">
                  <div className="compact-git-list">{gitDiffPanelNode}</div>
                </div>
              )}
            </>
          )}
        </div>
      )}
      {activeTab === "log" && (
        <div className="compact-panel">{debugPanelNode}</div>
      )}
      {tabBarNode}
        </>
      )}
    </div>
  );
}
