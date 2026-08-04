// @ts-nocheck -- Node types are intentionally not enabled for the frontend project.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const modelActivityCoreCss = readFileSync(
  new URL("./model-activity-core.css", import.meta.url),
  "utf8",
);

describe("model activity core styles", () => {
  it("keeps each visible state animated with circular status signals", () => {
    expect(modelActivityCoreCss).toMatch(
      /\.model-activity-core--idle \.model-activity-core__orbit--primary\s*\{[^}]*animation:\s*model-activity-orbit 2\.8s linear infinite;/s,
    );
    expect(modelActivityCoreCss).toMatch(
      /\.model-activity-core--thinking \.model-activity-core__orbit--primary\s*\{[^}]*animation:\s*model-activity-orbit 0\.96s linear infinite;/s,
    );
    expect(modelActivityCoreCss).toMatch(
      /\.model-activity-core--completed \.model-activity-core__orbit--primary\s*\{[^}]*animation:\s*model-activity-orbit 2\.35s linear infinite;/s,
    );
    expect(modelActivityCoreCss).toMatch(
      /\.model-activity-core--failed \.model-activity-core__sweep,[\s\S]*animation:\s*model-activity-error-flicker 1\.6s steps\(2, end\) infinite;/,
    );
    expect(modelActivityCoreCss).toMatch(
      /\.model-activity-core--thinking \.model-activity-core__thinking-dot\s*\{[^}]*animation:\s*model-activity-thinking-dot 0\.84s ease-in-out infinite;/s,
    );
    expect(modelActivityCoreCss).toMatch(
      /\.model-activity-core--executing \.model-activity-core__thinking-dot\s*\{[^}]*animation:\s*model-activity-thinking-dot 0\.52s ease-in-out infinite;/s,
    );
  });

  it("keeps compact icons circular and uncluttered", () => {
    expect(modelActivityCoreCss).toMatch(
      /\.model-activity-core--compact \.model-activity-core__orbit--secondary,[\s\S]*display:\s*none;/,
    );
    expect(modelActivityCoreCss).toMatch(
      /\.model-activity-core--compact \.model-activity-core__sweep\s*\{[^}]*stroke-width:\s*1\.7;/s,
    );
    expect(modelActivityCoreCss).not.toContain("model-activity-core__brain-outline");
    expect(modelActivityCoreCss).not.toContain("model-activity-core__network");
    expect(modelActivityCoreCss).not.toContain("model-activity-core__scan");
  });

  it("rotates orbiting details around the SVG center rather than their off-center spark bounds", () => {
    expect(modelActivityCoreCss).toMatch(
      /\.model-activity-core__orbit\s*\{[^}]*transform-box:\s*view-box;[^}]*transform-origin:\s*50% 50%;/s,
    );
  });

  it("still honors reduced motion", () => {
    expect(modelActivityCoreCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*animation:\s*none !important;/,
    );
  });
});
