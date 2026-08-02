import { describe, expect, it } from "vitest";
import { formatReasoningEffortLabel } from "./reasoningEffortLabels";

describe("formatReasoningEffortLabel", () => {
  it("keeps reasoning effort values in their raw form", () => {
    expect(formatReasoningEffortLabel("MAX")).toBe("max");
    expect(formatReasoningEffortLabel(" ultra ")).toBe("ultra");
  });

  it("preserves unknown future reasoning efforts", () => {
    expect(formatReasoningEffortLabel("future")).toBe("future");
  });
});
