import { describe, expect, it } from "vitest";
import { resolveNextThemePreference } from "./themePreference";

describe("themePreference", () => {
  it("switches between the two supported color modes", () => {
    expect(resolveNextThemePreference("light")).toBe("dark");
    expect(resolveNextThemePreference("dark")).toBe("light");
  });
});
