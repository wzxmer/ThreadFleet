// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { renderConversationExport } from "./conversationExportRenderer";

const { html2canvasMock } = vi.hoisted(() => ({
  html2canvasMock: vi.fn(),
}));

vi.mock("html2canvas", () => ({ default: html2canvasMock }));
vi.mock("jspdf", () => ({
  jsPDF: class {
    internal = {
      pageSize: {
        getWidth: () => 210,
        getHeight: () => 297,
      },
    };
  },
}));

describe("conversation export renderer", () => {
  afterEach(() => {
    html2canvasMock.mockReset();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("renders each PDF block from a standalone body-level root", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 674,
      height: 80,
      top: 0,
      right: 674,
      bottom: 80,
      left: 0,
      toJSON: () => ({}),
    });
    html2canvasMock.mockImplementation(async (
      element: HTMLElement,
      options: { ignoreElements?: (candidate: Element) => boolean },
    ) => {
      expect(element.className).toBe("conversation-export-render-root");
      expect(element.parentElement).toBe(document.body);
      expect(element.querySelector("[data-export-block]")).not.toBeNull();
      expect(options.ignoreElements?.(element)).toBe(false);
      expect(options.ignoreElements?.(element.firstElementChild!)).toBe(false);
      expect(options.ignoreElements?.(document.head)).toBe(false);
      expect(options.ignoreElements?.(document.createElement("style"))).toBe(false);
      expect(options.ignoreElements?.(document.createElement("canvas"))).toBe(true);
      throw new Error("stop after inspecting render root");
    });

    await act(async () => {
      await expect(renderConversationExport({
        format: "pdf",
        messages: [{
          id: "message-1",
          role: "assistant",
          label: "gpt-5-codex",
          text: "Exported response",
          images: [],
          createdAt: null,
        }],
        exportedAt: new Date("2026-07-29T00:00:00Z"),
        exportedAtLabel: "Exported at",
        imageUnavailableLabel: "Image unavailable",
        signal: new AbortController().signal,
        onProgress: vi.fn(),
      })).rejects.toThrow("stop after inspecting render root");
    });

    expect(html2canvasMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".conversation-export-host")).toBeNull();
    expect(document.querySelector(".conversation-export-render-root")).toBeNull();
  });

  it("keeps the source document mounted while PDF rasterization is pending", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 674,
      height: 80,
      top: 0,
      right: 674,
      bottom: 80,
      left: 0,
      toJSON: () => ({}),
    });
    let rejectRasterization: ((error: Error) => void) | null = null;
    html2canvasMock.mockImplementation(() => new Promise((_resolve, reject) => {
      rejectRasterization = reject;
    }));

    let exportPromise!: ReturnType<typeof renderConversationExport>;
    await act(async () => {
      exportPromise = renderConversationExport({
        format: "pdf",
        messages: [{
          id: "message-1",
          role: "assistant",
          label: "gpt-5-codex",
          text: "Exported response",
          images: [],
          createdAt: null,
        }],
        exportedAt: new Date("2026-07-29T00:00:00Z"),
        exportedAtLabel: "Exported at",
        imageUnavailableLabel: "Image unavailable",
        signal: new AbortController().signal,
        onProgress: vi.fn(),
      });
      await vi.waitFor(() => expect(html2canvasMock).toHaveBeenCalledTimes(1));
    });

    expect(document.querySelector(".conversation-export-host")).not.toBeNull();
    expect(rejectRasterization).not.toBeNull();

    await act(async () => {
      rejectRasterization!(new Error("stop pending rasterization"));
      await expect(exportPromise).rejects.toThrow("stop pending rasterization");
    });

    expect(document.querySelector(".conversation-export-host")).toBeNull();
    expect(document.querySelector(".conversation-export-render-root")).toBeNull();
  });
});
