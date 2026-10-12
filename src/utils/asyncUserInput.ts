import type { ConversationItem } from "@/types";

export type AsyncQuestions = Extract<ConversationItem, { kind: "message" }>["asyncQuestions"];

// Async questions are agent messages, not pending JSON-RPC server requests.
export function parseAsyncQuestions(item: Record<string, unknown>): AsyncQuestions {
  if (item.delivery !== "async" || !Array.isArray(item.questions)) return undefined;
  const questions = item.questions.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.title !== "string" || !entry.title.trim()) return [];
    const options = Array.isArray(entry.options)
      ? entry.options.filter((option: unknown): option is string => typeof option === "string" && Boolean(option.trim()))
      : [];
    return [{ title: entry.title, ...(options.length ? { options } : {}) }];
  });
  return questions.length ? questions : undefined;
}
