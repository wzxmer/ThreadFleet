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
    showRemoteThreadConnectionIndicator: boolean;
    remoteThreadConnectionState: "live" | "polling" | "disconnected";
    remoteThreadConnectionCopy: Record<
      "live" | "polling" | "disconnected",
      { label: string; title: string }
    >;
  };
};

export function useMainAppShellProps({
  shell,
  gitHubPanelDataProps,
  appLayout,
  topbar,
}: UseMainAppShellPropsArgs) {
  const showThreadConnectionIndicator =
    topbar.hasActiveWorkspace &&
    topbar.backendMode === "remote" &&
    topbar.showRemoteThreadConnectionIndicator;
  const connectionCopy =
    topbar.remoteThreadConnectionCopy[topbar.remoteThreadConnectionState];
  const topbarActionsNode = showThreadConnectionIndicator ? (
    <span
      className={`compact-workspace-live-indicator ${
        topbar.remoteThreadConnectionState === "live"
          ? "is-live"
          : topbar.remoteThreadConnectionState === "polling"
            ? "is-polling"
            : "is-disconnected"
      }`}
      title={connectionCopy.title}
    >
      {connectionCopy.label}
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
