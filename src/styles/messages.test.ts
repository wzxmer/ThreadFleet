// @ts-nocheck -- Node types are intentionally not enabled for the frontend project.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("message tool group interaction styles", () => {
  const buttonsCss = readFileSync(
    new URL("./buttons.css", import.meta.url),
    "utf8",
  );
  const messagesCss = readFileSync(
    new URL("./messages.css", import.meta.url),
    "utf8",
  );
  const messagesSource = readFileSync(
    new URL("../features/messages/components/Messages.tsx", import.meta.url),
    "utf8",
  );
  const messageRowsSource = readFileSync(
    new URL("../features/messages/components/MessageRows.tsx", import.meta.url),
    "utf8",
  );

  it("lets composite buttons opt out of global hover and active elevation", () => {
    expect(buttonsCss).toContain(
      'button:not(:where([data-button-elevation="none"])):hover:not(:disabled)',
    );
    expect(buttonsCss).toContain(
      'button:not(:where([data-button-elevation="none"])):active:not(:disabled)',
    );
    expect(buttonsCss).not.toContain(
      'button:not([data-button-elevation="none"])',
    );
    expect(buttonsCss).not.toMatch(/^button:hover:not\(:disabled\)\s*\{/m);
    expect(buttonsCss).not.toMatch(/^button:active:not\(:disabled\)\s*\{/m);
  });

  it("marks every tool group toggle as a non-elevated composite control", () => {
    expect(messagesSource.match(/className="tool-group-toggle"/g)).toHaveLength(
      2,
    );
    expect(
      messagesSource.match(
        /className="tool-group-toggle"\s+data-button-elevation="none"/g,
      ),
    ).toHaveLength(2);
    expect(messageRowsSource).toMatch(
      /className="message-agent-process-toggle"[\s\S]*?data-button-elevation="none"/,
    );
  });

  it("does not reintroduce local elevation resets in message styles", () => {
    expect(messagesCss).not.toMatch(
      /\.tool-group-toggle:(?:hover|active)[^{]*\{[^}]*(?:transform|box-shadow)/s,
    );
  });

  it("keeps edited-message retry progress aligned without shifting actions", () => {
    expect(messagesCss).toMatch(
      /\.message-edit-resend-button\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*min-width:\s*92px;/s,
    );
    expect(messagesCss).toMatch(
      /\.message-edit-resend-spinner\s*\{[^}]*width:\s*12px;[^}]*height:\s*12px;[^}]*border-top-color:\s*currentColor;/s,
    );
  });

  it("does not keep removed reading or style switch styles", () => {
    const controlsRule = messagesCss.match(
      /\.messages-tool-controls\s*\{([\s\S]*?)\n\}/,
    );

    expect(controlsRule?.[1]).not.toMatch(
      /position:\s*(?:sticky|fixed|absolute)/,
    );
    expect(controlsRule?.[1]).not.toMatch(/\btop:/);
    expect(messagesCss).not.toContain(".messages-reading-segmented");
    expect(messagesCss).not.toContain(".messages-style-popover");
    expect(messagesCss).not.toContain(".messages-style-panel-host");
  });

  it("keeps horizontal scrolling inside wide content instead of the conversation pane", () => {
    const messagesRule = messagesCss.match(/\.messages\s*\{([\s\S]*?)\n\}/);

    expect(messagesRule?.[1]).toContain("overflow-y: auto");
    expect(messagesRule?.[1]).toContain("overflow-x: hidden");
    expect(messagesCss).toMatch(
      /\.markdown-table-wrap\s*\{[^}]*overflow-x:\s*auto;/s,
    );
  });

  it("shows complete image attachments inside square thumbnails", () => {
    expect(messagesCss).toMatch(
      /\.message-image-thumb img\s*\{[^}]*object-fit:\s*contain;/s,
    );
  });

  it("does not keep CLI reading mode styles", () => {
    expect(messagesCss).not.toContain(".messages-reading-cli");
    expect(messagesCss).not.toContain("--messages-cli-end-gutter");
    expect(messagesCss).not.toContain("data-cli-timestamp");
    expect(messagesCss).not.toContain("message-bubble-cli-timestamp-hidden");
  });

  it("anchors child result details to the chat layer and above the composer", () => {
    const drawerRule = messagesCss.match(
      /\.subagent-result-drawer\s*\{([\s\S]*?)\n\}/,
    );

    expect(drawerRule?.[1]).toContain("position: absolute");
    expect(drawerRule?.[1]).toContain("right: 12px");
    expect(drawerRule?.[1]).toContain("calc(100% - 24px)");
    expect(drawerRule?.[1]).not.toContain("100vw");
    expect(drawerRule?.[1]).toContain("--composer-overlay-height");
  });

  it("uses conversation canvas colors for the unframed child result heading", () => {
    const headerRule = messagesCss.match(
      /\.subagent-results-header\s*\{([\s\S]*?)\n\}/,
    );
    const headingRule = messagesCss.match(
      /\.subagent-results-heading\s*\{([\s\S]*?)\n\}/,
    );

    expect(headerRule?.[1]).toContain(
      "color: var(--conversation-assistant-text)",
    );
    expect(headingRule?.[1]).toContain("color: inherit");
  });

  it("keeps checkpoint text paired with the runtime conversation canvas", () => {
    const checkpointRule = messagesCss.match(
      /\.subagent-checkpoint-inline\s*\{([\s\S]*?)\n\}/,
    );
    const checkpointLabelRule = messagesCss.match(
      /\.subagent-checkpoint-inline \.tool-inline-label\s*\{([\s\S]*?)\n\}/,
    );
    const checkpointDetailRule = messagesCss.match(
      /\.subagent-checkpoint-inline \.tool-inline-detail\s*\{([\s\S]*?)\n\}/,
    );

    expect(checkpointRule?.[1]).toContain(
      "color: var(--conversation-assistant-text)",
    );
    expect(checkpointLabelRule?.[1]).toContain(
      "var(--conversation-assistant-text)",
    );
    expect(checkpointDetailRule?.[1]).toContain(
      "color: var(--conversation-assistant-text)",
    );
  });

  it("uses compact bordered process groups with assistant metadata only on answers", () => {
    expect(messagesCss).toMatch(
      /\.tool-group\s*\{[^}]*gap:\s*0;[^}]*border:\s*1px solid var\(--messages-process-border\);[^}]*border-radius:\s*var\(--cm-radius-card,\s*12px\);/s,
    );
    expect(messagesCss).toMatch(
      /\.tool-group-body\s*\{[^}]*gap:\s*4px;[^}]*padding:\s*5px;/s,
    );
    expect(messagesCss).toMatch(
      /\.tool-group-body \.tool-inline\s*\{[^}]*border:\s*1px solid\s+color-mix\(\s*in srgb,\s*var\(--messages-process-border\) 58%,\s*transparent\s*\);[^}]*border-radius:\s*var\(--cm-radius-dense,\s*8px\);/s,
    );
    expect(messagesCss).toMatch(
      /\.tool-group-body > \* \+ \*\s*\{[^}]*border-top:\s*0;/s,
    );
    expect(messageRowsSource).toContain('className="message-agent-name"');
    expect(messageRowsSource).toContain('className="message-agent-time"');
    expect(messageRowsSource).toContain('className="message-agent-stats"');
    expect(messageRowsSource).toContain(
      'className="message-agent-process-toggle"',
    );
    expect(messageRowsSource).not.toContain('className="working-agent-name"');
    expect(messageRowsSource).not.toContain('t("messages.agentName")');
    expect(messageRowsSource).toContain('className="message-agent-avatar"');
    expect(messageRowsSource).toMatch(
      /<ModelActivityCore\s+state=\{assistantActivityState\}\s+size=\{22\}/s,
    );
    expect(messageRowsSource).toContain(
      '<ModelActivityCore state={activityState} size={40} />',
    );
    expect(messageRowsSource).not.toContain('className="message-agent-running"');
    expect(messagesCss).toMatch(
      /\.message-agent-process-toggle\s*\{[^}]*display:\s*inline-flex;[^}]*border:\s*0;[^}]*background:\s*transparent;/s,
    );
    expect(messagesCss).toContain(".message-agent-process-content");
    expect(messagesCss).toMatch(
      /\.process-group-nested-collapsible\s*\{[^}]*border:\s*1px solid[^}]*border-radius:\s*8px;/s,
    );
    expect(messagesCss).toMatch(
      /\.message-agent-meta\s*\{[^}]*font-size:\s*13px;/s,
    );
    expect(messagesCss).toMatch(
      /\.message-agent-name\s*\{[^}]*font-size:\s*14px;/s,
    );
    expect(messagesCss).toMatch(
      /:root:not\(\[data-theme\]\) \.messages-view,\s*:root\[data-theme="light"\] \.messages-view\s*\{[^}]*--message-link-color:\s*#0f675c;[^}]*--messages-inline-code-text:\s*#242a2f;/s,
    );
  });

  it("uses shared success and error tokens for line-change statistics", () => {
    expect(messagesCss).toMatch(
      /\.message-agent-stat-add\s*\{[^}]*color:\s*var\(--status-success\);/s,
    );
    expect(messagesCss).toMatch(
      /\.message-agent-stat-delete\s*\{[^}]*color:\s*var\(--status-error\);/s,
    );
    expect(messagesCss).toMatch(
      /\.tool-group-line-change-stat-add\s*\{[^}]*color:\s*var\(--status-success\);/s,
    );
    expect(messagesCss).toMatch(
      /\.tool-group-line-change-stat-delete\s*\{[^}]*color:\s*var\(--status-error\);/s,
    );
  });

  it("gives native conversations a readable assistant stream and timed user cards", () => {
    expect(messagesCss).toMatch(
      /\.messages-view\s*\{[^}]*--conversation-user-text:\s*#dfe5ea;[^}]*--conversation-assistant-text:\s*#dfe5ea;/s,
    );
    expect(messagesCss).toMatch(
      /\.app:is\(\.layout-desktop, \.layout-compact\):not\(\.layout-phone\) \.messages-view\s*\{[^}]*--conversation-user-text:\s*#dfe5ea;[^}]*--conversation-assistant-text:\s*#dfe5ea;/s,
    );
    expect(messagesCss).toMatch(
      /:root:not\(\[data-theme\]\) \.messages-view,\s*:root\[data-theme="light"\] \.messages-view\s*\{[^}]*--conversation-user-text:\s*#37414b;[^}]*--conversation-assistant-text:\s*#37414b;/s,
    );
    expect(messagesCss).toMatch(
      /\.messages-reading-native \.messages-inner\s*\{[^}]*max-width:\s*min\(100%, var\(--conversation-reading-width, 860px\)\);[^}]*gap:\s*22px;/s,
    );
    expect(messagesCss).not.toMatch(
      /\.messages-view\s*\{[^}]*--conversation-reading-width:/s,
    );
    expect(messagesCss).toMatch(
      /\.messages-reading-native \.message\.assistant \.bubble\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*padding:\s*0 0 22px;[^}]*border:\s*0;[^}]*border-bottom:\s*1px solid\s+color-mix/s,
    );
    expect(messagesCss).toMatch(
      /:root:not\(\[data-theme\]\)\s+\.app:is\(\.layout-desktop, \.layout-compact\):not\(\.layout-phone\)\s+\.messages-view\.messages-reading-native\s+\.message\.assistant\s+\.bubble,\s*:root\[data-theme="light"\]\s+\.app:is\(\.layout-desktop, \.layout-compact\):not\(\.layout-phone\)\s+\.messages-view\.messages-reading-native\s+\.message\.assistant\s+\.bubble\s*\{[^}]*border-color:\s*transparent;[^}]*border-left-color:\s*transparent;[^}]*background:\s*transparent;/s,
    );
    expect(messagesCss).toMatch(
      /\.messages-reading-native \.message\.assistant \.markdown,\s*\.messages-reading-native \.message\.assistant \.item-text\s*\{[^}]*max-width:\s*100%;[^}]*margin-left:\s*0;[^}]*margin-top:\s*0;/s,
    );
    expect(messagesCss).toMatch(
      /\.messages-reading-native \.message\.assistant \.markdown,\s*\.messages-reading-native \.message\.assistant \.item-text\s*\{[^}]*max-width:\s*100%;[^}]*font-size:\s*var\(--message-font-size, 15px\);[^}]*line-height:\s*1\.74;/s,
    );
    expect(messagesCss).toMatch(
      /\.message\.assistant \.markdown :where\(p, ul, ol, blockquote\)\s*\{[^}]*max-width:\s*100%;/s,
    );
    expect(messagesCss).not.toMatch(/\.message\.assistant[^{}]*\{[^}]*max-width:\s*\d+ch;/s);
    expect(messagesCss).toContain(".message-agent-name");
    expect(messagesCss).toContain(".message-agent-time");
    expect(messagesCss).toContain(".message-agent-stats");
    expect(messagesCss).not.toContain(".working-agent-name");
    expect(messagesCss).toMatch(
      /\.messages-reading-native \.message \.message-actions\s*\{[^}]*bottom:\s*-15px;/s,
    );
    expect(messagesCss).toMatch(
      /\.message-actions \.message-copy-button,\s*\.message-actions \.message-edit-button,\s*\.message-actions \.message-quote-button,\s*\.message-actions \.message-export-button\s*\{[^}]*position:\s*static;[^}]*width:\s*28px;[^}]*height:\s*28px;/s,
    );
    expect(messagesCss).toMatch(
      /\.messages-reading-native \.message\.user\s*\{[^}]*justify-content:\s*flex-end;[^}]*min-width:\s*0;[^}]*box-sizing:\s*border-box;/s,
    );
    expect(messagesCss).toMatch(
      /\.messages-reading-native \.message\.user \.bubble\s*\{[^}]*position:\s*relative;[^}]*width:\s*fit-content;[^}]*max-width:\s*min\(68%, 680px\);[^}]*min-height:\s*42px;[^}]*padding:\s*12px 56px 11px 16px;[^}]*border-radius:\s*12px;[^}]*background:\s*color-mix\(\s*in srgb,\s*var\(--messages-solid-control\) 58%,\s*var\(--messages-solid-panel\) 42%\s*\);/s,
    );
    expect(messagesCss).toMatch(
      /:root:not\(\[data-theme\]\) \.messages-reading-native \.message\.user \.bubble,\s*:root\[data-theme="light"\] \.messages-reading-native \.message\.user \.bubble\s*\{[^}]*background:\s*var\(--conversation-user-color\);[^}]*color:\s*var\(--conversation-user-text\);/s,
    );
    expect(messagesCss).toMatch(
      /\.messages-reading-native \.message-user-meta\s*\{[^}]*position:\s*absolute;[^}]*top:\s*11px;[^}]*right:\s*14px;[^}]*display:\s*flex;/s,
    );
    expect(messageRowsSource).toMatch(
      /className=\{`ghost message-quote-button[^`]+`\}\s+data-button-elevation="none"/s,
    );
    expect(messageRowsSource).toContain('className="message-actions"');
    expect(messageRowsSource).toMatch(
      /className="ghost message-edit-button"\s+data-button-elevation="none"/s,
    );
    expect(messageRowsSource).toMatch(
      /className=\{`ghost message-copy-button[^`]+`\}\s+data-button-elevation="none"/s,
    );
    expect(messageRowsSource).toMatch(
      /className="ghost message-export-button"\s+data-button-elevation="none"/s,
    );
    expect(messagesCss).toMatch(
      /\.messages-reading-native \.working\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*42px minmax\(0,\s*1fr\);[^}]*gap:\s*7px;[^}]*padding:\s*4px 6px;[^}]*background:\s*transparent;/s,
    );
    expect(messagesCss).toMatch(
      /\.messages-reading-native \.working-agent-avatar\s*\{[^}]*width:\s*42px;[^}]*height:\s*42px;[^}]*background:\s*transparent;/s,
    );
    expect(messagesCss).toMatch(
      /\.message-agent-avatar\s*\{[^}]*width:\s*26px;[^}]*height:\s*26px;[^}]*border-radius:\s*8px;/s,
    );
    expect(messagesCss).toMatch(
      /\.message-edit-form\s*\{[^}]*gap:\s*4px;[^}]*padding:\s*0;[^}]*border:\s*0;/s,
    );
    expect(messagesCss).toMatch(
      /\.message-editing \.message-actions\s*\{[^}]*display:\s*none;/s,
    );
    expect(messagesCss).toMatch(
      /\.message-edit-textarea\s*\{[^}]*min-height:\s*104px;[^}]*background:\s*transparent;/s,
    );
  });

  it("keeps light process text distinct from its pale surface", () => {
    expect(messagesCss).toMatch(
      /:root:not\(\[data-theme\]\) \.messages-view,\s*:root\[data-theme="light"\] \.messages-view\s*\{[^}]*--messages-process-text:\s*#202832;[^}]*--messages-process-text-soft:\s*#56616b;/s,
    );
    expect(messagesCss).toMatch(
      /:root:not\(\[data-theme\]\) \.messages-view \.message-agent-time,\s*:root\[data-theme="light"\] \.messages-view \.message-agent-time\s*\{[^}]*color:\s*var\(--messages-process-text-soft\);/s,
    );
  });

  it("keeps dark conversation rules but lets the light theme override them", () => {
    expect(messagesCss).toMatch(
      /\.app:is\(\.layout-desktop, \.layout-compact\):not\(\.layout-phone\) \.messages-view,\s*\.app:is\(\.layout-desktop, \.layout-compact\):not\(\.layout-phone\)\s+\.messages-view\s+\.messages-full,\s*\.app:is\(\.layout-desktop, \.layout-compact\):not\(\.layout-phone\)\s+\.messages-view\s+\.messages-control-layer\s*\{[^}]*background:\s*#101419;/s,
    );
    expect(messagesCss).toMatch(
      /\.app:is\(\.layout-desktop, \.layout-compact\):not\(\.layout-phone\) \.messages-view\s*\{[^}]*--messages-process-bg:\s*color-mix\(in srgb, #15191e 82%, transparent\);/s,
    );
    expect(messagesCss).toMatch(
      /\.app:is\(\.layout-desktop, \.layout-compact\):not\(\.layout-phone\) \.messages-view\s*\{[^}]*--cm-scrollbar-track:\s*transparent;[^}]*--cm-scrollbar-thumb:\s*#46515a;[^}]*--cm-scrollbar-thumb-hover:\s*#65717a;/s,
    );
    expect(messagesCss).toMatch(
      /\.app:is\(\.layout-desktop, \.layout-compact\):not\(\.layout-phone\)\s+\.messages-view\s+\.working\s*\{[^}]*background:\s*var\(--messages-process-bg\);[^}]*box-shadow:\s*none;/s,
    );
    expect(messagesCss).toMatch(
      /\.app:is\(\.layout-desktop, \.layout-compact\):not\(\.layout-phone\)\s+\.messages-view\s+\.messages-empty:has\(\.messages-loading-indicator\)\s*\{[^}]*background:\s*#15191e;[^}]*box-shadow:\s*none;/s,
    );
    expect(messagesCss).toMatch(
      /:root:not\(\[data-theme\]\)\s+\.app:is\(\.layout-desktop, \.layout-compact\):not\(\.layout-phone\)\s+\.messages-view,\s*:root\[data-theme="light"\]\s+\.app:is\(\.layout-desktop, \.layout-compact\):not\(\.layout-phone\)\s+\.messages-view\s*\{[^}]*--conversation-canvas:\s*var\(--cm-light-main-bg\);[^}]*--messages-solid-main:\s*var\(--cm-light-main-bg\);/s,
    );
    expect(messagesCss).toMatch(
      /:root:not\(\[data-theme\]\)\s+\.app:is\(\.layout-desktop, \.layout-compact\):not\(\.layout-phone\)\s+\.messages-view,\s*:root:not\(\[data-theme\]\)\s+\.app:is\(\.layout-desktop, \.layout-compact\):not\(\.layout-phone\)\s+\.messages-view\s+\.messages-full,\s*:root:not\(\[data-theme\]\)\s+\.app:is\(\.layout-desktop, \.layout-compact\):not\(\.layout-phone\)\s+\.messages-view\s+\.messages-control-layer,\s*:root\[data-theme="light"\]\s+\.app:is\(\.layout-desktop, \.layout-compact\):not\(\.layout-phone\)\s+\.messages-view,[\s\S]*?\{[^}]*background:\s*var\(--cm-light-main-bg\);/s,
    );
    expect(messagesCss).not.toContain(
      ".messages-view:not(.messages-reading-native)",
    );
  });
});

