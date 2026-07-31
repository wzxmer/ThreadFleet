// @ts-nocheck -- Node types are intentionally not enabled for the frontend project.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("home layout styles", () => {
  const homeCss = readFileSync(new URL("./home.css", import.meta.url), "utf8");

  it("keeps the dashboard constrained to its owning grid area", () => {
    const homeRule = homeCss.match(/\.home\s*\{([\s\S]*?)\n\}/);

    expect(homeRule?.[1]).toContain("width: 100%");
    expect(homeRule?.[1]).toContain("min-width: 0");
    expect(homeRule?.[1]).toContain("max-width: 100%");
    expect(homeRule?.[1]).toContain("background: var(--home-command-page-bg, #101419)");
  });

  it("defines readable command-deck tokens for home surfaces across shells", () => {
    const commandDeckRule = homeCss.match(
      /\.home\s*\{[^}]*--home-command-surface:\s*#151a1f;[^}]*--home-command-text:\s*#dfe5ea;[^}]*color:\s*var\(--home-command-text\);[^}]*\}/s,
    );

    expect(commandDeckRule).not.toBeNull();
    expect(homeCss).toMatch(
      /:root:not\(\[data-theme\]\) \.home,\s*:root\[data-theme="light"\] \.home\s*\{[^}]*--home-command-page-bg:\s*var\(--cm-light-main-bg\);[^}]*--home-command-surface:\s*var\(--cm-light-panel-bg\);[^}]*--home-command-text:\s*var\(--cm-light-text-strong\);/s,
    );
    expect(homeCss).toContain(
      ".home .home-usage-card,\n.home .home-usage-chart-card",
    );
    expect(homeCss).toMatch(
      /\.home \.home-usage-select-wrap,\s*\.home \.home-usage-toggle,\s*\.home \.home-usage-model-chip\s*\{[^}]*border-color:\s*var\(--home-command-border\);[^}]*background:\s*var\(--home-command-surface-control\);/s,
    );
    expect(homeCss).toMatch(
      /\.home \.home-usage-toggle-button\.is-active\s*\{[^}]*background:\s*var\(--home-command-surface-soft\);[^}]*color:\s*var\(--home-command-text\);/s,
    );
    expect(homeCss).not.toContain(".app.layout-desktop .home .home-usage-select-wrap");
  });

  it("keeps home chrome and headings on theme-aware home tokens", () => {
    expect(homeCss).toMatch(
      /\.home-header\s*\{[^}]*border-bottom:\s*1px solid var\(--home-command-border\);/s,
    );
    expect(homeCss).toMatch(
      /\.home-title\s*\{[^}]*color:\s*var\(--home-command-text\);/s,
    );
    expect(homeCss).toMatch(
      /\.home-subtitle\s*\{[^}]*color:\s*var\(--home-command-faint\);/s,
    );
    expect(homeCss).toMatch(
      /\.home-usage-card\s*\{[^}]*background:\s*var\(--home-command-surface\);[^}]*border:\s*1px solid var\(--home-command-border\);/s,
    );
    expect(homeCss).toMatch(
      /\.home-usage-chart-card\s*\{[^}]*background:\s*var\(--home-command-surface\);[^}]*border:\s*1px solid var\(--home-command-border\);/s,
    );
  });

  it("uses semantic tokens for home action button colors", () => {
    expect(homeCss).toMatch(
      /--home-action-secondary-bg:\s*var\(--home-command-surface-control\)/,
    );
    expect(homeCss).toMatch(
      /:root:not\(\[data-theme\]\) \.home,\s*:root\[data-theme="light"\] \.home\s*\{[^}]*--home-action-primary-bg:\s*var\(--home-command-surface-control\);[^}]*--home-action-primary-bg-hover:\s*var\(--cm-light-control-bg-hover\);[^}]*--home-action-primary-border:\s*color-mix\(in srgb, var\(--cm-light-control-border\) 72%, var\(--border-accent\) 28%\);[^}]*--home-action-primary-text:\s*var\(--home-command-text\);/s,
    );
    expect(homeCss).toMatch(
      /:root:not\(\[data-theme\]\) \.home,\s*:root\[data-theme="light"\] \.home\s*\{[^}]*--home-action-secondary-bg:\s*var\(--home-command-surface-control\);[^}]*--home-action-secondary-border-hover:\s*var\(--cm-light-control-border-hover\);[^}]*--home-action-icon-accent:\s*var\(--text-accent\);/s,
    );
    expect(homeCss).toMatch(
      /\.home-actions \.home-add-workspaces-button\s*\{[^}]*background:\s*var\(--home-action-primary-bg/s,
    );
    expect(homeCss).toMatch(
      /\.home-actions \.home-button\.primary\s*\{[^}]*background:\s*var\(--home-action-primary-bg/s,
    );
    expect(homeCss).toMatch(
      /\.home-actions \.home-add-workspace-from-url-button\s*\{[^}]*border-color:\s*var\(--home-action-secondary-border/s,
    );
    expect(homeCss).not.toMatch(
      /\.home-actions \.home-button\.primary\s*\{[^}]*background:\s*#[0-9a-fA-F]{3,8}/s,
    );
  });
});
