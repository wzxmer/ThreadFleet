// @ts-nocheck -- Node types are intentionally not enabled for the frontend project.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("global font styles", () => {
  it("uses the runtime UI font variable at the document root", () => {
    const themeCss = readFileSync(
      new URL("./themes.light.css", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");
    expect(themeCss).toContain(":root,\n:root[data-theme=\"light\"] {\n  font-family: var(--ui-font-family);");
  });

  it("uses the composed code font stack for terminal content", () => {
    const terminalCss = readFileSync(new URL("./terminal.css", import.meta.url), "utf8");
    expect(terminalCss).toContain("--terminal-font-family: var(--code-font-family);");
  });

  it("derives interface typography from the runtime UI font size", () => {
    const baseCss = readFileSync(new URL("./base.css", import.meta.url), "utf8");
    const typographyCss = readFileSync(
      new URL("./ui-typography.css", import.meta.url),
      "utf8",
    );
    expect(baseCss).toContain("--ui-font-size-sm:");
    expect(baseCss).toContain("--ui-font-size-control:");
    expect(typographyCss).toContain(".sidebar");
    expect(typographyCss).toContain(".settings-overlay");
    expect(typographyCss).toContain(".composer");
    expect(typographyCss).toContain(".file-tree-panel");
    expect(typographyCss).toContain(".terminal-header");
    expect(typographyCss).toContain(".diff-viewer");
    expect(typographyCss).toContain("font-size: var(--ui-font-size-md)");
  });

  it("uses app-owned scrollbar tokens instead of native white tracks", () => {
    const baseCss = readFileSync(new URL("./base.css", import.meta.url), "utf8");

    expect(baseCss).toContain("--cm-scrollbar-size: 10px;");
    expect(baseCss).toContain("--cm-scrollbar-track: transparent;");
    expect(baseCss).toContain(
      "--cm-scrollbar-thumb: color-mix(in srgb, var(--text-dim) 72%, transparent);",
    );
    expect(baseCss).toMatch(
      /\.app,\s*\.app \*\s*\{[^}]*scrollbar-color:\s*var\(--cm-scrollbar-thumb\) var\(--cm-scrollbar-track\);[^}]*scrollbar-width:\s*thin;/s,
    );
    expect(baseCss).toMatch(
      /\.app::-webkit-scrollbar-thumb,\s*\.app \*::-webkit-scrollbar-thumb\s*\{[^}]*border:\s*2px solid transparent;/s,
    );
    expect(baseCss).toMatch(
      /\.app::-webkit-scrollbar,\s*\.app \*::-webkit-scrollbar\s*\{[^}]*background:\s*transparent;/s,
    );
    expect(baseCss).toMatch(
      /\.app::-webkit-scrollbar-button,\s*\.app \*::-webkit-scrollbar-button\s*\{[^}]*display:\s*none;[^}]*width:\s*0;[^}]*height:\s*0;/s,
    );
  });
});
