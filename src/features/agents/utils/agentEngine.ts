import type { AgentEngine } from "@/types";

export function getThreadEngine(threadId: string | null | undefined): AgentEngine {
  return threadId?.startsWith("gemini:") ? "gemini" : "codex";
}

export function isGeminiThread(threadId: string | null | undefined): boolean {
  return getThreadEngine(threadId) === "gemini";
}
