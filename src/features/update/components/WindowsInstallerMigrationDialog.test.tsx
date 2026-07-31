// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/features/i18n/I18nProvider";
import { executeWindowsInstallerMigration } from "@services/tauri";
import { WindowsInstallerMigrationDialog } from "./WindowsInstallerMigrationDialog";

vi.mock("@services/tauri", () => ({
  executeWindowsInstallerMigration: vi.fn(),
}));

const executeMock = vi.mocked(executeWindowsInstallerMigration);
const targetVersion = "2026.07.29-enterprise-long-version-label";

describe("WindowsInstallerMigrationDialog", () => {
  beforeEach(() => {
    executeMock.mockReset();
  });
  afterEach(cleanup);

  it("requires explicit acknowledgement and renders the verified completion", async () => {
    executeMock.mockResolvedValue({
      status: "completed",
      diagnosticCode: "completed",
      rebootRequired: false,
    });
    render(
      <I18nProvider preference="en">
        <WindowsInstallerMigrationDialog
          open
          targetVersion={targetVersion}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    const start = screen.getByRole("button", {
      name: "Start migration",
    }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(screen.getByText(/2026\.07\.29-enterprise/)).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox"));
    expect(start.disabled).toBe(false);
    fireEvent.click(start);

    await waitFor(() =>
      expect(
        screen.getByText("Migration completed and passed local verification."),
      ).toBeTruthy(),
    );
    expect(executeMock).toHaveBeenCalledWith();
  });

  it("keeps close disabled while the migration call is pending", async () => {
    let finish:
      | ((value: {
          status: "completed";
          diagnosticCode: "completed";
          rebootRequired: false;
        }) => void)
      | undefined;
    executeMock.mockImplementation(
      () => new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(
      <I18nProvider preference="en">
        <WindowsInstallerMigrationDialog
          open
          targetVersion={targetVersion}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Start migration" }));

    expect(
      (screen.getByRole("button", { name: "Close" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/Migrating and verifying/)).toBeTruthy();
    finish?.({
      status: "completed",
      diagnosticCode: "completed",
      rebootRequired: false,
    });
    await waitFor(() => expect(screen.getByText(/passed local verification/)).toBeTruthy());
  });

  it("labels a backend-bound restart as recovery", () => {
    render(
      <I18nProvider preference="en">
        <WindowsInstallerMigrationDialog
          open
          recoveryMode
          targetVersion={targetVersion}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByText(/incomplete installer migration was detected/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume migration" })).toBeTruthy();
  });
});
