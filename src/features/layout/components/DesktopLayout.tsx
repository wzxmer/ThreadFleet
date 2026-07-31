import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import type { ActivePanel } from "./panelTypes";
import { MainTopbar } from "../../app/components/MainTopbar";
import { ChatPane } from "./ChatPane";

type CenterMode = "chat" | "diff";

function shouldRenderDiffViewer({
  splitChatDiffView,
  preloadGitDiffs,
  centerMode,
}: {
  splitChatDiffView: boolean;
  preloadGitDiffs: boolean;
  centerMode: CenterMode;
}) {
  return splitChatDiffView || preloadGitDiffs || centerMode === "diff";
}

function isActiveLayer(centerMode: CenterMode, layer: CenterMode) {
  return centerMode === layer;
}

function layerClassName({
  splitChatDiffView,
  layer,
  isActive,
}: {
  splitChatDiffView: boolean;
  layer: CenterMode;
  isActive: boolean;
}) {
  if (splitChatDiffView) {
    return `content-layer content-layer-split content-layer-${layer}${
      isActive ? " is-active" : ""
    }`;
  }
  return `content-layer ${isActive ? "is-active" : "is-hidden"}`;
}

function setLayerInert(
  layer: HTMLDivElement | null,
  isActive: boolean,
  splitChatDiffView: boolean,
) {
  if (!layer) {
    return;
  }

  if (splitChatDiffView || isActive) {
    layer.removeAttribute("inert");
    return;
  }

  layer.setAttribute("inert", "");
}

type DesktopLayoutProps = {
  tabletNavNode: ReactNode;
  sidebarNode: ReactNode;
  updateToastNode: ReactNode;
  approvalToastsNode: ReactNode;
  errorToastsNode: ReactNode;
  activePanel: ActivePanel;
  libraryOpen: boolean;
  homeNode: ReactNode;
  showWorkspace: boolean;
  topbarLeftNode: ReactNode;
  topbarActionsNode?: ReactNode;
  centerMode: "chat" | "diff";
  preloadGitDiffs: boolean;
  splitChatDiffView: boolean;
  messagesNode: ReactNode;
  gitDiffViewerNode: ReactNode;
  gitDiffPanelNode: ReactNode;
  planPanelNode: ReactNode;
  composerNode: ReactNode;
  terminalDockNode: ReactNode;
  settingsOpen: boolean;
  settingsNode: ReactNode;
  debugPanelNode: ReactNode;
  debugPanelFullNode: ReactNode;
  compactEmptyCodexNode: ReactNode;
  compactEmptyGitNode: ReactNode;
  hasActivePlan: boolean;
  onSidebarResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  onChatDiffSplitPositionResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  onRightPanelResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  onPlanPanelResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
};

