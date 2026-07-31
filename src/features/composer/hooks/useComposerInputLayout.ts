import { useEffect, useLayoutEffect, useMemo, useState, type RefObject } from "react";

type UseComposerInputLayoutArgs = {
  isExpanded: boolean;
  text: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  manualHeight?: number | null;
};

export function useComposerInputLayout({
  isExpanded,
  text,
  textareaRef,
  manualHeight = null,
}: UseComposerInputLayoutArgs) {
  const [isPhoneLayout, setIsPhoneLayout] = useState(false);
  const [isPhoneTallInput, setIsPhoneTallInput] = useState(false);
  const [textareaScrollable, setTextareaScrollable] = useState(false);
  const textareaHeightBounds = useMemo(
    () => ({
      min: isExpanded ? (isPhoneLayout ? 112 : 120) : isPhoneLayout ? 36 : 24,
      max: isExpanded ? (isPhoneLayout ? 280 : 360) : isPhoneLayout ? 168 : 260,
    }),
    [isExpanded, isPhoneLayout],
  );

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    const appRoot = textarea.closest(".app");
    if (!(appRoot instanceof HTMLElement)) {
      setIsPhoneLayout(false);
      return;
    }

    const syncLayout = () => {
      const nextIsPhoneLayout = appRoot.classList.contains("layout-phone");
      setIsPhoneLayout((prev) => (prev === nextIsPhoneLayout ? prev : nextIsPhoneLayout));
    };

    syncLayout();
    const observer = new MutationObserver((records) => {
      if (records.some((record) => record.attributeName === "class")) {
        syncLayout();
      }
    });
    observer.observe(appRoot, { attributes: true, attributeFilter: ["class"] });
    return () => {
      observer.disconnect();
    };
  }, [textareaRef]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    const { min: minTextareaHeight, max: maxTextareaHeight } = textareaHeightBounds;
    textarea.style.setProperty("--composer-textarea-max-height", `${maxTextareaHeight}px`);
    textarea.style.minHeight = `${minTextareaHeight}px`;
    textarea.style.maxHeight = `${maxTextareaHeight}px`;
    const nextHeight =
      manualHeight === null
        ? Math.min(
            Math.max(textarea.scrollHeight, minTextareaHeight),
            maxTextareaHeight,
          )
        : Math.min(Math.max(manualHeight, minTextareaHeight), maxTextareaHeight);
    if (manualHeight === null) {
      textarea.style.height = "auto";
    }
    textarea.style.height = `${nextHeight}px`;
    const nextScrollable =
      manualHeight === null
        ? textarea.scrollHeight > maxTextareaHeight + 1
        : textarea.scrollHeight > nextHeight + 1;
    textarea.style.overflowY = nextScrollable ? "auto" : "hidden";
    setTextareaScrollable((prev) => (prev === nextScrollable ? prev : nextScrollable));

    if (!isPhoneLayout) {
      setIsPhoneTallInput((prev) => (prev ? false : prev));
      return;
    }

    const computedStyle = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(computedStyle.lineHeight) || 20;
    const paddingTop = Number.parseFloat(computedStyle.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(computedStyle.paddingBottom) || 0;
    const contentHeight = Math.max(0, nextHeight - paddingTop - paddingBottom);
    const estimatedLineCount = contentHeight / lineHeight;
    const nextIsPhoneTallInput = estimatedLineCount > 2.25;
    setIsPhoneTallInput((prev) => (prev === nextIsPhoneTallInput ? prev : nextIsPhoneTallInput));
  }, [isPhoneLayout, manualHeight, text, textareaHeightBounds, textareaRef]);

  return { isPhoneLayout, isPhoneTallInput, textareaScrollable, textareaHeightBounds };
}
