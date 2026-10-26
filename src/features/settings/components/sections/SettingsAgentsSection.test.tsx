// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@/types";
import type { SettingsAgentsSectionProps } from "@settings/hooks/useSettingsAgentsSection";
import { SettingsAgentsSection } from "./SettingsAgentsSection";

const baseAppSettings = {
  nativeAgentMarkdownImportEnabled: true,
  subagentCheckpointSyncMode: "off",
  subagentCheckpointSyncVersion: 1,
} as AppSettings;

const baseProps = (): SettingsAgentsSectionProps => ({
  appSettings: baseAppSettings,
  onUpdateAppSettings: vi.fn(async () => {}),
  settings: {
    configPath: "/Users/me/.codex/config.toml",
    multiAgentEnabled: false,
    maxThreads: 6,
    maxDepth: 1,
    agents: [
      {
        name: "researcher",
        description: "Research-focused role",
        developerInstructions: "Investigate and propose safe changes.",
        configFile: "researcher.toml",
        resolvedPath: "/Users/me/.codex/agents/researcher.toml",
        managedByApp: true,
        fileExists: true,
      },
    ],
  },
  isLoading: false,
  isUpdatingCore: false,
  creatingAgent: false,
  updatingAgentName: null,
  deletingAgentName: null,
  readingConfigAgentName: null,
  writingConfigAgentName: null,
  createDescriptionGenerating: false,
  editDescriptionGenerating: false,
  error: null,
  onRefresh: vi.fn(),
  onSetMultiAgentEnabled: vi.fn(async () => true),
  onSetMaxThreads: vi.fn(async () => true),
  onSetMaxDepth: vi.fn(async () => true),
  onCreateAgent: vi.fn(async () => true),
  onUpdateAgent: vi.fn(async () => true),
  onDeleteAgent: vi.fn(async () => true),
  onReadAgentConfig: vi.fn(async () => "model = \"gpt-5-codex\""),
  onWriteAgentConfig: vi.fn(async () => true),
  onGenerateCreateDescription: vi.fn(async () => null),
  onGenerateEditDescription: vi.fn(async () => null),
  modelOptions: [
    {
      id: "gpt-5-codex",
      model: "gpt-5-codex",
      displayName: "gpt-5-codex",
      description: "",
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
      isDefault: true,
    },
  ],
  modelOptionsLoading: false,
  modelOptionsError: null,
});

describe("SettingsAgentsSection", () => {
  afterEach(() => {
    cleanup();
  });

  it("enables create generation only when name is present", () => {
    const props = baseProps();
    render(<SettingsAgentsSection {...props} />);

    const improveButton = screen.getByRole("button", {
      name: "为新 agent 生成字段",
    }) as HTMLButtonElement;
    expect(improveButton.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "researcher" } });
    expect(improveButton.disabled).toBe(false);
  });

  it("toggles native Markdown agent auto import", async () => {
    const props = baseProps();
    const onUpdateAppSettings = vi.fn(async () => {});
    const onRefresh = vi.fn();
    render(
      <SettingsAgentsSection
        {...props}
        onUpdateAppSettings={onUpdateAppSettings}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "自动导入 Codex 原生 Agents",
      }),
    );

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith({
        ...baseAppSettings,
        nativeAgentMarkdownImportEnabled: false,
      });
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });
  });

  it("updates subagent checkpoint sync mode", async () => {
    const props = baseProps();
    const onUpdateAppSettings = vi.fn(async () => {});
    render(
      <SettingsAgentsSection
        {...props}
        onUpdateAppSettings={onUpdateAppSettings}
      />,
    );

    fireEvent.change(screen.getByLabelText("子会话进度同步"), {
      target: { value: "finalOnly" },
    });

    await waitFor(() => {
      expect(onUpdateAppSettings).toHaveBeenCalledWith({
        ...baseAppSettings,
        subagentCheckpointSyncMode: "finalOnly",
      });
    });
  });

  it("applies generated description to create textarea", async () => {
    const props = baseProps();
    const onGenerateCreateDescription = vi.fn(async () => ({
      description: "Stabilizes flaky test suites",
      developerInstructions:
        "Reproduce failures first.\nPrefer deterministic fixes.\nAdd targeted regression tests.",
    }));
    render(
      <SettingsAgentsSection
        {...props}
        onGenerateCreateDescription={onGenerateCreateDescription}
      />,
    );

    const createName = screen.getByLabelText("名称") as HTMLInputElement;
    const createDescription = screen.getByLabelText("描述") as HTMLTextAreaElement;
    const createDeveloperInstructions = screen.getByLabelText(
      "开发者指令",
    ) as HTMLTextAreaElement;
    fireEvent.change(createName, { target: { value: "researcher" } });
    fireEvent.change(createDescription, { target: { value: "flaky tests" } });
    fireEvent.click(
      screen.getByRole("button", { name: "为新 agent 生成字段" }),
    );

    await waitFor(() => {
      expect(onGenerateCreateDescription).toHaveBeenCalledWith({
        name: "researcher",
        description: "flaky tests",
        developerInstructions: "",
      });
    });
    await waitFor(() => {
      expect(createDescription.value).toBe("Stabilizes flaky test suites");
      expect(createDeveloperInstructions.value).toContain("Reproduce failures first.");
    });
  });

  it("does not send developerInstructions when unchanged during edit", async () => {
    const props = baseProps();
    const onUpdateAgent = vi.fn(
      async (_input: Parameters<SettingsAgentsSectionProps["onUpdateAgent"]>[0]) => true,
    );
    render(<SettingsAgentsSection {...props} onUpdateAgent={onUpdateAgent} />);

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const nameInputs = screen.getAllByLabelText("名称") as HTMLInputElement[];
    fireEvent.change(nameInputs[1], { target: { value: "researcher-v2" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(onUpdateAgent).toHaveBeenCalledTimes(1);
    });
    const payload = onUpdateAgent.mock.calls[0]?.[0];
    if (!payload) {
      throw new Error("Expected update payload");
    }
    expect(payload).toMatchObject({
      originalName: "researcher",
      name: "researcher-v2",
      description: "Research-focused role",
      renameManagedFile: true,
    });
    expect(payload).not.toHaveProperty("developerInstructions");
  });

  it("updates max depth from stepper control", async () => {
    const props = baseProps();
    const onSetMaxDepth = vi.fn(async () => true);
    render(<SettingsAgentsSection {...props} onSetMaxDepth={onSetMaxDepth} />);

    fireEvent.click(screen.getByRole("button", { name: "增加最大深度" }));

    await waitFor(() => {
      expect(onSetMaxDepth).toHaveBeenCalledWith(2);
    });
  });

  it("does not increase max depth beyond 4", () => {
    const props = baseProps();
    const onSetMaxDepth = vi.fn(async () => true);
    render(
      <SettingsAgentsSection
        {...props}
        settings={{ ...props.settings!, maxDepth: 4 }}
        onSetMaxDepth={onSetMaxDepth}
      />,
    );

    const increaseDepthButton = screen.getByRole("button", { name: "增加最大深度" });
    expect((increaseDepthButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(increaseDepthButton);
    expect(onSetMaxDepth).not.toHaveBeenCalled();
  });
});