export function DesktopLayout({
  tabletNavNode,
  sidebarNode,
  updateToastNode,
  approvalToastsNode,
  errorToastsNode,
  activePanel,
  libraryOpen,
  homeNode,
  showWorkspace,
  topbarLeftNode,
  topbarActionsNode,
  centerMode,
  preloadGitDiffs,
  splitChatDiffView,
  messagesNode,
  gitDiffViewerNode,
  gitDiffPanelNode,
  planPanelNode,
  composerNode,
  terminalDockNode,
  settingsOpen,
  settingsNode,
  debugPanelNode,
  debugPanelFullNode,
  compactEmptyCodexNode,
  compactEmptyGitNode,
  hasActivePlan,
  onSidebarResizeStart,
  onRightPanelResizeStart,
  onPlanPanelResizeStart,
  onChatDiffSplitPositionResizeStart,
}: DesktopLayoutProps) {
  const diffLayerRef = useRef<HTMLDivElement | null>(null);
  const chatLayerRef = useRef<HTMLDivElement | null>(null);
  const chatPaneNode = <ChatPane messagesNode={messagesNode} composerNode={composerNode} />;
  const diffLayerActive = isActiveLayer(centerMode, "diff");
  const chatLayerActive = isActiveLayer(centerMode, "chat");
  const showDiffViewer = shouldRenderDiffViewer({
    splitChatDiffView,
    preloadGitDiffs,
    centerMode,
  });
  const showSessionsPanel = activePanel === "sessions";
  const showLibraryPanel = libraryOpen || activePanel === "library";
  const showHomePanel = activePanel === "home" || showLibraryPanel;
  const showGitPanel = activePanel === "git";
  const showTerminalPanel = activePanel === "terminal";
  const showActivityPanel = activePanel === "activity";
  const showSettingsPanel = settingsOpen || activePanel === "settings";
  const showSidebarPanel = showSessionsPanel || showLibraryPanel;

  useEffect(() => {
    const diffLayer = diffLayerRef.current;
    const chatLayer = chatLayerRef.current;
    setLayerInert(diffLayer, diffLayerActive, splitChatDiffView);
    setLayerInert(chatLayer, chatLayerActive, splitChatDiffView);

    if (splitChatDiffView) {
      return;
    }

    const hiddenLayer = diffLayerActive ? chatLayer : diffLayer;
    const activeElement = document.activeElement;
    if (
      hiddenLayer &&
      activeElement instanceof HTMLElement &&
      hiddenLayer.contains(activeElement)
    ) {
      activeElement.blur();
    }
  }, [chatLayerActive, diffLayerActive, splitChatDiffView]);

  return (
    <>
      {tabletNavNode}
      {showSidebarPanel ? (
        <>
          {sidebarNode}
          <div
            className="sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            onMouseDown={onSidebarResizeStart}
          />
        </>
      ) : null}

      <section className="main">
        {updateToastNode}
        {errorToastsNode}
        {showSettingsPanel ? (
          <div className="settings-surface-host">{settingsNode}</div>
        ) : null}
        {!showSettingsPanel && showHomePanel && homeNode}
        {!showSettingsPanel && showGitPanel && (
          <div className="desktop-git-surface">
            {showWorkspace ? (
              <>
                <div className="desktop-git-sidebar">{gitDiffPanelNode}</div>
                <div className="desktop-git-viewer">{gitDiffViewerNode}</div>
              </>
            ) : (
              compactEmptyGitNode
            )}
          </div>
        )}
        {!showSettingsPanel && showTerminalPanel && (
          <div className="desktop-terminal-surface">{terminalDockNode}</div>
        )}
        {!showSettingsPanel && showActivityPanel && (
          <div className="desktop-activity-surface">{debugPanelFullNode}</div>
        )}
        {!showSettingsPanel && showSessionsPanel && !showWorkspace && (
          <div className="desktop-empty-session-surface">{compactEmptyCodexNode}</div>
        )}

        {!showSettingsPanel && showSessionsPanel && showWorkspace && (
          <>
            <MainTopbar leftNode={topbarLeftNode} actionsNode={topbarActionsNode} />
            {approvalToastsNode}
            <div className={`content${splitChatDiffView ? " content-split" : ""}`}>
              {splitChatDiffView ? (
                <>
                  <div
                    className={layerClassName({
                      splitChatDiffView,
                      layer: "chat",
                      isActive: chatLayerActive,
                    })}
                    ref={chatLayerRef}
                  >
                    {chatPaneNode}
                  </div>
                  <div
                    className="content-split-resizer"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize chat/diff split"
                    onMouseDown={onChatDiffSplitPositionResizeStart}
                  />
                  <div
                    className={layerClassName({
                      splitChatDiffView,
                      layer: "diff",
                      isActive: diffLayerActive,
                    })}
                    ref={diffLayerRef}
                  >
                    {showDiffViewer ? gitDiffViewerNode : null}
                  </div>
                </>
              ) : (
                <>
                  <div
                    className={layerClassName({
                      splitChatDiffView,
                      layer: "diff",
                      isActive: diffLayerActive,
                    })}
                    aria-hidden={!splitChatDiffView ? !diffLayerActive : undefined}
                    ref={diffLayerRef}
                  >
                    {showDiffViewer ? gitDiffViewerNode : null}
                  </div>
                  <div
                    className={layerClassName({
                      splitChatDiffView,
                      layer: "chat",
                      isActive: chatLayerActive,
                    })}
                    aria-hidden={!splitChatDiffView ? !chatLayerActive : undefined}
                    ref={chatLayerRef}
                  >
                    {chatPaneNode}
                  </div>
                </>
              )}
            </div>

            <div
              className="right-panel-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize right panel"
              onMouseDown={onRightPanelResizeStart}
            />
            <div className={`right-panel ${hasActivePlan ? "" : "plan-collapsed"}`}>
              <div className="right-panel-drag-strip" />
              <div className="right-panel-top">{gitDiffPanelNode}</div>
              <div
                className="right-panel-divider"
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize plan panel"
                onMouseDown={onPlanPanelResizeStart}
              />
              <div className="right-panel-bottom">{planPanelNode}</div>
            </div>
            {terminalDockNode}
          </>
        )}
        {showSessionsPanel ? debugPanelNode : null}
      </section>
    </>
  );
}
