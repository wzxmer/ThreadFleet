import { useEffect, useRef, useState } from "react";
import { subscribeWindowDragDrop } from "../../../services/dragDrop";
import { isImageAttachment, withFileNameInDataUrl } from "../../../utils/attachments";

function isDragFileTransfer(types: readonly string[] | undefined) {
  if (!types || types.length === 0) {
    return false;
  }
  return (
    types.includes("Files") ||
    types.includes("public.file-url") ||
    types.includes("application/x-moz-file")
  );
}

function readFilesAsDataUrls(files: File[]) {
  return Promise.all(
    files.map(
      (file) =>
        new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve(
              typeof reader.result === "string"
                ? withFileNameInDataUrl(reader.result, file.name)
                : "",
            );
          reader.onerror = () => resolve("");
          reader.readAsDataURL(file);
        }),
    ),
  ).then((items) => items.filter(Boolean));
}

function getDragPosition(position: { x: number; y: number }) {
  return position;
}

function normalizeDragPosition(
  position: { x: number; y: number },
  lastClientPosition: { x: number; y: number } | null,
) {
  const scale = window.devicePixelRatio || 1;
  if (scale === 1 || !lastClientPosition) {
    return getDragPosition(position);
  }
  const logicalDistance = Math.hypot(
    position.x - lastClientPosition.x,
    position.y - lastClientPosition.y,
  );
  const scaled = { x: position.x / scale, y: position.y / scale };
  const scaledDistance = Math.hypot(
    scaled.x - lastClientPosition.x,
    scaled.y - lastClientPosition.y,
  );
  return scaledDistance < logicalDistance ? scaled : position;
}

type UseComposerImageDropArgs = {
  disabled: boolean;
  onAttachImages?: (paths: string[]) => void;
  onPasteImages?: (paths: string[]) => void;
  onPasteStart?: () => ((paths: string[]) => void) | null;
};

export function useComposerImageDrop({
  disabled,
  onAttachImages,
  onPasteImages,
  onPasteStart,
}: UseComposerImageDropArgs) {
  const [isDragOver, setIsDragOver] = useState(false);
  const dropTargetRef = useRef<HTMLDivElement | null>(null);
  const lastClientPositionRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    if (disabled) {
      return undefined;
    }
    unlisten = subscribeWindowDragDrop((event) => {
      if (!dropTargetRef.current) {
        return;
      }
      if (event.payload.type === "leave") {
        setIsDragOver(false);
        return;
      }
      const position = normalizeDragPosition(
        event.payload.position,
        lastClientPositionRef.current,
      );
      const rect = dropTargetRef.current.getBoundingClientRect();
      const isInside =
        position.x >= rect.left &&
        position.x <= rect.right &&
        position.y >= rect.top &&
        position.y <= rect.bottom;
      if (event.payload.type === "over" || event.payload.type === "enter") {
        setIsDragOver(isInside);
        return;
      }
      if (event.payload.type === "drop") {
        setIsDragOver(false);
        if (!isInside) {
          return;
        }
        const filePaths = (event.payload.paths ?? [])
          .map((path) => path.trim())
          .filter(Boolean);
        if (filePaths.length > 0) {
          onAttachImages?.(filePaths);
        }
      }
    });
    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [disabled, onAttachImages]);

  const handleDragOver = (event: React.DragEvent<HTMLElement>) => {
    if (disabled) {
      return;
    }
    if (isDragFileTransfer(event.dataTransfer?.types)) {
      lastClientPositionRef.current = { x: event.clientX, y: event.clientY };
      event.preventDefault();
      setIsDragOver(true);
    }
  };

  const handleDragEnter = (event: React.DragEvent<HTMLElement>) => {
    handleDragOver(event);
  };

  const handleDragLeave = () => {
    if (isDragOver) {
      setIsDragOver(false);
      lastClientPositionRef.current = null;
    }
  };

  const handleDrop = async (event: React.DragEvent<HTMLElement>) => {
    if (disabled) {
      return;
    }
    event.preventDefault();
    setIsDragOver(false);
    lastClientPositionRef.current = null;
    const files = Array.from(event.dataTransfer?.files ?? []);
    const items = Array.from(event.dataTransfer?.items ?? []);
    const itemFiles = items
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    const filePaths = [...files, ...itemFiles]
      .map((file) => (file as File & { path?: string }).path ?? "")
      .filter(Boolean);
    if (filePaths.length > 0) {
      onAttachImages?.(filePaths);
      return;
    }
    const droppedFiles = [...files, ...itemFiles];
    if (droppedFiles.length === 0) {
      return;
    }
    const dataUrls = await readFilesAsDataUrls(droppedFiles);
    if (dataUrls.length > 0) {
      onAttachImages?.(dataUrls);
    }
  };

  const handlePaste = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled) {
      return;
    }
    const items = Array.from(event.clipboardData?.items ?? []);
    const itemFiles = items
      .filter((item) => item.kind === "file" || item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    const files =
      itemFiles.length > 0
        ? itemFiles
        : Array.from(event.clipboardData?.files ?? []);
    const filePaths = files
      .map((file) => (file as File & { path?: string }).path ?? "")
      .filter(Boolean)
      .filter((path) => isImageAttachment(path) || path.length > 0);
    const inlineFiles = files.filter((file) => {
      const path = (file as File & { path?: string }).path ?? "";
      return !path;
    });
    if (filePaths.length === 0 && inlineFiles.length === 0) {
      return;
    }
    event.preventDefault();
    const completePaste =
      onPasteStart?.() ?? onPasteImages ?? onAttachImages;
    const dataUrls = await Promise.all(
      inlineFiles.map(
        (file) =>
          new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () =>
              resolve(
                typeof reader.result === "string"
                  ? withFileNameInDataUrl(reader.result, file.name)
                  : "",
              );
            reader.onerror = () => resolve("");
            reader.readAsDataURL(file);
          }),
      ),
    );
    const valid = dataUrls.filter(Boolean);
    const pastedAttachments = [...filePaths, ...valid];
    if (pastedAttachments.length > 0) {
      completePaste?.(pastedAttachments);
    }
  };

  return {
    dropTargetRef,
    isDragOver,
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDrop,
    handlePaste,
  };
}
