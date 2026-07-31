// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopLayout } from "./DesktopLayout";
import { TabletLayout } from "./TabletLayout";

afterEach(cleanup);

function renderDesktopSettingsSurface() {
  render(
    <DesktopLayout
      tabletNavNode={<nav aria-label="rail">rail</nav>}
      sidebarNode={<aside aria-label="session-list">session list</aside>}
      updateToastNode={null}
      approvalToastsNode={<div>approval toast</div>}
      errorToastsNode={null}
      activePanel="settings"
      libraryOpen={false}
      homeNode={<div>home view</div>}
      showWorkspace
      topbarLeftNode={<div>workspace topbar</div>}
      centerMode="chat"
      preloadGitDiffs={false}
      splitChatDiffView={false}
      messagesNode={<div>messages view</div>}
      gitDiffViewerNode={<div>diff viewer</div>}
      gitDiffPanelNode={<div>git panel</div>}
      planPanelNode={<div>plan panel</div>}
      composerNode={<div>composer</div>}
      terminalDockNode={<div>terminal dock</div>}
      settingsOpen
      settingsNode={<div>settings surface</div>}
      debugPanelNode={null}
      debugPanelFullNode={<div>debug full</div>}
      compactEmptyCodexNode={<div>empty codex</div>}
      compactEmptyGitNode={<div>empty git</div>}
      hasActivePlan={false}
      onSidebarResizeStart={vi.fn()}
      onChatDiffSplitPositionResizeStart={vi.fn()}
      onRightPanelResizeStart={vi.fn()}
      onPlanPanelResizeStart={vi.fn()}
    />,
  );
}

function renderTabletSettingsSurface() {
  render(
    <TabletLayout
      tabletNavNode={<nav aria-label="rail">rail</nav>}
      approvalToastsNode={null}
      updateToastNode={null}
      errorToastsNode={null}
      settingsOpen
      settingsNode={<div>settings surface</div>}
      activePanel="settings"
      libraryOpen={false}
      homeNode={<div>home view</div>}
      showHome={false}
      showWorkspace
      showProjects
      sidebarNode={<aside aria-label="session-list">session list</aside>}
      tabletTab="codex"
      onSidebarResizeStart={vi.fn()}
      topbarLeftNode={<div>workspace topbar</div>}
      messagesNode={<div>messages view</div>}
      composerNode={<div>composer</div>}
      gitDiffPanelNode={<div>git panel</div>}
      gitDiffViewerNode={<div>diff viewer</div>}
      compactEmptyCodexNode={<div>empty codex</div>}
      terminalDockNode={<div>terminal dock</div>}
      debugPanelNode={<div>debug panel</div>}
    />,
  );
}

