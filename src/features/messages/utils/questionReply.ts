import type { ConversationItem, RequestUserInputOption } from "@/types";

export function getQuestionReplyTarget(items: ConversationItem[]) {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item.kind === "userInput") return null;
    if (item.kind !== "message") continue;
    if (item.role !== "assistant") return null;
    const prose = item.text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "");
    return /[?？]|请选择|请先选择|please (?:choose|select)/i.test(prose) ? item : null;
  }
  return null;
}

// Used only after the user explicitly opens the reply form. A list never
// creates a server request, changes execution state, or selects an answer.
export function extractQuestionChoices(text: string): { question: string; options: RequestUserInputOption[] } | null {
  if (/```|~~~/.test(text)) return null;
  const lines = text.trim().split(/\r?\n/);
  const options: RequestUserInputOption[] = [];
  let index = lines.length - 1;
  for (; index >= 0; index--) {
    const line = lines[index].trim();
    if (!line) continue;
    if (/^\s+/.test(lines[index]) && /^(?:[-*+•]|\d+[.)、])\s/.test(line)) return null;
    const match = line.match(/^(?:[-*+•]|\d+[.)、])\s+(.+)$/);
    if (!match) break;
    const label = match[1].trim();
    if (label.length > 240 || /^\[[ xX]\]/.test(label)) return null;
    options.unshift({ label, description: "" });
  }
  const question = lines.slice(0, index + 1).join("\n").trim();
  if (options.length < 2 || options.length > 8 || new Set(options.map((option) => option.label)).size !== options.length) return null;
  if (!/[?？]|请选择|请先选择|please (?:choose|select)/i.test(question)) return null;
  return { question, options };
}

export function buildQuestionReplyMessage(question: string, answers: string[]) {
  return ["> " + question.trim().split(/\r?\n/).join("\n> "), "", ...answers].join("\n");
}
