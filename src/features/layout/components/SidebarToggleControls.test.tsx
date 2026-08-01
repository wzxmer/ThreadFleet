// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  RightPanelCollapseButton,
  RightPanelExpandButton,
  TitlebarExpandControls,
} from "./SidebarToggleControls";

vi.mock("@/features/i18n/I18nProvider", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe("TitlebarExpandControls", () => {
  it("keeps the sidebar restore control available after automatic collapse", () => {
    const onExpandSidebar = vi.fn();

    render(
      <TitlebarExpandControls
        isCompact={false}
        sidebarCollapsed
        rightPanelCollapsed
        autoSidebarCollapsed
        onCollapseSidebar={vi.fn()}
        onExpandSidebar={onExpandSidebar}
        onCollapseRightPanel={vi.fn()}
        onExpandRightPanel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "sidebar.showThreadsSidebar" }));

    expect(onExpandSidebar).toHaveBeenCalledTimes(1);
  });
});

describe("Git sidebar controls", () => {
  const sharedProps = {
    isCompact: false,
    sidebarCollapsed: false,
    onCollapseSidebar: vi.fn(),
    onExpandSidebar: vi.fn(),
  };

  it("replaces the expand action with a collapse action after Git opens", () => {
    const onCollapseRightPanel = vi.fn();
    const onExpandRightPanel = vi.fn();
    const { rerender } = render(
      <RightPanelExpandButton
        {...sharedProps}
        rightPanelCollapsed
        onCollapseRightPanel={onCollapseRightPanel}
        onExpandRightPanel={onExpandRightPanel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show git sidebar" }));
    expect(onExpandRightPanel).toHaveBeenCalledTimes(1);

    rerender(
      <RightPanelCollapseButton
        {...sharedProps}
        rightPanelCollapsed={false}
        onCollapseRightPanel={onCollapseRightPanel}
        onExpandRightPanel={onExpandRightPanel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Hide git sidebar" }));
    expect(onCollapseRightPanel).toHaveBeenCalledTimes(1);
  });
});
