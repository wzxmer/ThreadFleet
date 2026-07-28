// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/features/i18n/I18nProvider";
import type { CodexSyncDiagnostics } from "@/types";
import { CodexSessionSharingStatus } from "./CodexSessionSharingStatus";

const diagnostics: CodexSyncDiagnostics = {
  username: "tester",
  userProfile: "C:\\Users\\tester",
  codexHomePath: "C:\\Users\\tester\\.codex",
  codexHomeSource: "默认路径",
  defaultCodexHomePath: "C:\\Users\\tester\\.codex",
  sharesDefaultCodexSessions: true,
  sessionsPath: "C:\\Users\\tester\\.codex\\sessions",
  sessionsExists: true,
  sessionFileCount: 12,
  latestSessionPath: null,
  latestSessionModifiedMs: null,
};

function renderStatus(
  backendMode: "local" | "remote",
  result: CodexSyncDiagnostics,
) {
  return render(
    <I18nProvider preference="zh">
      <CodexSessionSharingStatus
        backendMode={backendMode}
        state={{ status: "done", result, error: null }}
        onRefresh={vi.fn()}
      />
    </I18nProvider>,
  );
}

afterEach(cleanup);

describe("CodexSessionSharingStatus", () => {
  it("reports automatic sharing for the local official CODEX_HOME", () => {
    renderStatus("local", diagnostics);

    expect(screen.getByText("正在使用本机默认会话库")).toBeTruthy();
    expect(screen.getByText("会话文件：12 个")).toBeTruthy();
  });

  it("reports a separate library for a custom local CODEX_HOME", () => {
    renderStatus("local", {
      ...diagnostics,
      codexHomePath: "D:\\ThreadFleet\\codex-home",
      sharesDefaultCodexSessions: false,
    });

    expect(screen.getByText("当前使用独立会话库")).toBeTruthy();
  });

  it("does not claim that a remote backend shares this computer's library", () => {
    renderStatus("remote", diagnostics);

    expect(screen.getByText("会话库位于远程主机")).toBeTruthy();
    expect(screen.getByText(/远程 CODEX_HOME/)).toBeTruthy();
    expect(screen.queryByText(/本机默认 CODEX_HOME/)).toBeNull();
  });
});
