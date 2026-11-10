// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getMessageSearchRanges,
  highlightMessageSearchRanges,
  scrollToMessageSearchRange,
} from "./messageSearch";

afterEach(() => vi.unstubAllGlobals());

describe("message search rendered ranges", () => {
  it("highlights case-insensitive text across Markdown spans, excluding nested process rows", () => {
    const root = document.createElement("div");
    root.className = "messages-search-target";
    root.innerHTML = '<p>Before Graph<strong>ify</strong> after graphify</p>' +
      '<div class="messages-search-target">Graphify nested output</div>' +
      '<span hidden>Graphify hidden</span>';
    const ranges = getMessageSearchRanges(root, "Graphify");
    expect(ranges.map((range) => range.toString())).toEqual(["Graphify", "graphify"]);
    expect(ranges[0].startContainer.textContent).toBe("Before Graph");
    expect(ranges[0].endContainer.textContent).toBe("ify");
  });

  it("registers and clears painted highlights without changing the rendered DOM", () => {
    const registry = new Map();
    vi.stubGlobal("CSS", { highlights: registry });
    vi.stubGlobal("Highlight", class extends Set<Range> {
      constructor(...ranges: Range[]) { super(ranges); }
    });
    const root = document.createElement("div");
    root.className = "messages-search-target";
    root.innerHTML = "A Graphify result";
    const clear = highlightMessageSearchRanges(getMessageSearchRanges(root, "Graphify"));
    expect([...registry.get("threadfleet-message-search")][0].toString()).toBe("Graphify");
    expect(root.innerHTML).toBe("A Graphify result");
    clear();
    expect(registry.size).toBe(0);
  });

  it("centers the matched line rather than the entire long message", () => {
    const container = document.createElement("div");
    Object.defineProperty(container, "clientHeight", { value: 600 });
    container.scrollTop = 100;
    container.getBoundingClientRect = () => ({ top: 80 }) as DOMRect;
    const node = document.createElement("div");
    node.scrollIntoView = vi.fn();
    const range = document.createRange();
    range.getClientRects = () => [{ top: 1600, height: 20 }] as unknown as DOMRectList;
    scrollToMessageSearchRange(node, range, container);
    expect(container.scrollTop).toBe(1330);
    expect(node.scrollIntoView).not.toHaveBeenCalled();
  });
});
