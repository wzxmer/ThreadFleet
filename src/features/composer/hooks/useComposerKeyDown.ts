import { useCallback, type KeyboardEvent, type RefObject } from "react";
import type {
  ComposerSendIntent,
  ComposerSendShortcut,
  ComposerSubmissionSource,
} from "../../../types";
import { getListContinuation } from "../../../utils/composerText";
import { isComposingEvent } from "../../../utils/keys";
import { isMobilePlatform } from "../../../utils/platformPaths";

type ReviewPromptKeyEvent = {
  key: string;
  shiftKey?: boolean;
  preventDefault: () => void;
};

type UseComposerKeyDownArgs = {
  applyTextInsertion: (nextText: string, nextCursor: number) => void;
  canSend: boolean;
  composerSendShortcut: ComposerSendShortcut;
  continueListOnShiftEnter: boolean;
  defaultSubmitIntent: ComposerSendIntent;
  expandFenceOnEnter: boolean;
  expandFenceOnSpace: boolean;
  handleHistoryKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  handleInputKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  handleSend: (
    submitIntent?: ComposerSendIntent,
    submissionSource?: ComposerSubmissionSource,
  ) => void;
  isDictationBusy: boolean;
  isMac: boolean;
  onReviewPromptKeyDown?: (event: ReviewPromptKeyEvent) => boolean;
  oppositeSubmitIntent: ComposerSendIntent;
  reviewPromptOpen: boolean;
  steerAvailable: boolean;
  suggestionsOpen: boolean;
  text: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  tryExpandFence: (start: number, end: number) => boolean;
};

export function useComposerKeyDown({
  applyTextInsertion,
  canSend,
  composerSendShortcut,
  continueListOnShiftEnter,
  defaultSubmitIntent,
  expandFenceOnEnter,
  expandFenceOnSpace,
  handleHistoryKeyDown,
  handleInputKeyDown,
  handleSend,
  isDictationBusy,
  isMac,
  onReviewPromptKeyDown,
  oppositeSubmitIntent,
  reviewPromptOpen,
  steerAvailable,
  suggestionsOpen,
  text,
  textareaRef,
  tryExpandFence,
}: UseComposerKeyDownArgs) {
  return useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (isComposingEvent(event)) {
        return;
      }
      if (event.key === "Enter" && event.repeat) {
        event.preventDefault();
        return;
      }
      const insertNewline = () => {
        event.preventDefault();
        const textarea = textareaRef.current;
        if (!textarea) {
          return;
        }
        const start = textarea.selectionStart ?? text.length;
        const end = textarea.selectionEnd ?? start;
        const nextText = `${text.slice(0, start)}\n${text.slice(end)}`;
        applyTextInsertion(nextText, start + 1);
      };

      handleHistoryKeyDown(event);
      if (event.defaultPrevented) {
        return;
      }
      if (
        expandFenceOnSpace &&
        event.key === " " &&
        !event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        const textarea = textareaRef.current;
        if (!textarea) {
          return;
        }
        const start = textarea.selectionStart ?? text.length;
        const end = textarea.selectionEnd ?? start;
        if (tryExpandFence(start, end)) {
          event.preventDefault();
          return;
        }
      }
      if (
        event.key === "Enter" &&
        event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        composerSendShortcut !== "ctrl-enter"
      ) {
        if (continueListOnShiftEnter && !suggestionsOpen) {
          const textarea = textareaRef.current;
          if (textarea) {
            const start = textarea.selectionStart ?? text.length;
            const end = textarea.selectionEnd ?? start;
            if (start === end) {
              const marker = getListContinuation(text, start);
              if (marker) {
                event.preventDefault();
                const before = text.slice(0, start);
                const after = text.slice(end);
                const nextText = `${before}\n${marker}${after}`;
                const nextCursor = before.length + 1 + marker.length;
                applyTextInsertion(nextText, nextCursor);
                return;
              }
            }
          }
        }
        insertNewline();
        return;
      }
      if (reviewPromptOpen && onReviewPromptKeyDown) {
        const handled = onReviewPromptKeyDown(event);
        if (handled) {
          return;
        }
      }
      handleInputKeyDown(event);
      if (event.defaultPrevented) {
        return;
      }
      const isPlainEnter =
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey;
      const isCtrlEnter =
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.altKey &&
        (event.ctrlKey || (isMac && event.metaKey));
      const isShiftEnter =
        event.key === "Enter" &&
        event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey;
      const sendWithIntent = (
        submitIntent: ComposerSendIntent,
        submissionSource: ComposerSubmissionSource,
      ) => {
        if (expandFenceOnEnter && isPlainEnter) {
          const textarea = textareaRef.current;
          if (textarea) {
            const start = textarea.selectionStart ?? text.length;
            const end = textarea.selectionEnd ?? start;
            if (tryExpandFence(start, end)) {
              event.preventDefault();
              return;
            }
          }
        }
        if (isDictationBusy) {
          event.preventDefault();
          return;
        }
        event.preventDefault();
        const dismissKeyboardAfterSend = canSend && isMobilePlatform();
        handleSend(submitIntent, submissionSource);
        if (dismissKeyboardAfterSend) {
          textareaRef.current?.blur();
        }
      };
      if (composerSendShortcut === "ctrl-enter") {
        if (isPlainEnter) {
          return;
        }
        if (isCtrlEnter) {
          sendWithIntent(defaultSubmitIntent, "keyboard-ctrl-enter");
          return;
        }
        if (isShiftEnter) {
          sendWithIntent(oppositeSubmitIntent, "keyboard-shift-enter");
          return;
        }
      } else if (composerSendShortcut === "steer-priority") {
        if (isPlainEnter) {
          sendWithIntent(
            steerAvailable ? oppositeSubmitIntent : defaultSubmitIntent,
            "keyboard-enter",
          );
          return;
        }
        if (isCtrlEnter) {
          insertNewline();
          return;
        }
      } else {
        if (isPlainEnter) {
          sendWithIntent(defaultSubmitIntent, "keyboard-enter");
          return;
        }
        if (isCtrlEnter) {
          sendWithIntent(oppositeSubmitIntent, "keyboard-ctrl-enter");
          return;
        }
      }
    },
    [
      applyTextInsertion,
      canSend,
      composerSendShortcut,
      continueListOnShiftEnter,
      defaultSubmitIntent,
      expandFenceOnEnter,
      expandFenceOnSpace,
      handleHistoryKeyDown,
      handleInputKeyDown,
      handleSend,
      isDictationBusy,
      isMac,
      onReviewPromptKeyDown,
      oppositeSubmitIntent,
      reviewPromptOpen,
      steerAvailable,
      suggestionsOpen,
      text,
      textareaRef,
      tryExpandFence,
    ],
  );
}
