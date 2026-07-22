// @ts-nocheck -- Node types are intentionally not enabled for the frontend project.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("sidebar interaction styles", () => {
  it("distributes header icon buttons across the available sidebar width", () => {
    const sidebarCss = readFileSync(new URL("./sidebar.css", import.meta.url), "utf8");
    const headerRule = sidebarCss.match(/\.sidebar-header\s*\{([\s\S]*?)\n\}/);
    const titleRule = sidebarCss.match(/\.sidebar-header-title\s*\{([\s\S]*?)\n\}/);
    const titleGroupRule = sidebarCss.match(/\.sidebar-title-group\s*\{([\s\S]*?)\n\}/);
    const actionsRule = sidebarCss.match(/\.sidebar-header-actions\s*\{([\s\S]*?)\n\}/);

    expect(headerRule?.[1]).toContain("justify-content: space-between");
    expect(headerRule?.[1]).toContain("gap: 0");
    expect(headerRule?.[1]).toContain("width: 100%");
    expect(titleRule?.[1]).toContain("display: contents");
    expect(titleGroupRule?.[1]).toContain("display: contents");
    expect(actionsRule?.[1]).toContain("display: contents");
    expect(actionsRule?.[1]).not.toContain("margin-left: auto");
  });

  it("keeps the local Codex history pill from inheriting global button elevation", () => {
    const sidebarCss = readFileSync(new URL("./sidebar.css", import.meta.url), "utf8");
    const interactionRule = sidebarCss.match(
      /\.local-codex-history-header:hover,[\s\S]*?\.local-codex-history-header:active:not\(:disabled\)\s*\{([\s\S]*?)\n\}/,
    );

    expect(interactionRule).not.toBeNull();
    expect(interactionRule?.[1]).toContain("box-shadow:");
    expect(interactionRule?.[1]).toContain("!important");
    expect(interactionRule?.[1]).toContain("transform: none !important");
  });

  it("fills the session workspace and responds to its own content width", () => {
    const sidebarCss = readFileSync(new URL("./sidebar.css", import.meta.url), "utf8");
    const workspaceRule = sidebarCss.match(
      /\.session-manager-workspace\s*\{([\s\S]*?)\n\}/,
    );
    const containerRule = sidebarCss.match(
      /@container session-manager-workspace \(max-width: 760px\)\s*\{([\s\S]*?)\n\}/,
    );

    expect(workspaceRule?.[1]).toContain("container-name: session-manager-workspace");
    expect(workspaceRule?.[1]).toContain("container-type: inline-size");
    expect(workspaceRule?.[1]).not.toContain("grid-column: 1 / -1");
    expect(workspaceRule?.[1]).toContain("grid-row: 1 / -1");
    expect(workspaceRule?.[1]).toContain("width: auto");
    expect(workspaceRule?.[1]).toContain("height: 100%");
    expect(sidebarCss).not.toContain("width: min(980px, calc(100% - 48px))");
    expect(containerRule?.[1]).toContain(".session-manager-workspace-header");
  });

  it("uses the reserved right area as a selected-session information inspector", () => {
    const sidebarCss = readFileSync(new URL("./sidebar.css", import.meta.url), "utf8");
    const detailRule = sidebarCss.match(
      /\.session-manager-detail\.is-session\s*\{([\s\S]*?)\n\}/,
    );
    const inspectorRule = sidebarCss.match(
      /\.session-manager-detail-inspector\s*\{([\s\S]*?)\n\}/,
    );

    expect(detailRule?.[1]).toContain("grid-template-columns: minmax(0, 1fr) minmax(260px, 320px)");
    expect(inspectorRule?.[1]).toContain("border-left: 1px solid var(--border-subtle)");
  });

  it("keeps session rows flat and gives selected rows a stable accent surface", () => {
    const sidebarCss = readFileSync(new URL("./sidebar.css", import.meta.url), "utf8");
    const contentRule = sidebarCss.match(
      /\.session-manager-row-content\s*\{([\s\S]*?)\n\}/,
    );
    const selectedRule = sidebarCss.match(
      /\.session-manager-row\.is-selected\s*\{([\s\S]*?)\n\}/,
    );
    const selectedFocusedRule = sidebarCss.match(
      /\.session-manager-row\.is-selected\.is-focused\s*\{([\s\S]*?)\n\}/,
    );

    expect(contentRule?.[1]).toContain("padding: 0");
    expect(contentRule?.[1]).toContain("border-radius: 0");
    expect(selectedRule?.[1]).toContain("var(--border-accent) 16%");
    expect(selectedFocusedRule?.[1]).toContain("var(--border-accent) 20%");
  });

  it("keeps the session manager scrollbar stable without a compositor mask", () => {
    const sidebarCss = readFileSync(new URL("./sidebar.css", import.meta.url), "utf8");
    const managerScrollerRule = sidebarCss.match(
      /\.sidebar-body\.is-session-manager\s*\{([\s\S]*?)\n\}/,
    );

    expect(managerScrollerRule?.[1]).toContain("scrollbar-gutter: stable");
    expect(managerScrollerRule?.[1]).toContain("-webkit-mask-image: none");
    expect(managerScrollerRule?.[1]).toContain("mask-image: none");
  });

  it("shows complete selected-session message text without line clamping", () => {
    const sidebarCss = readFileSync(new URL("./sidebar.css", import.meta.url), "utf8");
    const messageRule = sidebarCss.match(
      /\.session-manager-preview-item p\s*\{([\s\S]*?)\n\}/,
    );

    expect(messageRule?.[1]).toContain("white-space: pre-wrap");
    expect(messageRule?.[1]).not.toContain("-webkit-line-clamp");
  });
});
