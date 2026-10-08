/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerPasteUndo } from "./useComposerPasteUndo";

type HookProps = {
  draftKey: string;
  text: string;
  attachments: string[];
};

function createShortcut(redo = false) {
  return {
    key: "z",
    ctrlKey: true,
    metaKey: false,
    shiftKey: redo,
    altKey: false,
    preventDefault: vi.fn(),
  };
}

describe("useComposerPasteUndo", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  function setup(initialProps: HookProps) {
    const textarea = document.createElement("textarea");
    const onAttachImages = vi.fn();
    const onReplaceImages = vi.fn();
    const onSelectionChange = vi.fn();
    const hook = renderHook(
      (props: HookProps) =>
        useComposerPasteUndo({
          ...props,
          textareaRef: { current: textarea },
          onAttachImages,
          onReplaceImages,
          onSelectionChange,
        }),
      { initialProps },
    );
    return {
      ...hook,
      onAttachImages,
      onReplaceImages,
    };
  }

  it("keeps attachment undo histories isolated by draft", () => {
    const hook = setup({ draftKey: "draft-a", text: "", attachments: [] });

    act(() => hook.result.current.pasteAttachments(["a.png"]));
    hook.rerender({ draftKey: "draft-a", text: "", attachments: ["a.png"] });
    hook.rerender({ draftKey: "draft-b", text: "", attachments: [] });
    act(() => hook.result.current.pasteAttachments(["b.png"]));
    hook.rerender({ draftKey: "draft-b", text: "", attachments: ["b.png"] });

    expect(hook.result.current.handlePasteUndoKeyDown(createShortcut())).toBe(true);
    expect(hook.onReplaceImages).toHaveBeenLastCalledWith([]);

    hook.rerender({ draftKey: "draft-a", text: "", attachments: ["a.png"] });
    expect(hook.result.current.handlePasteUndoKeyDown(createShortcut())).toBe(true);
    expect(hook.onReplaceImages).toHaveBeenCalledTimes(2);
  });

  it("records a delayed paste in the draft where the paste started", () => {
    const hook = setup({ draftKey: "draft-a", text: "", attachments: [] });
    const completeDraftAPaste = hook.result.current.beginPasteAttachments();

    hook.rerender({ draftKey: "draft-b", text: "", attachments: [] });
    act(() => completeDraftAPaste?.(["delayed.png"]));

    hook.rerender({
      draftKey: "draft-a",
      text: "",
      attachments: ["delayed.png"],
    });
    expect(hook.result.current.handlePasteUndoKeyDown(createShortcut())).toBe(true);
    expect(hook.onReplaceImages).toHaveBeenCalledWith([]);
  });

  it("serializes concurrent paste completions from the same draft snapshot", () => {
    const hook = setup({ draftKey: "draft-a", text: "", attachments: [] });
    const completeFirstPaste = hook.result.current.beginPasteAttachments();
    const completeSecondPaste = hook.result.current.beginPasteAttachments();

    act(() => {
      completeFirstPaste?.(["first.png"]);
      completeSecondPaste?.(["second.png"]);
    });
    hook.rerender({
      draftKey: "draft-a",
      text: "",
      attachments: ["first.png", "second.png"],
    });

    expect(hook.result.current.handlePasteUndoKeyDown(createShortcut())).toBe(true);
    expect(hook.onReplaceImages).toHaveBeenLastCalledWith(["first.png"]);
    hook.rerender({ draftKey: "draft-a", text: "", attachments: ["first.png"] });
    expect(hook.result.current.handlePasteUndoKeyDown(createShortcut())).toBe(true);
    expect(hook.onReplaceImages).toHaveBeenLastCalledWith([]);
  });

  it("records both concurrent pastes when the attachment count exceeds ten", () => {
    const existing = Array.from({ length: 9 }, (_, index) => `${index}.png`);
    const hook = setup({
      draftKey: "draft-a",
      text: "",
      attachments: existing,
    });
    const completePasteA = hook.result.current.beginPasteAttachments();
    const completePasteB = hook.result.current.beginPasteAttachments();

    act(() => {
      completePasteB?.(["b.png"]);
      completePasteA?.(["a.png"]);
    });
    hook.rerender({
      draftKey: "draft-a",
      text: "",
      attachments: [...existing, "b.png", "a.png"],
    });

    expect(hook.result.current.handlePasteUndoKeyDown(createShortcut())).toBe(true);
    expect(hook.onReplaceImages).toHaveBeenLastCalledWith([...existing, "b.png"]);
    hook.rerender({ draftKey: "draft-a", text: "", attachments: [...existing, "b.png"] });
    expect(hook.result.current.handlePasteUndoKeyDown(createShortcut())).toBe(true);
    expect(hook.onReplaceImages).toHaveBeenLastCalledWith(existing);
  });

  it("drops attachment redo after a newer native edit", () => {
    const hook = setup({ draftKey: "draft-a", text: "", attachments: [] });
    act(() => hook.result.current.pasteAttachments(["a.png"]));
    hook.rerender({ draftKey: "draft-a", text: "", attachments: ["a.png"] });

    expect(hook.result.current.handlePasteUndoKeyDown(createShortcut())).toBe(true);
    hook.rerender({ draftKey: "draft-a", text: "", attachments: [] });
    act(() => hook.result.current.markNativeHistoryChange());
    hook.onAttachImages.mockClear();

    expect(hook.result.current.handlePasteUndoKeyDown(createShortcut(true))).toBe(false);
    expect(hook.onAttachImages).not.toHaveBeenCalled();
  });

  it("undoes native text before the earlier attachment transaction", () => {
    const hook = setup({ draftKey: "draft-a", text: "", attachments: [] });
    act(() => hook.result.current.pasteAttachments(["a.png"]));
    hook.rerender({ draftKey: "draft-a", text: "typed", attachments: ["a.png"] });

    expect(hook.result.current.handlePasteUndoKeyDown(createShortcut())).toBe(false);

    hook.rerender({ draftKey: "draft-a", text: "", attachments: ["a.png"] });
    expect(hook.result.current.handlePasteUndoKeyDown(createShortcut())).toBe(true);
    expect(hook.onReplaceImages).toHaveBeenCalledWith([]);
  });

  it("undoes and redoes all pasted attachments beyond ten", () => {
    const existing = Array.from({ length: 9 }, (_, index) => `${index}.png`);
    const hook = setup({
      draftKey: "draft-a",
      text: "",
      attachments: existing,
    });
    const added = ["slides.pptx", "file.custom", "extensionless"];
    act(() => hook.result.current.pasteAttachments([...added, existing[0]]));
    hook.rerender({
      draftKey: "draft-a",
      text: "",
      attachments: [...existing, ...added],
    });

    expect(hook.result.current.handlePasteUndoKeyDown(createShortcut())).toBe(true);
    expect(hook.onReplaceImages).toHaveBeenCalledWith(existing);
    hook.rerender({ draftKey: "draft-a", text: "", attachments: existing });
    hook.onAttachImages.mockClear();
    expect(hook.result.current.handlePasteUndoKeyDown(createShortcut(true))).toBe(true);
    expect(hook.onAttachImages).toHaveBeenCalledWith(added);
  });

  it("preserves normalized paths for attachments that predate the paste", () => {
    const hook = setup({
      draftKey: "draft-a",
      text: "",
      attachments: ["data:image/png;base64,old"],
    });
    act(() => hook.result.current.pasteAttachments(["new.txt"]));
    hook.rerender({
      draftKey: "draft-a",
      text: "",
      attachments: ["C:/saved/old.png", "new.txt"],
    });

    expect(hook.result.current.handlePasteUndoKeyDown(createShortcut())).toBe(true);
    expect(hook.onReplaceImages).toHaveBeenCalledWith(["C:/saved/old.png"]);
  });

  it("attaches a delayed paste without restoring stale history after a barrier", () => {
    const hook = setup({ draftKey: "draft-a", text: "", attachments: [] });
    const completePaste = hook.result.current.beginPasteAttachments();

    act(() => hook.result.current.clearPasteUndoHistory());
    act(() => completePaste?.(["late.png"]));

    expect(hook.onAttachImages).toHaveBeenCalledWith(["late.png"]);
    expect(hook.result.current.handlePasteUndoKeyDown(createShortcut())).toBe(false);
  });
});
