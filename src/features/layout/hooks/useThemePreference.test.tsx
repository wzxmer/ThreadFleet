/** @vitest-environment jsdom */
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ThemePreference } from "../../../types";
import { useThemePreference } from "./useThemePreference";

describe("useThemePreference", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  it("writes explicit light and dark runtime themes", () => {
    const { result, rerender } = renderHook(
      ({ theme }) => useThemePreference(theme),
      { initialProps: { theme: "light" as ThemePreference } },
    );

    expect(result.current).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");

    rerender({ theme: "dark" });

    expect(result.current).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
