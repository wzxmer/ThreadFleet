/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettingsSurfaceFallback } from "./SettingsSurfaceFallback";

describe("SettingsSurfaceFallback", () => {
  it("keeps the settings surface visible while the lazy view loads", () => {
    render(<SettingsSurfaceFallback />);

    expect(screen.getByRole("status", { name: "设置" })).toBeTruthy();
    expect(screen.getByText("正在加载设置…")).toBeTruthy();
  });
});
