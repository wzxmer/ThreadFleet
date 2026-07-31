// @ts-nocheck -- Node types are intentionally not enabled for the frontend project.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("main topbar layout styles", () => {
  const mainCss = readFileSync(new URL("./main.css", import.meta.url), "utf8");

  it("constrains the desktop grid surface so docked rows remain in the viewport", () => {
    const mainRule = mainCss.match(/\.main\s*\{([\s\S]*?)\n\}/);

    expect(mainRule?.[1]).toContain("height: 100%");
    expect(mainRule?.[1]).toContain("min-height: 0");
  });

  it("releases the reserved inspector column when the right panel is collapsed", () => {
    expect(mainCss).toMatch(
      /\.app\.right-panel-collapsed \.main\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) 0;/s,
    );
  });

  it("lets the desktop sessions empty state span the reserved right-panel column", () => {
    expect(mainCss).toMatch(
      /\.desktop-empty-session-surface\s*\{[^}]*grid-column:\s*1 \/ -1;[^}]*grid-row:\s*1 \/ -1;/s,
    );
    expect(mainCss).toMatch(
      /\.app\.layout-desktop\.sidebar-overlay-open \.desktop-empty-session-surface\s*\{[^}]*padding-left:\s*min\(/s,
    );
  });

  it("reserves Windows caption controls in every compact layout", () => {
    const compactTopbarRule = mainCss.match(
      /\.app\.layout-compact \.main-topbar\s*\{([\s\S]*?)\n\}/,
    );

    expect(compactTopbarRule?.[1]).toContain("--window-caption-width");
    expect(compactTopbarRule?.[1]).toContain("--window-caption-gap");
    expect(mainCss).not.toContain(
      ".app.layout-compact.right-panel-collapsed .main-topbar",
    );
  });

  it("keeps the conversation column readable and uses a compact context-only header", () => {
    expect(mainCss).toContain("--conversation-column-width: clamp(1040px, 88vw, 1360px);");
    expect(mainCss).toMatch(
      /\.chat-pane\s*\{[^}]*--conversation-reading-width:\s*var\(--conversation-column-width\);/s,
    );
    expect(mainCss).toContain("--main-topbar-height: 64px;");
    expect(mainCss).toMatch(
      /\.app\.layout-desktop,\s*\.app\.layout-tablet\s*\{[^}]*--main-topbar-height:\s*64px;/s,
    );
    expect(mainCss).toMatch(
      /\.main-topbar\s*\{[^}]*padding:\s*6px var\(--main-panel-padding\);/s,
    );
    expect(mainCss).toMatch(
      /\.main-topbar\s*\{[^}]*container-name:\s*main-topbar;/s,
    );
    expect(mainCss).toMatch(
      /\.workspace-context-chips\s*\{[^}]*display:\s*flex;[^}]*overflow:\s*hidden;/s,
    );
    expect(mainCss).toMatch(
      /@media \(max-width: 1250px\)[\s\S]*?\.workspace-context-chip-project\s*\{[^}]*display:\s*none;/,
    );
    expect(mainCss).not.toContain(".session-header-title");
    expect(mainCss).not.toContain(".workspace-title-line");
    expect(mainCss).not.toMatch(/\.workspace-title\s*\{/);
  });

  it("lets topbar action groups shrink instead of overlapping the workspace context", () => {
    expect(mainCss).toMatch(
      /\.main-header\s*\{[^}]*overflow:\s*hidden;/s,
    );
    expect(mainCss).toMatch(
      /\.main-header-actions\s*\{[^}]*flex:\s*0 1 auto;[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s,
    );
    expect(mainCss).toMatch(
      /\.main-header-message-tools,\s*\.main-header-composer-tools\s*\{[^}]*flex:\s*0 1 auto;[^}]*overflow:\s*hidden;/s,
    );
    expect(mainCss).toMatch(
      /@container main-topbar \(max-width: 1040px\)[\s\S]*?\.workspace-context-chip-project\s*\{[^}]*display:\s*none;/,
    );
    expect(mainCss).toMatch(
      /@container main-topbar \(max-width: 900px\)[\s\S]*?\.workspace-branch-button,\s*\.workspace-branch-static-button\s*\{[^}]*max-width:\s*120px;/,
    );
  });

  it("keeps right top menu colors owned by header tokens", () => {
    expect(mainCss).toMatch(
      /\.main-header\s*\{[^}]*--main-header-action-bg:\s*var\(--surface-card-strong\)/s,
    );
    expect(mainCss).toMatch(
      /\.main-header-message-tools,\s*\.main-header-composer-tools\s*\{[^}]*display:\s*inline-flex;/s,
    );
    expect(mainCss).toMatch(
      /\.main-header-action\s*\{[^}]*background:\s*var\(--main-header-action-bg/s,
    );
    expect(mainCss).toMatch(
      /\.open-app-button\s*\{[^}]*background:\s*var\(--main-header-action-bg/s,
    );
    expect(mainCss).not.toMatch(
      /\.main-header-action\s*\{[^}]*background:\s*#[0-9a-fA-F]{3,8}/s,
    );
    expect(mainCss).toMatch(
      /\.app:is\(\.layout-desktop, \.layout-tablet\) \.main-header \.workspace-context-chip,\s*\.app:is\(\.layout-desktop, \.layout-tablet\) \.main-header \.workspace-branch-static-button,\s*\.app:is\(\.layout-desktop, \.layout-tablet\) \.main-header \.workspace-branch-button\s*\{[^}]*background:\s*var\(--main-header-action-bg\);[^}]*color:\s*var\(--main-header-action-text-strong\);/s,
    );
  });

  it("keeps dark desktop chrome rules but lets the light theme override them", () => {
    expect(mainCss).toMatch(
      /\.app\.layout-desktop \.main,\s*\.app\.layout-tablet \.tablet-main\s*\{[^}]*--surface-topbar:\s*#151a1f;[^}]*--surface-messages:\s*#101419;/s,
    );
    expect(mainCss).toMatch(
      /\.app\.layout-desktop \.main-topbar,\s*\.app\.layout-tablet \.main-topbar\s*\{[^}]*background:\s*#151a1f;/s,
    );
    expect(mainCss).toMatch(
      /\.app\.layout-desktop \.content,\s*\.app\.layout-tablet \.tablet-content\s*\{[^}]*background:\s*#101419;/s,
    );
    expect(mainCss).toMatch(
      /:root:not\(\[data-theme\]\) \.app\.layout-desktop \.main,\s*:root:not\(\[data-theme\]\) \.app\.layout-tablet \.tablet-main,\s*:root\[data-theme="light"\] \.app\.layout-desktop \.main,\s*:root\[data-theme="light"\] \.app\.layout-tablet \.tablet-main\s*\{[^}]*--surface-topbar:\s*var\(--cm-light-panel-bg\);[^}]*--surface-messages:\s*var\(--cm-light-main-bg\);[^}]*background:\s*var\(--cm-light-main-bg\);/s,
    );
    expect(mainCss).toMatch(
      /:root:not\(\[data-theme\]\) \.app\.layout-desktop \.main,[\s\S]*?--surface-active:\s*color-mix\(in srgb, var\(--cm-light-accent\) 13%, transparent\);[\s\S]*?--border-accent:\s*color-mix\(in srgb, var\(--cm-light-accent\) 48%, transparent\);[\s\S]*?--text-accent:\s*var\(--cm-light-accent-text\);/,
    );
    expect(mainCss).toMatch(
      /:root:not\(\[data-theme\]\) \.app\.layout-desktop \.main-topbar,\s*:root:not\(\[data-theme\]\) \.app\.layout-tablet \.main-topbar,\s*:root\[data-theme="light"\] \.app\.layout-desktop \.main-topbar,\s*:root\[data-theme="light"\] \.app\.layout-tablet \.main-topbar\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--cm-light-panel-bg\) 94%, var\(--cm-light-main-bg\) 6%\);/s,
    );
  });

  it("keeps compact and tablet shells on the app surface color instead of the page fallback", () => {
    const compactBaseCss = readFileSync(
      new URL("./compact-base.css", import.meta.url),
      "utf8",
    );
    const compactTabletCss = readFileSync(
      new URL("./compact-tablet.css", import.meta.url),
      "utf8",
    );

    expect(compactBaseCss).toMatch(
      /\.compact-panel\s*\{[^}]*background:\s*var\(--surface-messages\);/s,
    );
    expect(compactTabletCss).toMatch(
      /\.app\.layout-tablet\s*\{[^}]*background:\s*#101419;/s,
    );
    expect(compactTabletCss).toMatch(
      /\.tablet-main\s*\{[^}]*background:\s*#101419;/s,
    );
    expect(compactTabletCss).toMatch(
      /:root:not\(\[data-theme\]\) \.app\.layout-tablet,\s*:root\[data-theme="light"\] \.app\.layout-tablet\s*\{[^}]*background:\s*var\(--cm-light-main-bg\);/s,
    );
    expect(compactTabletCss).toMatch(
      /:root:not\(\[data-theme\]\) \.tablet-main,\s*:root\[data-theme="light"\] \.tablet-main\s*\{[^}]*background:\s*var\(--cm-light-main-bg\);/s,
    );
    expect(compactTabletCss).toMatch(
      /:root:not\(\[data-theme\]\) \.tablet-nav-item\.active,\s*:root\[data-theme="light"\] \.tablet-nav-item\.active\s*\{[^}]*color:\s*var\(--cm-light-text-strong\);[^}]*background:\s*color-mix\(in srgb, var\(--cm-light-accent\) 12%, transparent\);/s,
    );
  });
});
