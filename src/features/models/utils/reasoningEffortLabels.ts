import type { I18nKey } from "@/features/i18n/strings";

const REASONING_EFFORT_LABEL_KEYS: Record<string, I18nKey> = {
  low: "settings.codex.reasoningEffort.low",
  medium: "settings.codex.reasoningEffort.medium",
  high: "settings.codex.reasoningEffort.high",
  xhigh: "settings.codex.reasoningEffort.xhigh",
  max: "settings.codex.reasoningEffort.max",
  ultra: "settings.codex.reasoningEffort.ultra",
};

export function formatReasoningEffortLabel(
  effort: string,
  t: (key: I18nKey) => string,
) {
  const normalized = effort.trim().toLowerCase();
  const labelKey = REASONING_EFFORT_LABEL_KEYS[normalized];
  return labelKey ? t(labelKey) : effort;
}
