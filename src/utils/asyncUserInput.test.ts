import { describe, expect, it } from "vitest";
import { buildConversationItemFromThreadItem, prepareThreadItems } from "./threadItems";
import { parseAsyncQuestions } from "./asyncUserInput";

describe("async user input metadata", () => {
  it("preserves the installed protocol's questions through history normalization", () => {
    const questions = [{ title: "如何处理？", options: ["启用", "停用"] }, { title: "原因？", options: null }];
    const item = buildConversationItemFromThreadItem({ type: "agentMessage", id: "call-q", text: "如何处理？", delivery: "async", phase: "final_answer", questions })!;
    expect(prepareThreadItems([item])[0]).toMatchObject({ id: "call-q", asyncQuestions: [{ title: "如何处理？", options: ["启用", "停用"] }, { title: "原因？" }] });
  });

  it("does not invent async questions from ordinary messages or invalid metadata", () => {
    expect(parseAsyncQuestions({ questions: [{ title: "Question?" }] })).toBeUndefined();
    expect(parseAsyncQuestions({ delivery: "async", questions: [null, "invalid", { title: "" }] })).toBeUndefined();
    expect(parseAsyncQuestions({ delivery: "async", questions: [{ title: "Question?", options: [null, 2, "", "A"] }] })).toEqual([{ title: "Question?", options: ["A"] }]);
  });
});
