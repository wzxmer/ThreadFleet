// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/features/i18n/I18nProvider";
import { PlanPanel } from "./PlanPanel";

function renderPanel(panel: React.ReactElement) {
  return render(<I18nProvider preference="en">{panel}</I18nProvider>);
}

describe("PlanPanel", () => {
  it("shows a waiting label while processing without a plan", () => {
    renderPanel(<PlanPanel plan={null} isProcessing />);

    expect(screen.getByText("Waiting on a plan...")).toBeTruthy();
  });

  it("shows an empty label when idle without a plan", () => {
    renderPanel(<PlanPanel plan={null} isProcessing={false} />);

    expect(screen.getByText("No active plan.")).toBeTruthy();
  });

  it("shows a delta stream while the structured plan is stale", () => {
    renderPanel(
      <PlanPanel
        plan={{
          turnId: "turn-1",
          explanation: "Previous plan",
          steps: [{ step: "Previous step", status: "inProgress" }],
        }}
        planStream={"- Inspect source\n- Run tests"}
        activeTurnId="turn-2"
        isProcessing
      />,
    );

    expect(document.querySelector(".plan-stream")?.textContent).toBe(
      "- Inspect source\n- Run tests",
    );
    expect(screen.queryByText("Previous plan")).toBeNull();
  });

  it("shows the first delta before a structured plan arrives", () => {
    renderPanel(
      <PlanPanel
        plan={null}
        planStream="- Inspect source"
        activeTurnId="turn-1"
        isProcessing
      />,
    );

    const streams = document.querySelectorAll(".plan-stream");
    expect(streams[streams.length - 1]?.textContent).toBe("- Inspect source");
    const panels = document.querySelectorAll(".plan-panel");
    expect(panels[panels.length - 1]?.querySelector(".plan-empty")).toBeNull();
  });

  it("shows reconciliation state without hiding structured steps", () => {
    renderPanel(
      <PlanPanel
        plan={{
          turnId: "turn-1",
          explanation: "Checking completion",
          steps: [{ step: "Run tests", status: "inProgress" }],
          syncState: "reconciling",
        }}
        isProcessing={false}
      />,
    );

    expect(screen.getByText("Checking the final Plan state...")).toBeTruthy();
    expect(screen.getByText("Run tests")).toBeTruthy();
  });

  it("warns when the final structured plan may be stale", () => {
    renderPanel(
      <PlanPanel
        plan={{
          turnId: "turn-1",
          explanation: null,
          steps: [{ step: "Run tests", status: "inProgress" }],
          syncState: "stale",
        }}
        isProcessing={false}
      />,
    );

    expect(
      screen.getByText(
        "The turn ended without a final Plan update. These steps may be stale.",
      ),
    ).toBeTruthy();
    expect(document.querySelector(".plan-sync-status.stale")).toBeTruthy();
  });
});
