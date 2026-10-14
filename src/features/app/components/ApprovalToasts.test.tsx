// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, WorkspaceInfo } from "../../../types";
import { I18nProvider } from "../../i18n/I18nProvider";
import { ApprovalToasts } from "./ApprovalToasts";

const workspaces: WorkspaceInfo[] = [
  {
    id: "workspace-1",
    name: "Workspace One",
    path: "/tmp/workspace-1",
    connected: true,
    settings: { sidebarCollapsed: false },
  },
];

const approvals: ApprovalRequest[] = [
  {
    workspace_id: "workspace-1",
    request_id: 1,
    method: "codex/requestApproval/shell",
    params: { command: "echo one" },
  },
  {
    workspace_id: "workspace-1",
    request_id: 2,
    method: "codex/requestApproval/shell",
    params: { command: "echo two" },
  },
];

afterEach(() => cleanup());

describe("ApprovalToasts", () => {
  it("renders live-region semantics and handles Enter on primary request", () => {
    const onDecision = vi.fn();
    render(
      <ApprovalToasts approvals={approvals} workspaces={workspaces} onDecision={onDecision} />,
    );

    const region = screen.getByRole("region");
    expect(region.getAttribute("aria-live")).toBe("assertive");
    expect(screen.getAllByRole("alert")).toHaveLength(2);

    fireEvent.keyDown(window, { key: "Enter" });
    expect(onDecision).toHaveBeenCalledWith(approvals[1], "accept");
  });

  it("does not submit when an input is focused", () => {
    const onDecision = vi.fn();
    render(
      <ApprovalToasts approvals={approvals} workspaces={workspaces} onDecision={onDecision} />,
    );

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onDecision).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it("localizes permission fields and actions in Chinese", () => {
    const request: ApprovalRequest = {
      workspace_id: "workspace-1",
      request_id: 3,
      method: "item/permissions/requestApproval",
      params: {
        reason: "需要验证",
        startedAtMs: 123,
        threadId: "thread-1",
        turnId: "turn-1",
        command: "git status",
      },
    };

    render(
      <I18nProvider preference="zh">
        <ApprovalToasts
          approvals={[request]}
          workspaces={workspaces}
          onDecision={vi.fn()}
          onRemember={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("需要授权")).toBeTruthy();
    expect(screen.getByText("权限申请")).toBeTruthy();
    expect(screen.getByText("原因")).toBeTruthy();
    expect(screen.getByText("开始时间（毫秒）")).toBeTruthy();
    expect(screen.getByText("会话 ID")).toBeTruthy();
    expect(screen.getByText("轮次 ID")).toBeTruthy();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "始终允许" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "允许（Enter）" })).toBeTruthy();
  });

  it("offers one-time decisions for Gemini without a persistent approval rule", () => {
    const request: ApprovalRequest = {
      ...approvals[0], request_id: "gemini:session:approval-1",
      method: "item/commandExecution/requestApproval",
    };
    const onDecision = vi.fn();
    const onRemember = vi.fn();
    render(
      <I18nProvider preference="zh">
        <ApprovalToasts approvals={[request]} workspaces={workspaces}
          onDecision={onDecision} onRemember={onRemember} />
      </I18nProvider>,
    );
    expect(screen.queryByRole("button", { name: "始终允许" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "允许（Enter）" }));
    expect(onDecision).toHaveBeenCalledWith(request, "accept");
    expect(onRemember).not.toHaveBeenCalled();
  });

  it("keeps approval copy in English when English is selected", () => {
    render(
      <I18nProvider preference="en">
        <ApprovalToasts
          approvals={[approvals[0]]}
          workspaces={workspaces}
          onDecision={vi.fn()}
          onRemember={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("Approval needed")).toBeTruthy();
    expect(screen.getByText("Shell command")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Always allow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve (Enter)" })).toBeTruthy();
  });
});