describe("settings surface layout", () => {
  it("hides the desktop session list and workspace chrome while settings is open", () => {
    renderDesktopSettingsSurface();

    expect(screen.getByText("settings surface")).toBeTruthy();
    expect(screen.queryByLabelText("session-list")).toBeNull();
    expect(screen.queryByRole("separator", { name: "Resize sidebar" })).toBeNull();
    expect(screen.queryByText("workspace topbar")).toBeNull();
    expect(screen.queryByText("messages view")).toBeNull();
    expect(screen.getByLabelText("rail")).toBeTruthy();
  });

  it("hides the tablet session list even if the projects rail state is open", () => {
    renderTabletSettingsSurface();

    expect(screen.getByText("settings surface")).toBeTruthy();
    expect(screen.queryByLabelText("session-list")).toBeNull();
    expect(screen.queryByRole("separator", { name: "Resize projects" })).toBeNull();
    expect(screen.queryByText("workspace topbar")).toBeNull();
    expect(screen.queryByText("messages view")).toBeNull();
    expect(screen.getByLabelText("rail")).toBeTruthy();
  });

  it("uses the desktop rail destination as the owner of the main surface", () => {
    render(
      <DesktopLayout
        tabletNavNode={<nav aria-label="rail">rail</nav>}
        sidebarNode={<aside aria-label="session-list">session list</aside>}
        updateToastNode={null}
        approvalToastsNode={null}
        errorToastsNode={null}
        activePanel="git"
        libraryOpen={false}
        homeNode={<div>home view</div>}
        showWorkspace
        topbarLeftNode={<div>workspace topbar</div>}
        centerMode="chat"
        preloadGitDiffs={false}
        splitChatDiffView={false}
        messagesNode={<div>messages view</div>}
        gitDiffViewerNode={<div>diff viewer</div>}
        gitDiffPanelNode={<div>git panel</div>}
        planPanelNode={<div>plan panel</div>}
        composerNode={<div>composer</div>}
        terminalDockNode={<div>terminal dock</div>}
        settingsOpen={false}
        settingsNode={null}
        debugPanelNode={<div>debug dock</div>}
        debugPanelFullNode={<div>debug full</div>}
        compactEmptyCodexNode={<div>empty codex</div>}
        compactEmptyGitNode={<div>empty git</div>}
        hasActivePlan={false}
        onSidebarResizeStart={vi.fn()}
        onChatDiffSplitPositionResizeStart={vi.fn()}
        onRightPanelResizeStart={vi.fn()}
        onPlanPanelResizeStart={vi.fn()}
      />,
    );

    expect(screen.getByText("git panel")).toBeTruthy();
    expect(screen.getByText("diff viewer")).toBeTruthy();
    expect(screen.queryByLabelText("session-list")).toBeNull();
    expect(screen.queryByText("messages view")).toBeNull();
    expect(screen.queryByText("plan panel")).toBeNull();
  });

  it("renders terminal as a rail-owned desktop surface without the session list", () => {
    render(
      <DesktopLayout
        tabletNavNode={<nav aria-label="rail">rail</nav>}
        sidebarNode={<aside aria-label="session-list">session list</aside>}
        updateToastNode={null}
        approvalToastsNode={null}
        errorToastsNode={null}
        activePanel="terminal"
        libraryOpen={false}
        homeNode={<div>home view</div>}
        showWorkspace
        topbarLeftNode={<div>workspace topbar</div>}
        centerMode="chat"
        preloadGitDiffs={false}
        splitChatDiffView={false}
        messagesNode={<div>messages view</div>}
        gitDiffViewerNode={<div>diff viewer</div>}
        gitDiffPanelNode={<div>git panel</div>}
        planPanelNode={<div>plan panel</div>}
        composerNode={<div>composer</div>}
        terminalDockNode={<div>terminal dock</div>}
        settingsOpen={false}
        settingsNode={null}
        debugPanelNode={<div>debug dock</div>}
        debugPanelFullNode={<div>debug full</div>}
        compactEmptyCodexNode={<div>empty codex</div>}
        compactEmptyGitNode={<div>empty git</div>}
        hasActivePlan={false}
        onSidebarResizeStart={vi.fn()}
        onChatDiffSplitPositionResizeStart={vi.fn()}
        onRightPanelResizeStart={vi.fn()}
        onPlanPanelResizeStart={vi.fn()}
      />,
    );

    expect(screen.getByText("terminal dock")).toBeTruthy();
    expect(screen.queryByLabelText("session-list")).toBeNull();
    expect(screen.queryByText("messages view")).toBeNull();
  });

  it("keeps the session manager list and workspace together when library is open", () => {
    render(
      <DesktopLayout
        tabletNavNode={<nav aria-label="rail">rail</nav>}
        sidebarNode={<aside aria-label="session-manager-list">session manager list</aside>}
        updateToastNode={null}
        approvalToastsNode={null}
        errorToastsNode={null}
        activePanel="sessions"
        libraryOpen
        homeNode={<div>session manager workspace</div>}
        showWorkspace={false}
        topbarLeftNode={<div>workspace topbar</div>}
        centerMode="chat"
        preloadGitDiffs={false}
        splitChatDiffView={false}
        messagesNode={<div>messages view</div>}
        gitDiffViewerNode={<div>diff viewer</div>}
        gitDiffPanelNode={<div>git panel</div>}
        planPanelNode={<div>plan panel</div>}
        composerNode={<div>composer</div>}
        terminalDockNode={<div>terminal dock</div>}
        settingsOpen={false}
        settingsNode={null}
        debugPanelNode={<div>debug dock</div>}
        debugPanelFullNode={<div>debug full</div>}
        compactEmptyCodexNode={<div>empty codex</div>}
        compactEmptyGitNode={<div>empty git</div>}
        hasActivePlan={false}
        onSidebarResizeStart={vi.fn()}
        onChatDiffSplitPositionResizeStart={vi.fn()}
        onRightPanelResizeStart={vi.fn()}
        onPlanPanelResizeStart={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("session-manager-list")).toBeTruthy();
    expect(screen.getByText("session manager workspace")).toBeTruthy();
    expect(screen.queryByText("messages view")).toBeNull();
  });

  it("shows the desktop Codex empty state when sessions has no active workspace", () => {
    render(
      <DesktopLayout
        tabletNavNode={<nav aria-label="rail">rail</nav>}
        sidebarNode={<aside aria-label="session-list">session list</aside>}
        updateToastNode={null}
        approvalToastsNode={null}
        errorToastsNode={null}
        activePanel="sessions"
        libraryOpen={false}
        homeNode={<div>home view</div>}
        showWorkspace={false}
        topbarLeftNode={<div>workspace topbar</div>}
        centerMode="chat"
        preloadGitDiffs={false}
        splitChatDiffView={false}
        messagesNode={<div>messages view</div>}
        gitDiffViewerNode={<div>diff viewer</div>}
        gitDiffPanelNode={<div>git panel</div>}
        planPanelNode={<div>plan panel</div>}
        composerNode={<div>composer</div>}
        terminalDockNode={<div>terminal dock</div>}
        settingsOpen={false}
        settingsNode={null}
        debugPanelNode={<div>debug dock</div>}
        debugPanelFullNode={<div>debug full</div>}
        compactEmptyCodexNode={<div>empty codex</div>}
        compactEmptyGitNode={<div>empty git</div>}
        hasActivePlan={false}
        onSidebarResizeStart={vi.fn()}
        onChatDiffSplitPositionResizeStart={vi.fn()}
        onRightPanelResizeStart={vi.fn()}
        onPlanPanelResizeStart={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("session-list")).toBeTruthy();
    expect(screen.getByText("empty codex")).toBeTruthy();
    expect(screen.queryByText("messages view")).toBeNull();
  });

  it("shows the tablet Codex empty state when sessions has no active workspace", () => {
    render(
      <TabletLayout
        tabletNavNode={<nav aria-label="rail">rail</nav>}
        approvalToastsNode={null}
        updateToastNode={null}
        errorToastsNode={null}
        settingsOpen={false}
        settingsNode={null}
        activePanel="sessions"
        libraryOpen={false}
        homeNode={<div>home view</div>}
        showHome={false}
        showWorkspace={false}
        showProjects
        sidebarNode={<aside aria-label="session-list">session list</aside>}
        tabletTab="codex"
        onSidebarResizeStart={vi.fn()}
        topbarLeftNode={<div>workspace topbar</div>}
        messagesNode={<div>messages view</div>}
        composerNode={<div>composer</div>}
        gitDiffPanelNode={<div>git panel</div>}
        gitDiffViewerNode={<div>diff viewer</div>}
        compactEmptyCodexNode={<div>empty codex</div>}
        terminalDockNode={<div>terminal dock</div>}
        debugPanelNode={<div>debug panel</div>}
      />,
    );

    expect(screen.getByLabelText("session-list")).toBeTruthy();
    expect(screen.getByText("empty codex")).toBeTruthy();
    expect(screen.queryByText("messages view")).toBeNull();
  });
});
