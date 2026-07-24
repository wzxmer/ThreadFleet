import { describe, expect, it } from "vitest";
import type { I18nKey } from "@/features/i18n/strings";
import { formatReasoningEffortLabel } from "./reasoningEffortLabels";

const LABELS: Partial<Record<I18nKey, string>> = {
  "settings.codex.reasoningEffort.max": "最高",
  "settings.codex.reasoningEffort.ultra": "终极（自动委派）",
};

const t = (key: I18nKey) => LABELS[key] ?? key;

describe("formatReasoningEffortLabel", () => {
  it("localizes max and ultra reasoning efforts", () => {
    expect(formatReasoningEffortLabel("MAX", t)).toBe("最高");
    expect(formatReasoningEffortLabel(" ultra ", t)).toBe("终极（自动委派）");
  });

  it("preserves unknown future reasoning efforts", () => {
    expect(formatReasoningEffortLabel("future", t)).toBe("future");
  });
});
