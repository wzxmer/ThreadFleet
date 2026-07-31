import type { ComponentProps } from "react";
import { MainAppShell } from "@app/components/MainAppShell";

type UseMainAppShellPropsArgs = {
  shell: Pick<
    ComponentProps<typeof MainAppShell>,
    | "appClassName"
    | "isResizing"
    | "appStyle"
    | "appRef"
    | "sidebarToggleProps"
    | "shouldLoadGitHubPanelData"
    | "appModalsProps"
    | "showMobileSetupWizard"
    | "mobileSetupWizardProps"
  >;
  gitHubPanelDataProps: ComponentProps<typeof MainAppShell>["gitHubPanelDataProps"];
  appLayout: Omit<ComponentProps<typeof MainAppShell>["appLayoutProps"], "desktopTopbarLeftNode" | "topbarActionsNode">;
  topbar: {
    desktopTopbarLeftNode: ComponentProps<typeof MainAppShell>["appLayoutProps"]["desktopTopbarLeftNode"];
    hasActiveWorkspace: boolean;
    backendMode: "local" | "remote";
    remoteThreadConnectionState: "live" | "polling" | "disconnected";
  };
};

export function useMainAppShellProps({
  shell,
  gitHubPanelDataProps,
  appLayout,
  topbar,
}: UseMainAppShellPropsArgs) {
  const showThreadConnectionIndicator =
    topbar.hasActiveWorkspace && topbar.backendMode === "remote";
  const topbarActionsNode = showThreadConnectionIndicator ? (
    <span
      className={`compact-workspace-live-indicator ${
        topbar.remoteThreadConnectionState === "live"
          ? "is-live"
          : topbar.remoteThreadConnectionState === "polling"
            ? "is-polling"
            : "is-disconnected"
      }`}
      title={
        topbar.remoteThreadConnectionState === "live"
          ? "Receiving live thread events"
          : topbar.remoteThreadConnectionState === "polling"
            ? "Connected, syncing thread state by polling"
            : "Disconnected from backend"
      }
    >
      {topbar.remoteThreadConnectionState === "live"
        ? "Live"
        : topbar.remoteThreadConnectionState === "polling"
          ? "Polling"
          : "Disconnected"}
    </span>
  ) : null;

  return {
    ...shell,
    gitHubPanelDataProps,
    appLayoutProps: {
      ...appLayout,
      desktopTopbarLeftNode: topbar.desktopTopbarLeftNode,
      topbarActionsNode,
    },
  };
}
