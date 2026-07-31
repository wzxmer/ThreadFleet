import { describe, expect, it } from "vitest";
import type { ConversationItem, TurnExecutionSummary } from "@/types";
import {
  buildConversationExportFileName,
  buildConversationExportMessages,
  getExportableMessageIds,
} from "./conversationExport";

const summaries: TurnExecutionSummary[] = [{
  schemaVersion: 1,
  executionId: "execution-1",
  workspaceId: "ws-1",
  threadId: "thread-1",
  turnId: "turn-1",
  turnChain: ["turn-1"],
  modelId: "gpt-5-codex",
  status: "completed",
  startedAtMs: 1,
  endedAtMs: 2,
  workingDurationMs: 1,
  addedLines: null,
  deletedLines: null,
  diffRevision: 0,
  recordRevision: 1,
  updatedAtMs: 2,
}];

const items = [
  { kind: "tool", id: "tool-1", toolType: "command", detail: "internal" },
  { kind: "message", id: "user-1", role: "user", text: "Question", turnId: "turn-1", images: [] },
  { kind: "reasoning", id: "reasoning-1", content: "hidden" },
  { kind: "message", id: "assistant-1", role: "assistant", text: "Answer", turnId: "turn-1", images: ["image.png"] },
] as ConversationItem[];
const labels = { user: "User", assistantFallback: "AI" };

describe("conversation export data contract", () => {
  it("keeps only user and assistant messages in source order", () => {
    expect(getExportableMessageIds(items)).toEqual(["user-1", "assistant-1"]);
    expect(buildConversationExportMessages(items, summaries, labels)).toMatchObject([
      { id: "user-1", label: "User" },
      { id: "assistant-1", label: "gpt-5-codex", images: ["image.png"] },
    ]);
  });

  it("does not use the current model when historical model data is absent", () => {
    const messages = buildConversationExportMessages(items, [], labels);
    expect(messages[1]?.label).toBe("AI");
  });

  it("supports a selected subset and deterministic default names", () => {
    expect(
      buildConversationExportMessages(items, summaries, labels, new Set(["assistant-1"])),
    ).toHaveLength(1);
    expect(buildConversationExportFileName("pdf", new Date(2026, 6, 29, 1, 2, 3))).toBe(
      "ThreadFleet-20260729-010203.pdf",
    );
  });
});
