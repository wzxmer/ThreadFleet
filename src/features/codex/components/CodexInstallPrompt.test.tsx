// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/features/i18n/I18nProvider";
import { CodexInstallPrompt } from "./CodexInstallPrompt";

afterEach(cleanup);

describe("CodexInstallPrompt", () => {
  it("offers automatic install and existing CLI selection", () => {
    const onInstall = vi.fn();
    const onChooseExisting = vi.fn();
    render(
      <I18nProvider preference="zh">
        <CodexInstallPrompt open stage="ready" onInstall={onInstall} onChooseExisting={onChooseExisting} onLater={vi.fn()} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "自动安装" }));
    fireEvent.click(screen.getByRole("button", { name: "选择已有 CLI" }));
    expect(onInstall).toHaveBeenCalledTimes(1);
    expect(onChooseExisting).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["zh", "Codex CLI 安装失败", "OpenAI 官方源"],
    ["en", "Codex CLI installation failed", "OpenAI's official source"],
  ] as const)("explains official fallback and shows failures in %s", (preference, failure, official) => {
    render(
      <I18nProvider preference={preference}>
        <CodexInstallPrompt open stage="error" error="ThreadFleet: Failed to fetch | OpenAI: timed out"
          onInstall={vi.fn()} onChooseExisting={vi.fn()} onLater={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.getByText(new RegExp(official))).toBeTruthy();
    expect(screen.getByText(new RegExp(failure)).textContent).toContain("OpenAI: timed out");
    expect(screen.getByRole("button", { name: preference === "zh" ? "自动安装" : "Install automatically" })
      .hasAttribute("disabled")).toBe(false);
  });
});
