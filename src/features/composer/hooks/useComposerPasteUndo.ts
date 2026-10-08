import { useCallback, useEffect, useRef, type RefObject } from "react";

const MAX_PASTE_UNDO_DEPTH = 20;

type PasteAttachmentTransaction = {
  text: string;
  selectionStart: number;
  selectionEnd: number;
  beforeAttachmentCount: number;
  addedAttachments: string[];
  afterAttachmentCount: number;
};

type PasteUndoKeyEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  preventDefault: () => void;
};

type UseComposerPasteUndoArgs = {
  text: string;
  attachments: string[];
  draftKey: string | null;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onAttachImages?: (paths: string[]) => void;
  onReplaceImages?: (paths: string[]) => void;
  onSelectionChange: (selectionStart: number | null) => void;
};

export function useComposerPasteUndo({
  text,
  attachments,
  draftKey,
  textareaRef,
  onAttachImages,
  onReplaceImages,
  onSelectionChange,
}: UseComposerPasteUndoArgs) {
  const undoStacksRef = useRef<Record<string, PasteAttachmentTransaction[]>>({});
  const redoStacksRef = useRef<Record<string, PasteAttachmentTransaction[]>>({});
  const pasteEpochsRef = useRef<Record<string, number>>({});
  const latestTextByDraftRef = useRef<Record<string, string>>({});
  const latestAttachmentsByDraftRef = useRef<Record<string, string[]>>({});

  const clearPasteUndoHistory = useCallback(() => {
    if (!draftKey) {
      return;
    }
    pasteEpochsRef.current[draftKey] =
      (pasteEpochsRef.current[draftKey] ?? 0) + 1;
    delete undoStacksRef.current[draftKey];
    delete redoStacksRef.current[draftKey];
  }, [draftKey]);

  const markNativeHistoryChange = useCallback(() => {
    if (draftKey) {
      delete redoStacksRef.current[draftKey];
    }
  }, [draftKey]);

  useEffect(() => {
    if (!draftKey) {
      return;
    }
    const previousText = latestTextByDraftRef.current[draftKey];
    latestTextByDraftRef.current[draftKey] = text;
    latestAttachmentsByDraftRef.current[draftKey] = attachments;
    if (previousText !== undefined && previousText !== text) {
      delete redoStacksRef.current[draftKey];
    }
  }, [attachments, draftKey, text]);

  const restoreSelection = useCallback(
    (transaction: PasteAttachmentTransaction) => {
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) {
          return;
        }
        textarea.focus();
        textarea.setSelectionRange(
          transaction.selectionStart,
          transaction.selectionEnd,
        );
        onSelectionChange(transaction.selectionStart);
      });
    },
    [onSelectionChange, textareaRef],
  );

  const beginPasteAttachments = useCallback(() => {
    if (!draftKey || !onAttachImages || !onReplaceImages) {
      return null;
    }
    const pasteDraftKey = draftKey;
    const pasteEpoch = pasteEpochsRef.current[pasteDraftKey] ?? 0;
    const attachmentsAtPasteStart = [...attachments];
    const textarea = textareaRef.current;
    const selectionStart = textarea?.selectionStart ?? text.length;
    const selectionEnd = textarea?.selectionEnd ?? selectionStart;

    return (paths: string[]) => {
      if (paths.length === 0) {
        return false;
      }
      if ((pasteEpochsRef.current[pasteDraftKey] ?? 0) !== pasteEpoch) {
        onAttachImages(paths);
        return false;
      }
      const beforeAttachments =
        latestAttachmentsByDraftRef.current[pasteDraftKey] ??
        attachmentsAtPasteStart;
      const mergedAttachments = Array.from(
        new Set([...beforeAttachments, ...paths]),
      );
      const beforeSet = new Set(beforeAttachments);
      const addedAttachments = mergedAttachments.filter(
        (path) => !beforeSet.has(path),
      );
      if (addedAttachments.length === 0) {
        onAttachImages(paths);
        return false;
      }
      latestAttachmentsByDraftRef.current[pasteDraftKey] = mergedAttachments;
      undoStacksRef.current[pasteDraftKey] = [
        ...(undoStacksRef.current[pasteDraftKey] ?? []),
        {
          text,
          selectionStart,
          selectionEnd,
          beforeAttachmentCount: beforeAttachments.length,
          addedAttachments,
          afterAttachmentCount: mergedAttachments.length,
        },
      ].slice(-MAX_PASTE_UNDO_DEPTH);
      delete redoStacksRef.current[pasteDraftKey];
      onAttachImages(paths);
      return true;
    };
  }, [
    attachments,
    draftKey,
    onAttachImages,
    onReplaceImages,
    text,
    textareaRef,
  ]);

  const pasteAttachments = useCallback(
    (paths: string[]) => {
      const completePaste = beginPasteAttachments();
      if (completePaste) {
        return completePaste(paths);
      }
      onAttachImages?.(paths);
      return false;
    },
    [beginPasteAttachments, onAttachImages],
  );

  const handlePasteUndoKeyDown = useCallback(
    (event: PasteUndoKeyEvent) => {
      const isUndoShortcut =
        event.key.toLowerCase() === "z" &&
        !event.altKey &&
        (event.ctrlKey || event.metaKey);
      if (
        !isUndoShortcut ||
        !draftKey ||
        !onAttachImages ||
        !onReplaceImages
      ) {
        return false;
      }
      if (event.shiftKey) {
        const redoStack = redoStacksRef.current[draftKey] ?? [];
        const transaction = redoStack[redoStack.length - 1];
        if (
          !transaction ||
          text !== transaction.text ||
          attachments.length !== transaction.beforeAttachmentCount
        ) {
          return false;
        }
        event.preventDefault();
        redoStacksRef.current[draftKey] = redoStack.slice(0, -1);
        undoStacksRef.current[draftKey] = [
          ...(undoStacksRef.current[draftKey] ?? []),
          transaction,
        ].slice(
          -MAX_PASTE_UNDO_DEPTH,
        );
        onAttachImages(transaction.addedAttachments);
        restoreSelection(transaction);
        return true;
      }

      const undoStack = undoStacksRef.current[draftKey] ?? [];
      const transaction = undoStack[undoStack.length - 1];
      if (
        !transaction ||
        text !== transaction.text ||
        attachments.length !== transaction.afterAttachmentCount
      ) {
        return false;
      }
      event.preventDefault();
      undoStacksRef.current[draftKey] = undoStack.slice(0, -1);
      redoStacksRef.current[draftKey] = [
        ...(redoStacksRef.current[draftKey] ?? []),
        transaction,
      ].slice(
        -MAX_PASTE_UNDO_DEPTH,
      );
      onReplaceImages(attachments.slice(0, transaction.beforeAttachmentCount));
      restoreSelection(transaction);
      return true;
    },
    [
      attachments,
      draftKey,
      onAttachImages,
      onReplaceImages,
      restoreSelection,
      text,
    ],
  );

  return {
    beginPasteAttachments,
    clearPasteUndoHistory,
    handlePasteUndoKeyDown,
    markNativeHistoryChange,
    pasteAttachments,
  };
}
