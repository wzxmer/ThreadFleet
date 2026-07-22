// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedSession, SessionSource } from "@/types";
import { SessionManagerList } from "./SessionManagerList";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

const source: SessionSource = { id: "source-a", name: "Primary", codexHomePath: "C:/Users/test/.codex", enabled: true, isCurrent: true, isDefault: true, discoveredAt: 1, lastScanAt: null, status: "ready", error: null };
const managedSession: ManagedSession = { key: "source-a:thread-a", sourceId: "source-a", threadId: "thread-a", sourceKind: "cli", cwd: "C:/missing/project", title: "Archived child", preview: null, createdAt: 1, updatedAt: 2, archivedAt: 2, isArchived: true, parentThreadId: "parent", isSubagent: true, subagentNickname: "worker", subagentRole: null, projectExists: false, fileStatus: "mapped", fileConfidence: "exact" };

describe("SessionManagerList", () => {
  it("selects one session from the whole row without elevating inner controls", () => {
    const onSelectSingle = vi.fn();
    const selectionProps = { onSelectSingle };
    const baseListProps = {
      sessions: [managedSession],
      sources: [source],
      resumingKey: null,
      archivingKeys: new Set<string>(),
      loading: false,
      loadingMore: false,
      error: null,
      hasMore: false,
      onToggleSelected: vi.fn(),
      onResume: vi.fn(),
      onArchive: vi.fn(),
      onDerive: vi.fn(),
      onLoadMore: vi.fn(),
    };
    const { rerender } = render(
      <SessionManagerList {...baseListProps} {...selectionProps} selected={new Set()} />,
    );
    const row = screen.getByText(managedSession.title).closest(".session-manager-row");
    expect(row).not.toBeNull();

    fireEvent.click(row!);
    fireEvent.click(screen.getByText(managedSession.title));

    expect(onSelectSingle).toHaveBeenNthCalledWith(1, managedSession.key);
    expect(onSelectSingle).toHaveBeenNthCalledWith(2, managedSession.key);
    expect(
      Array.from(row!.querySelectorAll("button")).every(
        (button) => button.getAttribute("data-button-elevation") === "none",
      ),
    ).toBe(true);

    onSelectSingle.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "选择 Archived child" }));
    expect(baseListProps.onToggleSelected).toHaveBeenCalledWith(managedSession.key);
    expect(onSelectSingle).not.toHaveBeenCalled();

    rerender(
      <SessionManagerList
        {...baseListProps}
        {...selectionProps}
        selected={new Set([managedSession.key])}
      />,
    );
    expect(row?.classList.contains("is-selected")).toBe(true);
    expect(screen.getByRole("button", { pressed: true }).textContent).toContain(
      managedSession.title,
    );
  });

  it("renders source, archive grouping, missing-project, and subagent metadata", () => {
    const onToggleSelected = vi.fn();
    render(<SessionManagerList sessions={[managedSession]} sources={[source]} selected={new Set()} resumingKey={null} archivingKeys={new Set()} loading={false} loadingMore={false} error={null} hasMore={false} onToggleSelected={onToggleSelected} onResume={vi.fn()} onArchive={vi.fn()} onDerive={vi.fn()} onLoadMore={vi.fn()} />);
    expect(screen.getByText("Primary")).toBeTruthy();
    expect(screen.getByRole("region", { name: "归档会话" })).toBeTruthy();
    expect(screen.getByText("项目缺失")).toBeTruthy();
    expect(screen.getByText("worker")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "选择 Archived child" }));
    expect(onToggleSelected).toHaveBeenCalledWith("source-a:thread-a");
  });

  it("resumes a restorable session without toggling selection", () => {
    const onToggleSelected = vi.fn();
    const onResume = vi.fn();
    const restorable = { ...managedSession, projectExists: true, cwd: "C:/project" };
    render(<SessionManagerList sessions={[restorable]} sources={[source]} selected={new Set()} resumingKey={null} archivingKeys={new Set()} loading={false} loadingMore={false} error={null} hasMore={false} onToggleSelected={onToggleSelected} onResume={onResume} onArchive={vi.fn()} onDerive={vi.fn()} onLoadMore={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(onResume).toHaveBeenCalledWith(restorable);
    expect(onToggleSelected).not.toHaveBeenCalled();
  });

  it("archives an active row but disables archived rows", () => {
    const onArchive = vi.fn();
    const active = { ...managedSession, isArchived: false, archivedAt: null };
    render(<SessionManagerList sessions={[active]} sources={[source]} selected={new Set()} resumingKey={null} archivingKeys={new Set()} loading={false} loadingMore={false} error={null} hasMore={false} onToggleSelected={vi.fn()} onResume={vi.fn()} onArchive={onArchive} onDerive={vi.fn()} onLoadMore={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "归档" }));
    expect(onArchive).toHaveBeenCalledWith(active);
    cleanup();
    render(<SessionManagerList sessions={[managedSession]} sources={[source]} selected={new Set()} resumingKey={null} archivingKeys={new Set()} loading={false} loadingMore={false} error={null} hasMore={false} onToggleSelected={vi.fn()} onResume={vi.fn()} onArchive={onArchive} onDerive={vi.fn()} onLoadMore={vi.fn()} />);
    expect((screen.getByRole("button", { name: "归档" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("references one session without changing selection", () => {
    const onDerive = vi.fn();
    render(<SessionManagerList sessions={[managedSession]} sources={[source]} selected={new Set()} resumingKey={null} archivingKeys={new Set()} loading={false} loadingMore={false} error={null} hasMore={false} onToggleSelected={vi.fn()} onResume={vi.fn()} onArchive={vi.fn()} onDerive={onDerive} onLoadMore={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "引用" }));
    expect(onDerive).toHaveBeenCalledWith(managedSession);
  });

  it("uses a single right-click target for an unselected row and keeps batch selection for a selected row", () => {
    const onArchive = vi.fn();
    const active = { ...managedSession, key: "source-a:active", threadId: "active", title: "Active", isArchived: false, archivedAt: null, projectExists: true };
    const archived = { ...managedSession, key: "source-a:archived", threadId: "archived", title: "Archived", projectExists: true };
    render(<SessionManagerList sessions={[active, archived]} sources={[source]} selected={new Set([archived.key])} resumingKey={null} archivingKeys={new Set()} loading={false} loadingMore={false} error={null} hasMore={false} onToggleSelected={vi.fn()} onResume={vi.fn()} onArchive={onArchive} onDerive={vi.fn()} onLoadMore={vi.fn()} />);
    fireEvent.contextMenu(screen.getByText("Active"));
    expect(screen.getByRole("menu").querySelector(".ds-popover-item")).toBeTruthy();
    expect(screen.getByRole("menu").textContent).not.toContain("永久删除");
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.contextMenu(screen.getByText("Archived"));
    expect(screen.getByRole("menu").textContent).toContain("永久删除");
  });

  it("keeps the context menu inside the session manager boundary", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute("data-session-manager-menu-boundary")) return rect(0, 0, 300, 600);
      return rect(0, 0, 0, 0);
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "menu" ? 220 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "menu" ? 180 : 0;
    });

    const active = { ...managedSession, isArchived: false, archivedAt: null, projectExists: true };
    render(
      <div data-session-manager-menu-boundary>
        <SessionManagerList sessions={[active]} sources={[source]} selected={new Set()} resumingKey={null} archivingKeys={new Set()} loading={false} loadingMore={false} error={null} hasMore={false} onToggleSelected={vi.fn()} onResume={vi.fn()} onArchive={vi.fn()} onDerive={vi.fn()} onLoadMore={vi.fn()} />
      </div>,
    );

    fireEvent.contextMenu(screen.getByText(active.title), { clientX: 270, clientY: 580 });
    const menu = screen.getByRole("menu");

    await waitFor(() => {
      const left = Number.parseFloat(menu.style.left);
      const top = Number.parseFloat(menu.style.top);
      expect(menu.style.width).toBe("220px");
      expect(left).toBeGreaterThanOrEqual(8);
      expect(left + 220).toBeLessThanOrEqual(292);
      expect(top).toBeGreaterThanOrEqual(8);
      expect(top + 180).toBeLessThanOrEqual(592);
    });
  });

  it("shows the local absolute last-used time and keeps relative time auxiliary", () => {
    const updatedAt = new Date(2026, 6, 19, 9, 5).getTime();
    const active = {
      ...managedSession,
      title: "Timed session",
      updatedAt,
      isArchived: false,
      archivedAt: null,
      projectExists: true,
    };

    render(
      <SessionManagerList sessions={[active]} sources={[source]} selected={new Set()} resumingKey={null} archivingKeys={new Set()} loading={false} loadingMore={false} error={null} hasMore={false} onToggleSelected={vi.fn()} onResume={vi.fn()} onArchive={vi.fn()} onDerive={vi.fn()} onLoadMore={vi.fn()} />,
    );

    const row = screen.getByText("Timed session").closest(".session-manager-row");
    const time = row?.querySelector<HTMLElement>(".session-manager-row-time");
    expect(time?.textContent).toBe("2026-07-19 09:05");
    expect(time?.title).toMatch(/^(now|\d+(m|h|d|w|mo|y))$/);
  });

  it("shows an explicit empty value when last-used time is unknown", () => {
    const session = {
      ...managedSession,
      title: "Unknown time",
      updatedAt: null,
    };

    render(
      <SessionManagerList sessions={[session]} sources={[source]} selected={new Set()} resumingKey={null} archivingKeys={new Set()} loading={false} loadingMore={false} error={null} hasMore={false} onToggleSelected={vi.fn()} onResume={vi.fn()} onArchive={vi.fn()} onDerive={vi.fn()} onLoadMore={vi.fn()} />,
    );

    const row = screen.getByText("Unknown time").closest(".session-manager-row");
    const time = row?.querySelector<HTMLElement>(".session-manager-row-time");
    expect(time?.textContent).toBe("—");
    expect(time?.getAttribute("title")).toBeNull();
  });

  it("closes the context menu when the session manager boundary scrolls", () => {
    const active = { ...managedSession, isArchived: false, archivedAt: null, projectExists: true };
    const { container } = render(
      <div data-session-manager-menu-boundary>
        <SessionManagerList sessions={[active]} sources={[source]} selected={new Set()} resumingKey={null} archivingKeys={new Set()} loading={false} loadingMore={false} error={null} hasMore={false} onToggleSelected={vi.fn()} onResume={vi.fn()} onArchive={vi.fn()} onDerive={vi.fn()} onLoadMore={vi.fn()} />
      </div>,
    );

    fireEvent.contextMenu(screen.getByText(active.title));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.scroll(container.firstElementChild as HTMLElement);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("renders child sessions immediately below their visible parent", () => {
    const parent = { ...managedSession, key: "source-a:parent", threadId: "parent", title: "Parent", parentThreadId: null, isSubagent: false, isArchived: false, archivedAt: null };
    const child = { ...managedSession, key: "source-a:child", threadId: "child", title: "Child", parentThreadId: "parent" };
    const unrelated = { ...managedSession, key: "source-a:other", threadId: "other", title: "Other", parentThreadId: null, isSubagent: false, isArchived: false, archivedAt: null };
    const { container } = render(<SessionManagerList sessions={[parent, unrelated, child]} sources={[source]} selected={new Set()} resumingKey={null} archivingKeys={new Set()} loading={false} loadingMore={false} error={null} hasMore={false} onToggleSelected={vi.fn()} onResume={vi.fn()} onArchive={vi.fn()} onDerive={vi.fn()} onLoadMore={vi.fn()} />);
    const titles = Array.from(container.querySelectorAll(".session-manager-row-title"), (node) => node.textContent);
    expect(titles).toEqual(["Parent", "Child", "Other"]);
    expect(screen.getByText("Child").closest(".session-manager-row")?.classList.contains("is-child")).toBe(true);
    expect((screen.getByText("Child").closest(".session-manager-row") as HTMLElement).style.getPropertyValue("--session-manager-depth")).toBe("1");
    expect(screen.queryByRole("region", { name: "已归档" })).toBeNull();
  });

  it("applies batch context actions to the selected collection", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const onArchiveSelected = vi.fn();
    const onDeriveSelected = vi.fn();
    const onPermanentDelete = vi.fn();
    const active = { ...managedSession, key: "source-a:active", threadId: "active", title: "Active", isArchived: false, archivedAt: null, projectExists: true };
    const archived = { ...managedSession, key: "source-a:archived", threadId: "archived", title: "Archived", projectExists: true };
    render(<SessionManagerList sessions={[active, archived]} sources={[source]} selected={new Set([active.key, archived.key])} resumingKey={null} archivingKeys={new Set()} loading={false} loadingMore={false} error={null} hasMore={false} onToggleSelected={vi.fn()} onResume={vi.fn()} onArchive={vi.fn()} onArchiveSelected={onArchiveSelected} onDerive={vi.fn()} onDeriveSelected={onDeriveSelected} onPermanentDelete={onPermanentDelete} onLoadMore={vi.fn()} />);
    fireEvent.contextMenu(screen.getByText("Active"));
    fireEvent.click(screen.getByRole("menuitem", { name: "派生所选到当前项目" }));
    expect(onDeriveSelected).toHaveBeenCalledWith([active, archived]);
    fireEvent.contextMenu(screen.getByText("Active"));
    fireEvent.click(screen.getByRole("menuitem", { name: "归档所选" }));
    expect(onArchiveSelected).toHaveBeenCalledWith([active]);
    fireEvent.contextMenu(screen.getByText("Archived"));
    expect(screen.queryByRole("menuitem", { name: "永久删除所选" })).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.contextMenu(screen.getByText("Active"));
    fireEvent.click(screen.getByRole("menuitem", { name: "复制所选会话 ID" }));
    expect(writeText).toHaveBeenCalledWith("active\narchived");
  });

  it("offers permanent deletion only when every selected session is archived", () => {
    const onPermanentDelete = vi.fn();
    const archived = { ...managedSession, key: "source-a:archived", threadId: "archived", title: "Archived", projectExists: true };
    render(<SessionManagerList sessions={[archived]} sources={[source]} selected={new Set([archived.key])} resumingKey={null} archivingKeys={new Set()} loading={false} loadingMore={false} error={null} hasMore={false} onToggleSelected={vi.fn()} onResume={vi.fn()} onArchive={vi.fn()} onDerive={vi.fn()} onPermanentDelete={onPermanentDelete} onLoadMore={vi.fn()} />);
    fireEvent.contextMenu(screen.getByText("Archived"));
    fireEvent.click(screen.getByRole("menuitem", { name: "永久删除" }));
    expect(onPermanentDelete).toHaveBeenCalledWith([archived]);
  });
});
