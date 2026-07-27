// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Node types are intentionally not enabled for the frontend project.
// @ts-nocheck -- Node types are intentionally not enabled for the frontend project.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("settings Provider diagnostics styles", () => {
  const settingsCss = readFileSync(new URL("./settings.css", import.meta.url), "utf8");

  it("collapses diagnostics to one column in narrow settings windows", () => {
    expect(settingsCss).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.settings-provider-diagnostics-grid\s*\{\s*grid-template-columns: 1fr;/,
    );
  });

  it("keeps long source identifiers inside the diagnostics panel", () => {
    const valueRule = settingsCss.match(
      /\.settings-provider-diagnostics-grid dd\s*\{([\s\S]*?)\n\}/,
    );

    expect(valueRule?.[1]).toContain("min-width: 0");
    expect(valueRule?.[1]).toContain("overflow-wrap: anywhere");
  });

  it("keeps computer-control status and responsive rules feature-scoped", () => {
    expect(settingsCss).toContain(".settings-computer-control-status-row");
    expect(settingsCss).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.settings-computer-control-header\s*\{[\s\S]*?flex-direction: column;/,
    );
    expect(settingsCss).not.toMatch(
      /(^|\n)button\s*\{[\s\S]*?computer-control/,
    );
  });
});
