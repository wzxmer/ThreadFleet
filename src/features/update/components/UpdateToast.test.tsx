// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateState } from "../hooks/useUpdater";
import { I18nProvider } from "@/features/i18n/I18nProvider";
import {
  applyWindowsInstallerRepair,
  previewWindowsInstallerRepair,
  rollbackWindowsInstallerRepair,
} from "@services/tauri";
import { UpdateToast } from "./UpdateToast";
import { CodexCliUpdateToast } from "./CodexCliUpdateToast";
import { WindowsUiUpdateToast } from "./WindowsUiUpdateToast";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

vi.mock("@services/tauri", () => ({
  previewWindowsInstallerRepair: vi.fn(),
  applyWindowsInstallerRepair: vi.fn(),
  rollbackWindowsInstallerRepair: vi.fn(),
}));

const openUrlMock = vi.mocked(openUrl);
const previewRepairMock = vi.mocked(previewWindowsInstallerRepair);
const applyRepairMock = vi.mocked(applyWindowsInstallerRepair);
const rollbackRepairMock = vi.mocked(rollbackWindowsInstallerRepair);

function renderUpdateToast(element: ReactElement) {
  return render(<I18nProvider preference="en">{element}</I18nProvider>);
}

describe("UpdateToast", () => {
  const mcpCheck = {
    status: "available" as const, installed: true, managed: true, currentVersion: "1.3.28",
    release: { version: "1.3.29", releaseUrl: "https://github.com/sbroenne/mcp-windows/releases/tag/v1.3.29", assetSize: 100, assetSha256: "a".repeat(64) }, reasonCode: null,
  };

  it.each(["checking", "upToDate"] as const)("hides %s results for all three updaters", (stage) => {
    renderUpdateToast(<>
      <UpdateToast state={{ stage }} onUpdate={vi.fn()} onDismiss={vi.fn()} />
      <CodexCliUpdateToast state={{ stage }} onDetails={vi.fn()} onDismiss={vi.fn()} onRetry={vi.fn()} />
      <WindowsUiUpdateToast state={{ stage }} onInstall={vi.fn()} onDismiss={vi.fn()} />
    </>);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("stacks all three available updates in one viewport and confirms MCP installation", () => {
    const install = vi.fn();
    renderUpdateToast(<UpdateToast state={{ stage: "available", version: "0.8.0" }} onUpdate={vi.fn()} onDismiss={vi.fn()}
      additionalToast={<>
        <CodexCliUpdateToast state={{ stage: "available" }} onDetails={vi.fn()} onDismiss={vi.fn()} onRetry={vi.fn()} />
        <WindowsUiUpdateToast state={{ stage: "available", check: mcpCheck }} onInstall={install} onDismiss={vi.fn()} />
      </>} />);
    expect(screen.getAllByRole("region")).toHaveLength(1);
    expect(screen.getAllByRole("status")).toHaveLength(3);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Install update" }));
    expect(install).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Install windows-ui update?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Download and install" }));
    expect(install).toHaveBeenCalledOnce();
  });

  it("offers release review for a patched MCP without an install action", () => {
    renderUpdateToast(<WindowsUiUpdateToast state={{ stage: "available", check: { ...mcpCheck, managed: false, reasonCode: "localPatchRequiresReview" } }} onInstall={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByText(/local patched version/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install update" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View on GitHub" }));
    expect(openUrlMock).toHaveBeenCalledWith(mcpCheck.release.releaseUrl);
  });

  it("stacks CLI progress with the app update in one nonmodal viewport", () => {
    const onDetails = vi.fn();
    const onDismissCli = vi.fn();
    renderUpdateToast(<UpdateToast state={{ stage: "available", version: "1.2.3" }} onUpdate={vi.fn()} onDismiss={vi.fn()}
      additionalToast={<CodexCliUpdateToast state={{ stage: "installing", progress: { downloadedBytes: 50, totalBytes: 100, phase: "downloading", route: "system-proxy" } }}
        onDetails={onDetails} onDismiss={onDismissCli} onRetry={vi.fn()} />} />);
    expect(screen.getAllByRole("region")).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
    expect(screen.getByText(/System proxy/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View details" }));
    expect(onDetails).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismissCli).toHaveBeenCalledOnce();
  });

  it("shows a CLI result even when the app has no update", () => {
    renderUpdateToast(<UpdateToast state={{ stage: "idle" }} onUpdate={vi.fn()} onDismiss={vi.fn()}
      additionalToast={<CodexCliUpdateToast state={{ stage: "updated", installedVersion: "0.163.0" }}
        onDetails={vi.fn()} onDismiss={vi.fn()} onRetry={vi.fn()} />} />);
    expect(screen.getByText("Codex CLI update")).toBeTruthy();
    expect(screen.getByText("0.163.0")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    previewRepairMock.mockResolvedValue({
      status: "blocked",
      fingerprint: null,
      currentVersion: "0.7.91",
      records: [],
      blockers: ["An unverifiable legacy shortcut (.lnk) exists."],
      plannedActions: [],
    });
    applyRepairMock.mockResolvedValue({ status: "unsupported" });
    rollbackRepairMock.mockResolvedValue({ status: "unsupported" });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders available state and handles actions", () => {
    const onUpdate = vi.fn();
    const onDismiss = vi.fn();
    const state: UpdateState = { stage: "available", version: "1.2.3" };

    renderUpdateToast(
      <UpdateToast state={state} onUpdate={onUpdate} onDismiss={onDismiss} />,
    );

    const region = screen.getByRole("region");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getAllByText("Update")).toHaveLength(2);
    expect(screen.getByText("v1.2.3")).toBeTruthy();
    expect(screen.getByText("A new version is available.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("renders downloading state with progress", () => {
    const state: UpdateState = {
      stage: "downloading",
      progress: { totalBytes: 1000, downloadedBytes: 500 },
    };

    const { container } = renderUpdateToast(
      <UpdateToast state={state} onUpdate={vi.fn()} onDismiss={vi.fn()} />,
    );

    expect(screen.getByText(/Downloading update/)).toBeTruthy();
    expect(screen.getByText("500 B / 1000 B")).toBeTruthy();
    const fill = container.querySelector(".update-toast-progress-fill");
    expect(fill).toBeTruthy();
    if (!fill) {
      throw new Error("Expected progress fill element");
    }
    expect(fill.getAttribute("style")).toContain("width: 50%");
  });

  it("renders an empty progress bar before the first downloaded byte", () => {
    const state: UpdateState = {
      stage: "downloading",
      progress: { totalBytes: 24 * 1024 * 1024, downloadedBytes: 0 },
    };

    const { container } = renderUpdateToast(
      <UpdateToast state={state} onUpdate={vi.fn()} onDismiss={vi.fn()} />,
    );

    expect(screen.getByText("0 B / 24 MB")).toBeTruthy();
    expect(
      container.querySelector(".update-toast-progress-fill")?.getAttribute("style"),
    ).toContain("width: 0%");
  });

  it("localizes backend installer errors in the Chinese update prompt", () => {
    render(
      <I18nProvider preference="zh">
        <UpdateToast
          state={{ stage: "error", error: "No compatible installer asset found in the latest release." }}
          onUpdate={vi.fn()}
          onDismiss={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(screen.getByText("该版本没有适用于当前系统的安装包。")).toBeTruthy();
    expect(screen.queryByText(/No compatible installer/)).toBeNull();
  });

  it("renders error state and lets you dismiss or retry", () => {
    const onUpdate = vi.fn();
    const onDismiss = vi.fn();
    const state: UpdateState = {
      stage: "error",
      error: "Network error",
    };

    renderUpdateToast(
      <UpdateToast state={state} onUpdate={onUpdate} onDismiss={onDismiss} />,
    );

    expect(screen.getByText("Update failed.")).toBeTruthy();
    expect(screen.getByText("Could not reach the update service. Check your network or proxy settings and retry.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("opens the safe repair preview for a mixed-installer block", async () => {
    const state: UpdateState = {
      stage: "error",
      errorCode: "mixedInstaller",
    };

    renderUpdateToast(
      <UpdateToast
        state={state}
        onUpdate={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/Both MSI and EXE installer records were detected/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View repair" }));
    expect(
      await screen.findByRole("dialog", { name: "Repair Windows installer state" }),
    ).toBeTruthy();
    expect(await screen.findByText(/unverifiable legacy \.lnk shortcut/)).toBeTruthy();
    expect(previewRepairMock).toHaveBeenCalledTimes(1);
  });

  it("renders post-update loading notice and dismisses", () => {
    const onDismissPostUpdateNotice = vi.fn();
    const state: UpdateState = { stage: "idle" };

    const { container } = renderUpdateToast(
      <UpdateToast
        state={state}
        onUpdate={vi.fn()}
        onDismiss={vi.fn()}
        postUpdateNotice={{
          stage: "loading",
          version: "1.2.3",
          htmlUrl: "https://github.com/wzxmer/ThreadFleet/releases/tag/v1.2.3",
        }}
        onDismissPostUpdateNotice={onDismissPostUpdateNotice}
      />,
    );
    const scoped = within(container);

    expect(scoped.getByText("What's New")).toBeTruthy();
    expect(scoped.getByText(/Loading release notes/i)).toBeTruthy();
    fireEvent.click(scoped.getByRole("button", { name: "Dismiss" }));
    expect(onDismissPostUpdateNotice).toHaveBeenCalledTimes(1);
  });

  it("renders post-update release notes and opens GitHub link", () => {
    const onDismissPostUpdateNotice = vi.fn();
    const htmlUrl =
      "https://github.com/wzxmer/ThreadFleet/releases/tag/v1.2.3";
    const state: UpdateState = { stage: "idle" };

    const { container } = renderUpdateToast(
      <UpdateToast
        state={state}
        onUpdate={vi.fn()}
        onDismiss={vi.fn()}
        postUpdateNotice={{
          stage: "ready",
          version: "1.2.3",
          body: "## Highlights\n- Added release notes toast",
          htmlUrl,
        }}
        onDismissPostUpdateNotice={onDismissPostUpdateNotice}
      />,
    );
    const scoped = within(container);

    expect(scoped.getByText("Highlights")).toBeTruthy();
    expect(scoped.getByText("Added release notes toast")).toBeTruthy();

    fireEvent.click(scoped.getByRole("button", { name: "View on GitHub" }));
    expect(openUrlMock).toHaveBeenCalledWith(htmlUrl);

    fireEvent.click(scoped.getByRole("button", { name: "Dismiss" }));
    expect(onDismissPostUpdateNotice).toHaveBeenCalledTimes(1);
  });

  it("renders post-update fallback notice", () => {
    const htmlUrl =
      "https://github.com/wzxmer/ThreadFleet/releases/tag/v1.2.3";
    const state: UpdateState = { stage: "available", version: "9.9.9" };

    const { container } = renderUpdateToast(
      <UpdateToast
        state={state}
        onUpdate={vi.fn()}
        onDismiss={vi.fn()}
        postUpdateNotice={{
          stage: "fallback",
          version: "1.2.3",
          htmlUrl,
        }}
      />,
    );
    const scoped = within(container);

    expect(
      scoped.getByText("Updated to v1.2.3. Release notes could not be loaded."),
    ).toBeTruthy();
    fireEvent.click(scoped.getByRole("button", { name: "View on GitHub" }));
    expect(openUrlMock).toHaveBeenCalledWith(htmlUrl);
    expect(scoped.queryByText("A new version is available.")).toBeNull();
  });

  it("renders localized update text in the default language", () => {
    render(
      <UpdateToast
        state={{ stage: "available", version: "1.2.3" }}
        onUpdate={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getAllByText("更新")).toHaveLength(2);
    expect(screen.getByText("发现新版本。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "稍后" })).toBeTruthy();
  });
});
