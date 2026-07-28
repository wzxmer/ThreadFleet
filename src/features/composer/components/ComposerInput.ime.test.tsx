/** @vitest-environment jsdom */
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComposerInput } from "./ComposerInput";

vi.mock("../../../services/dragDrop", () => ({
  subscribeWindowDragDrop: vi.fn(() => () => {}),
}));

function renderInput(
  onTextChange = vi.fn(),
  onSelectionChange = vi.fn(),
) {
  render(
    <ComposerInput
      text=""
      disabled={false}
      sendLabel="Send"
      canStop={false}
      canSend={false}
      isProcessing={false}
      onStop={() => {}}
      onSend={() => {}}
      onTextChange={onTextChange}
      onSelectionChange={onSelectionChange}
      onKeyDown={() => {}}
      textareaRef={createRef<HTMLTextAreaElement>()}
      suggestionsOpen={false}
      suggestions={[]}
      highlightIndex={0}
      onHighlightIndex={() => {}}
      onSelectSuggestion={() => {}}
    />,
  );
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

describe("ComposerInput IME composition", () => {
  it("commits only the final composition text and selection", () => {
    const onTextChange = vi.fn();
    const onSelectionChange = vi.fn();
    const textarea = renderInput(onTextChange, onSelectionChange);

    fireEvent.compositionStart(textarea);
    fireEvent.change(textarea, { target: { value: "ding" } });
    fireEvent.select(textarea, { target: { selectionStart: 4 } });

    expect(textarea.value).toBe("ding");
    expect(onTextChange).not.toHaveBeenCalled();
    expect(onSelectionChange).not.toHaveBeenCalled();

    fireEvent.compositionEnd(textarea, {
      data: "顶",
      target: { value: "顶", selectionStart: 1 },
    });

    expect(onTextChange).toHaveBeenCalledTimes(1);
    expect(onTextChange).toHaveBeenCalledWith("顶", 1);
    expect(onSelectionChange).not.toHaveBeenCalled();

    fireEvent.change(textarea, { target: { value: "顶", selectionStart: 1 } });
    expect(onTextChange).toHaveBeenCalledTimes(1);

    fireEvent.change(textarea, { target: { value: "顶功", selectionStart: 2 } });
    expect(onTextChange).toHaveBeenCalledTimes(2);
    expect(onTextChange).toHaveBeenLastCalledWith("顶功", 2);
  });
});
