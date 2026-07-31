import type { ConversationItem, TurnExecutionSummary } from "@/types";

export type ConversationExportFormat = "pdf" | "png";

export type ConversationExportMessage = {
  id: string;
  role: "user" | "assistant";
  label: string;
  text: string;
  images: string[];
  createdAt: number | null;
};

export type ConversationExportProgress = {
  stage: "preparing" | "rendering" | "saving" | "completed" | "error";
  completed: number;
  total: number;
  messageCount: number;
  imageCount: number;
  path?: string;
  error?: string;
};

export function buildConversationExportFileName(
  format: ConversationExportFormat,
  date = new Date(),
) {
  const pad = (value: number) => String(value).padStart(2, "0");
  const timestamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(
    date.getDate(),
  )}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `ThreadFleet-${timestamp}.${format}`;
}

export function getExportableMessageIds(items: ConversationItem[]) {
  return items.flatMap((item) =>
    item.kind === "message" && (item.role === "user" || item.role === "assistant")
      ? [item.id]
      : [],
  );
}

export function buildConversationExportMessages(
  items: ConversationItem[],
  summaries: TurnExecutionSummary[],
  labels: { user: string; assistantFallback: string },
  selectedIds?: ReadonlySet<string> | null,
): ConversationExportMessage[] {
  const modelByTurn = new Map<string, string>();
  summaries.forEach((summary) => {
    const modelId = summary.modelId?.trim();
    if (!modelId) {
      return;
    }
    summary.turnChain.forEach((turnId) => modelByTurn.set(turnId, modelId));
  });

  return items.flatMap((item) => {
    if (
      item.kind !== "message" ||
      (item.role !== "user" && item.role !== "assistant") ||
      (selectedIds && !selectedIds.has(item.id))
    ) {
      return [];
    }
    const modelId = item.turnId ? modelByTurn.get(item.turnId) : null;
    return [{
      id: item.id,
      role: item.role,
      label: item.role === "user" ? labels.user : modelId || labels.assistantFallback,
      text: item.text,
      images: item.images ?? [],
      createdAt: item.createdAt ?? null,
    }];
  });
}

export function countConversationExportImages(messages: ConversationExportMessage[]) {
  return messages.reduce((total, message) => total + message.images.length, 0);
}
