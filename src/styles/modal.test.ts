// @ts-nocheck -- Node types are intentionally not enabled for the frontend project.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("modal surface styles", () => {
  const dsModalCss = readFileSync(new URL("./ds-modal.css", import.meta.url), "utf8");
  const settingsCss = readFileSync(new URL("./settings.css", import.meta.url), "utf8");
  const updateToastCss = readFileSync(new URL("./update-toasts.css", import.meta.url), "utf8");
  const sidebarCss = readFileSync(new URL("./sidebar.css", import.meta.url), "utf8");
  const gitInitCss = readFileSync(new URL("./git-init-modal.css", import.meta.url), "utf8");
  const branchSwitcherCss = readFileSync(new URL("./branch-switcher-modal.css", import.meta.url), "utf8");
  const workspaceFromUrlCss = readFileSync(new URL("./workspace-from-url-modal.css", import.meta.url), "utf8");
  const mobileRemoteCss = readFileSync(new URL("./mobile-remote-workspace-modal.css", import.meta.url), "utf8");
  const mobileSetupCss = readFileSync(new URL("./mobile-setup-wizard.css", import.meta.url), "utf8");
  const composerCss = readFileSync(new URL("./composer.css", import.meta.url), "utf8");

  it("centers ModalShell cards on the shared desktop dialog surface", () => {
    expect(dsModalCss).toMatch(
      /\.ds-modal\s*\{[^}]*display:\s*grid;[^}]*place-items:\s*center;[^}]*padding:\s*24px;/s,
    );
    expect(dsModalCss).toMatch(
      /\.ds-modal-backdrop\s*\{[^}]*background:\s*transparent;[^}]*backdrop-filter:\s*none;[^}]*-webkit-backdrop-filter:\s*none;/s,
    );
    expect(dsModalCss).toMatch(
      /\.ds-modal-card,\s*\.ds-modal-surface\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--cm-panel-bg\) 94%, var\(--cm-main-bg\) 6%\);[^}]*border:\s*1px solid var\(--cm-panel-border\);[^}]*box-shadow:\s*var\(--cm-elevation-shadow\);/s,
    );
    expect(dsModalCss).toMatch(
      /\.ds-modal-card\s*\{[^}]*width:\s*min\(520px, calc\(100vw - 48px\)\);[^}]*padding:\s*18px;[^}]*border-radius:\s*18px;/s,
    );
  });

  it("routes modal controls through active shell tokens", () => {
    expect(dsModalCss).toMatch(
      /\.ds-modal-input,\s*\.ds-modal-textarea\s*\{[^}]*border:\s*1px solid var\(--cm-control-border\);[^}]*background:\s*var\(--cm-control-bg\);[^}]*color:\s*var\(--cm-text-strong\);/s,
    );
    expect(dsModalCss).toMatch(
      /\.ds-modal-button\.secondary,\s*\.ds-modal-button\.ghost\s*\{[^}]*border:\s*1px solid var\(--cm-control-border\);[^}]*background:\s*var\(--cm-control-bg\);[^}]*color:\s*var\(--cm-text-primary\);/s,
    );
    expect(dsModalCss).toMatch(
      /\.ds-modal-error\s*\{[^}]*color:\s*color-mix\(in srgb, var\(--status-error\) 72%, var\(--cm-text-strong\)\);[^}]*background:\s*color-mix\(in srgb, var\(--status-error\) 14%, var\(--cm-panel-bg\)\);/s,
    );
  });

  it("keeps feature modals from redefining shared card chrome", () => {
    expect(updateToastCss).not.toMatch(/\.update-dialog-card\s*\{[^}]*background:/s);
    expect(updateToastCss).not.toMatch(/\.update-dialog-card\s*\{[^}]*box-shadow:/s);
    expect(gitInitCss).not.toContain(".git-init-modal .ds-modal-backdrop");
    expect(gitInitCss).not.toMatch(/\.git-init-modal \.ds-modal-card\s*\{[^}]*background:/s);
    expect(workspaceFromUrlCss).not.toMatch(/\.workspace-from-url-modal-card\s*\{[^}]*background:/s);
    expect(mobileRemoteCss).not.toMatch(/\.mobile-remote-workspace-modal-card\s*\{[^}]*background:/s);
    expect(mobileSetupCss).not.toContain(".mobile-setup-wizard-overlay .ds-modal-backdrop");
    expect(composerCss).not.toMatch(/\.workflow-gate-binding-modal \.ds-modal-card\s*\{[^}]*border-radius:/s);
    expect(branchSwitcherCss).toMatch(
      /\.branch-switcher-modal \.ds-modal-card\s*\{[^}]*padding:\s*0;[^}]*overflow:\s*hidden;/s,
    );
  });

  it("keeps settings sub-dialogs on the shared modal layer and palette", () => {
    expect(settingsCss).toMatch(
      /\.settings-overlay\s*\{[^}]*z-index:\s*var\(--ds-layer-modal,\s*40\);/s,
    );
    expect(settingsCss).toMatch(
      /\.settings-add-remote-overlay\s*\{[^}]*z-index:\s*var\(--ds-layer-modal,\s*40\);/s,
    );
    expect(settingsCss).not.toContain("background: #141b27");
    expect(settingsCss).not.toContain("box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55)");
    expect(settingsCss).toMatch(
      /\.settings-add-remote-card \.settings-input\s*\{[^}]*background:\s*var\(--cm-control-bg\);[^}]*border-color:\s*var\(--cm-control-border\);/s,
    );
  });

  it("keeps destructive session dialogs on danger semantics", () => {
    expect(sidebarCss).toMatch(
      /\.session-delete-modal \.ds-modal-button\.primary\s*\{[^}]*var\(--status-danger,\s*var\(--status-warning\)\)[^}]*background:\s*color-mix\(in srgb, var\(--status-danger,\s*var\(--status-warning\)\) 82%, var\(--cm-panel-bg\)\);/s,
    );
    expect(sidebarCss).toMatch(
      /\.session-delete-modal \.ds-modal-button\.primary:hover:not\(:disabled\),\s*\.session-delete-modal \.ds-modal-button\.primary:focus-visible\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--status-danger,\s*var\(--status-warning\)\) 92%, var\(--cm-panel-bg\)\);/s,
    );
  });
});
