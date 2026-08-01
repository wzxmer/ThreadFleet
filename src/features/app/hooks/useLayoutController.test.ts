import { describe, expect, it } from "vitest";
import {
  APP_RAIL_WIDTH,
  AUTO_COLLAPSE_HYSTERESIS,
  AUTO_EXPAND_HYSTERESIS,
  DEFAULT_RIGHT_PANEL_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  MIN_MAIN_CONTENT_WIDTH,
  SESSION_MANAGER_MIN_MAIN_CONTENT_WIDTH,
  resolveEffectivePanelCollapse,
} from "./useLayoutController";

describe("resolveEffectivePanelCollapse", () => {
  const fullLayoutWidth =
    APP_RAIL_WIDTH +
    DEFAULT_SIDEBAR_WIDTH +
    DEFAULT_RIGHT_PANEL_WIDTH +
    MIN_MAIN_CONTENT_WIDTH;
  const sidebarOnlyLayoutWidth =
    APP_RAIL_WIDTH + DEFAULT_SIDEBAR_WIDTH + MIN_MAIN_CONTENT_WIDTH;

  it("auto-collapses the right panel before the project sidebar from the available content width", () => {
    expect(
      resolveEffectivePanelCollapse({
        width: fullLayoutWidth - AUTO_COLLAPSE_HYSTERESIS - 1,
        isCompact: false,
        sidebarCollapsed: false,
        rightPanelCollapsed: false,
      }),
    ).toEqual({
      sidebarCollapsed: false,
      rightPanelCollapsed: true,
      autoSidebarCollapsed: false,
      autoRightPanelCollapsed: true,
      sidebarOverlayOpen: false,
    });

    expect(
      resolveEffectivePanelCollapse({
        width: sidebarOnlyLayoutWidth - AUTO_COLLAPSE_HYSTERESIS - 1,
        isCompact: false,
        sidebarCollapsed: false,
        rightPanelCollapsed: false,
        previousAutoRightPanelCollapsed: true,
      }),
    ).toEqual({
      sidebarCollapsed: true,
      rightPanelCollapsed: true,
      autoSidebarCollapsed: true,
      autoRightPanelCollapsed: true,
      sidebarOverlayOpen: false,
    });
  });

  it("auto-expands back to the manual desktop state when the window is wide enough", () => {
    expect(
      resolveEffectivePanelCollapse({
        width: fullLayoutWidth + AUTO_EXPAND_HYSTERESIS,
        isCompact: false,
        sidebarCollapsed: false,
        rightPanelCollapsed: false,
        previousAutoRightPanelCollapsed: true,
      }),
    ).toEqual({
      sidebarCollapsed: false,
      rightPanelCollapsed: false,
      autoSidebarCollapsed: false,
      autoRightPanelCollapsed: false,
      sidebarOverlayOpen: false,
    });

    expect(
      resolveEffectivePanelCollapse({
        width: fullLayoutWidth + AUTO_EXPAND_HYSTERESIS,
        isCompact: false,
        sidebarCollapsed: true,
        rightPanelCollapsed: false,
        previousAutoRightPanelCollapsed: true,
      }),
    ).toEqual({
      sidebarCollapsed: true,
      rightPanelCollapsed: false,
      autoSidebarCollapsed: false,
      autoRightPanelCollapsed: false,
      sidebarOverlayOpen: false,
    });
  });

  it("does not apply desktop auto-collapse rules to compact layouts", () => {
    expect(
      resolveEffectivePanelCollapse({
        width: 900,
        isCompact: true,
        sidebarCollapsed: false,
        rightPanelCollapsed: false,
      }),
    ).toEqual({
      sidebarCollapsed: false,
      rightPanelCollapsed: false,
      autoSidebarCollapsed: false,
      autoRightPanelCollapsed: false,
      sidebarOverlayOpen: false,
    });
  });

  it("keeps collapsed state stable inside the hysteresis band", () => {
    expect(
      resolveEffectivePanelCollapse({
        width: fullLayoutWidth,
        isCompact: false,
        sidebarCollapsed: false,
        rightPanelCollapsed: false,
        previousAutoRightPanelCollapsed: true,
      }),
    ).toEqual({
      sidebarCollapsed: false,
      rightPanelCollapsed: true,
      autoSidebarCollapsed: false,
      autoRightPanelCollapsed: true,
      sidebarOverlayOpen: false,
    });
  });

  it("opens Git as a docked panel without changing the project sidebar state", () => {
    expect(
      resolveEffectivePanelCollapse({
        width: fullLayoutWidth - AUTO_COLLAPSE_HYSTERESIS - 1,
        isCompact: false,
        sidebarCollapsed: false,
        rightPanelCollapsed: false,
        rightPanelRevealRequested: true,
      }),
    ).toEqual({
      sidebarCollapsed: false,
      rightPanelCollapsed: false,
      autoSidebarCollapsed: false,
      autoRightPanelCollapsed: false,
      sidebarOverlayOpen: false,
    });

    expect(
      resolveEffectivePanelCollapse({
        width: fullLayoutWidth,
        isCompact: false,
        sidebarCollapsed: false,
        rightPanelCollapsed: false,
        rightPanelRevealRequested: true,
      }),
    ).toEqual({
      sidebarCollapsed: false,
      rightPanelCollapsed: false,
      autoSidebarCollapsed: false,
      autoRightPanelCollapsed: false,
      sidebarOverlayOpen: false,
    });
  });

  it("lets the user reveal Git when the conversation still has a readable adaptive width", () => {
    expect(
      resolveEffectivePanelCollapse({
        width: 1528,
        isCompact: false,
        sidebarWidth: 280,
        rightPanelWidth: 306,
        sidebarCollapsed: false,
        rightPanelCollapsed: false,
        previousAutoRightPanelCollapsed: true,
        rightPanelRevealRequested: true,
      }),
    ).toEqual({
      sidebarCollapsed: false,
      rightPanelCollapsed: false,
      autoSidebarCollapsed: false,
      autoRightPanelCollapsed: false,
      sidebarOverlayOpen: false,
    });
  });

  it("preserves an already auto-collapsed conversation sidebar until the expand threshold", () => {
    expect(
      resolveEffectivePanelCollapse({
        width: fullLayoutWidth - AUTO_COLLAPSE_HYSTERESIS - 1,
        isCompact: false,
        sidebarCollapsed: false,
        rightPanelCollapsed: false,
        previousAutoSidebarCollapsed: true,
        rightPanelRevealRequested: true,
      }),
    ).toEqual({
      sidebarCollapsed: true,
      rightPanelCollapsed: false,
      autoSidebarCollapsed: true,
      autoRightPanelCollapsed: false,
      sidebarOverlayOpen: false,
    });

    expect(
      resolveEffectivePanelCollapse({
        width: fullLayoutWidth + AUTO_EXPAND_HYSTERESIS,
        isCompact: false,
        sidebarCollapsed: false,
        rightPanelCollapsed: false,
        previousAutoSidebarCollapsed: true,
        rightPanelRevealRequested: true,
      }),
    ).toEqual({
      sidebarCollapsed: false,
      rightPanelCollapsed: false,
      autoSidebarCollapsed: false,
      autoRightPanelCollapsed: false,
      sidebarOverlayOpen: false,
    });
  });

  it("reveals an auto-collapsed sidebar as a docked column without an overlay", () => {
    expect(
      resolveEffectivePanelCollapse({
        width: sidebarOnlyLayoutWidth,
        isCompact: false,
        sidebarCollapsed: false,
        rightPanelCollapsed: false,
        previousAutoSidebarCollapsed: true,
        previousAutoRightPanelCollapsed: true,
        sidebarRevealRequested: true,
      }),
    ).toEqual({
      sidebarCollapsed: false,
      rightPanelCollapsed: true,
      autoSidebarCollapsed: true,
      autoRightPanelCollapsed: true,
      sidebarOverlayOpen: false,
    });

    expect(
      resolveEffectivePanelCollapse({
        width: sidebarOnlyLayoutWidth - 1,
        isCompact: false,
        sidebarCollapsed: false,
        rightPanelCollapsed: false,
        previousAutoSidebarCollapsed: true,
        previousAutoRightPanelCollapsed: true,
        sidebarRevealRequested: true,
      }),
    ).toEqual({
      sidebarCollapsed: false,
      rightPanelCollapsed: true,
      autoSidebarCollapsed: true,
      autoRightPanelCollapsed: true,
      sidebarOverlayOpen: false,
    });
  });

  it("keeps a manually collapsed sidebar independent from Git when both are toggled", () => {
    expect(
      resolveEffectivePanelCollapse({
        width: sidebarOnlyLayoutWidth - 1,
        isCompact: false,
        sidebarCollapsed: true,
        rightPanelCollapsed: false,
        previousAutoRightPanelCollapsed: true,
        sidebarRevealRequested: true,
      }),
    ).toEqual({
      sidebarCollapsed: false,
      rightPanelCollapsed: true,
      autoSidebarCollapsed: false,
      autoRightPanelCollapsed: true,
      sidebarOverlayOpen: false,
    });
  });

  it("keeps the session manager index docked beside its responsive workspace", () => {
    const sessionManagerWidth =
      APP_RAIL_WIDTH + DEFAULT_SIDEBAR_WIDTH + SESSION_MANAGER_MIN_MAIN_CONTENT_WIDTH;

    expect(
      resolveEffectivePanelCollapse({
        width: sessionManagerWidth,
        isCompact: false,
        sidebarCollapsed: true,
        rightPanelCollapsed: true,
        sidebarRevealRequested: true,
        minMainContentWidth: SESSION_MANAGER_MIN_MAIN_CONTENT_WIDTH,
      }),
    ).toEqual({
      sidebarCollapsed: false,
      rightPanelCollapsed: true,
      autoSidebarCollapsed: false,
      autoRightPanelCollapsed: false,
      sidebarOverlayOpen: false,
    });
  });
});
