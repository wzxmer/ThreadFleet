/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { saveComposerImages } from "../../../services/tauri";
import { useComposerImages } from "./useComposerImages";

vi.mock("../../../services/tauri", () => ({
  pickAttachmentFiles: vi.fn().mockResolvedValue([]),
  saveComposerImages: vi.fn(async (
    _workspaceId: string,
    _ownerKey: string,
    images: string[],
  ) =>
    images.map(
      (image) =>
        `/home/.codex/codex-monitor/attachments/sessions/session/${
          image.split("/").pop() ?? "image.png"
        }`,
    ),
  ),
}));

type HookResult = ReturnType<typeof useComposerImages>;

type RenderedHook = {
  result: HookResult;
  rerender: (next: { activeThreadId: string | null; activeWorkspaceId: string | null }) => void;
  unmount: () => void;
};

function renderComposerImages(
  initial: { activeThreadId: string | null; activeWorkspaceId: string | null },
): RenderedHook {
  let props = initial;
  let result: HookResult | undefined;

  function Test() {
    result = useComposerImages(props);
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
    rerender: (next) => {
      props = next;
      act(() => {
        root.render(React.createElement(Test));
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("useComposerImages", () => {
  it("keeps non-image attachments as original paths", async () => {
    const hook = renderComposerImages({
      activeThreadId: "thread-text",
      activeWorkspaceId: "ws-1",
    });

    await act(async () => {
      hook.result.attachImages(["/tmp/notes.md"]);
      await Promise.resolve();
    });

    expect(saveComposerImages).not.toHaveBeenCalled();
    expect(hook.result.activeImages).toEqual(["/tmp/notes.md"]);

    hook.unmount();
  });

  it("keeps all attachments beyond ten and deduplicates later additions", async () => {
    const hook = renderComposerImages({
      activeThreadId: "thread-limit",
      activeWorkspaceId: "ws-1",
    });
    const attachments = Array.from(
      { length: 12 },
      (_, index) => `/tmp/file-${index + 1}.md`,
    );

    await act(async () => {
      hook.result.attachImages(attachments);
      await Promise.resolve();
    });

    expect(hook.result.activeImages).toEqual(attachments);

    act(() => {
      hook.result.attachImages([attachments[0], "/tmp/another.custom"]);
    });
    expect(hook.result.activeImages).toEqual([...attachments, "/tmp/another.custom"]);

    hook.unmount();
  });

  it("restores every attachment after a failed transfer beyond ten", () => {
    const hook = renderComposerImages({
      activeThreadId: "thread-restore",
      activeWorkspaceId: "ws-1",
    });
    const attachments = Array.from(
      { length: 12 },
      (_, index) => `/tmp/file-${index}.custom`,
    );
    act(() => {
      hook.result.attachImages(attachments);
    });
    let token: { draftKey: string; generation: number } | null = null;
    act(() => {
      token = hook.result.transferActiveImages(attachments);
      hook.result.attachImages(["/tmp/new.custom"]);
    });
    expect(hook.result.activeImages).toEqual(["/tmp/new.custom"]);

    act(() => {
      hook.result.restoreImagesForDraft(token!, attachments);
    });
    expect(hook.result.activeImages).toEqual(["/tmp/new.custom", ...attachments]);
    hook.unmount();
  });

  it("attaches images and deduplicates paths", async () => {
    const hook = renderComposerImages({
      activeThreadId: "thread-1",
      activeWorkspaceId: "ws-1",
    });

    await act(async () => {
      hook.result.attachImages(["/tmp/a.png", "/tmp/b.png"]);
      await Promise.resolve();
    });

    expect(hook.result.activeImages).toEqual([
      "/home/.codex/codex-monitor/attachments/sessions/session/a.png",
      "/home/.codex/codex-monitor/attachments/sessions/session/b.png",
    ]);
    expect(saveComposerImages).toHaveBeenCalledWith(
      "ws-1",
      "thread-1",
      ["/tmp/a.png", "/tmp/b.png"],
    );

    await act(async () => {
      hook.result.attachImages(["/tmp/b.png", "/tmp/c.png"]);
      await Promise.resolve();
    });

    expect(hook.result.activeImages).toEqual([
      "/home/.codex/codex-monitor/attachments/sessions/session/a.png",
      "/home/.codex/codex-monitor/attachments/sessions/session/b.png",
      "/home/.codex/codex-monitor/attachments/sessions/session/c.png",
    ]);

    hook.unmount();
  });

  it("removes images and clears empty drafts", async () => {
    const hook = renderComposerImages({
      activeThreadId: "thread-2",
      activeWorkspaceId: "ws-1",
    });

    await act(async () => {
      hook.result.attachImages(["/tmp/a.png", "/tmp/b.png"]);
      await Promise.resolve();
    });

    act(() => {
      hook.result.removeImage(
        "/home/.codex/codex-monitor/attachments/sessions/session/a.png",
      );
    });

    expect(hook.result.activeImages).toEqual([
      "/home/.codex/codex-monitor/attachments/sessions/session/b.png",
    ]);
    act(() => {
      hook.result.removeImage(
        "/home/.codex/codex-monitor/attachments/sessions/session/b.png",
      );
    });

    expect(hook.result.activeImages).toEqual([]);

    hook.unmount();
  });

  it("clears only submitted images and returns their original draft key", async () => {
    const hook = renderComposerImages({
      activeThreadId: null,
      activeWorkspaceId: "ws-1",
    });

    act(() => {
      hook.result.attachImages(["/tmp/submitted.md", "/tmp/remaining.md"]);
    });

    let token: { draftKey: string; generation: number } | null = null;
    act(() => {
      token = hook.result.transferActiveImages(["/tmp/submitted.md"]);
    });

    expect(token).toEqual({ draftKey: "draft-ws-1", generation: 0 });
    expect(hook.result.activeImages).toEqual(["/tmp/remaining.md"]);

    hook.unmount();
  });

  it("restores images by original draft key and merges newer attachments", async () => {
    const hook = renderComposerImages({
      activeThreadId: null,
      activeWorkspaceId: "ws-1",
    });

    act(() => {
      hook.result.attachImages(["/tmp/original.md"]);
    });
    let token: { draftKey: string; generation: number } | null = null;
    act(() => {
      token = hook.result.transferActiveImages(["/tmp/original.md"]);
      hook.result.attachImages(["/tmp/new.md"]);
    });

    hook.rerender({ activeThreadId: null, activeWorkspaceId: "ws-2" });
    act(() => {
      hook.result.attachImages(["/tmp/other-workspace.md"]);
      hook.result.restoreImagesForDraft(token!, [
        "/tmp/original.md",
        "/tmp/new.md",
      ]);
    });

    expect(hook.result.activeImages).toEqual(["/tmp/other-workspace.md"]);
    hook.rerender({ activeThreadId: null, activeWorkspaceId: "ws-1" });
    expect(hook.result.activeImages).toEqual([
      "/tmp/new.md",
      "/tmp/original.md",
    ]);

    hook.unmount();
  });

  it("restores an earlier failed transfer after a later transfer succeeds", () => {
    const hook = renderComposerImages({
      activeThreadId: null,
      activeWorkspaceId: "ws-1",
    });

    act(() => {
      hook.result.attachImages(["/tmp/first.md"]);
    });
    let firstToken: { draftKey: string; generation: number } | null = null;
    act(() => {
      firstToken = hook.result.transferActiveImages(["/tmp/first.md"]);
      hook.result.attachImages(["/tmp/second.md"]);
    });
    let secondToken: { draftKey: string; generation: number } | null = null;
    act(() => {
      secondToken = hook.result.transferActiveImages(["/tmp/second.md"]);
    });

    expect(firstToken).toEqual({ draftKey: "draft-ws-1", generation: 0 });
    expect(secondToken).toEqual({ draftKey: "draft-ws-1", generation: 0 });
    act(() => {
      hook.result.restoreImagesForDraft(firstToken!, ["/tmp/first.md"]);
    });

    expect(hook.result.activeImages).toEqual(["/tmp/first.md"]);

    hook.unmount();
  });

  it("does not restore a transfer after its draft is explicitly cleared", () => {
    const hook = renderComposerImages({
      activeThreadId: null,
      activeWorkspaceId: "ws-1",
    });

    act(() => {
      hook.result.attachImages(["/tmp/original.md"]);
    });
    let token: { draftKey: string; generation: number } | null = null;
    act(() => {
      token = hook.result.transferActiveImages(["/tmp/original.md"]);
      hook.result.clearActiveImages();
      hook.result.restoreImagesForDraft(token!, ["/tmp/original.md"]);
    });

    expect(hook.result.activeImages).toEqual([]);

    hook.unmount();
  });

  it("treats attachment replacement as an explicit draft ownership change", () => {
    const hook = renderComposerImages({
      activeThreadId: null,
      activeWorkspaceId: "ws-1",
    });

    act(() => {
      hook.result.attachImages(["/tmp/original.md"]);
    });
    let token: { draftKey: string; generation: number } | null = null;
    act(() => {
      token = hook.result.transferActiveImages(["/tmp/original.md"]);
      hook.result.replaceActiveImages(["/tmp/replacement.md"]);
      hook.result.restoreImagesForDraft(token!, ["/tmp/original.md"]);
    });

    expect(hook.result.activeImageDraftKey).toBe("draft-ws-1");
    expect(hook.result.activeImages).toEqual(["/tmp/replacement.md"]);

    hook.unmount();
  });

  it("does not restore an image removed before attachment saving finishes", async () => {
    let resolveSave: (paths: string[]) => void = () => {};
    vi.mocked(saveComposerImages).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    const hook = renderComposerImages({
      activeThreadId: "thread-2",
      activeWorkspaceId: "ws-1",
    });

    act(() => {
      hook.result.attachImages(["/tmp/a.png"]);
    });
    expect(hook.result.activeImages).toEqual(["/tmp/a.png"]);

    act(() => {
      hook.result.removeImage("/tmp/a.png");
    });
    expect(hook.result.activeImages).toEqual([]);

    await act(async () => {
      resolveSave([
        "/home/.codex/codex-monitor/attachments/sessions/session/a.png",
      ]);
      await Promise.resolve();
    });
    expect(hook.result.activeImages).toEqual([]);

    hook.unmount();
  });

  it("switches drafts between thread and workspace", async () => {
    const hook = renderComposerImages({
      activeThreadId: "thread-1",
      activeWorkspaceId: "ws-1",
    });

    await act(async () => {
      hook.result.attachImages(["/tmp/a.png"]);
      await Promise.resolve();
    });
    expect(hook.result.activeImages).toEqual([
      "/home/.codex/codex-monitor/attachments/sessions/session/a.png",
    ]);

    hook.rerender({ activeThreadId: null, activeWorkspaceId: "ws-1" });
    expect(hook.result.activeImages).toEqual([]);

    await act(async () => {
      hook.result.attachImages(["/tmp/b.png"]);
      await Promise.resolve();
    });
    expect(hook.result.activeImages).toEqual([
      "/home/.codex/codex-monitor/attachments/sessions/session/b.png",
    ]);
    expect(saveComposerImages).toHaveBeenLastCalledWith(
      "ws-1",
      "draft-ws-1",
      ["/tmp/b.png"],
    );

    hook.rerender({ activeThreadId: "thread-1", activeWorkspaceId: "ws-1" });
    expect(hook.result.activeImages).toEqual([
      "/home/.codex/codex-monitor/attachments/sessions/session/a.png",
    ]);

    hook.unmount();
  });
});
