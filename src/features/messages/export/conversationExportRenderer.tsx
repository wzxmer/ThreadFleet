import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import { ConversationExportDocument } from "./ConversationExportDocument";
import type {
  ConversationExportFormat,
  ConversationExportMessage,
} from "./conversationExport";

const EXPORT_SCALE = 2;
const MAX_PNG_PIXEL_HEIGHT = 16_000;
const MAX_PNG_PIXEL_AREA = 80_000_000;
const IMAGE_WAIT_TIMEOUT_MS = 12_000;

export class ConversationExportCancelledError extends Error {
  constructor() {
    super("Conversation export cancelled");
    this.name = "ConversationExportCancelledError";
  }
}

export class ConversationExportImageTooTallError extends Error {
  constructor() {
    super("Conversation export image exceeds the safe canvas size");
    this.name = "ConversationExportImageTooTallError";
  }
}

type RenderConversationExportOptions = {
  format: ConversationExportFormat;
  messages: ConversationExportMessage[];
  exportedAt: Date;
  exportedAtLabel: string;
  imageUnavailableLabel: string;
  signal: AbortSignal;
  onProgress: (completed: number, total: number) => void;
};

function throwIfCancelled(signal: AbortSignal) {
  if (signal.aborted) {
    throw new ConversationExportCancelledError();
  }
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitForImages(container: HTMLElement, signal: AbortSignal) {
  const images = Array.from(container.querySelectorAll("img"));
  await Promise.all(images.map((image) => new Promise<void>((resolve) => {
    if (image.complete) {
      resolve();
      return;
    }
    const finish = () => {
      image.removeEventListener("load", finish);
      image.removeEventListener("error", finish);
      resolve();
    };
    image.addEventListener("load", finish, { once: true });
    image.addEventListener("error", finish, { once: true });
    setTimeout(finish, IMAGE_WAIT_TIMEOUT_MS);
  })));
  throwIfCancelled(signal);
}

async function renderElement(element: HTMLElement) {
  const bounds = element.getBoundingClientRect();
  const sourceWidth = Math.ceil(Math.max(bounds.width, element.scrollWidth, element.offsetWidth));
  const sourceHeight = Math.ceil(Math.max(bounds.height, element.scrollHeight, element.offsetHeight));
  if (sourceWidth < 1 || sourceHeight < 1) {
    const style = window.getComputedStyle(element);
    throw new Error(
      `Export block has no rendered size (${sourceWidth}x${sourceHeight}, ${element.className}, connected=${element.isConnected}, parentConnected=${element.parentElement?.isConnected ?? false}, display=${style.display})`,
    );
  }
  const renderRoot = document.createElement("div");
  renderRoot.className = "conversation-export-render-root";
  renderRoot.style.width = `${sourceWidth}px`;
  renderRoot.appendChild(element.cloneNode(true));
  document.body.appendChild(renderRoot);

  try {
    const canvas = await html2canvas(renderRoot, {
      backgroundColor: "#ffffff",
      scale: EXPORT_SCALE,
      logging: false,
      useCORS: true,
      imageTimeout: IMAGE_WAIT_TIMEOUT_MS,
      ignoreElements: (candidate) => {
        if (
          candidate === renderRoot
          || candidate.contains(renderRoot)
          || renderRoot.contains(candidate)
        ) {
          return false;
        }
        return candidate.tagName !== "HEAD"
          && candidate.tagName !== "STYLE"
          && candidate.tagName !== "LINK";
      },
      onclone: (_clonedDocument, clonedElement) => {
        clonedElement.style.opacity = "1";
      },
    });
    if (canvas.width < 1 || canvas.height < 1) {
      throw new Error(
        `Export raster is empty (${sourceWidth}x${sourceHeight} -> ${canvas.width}x${canvas.height}, ${element.className})`,
      );
    }
    return canvas;
  } finally {
    renderRoot.remove();
  }
}

function canvasToPngBytes(canvas: HTMLCanvasElement) {
  return new Promise<Uint8Array>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Failed to encode PNG"));
        return;
      }
      void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
    }, "image/png");
  });
}

function createCanvasSlice(source: HTMLCanvasElement, startY: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas rendering is unavailable");
  }
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, startY, source.width, height, 0, 0, source.width, height);
  return canvas;
}

function findReadableSliceHeight(
  canvas: HTMLCanvasElement,
  startY: number,
  idealHeight: number,
) {
  const remaining = canvas.height - startY;
  if (remaining <= idealHeight) {
    return remaining;
  }
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return idealHeight;
  }
  const searchStart = Math.max(32, idealHeight - 140);
  for (let offset = idealHeight; offset >= searchStart; offset -= 4) {
    const data = context.getImageData(0, startY + offset, canvas.width, 1).data;
    let colored = 0;
    for (let index = 0; index < data.length; index += 16) {
      if (data[index] < 244 || data[index + 1] < 244 || data[index + 2] < 244) {
        colored += 1;
        if (colored > 3) break;
      }
    }
    if (colored <= 3) return offset;
  }
  return idealHeight;
}

