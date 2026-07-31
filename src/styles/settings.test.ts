// @ts-nocheck -- Node types are intentionally not enabled for the frontend project.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("settings toggle row styles", () => {
  const settingsCss = readFileSync(new URL("./settings.css", import.meta.url), "utf8");

  it("keeps long localized copy from pushing the toggle outside narrow windows", () => {
    expect(settingsCss).toMatch(
      /\.settings-toggle-row > div:first-child\s*\{[^}]*min-width:\s*0;/s,
    );
    expect(settingsCss).toMatch(
      /\.settings-toggle-subtitle\s*\{[^}]*overflow-wrap:\s*anywhere;/s,
    );
    expect(settingsCss).toMatch(
      /\.settings-toggle\s*\{[^}]*flex:\s*0 0 44px;/s,
    );
  });

  it("keeps the settings form constrained and rows visually flat", () => {
    expect(settingsCss).toMatch(
      /\.settings-content-inner\s*\{[^}]*width:\s*min\(100%, 760px\);/s,
    );
    const rowRule = settingsCss.match(/\.settings-toggle-row\s*\{([\s\S]*?)\n\}/);
    expect(rowRule?.[1]).toContain("border-bottom: 1px solid var(--border-muted)");
    expect(rowRule?.[1]).not.toContain("background:");
    expect(rowRule?.[1]).not.toContain("border-radius:");
  });

  it("connects settings controls and cards to the shared app light palette tokens", () => {
    const contentRule = settingsCss.match(/^\.settings-content\s*\{([\s\S]*?)\n\}/m);

    expect(contentRule?.[1]).toContain("--settings-control-surface: var(--cm-control-bg);");
    expect(contentRule?.[1]).toContain("--settings-control-surface-hover: var(--cm-control-bg-hover);");
    expect(contentRule?.[1]).toContain(
      "--settings-card-surface: color-mix(in srgb, var(--cm-panel-bg) 92%, var(--cm-main-bg) 8%);",
    );
    expect(contentRule?.[1]).toContain("--settings-card-border: var(--cm-panel-border);");
    expect(contentRule?.[1]).toContain("--settings-control-border: var(--cm-control-border);");
    expect(contentRule?.[1]).toContain("--settings-control-border-hover: var(--cm-control-border-hover);");
    expect(contentRule?.[1]).toContain("background: var(--cm-main-bg);");
    expect(settingsCss).not.toContain("#e6e8ec");
    expect(settingsCss).not.toContain("#dde0e5");
  });

  it("keeps settings buttons scoped and neutral instead of reintroducing feature gradients", () => {
    const primaryButtonRule = settingsCss.match(
      /\.settings-content button\.primary\s*\{([\s\S]*?)\n\}/,
    );
    const primaryHoverRule = settingsCss.match(
      /\.settings-content button\.primary:hover:not\(:disabled\),\s*\.settings-content button\.primary:focus-visible\s*\{([\s\S]*?)\n\}/,
    );

    expect(primaryButtonRule?.[1]).toContain("background: var(--settings-control-surface);");
    expect(primaryButtonRule?.[1]).toContain(
      "border: 1px solid color-mix(in srgb, var(--settings-control-border) 70%, var(--border-accent) 30%);",
    );
    expect(primaryButtonRule?.[1]).not.toContain("linear-gradient");
    expect(primaryHoverRule?.[1]).toContain("background: var(--settings-control-surface-hover);");
    expect(settingsCss).not.toMatch(/(?:^|\n)\s*(?:button\.primary|\.primary)\s*\{/);
  });

  it("keeps settings inputs, selects, and toggles on settings control tokens", () => {
    expect(settingsCss).toMatch(
      /\.settings-input\s*\{[^}]*border:\s*1px solid var\(--settings-control-border\);[^}]*background:\s*var\(--settings-control-surface\);/s,
    );
    expect(settingsCss).toMatch(
      /\.settings-input:hover:not\(:disabled\),\s*\.settings-input:focus-visible\s*\{[^}]*border-color:\s*var\(--settings-control-border-hover\);[^}]*background-color:\s*var\(--settings-control-surface-hover\);/s,
    );
    expect(settingsCss).toMatch(
      /\.settings-select\s*\{[^}]*border:\s*1px solid var\(--settings-control-border\);[^}]*background:\s*var\(--settings-control-surface\);/s,
    );
    expect(settingsCss).toMatch(
      /\.settings-select:hover:not\(:disabled\),\s*\.settings-select:focus-visible\s*\{[^}]*border-color:\s*var\(--settings-control-border-hover\);[^}]*background-color:\s*var\(--settings-control-surface-hover\);/s,
    );
    expect(settingsCss).toMatch(
      /\.settings-toggle\.on\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--border-accent\) 54%, var\(--settings-control-surface\)\);/s,
    );
    expect(settingsCss).not.toMatch(
      /\.settings-toggle\.on\s*\{[^}]*linear-gradient/s,
    );
    expect(settingsCss).not.toContain("rgba(100, 200, 255");
    expect(settingsCss).not.toContain("rgba(120, 235, 190");
    expect(settingsCss).not.toContain("rgba(99, 102, 241");
    expect(settingsCss).not.toContain("rgba(236, 72, 153");
  });

  it("lets project assignment controls shrink or wrap inside narrow settings panes", () => {
    expect(settingsCss).toMatch(
      /\.settings-project-row\s*\{[^}]*flex-wrap:\s*wrap;[^}]*min-width:\s*0;/s,
    );
    expect(settingsCss).toMatch(
      /\.settings-project-info\s*\{[^}]*flex:\s*1 1 280px;[^}]*min-width:\s*0;/s,
    );
    expect(settingsCss).toMatch(
      /\.settings-project-actions\s*\{[^}]*flex:\s*0 1 auto;[^}]*min-width:\s*0;[^}]*margin-left:\s*auto;/s,
    );
    expect(settingsCss).toMatch(
      /\.settings-project-actions > \.ds-rounded-select\s*\{[^}]*flex:\s*0 1 148px;[^}]*min-width:\s*96px;/s,
    );
    expect(settingsCss).toMatch(
      /\.settings-project-group-select\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s,
    );
  });
});
