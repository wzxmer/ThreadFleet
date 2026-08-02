import type { ReasoningEffortOption } from "@/types";

const SUPPORTED_EFFORT_KEYS = [
  "supportedReasoningEfforts",
  "supported_reasoning_efforts",
  "reasoningEfforts",
  "reasoning_efforts",
] as const;

const DEFAULT_EFFORT_KEYS = [
  "defaultReasoningEffort",
  "default_reasoning_effort",
] as const;

const MODEL_ID_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

function firstOwnValue(
  record: Record<string, unknown>,
  keys: readonly string[],
): { found: boolean; value: unknown } {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return { found: true, value: record[key] };
    }
  }
  return { found: false, value: undefined };
}

export function normalizeReasoningEffortValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function inferReasoningEffortFromModelId(modelId: string): string | null {
  const tokens = modelId
    .trim()
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return MODEL_ID_REASONING_EFFORTS.find((effort) => tokens.includes(effort)) ?? null;
}

export function parseReasoningEffortOptions(value: unknown): ReasoningEffortOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const options = new Map<string, ReasoningEffortOption>();
  value.forEach((entry) => {
    const record = entry && typeof entry === "object"
      ? entry as Record<string, unknown>
      : null;
    const reasoningEffort = normalizeReasoningEffortValue(
      typeof entry === "string"
        ? entry
        : record?.reasoningEffort ??
          record?.reasoning_effort ??
          record?.effort ??
          record?.value,
    );
    if (!reasoningEffort) {
      return;
    }
    const key = reasoningEffort.toLocaleLowerCase();
    const description = typeof record?.description === "string"
      ? record.description.trim()
      : "";
    const previous = options.get(key);
    options.set(key, {
      reasoningEffort: previous?.reasoningEffort ?? reasoningEffort,
      description: description || previous?.description || "",
    });
  });
  return [...options.values()];
}

export function readReasoningEffortMetadata(record: Record<string, unknown>): {
  supportedReasoningEfforts?: ReasoningEffortOption[];
  defaultReasoningEffort?: string | null;
} {
  const supported = firstOwnValue(record, SUPPORTED_EFFORT_KEYS);
  const defaultEffort = firstOwnValue(record, DEFAULT_EFFORT_KEYS);
  return {
    ...(supported.found
      ? { supportedReasoningEfforts: parseReasoningEffortOptions(supported.value) }
      : {}),
    ...(defaultEffort.found
      ? { defaultReasoningEffort: normalizeReasoningEffortValue(defaultEffort.value) }
      : {}),
  };
}
