import { useCallback, useMemo, useRef, useState } from "react";
import { pickAttachmentFiles, saveComposerImages } from "../../../services/tauri";
import { isImageAttachment } from "../../../utils/attachments";

type ComposerImageTransferToken = Readonly<{
  draftKey: string;
  generation: number;
}>;

type UseComposerImagesArgs = {
  activeThreadId: string | null;
  activeWorkspaceId: string | null;
};

export function useComposerImages({
  activeThreadId,
  activeWorkspaceId,
}: UseComposerImagesArgs) {
  const [imagesByThread, setImagesByThread] = useState<Record<string, string[]>>({});
  const generationByDraft = useRef<Record<string, number>>({});

  const draftKey = useMemo(
    () => activeThreadId ?? `draft-${activeWorkspaceId ?? "none"}`,
    [activeThreadId, activeWorkspaceId],
  );

  const activeImages = imagesByThread[draftKey] ?? [];

  const advanceDraftGeneration = useCallback((targetDraftKey: string) => {
    const generation = (generationByDraft.current[targetDraftKey] ?? 0) + 1;
    generationByDraft.current[targetDraftKey] = generation;
    return generation;
  }, []);

  const attachImages = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) {
        return;
      }
      const attachImages = (nextPaths: string[]) => {
        setImagesByThread((prev) => {
          const existing = prev[draftKey] ?? [];
          const merged = Array.from(new Set([...existing, ...nextPaths]));
          return { ...prev, [draftKey]: merged };
        });
      };
      const replaceImages = (sourcePaths: string[], savedPaths: string[]) => {
        setImagesByThread((prev) => {
          const existing = prev[draftKey] ?? [];
          const savedBySource = new Map(
            sourcePaths.map((sourcePath, index) => [sourcePath, savedPaths[index]]),
          );
          const merged = Array.from(
            new Set(existing.map((path) => savedBySource.get(path) ?? path)),
          );
          return { ...prev, [draftKey]: merged };
        });
      };
      attachImages(paths);
      if (!activeWorkspaceId) {
        return;
      }
      const imagePaths = paths.filter(isImageAttachment);
      if (imagePaths.length === 0) {
        return;
      }
      void saveComposerImages(activeWorkspaceId, draftKey, imagePaths)
        .then((savedPaths) => {
          if (savedPaths.length > 0) {
            replaceImages(imagePaths, savedPaths);
          }
        })
        .catch((error) => {
          console.warn("Failed to save composer image attachments.", error);
        });
    },
    [activeWorkspaceId, draftKey],
  );

  const pickImages = useCallback(async () => {
    const picked = await pickAttachmentFiles();
    if (picked.length === 0) {
      return;
    }
    attachImages(picked);
  }, [attachImages]);

  const removeImage = useCallback(
    (path: string) => {
      advanceDraftGeneration(draftKey);
      setImagesByThread((prev) => {
        const existing = prev[draftKey] ?? [];
        const next = existing.filter((entry) => entry !== path);
        if (next.length === 0) {
          const { [draftKey]: _, ...rest } = prev;
          return rest;
        }
        return { ...prev, [draftKey]: next };
      });
    },
    [advanceDraftGeneration, draftKey],
  );

  const clearActiveImages = useCallback(() => {
    advanceDraftGeneration(draftKey);
    setImagesByThread((prev) => {
      if (!(draftKey in prev)) {
        return prev;
      }
      const { [draftKey]: _, ...rest } = prev;
      return rest;
    });
  }, [advanceDraftGeneration, draftKey]);

  const replaceActiveImages = useCallback(
    (images: string[]) => {
      advanceDraftGeneration(draftKey);
      setImagesByThread((prev) => {
        if (images.length === 0) {
          if (!(draftKey in prev)) {
            return prev;
          }
          const { [draftKey]: _, ...rest } = prev;
          return rest;
        }
        return { ...prev, [draftKey]: [...images] };
      });
    },
    [advanceDraftGeneration, draftKey],
  );

  const transferActiveImages = useCallback(
    (images: readonly string[]): ComposerImageTransferToken | null => {
      if (images.length === 0) {
        return null;
      }
      const token = {
        draftKey,
        generation: generationByDraft.current[draftKey] ?? 0,
      };
      setImagesByThread((prev) => {
        if (!(draftKey in prev)) {
          return prev;
        }
        const submittedImages = new Set(images);
        const remaining = (prev[draftKey] ?? []).filter(
          (image) => !submittedImages.has(image),
        );
        if (remaining.length > 0) {
          return { ...prev, [draftKey]: remaining };
        }
        const { [draftKey]: _, ...rest } = prev;
        return rest;
      });
      return token;
    },
    [draftKey],
  );

  const restoreImagesForDraft = useCallback(
    (token: ComposerImageTransferToken, images: readonly string[]) => {
      if (images.length === 0) {
        return;
      }
      setImagesByThread((prev) => {
        if ((generationByDraft.current[token.draftKey] ?? 0) !== token.generation) {
          return prev;
        }
        const existing = prev[token.draftKey] ?? [];
        const merged = Array.from(new Set([...existing, ...images]));
        return { ...prev, [token.draftKey]: merged };
      });
    },
    [],
  );

  const setImagesForThread = useCallback(
    (threadId: string, images: string[]) => {
      advanceDraftGeneration(threadId);
      setImagesByThread((prev) => ({ ...prev, [threadId]: images }));
    },
    [advanceDraftGeneration],
  );

  const removeImagesForThread = useCallback((threadId: string) => {
    advanceDraftGeneration(threadId);
    setImagesByThread((prev) => {
      if (!(threadId in prev)) {
        return prev;
      }
      const { [threadId]: _, ...rest } = prev;
      return rest;
    });
  }, [advanceDraftGeneration]);

  return {
    activeImageDraftKey: draftKey,
    activeImages,
    attachImages,
    pickImages,
    removeImage,
    clearActiveImages,
    replaceActiveImages,
    transferActiveImages,
    restoreImagesForDraft,
    setImagesForThread,
    removeImagesForThread,
  };
}
