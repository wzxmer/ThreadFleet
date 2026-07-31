import { useMemo, type CSSProperties } from "react";
import type { AppSettings } from "@/types";
import { isWindowsPlatform } from "@utils/platformPaths";
import { composeContentFontFamily, composeUiFontFamily } from "@utils/fonts";

type UseAppShellOrchestrationOptions = {
  isCompact: boolean;
  isPhone: boolean;
  isTablet: boolean;
  tabletProjectsOpen: boolean;
  sidebarOverlayOpen: boolean;
  sidebarCollapsed: boolean;
  rightPanelCollapsed: boolean;
  shouldReduceTransparency: boolean;
  isWorkspaceDropActive: boolean;
  centerMode: "chat" | "diff";
  selectedDiffPath: string | null;
  showComposer: boolean;
  activeThreadId: string | null;
  sidebarWidth: number;
  rightPanelWidth: number;
  chatDiffSplitPositionPercent: number;
  planPanelHeight: number;
  terminalPanelHeight: number;
  debugPanelHeight: number;
  appSettings: Pick<
    AppSettings,
    | "uiFontFamily"
    | "uiLatinFontFamily"
    | "uiCjkFontFamily"
    | "uiFontSize"
    | "uiFontWeight"
    | "messageFontSize"
    | "processFontSize"
    | "codeFontFamily"
    | "codeFontSize"
  >;
};

export function useAppShellOrchestration({
  isCompact,
  isPhone,
  isTablet,
  tabletProjectsOpen,
  sidebarOverlayOpen,
  sidebarCollapsed,
  rightPanelCollapsed,
  shouldReduceTransparency,
  isWorkspaceDropActive,
  centerMode,
  selectedDiffPath,
  showComposer,
  activeThreadId,
  sidebarWidth,
  rightPanelWidth,
  chatDiffSplitPositionPercent,
  planPanelHeight,
  terminalPanelHeight,
  debugPanelHeight,
  appSettings,
}: UseAppShellOrchestrationOptions) {
  const isWindows = isWindowsPlatform();
  const showGitDetail = Boolean(selectedDiffPath) && isPhone && centerMode === "diff";
  const isThreadOpen = Boolean(activeThreadId && showComposer);
  const uiFontFamily = composeUiFontFamily(
    appSettings.uiLatinFontFamily,
    appSettings.uiCjkFontFamily,
    appSettings.uiFontFamily,
  );
  const codeFontFamily = composeContentFontFamily(
    appSettings.codeFontFamily,
    appSettings.uiCjkFontFamily,
    appSettings.uiFontFamily,
  );

  const appClassName = `app ${isCompact ? "layout-compact" : "layout-desktop"}${
    isPhone ? " layout-phone" : ""
  }${isTablet ? " layout-tablet" : ""}${
    isTablet && tabletProjectsOpen ? " tablet-projects-open" : ""
  }${!isCompact && sidebarOverlayOpen ? " sidebar-overlay-open" : ""}${
    shouldReduceTransparency ? " reduced-transparency" : ""
  }${!isCompact && sidebarCollapsed ? " sidebar-collapsed" : ""}${
    !isCompact && rightPanelCollapsed ? " right-panel-collapsed" : ""
  }${isWindows ? " is-windows" : ""}`;

  const appStyle = useMemo<CSSProperties>(
    () => ({
      "--sidebar-width": `${isCompact ? sidebarWidth : sidebarCollapsed ? 0 : sidebarWidth}px`,
      "--sidebar-overlay-width": `${sidebarWidth}px`,
      "--tablet-sidebar-effective-width":
        isTablet && tabletProjectsOpen ? `min(${sidebarWidth}px, 34vw)` : "0px",
      "--right-panel-width": `${
        isCompact ? rightPanelWidth : rightPanelCollapsed ? 0 : rightPanelWidth
      }px`,
      "--chat-diff-split-position-percent": `${chatDiffSplitPositionPercent}%`,
      "--plan-panel-height": `${planPanelHeight}px`,
      "--terminal-panel-height": `${terminalPanelHeight}px`,
      "--debug-panel-height": `${debugPanelHeight}px`,
      "--ui-font-family": uiFontFamily,
      "--ui-font-size": `${appSettings.uiFontSize}px`,
      "--ui-font-weight": `${appSettings.uiFontWeight}`,
      "--code-font-family": codeFontFamily,
      "--message-font-size": `${appSettings.messageFontSize}px`,
      "--process-font-size": `${appSettings.processFontSize}px`,
      "--message-font-family": uiFontFamily,
      "--message-font-weight": `${appSettings.uiFontWeight}`,
      "--code-font-size": `${appSettings.codeFontSize}px`,
      "--sidebar-top-padding": isWindows ? "10px" : "36px",
      "--right-panel-top-padding": isWindows
        ? "calc(var(--main-topbar-height, 44px) + 6px)"
        : "12px",
      "--home-scroll-offset": isWindows ? "var(--main-topbar-height, 44px)" : "0px",
      "--window-caption-width": isWindows ? "138px" : "0px",
      "--window-caption-gap": isWindows ? "10px" : "0px",
      ...(isWindows
        ? {
            "--titlebar-height": "8px",
            "--titlebar-drag-strip-z-index": "5",
            "--window-drag-strip-z-index": "2",
            "--side-panel-drag-strip-height": "56px",
            "--window-drag-hit-height": "44px",
            "--window-drag-strip-pointer-events": "auto",
            "--window-drag-strip-left": isCompact
              ? "64px"
              : "calc(var(--app-rail-width, 52px) + var(--sidebar-width, 280px))",
            "--window-drag-strip-right":
              "calc(var(--window-caption-width, 138px) + var(--window-caption-gap, 10px))",
            "--titlebar-inset-left": isCompact ? "0px" : "var(--app-rail-width, 52px)",
            "--titlebar-collapsed-left-extra": "0px",
            "--titlebar-toggle-size": "32px",
            "--titlebar-toggle-side-gap": "14px",
            "--titlebar-toggle-title-offset": "0px",
            "--titlebar-toggle-offset": "0px",
          }
        : {}),
    } as CSSProperties),
    [
      appSettings.codeFontSize,
      appSettings.messageFontSize,
      appSettings.processFontSize,
      appSettings.uiFontSize,
      appSettings.uiFontWeight,
      codeFontFamily,
      chatDiffSplitPositionPercent,
      debugPanelHeight,
      isWindows,
      isCompact,
      isTablet,
      planPanelHeight,
      rightPanelCollapsed,
      rightPanelWidth,
      sidebarCollapsed,
      sidebarWidth,
      tabletProjectsOpen,
      terminalPanelHeight,
      uiFontFamily,
    ],
  );

  return {
    showGitDetail,
    isThreadOpen,
    dropOverlayActive: isWorkspaceDropActive,
    dropOverlayText: "Drop Project Here",
    appClassName,
    appStyle,
  };
}
