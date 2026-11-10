const SEARCH_HIGHLIGHT = "threadfleet-message-search";

/** Match rendered text across Markdown spans without mutating React's DOM. */
export function getMessageSearchRanges(root: HTMLElement, query: string): Range[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; start: number; end: number }[] = [];
  let text = "";
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const parent = node.parentElement;
    if (
      !parent ||
      parent.closest(".messages-search-target") !== root ||
      parent.closest('script, style, svg, [hidden], [aria-hidden="true"]')
    ) continue;
    const start = text.length;
    text += node.data;
    nodes.push({ node, start, end: text.length });
  }
  const haystack = text.toLowerCase();
  const ranges: Range[] = [];
  for (let offset = haystack.indexOf(needle); offset >= 0;
    offset = haystack.indexOf(needle, offset + needle.length)) {
    const start = nodes.find((entry) => entry.end > offset);
    const end = nodes.find((entry) => entry.end >= offset + needle.length);
    if (!start || !end) continue;
    const range = document.createRange();
    range.setStart(start.node, offset - start.start);
    range.setEnd(end.node, offset + needle.length - end.start);
    ranges.push(range);
  }
  return ranges;
}

export function highlightMessageSearchRanges(ranges: Range[]): () => void {
  // Custom Highlight is supported by desktop WebViews; the row outline remains
  // available on older engines that don't expose it.
  if (typeof Highlight === "undefined" || typeof CSS === "undefined" || !CSS.highlights) {
    return () => {};
  }
  const highlight = new Highlight(...ranges);
  CSS.highlights.set(SEARCH_HIGHLIGHT, highlight);
  return () => {
    if (CSS.highlights.get(SEARCH_HIGHLIGHT) === highlight) {
      CSS.highlights.delete(SEARCH_HIGHLIGHT);
    }
  };
}

export function scrollToMessageSearchRange(
  node: HTMLElement, range: Range | undefined, container: HTMLElement | null,
) {
  // Tool terminals and code blocks have their own scrollports. Reveal the line
  // there before calculating its position in the conversation scrollport.
  if (range && container) {
    for (let parent = range.startContainer.parentElement;
      parent && parent !== container; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const rect = range.getClientRects?.()[0];
      if (!rect) break;
      const viewport = parent.getBoundingClientRect();
      if (parent.clientHeight > 0 && parent.scrollHeight > parent.clientHeight &&
          /auto|scroll/.test(style.overflowY)) {
        parent.scrollTop += rect.top - viewport.top - parent.clientHeight / 2 + rect.height / 2;
      }
      if (parent.clientWidth > 0 && parent.scrollWidth > parent.clientWidth &&
          /auto|scroll/.test(style.overflowX)) {
        parent.scrollLeft += rect.left - viewport.left - parent.clientWidth / 2 + rect.width / 2;
      }
    }
  }
  const rect = range?.getClientRects?.()[0];
  if (rect && container && container.clientHeight > 0) {
    const viewport = container.getBoundingClientRect();
    container.scrollTop += rect.top - viewport.top - container.clientHeight / 2 + rect.height / 2;
  } else {
    node.scrollIntoView({ block: "center", behavior: "instant" });
  }
}
