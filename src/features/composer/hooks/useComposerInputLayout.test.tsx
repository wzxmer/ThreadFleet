// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useComposerInputLayout } from "./useComposerInputLayout";

function createMeasuredTextarea(value: string) {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  Object.defineProperty(textarea, "scrollHeight", {
    configurable: true,
    get: () => {
      const contentHeight = textarea.value ? 200 : 24;
      const fixedHeight = textarea.style.height.endsWith("px")
        ? Number.parseFloat(textarea.style.height)
        : 0;
      return Math.max(contentHeight, fixedHeight);
    },
  });
  document.body.appendChild(textarea);
  return textarea;
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("useComposerInputLayout", () => {
  it("shrinks an auto-sized textarea after sent text is cleared", () => {
    const textarea = createMeasuredTextarea("long pasted content");
    const textareaRef = { current: textarea };
    const { rerender } = renderHook(
      ({ text }) =>
        useComposerInputLayout({
          isExpanded: false,
          text,
          textareaRef,
        }),
      { initialProps: { text: textarea.value } },
    );

    expect(textarea.style.height).toBe("200px");

    textarea.value = "";
    rerender({ text: "" });

    expect(textarea.style.height).toBe("24px");
  });

  it("keeps an explicit manual height after text is cleared", () => {
    const textarea = createMeasuredTextarea("long pasted content");
    const textareaRef = { current: textarea };
    const { rerender } = renderHook(
      ({ text }) =>
        useComposerInputLayout({
          isExpanded: false,
          text,
          textareaRef,
          manualHeight: 140,
        }),
      { initialProps: { text: textarea.value } },
    );

    textarea.value = "";
    rerender({ text: "" });

    expect(textarea.style.height).toBe("140px");
  });
});
