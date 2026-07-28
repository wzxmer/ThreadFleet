/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerImageDrop } from "./useComposerImageDrop";

let mockOnDragDropEvent:
  | ((event: {
      payload: {
        type: "enter" | "over" | "leave" | "drop";
        position: { x: number; y: number };
        paths?: string[];
      };
    }) => void)
  | null = null;

vi.mock("../../../services/dragDrop", () => ({
  subscribeWindowDragDrop: (handler: typeof mockOnDragDropEvent) => {
    mockOnDragDropEvent = handler;
    return () => {};
  },
}));

type HookResult = ReturnType<typeof useComposerImageDrop>;

type RenderedHook = {
  result: HookResult;
  unmount: () => void;
};

function renderImageDropHook(options: {
  disabled: boolean;
  onAttachImages?: (paths: string[]) => void;
  onPasteImages?: (paths: string[]) => void;
  onPasteStart?: () => ((paths: string[]) => void) | null;
}): RenderedHook {
  let result: HookResult | undefined;

  function Test() {
    result = useComposerImageDrop(options);
    return null;
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(React.createElement(Test));
  });

  return {
    get result() {
      if (!result) {
        throw new Error("Hook not rendered");
      }
      return result;
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function setMockFileReader() {
  const OriginalFileReader = window.FileReader;
  class MockFileReader {
    result: string | ArrayBuffer | null = null;
    onload: ((ev: ProgressEvent<FileReader>) => unknown) | null = null;
    onerror: ((ev: ProgressEvent<FileReader>) => unknown) | null = null;

    readAsDataURL(file: File) {
      this.result = `data:${file.type};base64,MOCK`;
      this.onload?.({} as ProgressEvent<FileReader>);
    }
  }
  window.FileReader = MockFileReader as typeof FileReader;
  return () => {
    window.FileReader = OriginalFileReader;
  };
}

describe("useComposerImageDrop", () => {
  beforeEach(() => {
    mockOnDragDropEvent = null;
  });

  it("tracks drag over state for file transfers", () => {
    const hook = renderImageDropHook({ disabled: false });
    const preventDefault = vi.fn();

    act(() => {
      hook.result.handleDragOver({
        dataTransfer: { types: ["Files"] },
        preventDefault,
      } as unknown as React.DragEvent<HTMLElement>);
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(hook.result.isDragOver).toBe(true);

    act(() => {
      hook.result.handleDragLeave();
    });

    expect(hook.result.isDragOver).toBe(false);

    hook.unmount();
  });

  it("uses attachment file paths on drop when available", async () => {
    const onAttachImages = vi.fn();
    const hook = renderImageDropHook({ disabled: false, onAttachImages });

    const file = new File(["data"], "notes.md", { type: "text/markdown" });
    (file as File & { path?: string }).path = "/tmp/notes.md";

    await act(async () => {
      await hook.result.handleDrop({
        dataTransfer: { files: [file], items: [] },
        preventDefault: vi.fn(),
      } as unknown as React.DragEvent<HTMLElement>);
    });

    expect(onAttachImages).toHaveBeenCalledWith(["/tmp/notes.md"]);

    hook.unmount();
  });

  it("reads inline non-image attachments as non-preview data URLs when paths are missing", async () => {
    const restoreFileReader = setMockFileReader();
    const onAttachImages = vi.fn();
    const hook = renderImageDropHook({ disabled: false, onAttachImages });

    const file = new File(["data"], "notes.txt", { type: "text/plain" });

    await act(async () => {
      await hook.result.handleDrop({
        dataTransfer: { files: [file], items: [] },
        preventDefault: vi.fn(),
      } as unknown as React.DragEvent<HTMLElement>);
    });

    expect(onAttachImages).toHaveBeenCalledWith([
      'data:text/plain;name="notes.txt";base64,MOCK',
    ]);

    hook.unmount();
    restoreFileReader();
  });

  it("handles pasted image items", async () => {
    const restoreFileReader = setMockFileReader();
    const onAttachImages = vi.fn();
    const hook = renderImageDropHook({ disabled: false, onAttachImages });
    const preventDefault = vi.fn();

    const file = new File(["data"], "paste.png", { type: "image/png" });
    const item = {
      type: "image/png",
      getAsFile: () => file,
    };

    await act(async () => {
      await hook.result.handlePaste({
        clipboardData: { items: [item] },
        preventDefault,
      } as unknown as React.ClipboardEvent<HTMLTextAreaElement>);
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(onAttachImages).toHaveBeenCalledWith([
      'data:image/png;name="paste.png";base64,MOCK',
    ]);

    hook.unmount();
    restoreFileReader();
  });

  it("falls back to clipboard files when pasted items are unavailable", async () => {
    const restoreFileReader = setMockFileReader();
    const onAttachImages = vi.fn();
    const hook = renderImageDropHook({ disabled: false, onAttachImages });
    const preventDefault = vi.fn();
    const file = new File(["data"], "paste.png", { type: "image/png" });

    await act(async () => {
      await hook.result.handlePaste({
        clipboardData: { items: [], files: [file] },
        preventDefault,
      } as unknown as React.ClipboardEvent<HTMLTextAreaElement>);
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(onAttachImages).toHaveBeenCalledWith([
      'data:image/png;name="paste.png";base64,MOCK',
    ]);

    hook.unmount();
    restoreFileReader();
  });

  it("handles pasted inline non-image files without treating them as images", async () => {
    const restoreFileReader = setMockFileReader();
    const onAttachImages = vi.fn();
    const hook = renderImageDropHook({ disabled: false, onAttachImages });
    const preventDefault = vi.fn();

    const file = new File(["data"], "notes.txt", { type: "text/plain" });
    const item = {
      kind: "file",
      type: "text/plain",
      getAsFile: () => file,
    };

    await act(async () => {
      await hook.result.handlePaste({
        clipboardData: { items: [item] },
        preventDefault,
      } as unknown as React.ClipboardEvent<HTMLTextAreaElement>);
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(onAttachImages).toHaveBeenCalledWith([
      'data:text/plain;name="notes.txt";base64,MOCK',
    ]);

    hook.unmount();
    restoreFileReader();
  });

  it("attaches pasted image file paths from the clipboard", async () => {
    const restoreFileReader = setMockFileReader();
    const onAttachImages = vi.fn();
    const hook = renderImageDropHook({ disabled: false, onAttachImages });
    const preventDefault = vi.fn();

    const file = new File(["data"], "paste.png", { type: "image/png" });
    Object.defineProperty(file, "path", {
      value: "D:\\Pictures\\paste.png",
      configurable: true,
    });
    const item = {
      kind: "file",
      type: "image/png",
      getAsFile: () => file,
    };

    await act(async () => {
      await hook.result.handlePaste({
        clipboardData: { items: [item] },
        preventDefault,
      } as unknown as React.ClipboardEvent<HTMLTextAreaElement>);
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(onAttachImages).toHaveBeenCalledWith(["D:\\Pictures\\paste.png"]);

    hook.unmount();
    restoreFileReader();
  });

  it("reports path and inline clipboard files as one paste transaction", async () => {
    const restoreFileReader = setMockFileReader();
    const onAttachImages = vi.fn();
    const onPasteImages = vi.fn();
    const hook = renderImageDropHook({
      disabled: false,
      onAttachImages,
      onPasteImages,
    });
    const pathFile = new File(["path"], "path.png", { type: "image/png" });
    Object.defineProperty(pathFile, "path", {
      value: "D:\\Pictures\\path.png",
      configurable: true,
    });
    const inlineFile = new File(["inline"], "inline.txt", {
      type: "text/plain",
    });

    await act(async () => {
      await hook.result.handlePaste({
        clipboardData: {
          items: [
            { kind: "file", type: "image/png", getAsFile: () => pathFile },
            { kind: "file", type: "text/plain", getAsFile: () => inlineFile },
          ],
        },
        preventDefault: vi.fn(),
      } as unknown as React.ClipboardEvent<HTMLTextAreaElement>);
    });

    expect(onPasteImages).toHaveBeenCalledTimes(1);
    expect(onPasteImages).toHaveBeenCalledWith([
      "D:\\Pictures\\path.png",
      'data:text/plain;name="inline.txt";base64,MOCK',
    ]);
    expect(onAttachImages).not.toHaveBeenCalled();

    hook.unmount();
    restoreFileReader();
  });

  it("filters tauri drag-drop paths and respects drop target", async () => {
    const onAttachImages = vi.fn();
    const hook = renderImageDropHook({ disabled: false, onAttachImages });

    const target = document.createElement("div");
    target.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 100 } as DOMRect);
    hook.result.dropTargetRef.current = target;

    Object.defineProperty(window, "devicePixelRatio", {
      value: 2,
      configurable: true,
    });

    await act(async () => {
      await Promise.resolve();
    });

    if (!mockOnDragDropEvent) {
      throw new Error("Drag drop handler not registered");
    }

    act(() => {
      mockOnDragDropEvent?.({
        payload: {
          type: "over",
          position: { x: 40, y: 40 },
          paths: [],
        },
      });
    });

    expect(hook.result.isDragOver).toBe(true);

    act(() => {
      mockOnDragDropEvent?.({
        payload: {
          type: "drop",
          position: { x: 40, y: 40 },
          paths: [" /tmp/photo.png ", "/tmp/note.txt"],
        },
      });
    });

    expect(onAttachImages).toHaveBeenCalledWith(["/tmp/photo.png", "/tmp/note.txt"]);

    hook.unmount();
  });

  it("accepts heic paths from tauri drag-drop", async () => {
    const onAttachImages = vi.fn();
    const hook = renderImageDropHook({ disabled: false, onAttachImages });

    const target = document.createElement("div");
    target.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 100 } as DOMRect);
    hook.result.dropTargetRef.current = target;

    await act(async () => {
      await Promise.resolve();
    });

    if (!mockOnDragDropEvent) {
      throw new Error("Drag drop handler not registered");
    }

    act(() => {
      mockOnDragDropEvent?.({
        payload: {
          type: "drop",
          position: { x: 40, y: 40 },
          paths: ["/tmp/screenshot.heic"],
        },
      });
    });

    expect(onAttachImages).toHaveBeenCalledWith(["/tmp/screenshot.heic"]);

    hook.unmount();
  });

  it("ignores drag/drop and paste when disabled", async () => {
    const onAttachImages = vi.fn();
    const hook = renderImageDropHook({ disabled: true, onAttachImages });
    const preventDefault = vi.fn();

    act(() => {
      hook.result.handleDragOver({
        dataTransfer: { types: ["Files"] },
        preventDefault,
      } as unknown as React.DragEvent<HTMLElement>);
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(hook.result.isDragOver).toBe(false);

    await act(async () => {
      await hook.result.handleDrop({
        dataTransfer: { files: [], items: [] },
        preventDefault: vi.fn(),
      } as unknown as React.DragEvent<HTMLElement>);
    });
    expect(onAttachImages).not.toHaveBeenCalled();

    await act(async () => {
      await hook.result.handlePaste({
        clipboardData: { items: [] },
        preventDefault,
      } as unknown as React.ClipboardEvent<HTMLTextAreaElement>);
    });
    expect(onAttachImages).not.toHaveBeenCalled();

    hook.unmount();
  });
});
