// @ts-nocheck -- Node types are intentionally not enabled for the frontend project.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("sidebar interaction styles", () => {
  it("uses a compact object-title header with grouped actions", () => {
    const sidebarCss = readFileSync(new URL("./sidebar.css", import.meta.url), "utf8");
    const headerRule = sidebarCss.match(/\.sidebar-header\s*\{([\s\S]*?)\n\}/);
    const titleRule = sidebarCss.match(/\.sidebar-header-title\s*\{([\s\S]*?)\n\}/);
    const titleGroupRule = sidebarCss.match(/\.sidebar-title-group\s*\{([\s\S]*?)\n\}/);
    const actionsRule = sidebarCss.match(/\.sidebar-header-actions\s*\{([\s\S]*?)\n\}/);

    expect(headerRule?.[1]).toContain("display: flex");
    expect(headerRule?.[1]).toContain("justify-content: flex-start");
    expect(headerRule?.[1]).toContain("gap: clamp(4px, calc((100% - 292px) / 4), 14px)");
    expect(headerRule?.[1]).toContain("width: 100%");
    expect(titleRule?.[1]).toContain("display: contents");
    expect(titleGroupRule?.[1]).toContain("display: contents");
    expect(actionsRule?.[1]).toContain("display: contents");
    expect(sidebarCss).toContain(".sidebar-object-title");
    expect(sidebarCss).toMatch(
      /\.sidebar-header-actions \.sidebar-search\s*\{[^}]*flex:\s*1 1 152px;[^}]*min-width:\s*118px;/s,
    );
    expect(sidebarCss).toMatch(
      /\.sidebar-header-actions \.sidebar-search-input\s*\{[^}]*height:\s*28px;[^}]*color:\s*var\(--sidebar-object-text\);[^}]*caret-color:\s*var\(--sidebar-object-text\);/s,
    );
    expect(sidebarCss).toMatch(
      /:root:not\(\[data-theme\]\) \.sidebar-header-actions \.sidebar-search-input,\s*:root\[data-theme="light"\] \.sidebar-header-actions \.sidebar-search-input\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--sidebar-object-bg-strong\) 92%, var\(--sidebar-object-bg\) 8%\);[^}]*color:\s*var\(--sidebar-object-text\);/s,
    );
  });

  it("keeps object-sidebar top actions and tablet rail icons visible on dark chrome", () => {
    const sidebarCss = readFileSync(new URL("./sidebar.css", import.meta.url), "utf8");
    const tabletCss = readFileSync(new URL("./compact-tablet.css", import.meta.url), "utf8");

    expect(sidebarCss).toMatch(
      /\.sidebar-title-add\s*\{[^}]*color:\s*var\(--sidebar-object-muted\);/s,
    );
    expect(sidebarCss).toMatch(
      /\.sidebar-home-toggle\s*\{[^}]*color:\s*var\(--sidebar-object-muted\);/s,
    );
    expect(sidebarCss).toMatch(
      /\.sidebar-sort-toggle\s*\{[^}]*color:\s*var\(--sidebar-object-muted\);/s,
    );
    expect(sidebarCss).toMatch(
      /\.sidebar-refresh-toggle\s*\{[^}]*color:\s*var\(--sidebar-object-muted\);/s,
    );
    expect(sidebarCss).toMatch(
      /\.sidebar-search-toggle\s*\{[^}]*color:\s*var\(--sidebar-object-muted\);/s,
    );
    expect(tabletCss).toMatch(
      /\.tablet-nav-item\s*\{[^}]*color:\s*#7d8992;/s,
    );
    expect(tabletCss).toMatch(
      /\.tablet-nav-item:hover:not\(:disabled\),\s*\.tablet-nav-item:focus-visible\s*\{[^}]*color:\s*#dfe5ea;[^}]*background:\s*rgba\(255, 255, 255, 0\.055\);/s,
    );
    expect(tabletCss).toMatch(
      /:root:not\(\[data-theme\]\) \.tablet-nav-account-popover,\s*:root\[data-theme="light"\] \.tablet-nav-account-popover\s*\{[^}]*--ds-popover-bg:\s*var\(--cm-light-panel-bg\);/s,
    );
    expect(tabletCss).toMatch(
      /\.app\.layout-tablet\s*\{[^}]*grid-template-columns:\s*var\(--tablet-nav-width,\s*52px\) var\(--tablet-sidebar-effective-width,\s*0px\) minmax\(0,\s*1fr\);/s,
    );
    expect(tabletCss).toMatch(
      /\.tablet-nav\s*\{[^}]*padding:\s*calc\(8px \+ var\(--macos-window-controls-safe-top, 0px\)\) 7px 10px;/s,
    );
    expect(tabletCss).toMatch(
      /\.app\.layout-tablet\.settings-surface-open\s*\{[^}]*grid-template-columns:\s*var\(--tablet-nav-width,\s*52px\) minmax\(0,\s*1fr\);/s,
    );
    expect(tabletCss).toMatch(
      /@media \(max-width: 900px\)[\s\S]*?\.app\.layout-tablet\.tablet-projects-open \.tablet-projects\s*\{[^}]*position:\s*absolute;[^}]*width:\s*min\(360px,\s*calc\(100vw - var\(--tablet-nav-width,\s*52px\) - 24px\)\);/s,
    );
    expect(sidebarCss).toMatch(
      /\.app\.layout-desktop\.sidebar-overlay-open \.sidebar\s*\{[^}]*position:\s*absolute;[^}]*left:\s*var\(--app-rail-width,\s*52px\);[^}]*width:\s*min\(/s,
    );
    expect(sidebarCss).toMatch(
      /\.app\.layout-desktop\.sidebar-overlay-open \.sidebar\s*\{[^}]*opacity:\s*1;[^}]*transform:\s*none;[^}]*pointer-events:\s*auto;/s,
    );
  });

  it("renders workspace sessions as a compact project tree without elevated row shadows", () => {
    const sidebarCss = readFileSync(new URL("./sidebar.css", import.meta.url), "utf8");
    const sidebarRule = sidebarCss.match(/\.sidebar\s*\{([\s\S]*?)\n\}/);
    const workspaceContentRule = sidebarCss.match(
      /\.workspace-card-content-inner\s*\{([\s\S]*?)\n\}/,
    );
    const workspaceTitleRule = sidebarCss.match(
      /\.workspace-title\s*\{([\s\S]*?)\n\}/,
    );
    const workspaceRowRule = sidebarCss.match(
      /\.workspace-row\s*\{([\s\S]*?)\n\}/,
    );
    const workspaceCountRule = sidebarCss.match(
      /\.workspace-thread-count\s*\{([\s\S]*?)\n\}/,
    );
    const threadListRule = sidebarCss.match(
      /\.thread-list\s*\{([\s\S]*?)\n\}/,
    );
    const workspaceHoverRule = sidebarCss.match(
      /\.workspace-row:hover::before\s*\{([\s\S]*?)\n\}/,
    );
    const threadHoverRule = sidebarCss.match(
      /(?:^|\n)\.thread-row:hover\s*\{([\s\S]*?)\n\}/,
    );
    const threadRowRule = sidebarCss.match(/(?:^|\n)\.thread-row\s*\{([\s\S]*?)\n\}/);

    expect(sidebarRule?.[1]).toContain("--sidebar-object-bg: #171b20");
    expect(sidebarRule?.[1]).toContain("--sidebar-object-active: #22282e");
    expect(workspaceContentRule?.[1]).toContain("margin-left: 0");
    expect(workspaceContentRule?.[1]).toContain("padding: 3px 8px");
    expect(workspaceContentRule?.[1]).toContain("border-left: 0");
    expect(sidebarCss).not.toContain(".app:not(.layout-phone) .sidebar .workspace-card-content-inner");
    expect(threadRowRule?.[1]).toContain("gap: 8px");
    expect(threadRowRule?.[1]).toContain(
      "padding: 7px 10px 7px calc(10px + var(--thread-indent, 0px))",
    );
    expect(threadRowRule?.[1]).toContain("min-height: 44px");
    expect(threadRowRule?.[1]).toContain("border-radius: 10px");
    expect(workspaceTitleRule?.[1]).toContain(
      "grid-template-columns: 18px 16px minmax(0, 1fr) auto",
    );
    expect(workspaceTitleRule?.[1]).toContain("gap: 4px");
    expect(workspaceRowRule?.[1]).toContain("align-items: center");
    expect(workspaceRowRule?.[1]).toContain("min-height: 38px");
    expect(workspaceRowRule?.[1]).toContain("padding: 4px 6px");
    expect(workspaceCountRule?.[1]).toContain("align-items: center");
    expect(workspaceCountRule?.[1]).toContain("justify-content: center");
    expect(workspaceCountRule?.[1]).toContain("height: 18px");
    expect(threadListRule?.[1]).toContain("gap: 2px");
    expect(sidebarCss).toMatch(
      /\.app:not\(\.layout-phone\) \.sidebar \.thread-row\s*\{[^}]*min-height:\s*34px;[^}]*padding-top:\s*3px;[^}]*padding-bottom:\s*3px;/s,
    );
    expect(workspaceHoverRule?.[1]).toContain("box-shadow: none");
    expect(threadHoverRule?.[1]).toContain("box-shadow: none");
    expect(sidebarCss).toContain(".workspace-thread-count");
  });

  it("keeps desktop/tablet project rows on themeable object-sidebar tokens", () => {
    const sidebarCss = readFileSync(new URL("./sidebar.css", import.meta.url), "utf8");

    expect(sidebarCss).toMatch(
      /:root:not\(\[data-theme\]\) \.sidebar,\s*:root\[data-theme="light"\] \.sidebar\s*\{[^}]*--sidebar-object-bg:\s*var\(--cm-light-chrome-bg\);[^}]*--sidebar-object-text:\s*var\(--cm-light-text-strong\);/s,
    );
    expect(sidebarCss).toMatch(
      /:root:not\(\[data-theme\]\) \.app:not\(\.layout-phone\) \.sidebar \.workspace-name,\s*:root\[data-theme="light"\] \.app:not\(\.layout-phone\) \.sidebar \.workspace-name\s*\{[^}]*color:\s*var\(--sidebar-object-text\);/s,
    );
    expect(sidebarCss).toMatch(
      /\.app:not\(\.layout-phone\) \.sidebar \.workspace-row\.active::before\s*\{[^}]*background:\s*var\(--sidebar-object-active\);[^}]*border-color:\s*var\(--sidebar-object-active-border\);/s,
    );
    expect(sidebarCss).toMatch(
      /\.app:not\(\.layout-phone\) \.sidebar \.workspace-row:not\(\.active\)::before\s*\{[^}]*background:\s*var\(--sidebar-object-hover\);[^}]*border-color:\s*var\(--sidebar-object-border\);[^}]*box-shadow:\s*none;/s,
    );
    expect(sidebarCss).toMatch(
      /\.app:not\(\.layout-phone\) \.sidebar \.workspace-thread-count\s*\{[^}]*background:\s*var\(--sidebar-object-control\);[^}]*color:\s*var\(--sidebar-object-muted\);/s,
    );
    expect(sidebarCss).toMatch(
      /\.app:not\(\.layout-phone\) \.sidebar \.workspace-row\.active \.workspace-thread-count\s*\{[^}]*background:\s*rgba\(255, 255, 255, 0\.055\);[^}]*color:\s*var\(--sidebar-object-text\);/s,
    );
  });

  it("keeps the conversation list on the sidebar theme surface without changing the tablet rail", () => {
    const sidebarCss = readFileSync(new URL("./sidebar.css", import.meta.url), "utf8");
    const sidebarBodyRule = sidebarCss.match(/\.sidebar-body\s*\{([\s\S]*?)\n\}/);

    expect(sidebarBodyRule?.[1]).toContain("background: var(--sidebar-object-bg)");
    expect(sidebarCss).not.toMatch(/\.sidebar-body\s*\{[^}]*var\(--cm-light-panel-bg\)/s);
    expect(sidebarCss).not.toMatch(
      /:root(?:[^{}]|\{[^}]*\})*\.tablet-nav[^{}]*\{[^}]*background:\s*var\(--cm-light-panel-bg\)/s,
    );
  });

  it("keeps desktop/tablet command-deck thread rows readable on the dark object sidebar", () => {
    const sidebarCss = readFileSync(new URL("./sidebar.css", import.meta.url), "utf8");

    expect(sidebarCss).toMatch(
      /\.app:not\(\.layout-phone\) \.sidebar \.thread-row\s*\{[^}]*min-height:\s*34px;[^}]*padding-top:\s*3px;[^}]*padding-bottom:\s*3px;[^}]*color:\s*var\(--sidebar-object-muted\);/s,
    );
    expect(sidebarCss).toMatch(
      /\.app:not\(\.layout-phone\) \.sidebar \.thread-row\.active\s*\{[^}]*background:\s*var\(--sidebar-object-active\);[^}]*color:\s*var\(--sidebar-object-text\);/s,
    );
    expect(sidebarCss).toMatch(
      /\.app:not\(\.layout-phone\) \.sidebar \.thread-row\.active\s*\{[^}]*box-shadow:\s*inset 3px 0 0 var\(--border-accent\);/s,
    );
    expect(sidebarCss).toMatch(
      /\.app:not\(\.layout-phone\) \.sidebar \.thread-row:hover \.thread-name,\s*\.app:not\(\.layout-phone\) \.sidebar \.thread-row\.active \.thread-name\s*\{[^}]*color:\s*var\(--sidebar-object-text\);/s,
    );
    expect(sidebarCss).toMatch(
      /\.thread-more\s*\{[^}]*color:\s*var\(--sidebar-object-muted\);/s,
    );
    expect(sidebarCss).toMatch(
      /\.thread-more:hover\s*\{[^}]*color:\s*var\(--sidebar-object-text\);/s,
    );
  });

  it("keeps desktop/tablet command-deck sidebar bottom controls dark and compact", () => {
    const sidebarCss = readFileSync(new URL("./sidebar.css", import.meta.url), "utf8");

    expect(sidebarCss).toMatch(
      /\.sidebar-usage-panel\s*\{[^}]*border:\s*1px solid var\(--sidebar-object-border\);[^}]*background:\s*var\(--sidebar-object-bg-strong\);/s,
    );
    expect(sidebarCss).toMatch(
      /\.sidebar-usage-selection-stack \.ds-rounded-select\s*\{[^}]*display:\s*block;[^}]*flex:\s*0 0 120px;[^}]*width:\s*120px;[^}]*min-width:\s*120px;[^}]*max-width:\s*120px;/s,
    );
    expect(sidebarCss).toMatch(
      /\.sidebar-usage-selection-stack \.sidebar-usage-select\s*\{[^}]*display:\s*flex;[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*max-width:\s*none;[^}]*border:\s*1px solid var\(--sidebar-object-border-strong\);[^}]*background:\s*var\(--sidebar-object-control\);/s,
    );
    expect(sidebarCss).toMatch(
      /\.sidebar-usage-select-value\s*\{[^}]*display:\s*flex;[^}]*width:\s*100%;[^}]*height:\s*30px;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s,
    );
    expect(sidebarCss).toMatch(
      /\.sidebar-usage-selection-stack\s*\{[^}]*grid-template-columns:\s*repeat\(2, 120px\);/s,
    );
    expect(sidebarCss).toMatch(
      /\.sidebar-usage-select-popover\s*\{[^}]*left:\s*auto;[^}]*right:\s*0;[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s,
    );
    expect(sidebarCss).not.toContain(".sidebar-theme-toggle");
    expect(sidebarCss).not.toContain(".sidebar-bottom-actions");
    expect(sidebarCss).not.toContain(".sidebar-account-menu");
    expect(sidebarCss).not.toContain(".sidebar-labeled-button");
    expect(sidebarCss).not.toContain(".sidebar-utility-actions");
    expect(sidebarCss).not.toContain(".sidebar-utility-button");
  });

  it("keeps workspace creation menus on the object-sidebar dark surface", () => {
    const sidebarCss = readFileSync(new URL("./sidebar.css", import.meta.url), "utf8");

    expect(sidebarCss).toMatch(
      /\.workspace-add-menu\s*\{[^}]*--ds-popover-bg:\s*var\(--sidebar-object-bg-strong,\s*#151a1f\);[^}]*background:\s*var\(--sidebar-object-bg-strong,\s*#151a1f\);/s,
    );
    expect(sidebarCss).toMatch(
      /\.workspace-add-menu \.ds-popover-item\s*\{[^}]*color:\s*var\(--sidebar-object-muted,\s*#a5b0b7\);/s,
    );
    expect(sidebarCss).toMatch(
      /\.workspace-add-option\s*\{[^}]*color:\s*var\(--sidebar-object-muted,\s*#a5b0b7\);[^}]*padding:\s*8px 9px;/s,
    );
    expect(sidebarCss).toMatch(
      /\.workspace-add-menu \.ds-popover-item:hover:not\(:disabled\),\s*\.workspace-add-menu \.ds-popover-item:focus-visible,\s*\.workspace-add-menu \.ds-popover-item\.is-active\s*\{[^}]*background:\s*var\(--sidebar-object-hover,\s*rgba\(255, 255, 255, 0\.045\)\);/s,
    );
  });

  it("keeps pinned and active thread times visible in the sidebar meta lane", () => {
    const sidebarCss = readFileSync(new URL("./sidebar.css", import.meta.url), "utf8");
    const metaRule = sidebarCss.match(/\.thread-meta\s*\{([\s\S]*?)\n\}/);

    expect(metaRule?.[1]).toContain("grid-template-columns: 22px 20px");
    expect(metaRule?.[1]).toContain("gap: 2px");
    expect(metaRule?.[1]).toContain("width: 44px");
    expect(sidebarCss).toMatch(
      /\.thread-meta\.has-subagent-toggle\s*\{[^}]*grid-template-columns:\s*22px 40px;[^}]*width:\s*64px;/s,
    );
    expect(sidebarCss).toMatch(
      /\.thread-pin-button\s*\{[^}]*grid-column:\s*1;/s,
    );
    expect(sidebarCss).toMatch(
      /\.thread-time,\s*\.thread-subagent-time-toggle\s*\{[^}]*grid-column:\s*2;[^}]*justify-self:\s*end;/s,
    );
    expect(sidebarCss).toMatch(
      /\.app:not\(\.layout-phone\) \.sidebar \.thread-time,\s*\.app:not\(\.layout-phone\) \.sidebar \.thread-subagent-time-label\s*\{[^}]*color:\s*var\(--sidebar-object-muted\);[^}]*opacity:\s*1;/s,
    );
    expect(sidebarCss).toMatch(
      /\.app:not\(\.layout-phone\) \.sidebar \.thread-row\.active \.thread-time/s,
    );
    expect(sidebarCss).toMatch(
      /\.app:not\(\.layout-phone\) \.sidebar \.thread-pin-button\.is-pinned\s*\{[^}]*color:\s*var\(--sidebar-object-muted\);/s,
    );
    expect(sidebarCss).toMatch(
      /\.workspace-actions\s*\{[^}]*opacity:\s*0\.7;[^}]*pointer-events:\s*auto;/s,
    );
    expect(sidebarCss).toMatch(
      /\.workspace-add\s*\{[^}]*color:\s*var\(--sidebar-object-muted\);[^}]*opacity:\s*0\.82;/s,
    );
    expect(sidebarCss).toMatch(
      /\.workspace-add-direct,\s*\.workspace-more\s*\{[^}]*color:\s*var\(--sidebar-object-muted\);[^}]*opacity:\s*0\.86;/s,
    );
    expect(sidebarCss).toMatch(
      /\.thread-pin-button\s*\{[^}]*color:\s*var\(--sidebar-object-muted\);[^}]*opacity:\s*0\.76;/s,
    );
    expect(sidebarCss).toMatch(
      /\.thread-row:hover \.thread-pin-button,\s*\.thread-row\.active \.thread-pin-button,\s*\.thread-pin-button:focus-visible,\s*\.thread-pin-button\.is-pinned\s*\{[^}]*opacity:\s*1;/s,
    );
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
    expect(workspaceRule?.[1]).toContain("max-width: 100%");
    expect(workspaceRule?.[1]).toContain("height: 100%");
    expect(sidebarCss).not.toContain("width: min(980px, calc(100% - 48px))");
    expect(containerRule?.[1]).toContain(".session-manager-workspace-header");
  });

  it("keeps the session workspace summary clear of Windows caption controls", () => {
    const sidebarCss = readFileSync(new URL("./sidebar.css", import.meta.url), "utf8");
    const summaryRule = sidebarCss.match(
      /\.session-manager-workspace-summary\s*\{([\s\S]*?)\n\}/,
    );

    expect(summaryRule?.[1]).toContain("var(--window-caption-width, 0px)");
    expect(summaryRule?.[1]).toContain("var(--window-caption-gap, 0px)");
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
    expect(selectedRule?.[1]).toContain("var(--border-accent) 46%");
    expect(selectedRule?.[1]).toContain("background: var(--surface-active)");
    expect(selectedFocusedRule?.[1]).toContain("var(--border-accent) 56%");
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
