// @ts-nocheck -- Node types are intentionally not enabled for the frontend project.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("conversation export selection styles", () => {
  const exportCss = readFileSync(new URL("./conversation-export.css", import.meta.url), "utf8");

  it("keeps selection checkboxes on the left and the export action on the right", () => {
    expect(exportCss).toMatch(/\.message-export-checkbox\s*\{[^}]*left:\s*6px;/s);
    expect(exportCss).not.toMatch(/\.message-export-checkbox\s*\{[^}]*right:/s);
    expect(exportCss).toMatch(/\.message-export-button\s*\{[^}]*right:\s*62px;/s);
    expect(exportCss).toMatch(
      /\.messages-reading-native \.message \.message-export-button\s*\{[^}]*bottom:\s*-20px;[^}]*background:\s*color-mix\(in srgb, var\(--messages-solid-control\) 86%, var\(--messages-solid-main\) 14%\);[^}]*color:\s*var\(--messages-process-text\);/s,
    );
  });
});
