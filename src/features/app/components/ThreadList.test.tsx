// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadSummary } from "../../../types";
import { ThreadList } from "./ThreadList";

const nestedThread: ThreadSummary = {
  id: "thread-2",
  name: "Nested Agent",
  updatedAt: 900,
  isSubagent: true,
  subagentNickname: "Robie",
  subagentRole: "explorer",
};

const thread: ThreadSummary = {
  id: "thread-1",
  name: "Alpha",
  updatedAt: 1000,
};

const statusMap = {
  "thread-1": { isProcessing: false, hasUnread: true, isReviewing: false },
  "thread-2": { isProcessing: false, hasUnread: false, isReviewing: false },
};

const baseProps = {
  workspaceId: "ws-1",
  pinnedRows: [],
  unpinnedRows: [{ thread, depth: 0 }],
  totalThreadRoots: 1,
  isExpanded: false,
  nextCursor: null,
  isPaging: false,
  nested: false,
  activeWorkspaceId: "ws-1",
  activeThreadId: "thread-1",
  threadStatusById: statusMap,
  getThreadTime: () => "2m",
  isThreadPinned: () => false,
  onToggleExpanded: vi.fn(),
  onLoadOlderThreads: vi.fn(),
  onSelectThread: vi.fn(),
  onShowThreadMenu: vi.fn(),
};

