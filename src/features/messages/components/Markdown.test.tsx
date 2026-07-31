// @vitest-environment jsdom
import { cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectOpenedFileTarget } from "../test/fileLinkAssertions";
import { Markdown } from "./Markdown";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));

describe("Markdown file-like href behavior", () => {
  afterEach(() => {
    cleanup();
  });

  it("prevents file-like href navigation when no file opener is provided", () => {
    render(
      <Markdown
        value="See [setup](./docs/setup.md)"
        className="markdown"
      />,
    );

    const link = screen.getByText("setup").closest("a");
    expect(link?.getAttribute("href")).toBe("./docs/setup.md");

    const clickEvent = createEvent.click(link as Element, {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(link as Element, clickEvent);
    expect(clickEvent.defaultPrevented).toBe(true);
  });

  it("intercepts file-like href clicks when a file opener is provided", () => {
    const onOpenFileLink = vi.fn();
    render(
      <Markdown
        value="See [setup](./docs/setup.md)"
        className="markdown"
        onOpenFileLink={onOpenFileLink}
      />,
    );

    const link = screen.getByText("setup").closest("a");
    expect(link?.getAttribute("href")).toBe("./docs/setup.md");

    const clickEvent = createEvent.click(link as Element, {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(link as Element, clickEvent);
    expect(clickEvent.defaultPrevented).toBe(true);
    expectOpenedFileTarget(onOpenFileLink, "./docs/setup.md");
  });

  it("prevents bare relative link navigation without treating it as a file", () => {
    const onOpenFileLink = vi.fn();
    render(
      <Markdown
        value="See [setup](docs/setup.md)"
        className="markdown"
        onOpenFileLink={onOpenFileLink}
      />,
    );

    const link = screen.getByText("setup").closest("a");
    expect(link?.getAttribute("href")).toBe("docs/setup.md");
    const clickEvent = createEvent.click(link as Element, {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(link as Element, clickEvent);
    expect(clickEvent.defaultPrevented).toBe(true);
    expect(onOpenFileLink).not.toHaveBeenCalled();
  });

  it("still intercepts explicit workspace file hrefs when a file opener is provided", () => {
    const onOpenFileLink = vi.fn();
    render(
      <Markdown
        value="See [example](/workspace/src/example.ts)"
        className="markdown"
        onOpenFileLink={onOpenFileLink}
      />,
    );

    const link = screen.getByText("example").closest("a");
    expect(link?.getAttribute("href")).toBe("/workspace/src/example.ts");

    const clickEvent = createEvent.click(link as Element, {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(link as Element, clickEvent);
    expect(clickEvent.defaultPrevented).toBe(true);
    expectOpenedFileTarget(onOpenFileLink, "/workspace/src/example.ts");
  });

  it("still intercepts dotless workspace file hrefs when a file opener is provided", () => {
    const onOpenFileLink = vi.fn();
    render(
      <Markdown
        value="See [license](/workspace/ThreadFleet/LICENSE)"
        className="markdown"
        workspacePath="/Users/sotiriskaniras/Documents/Development/Forks/ThreadFleet"
        onOpenFileLink={onOpenFileLink}
      />,
    );

    const link = screen.getByText("license").closest("a");
    expect(link?.getAttribute("href")).toBe("/workspace/ThreadFleet/LICENSE");

    const clickEvent = createEvent.click(link as Element, {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(link as Element, clickEvent);
    expect(clickEvent.defaultPrevented).toBe(true);
    expectOpenedFileTarget(onOpenFileLink, "/workspace/ThreadFleet/LICENSE");
  });

  it("intercepts mounted workspace links outside the old root allowlist", () => {
    const onOpenFileLink = vi.fn();
    render(
      <Markdown
        value="See [workflows](/workspace/.github/workflows)"
        className="markdown"
        workspacePath="/Users/sotiriskaniras/Documents/Development/Forks/ThreadFleet"
        onOpenFileLink={onOpenFileLink}
      />,
    );

    const link = screen.getByText("workflows").closest("a");
    expect(link?.getAttribute("href")).toBe("/workspace/.github/workflows");

    const clickEvent = createEvent.click(link as Element, {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(link as Element, clickEvent);
    expect(clickEvent.defaultPrevented).toBe(true);
    expectOpenedFileTarget(onOpenFileLink, "/workspace/.github/workflows");
  });

  it("intercepts mounted workspace directory links that resolve relative to the workspace", () => {
    const onOpenFileLink = vi.fn();
    render(
      <Markdown
        value="See [assets](/workspace/dist/assets)"
        className="markdown"
        workspacePath="/Users/sotiriskaniras/Documents/Development/Forks/ThreadFleet"
        onOpenFileLink={onOpenFileLink}
      />,
    );

    const link = screen.getByText("assets").closest("a");
    expect(link?.getAttribute("href")).toBe("/workspace/dist/assets");

    const clickEvent = createEvent.click(link as Element, {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(link as Element, clickEvent);
    expect(clickEvent.defaultPrevented).toBe(true);
    expectOpenedFileTarget(onOpenFileLink, "/workspace/dist/assets");
  });

  it("keeps exact workspace routes as normal markdown links", () => {
    const onOpenFileLink = vi.fn();
    render(
      <Markdown
        value="See [reviews](/workspace/reviews)"
        className="markdown"
        workspacePath="/Users/sotiriskaniras/Documents/Development/Forks/ThreadFleet"
        onOpenFileLink={onOpenFileLink}
      />,
    );

    const link = screen.getByText("reviews").closest("a");
    expect(link?.getAttribute("href")).toBe("/workspace/reviews");

    const clickEvent = createEvent.click(link as Element, {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(link as Element, clickEvent);
    expect(clickEvent.defaultPrevented).toBe(true);
    expect(onOpenFileLink).not.toHaveBeenCalled();
  });

  it("keeps nested workspace reviews routes local even when the workspace basename matches", () => {
    const onOpenFileLink = vi.fn();
    render(
      <Markdown
        value="See [overview](/workspace/reviews/overview)"
        className="markdown"
        workspacePath="/Users/sotiriskaniras/Documents/Development/Forks/reviews"
        onOpenFileLink={onOpenFileLink}
      />,
    );

    const link = screen.getByText("overview").closest("a");
    expect(link?.getAttribute("href")).toBe("/workspace/reviews/overview");

    const clickEvent = createEvent.click(link as Element, {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(link as Element, clickEvent);
    expect(clickEvent.defaultPrevented).toBe(true);
    expect(onOpenFileLink).not.toHaveBeenCalled();
  });

  it("keeps nested workspaces routes as normal markdown links", () => {
    const onOpenFileLink = vi.fn();
    render(
      <Markdown
        value="See [overview](/workspaces/team/reviews/overview)"
        className="markdown"
        workspacePath="/Users/sotiriskaniras/Documents/Development/Forks/ThreadFleet"
        onOpenFileLink={onOpenFileLink}
      />,
    );

    const link = screen.getByText("overview").closest("a");
    expect(link?.getAttribute("href")).toBe("/workspaces/team/reviews/overview");

    const clickEvent = createEvent.click(link as Element, {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(link as Element, clickEvent);
    expect(clickEvent.defaultPrevented).toBe(true);
    expect(onOpenFileLink).not.toHaveBeenCalled();
  });

  it("keeps nested reviews routes local even when the workspace basename matches the route segment", () => {
    const onOpenFileLink = vi.fn();
    render(
      <Markdown
        value="See [overview](/workspaces/team/reviews/overview)"
        className="markdown"
        workspacePath="/Users/sotiriskaniras/Documents/Development/Forks/reviews"
        onOpenFileLink={onOpenFileLink}
      />,
    );

    const link = screen.getByText("overview").closest("a");
    expect(link?.getAttribute("href")).toBe("/workspaces/team/reviews/overview");

    const clickEvent = createEvent.click(link as Element, {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(link as Element, clickEvent);
    expect(clickEvent.defaultPrevented).toBe(true);
    expect(onOpenFileLink).not.toHaveBeenCalled();
  });

  it("still intercepts nested workspace file hrefs when a file opener is provided", () => {
    const onOpenFileLink = vi.fn();
    render(
      <Markdown
        value="See [src](/workspaces/team/ThreadFleet/src)"
        className="markdown"
        workspacePath="/Users/sotiriskaniras/Documents/Development/Forks/ThreadFleet"
        onOpenFileLink={onOpenFileLink}
      />,
    );

    const link = screen.getByText("src").closest("a");
    expect(link?.getAttribute("href")).toBe("/workspaces/team/ThreadFleet/src");

    const clickEvent = createEvent.click(link as Element, {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(link as Element, clickEvent);
    expect(clickEvent.defaultPrevented).toBe(true);
    expectOpenedFileTarget(onOpenFileLink, "/workspaces/team/ThreadFleet/src");
  });

  it("treats extensionless paths under /workspace/settings as files", () => {
    const onOpenFileLink = vi.fn();
    render(
      <Markdown
        value="See [license](/workspace/settings/LICENSE)"
        className="markdown"
        workspacePath="/Users/sotiriskaniras/Documents/Development/Forks/settings"
        onOpenFileLink={onOpenFileLink}
      />,
    );

    const link = screen.getByText("license").closest("a");
    expect(link?.getAttribute("href")).toBe("/workspace/settings/LICENSE");

    const clickEvent = createEvent.click(link as Element, {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(link as Element, clickEvent);
    expect(clickEvent.defaultPrevented).toBe(true);
    expectOpenedFileTarget(onOpenFileLink, "/workspace/settings/LICENSE");
  });

  it("intercepts file hrefs that use #L line anchors", () => {
    const onOpenFileLink = vi.fn();
    render(
      <Markdown
        value="See [markdown](./docs/setup.md#L12)"
        className="markdown"
        onOpenFileLink={onOpenFileLink}
      />,
    );

    const link = screen.getByText("markdown").closest("a");
    expect(link?.getAttribute("href")).toBe("./docs/setup.md#L12");

    const clickEvent = createEvent.click(link as Element, {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(link as Element, clickEvent);
    expect(clickEvent.defaultPrevented).toBe(true);
    expectOpenedFileTarget(onOpenFileLink, "./docs/setup.md", 12);
  });

  it("intercepts Windows absolute file hrefs with #L anchors and preserves the tooltip", () => {
    const onOpenFileLink = vi.fn();
    const onOpenFileLinkMenu = vi.fn();
    const linkedPath =
      "I:\\gpt-projects\\ThreadFleet\\src\\features\\settings\\components\\sections\\SettingsDisplaySection.tsx#L422";
    render(
      <Markdown
        value={`See [SettingsDisplaySection.tsx](${linkedPath})`}
        className="markdown"
        onOpenFileLink={onOpenFileLink}
        onOpenFileLinkMenu={onOpenFileLinkMenu}
      />,
    );

    const link = screen.getByText("SettingsDisplaySection.tsx").closest("a");
    expect(link?.getAttribute("href")).toBe(
      "I:%5Cgpt-projects%5CThreadFleet%5Csrc%5Cfeatures%5Csettings%5Ccomponents%5Csections%5CSettingsDisplaySection.tsx#L422",
    );
    expect(link?.getAttribute("title")).toBe(
      "I:\\gpt-projects\\ThreadFleet\\src\\features\\settings\\components\\sections\\SettingsDisplaySection.tsx:422",
    );

    const clickEvent = createEvent.click(link as Element, {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(link as Element, clickEvent);
    expect(clickEvent.defaultPrevented).toBe(true);
    expectOpenedFileTarget(
      onOpenFileLink,
      "I:\\gpt-projects\\ThreadFleet\\src\\features\\settings\\components\\sections\\SettingsDisplaySection.tsx",
      422,
    );

    fireEvent.contextMenu(link as Element);
    expect(onOpenFileLinkMenu).toHaveBeenCalledWith(
      expect.anything(),
      {
        path: "I:\\gpt-projects\\ThreadFleet\\src\\features\\settings\\components\\sections\\SettingsDisplaySection.tsx",
        line: 422,
        column: null,
      },
    );
  });

  it("prevents unsupported route fragments without treating them as file links", () => {
    const onOpenFileLink = vi.fn();
    render(
      <Markdown
        value="See [profile](/workspace/settings/profile#details)"
        className="markdown"
        onOpenFileLink={onOpenFileLink}
      />,
    );

    const link = screen.getByText("profile").closest("a");
    expect(link?.getAttribute("href")).toBe("/workspace/settings/profile#details");

    const clickEvent = createEvent.click(link as Element, {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(link as Element, clickEvent);
    expect(clickEvent.defaultPrevented).toBe(true);
    expect(onOpenFileLink).not.toHaveBeenCalled();
  });

  it("keeps workspace settings #L anchors as local routes", () => {
    const onOpenFileLink = vi.fn();
    render(
      <Markdown
        value="See [settings](/workspace/settings#L12)"
        className="markdown"
        workspacePath="/Users/sotiriskaniras/Documents/Development/Forks/ThreadFleet"
        onOpenFileLink={onOpenFileLink}
      />,
    );

    const link = screen.getByText("settings").closest("a");
    expect(link?.getAttribute("href")).toBe("/workspace/settings#L12");

    const clickEvent = createEvent.click(link as Element, {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(link as Element, clickEvent);
    expect(clickEvent.defaultPrevented).toBe(true);
    expect(onOpenFileLink).not.toHaveBeenCalled();
  });

  it("keeps workspace reviews #L anchors as local routes", () => {
    const onOpenFileLink = vi.fn();
    render(
      <Markdown
        value="See [reviews](/workspace/reviews#L9)"
        className="markdown"
        workspacePath="/Users/sotiriskaniras/Documents/Development/Forks/ThreadFleet"
        onOpenFileLink={onOpenFileLink}
      />,
    );

    const link = screen.getByText("reviews").closest("a");
    expect(link?.getAttribute("href")).toBe("/workspace/reviews#L9");

    const clickEvent = createEvent.click(link as Element, {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(link as Element, clickEvent);
    expect(clickEvent.defaultPrevented).toBe(true);
    expect(onOpenFileLink).not.toHaveBeenCalled();
  });

  it("does not linkify workspace settings #L anchors in plain text", () => {
    const { container } = render(
      <Markdown
        value="See /workspace/settings#L12 for app settings."
        className="markdown"
        workspacePath="/Users/sotiriskaniras/Documents/Development/Forks/ThreadFleet"
      />,
    );

    expect(container.querySelector(".message-file-link")).toBeNull();
    expect(container.textContent).toContain("/workspace/settings#L12");
  });

  it("does not linkify Windows file paths embedded in custom URIs", () => {
    const { container } = render(
      <Markdown
        value="Open vscode://file/C:/repo/src/App.tsx:12 in VS Code."
        className="markdown"
      />,
    );

    expect(container.querySelector(".message-file-link")).toBeNull();
    expect(container.textContent).toContain("vscode://file/C:/repo/src/App.tsx:12");
  });

  it("does not turn workspace review #L anchors in inline code into file links", () => {
    const { container } = render(
      <Markdown
        value="Use `/workspace/reviews#L9` to reference the reviews route."
        className="markdown"
        workspacePath="/Users/sotiriskaniras/Documents/Development/Forks/ThreadFleet"
      />,
    );

    expect(container.querySelector(".message-file-link")).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe("/workspace/reviews#L9");
  });

  it("keeps dollar-prefixed placeholders as selectable inline code", () => {
    const { container } = render(
      <Markdown value="提示“建议插入 `$xxx`”。" className="markdown" />,
    );

    const code = container.querySelector("code");
    expect(code?.textContent).toBe("$xxx");
    expect(container.querySelector(".message-file-link")).toBeNull();
  });

  it("still opens mounted file links when the workspace basename is settings", () => {
    const onOpenFileLink = vi.fn();
    render(
      <Markdown
        value="See [app](/workspace/settings/src/App.tsx)"
        className="markdown"
        onOpenFileLink={onOpenFileLink}
      />,
    );

    const link = screen.getByText("app").closest("a");
    expect(link?.getAttribute("href")).toBe("/workspace/settings/src/App.tsx");

    const clickEvent = createEvent.click(link as Element, {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(link as Element, clickEvent);
    expect(clickEvent.defaultPrevented).toBe(true);
    expectOpenedFileTarget(onOpenFileLink, "/workspace/settings/src/App.tsx");
  });

  it("keeps nested settings routes local when the workspace basename is settings", () => {
    const onOpenFileLink = vi.fn();
    render(
      <Markdown
        value="See [profile](/workspace/settings/profile)"
        className="markdown"
        workspacePath="/Users/sotiriskaniras/Documents/Development/Forks/settings"
        onOpenFileLink={onOpenFileLink}
      />,
    );

    const link = screen.getByText("profile").closest("a");
    expect(link?.getAttribute("href")).toBe("/workspace/settings/profile");

    const clickEvent = createEvent.click(link as Element, {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(link as Element, clickEvent);
    expect(clickEvent.defaultPrevented).toBe(true);
    expect(onOpenFileLink).not.toHaveBeenCalled();
  });

  it("converts blank-line-separated structured review findings into one markdown table", () => {
    const { container } = render(
      <Markdown
        value={[
          "src/features/app/hooks/useMainAppLayoutSurfaces.ts | category=clarity | Layout assembly is still too broad. | Split surface assembly by domain. | high",
          "",
          "src/features/app/components/SidebarWorkspaceGroups.tsx | category=clarity | Workspace derivation still lives in the render component. | Move derivation into a focused hook. | high",
          "",
          "src/features/threads/hooks/threadMessagingHelpers.ts | category=clarity | Helper responsibilities are too broad. | Split helpers by concern. | medium",
        ].join("\n")}
        className="markdown"
      />,
    );

    expect(container.querySelector(".markdown-table-wrap")).toBeTruthy();
    expect(container.querySelector(".markdown-table-structured-review")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "File" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Recommendation" })).toBeTruthy();
    expect(screen.getAllByText("clarity")).toHaveLength(3);
    expect(container.querySelectorAll(".markdown-table").length).toBe(1);
    expect(container.querySelectorAll("tbody tr").length).toBe(3);
    expect(screen.getAllByText("high")).toHaveLength(2);
    expect(screen.getByText("Split helpers by concern.")).toBeTruthy();
    expect(
      screen
        .getByRole("columnheader", { name: "Category" })
        .classList.contains("markdown-table-cell-center"),
    ).toBe(true);
    expect(
      screen
        .getByRole("columnheader", { name: "Severity" })
        .classList.contains("markdown-table-cell-center"),
    ).toBe(true);
  });

  it("wraps standard gfm tables in the styled table container", () => {
    const { container } = render(
      <Markdown
        value={["| Name | Value |", "| --- | --- |", "| Status | Ready |"].join("\n")}
        className="markdown"
      />,
    );

    expect(container.querySelector(".markdown-table-wrap")).toBeTruthy();
    expect(container.querySelector(".markdown-table")).toBeTruthy();
    expect(container.querySelector(".markdown-table-structured-review")).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
  });

  it("aligns numeric and status columns by content semantics", () => {
    render(
      <Markdown
        value={[
          "| Name | Count | Percent | Status | Description |",
          "| --- | --- | --- | --- | --- |",
          "| Alpha | 42 | 37.5% | Ready | Long text stays readable. |",
          "| Beta | 1,024 | 100% | Blocked | Another description. |",
        ].join("\n")}
        className="markdown"
      />,
    );

    expect(
      screen
        .getByRole("columnheader", { name: "Count" })
        .classList.contains("markdown-table-cell-numeric"),
    ).toBe(true);
    expect(screen.getByText("1,024").classList.contains("markdown-table-cell-numeric")).toBe(
      true,
    );
    expect(
      screen
        .getByRole("columnheader", { name: "Status" })
        .classList.contains("markdown-table-cell-center"),
    ).toBe(true);
    expect(screen.getByText("Blocked").classList.contains("markdown-table-cell-center")).toBe(
      true,
    );
    const description = screen.getByText("Long text stays readable.");
    expect(description.classList.contains("markdown-table-cell-center")).toBe(false);
    expect(description.classList.contains("markdown-table-cell-numeric")).toBe(false);
  });

  it("preserves table scroll position across markdown rerenders", () => {
    const value = ["| Name | Value |", "| --- | --- |", "| Status | Ready |"].join("\n");
    const { container, rerender } = render(<Markdown value={value} className="markdown" />);
    const tableWrap = container.querySelector<HTMLElement>(".markdown-table-wrap");

    expect(tableWrap).not.toBeNull();
    if (!tableWrap) {
      throw new Error("Expected markdown table wrapper");
    }
    tableWrap.scrollLeft = 240;

    rerender(<Markdown value={value} className="markdown" />);

    const rerenderedTableWrap = container.querySelector<HTMLElement>(".markdown-table-wrap");
    expect(rerenderedTableWrap).toBe(tableWrap);
    expect(rerenderedTableWrap?.scrollLeft).toBe(240);

    rerender(<Markdown value={value} className="markdown updated" />);
    expect(container.querySelector(".markdown-table-wrap")).toBe(tableWrap);
    expect(tableWrap.scrollLeft).toBe(240);

    rerender(<Markdown value={value.replace("Ready", "Updated")} className="markdown updated" />);
    expect(container.querySelector(".markdown-table-wrap")).toBe(tableWrap);
    expect(tableWrap.scrollLeft).toBe(240);
    expect(screen.getByText("Updated")).toBeTruthy();
  });

  it("converts Windows absolute Markdown image paths to Tauri asset URLs", () => {
    const rawPath = "/D:/Project/CodexMonitor/.codex-monitor/preview.png";
    const { container } = render(
      <Markdown value={`![preview](${rawPath})`} className="markdown" />,
    );

    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "asset://localhost/D%3A%2FProject%2FCodexMonitor%2F.codex-monitor%2Fpreview.png",
    );
  });

  it("preserves message code block scroll position across markdown rerenders", () => {
    const value = [
      "```text",
      "D:/DevKnowledgeBase/20-项目知识/ThreadFleet/BUG/ThreadFleet-Markdown表格横向滚动位置被重置.md",
      "Use diagnose and ui-regression-guardian to verify the visible code block scroll state.",
      "```",
    ].join("\n");
    const renderMarkdown = (onOpenThreadLink?: (threadId: string) => void) => (
      <Markdown
        value={value}
        className="markdown"
        codeBlockStyle="message"
        onOpenThreadLink={onOpenThreadLink}
      />
    );
    const { container, rerender } = render(renderMarkdown());
    const codeBlockScroller = container.querySelector<HTMLElement>(".markdown-codeblock pre");

    expect(codeBlockScroller).not.toBeNull();
    if (!codeBlockScroller) {
      throw new Error("Expected markdown code block scroller");
    }
    codeBlockScroller.scrollLeft = 240;

    rerender(renderMarkdown(() => {}));

    expect(container.querySelector(".markdown-codeblock pre")).toBe(codeBlockScroller);
    expect(codeBlockScroller.scrollLeft).toBe(240);
  });

  it("copies code block content without markdown fences by default", async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <Markdown
        value={["```text", "Build Installers", "event: push", "success", "```"].join("\n")}
        className="markdown"
        codeBlockStyle="message"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy code block" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("Build Installers\nevent: push\nsuccess");
    });
  });

  it("keeps a mouse selection that starts in a code block inside that block", () => {
    const { container } = render(
      <Markdown
        value={["Before", "```text", "alpha beta", "gamma", "```", "After"].join("\n")}
        className="markdown"
        codeBlockStyle="message"
      />,
    );

    const code = container.querySelector<HTMLElement>(".markdown-codeblock code");
    const after = screen.getByText("After");
    const codeText = code?.firstChild;
    const afterText = after.firstChild;
    if (!code || !(codeText instanceof Text) || !(afterText instanceof Text)) {
      throw new Error("Expected code block and adjacent text nodes");
    }

    fireEvent.mouseDown(code, { button: 0 });
    const range = document.createRange();
    range.setStart(codeText, 6);
    range.setEnd(afterText, 5);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.mouseUp(window);

    expect(selection?.toString()).toBe("beta\ngamma");
    selection?.removeAllRanges();
  });

  it("keeps a single-line fenced code selection inside its block", () => {
    const { container } = render(
      <Markdown
        value={["Before", "```text", "alpha beta", "```", "After"].join("\n")}
        className="markdown"
        codeBlockStyle="message"
      />,
    );

    const code = container.querySelector<HTMLElement>(".markdown-codeblock-single code");
    const after = screen.getByText("After");
    const codeText = code?.firstChild;
    const afterText = after.firstChild;
    if (!code || !(codeText instanceof Text) || !(afterText instanceof Text)) {
      throw new Error("Expected single-line code block and adjacent text nodes");
    }

    fireEvent.mouseDown(code, { button: 0 });
    const range = document.createRange();
    range.setStart(codeText, 6);
    range.setEnd(afterText, 5);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.mouseUp(window);

    expect(selection?.toString()).toBe("beta");
    selection?.removeAllRanges();
  });

  it("copies code block markdown fences with Ctrl when modifier copy is enabled", async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <Markdown
        value={["```text", "Build Installers", "event: push", "success", "```"].join("\n")}
        className="markdown"
        codeBlockStyle="message"
        codeBlockCopyUseModifier
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy code block" }), {
      ctrlKey: true,
    });

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "```text\nBuild Installers\nevent: push\nsuccess\n```",
      );
    });
  });

});
