import { describe, expect, it } from "vitest";
import type { ConversationItem } from "@/types";
import { buildQuestionReplyMessage, extractQuestionChoices, getPendingAsyncQuestionIds, getQuestionReplyTarget } from "./questionReply";

describe("questionReply", () => {
  it("keeps async questions through progress and resolves only the explicitly quoted answer", () => {
    const first: ConversationItem = { id: "q1", kind: "message", role: "assistant", text: "First?", asyncQuestions: [{ title: "First?" }] };
    const second: ConversationItem = { ...first, id: "q2", text: "Second?", asyncQuestions: [{ title: "Second?" }] };
    const progress: ConversationItem = { id: "p", kind: "message", role: "assistant", text: "Working." };
    const answer: ConversationItem = { id: "a", kind: "message", role: "user", text: buildQuestionReplyMessage(first.text, ["A"]) };
    expect(getPendingAsyncQuestionIds([first, second, progress])).toEqual(new Set(["q2", "q1"]));
    expect(getPendingAsyncQuestionIds([first, second, progress, answer])).toEqual(new Set(["q2"]));
    expect(getPendingAsyncQuestionIds([first, second, { ...answer, text: "Both are fine." }])).toEqual(new Set());
  });
  it("extracts the screenshot's terminal choices without selecting one", () => {
    expect(extractQuestionChoices("网站有 ICP 备案吗？这会决定服务器地区。\n\n- 没有，香港\n\n- 有，大陆\n\n- 不确定")).toEqual({
      question: "网站有 ICP 备案吗？这会决定服务器地区。",
      options: ["没有，香港", "有，大陆", "不确定"].map((label) => ({ label, description: "" })),
    });
  });
  it("declines ordinary lists, fenced code, checklists and ambiguous nested lists", () => {
    for (const text of ["已完成：\n- A\n- B", "选哪个？\n```\n- A\n- B\n```", "选哪个？\n- [x] A\n- [ ] B", "选哪个？\n- A\n  - B\n  - C"]) {
      expect(extractQuestionChoices(text)).toBeNull();
    }
  });
  it("only offers reply to the latest unanswered assistant message", () => {
    const question: ConversationItem = { id: "q", kind: "message", role: "assistant", text: "Which region?" };
    const answer: ConversationItem = { id: "a", kind: "message", role: "user", text: "Hong Kong" };
    expect(getQuestionReplyTarget([question])).toBe(question);
    expect(getQuestionReplyTarget([question, answer])).toBeNull();
    expect(getQuestionReplyTarget([question, { ...question, id: "done", text: "Done." }])).toBeNull();
    expect(getQuestionReplyTarget([{ ...question, text: "```js\nconst x = a ? b : c;\n```" }])).toBeNull();
  });
  it("quotes the full question context and appends the actual answer", () => {
    expect(buildQuestionReplyMessage("ICP?\n- A\n- B", ["B", "user_note: details"])).toBe("> ICP?\n> - A\n> - B\n\nB\nuser_note: details");
  });
});
