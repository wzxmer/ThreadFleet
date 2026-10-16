// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowsControlMcpConfig } from "@/types";
import { getWindowsControlMcp, setWindowsControlMcp } from "@services/tauri";
import { SettingsWindowsControlMcp } from "./SettingsWindowsControlMcp";

vi.mock("@services/tauri", () => ({ getWindowsControlMcp: vi.fn(), setWindowsControlMcp: vi.fn() }));
const config: WindowsControlMcpConfig = {
  supported: true, provider: "sbroenne", enabled: true, revision: "v1",
  profiles: {
    sbroenne: { command: "C:/managed/Sbroenne.WindowsMcp.exe", args: [] },
    cursortouch: { command: "D:/Tools/Windows-MCP/.venv/Scripts/windows-mcp.exe", args: ["serve"] },
  },
};

describe("SettingsWindowsControlMcp", () => {
  beforeEach(() => {
    vi.mocked(getWindowsControlMcp).mockResolvedValue(config);
    vi.mocked(setWindowsControlMcp).mockImplementation(async (input) => ({
      ...config, provider: input.provider, revision: "v2", profiles: { ...config.profiles, [input.provider]: input },
    }));
  });
  afterEach(() => { cleanup(); vi.resetAllMocks(); });
  const setup = (configEditorBusy = false) => {
    const onSaved = vi.fn();
    const onProvider = vi.fn();
    render(<SettingsWindowsControlMcp configEditorBusy={configEditorBusy} onSaved={onSaved} onProvider={onProvider} />);
    return { onSaved, onProvider };
  };

  it("restores the installed provider path and applies one revision-bound request", async () => {
    const { onSaved, onProvider } = setup();
    const select = screen.getByRole("combobox", { name: "Windows 操控 MCP" });
    await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(select, { target: { value: "cursortouch" } });
    expect((screen.getByLabelText("程序路径或命令") as HTMLInputElement).value).toContain("D:/Tools/");
    expect(setWindowsControlMcp).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "应用 MCP 选择" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(setWindowsControlMcp).toHaveBeenCalledWith({ provider: "cursortouch", command: config.profiles.cursortouch!.command, args: ["serve"], revision: "v1" });
    expect(onProvider).toHaveBeenLastCalledWith("cursortouch");
    expect(screen.getByRole("status").textContent).toContain("重新连接");
  });

  it("rejects non-string arguments without changing config", async () => {
    setup();
    await waitFor(() => expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("启动参数（JSON 字符串数组）"), { target: { value: "[123]" } });
    fireEvent.click(screen.getByRole("button", { name: "应用 MCP 选择" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("JSON"));
    expect(setWindowsControlMcp).not.toHaveBeenCalled();
  });

  it("blocks provider changes while the native config editor has pending edits", async () => {
    setup(true);
    await waitFor(() => expect(getWindowsControlMcp).toHaveBeenCalledOnce());
    expect((screen.getByRole("button", { name: "应用 MCP 选择" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(true);
  });

  it("keeps failures visible without claiming the switch succeeded", async () => {
    vi.mocked(setWindowsControlMcp).mockRejectedValue(new Error("Configuration changed"));
    const { onSaved } = setup();
    await waitFor(() => expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "应用 MCP 选择" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Configuration changed"));
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