describe("markdown table layout styles", () => {
  it("caps Markdown images while keeping them responsive", () => {
    expect(messagesCss).toMatch(
      /\.markdown img\s*\{[^}]*max-width:\s*min\(100%, 200px\);[^}]*max-height:\s*200px;[^}]*height:\s*auto;[^}]*object-fit:\s*contain;/s,
    );
  });

  const messagesCss = readFileSync(
    new URL("./messages.css", import.meta.url),
    "utf8",
  );

  it("keeps generic tables responsive and scopes fixed widths to review tables", () => {
    expect(messagesCss).toMatch(
      /\.markdown \.markdown-table\s*\{[^}]*min-width:\s*100%;[^}]*table-layout:\s*auto;/s,
    );
    expect(messagesCss).toMatch(
      /\.markdown \.markdown-table-structured-review\s*\{[^}]*min-width:\s*760px;[^}]*table-layout:\s*fixed;/s,
    );
    expect(messagesCss).not.toMatch(
      /\.message \.markdown \.markdown-table th:first-child/,
    );
    expect(messagesCss).toMatch(
      /\.markdown \.markdown-table \.markdown-table-cell-numeric\s*\{[^}]*text-align:\s*right;[^}]*font-variant-numeric:\s*tabular-nums;/s,
    );
    expect(messagesCss).toMatch(
      /\.markdown \.markdown-table \.markdown-table-cell-center\s*\{[^}]*text-align:\s*center;/s,
    );
  });
});

describe("markdown code block selection styles", () => {
  const messagesCss = readFileSync(
    new URL("./messages.css", import.meta.url),
    "utf8",
  );

  it("keeps code block chrome out of manual text selections", () => {
    expect(messagesCss).toMatch(
      /\.message \.markdown-codeblock-header\s*\{[^}]*user-select:\s*none;/s,
    );
    expect(messagesCss).toMatch(
      /\.message \.markdown-codeblock pre\s*\{[^}]*user-select:\s*text;/s,
    );
  });
});
