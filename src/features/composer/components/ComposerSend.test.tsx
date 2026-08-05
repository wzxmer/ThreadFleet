/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isMobilePlatform } from "../../../utils/platformPaths";
import { Composer } from "./Composer";
import type {
  AppOption,
  AppMention,
  ComposerSendIntent,
  ComposerSendShortcut,
  ComposerSubmission,
  ComposerSubmissionSource,
  ComposerReference,
  CustomPromptOption,
  FollowUpMessageBehavior,
  ThreadTokenUsage,
} from "../../../types";

vi.mock("../../../services/dragDrop", () => ({
  subscribeWindowDragDrop: vi.fn(() => () => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `tauri://${path}`,
}));

vi.mock("../../../utils/platformPaths", async () => {
  const actual = await vi.importActual<typeof import("../../../utils/platformPaths")>(
    "../../../utils/platformPaths",
  );
  return {
    ...actual,
    isMobilePlatform: vi.fn(() => false),
  };
});

type HarnessProps = {
  onSend: (
    text: string,
    images: string[],
    appMentions?: AppMention[],
    submitIntent?: ComposerSendIntent,
    references?: ComposerReference[],
    submission?: ComposerSubmission,
  ) => void;
  apps?: AppOption[];
  prompts?: CustomPromptOption[];
  skills?: { name: string; description?: string }[];
  isProcessing?: boolean;
  followUpMessageBehavior?: FollowUpMessageBehavior;
  composerSendShortcut?: ComposerSendShortcut;
  steerAvailable?: boolean;
  selectedServiceTier?: "fast" | "flex" | null;
  canStop?: boolean;
  onStop?: () => void;
  controlledDraft?: boolean;
  onDraftChangeOverride?: (text: string) => void;
  draftKey?: string | null;
  autoReconnectEnabled?: boolean;
  autoReconnectPhase?: "idle" | "waiting" | "sending" | "running";
  autoReconnectAttempt?: number;
  onAutoReconnectChange?: (enabled: boolean) => void;
  references?: ComposerReference[];
  contextUsage?: ThreadTokenUsage | null;
  contextCompactionInProgress?: boolean;
};

function ComposerHarness({
  onSend,
  apps = [],
  prompts = [],
  skills = [],
  isProcessing = false,
  followUpMessageBehavior = "queue",
  composerSendShortcut = "enter",
  steerAvailable = false,
  selectedServiceTier = null,
  canStop = false,
  onStop = () => {},
  controlledDraft = true,
  onDraftChangeOverride,
  draftKey = null,
  autoReconnectEnabled,
  autoReconnectPhase,
  autoReconnectAttempt,
  onAutoReconnectChange,
  references = [],
  contextUsage,
  contextCompactionInProgress,
}: HarnessProps) {
  const [draftText, setDraftText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  return (
    <Composer
      onSend={onSend}
      onStop={onStop}
      canStop={canStop}
      isProcessing={isProcessing}
      autoReconnectEnabled={autoReconnectEnabled}
      autoReconnectPhase={autoReconnectPhase}
      autoReconnectAttempt={autoReconnectAttempt}
      onAutoReconnectChange={onAutoReconnectChange}
      appsEnabled={true}
      steerAvailable={steerAvailable}
      followUpMessageBehavior={followUpMessageBehavior}
      composerSendShortcut={composerSendShortcut}
      collaborationModes={[]}
      selectedCollaborationModeId={null}
      onSelectCollaborationMode={() => {}}
      models={[]}
      selectedModelId={null}
      onSelectModel={() => {}}
      reasoningOptions={[]}
      selectedEffort={null}
      onSelectEffort={() => {}}
      selectedServiceTier={selectedServiceTier}
      reasoningSupported={false}
      accessMode="current"
      onSelectAccessMode={() => {}}
      skills={skills}
      apps={apps}
      prompts={prompts}
      files={[]}
      draftText={controlledDraft ? draftText : ""}
      onDraftChange={onDraftChangeOverride ?? (controlledDraft ? setDraftText : undefined)}
      pasteUndoKey={draftKey}
      textareaRef={textareaRef}
      dictationEnabled={false}
      references={references}
      contextUsage={contextUsage}
      contextCompactionInProgress={contextCompactionInProgress}
    />
  );
}

function expectComposerSend(
  onSend: ReturnType<typeof vi.fn>,
  expectedArgs: unknown[],
  source: ComposerSubmissionSource,
) {
  const call = onSend.mock.calls[onSend.mock.calls.length - 1];
  expect(call?.slice(0, expectedArgs.length)).toEqual(expectedArgs);
  expect(call?.[5]).toEqual(
    expect.objectContaining({
      id: expect.stringMatching(/^composer-/),
      source,
      draftGeneration: expect.any(Number),
    }),
  );
}

describe("Composer send triggers", () => {
  it("shows current context usage from the app-server token snapshot", () => {
    render(
      <ComposerHarness
        onSend={vi.fn()}
        contextUsage={{
          total: {
            totalTokens: 90_000,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 40_000,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 100_000,
        }}
      />,
    );

    const status = screen.getByLabelText(/上下文占用 40%/);
    const inputArea = status.closest(".composer-input-area") as HTMLElement;
    expect(inputArea.classList.contains("is-context-ok")).toBe(true);
    expect(inputArea.style.getPropertyValue("--composer-context-used")).toBe("40");
  });

  it("shows a full danger ring while context compaction is in progress", () => {
    render(
      <ComposerHarness
        onSend={vi.fn()}
        contextCompactionInProgress={true}
      />,
    );

    const status = screen.getByLabelText(/正在压缩上下文/);
    const inputArea = status.closest(".composer-input-area") as HTMLElement;
    expect(inputArea.classList.contains("is-context-danger")).toBe(true);
    expect(inputArea.style.getPropertyValue("--composer-context-used")).toBe("100");
  });

  it("renders the per-conversation auto reconnect switch", () => {
    const onAutoReconnectChange = vi.fn();
    render(
      <ComposerHarness
        onSend={vi.fn()}
        autoReconnectEnabled={false}
        onAutoReconnectChange={onAutoReconnectChange}
      />,
    );

    const toggle = screen.getByRole("switch", { name: "自动重连" });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect(toggle.closest("label")?.getAttribute("title")).toContain(
      "不会占用 Codex 当前任务的尝试次数，仅对当前会话有效",
    );
    expect(toggle.closest(".composer-meta-secondary")).toBeTruthy();
    fireEvent.click(toggle);
    expect(onAutoReconnectChange).toHaveBeenCalledWith(true);
  });

  afterEach(() => {
    cleanup();
    vi.mocked(isMobilePlatform).mockReturnValue(false);
    vi.restoreAllMocks();
  });

  it("sends once on Enter", () => {
    const onSend = vi.fn();
    render(<ComposerHarness onSend={onSend} />);

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "hello world" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledTimes(1);
    expectComposerSend(
      onSend,
      ["hello world", [], undefined, "default", undefined],
      "keyboard-enter",
    );
  });

  it("consumes one draft only once when keyboard and button submissions overlap", () => {
    let retriggered = false;
    const onSend = vi.fn(() => {
      if (retriggered) {
        return;
      }
      retriggered = true;
      fireEvent.click(screen.getByLabelText("发送"));
    });
    render(<ComposerHarness onSend={onSend} />);

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "one draft" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("ignores repeated send keydown events", () => {
    const onSend = vi.fn();
    render(<ComposerHarness onSend={onSend} />);

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "held enter" } });
    fireEvent.keyDown(textarea, { key: "Enter", repeat: true });

    expect(onSend).not.toHaveBeenCalled();
  });

  it("allows the same text after the user creates a new draft", () => {
    const onSend = vi.fn();
    render(<ComposerHarness onSend={onSend} />);

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "继续" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.change(textarea, { target: { value: "继续" } });
    fireEvent.click(screen.getByLabelText("发送"));

    expect(onSend).toHaveBeenCalledTimes(2);
    const firstSubmission = onSend.mock.calls[0]?.[5] as ComposerSubmission;
    const secondSubmission = onSend.mock.calls[1]?.[5] as ComposerSubmission;
    expect(firstSubmission.id).not.toBe(secondSubmission.id);
    expect(secondSubmission.draftGeneration).toBeGreaterThan(
      firstSubmission.draftGeneration,
    );
  });

  it("keeps local input when the parent mirrors drafts without rerendering", () => {
    const onDraftChange = vi.fn();
    render(
      <ComposerHarness
        onSend={vi.fn()}
        controlledDraft={false}
        onDraftChangeOverride={onDraftChange}
      />,
    );

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hello world" } });

    expect(onDraftChange).toHaveBeenCalledWith("hello world");
    expect(textarea.value).toBe("hello world");
  });

  it("replaces local input when the active draft key changes", () => {
    const onDraftChange = vi.fn();
    const { rerender } = render(
      <ComposerHarness
        onSend={vi.fn()}
        controlledDraft={false}
        onDraftChangeOverride={onDraftChange}
        draftKey="thread-a"
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "thread a draft" },
    });
    rerender(
      <ComposerHarness
        onSend={vi.fn()}
        controlledDraft={false}
        onDraftChangeOverride={onDraftChange}
        draftKey="thread-b"
      />,
    );

    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("serializes references in card order before the untouched body", () => {
    const onSend = vi.fn();
    const references: ComposerReference[] = [
      { id: "two", sourceTitle: "two", sourceRole: "assistant", content: "two", prompt: "> two\n\n", mode: "full", collapsed: false },
      { id: "one", sourceTitle: "one", sourceRole: "user", content: "one", prompt: "> one\n\n", mode: "full", collapsed: false },
    ];
    render(<ComposerHarness onSend={onSend} references={references} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "body" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expectComposerSend(
      onSend,
      ["> two\n\n> one\n\nbody", [], undefined, "default", references],
      "keyboard-enter",
    );
  });

  it("sends once on Ctrl+Enter when enabled", () => {
    const onSend = vi.fn();
    render(<ComposerHarness onSend={onSend} composerSendShortcut="ctrl-enter" />);

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "ctrl send" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    expect(onSend).toHaveBeenCalledTimes(1);
    expectComposerSend(
      onSend,
      ["ctrl send", [], undefined, "default", undefined],
      "keyboard-ctrl-enter",
    );
  });

  it("uses Ctrl+Enter for steer in chat mode while processing", () => {
    const onSend = vi.fn();
    render(
      <ComposerHarness
        onSend={onSend}
        composerSendShortcut="enter"
        isProcessing={true}
        followUpMessageBehavior="queue"
        steerAvailable={true}
      />,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "steer this" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    expect(onSend).toHaveBeenCalledTimes(1);
    expectComposerSend(
      onSend,
      ["steer this", [], undefined, "steer", undefined],
      "keyboard-ctrl-enter",
    );
  });

  it("does not send on plain Enter when Ctrl+Enter is selected", () => {
    const onSend = vi.fn();
    render(<ComposerHarness onSend={onSend} composerSendShortcut="ctrl-enter" />);

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "plain enter" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).not.toHaveBeenCalled();
  });

  it("sends once on send-button click", () => {
    const onSend = vi.fn();
    render(<ComposerHarness onSend={onSend} />);

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "from button" } });
    fireEvent.click(screen.getByLabelText("发送"));

    expect(onSend).toHaveBeenCalledTimes(1);
    expectComposerSend(
      onSend,
      ["from button", [], undefined, "default", undefined],
      "button",
    );
  });

  it("sends a Chinese slash instruction instead of applying a prompt suggestion", () => {
    const onSend = vi.fn();
    render(
      <ComposerHarness
        onSend={onSend}
        prompts={[
          {
            name: "自造词",
            path: "prompts/自造词.md",
            content: "自造词",
          },
        ]}
      />,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "/自造词" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledTimes(1);
    expectComposerSend(
      onSend,
      ["/自造词", [], undefined, "default", undefined],
      "keyboard-enter",
    );
  });

  it("sends a plus-prefixed Chinese slash instruction instead of applying a prompt suggestion", () => {
    const onSend = vi.fn();
    render(
      <ComposerHarness
        onSend={onSend}
        prompts={[
          {
            name: "+自造词",
            path: "prompts/+自造词.md",
            content: "+自造词",
          },
        ]}
      />,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "/+自造词" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledTimes(1);
    expectComposerSend(
      onSend,
      ["/+自造词", [], undefined, "default", undefined],
      "keyboard-enter",
    );
  });

  it("shows the fast-mode indicator when enabled", () => {
    const onSend = vi.fn();
    render(<ComposerHarness onSend={onSend} selectedServiceTier="fast" />);

    expect(screen.getByLabelText("快速模式已启用")).toBeTruthy();
  });

  it("suggests an available manual skill and inserts it on request", () => {
    const onSend = vi.fn();
    render(
      <ComposerHarness
        onSend={onSend}
        skills={[{ name: "code-review", description: "Manual review helper" }]}
      />,
    );

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "帮我看下这个改动有没有问题" } });

    expect(screen.getByText("可使用 $code-review")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "插入" }));

    expect(textarea.value).toBe("帮我看下这个改动有没有问题 $code-review");
  });

  it("does not suggest a skill when the draft already contains one", () => {
    const onSend = vi.fn();
    render(
      <ComposerHarness
        onSend={onSend}
        skills={[{ name: "code-review", description: "Manual review helper" }]}
      />,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, {
      target: { value: "$frontend-design 帮我看下这个改动有没有问题" },
    });

    expect(screen.queryByText("可使用 $code-review")).toBeNull();
  });

  it("blurs the textarea after Enter send on mobile", () => {
    vi.mocked(isMobilePlatform).mockReturnValue(true);
    const onSend = vi.fn();
    const blurSpy = vi.spyOn(HTMLTextAreaElement.prototype, "blur");
    render(<ComposerHarness onSend={onSend} />);

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "dismiss keyboard" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledTimes(1);
    expectComposerSend(
      onSend,
      ["dismiss keyboard", [], undefined, "default", undefined],
      "keyboard-enter",
    );
    expect(blurSpy).toHaveBeenCalledTimes(1);
  });

  it("sends explicit app mentions when an app autocomplete item is selected", () => {
    const onSend = vi.fn();
    render(
      <ComposerHarness
        onSend={onSend}
        apps={[
          {
            id: "connector_calendar",
            name: "Calendar App",
            description: "Calendar integration",
            isAccessible: true,
          },
        ]}
      />,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "$cal" } });
    fireEvent.keyDown(textarea, { key: "Tab" });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledTimes(1);
    expectComposerSend(
      onSend,
      [
        "$calendar-app",
        [],
        [{ name: "Calendar App", path: "app://connector_calendar" }],
        "default",
        undefined,
      ],
      "keyboard-enter",
    );
  });

  it("uses queue by default while processing when follow-up behavior is queue", () => {
    const onSend = vi.fn();
    render(
      <ComposerHarness
        onSend={onSend}
        isProcessing={true}
        followUpMessageBehavior="queue"
        steerAvailable={true}
      />,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "queue this" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledTimes(1);
    expectComposerSend(
      onSend,
      ["queue this", [], undefined, "queue", undefined],
      "keyboard-enter",
    );
  });

  it("uses Shift+Enter for steer in editor mode while processing", () => {
    const onSend = vi.fn();
    render(
      <ComposerHarness
        onSend={onSend}
        isProcessing={true}
        followUpMessageBehavior="queue"
        steerAvailable={true}
        composerSendShortcut="ctrl-enter"
      />,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "steer this" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    expect(onSend).toHaveBeenCalledTimes(1);
    expectComposerSend(
      onSend,
      ["steer this", [], undefined, "steer", undefined],
      "keyboard-shift-enter",
    );
  });

  it("uses Enter for steer in steer-priority mode while processing", () => {
    const onSend = vi.fn();
    render(
      <ComposerHarness
        onSend={onSend}
        isProcessing={true}
        followUpMessageBehavior="queue"
        steerAvailable={true}
        composerSendShortcut="steer-priority"
      />,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "steer priority" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledTimes(1);
    expectComposerSend(
      onSend,
      ["steer priority", [], undefined, "steer", undefined],
      "keyboard-enter",
    );
  });

  it("falls back to the default send intent on Enter in steer-priority mode when steer is unavailable", () => {
    const onSend = vi.fn();
    render(
      <ComposerHarness
        onSend={onSend}
        isProcessing={true}
        followUpMessageBehavior="queue"
        steerAvailable={false}
        composerSendShortcut="steer-priority"
      />,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "fallback queue" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledTimes(1);
    expectComposerSend(
      onSend,
      ["fallback queue", [], undefined, "queue", undefined],
      "keyboard-enter",
    );
  });

  it("uses Enter for default send in steer-priority mode", () => {
    const onSend = vi.fn();
    render(
      <ComposerHarness
        onSend={onSend}
        composerSendShortcut="steer-priority"
      />,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "normal send" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledTimes(1);
    expectComposerSend(
      onSend,
      ["normal send", [], undefined, "default", undefined],
      "keyboard-enter",
    );
  });

  it("inserts a newline on Shift+Enter in steer-priority mode", () => {
    const onSend = vi.fn();
    render(
      <ComposerHarness
        onSend={onSend}
        composerSendShortcut="steer-priority"
      />,
    );

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "line one" } });
    textarea.setSelectionRange(8, 8);
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe("line one\n");
  });

  it("inserts a newline on Ctrl+Enter in steer-priority mode", () => {
    const onSend = vi.fn();
    render(
      <ComposerHarness
        onSend={onSend}
        composerSendShortcut="steer-priority"
      />,
    );

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "line one" } });
    textarea.setSelectionRange(8, 8);
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe("line one\n");
  });

  it("falls back to queue when steer is selected but unavailable", () => {
    const onSend = vi.fn();
    render(
      <ComposerHarness
        onSend={onSend}
        isProcessing={true}
        followUpMessageBehavior="steer"
        steerAvailable={false}
      />,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "queue fallback" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(screen.queryByText("追问方式")).toBeNull();
    expect(onSend).toHaveBeenCalledTimes(1);
    expectComposerSend(
      onSend,
      ["queue fallback", [], undefined, "queue", undefined],
      "keyboard-enter",
    );
  });

  it("does not restore the last submitted prompt into the composer when stopping a turn", () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    const { rerender } = render(
      <ComposerHarness onSend={onSend} onStop={onStop} />,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "revise this answer" } });
    fireEvent.click(screen.getByLabelText("发送"));

    expect((textarea as HTMLTextAreaElement).value).toBe("");

    rerender(<ComposerHarness onSend={onSend} onStop={onStop} canStop />);
    fireEvent.click(screen.getByLabelText("停止"));

    expect(onStop).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("keeps the composer empty after stopping and parent draft rerenders empty", () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    const { rerender } = render(
      <ComposerHarness
        onSend={onSend}
        onStop={onStop}
        controlledDraft={false}
      />,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "edit after stop" } });
    fireEvent.click(screen.getByLabelText("发送"));

    rerender(
      <ComposerHarness
        onSend={onSend}
        onStop={onStop}
        canStop
        controlledDraft={false}
      />,
    );
    fireEvent.click(screen.getByLabelText("停止"));
    rerender(
      <ComposerHarness
        onSend={onSend}
        onStop={onStop}
        controlledDraft={false}
      />,
    );

    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("does not send on Shift+Ctrl+Enter when not processing", () => {
    const onSend = vi.fn();
    render(
      <ComposerHarness
        onSend={onSend}
        isProcessing={false}
        followUpMessageBehavior="queue"
        steerAvailable={true}
      />,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "normal shortcut send" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true, ctrlKey: true });

    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not queue on Tab while processing", () => {
    const onSend = vi.fn();
    render(
      <ComposerHarness
        onSend={onSend}
        isProcessing={true}
        followUpMessageBehavior="queue"
        steerAvailable={true}
      />,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "tab no send" } });
    fireEvent.keyDown(textarea, { key: "Tab" });

    expect(onSend).not.toHaveBeenCalled();
  });
});