async function renderPdf(
  blocks: HTMLElement[],
  signal: AbortSignal,
  onProgress: (completed: number, total: number) => void,
) {
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const marginX = 18;
  const marginY = 16;
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const contentWidth = pageWidth - marginX * 2;
  const contentHeight = pageHeight - marginY * 2;
  let cursorY = marginY;
  let hasContent = false;

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    try {
      throwIfCancelled(signal);
      const canvas = await renderElement(block);
      throwIfCancelled(signal);
      const mmPerPixel = contentWidth / canvas.width;
      let sourceY = 0;
      while (sourceY < canvas.height) {
        let availableMm = pageHeight - marginY - cursorY;
        if (availableMm < 18 && hasContent) {
          pdf.addPage("a4", "portrait");
          cursorY = marginY;
          availableMm = contentHeight;
        }
        const idealPixels = Math.max(1, Math.floor(availableMm / mmPerPixel));
        const sliceHeight = findReadableSliceHeight(canvas, sourceY, idealPixels);
        const slice = createCanvasSlice(canvas, sourceY, sliceHeight);
        const renderedHeight = sliceHeight * mmPerPixel;
        pdf.addImage(slice.toDataURL("image/png"), "PNG", marginX, cursorY, contentWidth, renderedHeight);
        sourceY += sliceHeight;
        cursorY += renderedHeight + 3;
        hasContent = true;
        slice.width = 0;
        slice.height = 0;
        if (sourceY < canvas.height) {
          pdf.addPage("a4", "portrait");
          cursorY = marginY;
        }
      }
      canvas.width = 0;
      canvas.height = 0;
      onProgress(blockIndex + 1, blocks.length);
    } catch (error) {
      if (error instanceof ConversationExportCancelledError) {
        throw error;
      }
      throw new Error(
        `PDF block ${blockIndex + 1}/${blocks.length} (${block.className}): ${describeError(error)}`,
      );
    }
  }
  try {
    return new Uint8Array(pdf.output("arraybuffer"));
  } catch (error) {
    throw new Error(`PDF assembly failed: ${describeError(error)}`);
  }
}

export async function renderConversationExport({
  format,
  messages,
  exportedAt,
  exportedAtLabel,
  imageUnavailableLabel,
  signal,
  onProgress,
}: RenderConversationExportOptions) {
  throwIfCancelled(signal);
  const host = document.createElement("div");
  host.className = "conversation-export-host";
  document.body.appendChild(host);
  const root = createRoot(host);
  let stage = "rendering export document";
  try {
    flushSync(() => {
      root.render(
        <ConversationExportDocument
          messages={messages}
          exportedAt={exportedAt}
          exportedAtLabel={exportedAtLabel}
          imageUnavailableLabel={imageUnavailableLabel}
        />,
      );
    });
    await nextFrame();
    await nextFrame();
    await document.fonts?.ready;
    stage = "loading export images";
    await waitForImages(host, signal);
    const documentElement = host.querySelector<HTMLElement>(".conversation-export-document");
    if (!documentElement) throw new Error("Export document did not render");
    if (format === "png") {
      stage = "rendering PNG";
      const pixelWidth = Math.ceil(documentElement.scrollWidth * EXPORT_SCALE);
      const pixelHeight = Math.ceil(documentElement.scrollHeight * EXPORT_SCALE);
      if (pixelHeight > MAX_PNG_PIXEL_HEIGHT || pixelWidth * pixelHeight > MAX_PNG_PIXEL_AREA) {
        throw new ConversationExportImageTooTallError();
      }
      const canvas = await renderElement(documentElement);
      try {
        throwIfCancelled(signal);
        onProgress(1, 1);
        return await canvasToPngBytes(canvas);
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    const blocks = Array.from(
      documentElement.querySelectorAll<HTMLElement>("[data-export-block]"),
    );
    stage = "rendering PDF";
    // The source host must stay mounted until every block has been rasterized.
    return await renderPdf(blocks, signal, onProgress);
  } catch (error) {
    if (
      error instanceof ConversationExportCancelledError
      || error instanceof ConversationExportImageTooTallError
      || (error instanceof Error && /^PDF (?:block|assembly)/.test(error.message))
    ) {
      throw error;
    }
    throw new Error(`${stage}: ${describeError(error)}`);
  } finally {
    try {
      root.unmount();
    } catch {
      // Cleanup is best-effort and must not replace the export result or primary error.
    }
    host.remove();
  }
}
