import { describe, expect, it } from "vitest";
import type { ConversationItem } from "../types";
import {
  buildConversationItem,
  buildConversationItemFromThreadItem,
  buildCollabActualBinding,
  buildCollabExecutionBindingObservation,
  buildItemsFromThread,
  getThreadCreatedTimestamp,
  getThreadTimestamp,
  mergeThreadItems,
  normalizeItem,
  prepareThreadItems,
  upsertItem,
} from "./threadItems";

describe("threadItems", () => {
  it("truncates long message text in normalizeItem", () => {
    const text = "a".repeat(21000);
    const item: ConversationItem = {
      id: "msg-1",
      kind: "message",
      role: "assistant",
      text,
    };
    const normalized = normalizeItem(item);
    expect(normalized.kind).toBe("message");
    if (normalized.kind === "message") {
      expect(normalized.text).not.toBe(text);
      expect(normalized.text.endsWith("...")).toBe(true);
      expect(normalized.text.length).toBeLessThan(text.length);
    }
  });

  it("truncates extremely large tool output for fileChange and commandExecution", () => {
    const output = "x".repeat(250000);
    const item: ConversationItem = {
      id: "tool-1",
      kind: "tool",
      toolType: "fileChange",
      title: "File changes",
      detail: "",
      output,
    };
    const normalized = normalizeItem(item);
    expect(normalized.kind).toBe("tool");
    if (normalized.kind === "tool") {
      expect(normalized.output).not.toBe(output);
      expect(normalized.output?.endsWith("...")).toBe(true);
      expect((normalized.output ?? "").length).toBeLessThan(output.length);
    }
  });

  it("truncates older tool output in prepareThreadItems", () => {
    const output = "y".repeat(21000);
    const items: ConversationItem[] = Array.from({ length: 41 }, (_, index) => ({
      id: `tool-${index}`,
      kind: "tool",
      toolType: "commandExecution",
      title: "Tool",
      detail: "",
      output,
    }));
    const prepared = prepareThreadItems(items);
    const firstOutput = prepared[0].kind === "tool" ? prepared[0].output : undefined;
    const secondOutput = prepared[1].kind === "tool" ? prepared[1].output : undefined;
    expect(firstOutput).not.toBe(output);
    expect(firstOutput?.endsWith("...")).toBe(true);
    expect(secondOutput).toBe(output);
  });

  it("respects custom max items per thread in prepareThreadItems", () => {
    const items: ConversationItem[] = Array.from({ length: 5 }, (_, index) => ({
      id: `msg-${index}`,
      kind: "message",
      role: "assistant",
      text: `message ${index}`,
    }));
    const prepared = prepareThreadItems(items, { maxItemsPerThread: 3 });
    expect(prepared).toHaveLength(3);
    expect(prepared[0]?.id).toBe("msg-2");
    expect(prepared[2]?.id).toBe("msg-4");
  });

  it("supports unlimited max items per thread in prepareThreadItems", () => {
    const items: ConversationItem[] = Array.from({ length: 5 }, (_, index) => ({
      id: `msg-${index}`,
      kind: "message",
      role: "assistant",
      text: `message ${index}`,
    }));
    const prepared = prepareThreadItems(items, { maxItemsPerThread: null });
    expect(prepared).toHaveLength(5);
  });

  it("drops assistant review summaries that duplicate completed review items", () => {
    const items: ConversationItem[] = [
      {
        id: "review-1",
        kind: "review",
        state: "completed",
        text: "Review summary",
      },
      {
        id: "msg-1",
        kind: "message",
        role: "assistant",
        text: "Review summary",
      },
    ];
    const prepared = prepareThreadItems(items);
    expect(prepared).toHaveLength(1);
    expect(prepared[0].kind).toBe("review");
  });

  it("summarizes explored reads and hides raw commands", () => {
    const items: ConversationItem[] = [
      {
        id: "cmd-1",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: cat src/foo.ts",
        detail: "",
        status: "completed",
        output: "",
      },
      {
        id: "cmd-2",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: sed -n '1,10p' src/bar.ts",
        detail: "",
        status: "completed",
        output: "",
      },
      {
        id: "msg-1",
        kind: "message",
        role: "assistant",
        text: "Done reading",
      },
    ];

    const prepared = prepareThreadItems(items);
    expect(prepared[0].kind).toBe("explore");
    if (prepared[0].kind === "explore") {
      expect(prepared[0].entries).toHaveLength(2);
      expect(prepared[0].entries[0].kind).toBe("read");
      expect(prepared[0].entries[0].label).toContain("foo.ts");
      expect(prepared[0].entries[1].kind).toBe("read");
      expect(prepared[0].entries[1].label).toContain("bar.ts");
    }
    expect(prepared.filter((item) => item.kind === "tool")).toHaveLength(0);
  });

  it("treats inProgress command status as exploring", () => {
    const items: ConversationItem[] = [
      {
        id: "cmd-1",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: rg RouterDestination src",
        detail: "",
        status: "inProgress",
        output: "",
      },
    ];

    const prepared = prepareThreadItems(items);
    expect(prepared).toHaveLength(1);
    expect(prepared[0].kind).toBe("explore");
    if (prepared[0].kind === "explore") {
      expect(prepared[0].status).toBe("exploring");
      expect(prepared[0].entries[0]?.kind).toBe("search");
    }
  });

  it("deduplicates explore entries when consecutive summaries merge", () => {
    const items: ConversationItem[] = [
      {
        id: "cmd-1",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: cat src/customPrompts.ts",
        detail: "",
        status: "completed",
        output: "",
      },
      {
        id: "cmd-2",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: cat src/customPrompts.ts",
        detail: "",
        status: "completed",
        output: "",
      },
    ];

    const prepared = prepareThreadItems(items);
    expect(prepared).toHaveLength(1);
    expect(prepared[0].kind).toBe("explore");
    if (prepared[0].kind === "explore") {
      expect(prepared[0].entries).toHaveLength(1);
      expect(prepared[0].entries[0].label).toContain("customPrompts.ts");
    }
  });

  it("preserves distinct read paths that share the same basename", () => {
    const items: ConversationItem[] = [
      {
        id: "cmd-1",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: cat src/foo/index.ts",
        detail: "",
        status: "completed",
        output: "",
      },
      {
        id: "cmd-2",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: cat tests/foo/index.ts",
        detail: "",
        status: "completed",
        output: "",
      },
    ];

    const prepared = prepareThreadItems(items);
    expect(prepared).toHaveLength(1);
    expect(prepared[0].kind).toBe("explore");
    if (prepared[0].kind === "explore") {
      expect(prepared[0].entries).toHaveLength(2);
      const details = prepared[0].entries.map((entry) => entry.detail ?? entry.label);
      expect(details).toContain("src/foo/index.ts");
      expect(details).toContain("tests/foo/index.ts");
    }
  });

  it("preserves multi-path read commands instead of collapsing to the last path", () => {
    const items: ConversationItem[] = [
      {
        id: "cmd-1",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: cat src/a.ts src/b.ts",
        detail: "",
        status: "completed",
        output: "",
      },
    ];

    const prepared = prepareThreadItems(items);
    expect(prepared).toHaveLength(1);
    expect(prepared[0].kind).toBe("explore");
    if (prepared[0].kind === "explore") {
      expect(prepared[0].entries).toHaveLength(2);
      const details = prepared[0].entries.map((entry) => entry.detail ?? entry.label);
      expect(details).toContain("src/a.ts");
      expect(details).toContain("src/b.ts");
    }
  });

  it("ignores glob patterns when summarizing rg --files commands", () => {
    const items: ConversationItem[] = [
      {
        id: "cmd-1",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: rg --files -g '*.ts' src",
        detail: "",
        status: "completed",
        output: "",
      },
    ];

    const prepared = prepareThreadItems(items);
    expect(prepared).toHaveLength(1);
    expect(prepared[0].kind).toBe("explore");
    if (prepared[0].kind === "explore") {
      expect(prepared[0].entries).toHaveLength(1);
      expect(prepared[0].entries[0].kind).toBe("list");
      expect(prepared[0].entries[0].label).toBe("src");
    }
  });

  it("skips rg glob flag values and keeps the actual search path", () => {
    const items: ConversationItem[] = [
      {
        id: "cmd-1",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: rg myQuery -g '*.ts' src",
        detail: "",
        status: "completed",
        output: "",
      },
    ];

    const prepared = prepareThreadItems(items);
    expect(prepared).toHaveLength(1);
    expect(prepared[0].kind).toBe("explore");
    if (prepared[0].kind === "explore") {
      expect(prepared[0].entries).toHaveLength(1);
      expect(prepared[0].entries[0].kind).toBe("search");
      expect(prepared[0].entries[0].label).toBe("myQuery in src");
    }
  });

  it("unwraps unquoted /bin/zsh -lc rg commands", () => {
    const items: ConversationItem[] = [
      {
        id: "cmd-1",
        kind: "tool",
        toolType: "commandExecution",
        title: 'Command: /bin/zsh -lc rg -n "RouterDestination" src',
        detail: "",
        status: "completed",
        output: "",
      },
    ];

    const prepared = prepareThreadItems(items);
    expect(prepared).toHaveLength(1);
    expect(prepared[0].kind).toBe("explore");
    if (prepared[0].kind === "explore") {
      expect(prepared[0].entries).toHaveLength(1);
      expect(prepared[0].entries[0].kind).toBe("search");
      expect(prepared[0].entries[0].label).toBe("RouterDestination in src");
    }
  });

  it("treats nl -ba as a read command", () => {
    const items: ConversationItem[] = [
      {
        id: "cmd-1",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: nl -ba src/foo.ts",
        detail: "",
        status: "completed",
        output: "",
      },
    ];

    const prepared = prepareThreadItems(items);
    expect(prepared).toHaveLength(1);
    expect(prepared[0].kind).toBe("explore");
    if (prepared[0].kind === "explore") {
      expect(prepared[0].entries).toHaveLength(1);
      expect(prepared[0].entries[0].kind).toBe("read");
      expect(prepared[0].entries[0].detail ?? prepared[0].entries[0].label).toBe(
        "src/foo.ts",
      );
    }
  });

  it("summarizes piped nl commands using the left-hand read", () => {
    const items: ConversationItem[] = [
      {
        id: "cmd-1",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: nl -ba src/foo.ts | sed -n '1,10p'",
        detail: "",
        status: "completed",
        output: "",
      },
    ];

    const prepared = prepareThreadItems(items);
    expect(prepared).toHaveLength(1);
    expect(prepared[0].kind).toBe("explore");
    if (prepared[0].kind === "explore") {
      expect(prepared[0].entries).toHaveLength(1);
      expect(prepared[0].entries[0].kind).toBe("read");
      expect(prepared[0].entries[0].detail ?? prepared[0].entries[0].label).toBe(
        "src/foo.ts",
      );
    }
  });

  it("does not trim pipes that appear inside quoted arguments", () => {
    const items: ConversationItem[] = [
      {
        id: "cmd-1",
        kind: "tool",
        toolType: "commandExecution",
        title: 'Command: rg "foo | bar" src',
        detail: "",
        status: "completed",
        output: "",
      },
    ];

    const prepared = prepareThreadItems(items);
    expect(prepared).toHaveLength(1);
    expect(prepared[0].kind).toBe("explore");
    if (prepared[0].kind === "explore") {
      expect(prepared[0].entries).toHaveLength(1);
      expect(prepared[0].entries[0].kind).toBe("search");
      expect(prepared[0].entries[0].label).toBe("foo | bar in src");
    }
  });

  it("keeps raw commands when they are not recognized", () => {
    const items: ConversationItem[] = [
      {
        id: "cmd-1",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: git status",
        detail: "",
        status: "completed",
        output: "",
      },
    ];
    const prepared = prepareThreadItems(items);
    expect(prepared).toHaveLength(1);
    expect(prepared[0].kind).toBe("tool");
  });

  it("keeps raw commands when they fail", () => {
    const items: ConversationItem[] = [
      {
        id: "cmd-1",
        kind: "tool",
        toolType: "commandExecution",
        title: "Command: cat src/foo.ts",
        detail: "",
        status: "failed",
        output: "No such file",
      },
    ];
    const prepared = prepareThreadItems(items);
    expect(prepared).toHaveLength(1);
    expect(prepared[0].kind).toBe("tool");
  });

  it("builds file change items with summary details", () => {
    const item = buildConversationItem({
      type: "fileChange",
      id: "change-1",
      status: "done",
      changes: [
        {
          path: "foo.txt",
          kind: "add",
          diff: "diff --git a/foo.txt b/foo.txt",
        },
      ],
    });
    expect(item).not.toBeNull();
    if (item && item.kind === "tool") {
      expect(item.title).toBe("File changes");
      expect(item.detail).toBe("A foo.txt");
      expect(item.output).toContain("diff --git a/foo.txt b/foo.txt");
      expect(item.changes?.[0]?.path).toBe("foo.txt");
    }
  });

  it("defaults web search items to completed status", () => {
    const item = buildConversationItem({
      type: "webSearch",
      id: "web-1",
      query: "codex monitor",
    });
    expect(item).not.toBeNull();
    if (item && item.kind === "tool") {
      expect(item.toolType).toBe("webSearch");
      expect(item.status).toBe("completed");
      expect(item.detail).toBe("codex monitor");
    }
  });

  it("merges thread items preferring non-empty remote tool output", () => {
    const remote: ConversationItem = {
      id: "tool-2",
      kind: "tool",
      toolType: "webSearch",
      title: "Web search",
      detail: "query",
      status: "ok",
      output: "short",
    };
    const local: ConversationItem = {
      id: "tool-2",
      kind: "tool",
      toolType: "webSearch",
      title: "Web search",
      detail: "query",
      output: "much longer output",
    };
    const merged = mergeThreadItems([remote], [local]);
    expect(merged).toHaveLength(1);
    expect(merged[0].kind).toBe("tool");
    if (merged[0].kind === "tool") {
      expect(merged[0].output).toBe("short");
      expect(merged[0].status).toBe("ok");
    }
  });

  it("keeps local tool output when remote output is empty", () => {
    const remote: ConversationItem = {
      id: "tool-3",
      kind: "tool",
      toolType: "webSearch",
      title: "Web search",
      detail: "query",
      status: "completed",
      output: " ",
    };
    const local: ConversationItem = {
      id: "tool-3",
      kind: "tool",
      toolType: "webSearch",
      title: "Web search",
      detail: "query",
      output: "streamed output",
    };
    const merged = mergeThreadItems([remote], [local]);
    expect(merged).toHaveLength(1);
    expect(merged[0].kind).toBe("tool");
    if (merged[0].kind === "tool") {
      expect(merged[0].output).toBe("streamed output");
      expect(merged[0].status).toBe("completed");
    }
  });

  it("keeps local tool status when remote status is empty", () => {
    const remote: ConversationItem = {
      id: "tool-remote-status",
      kind: "tool",
      toolType: "webSearch",
      title: "Web search",
      detail: "query",
      status: "",
      output: "",
    };
    const local: ConversationItem = {
      id: "tool-remote-status",
      kind: "tool",
      toolType: "webSearch",
      title: "Web search",
      detail: "query",
      status: "completed",
      output: "",
    };
    const merged = mergeThreadItems([remote], [local]);
    expect(merged).toHaveLength(1);
    expect(merged[0].kind).toBe("tool");
    if (merged[0].kind === "tool") {
      expect(merged[0].status).toBe("completed");
    }
  });

  it("preserves streamed plan output when completion item has empty output", () => {
    const existing: ConversationItem = {
      id: "plan-1",
      kind: "tool",
      toolType: "plan",
      title: "Plan",
      detail: "Generating plan...",
      status: "in_progress",
      output: "## Plan\n- Step 1\n- Step 2",
    };
    const completed: ConversationItem = {
      id: "plan-1",
      kind: "tool",
      toolType: "plan",
      title: "Plan",
      detail: "",
      status: "completed",
      output: "",
    };

    const next = upsertItem([existing], completed);
    expect(next).toHaveLength(1);
    expect(next[0].kind).toBe("tool");
    if (next[0].kind === "tool") {
      expect(next[0].output).toBe(existing.output);
      expect(next[0].status).toBe("completed");
    }
  });

  it("uses incoming tool output even when shorter than existing output", () => {
    const existing: ConversationItem = {
      id: "tool-4",
      kind: "tool",
      toolType: "webSearch",
      title: "Web search",
      detail: "query",
      status: "in_progress",
      output: "verbose streamed output that will be replaced",
    };
    const incoming: ConversationItem = {
      id: "tool-4",
      kind: "tool",
      toolType: "webSearch",
      title: "Web search",
      detail: "query",
      status: "completed",
      output: "final",
    };

    const next = upsertItem([existing], incoming);
    expect(next).toHaveLength(1);
    expect(next[0].kind).toBe("tool");
    if (next[0].kind === "tool") {
      expect(next[0].output).toBe("final");
      expect(next[0].status).toBe("completed");
    }
  });

  it("replaces matching local user messages with server user messages", () => {
    const local: ConversationItem = {
      id: "local-user-123",
      kind: "message",
      role: "user",
      text: "show immediately",
      images: ["C:/tmp/image.png"],
    };
    const incoming: ConversationItem = {
      id: "server-user-1",
      kind: "message",
      role: "user",
      text: "show immediately",
      images: ["C:/tmp/image.png"],
    };

    const next = upsertItem([local], incoming);
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual(incoming);
  });

  it("replaces image echoes when equivalent Windows paths use different case and separators", () => {
    const local: ConversationItem = {
      id: "local-user-windows-image",
      kind: "message",
      role: "user",
      text: "看这张图",
      images: ["C:\\Users\\Lenovo\\.codex\\attachments\\IMAGE.PNG"],
    };
    const incoming: ConversationItem = {
      id: "server-user-windows-image",
      kind: "message",
      role: "user",
      text: "看这张图",
      images: ["c:/users/lenovo/.codex/attachments/image.png"],
    };

    expect(upsertItem([local], incoming)).toEqual([incoming]);
    expect(mergeThreadItems([incoming], [local])).toEqual([incoming]);
  });

  it("keeps same-text user messages when their image identities differ", () => {
    const local: ConversationItem = {
      id: "local-user-image-a",
      kind: "message",
      role: "user",
      text: "看这张图",
      images: ["C:/tmp/image-a.png"],
    };
    const incoming: ConversationItem = {
      id: "server-user-image-b",
      kind: "message",
      role: "user",
      text: "看这张图",
      images: ["C:/tmp/image-b.png"],
    };

    expect(mergeThreadItems([incoming], [local])).toEqual([incoming, local]);
  });

  it("replaces matching local user messages when file attachment echoes as a name", () => {
    const local: ConversationItem = {
      id: "local-user-attachment",
      kind: "message",
      role: "user",
      text: "看这个日志",
      attachments: ['data:text/plain;name="trace.log";base64,AAA'],
    };
    const incoming: ConversationItem = {
      id: "server-user-attachment",
      kind: "message",
      role: "user",
      text: "看这个日志",
      attachments: ["trace.log"],
    };

    const next = upsertItem([local], incoming);
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual(incoming);
  });

  it("drops matching local user echoes when merging refreshed thread items", () => {
    const local: ConversationItem = {
      id: "local-user-refresh",
      kind: "message",
      role: "user",
      text: "refresh without duplicates",
      attachments: ['data:text/plain;name="trace.log";base64,AAA'],
    };
    const remote: ConversationItem = {
      id: "server-user-refresh",
      kind: "message",
      role: "user",
      text: "refresh without duplicates",
      attachments: ["trace.log"],
    };

    const merged = mergeThreadItems([remote], [local]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(remote);
  });

  it("collapses consecutive local retry user messages with the same content", () => {
    const items: ConversationItem[] = [
      {
        id: "local-user-retry-1",
        kind: "message",
        role: "user",
        text: "retry this prompt",
        images: ["C:/tmp/image.png"],
      },
      {
        id: "local-user-retry-2",
        kind: "message",
        role: "user",
        text: "retry this prompt",
        images: ["C:/tmp/image.png"],
      },
    ];

    const prepared = prepareThreadItems(items, { maxItemsPerThread: null });

    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.id).toBe("local-user-retry-1");
  });

  it("collapses consecutive server user messages when their content matches", () => {
    const items: ConversationItem[] = [
      {
        id: "server-user-1",
        kind: "message",
        role: "user",
        text: "repeat intentionally",
      },
      {
        id: "server-user-2",
        kind: "message",
        role: "user",
        text: "repeat intentionally",
      },
    ];

    const prepared = prepareThreadItems(items, { maxItemsPerThread: null });

    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.id).toBe("server-user-1");
  });

  it("keeps consecutive user messages when their content differs", () => {
    const items: ConversationItem[] = [
      {
        id: "server-user-1",
        kind: "message",
        role: "user",
        text: "first prompt",
      },
      {
        id: "server-user-2",
        kind: "message",
        role: "user",
        text: "second prompt",
      },
    ];

    const prepared = prepareThreadItems(items, { maxItemsPerThread: null });

    expect(prepared).toHaveLength(2);
  });

  it("preserves streamed reasoning content when completion item is empty", () => {
    const existing: ConversationItem = {
      id: "reasoning-1",
      kind: "reasoning",
      summary: "Thinking",
      content: "More detail",
    };
    const completed: ConversationItem = {
      id: "reasoning-1",
      kind: "reasoning",
      summary: "",
      content: "",
    };

    const next = upsertItem([existing], completed);
    expect(next).toHaveLength(1);
    expect(next[0].kind).toBe("reasoning");
    if (next[0].kind === "reasoning") {
      expect(next[0].summary).toBe("Thinking");
      expect(next[0].content).toBe("More detail");
    }
  });

  it("preserves existing userInput answers when incoming payload has equal question count and no answers", () => {
    const existing: ConversationItem = {
      id: "user-input-1",
      kind: "userInput",
      status: "answered",
      questions: [
        {
          id: "q1",
          header: "Confirm",
          question: "Proceed?",
          answers: ["Yes"],
        },
      ],
    };
    const incoming: ConversationItem = {
      id: "user-input-1",
      kind: "userInput",
      status: "answered",
      questions: [
        {
          id: "q1",
          header: "Confirm",
          question: "Proceed?",
          answers: [],
        },
      ],
    };

    const next = upsertItem([existing], incoming);
    expect(next).toHaveLength(1);
    expect(next[0].kind).toBe("userInput");
    if (next[0].kind === "userInput") {
      expect(next[0].questions[0]?.answers).toEqual(["Yes"]);
    }
  });

  it("preserves existing answers for questions that are empty in a partial userInput upsert", () => {
    const existing: ConversationItem = {
      id: "user-input-2",
      kind: "userInput",
      status: "answered",
      questions: [
        {
          id: "q1",
          header: "Question 1",
          question: "Choose release mode",
          answers: ["Safe"],
        },
        {
          id: "q2",
          header: "Question 2",
          question: "Choose deployment time",
          answers: ["Tonight"],
        },
      ],
    };
    const incoming: ConversationItem = {
      id: "user-input-2",
      kind: "userInput",
      status: "answered",
      questions: [
        {
          id: "q1",
          header: "Question 1",
          question: "Choose release mode",
          answers: ["Fast"],
        },
        {
          id: "q2",
          header: "Question 2",
          question: "Choose deployment time",
          answers: [],
        },
      ],
    };

    const next = upsertItem([existing], incoming);
    expect(next).toHaveLength(1);
    expect(next[0].kind).toBe("userInput");
    if (next[0].kind === "userInput") {
      expect(next[0].questions).toHaveLength(2);
      expect(next[0].questions[0]?.answers).toEqual(["Fast"]);
      expect(next[0].questions[1]?.answers).toEqual(["Tonight"]);
    }
  });

  it("preserves answered questions missing from a partial userInput upsert", () => {
    const existing: ConversationItem = {
      id: "user-input-3",
      kind: "userInput",
      status: "answered",
      questions: [
        {
          id: "q1",
          header: "Question 1",
          question: "Primary answer",
          answers: ["A"],
        },
        {
          id: "q2",
          header: "Question 2",
          question: "Secondary answer",
          answers: ["B"],
        },
      ],
    };
    const incoming: ConversationItem = {
      id: "user-input-3",
      kind: "userInput",
      status: "answered",
      questions: [
        {
          id: "q1",
          header: "Question 1",
          question: "Primary answer",
          answers: ["A2"],
        },
      ],
    };

    const next = upsertItem([existing], incoming);
    expect(next).toHaveLength(1);
    expect(next[0].kind).toBe("userInput");
    if (next[0].kind === "userInput") {
      expect(next[0].questions).toHaveLength(2);
      expect(next[0].questions[0]?.id).toBe("q1");
      expect(next[0].questions[0]?.answers).toEqual(["A2"]);
      expect(next[0].questions[1]?.id).toBe("q2");
      expect(next[0].questions[1]?.answers).toEqual(["B"]);
    }
  });

  it("builds user message text from mixed inputs", () => {
    const item = buildConversationItemFromThreadItem({
      type: "userMessage",
      id: "msg-1",
      content: [
        { type: "text", text: "Please" },
        { type: "skill", name: "Review" },
        { type: "image", url: "https://example.com/image.png" },
      ],
    });
    expect(item).not.toBeNull();
    if (item && item.kind === "message") {
      expect(item.role).toBe("user");
      expect(item.text).toBe("Please $Review");
      expect(item.images).toEqual(["https://example.com/image.png"]);
    }
  });

  it("normalizes live subagent checkpoint injections as system items", () => {
    const item = buildConversationItem({
      type: "userMessage",
      id: "checkpoint-live-1",
      createdAt: 1_700_000_000,
      content: [
        {
          type: "text",
          text:
            '<subagent_checkpoint checkpoint_id="child:item:progress" child_thread_id="child" child_name="worker&lt;1&gt;" priority="normal" sequence="1">\nProgress update\n</subagent_checkpoint>',
        },
      ],
    });

    expect(item).toEqual({
      id: "checkpoint-live-1",
      kind: "subagentCheckpoint",
      createdAt: 1_700_000_000_000,
      checkpoints: [
        {
          checkpointId: "child:item:progress",
          childThreadId: "child",
          childName: "worker<1>",
          priority: "normal",
          sequence: 1,
          text: "Progress update",
        },
      ],
    });
  });

  it("normalizes batched checkpoint history without user-message identity", () => {
    const items = buildItemsFromThread({
      turns: [
        {
          items: [
            {
              type: "userMessage",
              id: "checkpoint-history-1",
              content: [
                {
                  type: "text",
                  text:
                    '<subagent_checkpoint checkpoint_id="child:item-1:progress" child_thread_id="child" priority="normal" sequence="1">\nFirst update\n</subagent_checkpoint>\n\n' +
                    '<subagent_checkpoint checkpoint_id="child:item-2:final" child_thread_id="child" priority="final" sequence="2">\nFinal result\n</subagent_checkpoint>',
                },
              ],
            },
          ],
        },
      ],
    });
    const item = items[0];

    expect(item).toMatchObject({
      id: "checkpoint-history-1",
      kind: "subagentCheckpoint",
      checkpoints: [
        { priority: "normal", sequence: 1, text: "First update" },
        { priority: "final", sequence: 2, text: "Final result" },
      ],
    });
  });

  it("builds dynamic tool call items from persisted history", () => {
    const item = buildConversationItem({
      type: "dynamicToolCall",
      id: "dynamic-1",
      namespace: "functions",
      tool: "exec",
      arguments: "const result = await tools.exec_command({ cmd: 'git status' });",
      status: "completed",
      contentItems: [{ type: "inputText", text: "Script completed" }],
      success: true,
      durationMs: 25,
      lineChangeStats: { additions: 3, deletions: 1 },
    });

    expect(item).not.toBeNull();
    if (item?.kind === "tool") {
      expect(item.toolType).toBe("dynamicToolCall");
      expect(item.title).toBe("Tool: functions / exec");
      expect(item.detail).toContain("tools.exec_command");
      expect(item.output).toBe("Script completed");
      expect(item.durationMs).toBe(25);
      expect(item.lineChangeStats).toEqual({ additions: 3, deletions: 1 });
    }
  });

  it("keeps the remote agent phase when local streamed text is richer", () => {
    const merged = mergeThreadItems(
      [
        {
          id: "assistant-1",
          kind: "message",
          role: "assistant",
          text: "Done",
          phase: "final_answer",
          turnId: "turn-1",
        },
      ],
      [
        {
          id: "assistant-1",
          kind: "message",
          role: "assistant",
          text: "Done with streamed detail",
        },
      ],
    );

    expect(merged[0]).toMatchObject({
      text: "Done with streamed detail",
      phase: "final_answer",
      turnId: "turn-1",
    });
  });

  it("uses trusted turn boundaries when historical message item timestamps are absent", () => {
    const items = buildItemsFromThread({
      turns: [
        {
          id: "turn-1",
          startedAt: 1_700_000_000,
          completedAt: 1_700_000_030,
          items: [
            {
              type: "userMessage",
              id: "user-1",
              content: [{ type: "text", text: "Question" }],
            },
            {
              type: "agentMessage",
              id: "assistant-progress-1",
              phase: "commentary",
              text: "Working",
            },
            {
              type: "agentMessage",
              id: "assistant-final-1",
              phase: "final_answer",
              text: "Done",
            },
          ],
        },
      ],
    });

    expect(items).toMatchObject([
      { id: "user-1", createdAt: 1_700_000_000_000 },
      {
        id: "assistant-progress-1",
        phase: "commentary",
        createdAt: undefined,
      },
      {
        id: "assistant-final-1",
        phase: "final_answer",
        createdAt: 1_700_000_030_000,
      },
    ]);
  });

  it("keeps incomplete checkpoint-like user text as a user message", () => {
    const text =
      '<subagent_checkpoint child_thread_id="child" priority="normal">\nUser-authored example\n</subagent_checkpoint>';
    const item = buildConversationItemFromThreadItem({
      type: "userMessage",
      id: "checkpoint-like-user-text",
      content: [{ type: "text", text }],
    });

    expect(item).toMatchObject({
      id: "checkpoint-like-user-text",
      kind: "message",
      role: "user",
      text,
    });
  });

  it("keeps checkpoint-like mixed inputs as a user message", () => {
    const envelope =
      '<subagent_checkpoint checkpoint_id="child:item:progress" child_thread_id="child" priority="normal" sequence="1">\nProgress\n</subagent_checkpoint>';
    const item = buildConversationItemFromThreadItem({
      type: "userMessage",
      id: "checkpoint-mixed-user-text",
      content: [
        { type: "text", text: envelope },
        { type: "skill", name: "review" },
      ],
    });

    expect(item).toMatchObject({
      kind: "message",
      role: "user",
      text: `${envelope} $review`,
    });
  });

  it("keeps envelopes outside producer invariants as user messages", () => {
    const mismatchedId =
      '<subagent_checkpoint checkpoint_id="other:item:progress" child_thread_id="child" priority="normal" sequence="1">\nProgress\n</subagent_checkpoint>';
    const oversized = `<subagent_checkpoint checkpoint_id="child:item:progress" child_thread_id="child" priority="normal" sequence="1">\n${"x".repeat(
      2_001,
    )}\n</subagent_checkpoint>`;

    for (const [id, text] of [
      ["checkpoint-mismatched-id", mismatchedId],
      ["checkpoint-oversized", oversized],
    ]) {
      expect(
        buildConversationItemFromThreadItem({
          type: "userMessage",
          id,
          content: [{ type: "text", text }],
        }),
      ).toMatchObject({ kind: "message", role: "user", text });
    }
  });

  it("extracts inline attached_file payloads from user text", () => {
    const item = buildConversationItemFromThreadItem({
      type: "userMessage",
      id: "msg-attached-file",
      content: [
        {
          type: "text",
          text: '请分析\n<attached_file name="notes.log">very long log body</attached_file>',
        },
      ],
    });

    expect(item).not.toBeNull();
    if (item && item.kind === "message") {
      expect(item.role).toBe("user");
      expect(item.text).toBe("请分析");
      expect(item.text).not.toContain("very long log body");
      expect(item.attachments).toEqual(["notes.log"]);
    }
  });

  it("extracts content references from user text", () => {
    const item = buildConversationItemFromThreadItem({
      type: "userMessage",
      id: "msg-content-reference",
      content: [
        {
          type: "text",
          text:
            "请分析\n<content_reference\n" +
            '  id="content-ref-1"\n' +
            '  source_kind="attachment"\n' +
            '  source_name="notes.log"\n' +
            '  path="C:\\Codex\\references\\content-ref-1\\content.md"\n' +
            ">\n" +
            "Read the referenced Markdown file only when its exact content is needed.\n" +
            "</content_reference>",
        },
      ],
    });

    expect(item).not.toBeNull();
    if (item && item.kind === "message") {
      expect(item.role).toBe("user");
      expect(item.text).toBe("请分析");
      expect(item.text).not.toContain("content_reference");
      expect(item.attachments).toEqual(["notes.log"]);
    }
  });

  it("treats non-image data URL inputs as file attachments", () => {
    const item = buildConversationItemFromThreadItem({
      type: "userMessage",
      id: "msg-text-attachment",
      content: [
        { type: "text", text: "看这个日志" },
        {
          type: "image",
          url: 'data:text/plain;name="trace.log";base64,AAA',
        },
      ],
    });

    expect(item).not.toBeNull();
    if (item && item.kind === "message") {
      expect(item.role).toBe("user");
      expect(item.text).toBe("看这个日志");
      expect(item.images).toBeUndefined();
      expect(item.attachments).toEqual([
        'data:text/plain;name="trace.log";base64,AAA',
      ]);
    }
  });

  it("keeps image-only user messages without placeholder text", () => {
    const item = buildConversationItemFromThreadItem({
      type: "userMessage",
      id: "msg-2",
      content: [{ type: "image", url: "https://example.com/only.png" }],
    });
    expect(item).not.toBeNull();
    if (item && item.kind === "message") {
      expect(item.role).toBe("user");
      expect(item.text).toBe("");
      expect(item.images).toEqual(["https://example.com/only.png"]);
    }
  });

  it("formats collab tool calls with receivers and agent states", () => {
    const item = buildConversationItem({
      type: "collabToolCall",
      id: "collab-1",
      tool: "handoff",
      status: "ok",
      senderThreadId: "thread-a",
      receiverThreadIds: ["thread-b"],
      newThreadId: "thread-c",
      prompt: "Coordinate work",
      agentStatus: { "agent-1": { status: "running" } },
    });
    expect(item).not.toBeNull();
    if (item && item.kind === "tool") {
      expect(item.title).toBe("Collab: handoff");
      expect(item.detail).toContain("From thread-a");
      expect(item.detail).toContain("thread-b");
      expect(item.detail).toContain("thread-c");
      expect(item.output).toBe("Coordinate work\n\nagent-1: running");
    }
  });

  it("retains actual model and reasoning effort from collab spawn items", () => {
    const camelCase = buildConversationItem({
      type: "collabAgentToolCall",
      id: "collab-binding-camel",
      tool: "spawn_agent",
      status: "completed",
      senderThreadId: "thread-parent",
      receiverThreadIds: ["thread-child"],
      model: " gpt-5.6-terra ",
      reasoningEffort: " low ",
    });
    const snakeCase = buildConversationItem({
      type: "collabAgentToolCall",
      id: "collab-binding-snake",
      tool: "spawn_agent",
      status: "completed",
      sender_thread_id: "thread-parent",
      receiver_thread_ids: ["thread-child"],
      model: "gpt-5.6-luna",
      reasoning_effort: "medium",
    });

    expect(camelCase).toMatchObject({
      kind: "tool",
      collabModel: "gpt-5.6-terra",
      collabReasoningEffort: "low",
    });
    expect(snakeCase).toMatchObject({
      kind: "tool",
      collabModel: "gpt-5.6-luna",
      collabReasoningEffort: "medium",
    });
  });

  it("omits blank collab model binding metadata", () => {
    const item = buildConversationItem({
      type: "collabAgentToolCall",
      id: "collab-binding-empty",
      tool: "spawn_agent",
      status: "completed",
      model: "  ",
      reasoning_effort: "\t",
    });

    expect(item).not.toBeNull();
    if (item && item.kind === "tool") {
      expect(item.collabModel).toBeUndefined();
      expect(item.collabReasoningEffort).toBeUndefined();
    }
  });

  it("keeps streamed collab binding metadata when completion omits it", () => {
    const remote: ConversationItem = {
      id: "collab-binding-merge",
      kind: "tool",
      toolType: "collabToolCall",
      title: "Collab: spawn_agent",
      detail: "",
      status: "completed",
      output: "",
    };
    const local: ConversationItem = {
      ...remote,
      status: "in_progress",
      collabModel: "gpt-5.6-terra",
      collabReasoningEffort: "high",
    };

    const merged = mergeThreadItems([remote], [local]);

    expect(merged[0]).toMatchObject({
      collabModel: "gpt-5.6-terra",
      collabReasoningEffort: "high",
      status: "completed",
    });
  });

  it("projects normalized collab metadata into an actual binding", () => {
    const item = buildConversationItem({
      type: "collabAgentToolCall",
      id: "collab-binding-audit",
      tool: "spawn_agent",
      status: "completed",
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
    });

    expect(item && buildCollabActualBinding(item)).toEqual({
      modelId: "gpt-5.6-luna",
      reasoningEffort: "low",
    });
  });

  it("observes a real spawn from subAgentActivity without prompt data", () => {
    const observation = buildCollabExecutionBindingObservation(
      {
        type: "subAgentActivity",
        id: "call-spawn-1",
        kind: "started",
        agentThreadId: "thread-child-1",
      },
      "thread-parent-1",
    );

    expect(observation).toEqual({
      parentThreadId: "thread-parent-1",
      collabToolCallId: "call-spawn-1",
      senderThreadId: "thread-parent-1",
      receiverThreadIds: ["thread-child-1"],
      actual: { modelId: null, reasoningEffort: null },
    });
    expect(observation).not.toHaveProperty("prompt");
  });

  it("does not observe wait_agent as a spawn binding", () => {
    expect(
      buildCollabExecutionBindingObservation(
        {
          type: "collabAgentToolCall",
          id: "call-wait-1",
          tool: "wait_agent",
          senderThreadId: "thread-parent-1",
        },
        "thread-parent-1",
      ),
    ).toBeNull();
  });

  it("keeps metadata-visible spawn_agent observation support", () => {
    expect(
      buildCollabExecutionBindingObservation(
        {
          type: "collabAgentToolCall",
          id: "call-spawn-2",
          tool: "spawn_agent",
          sender_thread_id: "thread-parent-1",
          receiver_thread_ids: ["thread-child-2"],
          model: "gpt-5.6-luna",
          reasoning_effort: "low",
          prompt: "sensitive prompt",
        },
        "fallback-parent",
      ),
    ).toEqual({
      parentThreadId: "thread-parent-1",
      collabToolCallId: "call-spawn-2",
      senderThreadId: "thread-parent-1",
      receiverThreadIds: ["thread-child-2"],
      actual: { modelId: "gpt-5.6-luna", reasoningEffort: "low" },
    });
  });

  it("captures rich collab metadata from receiver_agents and agent_statuses", () => {
    const item = buildConversationItem({
      type: "collabToolCall",
      id: "collab-rich-1",
      tool: "wait",
      status: "completed",
      sender_thread_id: "thread-parent",
      receiver_agents: [
        {
          thread_id: "thread-child-1",
          agent_nickname: "Robie",
          agent_role: "explorer",
        },
      ],
      agent_statuses: [
        {
          thread_id: "thread-child-1",
          status: "completed",
          agent_nickname: "Robie",
          agent_role: "explorer",
        },
      ],
      prompt: "Wait for workers",
    });

    expect(item).not.toBeNull();
    if (item && item.kind === "tool") {
      expect(item.collabSender).toEqual({ threadId: "thread-parent" });
      expect(item.collabReceiver).toEqual({
        threadId: "thread-child-1",
        nickname: "Robie",
        role: "explorer",
      });
      expect(item.collabReceivers).toEqual([
        {
          threadId: "thread-child-1",
          nickname: "Robie",
          role: "explorer",
        },
      ]);
      expect(item.collabStatuses).toEqual([
        {
          threadId: "thread-child-1",
          nickname: "Robie",
          role: "explorer",
          status: "completed",
        },
      ]);
      expect(item.detail).toContain("Robie [explorer]");
      expect(item.output).toContain("Robie [explorer]: completed");
    }
  });

  it("builds context compaction items", () => {
    const item = buildConversationItem({
      type: "contextCompaction",
      id: "compact-1",
      status: "inProgress",
    });
    expect(item).not.toBeNull();
    if (item && item.kind === "tool") {
      expect(item.toolType).toBe("contextCompaction");
      expect(item.title).toBe("Context compaction");
      expect(item.status).toBe("inProgress");
    }
  });

  it("builds context compaction items from thread history", () => {
    const item = buildConversationItemFromThreadItem({
      type: "contextCompaction",
      id: "compact-2",
    });
    expect(item).not.toBeNull();
    if (item && item.kind === "tool") {
      expect(item.toolType).toBe("contextCompaction");
      expect(item.title).toBe("Context compaction");
      expect(item.status).toBe("completed");
    }
  });

  it("builds structured skill process items", () => {
    const item = buildConversationItem({
      type: "skillTriggered",
      id: "skill-1",
      skill: { name: "diagnose" },
      reason: "bug report matched",
      status: "started",
    });

    expect(item).toEqual({
      id: "skill-1",
      kind: "process",
      processType: "skillTriggered",
      label: "diagnose",
      detail: "bug report matched",
      status: "started",
    });
  });

  it("builds structured agent process items from thread history", () => {
    const item = buildConversationItemFromThreadItem({
      type: "agent_spawned",
      id: "agent-1",
      agent: {
        agent_nickname: "Atlas",
        agent_role: "reviewer",
      },
    });

    expect(item).toEqual({
      id: "agent-1",
      kind: "process",
      processType: "agentSpawned",
      label: "Atlas [reviewer]",
      detail: undefined,
      status: undefined,
    });
  });

  it("parses ISO timestamps for thread updates", () => {
    const timestamp = getThreadTimestamp({ updated_at: "2025-01-01T00:00:00Z" });
    expect(timestamp).toBe(Date.parse("2025-01-01T00:00:00Z"));
  });

  it("returns 0 for invalid thread timestamps", () => {
    const timestamp = getThreadTimestamp({ updated_at: "not-a-date" });
    expect(timestamp).toBe(0);
  });

  it("parses created timestamps", () => {
    const timestamp = getThreadCreatedTimestamp({ created_at: "2025-01-01T00:00:00Z" });
    expect(timestamp).toBe(Date.parse("2025-01-01T00:00:00Z"));
  });

});
