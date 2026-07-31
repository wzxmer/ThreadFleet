/** @vitest-environment jsdom */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComposerMetaBar } from "./ComposerMetaBar";

describe("ComposerMetaBar", () => {
  it("hides the config suffix from model labels", () => {
    const { unmount } = render(
      <ComposerMetaBar
        disabled={false}
        collaborationModes={[]}
        selectedCollaborationModeId={null}
        onSelectCollaborationMode={() => {}}
        models={[
          { id: "config-model", model: "gpt-5.6-sol", displayName: "gpt-5.6-sol (config)" },
        ]}
        selectedModelId="config-model"
        onSelectModel={() => {}}
        reasoningOptions={[]}
        selectedEffort={null}
        onSelectEffort={() => {}}
        selectedServiceTier={null}
        reasoningSupported={false}
        accessMode="current"
        onSelectAccessMode={() => {}}
        composerSendShortcut="enter"
      />,
    );

    const trigger = screen.getByRole("button", { name: "模型" });
    expect(trigger.textContent).toBe("gpt-5.6-sol");
    expect(trigger.getAttribute("title")).toBe("gpt-5.6-sol");
    unmount();
  });

  it("keeps long model labels available in the trigger and model popover", () => {
    const longModelLabel = "gpt-5.6-sol-max-with-long-provider-name";
    render(
      <ComposerMetaBar
        disabled={false}
        collaborationModes={[]}
        selectedCollaborationModeId={null}
        onSelectCollaborationMode={() => {}}
        models={[
          {
            id: "long-model",
            displayName: longModelLabel,
            model: "gpt-5.6-sol-max",
          },
        ]}
        selectedModelId="long-model"
        onSelectModel={() => {}}
        reasoningOptions={[]}
        selectedEffort={null}
        onSelectEffort={() => {}}
        selectedServiceTier={null}
        reasoningSupported={false}
        accessMode="current"
        onSelectAccessMode={() => {}}
        composerSendShortcut="enter"
      />,
    );

    const trigger = screen.getByRole("button", { name: "模型" });
    expect(trigger.textContent).toBe(longModelLabel);
    expect(trigger.getAttribute("title")).toBe(longModelLabel);
    expect(trigger.closest(".composer-select-wrap--model")).toBeTruthy();

    fireEvent.click(trigger);

    const listbox = screen.getByRole("listbox", { name: "模型" });
    expect(listbox.classList.contains("composer-model-select-popover")).toBe(true);
    expect(screen.getByRole("option", { name: longModelLabel }).textContent).toContain(
      longModelLabel,
    );
  });

  it("activates the model core while the thread is processing, even when controls are disabled", () => {
    const view = render(
      <ComposerMetaBar
        disabled
        isProcessing
        collaborationModes={[]}
        selectedCollaborationModeId={null}
        onSelectCollaborationMode={() => {}}
        models={[{ id: "model-1", displayName: "gpt-5.6-sol", model: "gpt-5.6-sol" }]}
        selectedModelId="model-1"
        onSelectModel={() => {}}
        reasoningOptions={[]}
        selectedEffort={null}
        onSelectEffort={() => {}}
        selectedServiceTier={null}
        reasoningSupported={false}
        accessMode="current"
        onSelectAccessMode={() => {}}
        composerSendShortcut="enter"
      />,
    );

    expect(
      view.container.querySelector(".model-activity-core")?.getAttribute("data-state"),
    ).toBe("thinking");
  });

  it("sizes controls from the selected label instead of the longest option", () => {
    const view = render(
      <ComposerMetaBar
        disabled={false}
        collaborationModes={[]}
        selectedCollaborationModeId={null}
        onSelectCollaborationMode={() => {}}
        models={[
          { id: "short", model: "gpt-5.6-sol", displayName: "gpt-5.6-sol" },
          {
            id: "long",
            model: "long-model",
            displayName: "a-very-long-model-name-that-should-only-affect-the-menu",
          },
        ]}
        selectedModelId="short"
        onSelectModel={() => {}}
        reasoningOptions={[]}
        selectedEffort={null}
        onSelectEffort={() => {}}
        selectedServiceTier={null}
        reasoningSupported={false}
        accessMode="current"
        onSelectAccessMode={() => {}}
        composerSendShortcut="enter"
      />,
    );

    const wrapper = view.container.querySelector<HTMLElement>(
      ".composer-select-wrap--model",
    );
    expect(wrapper?.style.getPropertyValue("--composer-control-width")).toBe("159px");
  });

  it("combines input shortcut and trigger mode in one menu", () => {
    const onSelectComposerSendShortcut = vi.fn();
    const onSelectComposerTriggerMode = vi.fn();
    render(
      <ComposerMetaBar
        disabled={false}
        collaborationModes={[]}
        selectedCollaborationModeId={null}
        onSelectCollaborationMode={() => {}}
        models={[]}
        selectedModelId={null}
        onSelectModel={() => {}}
        reasoningOptions={[]}
        selectedEffort={null}
        onSelectEffort={() => {}}
        selectedServiceTier={null}
        reasoningSupported={false}
        accessMode="current"
        onSelectAccessMode={() => {}}
        composerSendShortcut="enter"
        onSelectComposerSendShortcut={onSelectComposerSendShortcut}
        composerTriggerMode="default"
        onSelectComposerTriggerMode={onSelectComposerTriggerMode}
      />,
    );

    const trigger = screen.getByRole("button", { name: "输入设置" });
    expect(trigger.textContent).toContain("输入：聊天 · 默认 / @");
    expect(trigger.getAttribute("title")).toBe("输入：聊天 · 默认 / @");

    fireEvent.click(trigger);

    const chatOption = screen.getByRole("menuitemradio", {
      name: /聊天：Enter 发送/,
    });
    expect(chatOption.getAttribute("title")).toBe(
      "发送：Enter；引导：Ctrl+Enter；换行：Shift+Enter",
    );
    expect(chatOption.getAttribute("aria-checked")).toBe("true");
    expect(
      screen
        .getByRole("menuitemradio", { name: /编辑：Ctrl\+Enter 发送/ })
        .getAttribute("title"),
    ).toBe("发送：Ctrl+Enter；引导：Shift+Enter；换行：Enter");
    expect(
      screen
        .getByRole("menuitemradio", { name: /引导优先：Enter 引导/ })
        .getAttribute("title"),
    ).toBe("发送/引导：Enter；换行：Ctrl+Enter");
    expect(
      screen.getByRole("menuitemradio", { name: "默认 / @" }).getAttribute("aria-checked"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("menuitemradio", { name: "对调 @ /" }));
    expect(onSelectComposerTriggerMode).toHaveBeenCalledWith("swap-slash-at");
  });

  it("portals the input settings menu to the main header host", () => {
    const host = document.createElement("div");
    host.className = "main-header-composer-tools";
    document.body.append(host);
    const view = render(
      <ComposerMetaBar
        disabled={false}
        collaborationModes={[]}
        selectedCollaborationModeId={null}
        onSelectCollaborationMode={() => {}}
        models={[]}
        selectedModelId={null}
        onSelectModel={() => {}}
        reasoningOptions={[]}
        selectedEffort={null}
        onSelectEffort={() => {}}
        selectedServiceTier={null}
        reasoningSupported={false}
        accessMode="current"
        onSelectAccessMode={() => {}}
        composerSendShortcut="enter"
        onSelectComposerSendShortcut={vi.fn()}
        composerTriggerMode="default"
        onSelectComposerTriggerMode={vi.fn()}
        inputToolsHost={host}
      />,
    );

    const trigger = within(host).getByRole("button", { name: "输入设置" });
    expect(host.contains(trigger)).toBe(true);
    expect(view.container.querySelector(".composer-meta-secondary")).toBeNull();
    view.unmount();
    host.remove();
  });

  it("refreshes models from the model control", () => {
    const onRefreshModels = vi.fn();
    render(
      <ComposerMetaBar
        disabled={false}
        collaborationModes={[]}
        selectedCollaborationModeId={null}
        onSelectCollaborationMode={() => {}}
        models={[]}
        selectedModelId={null}
        onSelectModel={() => {}}
        onRefreshModels={onRefreshModels}
        reasoningOptions={[]}
        selectedEffort={null}
        onSelectEffort={() => {}}
        selectedServiceTier={null}
        reasoningSupported={false}
        accessMode="current"
        onSelectAccessMode={() => {}}
        composerSendShortcut="enter"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "刷新模型列表" }));
    expect(onRefreshModels).toHaveBeenCalledTimes(1);
  });
});
