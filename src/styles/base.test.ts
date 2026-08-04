// @ts-nocheck -- Node types are intentionally not enabled for the frontend project.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("app root resize background", () => {
  const baseCss = readFileSync(new URL("./base.css", import.meta.url), "utf8");
  const tokenCss = readFileSync(new URL("./ds-tokens.css", import.meta.url), "utf8");
  const lightThemeCss = readFileSync(new URL("./themes.light.css", import.meta.url), "utf8");
  const darkThemeCss = readFileSync(new URL("./themes.dark.css", import.meta.url), "utf8");

  it("keeps the webview root on the app shell background during window resizing", () => {
    const documentRule = baseCss.match(/html,\s*body\s*\{([\s\S]*?)\n\}/);
    const rootRule = baseCss.match(/#root\s*\{([\s\S]*?)\n\}/);

    expect(baseCss.indexOf('@import "./ds-tokens.css";')).toBeLessThan(
      baseCss.indexOf('@import "./themes.css";'),
    );
    expect(documentRule?.[1]).toContain("background: var(--cm-chrome-bg)");
    expect(documentRule?.[1]).toContain("overflow: hidden");
    expect(rootRule?.[1]).toContain("width: 100vw");
    expect(rootRule?.[1]).toContain("min-width: 100vw");
    expect(rootRule?.[1]).toContain("background: var(--cm-chrome-bg)");
    expect(rootRule?.[1]).toContain("overflow: hidden");
    expect(baseCss).not.toMatch(/html,\s*body\s*\{[^}]*background:\s*transparent/s);
  });

  it("lets the main surface fill the window while the desktop sidebar overlays it", () => {
    const overlayRule = baseCss.match(
      /\.app\.layout-desktop\.sidebar-overlay-open\s*\{([\s\S]*?)\n\}/,
    );

    expect(overlayRule?.[1]).toContain(
      "grid-template-columns: var(--app-rail-width, 52px) minmax(0, 1fr)",
    );
  });

  it("keeps Windows caption controls visible on active chrome", () => {
    const captionControlsRule = baseCss.match(
      /\.window-caption-controls\s*\{([\s\S]*?)\n\}/,
    );
    const captionRule = baseCss.match(
      /\.window-caption-control\s*\{([\s\S]*?)\n\}/,
    );
    const captionHoverRule = baseCss.match(
      /\.window-caption-control:hover,\s*\.window-caption-control:focus-visible\s*\{([\s\S]*?)\n\}/,
    );
    const iconRule = baseCss.match(/\.window-caption-control svg\s*\{([\s\S]*?)\n\}/);

    expect(captionControlsRule?.[1]).toContain(
      "height: var(--window-caption-height, 40px)",
    );
    expect(captionRule?.[1]).toContain(
      "height: var(--window-caption-height, 40px)",
    );
    expect(captionRule?.[1]).toContain("color: var(--cm-caption-text)");
    expect(captionRule?.[1]).toContain("opacity: 0.96");
    expect(captionHoverRule?.[1]).toContain("color: var(--cm-text-strong)");
    expect(iconRule?.[1]).toContain("stroke-width: 2");
  });

  it("keeps titlebar sidebar expand controls readable on active chrome", () => {
    const titlebarActionRule = baseCss.match(
      /\.titlebar-toggle \.main-header-action\s*\{[^}]*background:\s*var\(--cm-control-bg\);([\s\S]*?)\n\}/,
    );
    const titlebarActionHoverRule = baseCss.match(
      /\.titlebar-toggle \.main-header-action:hover,\s*\.titlebar-toggle \.main-header-action:focus-visible\s*\{([\s\S]*?)\n\}/,
    );

    expect(titlebarActionRule).not.toBeNull();
    expect(titlebarActionRule?.[1]).toContain("color: var(--cm-text-primary)");
    expect(titlebarActionHoverRule?.[1]).toContain("background: var(--cm-control-bg-hover)");
    expect(titlebarActionHoverRule?.[1]).toContain("color: var(--cm-text-strong)");
  });

  it("defines light as the default shell palette and maps dark explicitly", () => {
    expect(tokenCss).toContain("--cm-light-chrome-bg: #ffffff;");
    expect(tokenCss).toContain("--cm-light-main-bg: #ffffff;");
    expect(tokenCss).toContain("--cm-light-panel-bg: #ffffff;");
    expect(tokenCss).toContain("--cm-light-control-bg: #edf5fb;");
    expect(tokenCss).toContain("--cm-light-control-bg-hover: #e1effa;");
    expect(tokenCss).toContain("--cm-light-accent: #2791d3;");
    expect(tokenCss).toContain("--cm-light-accent-text: #186fa6;");
    expect(tokenCss).toContain("--cm-light-text-primary: #26313d;");
    expect(tokenCss).toContain("--cm-light-text-strong: #0f1720;");
    expect(tokenCss).toContain("--cm-light-elevation-shadow: 0 20px 46px rgba(32, 86, 126, 0.11);");
    expect(tokenCss).toContain("--cm-chrome-bg: var(--cm-light-chrome-bg);");
    expect(tokenCss).toContain("--cm-elevation-shadow: var(--cm-light-elevation-shadow);");
    expect(lightThemeCss).toContain(":root,");
    expect(lightThemeCss).toContain("--cm-chrome-bg: var(--cm-light-chrome-bg);");
    expect(lightThemeCss).toContain("--cm-main-bg: var(--cm-light-main-bg);");
    expect(lightThemeCss).toContain("--cm-panel-bg: var(--cm-light-panel-bg);");
    expect(lightThemeCss).toContain("--cm-elevation-shadow: var(--cm-light-elevation-shadow);");
    expect(darkThemeCss).toContain(":root[data-theme=\"dark\"]");
    expect(darkThemeCss).toContain("--cm-chrome-bg: var(--cm-dark-chrome-bg);");
    expect(darkThemeCss).toContain("--cm-elevation-shadow: var(--cm-dark-elevation-shadow);");
  });
});
