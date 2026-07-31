// @ts-nocheck -- Node types are intentionally not enabled for the frontend project.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("debug panel layout styles", () => {
  const debugCss = readFileSync(new URL("./debug.css", import.meta.url), "utf8");
  const baseCss = readFileSync(new URL("./base.css", import.meta.url), "utf8");

  it("constrains the desktop grid host before reserving a docked activity row", () => {
    const desktopLayoutRule = baseCss.match(
      /\.app\.layout-desktop\s*\{([\s\S]*?)\n\}/,
    );

    expect(desktopLayoutRule?.[1]).toContain("grid-template-rows: minmax(0, 1fr)");
  });

  it("reserves the final desktop grid row when debug is open over home", () => {
    const homeWithDebugRule = debugCss.match(
      /\.main:has\(> \.debug-panel\.open\) > \.home\s*\{([\s\S]*?)\n\}/,
    );

    expect(homeWithDebugRule?.[1]).toContain("grid-row: 1 / 5");
  });

  it("keeps dense activity rows scannable without hiding payloads", () => {
    expect(debugCss).toMatch(
      /\.debug-row\s*\{[^}]*grid-template-columns:\s*max-content max-content minmax\(0, 1fr\);/s,
    );
    expect(debugCss).toMatch(
      /\.debug-payload\s*\{[^}]*grid-column:\s*1 \/ -1;[^}]*max-height:\s*96px;[^}]*overflow:\s*auto;/s,
    );
    expect(debugCss).toMatch(
      /@media \(max-width: 620px\)[\s\S]*?\.debug-label\s*\{[^}]*grid-column:\s*1 \/ -1;[^}]*white-space:\s*normal;/,
    );
  });
});
