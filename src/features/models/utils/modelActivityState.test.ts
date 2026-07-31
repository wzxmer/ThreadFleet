import { describe, expect, it } from "vitest";
import type { ConversationItem } from "@/types";
import { resolveModelActivityState } from "./modelActivityState";

const runningTool: ConversationItem = {
  id: "tool-1",
  kind: "tool",
  toolType: "commandExecution",
  title: "Run tests",
  detail: "npm test",
  status: "inProgress",
  turnId: "turn-1",
};

describe("resolveModelActivityState", () => {
  it("maps inactive turns to idle, completed, and failed states", () => {
    expect(resolveModelActivityState({ items: [], isProcessing: false })).toBe("idle");
    expect(
      resolveModelActivityState({ items: [], isProcessing: false, turnStatus: "completed" }),
    ).toBe("completed");
    expect(
      resolveModelActivityState({ items: [], isProcessing: false, turnStatus: "failed" }),
    ).toBe("failed");
    expect(
      resolveModelActivityState({ items: [], isProcessing: false, turnStatus: "interrupted" }),
    ).toBe("failed");
  });

  it("prioritizes waiting for user interaction over active execution", () => {
    expect(
      resolveModelActivityState({
        items: [runningTool],
        isProcessing: true,
        hasPendingInteraction: true,
        activeTurnIds: ["turn-1"],
      }),
    ).toBe("waiting");
  });

  it("maps a running current-turn tool to executing", () => {
    expect(
      resolveModelActivityState({
        items: [runningTool],
        isProcessing: true,
        activeTurnIds: ["turn-1"],
      }),
    ).toBe("executing");
  });

  it("ignores running tools from earlier turns", () => {
    expect(
      resolveModelActivityState({
        items: [runningTool],
        isProcessing: true,
        activeTurnIds: ["turn-2"],
      }),
    ).toBe("thinking");
  });
});
