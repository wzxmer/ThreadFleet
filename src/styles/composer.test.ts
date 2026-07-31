// @ts-nocheck -- Node types are intentionally not enabled for the frontend project.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("composer select interaction styles", () => {
  const composerCss = readFileSync(new URL("./composer.css", import.meta.url), "utf8");

  it("uses a single background-only hover state on select pills", () => {
    const hoverRule = composerCss.match(
      /\.composer-select-wrap:has\(\.composer-select-trigger:hover:not\(:disabled\)\)\s*\{([\s\S]*?)\n\}/,
    );

    expect(hoverRule).not.toBeNull();
    expect(hoverRule?.[1]).toContain("background:");
    expect(hoverRule?.[1]).not.toContain("transform:");
    expect(hoverRule?.[1]).not.toContain("box-shadow:");
  });

  it("prevents inner triggers and the refresh action from inheriting elevation", () => {
    expect(composerCss).toContain(".composer-select-trigger:hover:not(:disabled)");
    expect(composerCss).toContain(".composer-select-trigger:active:not(:disabled)");
    expect(composerCss).toContain(".composer-model-refresh:active:not(:disabled)");

    const elevationOverrides = composerCss.match(/transform: none;\s*box-shadow: none;/g);
    expect(elevationOverrides?.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps the model caret clear of refresh and fast controls", () => {
    expect(composerCss).toContain(
      ".composer-select-wrap--model:has(.composer-model-refresh):not(:has(.composer-fast-indicator))::after",
    );
    expect(composerCss).toContain(
      ".composer-select-wrap--model:has(.composer-model-refresh):has(.composer-fast-indicator)::after",
    );
  });

  it("allows light conversation presets to override only the input surface", () => {
    expect(composerCss).toContain(
      "background: var(--composer-input-background, var(--cm-surface-panel-elevated));",
    );
  });

  it("aligns the composer to the dedicated conversation reading width", () => {
    expect(composerCss).toMatch(
      /\.composer\s*\{[^}]*padding:\s*10px var\(--main-panel-padding\) 18px;/s,
    );
    expect(composerCss).not.toMatch(
      /\.composer\s*\{[^}]*--conversation-reading-width:/s,
    );
    const composerRule = composerCss.match(/(?:^|\n)\.composer\s*\{([\s\S]*?)\n\}/);
    expect(composerRule?.[1]).not.toContain("border-top");
    expect(composerCss).toContain(
      "width: min(100%, var(--conversation-reading-width, 920px));",
    );
    expect(composerCss).not.toContain(
      "width: min(100%, var(--conversation-column-width, 900px));",
    );
  });

  it("lets model and reasoning popovers escape the composer surface", () => {
    expect(composerCss).toMatch(
      /\.composer-surface\s*\{[^}]*overflow:\s*visible;/s,
    );
    expect(composerCss).toMatch(
      /\.composer-model-select-popover\s*\{[^}]*z-index:\s*90;/s,
    );
    expect(composerCss).toMatch(
      /\.composer-select-wrap--effort \.ds-rounded-select-popover\s*\{[^}]*z-index:\s*90;/s,
    );
  });

  it("keeps dark composer rules but lets the light theme override them", () => {
    expect(composerCss).toMatch(
      /\.app:is\(\.layout-desktop, \.layout-tablet\) \.composer \.composer-surface\s*\{[^}]*background:\s*#171c21;[^}]*box-shadow:\s*none;/s,
    );
    expect(composerCss).toMatch(
      /\.app:is\(\.layout-desktop, \.layout-tablet\) \.composer \.composer-bar\s*\{[^}]*background:\s*#151a1f;/s,
    );
    expect(composerCss).toMatch(
      /\.app:is\(\.layout-desktop, \.layout-tablet\) \.composer textarea::placeholder\s*\{[^}]*color:\s*#71808a;/s,
    );
    expect(composerCss).toMatch(
      /\.app:is\(\.layout-desktop, \.layout-tablet\) \.composer \.composer-attach,\s*\.app:is\(\.layout-desktop, \.layout-tablet\) \.composer \.composer-action\s*\{[^}]*background:\s*#20262c;[^}]*color:\s*#a5b0b7;/s,
    );
    expect(composerCss).toMatch(
      /\.app:is\(\.layout-desktop, \.layout-tablet\) \.composer \.composer-attach:disabled,\s*\.app:is\(\.layout-desktop, \.layout-tablet\) \.composer \.composer-action:disabled,\s*\.app:is\(\.layout-desktop, \.layout-tablet\) \.composer \.composer-action\.is-disabled\s*\{[^}]*opacity:\s*1;[^}]*background:\s*#15191e;/s,
    );
    expect(composerCss).toMatch(
      /:root:not\(\[data-theme\]\) \.app:is\(\.layout-desktop, \.layout-tablet\) \.composer,\s*:root\[data-theme="light"\] \.app:is\(\.layout-desktop, \.layout-tablet\) \.composer\s*\{[^}]*background:\s*var\(--cm-light-main-bg\);/s,
    );
    expect(composerCss).toMatch(
      /:root:not\(\[data-theme\]\) \.app:is\(\.layout-desktop, \.layout-tablet\) \.composer \.composer-surface,\s*:root\[data-theme="light"\] \.app:is\(\.layout-desktop, \.layout-tablet\) \.composer \.composer-surface\s*\{[^}]*background:\s*var\(--cm-light-panel-bg\);/s,
    );
  });

  it("keeps an unknown context track distinct from the input border", () => {
    const inputRule = composerCss.match(
      /(?:^|\n)\.composer-input-area\s*\{([\s\S]*?)\n\}/,
    );
    const unknownRule = composerCss.match(
      /\.composer-input-area\.is-context-unknown \.composer-context-progress-value\s*\{([\s\S]*?)\n\}/,
    );

    const surfaceRule = composerCss.match(
      /(?:^|\n)\.composer-surface\s*\{([\s\S]*?)\n\}/,
    );
    expect(surfaceRule?.[1]).toContain("border: 1px solid var(--cm-border-heavy)");
    expect(inputRule?.[1]).toContain("border: 0");
    expect(unknownRule?.[1]).toContain("stroke: var(--text-dim)");
    expect(unknownRule?.[1]).toContain("opacity: 1");
    expect(composerCss).toContain(".composer-context-cycle-track > span");
    expect(composerCss).toContain(
      "stroke: color-mix(in srgb, var(--composer-context-color) 82%, var(--text-muted));",
    );
    expect(composerCss).toContain(".composer-context-cycle-track > span.is-compacting");
    expect(composerCss).toContain(".composer-context-count.is-compacting");
  });

  it("keeps warning and danger context indicators semantic without a loud top border", () => {
    const trackRule = composerCss.match(
      /\.composer-context-cycle-track\s*\{([\s\S]*?)\n\}/,
    );
    const compactingTrackRule = composerCss.match(
      /\.composer-input-area\.is-context-compacting \.composer-context-cycle-track\s*\{([\s\S]*?)\n\}/,
    );

    expect(trackRule?.[1]).toContain("display: none");
    expect(trackRule?.[1]).toContain("height: 1px");
    expect(compactingTrackRule?.[1]).toContain("display: block");
    expect(composerCss).toMatch(
      /\.composer-context-cycle-track > span\.is-compacting\s*\{[^}]*width:\s*100%;[^}]*color-mix\(in srgb, var\(--composer-context-color\) 44%, transparent\)/s,
    );
    expect(composerCss).not.toContain(
      ".composer-input-area.is-context-danger .composer-context-cycle-track > span",
    );
    expect(composerCss).toMatch(
      /\.composer-input-area\.is-context-warning \.composer-context-count\s*\{[^}]*color:\s*color-mix\(in srgb, var\(--status-warning\) 74%, var\(--text-muted\)\);/s,
    );
  });

  it("moves input behavior settings into a compact header-ready menu", () => {
    expect(composerCss).toMatch(
      /\.composer-input-settings-trigger\s*\{[^}]*max-width:\s*178px;[^}]*border-radius:\s*var\(--cm-radius-control,\s*10px\);/s,
    );
    expect(composerCss).toMatch(
      /\.composer-input-settings\.is-header \.composer-input-settings-popover\s*\{[^}]*top:\s*calc\(100% \+ 8px\);[^}]*bottom:\s*auto;/s,
    );
    expect(composerCss).toMatch(
      /\.app\.layout-desktop \.composer-input-settings-trigger\s*\{[^}]*background:\s*#20262c;[^}]*color:\s*#a5b0b7;/s,
    );
    expect(composerCss).toMatch(
      /\.app\.layout-desktop \.composer-input-settings-popover\s*\{[^}]*background:\s*#15191e;/s,
    );
    expect(composerCss).toMatch(
      /:root:not\(\[data-theme\]\) \.app\.layout-desktop \.composer-input-settings-trigger,\s*:root\[data-theme="light"\] \.app\.layout-desktop \.composer-input-settings-trigger\s*\{[^}]*background:\s*var\(--cm-light-control-bg\);[^}]*color:\s*var\(--cm-light-text-primary\);/s,
    );
    expect(composerCss).toMatch(
      /:root:not\(\[data-theme\]\) \.app\.layout-desktop \.composer-input-settings-popover,\s*:root\[data-theme="light"\] \.app\.layout-desktop \.composer-input-settings-popover\s*\{[^}]*background:\s*var\(--cm-light-panel-bg\);/s,
    );
  });

  it("uses unified desktop control radii instead of making toolbar controls pill-shaped", () => {
    expect(composerCss).toMatch(
      /\.composer-surface\s*\{[^}]*border-radius:\s*var\(--cm-radius-pane,\s*16px\);/s,
    );
    expect(composerCss).toMatch(
      /\.composer-action\s*\{[^}]*border-radius:\s*var\(--cm-radius-control,\s*10px\);/s,
    );
    expect(composerCss).toMatch(
      /\.composer-attach\s*\{[^}]*border-radius:\s*var\(--cm-radius-control,\s*10px\);/s,
    );
    expect(composerCss).toMatch(
      /\.composer-select-wrap\s*\{[^}]*border-radius:\s*var\(--cm-radius-control,\s*10px\);/s,
    );
    expect(composerCss).toMatch(
      /\.composer-auto-reconnect\s*\{[^}]*border-radius:\s*var\(--cm-radius-control,\s*10px\);/s,
    );
  });

  it("lets the input grow until capped and pins composer actions to the lower right", () => {
    expect(composerCss).toMatch(
      /\.composer-input-row\s*\{[^}]*align-items:\s*stretch;/s,
    );
    expect(composerCss).toMatch(
      /\.composer-input-actions\s*\{[^}]*align-self:\s*flex-end;[^}]*padding:\s*0 2px 4px 8px;/s,
    );
    expect(composerCss).toMatch(
      /\.composer textarea\s*\{[^}]*min-height:\s*24px;[^}]*max-height:\s*var\(--composer-textarea-max-height,\s*160px\);[^}]*height:\s*24px;[^}]*overflow-y:\s*hidden;/s,
    );
    expect(composerCss).toMatch(
      /\.composer-input-resize-handle\s*\{[^}]*cursor:\s*ns-resize;[^}]*touch-action:\s*none;/s,
    );
    expect(composerCss).toContain(".composer textarea.is-scrollable");
    expect(composerCss).toContain(".composer textarea::-webkit-scrollbar-thumb");
  });

  it("keeps composer primary and secondary controls on one aligned toolbar row when space allows", () => {
    expect(composerCss).toMatch(
      /\.composer-meta\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*space-between;[^}]*flex-wrap:\s*wrap;/s,
    );
    expect(composerCss).toMatch(
      /\.composer-meta-secondary\s*\{[^}]*flex:\s*0 0 auto;[^}]*margin-left:\s*auto;/s,
    );
    expect(composerCss).toMatch(
      /\.composer-meta-secondary \.composer-workflow-gate,\s*\.composer-meta-secondary \.composer-auto-reconnect\s*\{[^}]*margin-left:\s*0;/s,
    );
  });

  it("lets text attachments use the composer width and wrap controls when needed", () => {
    const textAttachmentRule = composerCss.match(
      /\.composer-attachment\.is-text-attachment\s*\{([\s\S]*?)\n\}/,
    );
    expect(textAttachmentRule?.[1]).toContain("width: min(100%, 720px)");
    expect(textAttachmentRule?.[1]).toContain("max-width: 100%");
    expect(composerCss).toContain(
      ".composer-attachment.is-text-attachment .composer-attachment-main",
    );
    expect(composerCss).toContain("flex-wrap: wrap");
    expect(composerCss).toContain(
      ".composer-attachment.is-text-attachment .composer-attachment-name",
    );
  });
});
