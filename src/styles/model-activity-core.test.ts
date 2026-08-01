// @ts-nocheck -- Node types are intentionally not enabled for the frontend project.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const modelActivityCoreCss = readFileSync(
  new URL("./model-activity-core.css", import.meta.url),
  "utf8",
);

describe("model activity core styles", () => {
  it("keeps each visible state animated at small icon sizes", () => {
    expect(modelActivityCoreCss).toMatch(
      /\.model-activity-core--idle \.model-activity-core__scan\s*\{[^}]*animation:\s*model-activity-scan 2\.9s ease-in-out infinite;/s,
    );
    expect(modelActivityCoreCss).toMatch(
      /\.model-activity-core--thinking \.model-activity-core__scan\s*\{[^}]*animation:\s*model-activity-scan 0\.78s ease-in-out infinite;/s,
    );
    expect(modelActivityCoreCss).toMatch(
      /\.model-activity-core--completed \.model-activity-core__orbit--primary\s*\{[^}]*animation:\s*model-activity-orbit 2\.35s linear infinite;/s,
    );
    expect(modelActivityCoreCss).toMatch(
      /\.model-activity-core--failed \.model-activity-core__brain-outline,[\s\S]*animation:\s*model-activity-error-flicker 1\.6s steps\(2, end\) infinite;/,
    );
    expect(modelActivityCoreCss).toMatch(
      /\.model-activity-core--thinking \.model-activity-core__network\s*\{[^}]*animation:\s*model-activity-thinking-pulse 0\.84s ease-in-out infinite;/s,
    );
    expect(modelActivityCoreCss).toMatch(
      /\.model-activity-core--executing \.model-activity-core__network\s*\{[^}]*animation:\s*model-activity-thinking-pulse 0\.52s ease-in-out infinite;/s,
    );
  });

  it("reduces compact icons to the readable brain signal", () => {
    expect(modelActivityCoreCss).toMatch(
      /\.model-activity-core--compact \.model-activity-core__orbit--secondary,[\s\S]*display:\s*none;/,
    );
    expect(modelActivityCoreCss).toMatch(
      /\.model-activity-core--compact \.model-activity-core__midline\s*\{[^}]*display:\s*none;/s,
    );
  });

  it("still honors reduced motion", () => {
    expect(modelActivityCoreCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*animation:\s*none !important;/,
    );
  });
});
