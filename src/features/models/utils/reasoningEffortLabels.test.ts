import { describe, expect, it } from "vitest";
import type { I18nKey } from "@/features/i18n/strings";
import { formatReasoningEffortLabel } from "./reasoningEffortLabels";

const LABELS: Partial<Record<I18nKey, string>> = {
  "settings.codex.reasoningEffort.max": "最高",
  "settings.codex.reasoningEffort.ultra": "Ultra (auto-delegation)",
};

const t = (key: I18nKey) => LABELS[key] ?? key;

describe("formatReasoningEffortLabel", () => {
  it("localizes max and ultra reasoning efforts", () => {
    expect(formatReasoningEffortLabel("MAX", t)).toBe("最高");
    expect(formatReasoningEffortLabel(" ultra ", t)).toBe("Ultra (auto-delegation)");
  });

  it("preserves unknown future reasoning efforts", () => {
    expect(formatReasoningEffortLabel("future", t)).toBe("future");
  });
});
