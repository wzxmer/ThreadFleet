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

  it("requires explicit confirmation for a local managed update", () => {
    const onConfirm = vi.fn();
    render(
      <I18nProvider preference="zh">
        <CodexCliUpdatePrompt
          open
          check={check}
          installEnabled
          busy={false}
          progress={null}
          onCancel={vi.fn()}
          onConfirm={onConfirm}
        />
      </I18nProvider>,
    );
    expect(screen.getByText("腾讯 COS")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认安装" }));
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
          progress={null}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(screen.queryByRole("button", { name: "确认安装" })).toBeNull();
    expect(screen.getByText(/远程执行主机/)).toBeTruthy();
  });

  it("shows determinate download progress while installation is busy", () => {
    const { container } = render(
      <I18nProvider preference="zh">
        <CodexCliUpdatePrompt
          open
          check={check}
          installEnabled
          busy
          progress={50}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      </I18nProvider>,
    );

    const progress = screen.getByLabelText("Codex CLI 下载进度");
    expect(progress.textContent).toContain("50%");
    expect(
      (container.querySelector(".codex-install-progress-track > span") as HTMLElement)
        .style.width,
    ).toBe("50%");
    expect(
      (screen.getByRole("button", { name: "正在安装…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
