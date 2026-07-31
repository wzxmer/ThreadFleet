/** @vitest-environment jsdom */
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AppSettings } from "@/types";
import { useCodeCssVars } from "./useCodeCssVars";

describe("useCodeCssVars", () => {
  it("applies the selected CJK font globally and ignores legacy message font overrides", () => {
    const settings = {
      appLanguage: "zh",
      uiFontFamily: "system-ui, sans-serif",
      uiLatinFontFamily: '"Segoe UI", system-ui, sans-serif',
      uiCjkFontFamily: '"LXGW WenKai Screen", sans-serif',
      uiFontSize: 15,
      uiFontWeight: 500,
      codeFontFamily: '"JetBrains Mono", ui-monospace, monospace',
      codeFontSize: 12,
      messageFontFamily: '"Legacy Message Font", sans-serif',
      messageFontSize: 18,
      processFontSize: 12,
      messageFontWeight: 650,
    } as AppSettings;

    renderHook(() => useCodeCssVars(settings));

    const rootStyle = document.documentElement.style;
    const uiFontFamily =
      '"Segoe UI", "LXGW WenKai Screen", system-ui, sans-serif';
    expect(rootStyle.getPropertyValue("--ui-font-family")).toBe(uiFontFamily);
    expect(rootStyle.getPropertyValue("--message-font-family")).toBe(uiFontFamily);
    expect(rootStyle.getPropertyValue("--message-font-size")).toBe("18px");
    expect(rootStyle.getPropertyValue("--process-font-size")).toBe("12px");
    expect(rootStyle.getPropertyValue("--message-font-weight")).toBe("500");
    expect(rootStyle.getPropertyValue("--code-font-family")).toBe(
      '"JetBrains Mono", "LXGW WenKai Screen", ui-monospace, monospace, sans-serif, system-ui',
    );
  });
});
