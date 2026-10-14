// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCliCandidate, AppSettings } from "@/types";
import { I18nProvider } from "@/features/i18n/I18nProvider";
import { I18N_STRINGS, type I18nKey } from "@/features/i18n/strings";
import { discoverAgentClis, pickAgentCliPath } from "@services/tauri";
import { SettingsAgentRuntimeSection } from "./SettingsAgentRuntimeSection";

vi.mock("@services/tauri", () => ({
  discoverAgentClis: vi.fn(),
  pickAgentCliPath: vi.fn(),
}));

const text = (key: I18nKey) => I18N_STRINGS.en[key];
const systemCodex: AgentCliCandidate = {
  engine: "codex",
  path: "/usr/local/bin/codex",
  version: "0.162.1",
  source: "system",
  runnable: true,
  error: null,
};
const managedCodex: AgentCliCandidate = {
  ...systemCodex,
  path: "/managed-codex/0.163.0/bin/codex",
  version: "0.163.0",
  source: "managed",
};
const systemGemini: AgentCliCandidate = {
  ...systemCodex,
  engine: "gemini",
  path: "/usr/local/bin/gemini",
  version: "0.30.0",
};
const baseSettings = {
  codexBin: null,
  geminiBin: null,
  defaultAgentEngine: "codex",
  backendMode: "local",
} as AppSettings;

function renderSettings(initial = baseSettings, onSave = vi.fn()) {
  function Harness() {
    const [settings, setSettings] = useState(initial);
    return (
      <I18nProvider preference="en">
        <SettingsAgentRuntimeSection
          appSettings={settings}
          onUpdateAppSettings={async (next) => {
            await onSave(next);
            setSettings(next);
          }}
        />
      </I18nProvider>
    );
  }
  render(<Harness />);
  return onSave;
}

beforeEach(() => {
  vi.mocked(discoverAgentClis).mockImplementation(async (engine) =>
    engine === "codex" ? [systemCodex, managedCodex] : [systemGemini],
  );
  vi.mocked(pickAgentCliPath).mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SettingsAgentRuntimeSection", () => {
  it("detects both engines and persists the chosen installation instead of a version label", async () => {
    const onSave = renderSettings();
    await screen.findByRole("option", { name: /0\.163\.0/ });
    expect(discoverAgentClis).toHaveBeenCalledWith("codex");
    expect(discoverAgentClis).toHaveBeenCalledWith("gemini");
    const codexSelect = screen.getAllByLabelText(text("agents.cliSelection"))[0];
    fireEvent.change(codexSelect, { target: { value: managedCodex.path } });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ codexBin: managedCodex.path, geminiBin: null }),
    ));
    await waitFor(() => expect((codexSelect as HTMLSelectElement).value).toBe(managedCodex.path));
  });

  it("preserves an existing managed selection until the user chooses automatic mode", async () => {
    const onSave = renderSettings({ ...baseSettings, codexBin: managedCodex.path });
    await screen.findByRole("option", { name: /0\.163\.0/ });
    const codexSelect = screen.getAllByLabelText(text("agents.cliSelection"))[0] as HTMLSelectElement;
    const codexPath = screen.getAllByLabelText(text("agents.path"))[0] as HTMLInputElement;
    expect(codexSelect.value).toBe(managedCodex.path);
    expect(codexPath.value).toBe(managedCodex.path);
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(codexSelect, {
      target: { value: "__auto__" },
    });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ codexBin: null })));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(codexSelect.value).toBe("__auto__");
    expect(codexPath.value).toBe("");
  });

  it("keeps manually typed Gemini paths as drafts until saved", async () => {
    const onSave = renderSettings();
    await screen.findByRole("option", { name: /0\.30\.0/ });
    fireEvent.change(screen.getAllByLabelText(text("agents.path"))[1], {
      target: { value: "  /opt/custom/gemini  " },
    });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: text("common.save") })[1]);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ geminiBin: "/opt/custom/gemini", codexBin: null }),
    ));
  });

  it("lets users browse a CLI path and changes the default only for new conversations", async () => {
    vi.mocked(pickAgentCliPath).mockResolvedValue("/home/me/bin/gemini");
    const onSave = renderSettings();
    await screen.findByRole("option", { name: /0\.30\.0/ });
    fireEvent.click(screen.getAllByRole("button", { name: text("common.browse") })[1]);
    await waitFor(() => expect(
      (screen.getAllByLabelText(text("agents.path"))[1] as HTMLInputElement).value,
    ).toBe("/home/me/bin/gemini"));
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(text("agents.defaultEngine")), {
      target: { value: "gemini" },
    });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ defaultAgentEngine: "gemini", codexBin: null, geminiBin: null }),
    ));
  });

  it("disables failed installations and preserves manual entry when detection finds nothing", async () => {
    vi.mocked(discoverAgentClis).mockImplementation(async (engine) => engine === "codex" ? [{
      ...systemCodex,
      runnable: false,
      version: null,
      error: "CLI version check timed out.",
    }] : []);
    const onSave = renderSettings();
    const failedOption = await screen.findByRole("option", { name: new RegExp(text("agents.unavailable")) });
    expect((failedOption as HTMLOptionElement).disabled).toBe(true);
    expect(screen.getAllByText(text("agents.noInstallations"))).toHaveLength(2);
    fireEvent.change(screen.getAllByLabelText(text("agents.path"))[1], {
      target: { value: "/manually/installed/gemini" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: text("common.save") })[1]);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ geminiBin: "/manually/installed/gemini" }),
    ));
  });
});