describe("ThreadList", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders active row and handles click/context menu", () => {
    const onSelectThread = vi.fn();
    const onShowThreadMenu = vi.fn();

    render(
      <ThreadList
        {...baseProps}
        onSelectThread={onSelectThread}
        onShowThreadMenu={onShowThreadMenu}
      />,
    );

    const row = screen.getByText("Alpha").closest(".thread-row");
    expect(row).toBeTruthy();
    if (!row) {
      throw new Error("Missing thread row");
    }
    expect(row.classList.contains("active")).toBe(true);
    expect(row.querySelector(".thread-status")?.className).toContain("unread");

    fireEvent.click(row);
    expect(onSelectThread).toHaveBeenCalledWith("ws-1", "thread-1");

    fireEvent.contextMenu(row);
    expect(onShowThreadMenu).toHaveBeenCalledWith(
      expect.anything(),
      "ws-1",
      "thread-1",
      true,
    );
  });

  it("shows 10 roots after the first click and 10 more after each later click", () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({
      thread: {
        id: `thread-${index}`,
        name: `Thread ${index}`,
        updatedAt: 1000 - index,
      },
      depth: 0,
    }));
    const { container } = render(
      <ThreadList
        {...baseProps}
        unpinnedRows={rows}
        totalThreadRoots={rows.length}
      />,
    );

    expect(container.querySelectorAll(".thread-row")).toHaveLength(6);

    let moreButton = screen.getByRole("button", { name: "更多..." });
    fireEvent.click(moreButton);
    expect(container.querySelectorAll(".thread-row")).toHaveLength(10);

    moreButton = screen.getByRole("button", { name: "更多..." });
    fireEvent.click(moreButton);
    expect(container.querySelectorAll(".thread-row")).toHaveLength(20);

    moreButton = screen.getByRole("button", { name: "更多..." });
    fireEvent.click(moreButton);
    expect(container.querySelectorAll(".thread-row")).toHaveLength(25);
    expect(screen.getByRole("button", { name: "收起" })).toBeTruthy();
  });

  it("counts pinned roots toward each visible batch", () => {
    const pinnedRows = Array.from({ length: 2 }, (_, index) => ({
      thread: {
        id: `pinned-${index}`,
        name: `Pinned ${index}`,
        updatedAt: 2000 - index,
      },
      depth: 0,
    }));
    const unpinnedRows = Array.from({ length: 18 }, (_, index) => ({
      thread: {
        id: `unpinned-${index}`,
        name: `Unpinned ${index}`,
        updatedAt: 1000 - index,
      },
      depth: 0,
    }));
    const { container } = render(
      <ThreadList
        {...baseProps}
        pinnedRows={pinnedRows}
        unpinnedRows={unpinnedRows}
        totalThreadRoots={pinnedRows.length + unpinnedRows.length}
      />,
    );

    expect(container.querySelectorAll(".thread-row")).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "更多..." }));
    expect(container.querySelectorAll(".thread-row")).toHaveLength(10);
  });

  it("resets expanded roots when an owning workspace collapses", () => {
    const rows = Array.from({ length: 15 }, (_, index) => ({
      thread: {
        id: `thread-${index}`,
        name: `Thread ${index}`,
        updatedAt: 1000 - index,
      },
      depth: 0,
    }));
    const { container, rerender } = render(
      <ThreadList
        {...baseProps}
        unpinnedRows={rows}
        totalThreadRoots={rows.length}
        resetExpansionKey={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "更多..." }));
    expect(container.querySelectorAll(".thread-row")).toHaveLength(10);

    rerender(
      <ThreadList
        {...baseProps}
        unpinnedRows={rows}
        totalThreadRoots={rows.length}
        resetExpansionKey
      />,
    );

    expect(container.querySelectorAll(".thread-row")).toHaveLength(6);
  });

  it("loads older threads when a cursor is available", () => {
    const onLoadOlderThreads = vi.fn();
    render(
      <ThreadList
        {...baseProps}
        nextCursor="cursor"
        onLoadOlderThreads={onLoadOlderThreads}
      />,
    );

    const loadButton = screen.getByRole("button", { name: "加载更早会话..." });
    fireEvent.click(loadButton);
    expect(onLoadOlderThreads).toHaveBeenCalledWith("ws-1");
  });

  it("renders nested rows with indentation and disables pinning", () => {
    const onShowThreadMenu = vi.fn();
    render(
      <ThreadList
        {...baseProps}
        nested
        unpinnedRows={[
          { thread, depth: 0 },
          { thread: nestedThread, depth: 1 },
        ]}
        threadStatusById={{ "thread-2": { isProcessing: true } }}
        onShowThreadMenu={onShowThreadMenu}
      />,
    );

    const nestedRow = screen.getByText("Nested Agent").closest(".thread-row");
    expect(nestedRow).toBeTruthy();
    if (!nestedRow) {
      throw new Error("Missing nested thread row");
    }
    expect(nestedRow.getAttribute("style")).toContain("--thread-indent");

    fireEvent.contextMenu(nestedRow);
    expect(onShowThreadMenu).toHaveBeenCalledWith(
      expect.anything(),
      "ws-1",
      "thread-2",
      false,
    );
  });

  it("shows the subagent nickname pill with role styling", () => {
    const { container } = render(
      <ThreadList
        {...baseProps}
        unpinnedRows={[{ thread: nestedThread, depth: 1 }]}
        activeThreadId="thread-2"
      />,
    );

    const pill = screen.getByText("Robie");
    const role = screen.getByText("Explorer");
    expect(pill.className).toContain("thread-subagent-pill");
    expect(role.className).toContain("thread-subagent-role");
    expect((pill as HTMLElement).style.getPropertyValue("--thread-subagent-pill-hue")).toBeTruthy();
    expect(container.querySelector(".thread-workspace-label")).toBeNull();
  });

  it("shows blue unread-style status when a thread is waiting for user input", () => {
    const { container } = render(
      <ThreadList
        {...baseProps}
        threadStatusById={{
          "thread-1": { isProcessing: true, hasUnread: false, isReviewing: false },
          "thread-2": { isProcessing: false, hasUnread: false, isReviewing: false },
        }}
        pendingUserInputKeys={new Set(["ws-1:thread-1"])}
      />,
    );

    const row = container.querySelector(".thread-row");
    expect(row).toBeTruthy();
    expect(row?.querySelector(".thread-name")?.textContent).toBe("Alpha");
    expect(row?.querySelector(".thread-status")?.className).toContain("unread");
    expect(row?.querySelector(".thread-status")?.className).not.toContain("processing");
  });

  it("keeps the execution state before the fixed pin and time lane", () => {
    const { container } = render(
      <ThreadList
        {...baseProps}
        threadStatusById={{ "thread-1": { isProcessing: true } }}
      />,
    );

    const meta = container.querySelector(".thread-meta");
    const state = container.querySelector(".thread-state-chip");
    const time = meta?.querySelector(".thread-time");
    expect(state?.textContent).toBe("运行中");
    expect(time?.textContent).toBe("2m");
    expect(state?.nextElementSibling).toBe(meta);
    expect(meta?.querySelector(".thread-state-chip")).toBeNull();
    expect(container.querySelector(".thread-details .thread-state-chip")).toBeNull();
  });

  it("toggles sub-agent descendants for parent rows", () => {
    const { getByText, queryByText, getByRole } = render(
      <ThreadList
        {...baseProps}
        unpinnedRows={[
          { thread, depth: 0 },
          { thread: nestedThread, depth: 1 },
        ]}
        threadStatusById={{ "thread-2": { isProcessing: true } }}
      />,
    );

    expect(getByText("Nested Agent")).toBeTruthy();
    const hideButton = getByRole("button", { name: "Hide sub-agents" });
    fireEvent.click(hideButton);
    expect(queryByText("Nested Agent")).toBeNull();

    const showButton = getByRole("button", { name: "Show sub-agents" });
    fireEvent.click(showButton);
    expect(getByText("Nested Agent")).toBeTruthy();
  });

  it("shows subagent checkpoint delivery status", () => {
    render(
      <ThreadList
        {...baseProps}
        unpinnedRows={[
          {
            thread: {
              ...thread,
              subagentCheckpointStatus: "delivered",
              subagentCheckpointCount: 2,
            },
            depth: 0,
          },
        ]}
      />,
    );

    expect(screen.getByText("已同步 2 个检查点")).toBeTruthy();
  });

  it("auto-collapses completed sub-agent descendants", () => {
    const { queryByText, getByRole } = render(
      <ThreadList
        {...baseProps}
        unpinnedRows={[
          { thread, depth: 0 },
          { thread: nestedThread, depth: 1 },
        ]}
      />,
    );

    expect(queryByText("Nested Agent")).toBeNull();
    expect(getByRole("button", { name: "Show sub-agents" })).toBeTruthy();
  });

  it("does not show sub-agent toggle for rows without descendants", () => {
    const { queryByRole } = render(<ThreadList {...baseProps} />);

    expect(queryByRole("button", { name: "Hide sub-agents" })).toBeNull();
    expect(queryByRole("button", { name: "Show sub-agents" })).toBeNull();
  });
});
