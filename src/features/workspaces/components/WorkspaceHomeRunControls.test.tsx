/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceHomeRunControls } from "./WorkspaceHomeRunControls";

describe("WorkspaceHomeRunControls engine capabilities", () => {
  it("hides Codex collaboration and reasoning controls for Gemini", () => {
    const { rerender } = render(<WorkspaceHomeRunControls
      agentEngine="gemini"
      workspaceKind="main"
      runMode="local"
      onRunModeChange={vi.fn()}
      models={[]}
      selectedModelId={null}
      onSelectModel={vi.fn()}
      modelSelections={{}}
      onToggleModel={vi.fn()}
      onModelCountChange={vi.fn()}
      collaborationModes={[{ id: "plan", label: "Plan" }]}
      selectedCollaborationModeId="plan"
      onSelectCollaborationMode={vi.fn()}
      reasoningOptions={["high"]}
      selectedEffort="high"
      onSelectEffort={vi.fn()}
      reasoningSupported
      isSubmitting={false}
    />);
    expect(screen.queryByRole("combobox")).toBeNull();
    rerender(<WorkspaceHomeRunControls
      workspaceKind="main"
      runMode="local"
      onRunModeChange={vi.fn()}
      models={[]}
      selectedModelId={null}
      onSelectModel={vi.fn()}
      modelSelections={{}}
      onToggleModel={vi.fn()}
      onModelCountChange={vi.fn()}
      collaborationModes={[{ id: "plan", label: "Plan" }]}
      selectedCollaborationModeId="plan"
      onSelectCollaborationMode={vi.fn()}
      reasoningOptions={["high"]}
      selectedEffort="high"
      onSelectEffort={vi.fn()}
      reasoningSupported
      isSubmitting={false}
    />);
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
  });
});
