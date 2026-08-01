// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useMainAppShellProps } from "./useMainAppShellProps";

type UseMainAppShellPropsArgs = Parameters<typeof useMainAppShellProps>[0];

const connectionCopy = {
  live: {
    label: "实时",
    title: "正在接收实时会话事件",
  },
  polling: {
    label: "同步中",
    title: "已连接，正在通过轮询同步会话状态",
  },
  disconnected: {
    label: "已断开",
    title: "已断开后端连接",
  },
};

function ConnectionIndicatorProbe({
  state,
}: {
  state: "live" | "polling" | "disconnected";
}) {
  const shellProps = useMainAppShellProps({
    shell: {},
    gitHubPanelDataProps: {},
    appLayout: {},
    topbar: {
      desktopTopbarLeftNode: null,
      hasActiveWorkspace: true,
      backendMode: "remote",
      showRemoteThreadConnectionIndicator: true,
      remoteThreadConnectionState: state,
      remoteThreadConnectionCopy: connectionCopy,
    },
  } as unknown as UseMainAppShellPropsArgs);

  return <>{shellProps.appLayoutProps.topbarActionsNode}</>;
}

describe("useMainAppShellProps", () => {
  it("uses localized remote thread connection copy", () => {
    const { rerender } = render(<ConnectionIndicatorProbe state="live" />);

    const live = screen.getByText("实时");
    expect(live.getAttribute("title")).toBe("正在接收实时会话事件");
    expect(live.className).toContain("is-live");

    rerender(<ConnectionIndicatorProbe state="polling" />);
    const polling = screen.getByText("同步中");
    expect(polling.getAttribute("title")).toBe(
      "已连接，正在通过轮询同步会话状态",
    );
    expect(polling.className).toContain("is-polling");

    rerender(<ConnectionIndicatorProbe state="disconnected" />);
    const disconnected = screen.getByText("已断开");
    expect(disconnected.getAttribute("title")).toBe("已断开后端连接");
    expect(disconnected.className).toContain("is-disconnected");
  });

  it("hides the remote indicator when the current thread no longer needs live sync", () => {
    const shellProps = useMainAppShellProps({
      shell: {},
      gitHubPanelDataProps: {},
      appLayout: {},
      topbar: {
        desktopTopbarLeftNode: null,
        hasActiveWorkspace: true,
        backendMode: "remote",
        showRemoteThreadConnectionIndicator: false,
        remoteThreadConnectionState: "polling",
        remoteThreadConnectionCopy: connectionCopy,
      },
    } as unknown as UseMainAppShellPropsArgs);

    render(<>{shellProps.appLayoutProps.topbarActionsNode}</>);

    expect(screen.queryByText("同步中")).toBeNull();
  });
});
