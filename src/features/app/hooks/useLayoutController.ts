import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLayoutMode } from "../../layout/hooks/useLayoutMode";
import { useResizablePanels } from "../../layout/hooks/useResizablePanels";
import { useSidebarToggles } from "../../layout/hooks/useSidebarToggles";
import { usePanelVisibility } from "../../layout/hooks/usePanelVisibility";
import { usePanelShortcuts } from "../../layout/hooks/usePanelShortcuts";

export const APP_RAIL_WIDTH = 52;
export const DEFAULT_SIDEBAR_WIDTH = 280;
export const DEFAULT_RIGHT_PANEL_WIDTH = 300;
export const MIN_MAIN_CONTENT_WIDTH = 860;
export const SESSION_MANAGER_MIN_MAIN_CONTENT_WIDTH = 620;
export const AUTO_COLLAPSE_HYSTERESIS = 40;
export const AUTO_EXPAND_HYSTERESIS = 80;

export function resolveEffectivePanelCollapse({
  width,
  isCompact,
  sidebarWidth = DEFAULT_SIDEBAR_WIDTH,
  rightPanelWidth = DEFAULT_RIGHT_PANEL_WIDTH,
  sidebarCollapsed,
  rightPanelCollapsed,
  previousAutoSidebarCollapsed = false,
  previousAutoRightPanelCollapsed = false,
  sidebarRevealRequested = false,
  rightPanelRevealRequested = false,
  minMainContentWidth = MIN_MAIN_CONTENT_WIDTH,
}: {
  width: number;
  isCompact: boolean;
  sidebarWidth?: number;
  rightPanelWidth?: number;
  sidebarCollapsed: boolean;
  rightPanelCollapsed: boolean;
  previousAutoSidebarCollapsed?: boolean;
  previousAutoRightPanelCollapsed?: boolean;
  sidebarRevealRequested?: boolean;
  rightPanelRevealRequested?: boolean;
  minMainContentWidth?: number;
}) {
  if (isCompact) {
    return {
      sidebarCollapsed,
      rightPanelCollapsed,
      autoSidebarCollapsed: false,
      autoRightPanelCollapsed: false,
      sidebarOverlayOpen: false,
    };
  }

  const sidebarOpenForAutomaticRightPanel =
    (!sidebarCollapsed && !previousAutoSidebarCollapsed) || sidebarRevealRequested;
  const automaticRightPanelRequirement =
    APP_RAIL_WIDTH +
    (sidebarOpenForAutomaticRightPanel ? sidebarWidth : 0) +
    rightPanelWidth +
    minMainContentWidth;
  const rightPanelRevealAllowed = rightPanelRevealRequested;
  const autoRightPanelCollapsed = rightPanelCollapsed
    ? false
    : rightPanelRevealRequested
      ? !rightPanelRevealAllowed
      : previousAutoRightPanelCollapsed
        ? width < automaticRightPanelRequirement + AUTO_EXPAND_HYSTERESIS
        : width < automaticRightPanelRequirement - AUTO_COLLAPSE_HYSTERESIS;

  const rightPanelOpenForSidebarRequirement =
    !rightPanelCollapsed && !autoRightPanelCollapsed;
  const sidebarRequirement =
    APP_RAIL_WIDTH +
    (rightPanelOpenForSidebarRequirement ? rightPanelWidth : 0) +
    sidebarWidth +
    minMainContentWidth;
  const autoSidebarCollapsed = sidebarCollapsed
    ? false
    : previousAutoSidebarCollapsed
      ? width < sidebarRequirement + AUTO_EXPAND_HYSTERESIS
      : rightPanelRevealAllowed
        ? false
        : width < sidebarRequirement - AUTO_COLLAPSE_HYSTERESIS;
  const sidebarRevealAllowed = sidebarRevealRequested;
  const sidebarOverlayOpen = false;

  return {
    sidebarCollapsed:
      sidebarRevealRequested
        ? !sidebarRevealAllowed
        : sidebarCollapsed || autoSidebarCollapsed,
    rightPanelCollapsed: rightPanelRevealAllowed
      ? false
      : rightPanelCollapsed || autoRightPanelCollapsed,
    autoSidebarCollapsed,
    autoRightPanelCollapsed,
    sidebarOverlayOpen,
  };
}

function getViewportWidth() {
  if (typeof window === "undefined") {
    return Number.POSITIVE_INFINITY;
  }
  return window.innerWidth;
}

