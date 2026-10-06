// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/features/i18n/I18nProvider";
import { CodexCliUpdatePrompt } from "./CodexCliUpdatePrompt";

const check = {
  status: "available" as const,
  installed: true,
  currentVersion: "0.144.0",
  latestVersion: "0.147.0",
  platform: "windows-x86_64",
  source: "npm",
  package: null,
  reasonCode: null,
};

describe("CodexCliUpdatePrompt", () => {
  afterEach(cleanup);

  it("offers a retry action for a local in-place update", () => {
    const onConfirm = vi.fn();
    render(
      <I18nProvider preference="zh">
        <CodexCliUpdatePrompt
          open
          check={check}
          installEnabled
          busy={false}
          onCancel={vi.fn()}
          onConfirm={onConfirm}
        />
      </I18nProvider>,
    );
    expect(screen.getByText("启动时调用当前 Codex CLI 的检查逻辑；发现新版后执行 codex update 原地更新，不创建应用副本。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "立即更新" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("does not offer control-side installation for a remote host", () => {
    render(
      <I18nProvider preference="zh">
        <CodexCliUpdatePrompt
          open
          check={check}
          installEnabled={false}
          busy={false}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(screen.queryByRole("button", { name: "立即更新" })).toBeNull();
    expect(screen.getByText(/远程执行主机/)).toBeTruthy();
  });

  it("disables confirmation while the in-place update is busy", () => {
    render(
      <I18nProvider preference="zh">
        <CodexCliUpdatePrompt
          open
          check={check}
          installEnabled
          busy
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(
      (screen.getByRole("button", { name: "正在更新…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("shows a failed check and offers another check instead of installing", () => {
    const onRecheck = vi.fn();
    render(<I18nProvider preference="zh"><CodexCliUpdatePrompt open check={null} stage="error" error="version request timed out" installEnabled busy={false} onCancel={vi.fn()} onConfirm={vi.fn()} onRecheck={onRecheck} /></I18nProvider>);
    expect(screen.getByText("无法连接更新服务，请检查网络或代理设置后重试。")).toBeTruthy();
    expect(screen.queryByText("version request timed out")).toBeNull();
    expect(screen.queryByRole("button", { name: "立即更新" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "检查 Codex 更新" }));
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });

  it("shows the actual installed version after a managed update", () => {
    render(<I18nProvider preference="zh"><CodexCliUpdatePrompt open check={{ ...check, source: "managed" }} stage="updated" installedVersion="0.160.1" installEnabled busy={false} onCancel={vi.fn()} onConfirm={vi.fn()} /></I18nProvider>);
    expect(screen.getByText("0.160.1")).toBeTruthy();
    expect(screen.getByText(/新连接将自动使用新版/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "立即更新" })).toBeNull();
  });
});
