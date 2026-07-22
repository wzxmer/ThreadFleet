import type { ModelOption } from "../../../types";
import {
  normalizeReasoningEffortValue,
  readReasoningEffortMetadata,
} from "@utils/reasoningEfforts";

export const normalizeEffortValue = normalizeReasoningEffortValue;

function extractModelItems(response: unknown): unknown[] {
  if (!response || typeof response !== "object") {
    return [];
  }

  const record = response as Record<string, unknown>;
  const result =
    record.result && typeof record.result === "object"
      ? (record.result as Record<string, unknown>)
      : null;

  const resultData = result?.data;
  if (Array.isArray(resultData)) {
    return resultData;
  }

  const topLevelData = record.data;
  if (Array.isArray(topLevelData)) {
    return topLevelData;
  }

  return [];
}

export function parseModelListResponse(response: unknown): ModelOption[] {
  const items = extractModelItems(response);

  return items
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const record = item as Record<string, unknown>;
      const modelSlug = String(record.model ?? record.id ?? "");
      const rawDisplayName = String(record.displayName || record.display_name || "");
      const displayName = rawDisplayName.trim().length > 0 ? rawDisplayName : modelSlug;
      const reasoning = readReasoningEffortMetadata(record);
      return {
        id: String(record.id ?? record.model ?? ""),
        model: modelSlug,
        displayName,
        description: String(record.description ?? ""),
        supportedReasoningEfforts: reasoning.supportedReasoningEfforts ?? [],
        defaultReasoningEffort: reasoning.defaultReasoningEffort ?? null,
        isDefault: Boolean(record.isDefault ?? record.is_default ?? false),
      } satisfies ModelOption;
    })
    .filter((model): model is ModelOption => model !== null);
}
