/**
 * @vitest-environment jsdom
 */
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MainHeader } from "./MainHeader";
import type { BranchInfo, OpenAppTarget, WorkspaceInfo } from "@/types";

vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn(),
}));

const workspace: WorkspaceInfo = {
  id: "workspace-1",
  name: "ThreadFleet",
  path: "D:/Project/ThreadFleet",
  connected: true,
  settings: {
    sidebarCollapsed: false,
    groupId: null,
    sortOrder: 0,
  },
};

const branches: BranchInfo[] = [];
const openTargets: OpenAppTarget[] = [];

function renderHeader(overrides: Partial<Parameters<typeof MainHeader>[0]> = {}) {
  return render(
    <MainHeader
      workspace={workspace}
      openTargets={openTargets}
      openAppIconById={{}}
      selectedOpenAppId=""
      onSelectOpenAppId={vi.fn()}
      branchName="main"
      branches={branches}
      onCheckoutBranch={vi.fn()}
      onCreateBranch={vi.fn()}
      showWorkspaceTools={false}
      {...overrides}
    />,
  );
}

describe("MainHeader", () => {
  it("does not render the active thread title in the compact header", () => {
    const { container } = renderHeader({ titleOverride: "Fix Windows colors" });

    expect(container.querySelector(".session-header-title")).toBeNull();
    expect(container.textContent).not.toContain("Fix Windows colors");
    expect(container.querySelector(".workspace-context-chip-project")?.textContent).toBe(
      "ThreadFleet",
    );
  });

  it("does not duplicate the workspace name as a header title", () => {
    const { container } = renderHeader({ titleOverride: "   " });

    expect(container.querySelector(".session-header-title")).toBeNull();
    expect(container.querySelectorAll(".workspace-context-chip-project")).toHaveLength(1);
  });

  it("keeps the session header focused on project and branch context", () => {
    const { container } = renderHeader({ titleOverride: "Inspect responsive spacing" });

    const chips = container.querySelector(".workspace-context-chips");
    expect(chips?.textContent).toContain("ThreadFleet");
    expect(chips?.textContent).toContain("main");
    expect(container.querySelector(".workspace-context-chip-usage")).toBeNull();
    expect(container.querySelector(".workspace-context-chip-compactions")).toBeNull();
  });

  it("provides header hosts for conversation and input tools before workspace actions", () => {
    const { container } = renderHeader({
      showWorkspaceTools: true,
    });

    const actions = container.querySelector(".main-header-actions");
    const messageHost = actions?.querySelector(".main-header-message-tools");
    const composerHost = actions?.querySelector(".main-header-composer-tools");
    expect(messageHost).toBeTruthy();
    expect(composerHost).toBeTruthy();
    expect(actions?.children[0]).toBe(messageHost);
    expect(actions?.children[1]).toBe(composerHost);
  });

  it("keeps terminal and copy-thread actions out of the session topbar", () => {
    const { container } = renderHeader({ showWorkspaceTools: true });

    expect(container.querySelector('[aria-label="Toggle terminal panel"]')).toBeNull();
    expect(container.querySelector('[aria-label="Copy thread"]')).toBeNull();
  });
});