function useViewportWidth() {
  const [width, setWidth] = useState(getViewportWidth);

  useEffect(() => {
    function handleResize() {
      setWidth(getViewportWidth());
    }

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return width;
}

export function useLayoutController({
  activeWorkspaceId,
  setActiveTab,
  setDebugOpen,
  toggleDebugPanelShortcut,
  toggleTerminalShortcut,
  minMainContentWidth = MIN_MAIN_CONTENT_WIDTH,
}: {
  activeWorkspaceId: string | null;
  setActiveTab: (tab: "home" | "projects" | "codex" | "git" | "log") => void;
  setDebugOpen: (value: boolean | ((prev: boolean) => boolean)) => void;
  toggleDebugPanelShortcut: string | null;
  toggleTerminalShortcut: string | null;
  minMainContentWidth?: number;
}) {
  const {
    appRef,
    isResizing,
    sidebarWidth,
    rightPanelWidth,
    chatDiffSplitPositionPercent,
    onSidebarResizeStart,
    onChatDiffSplitPositionResizeStart,
    onRightPanelResizeStart,
    planPanelHeight,
    onPlanPanelResizeStart,
    terminalPanelHeight,
    onTerminalPanelResizeStart,
    debugPanelHeight,
    onDebugPanelResizeStart,
  } = useResizablePanels();

  const layoutMode = useLayoutMode();
  const isCompact = layoutMode !== "desktop";
  const isTablet = layoutMode === "tablet";
  const isPhone = layoutMode === "phone";
  const viewportWidth = useViewportWidth();
  const [sidebarRevealRequested, setSidebarRevealRequested] = useState(false);
  const [rightPanelRevealRequested, setRightPanelRevealRequested] = useState(false);
  const [tabletProjectsOpen, setTabletProjectsOpen] = useState(false);
  const previousAutoCollapseRef = useRef({
    sidebar: false,
    rightPanel: false,
  });

  const {
    sidebarCollapsed: manualSidebarCollapsed,
    rightPanelCollapsed: manualRightPanelCollapsed,
    collapseSidebar: collapseSidebarPreference,
    expandSidebar: expandSidebarPreference,
    collapseRightPanel: collapseRightPanelPreference,
    expandRightPanel: expandRightPanelPreference,
  } = useSidebarToggles({ isCompact });
  const panelCollapse = useMemo(
    () =>
      resolveEffectivePanelCollapse({
        width: viewportWidth,
        isCompact,
        sidebarWidth,
        rightPanelWidth,
        sidebarCollapsed: manualSidebarCollapsed,
        rightPanelCollapsed: manualRightPanelCollapsed,
        previousAutoSidebarCollapsed: previousAutoCollapseRef.current.sidebar,
        previousAutoRightPanelCollapsed: previousAutoCollapseRef.current.rightPanel,
        sidebarRevealRequested,
        rightPanelRevealRequested,
        minMainContentWidth,
      }),
    [
      isCompact,
      minMainContentWidth,
      manualRightPanelCollapsed,
      manualSidebarCollapsed,
      rightPanelWidth,
      rightPanelRevealRequested,
      sidebarRevealRequested,
      sidebarWidth,
      viewportWidth,
    ],
  );
  const {
    sidebarCollapsed,
    rightPanelCollapsed,
    autoSidebarCollapsed,
    autoRightPanelCollapsed,
    sidebarOverlayOpen,
  } = panelCollapse;
  useEffect(() => {
    previousAutoCollapseRef.current = {
      sidebar: autoSidebarCollapsed,
      rightPanel: autoRightPanelCollapsed,
    };
  }, [autoRightPanelCollapsed, autoSidebarCollapsed]);

  useEffect(() => {
    if (!isTablet) {
      setTabletProjectsOpen(false);
    }
    if (isCompact) {
      setSidebarRevealRequested(false);
      setRightPanelRevealRequested(false);
    }
  }, [isCompact, isTablet]);

  const revealSidebar = useCallback(() => {
    if (isTablet) {
      setTabletProjectsOpen(true);
      return;
    }
    if (!isCompact) {
      setSidebarRevealRequested(true);
    }
  }, [isCompact, isTablet]);

  const hideSidebar = useCallback(() => {
    if (isTablet) {
      setTabletProjectsOpen(false);
      return;
    }
    if (!isCompact) {
      setSidebarRevealRequested(false);
    }
  }, [isCompact, isTablet]);

  const collapseSidebar = useCallback(() => {
    if (isTablet) {
      setTabletProjectsOpen(false);
      return;
    }
    if (!isCompact) {
      setSidebarRevealRequested(false);
    }
    collapseSidebarPreference();
  }, [collapseSidebarPreference, isCompact, isTablet]);

  const expandSidebar = useCallback(() => {
    if (!isCompact) {
      setSidebarRevealRequested(true);
    }
    expandSidebarPreference();
  }, [expandSidebarPreference, isCompact]);

  const collapseRightPanel = useCallback(() => {
    if (!isCompact) {
      setRightPanelRevealRequested(false);
    }
    collapseRightPanelPreference();
  }, [collapseRightPanelPreference, isCompact]);

  const expandRightPanel = useCallback(() => {
    if (!isCompact) {
      setRightPanelRevealRequested(true);
    }
    expandRightPanelPreference();
  }, [expandRightPanelPreference, isCompact]);

  const {
    terminalOpen,
    onToggleDebug: handleDebugClick,
    onToggleTerminal: handleToggleTerminal,
    openTerminal,
    closeTerminal,
  } = usePanelVisibility({
    isCompact,
    activeWorkspaceId,
    setActiveTab,
    setDebugOpen,
  });

  usePanelShortcuts({
    toggleDebugPanelShortcut,
    toggleTerminalShortcut,
    onToggleDebug: handleDebugClick,
    onToggleTerminal: handleToggleTerminal,
  });

  return {
    appRef,
    isResizing,
    layoutMode,
    isCompact,
    isTablet,
    isPhone,
    sidebarWidth,
    rightPanelWidth,
    chatDiffSplitPositionPercent,
    planPanelHeight,
    terminalPanelHeight,
    debugPanelHeight,
    onSidebarResizeStart,
    onChatDiffSplitPositionResizeStart,
    onRightPanelResizeStart,
    onPlanPanelResizeStart,
    onTerminalPanelResizeStart,
    onDebugPanelResizeStart,
    sidebarCollapsed,
    rightPanelCollapsed,
    autoSidebarCollapsed,
    autoRightPanelCollapsed,
    sidebarOverlayOpen,
    sidebarRevealRequested,
    rightPanelRevealRequested,
    tabletProjectsOpen,
    revealSidebar,
    hideSidebar,
    collapseSidebar,
    expandSidebar,
    collapseRightPanel,
    expandRightPanel,
    terminalOpen,
    handleDebugClick,
    handleToggleTerminal,
    openTerminal,
    closeTerminal,
  };
}
