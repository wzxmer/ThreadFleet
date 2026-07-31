// @ts-nocheck -- Node types are intentionally not enabled for the frontend project.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("toast and update dialog theme styles", () => {
  const tokenCss = readFileSync(new URL("./ds-tokens.css", import.meta.url), "utf8");
  const dsToastCss = readFileSync(new URL("./ds-toast.css", import.meta.url), "utf8");
  const updateToastCss = readFileSync(new URL("./update-toasts.css", import.meta.url), "utf8");
  const approvalToastCss = readFileSync(new URL("./approval-toasts.css", import.meta.url), "utf8");
  const errorToastCss = readFileSync(new URL("./error-toasts.css", import.meta.url), "utf8");
  const repairDialogSource = readFileSync(
    new URL("../features/update/components/WindowsInstallerRepairDialog.tsx", import.meta.url),
    "utf8",
  );
  const migrationDialogSource = readFileSync(
    new URL("../features/update/components/WindowsInstallerMigrationDialog.tsx", import.meta.url),
    "utf8",
  );

  it("routes toast surfaces through the active light or dark shell palette", () => {
    expect(tokenCss).toContain(
      "--ds-toast-bg: color-mix(in srgb, var(--cm-panel-bg) 92%, var(--cm-main-bg) 8%);",
    );
    expect(tokenCss).toContain("--ds-toast-border: var(--cm-panel-border);");
    expect(tokenCss).toContain("--ds-toast-shadow: var(--cm-elevation-shadow);");
    expect(tokenCss).toContain("--ds-toast-title: var(--cm-text-strong);");
    expect(tokenCss).toContain("--ds-toast-body: var(--cm-text-primary);");
  });

  it("gives toast cards the upgraded floating desktop surface", () => {
    expect(dsToastCss).toMatch(
      /\.ds-toast-card\s*\{[^}]*border-radius:\s*18px;[^}]*padding:\s*16px;[^}]*color:\s*var\(--ds-toast-body\);[^}]*backdrop-filter:\s*blur\(18px\);/s,
    );
    expect(dsToastCss).toMatch(
      /\.ds-toast-error\s*\{[^}]*border:\s*1px solid var\(--cm-panel-border\);[^}]*background:\s*color-mix\(in srgb, var\(--cm-main-bg\) 86%, var\(--cm-panel-bg\) 14%\);/s,
    );
  });

  it("keeps update dialogs scoped away from settings modals", () => {
    expect(repairDialogSource).toContain('className="update-dialog-modal"');
    expect(repairDialogSource).toContain('cardClassName="update-dialog-card"');
    expect(repairDialogSource).not.toContain("CARD_STYLE");
    expect(migrationDialogSource).toContain('className="update-dialog-modal"');
    expect(migrationDialogSource).toContain('cardClassName="update-dialog-card"');
    expect(migrationDialogSource).not.toContain("DIALOG_STYLE");
    expect(updateToastCss).toMatch(
      /\.update-dialog-card\s*\{[^}]*width:\s*min\(560px, calc\(100vw - 40px\)\);[^}]*max-height:\s*min\(680px, calc\(100vh - 40px\)\);[^}]*overflow:\s*hidden;/s,
    );
    expect(updateToastCss).not.toMatch(/\.update-dialog-card\s*\{[^}]*background:/s);
    expect(updateToastCss).not.toMatch(/\.update-dialog-card\s*\{[^}]*box-shadow:/s);
  });

  it("themes update and approval action buttons in both color modes", () => {
    expect(updateToastCss).toMatch(
      /\.update-toast-actions \.secondary\s*\{[^}]*background:\s*var\(--cm-control-bg\);[^}]*color:\s*var\(--cm-text-primary\);/s,
    );
    expect(approvalToastCss).toMatch(
      /\.approval-toast-actions \.secondary,\s*\.approval-toast-actions \.ghost\s*\{[^}]*background:\s*var\(--cm-control-bg\);[^}]*color:\s*var\(--cm-text-primary\);/s,
    );
  });

  it("keeps error toasts on the shared upgraded toast primitive", () => {
    expect(errorToastCss).toContain("var(--ds-toast-bg)");
    expect(errorToastCss).toContain("var(--ds-toast-border)");
  });
});
