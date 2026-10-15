// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppSettings } from "@/types";
import { SettingsArtifactStorage } from "./SettingsArtifactStorage";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function setup(settings: Partial<AppSettings> = {}, update = vi.fn(async (_next: AppSettings) => {})) {
  const appSettings = { backendMode: "local", artifactRoot: null, ...settings } as AppSettings;
  const view = render(<SettingsArtifactStorage appSettings={appSettings} onUpdateAppSettings={update} />);
  return { ...view, appSettings, update };
}

describe("SettingsArtifactStorage", () => {
  it("saves a chosen path explicitly and preserves other settings", async () => {
    vi.mocked(open).mockResolvedValue("D:\\AgentArtifacts");
    const { update, appSettings } = setup({ theme: "dark" });
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "浏览" }));
    await waitFor(() => expect((screen.getByLabelText("任务产物目录") as HTMLInputElement).value).toBe("D:\\AgentArtifacts"));
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ ...appSettings, artifactRoot: "D:\\AgentArtifacts" }));
  });

  it("restores the host default only after saving", async () => {
    const { update, appSettings } = setup({ artifactRoot: "D:\\OldArtifacts" });
    fireEvent.click(screen.getByRole("button", { name: "使用默认目录" }));
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ ...appSettings, artifactRoot: null }));
  });

  it("keeps a failed draft and shows the save error", async () => {
    const update = vi.fn(async (_next: AppSettings) => { throw new Error("Directory unavailable"); });
    setup({}, update);
    fireEvent.change(screen.getByLabelText("任务产物目录"), { target: { value: "D:\\Unavailable" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Directory unavailable");
    expect((screen.getByLabelText("任务产物目录") as HTMLInputElement).value).toBe("D:\\Unavailable");
  });

  it("allows manual remote paths without offering the local picker", async () => {
    const { update } = setup({ backendMode: "remote" });
    expect((screen.getByRole("button", { name: "浏览" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("任务产物目录"), { target: { value: " /srv/artifacts " } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ artifactRoot: "/srv/artifacts" })));
  });
});
