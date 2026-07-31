// @ts-nocheck -- Node types are intentionally not enabled for the frontend project.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainCss = readFileSync(new URL("./main.css", import.meta.url), "utf8");
const panelTabsCss = readFileSync(
  new URL("./panel-tabs.css", import.meta.url),
  "utf8",
);
const terminalCss = readFileSync(
  new URL("./terminal.css", import.meta.url),
  "utf8",
);
const planCss = readFileSync(new URL("./plan.css", import.meta.url), "utf8");
const diffCss = readFileSync(new URL("./diff.css", import.meta.url), "utf8");
const coordinationCss = readFileSync(
  new URL("./coordination.css", import.meta.url),
  "utf8",
);

function rule(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
}

describe("right work panel styles", () => {
  it("keeps the inspector readable at its production minimum width", () => {
    expect(mainCss).toContain("var(--right-panel-width, 300px)");
    expect(rule(mainCss, ".right-panel-top .ds-panel")).toContain(
      "padding: var(--right-panel-top-padding, 10px) 10px 0",
    );
    expect(mainCss).toMatch(
      /\.right-panel-top \.diff-list,\s*\.right-panel-top \.file-tree-list\s*\{[^}]*scrollbar-gutter: stable/,
    );
  });

  it("uses stable compact panel tabs instead of text pills", () => {
    const tabs = rule(panelTabsCss, ".panel-tabs");
    const tab = rule(panelTabsCss, ".panel-tab");

    expect(tabs).toContain("border-radius: 7px");
    expect(tab).toContain("width: 28px");
    expect(tab).toContain("height: 28px");
    expect(tab).toContain("border-radius: 5px");
    expect(tab).not.toContain("999px");
  });

  it("renders terminal tabs as dock tabs with stable icon controls", () => {
    const header = rule(terminalCss, ".terminal-header");
    const tab = rule(terminalCss, ".terminal-tab");
    const add = rule(terminalCss, ".terminal-tab-add");

    expect(header).toContain("min-height: 34px");
    expect(tab).toContain("border-radius: 6px 6px 0 0");
    expect(tab).toContain("letter-spacing: 0");
    expect(add).toContain("width: 28px");
    expect(add).toContain("height: 28px");
  });

  it("keeps Plan and coordination content stable in a 300px inspector", () => {
    expect(rule(planCss, ".plan-step-status")).toContain("width: 16px");
    expect(rule(planCss, ".plan-empty")).toContain("place-items: center");
    expect(rule(coordinationCss, ".coordination-row")).toContain(
      "grid-template-columns: repeat(2, minmax(0, 1fr))",
    );
    expect(rule(coordinationCss, ".coordination-claim-btn")).toContain(
      "grid-column: 1 / -1",
    );
  });

  it("keeps dark Git commit controls but lets the light theme override them", () => {
    expect(mainCss).toMatch(
      /\.app\.layout-desktop \.right-panel\s*\{[^}]*--right-panel-control-bg:\s*#15191e;[^}]*--right-panel-control-bg-active:\s*#20262c;[^}]*--cm-surface-panel:\s*#15191e;[^}]*--cm-scrollbar-track:\s*transparent;/s,
    );
    expect(diffCss).toMatch(
      /\.git-panel-select-input\s*\{[^}]*background:\s*var\(--right-panel-control-bg,/s,
    );
    expect(diffCss).toMatch(
      /\.app\.layout-desktop \.right-panel \.commit-message-section\s*\{[^}]*background:\s*#151a1f;/s,
    );
    expect(diffCss).toMatch(
      /\.app\.layout-desktop \.right-panel \.commit-message-input\s*\{[^}]*color:\s*#dfe5ea;[^}]*background:\s*#20262c;/s,
    );
    expect(mainCss).toMatch(
      /:root:not\(\[data-theme\]\) \.app\.layout-desktop \.right-panel,\s*:root\[data-theme="light"\] \.app\.layout-desktop \.right-panel\s*\{[^}]*--right-panel-control-bg:\s*var\(--cm-light-control-bg\);[^}]*--cm-surface-panel:\s*var\(--cm-light-panel-bg\);/s,
    );
    expect(diffCss).toMatch(
      /:root\[data-theme="light"\] \.app\.layout-desktop \.right-panel \.commit-message-section\s*\{[^}]*background:\s*var\(--cm-light-panel-bg\);/s,
    );
    expect(diffCss).toMatch(
      /:root\[data-theme="light"\] \.app\.layout-desktop \.right-panel \.commit-message-input\s*\{[^}]*color:\s*var\(--cm-light-text-primary\);[^}]*background:\s*var\(--cm-light-control-bg\);/s,
    );
    expect(diffCss).toMatch(
      /\.app\.layout-desktop \.right-panel \.commit-button:disabled\s*\{[^}]*background:\s*var\(--right-panel-control-bg\);[^}]*opacity:\s*1;/s,
    );
    expect(diffCss).toMatch(
      /\.app\.layout-desktop \.right-panel \.push-button:disabled,\s*\.app\.layout-desktop \.right-panel \.push-button-secondary:disabled\s*\{[^}]*opacity:\s*1;[^}]*background:\s*var\(--right-panel-control-bg\);/s,
    );
    expect(diffCss).toMatch(
      /\.push-button\s*\{[^}]*background:\s*var\(--right-panel-control-bg,/s,
    );
    expect(diffCss).toMatch(
      /\.diff-counts-inline\s*\{[^}]*background:\s*var\(--right-panel-control-bg,/s,
    );
  });
});
