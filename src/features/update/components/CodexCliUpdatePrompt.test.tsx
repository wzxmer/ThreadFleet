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
  source: "tencent",
  package: {
    version: "0.147.0",
    fileName: "codex.zip",
    urls: ["https://download.example/codex.zip"],
    size: 1024,
    sha256: "a".repeat(64),
  },
  reasonCode: null,
};

describe("CodexCliUpdatePrompt", () => {
  afterEach(cleanup);

  it("requires explicit confirmation for a local in-place update", () => {
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
    expect(screen.getByText("通过当前 Codex CLI 的 npm 或 Homebrew 安装来源原地更新，不创建应用副本。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认更新" }));
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
    expect(screen.queryByRole("button", { name: "确认更新" })).toBeNull();
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
});
