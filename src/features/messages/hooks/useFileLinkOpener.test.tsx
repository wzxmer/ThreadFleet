// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openLocalFile, openWorkspaceIn } from "@services/tauri";
import { I18N_STRINGS } from "@/features/i18n/strings";
import { I18nProvider } from "@/features/i18n/I18nProvider";
import { Markdown } from "../components/Markdown";
import { fileTarget } from "../test/fileLinkAssertions";
import { useFileLinkOpener } from "./useFileLinkOpener";

const {
  menuNewMock,
  menuItemNewMock,
  predefinedMenuItemNewMock,
  logicalPositionMock,
  getCurrentWindowMock,
  revealItemInDirMock,
} = vi.hoisted(() => ({
  menuNewMock: vi.fn(),
  menuItemNewMock: vi.fn(),
  predefinedMenuItemNewMock: vi.fn(),
  logicalPositionMock: vi.fn(),
  getCurrentWindowMock: vi.fn(),
  revealItemInDirMock: vi.fn(),
}));

vi.mock("../../../services/tauri", () => ({
  openLocalFile: vi.fn(),
  openWorkspaceIn: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
  revealItemInDir: revealItemInDirMock,
}));

vi.mock("@tauri-apps/api/menu", () => ({
  Menu: { new: menuNewMock },
  MenuItem: { new: menuItemNewMock },
  PredefinedMenuItem: { new: predefinedMenuItemNewMock },
}));

vi.mock("@tauri-apps/api/dpi", () => ({
  LogicalPosition: logicalPositionMock,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: getCurrentWindowMock,
}));

vi.mock("@sentry/react", () => ({
  captureException: vi.fn(),
}));

vi.mock("../../../services/toasts", () => ({
  pushErrorToast: vi.fn(),
}));

describe("useFileLinkOpener", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  async function copyLinkFor(rawPath: string) {
    const clipboardWriteTextMock = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: clipboardWriteTextMock },
      configurable: true,
    });
    menuItemNewMock.mockImplementation(async (options) => options);
    predefinedMenuItemNewMock.mockImplementation(async (options) => options);
    menuNewMock.mockImplementation(async ({ items }) => ({
      items,
      popup: vi.fn(),
    }));

    const { result } = renderHook(() => useFileLinkOpener(null, [], ""));

    await act(async () => {
      await result.current.showFileLinkMenu(
        {
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
          clientX: 12,
          clientY: 24,
        } as never,
        fileTarget(rawPath),
      );
    });

    const items = menuNewMock.mock.calls[0]?.[0]?.items ?? [];
    const copyLinkItem = items.find(
      (item: { text?: string; action?: () => Promise<void> }) => item.text === "复制链接",
    );

    await copyLinkItem?.action?.();
    return clipboardWriteTextMock.mock.calls[0]?.[0];
  }

  it("copies namespace-prefixed Windows drive paths as round-trippable file URLs", async () => {
    expect(await copyLinkFor("\\\\?\\C:\\repo\\src\\App.tsx:42")).toBe(
      "file:///%5C%5C%3F%5CC%3A%5Crepo%5Csrc%5CApp.tsx#L42",
    );
  });

  it("copies namespace-prefixed Windows UNC paths as round-trippable file URLs", async () => {
    expect(await copyLinkFor("\\\\?\\UNC\\server\\share\\repo\\App.tsx:42")).toBe(
      "file:///%5C%5C%3F%5CUNC%5Cserver%5Cshare%5Crepo%5CApp.tsx#L42",
    );
  });

  it("percent-encodes copied file URLs for Windows paths with reserved characters", async () => {
    expect(await copyLinkFor("C:\\repo\\My File #100%.tsx:42")).toBe(
      "file:///C:/repo/My%20File%20%23100%25.tsx#L42",
    );
  });

  it("maps /workspace root-relative paths to the active workspace path", async () => {
    const workspacePath = "/Users/sotiriskaniras/Documents/Development/Forks/ThreadFleet";
    const openWorkspaceInMock = vi.mocked(openWorkspaceIn);
    const { result } = renderHook(() => useFileLinkOpener(workspacePath, [], ""));

    await act(async () => {
      await result.current.openFileLink(
        fileTarget("/workspace/src/features/messages/components/Markdown.tsx"),
      );
    });

    expect(openWorkspaceInMock).toHaveBeenCalledWith(
      "/Users/sotiriskaniras/Documents/Development/Forks/ThreadFleet/src/features/messages/components/Markdown.tsx",
      expect.objectContaining({ appName: "Visual Studio Code", args: [] }),
    );
  });

  it("maps /workspace/<workspace-name>/... paths to the active workspace path", async () => {
    const workspacePath = "/Users/sotiriskaniras/Documents/Development/Forks/ThreadFleet";
    const openWorkspaceInMock = vi.mocked(openWorkspaceIn);
    const { result } = renderHook(() => useFileLinkOpener(workspacePath, [], ""));

    await act(async () => {
      await result.current.openFileLink(fileTarget("/workspace/ThreadFleet/LICENSE"));
    });

    expect(openWorkspaceInMock).toHaveBeenCalledWith(
      "/Users/sotiriskaniras/Documents/Development/Forks/ThreadFleet/LICENSE",
      expect.objectContaining({ appName: "Visual Studio Code", args: [] }),
    );
  });

  it("maps extensionless files under /workspace/settings to the active workspace path", async () => {
    const workspacePath = "/Users/sotiriskaniras/Documents/Development/Forks/settings";
    const openWorkspaceInMock = vi.mocked(openWorkspaceIn);
    const { result } = renderHook(() => useFileLinkOpener(workspacePath, [], ""));

    await act(async () => {
      await result.current.openFileLink(fileTarget("/workspace/settings/LICENSE"));
    });

    expect(openWorkspaceInMock).toHaveBeenCalledWith(
      "/Users/sotiriskaniras/Documents/Development/Forks/settings/LICENSE",
      expect.objectContaining({ appName: "Visual Studio Code", args: [] }),
    );
  });

  it("maps nested /workspaces/.../<workspace-name>/... paths to the active workspace path", async () => {
    const workspacePath = "/Users/sotiriskaniras/Documents/Development/Forks/ThreadFleet";
    const openWorkspaceInMock = vi.mocked(openWorkspaceIn);
    const { result } = renderHook(() => useFileLinkOpener(workspacePath, [], ""));

    await act(async () => {
      await result.current.openFileLink(fileTarget("/workspaces/team/ThreadFleet/src"));
    });

    expect(openWorkspaceInMock).toHaveBeenCalledWith(
      "/Users/sotiriskaniras/Documents/Development/Forks/ThreadFleet/src",
      expect.objectContaining({ appName: "Visual Studio Code", args: [] }),
    );
  });

  it("preserves file link line and column metadata for editor opens", async () => {
    const workspacePath = "/Users/sotiriskaniras/Documents/Development/Forks/ThreadFleet";
    const openWorkspaceInMock = vi.mocked(openWorkspaceIn);
    const { result } = renderHook(() => useFileLinkOpener(workspacePath, [], ""));

    await act(async () => {
      await result.current.openFileLink(
        fileTarget("/workspace/src/features/messages/components/Markdown.tsx:33:7"),
      );
    });

    expect(openWorkspaceInMock).toHaveBeenCalledWith(
      "/Users/sotiriskaniras/Documents/Development/Forks/ThreadFleet/src/features/messages/components/Markdown.tsx",
      expect.objectContaining({
        appName: "Visual Studio Code",
        args: [],
        line: 33,
        column: 7,
      }),
    );
  });

  it("parses #L line anchors before opening the editor", async () => {
    const workspacePath = "/Users/sotiriskaniras/Documents/Development/Forks/ThreadFleet";
    const openWorkspaceInMock = vi.mocked(openWorkspaceIn);
    const { result } = renderHook(() => useFileLinkOpener(workspacePath, [], ""));

    await act(async () => {
      await result.current.openFileLink(fileTarget("/workspace/src/App.tsx#L33"));
    });

    expect(openWorkspaceInMock).toHaveBeenCalledWith(
      "/Users/sotiriskaniras/Documents/Development/Forks/ThreadFleet/src/App.tsx",
      expect.objectContaining({
        appName: "Visual Studio Code",
        args: [],
        line: 33,
      }),
    );
  });

  it("opens structured file targets without re-parsing #L-like filename endings", async () => {
    const openWorkspaceInMock = vi.mocked(openWorkspaceIn);
    const { result } = renderHook(() => useFileLinkOpener(null, [], ""));

    await act(async () => {
      await result.current.openFileLink({
        path: "/tmp/#L12",
        line: null,
        column: null,
      });
    });

    expect(openWorkspaceInMock).toHaveBeenCalledWith(
      "/tmp/#L12",
      expect.objectContaining({ appName: "Visual Studio Code", args: [] }),
    );
  });

  it("normalizes line ranges to the starting line before opening the editor", async () => {
    const workspacePath = "/Users/sotiriskaniras/Documents/Development/Forks/ThreadFleet";
    const openWorkspaceInMock = vi.mocked(openWorkspaceIn);
    const { result } = renderHook(() => useFileLinkOpener(workspacePath, [], ""));

    await act(async () => {
      await result.current.openFileLink(
        fileTarget("/workspace/src/features/messages/components/Markdown.tsx:366-369"),
      );
    });

    expect(openWorkspaceInMock).toHaveBeenCalledWith(
      "/Users/sotiriskaniras/Documents/Development/Forks/ThreadFleet/src/features/messages/components/Markdown.tsx",
      expect.objectContaining({
        appName: "Visual Studio Code",
        args: [],
        line: 366,
      }),
    );
  });

  it("opens slash-prefixed Windows drive paths with the default app instead of revealing them", async () => {
    const { result } = renderHook(() =>
      useFileLinkOpener(
        "D:\\Project\\ThreadFleet",
        [{ id: "finder", label: "Explorer", kind: "finder", args: [] }],
        "finder",
      ),
    );

    await act(async () => {
      await result.current.openFileLink(
        fileTarget("/D:/Project/rime/lua/txjx_processor.lua:42"),
      );
    });

    expect(openLocalFile).toHaveBeenCalledWith(
      "D:/Project/rime/lua/txjx_processor.lua",
    );
    expect(revealItemInDirMock).not.toHaveBeenCalled();
    expect(openWorkspaceIn).not.toHaveBeenCalled();
  });

  it.each(["zh", "en"] as const)("opens an HTML message link on click and reveals it only through its context menu (%s)", async (language) => {
    const path = "D:/reports/finance.html";
    menuItemNewMock.mockImplementation(async (options) => options);
    predefinedMenuItemNewMock.mockImplementation(async (options) => options);
    const popup = vi.fn();
    menuNewMock.mockResolvedValue({ popup });

    function MessageWithFileOpener() {
      const { openFileLink, showFileLinkMenu } = useFileLinkOpener(
        "D:/Project/ThreadFleet",
        [{ id: "finder", label: "Explorer", kind: "finder", args: [] }],
        "finder",
      );
      return (
        <Markdown
          value={`[Report](${path})`}
          className="markdown"
          onOpenFileLink={openFileLink}
          onOpenFileLinkMenu={showFileLinkMenu}
        />
      );
    }

    render(
      <I18nProvider preference={language}>
        <MessageWithFileOpener />
      </I18nProvider>,
    );
    const link = screen.getByRole("link", { name: "Report" });

    fireEvent.click(link);
    await waitFor(() => expect(openLocalFile).toHaveBeenCalledWith(path));
    expect(revealItemInDirMock).not.toHaveBeenCalled();
    expect(menuNewMock).not.toHaveBeenCalled();

    vi.mocked(openLocalFile).mockClear();
    fireEvent.contextMenu(link, { clientX: 12, clientY: 24 });
    await waitFor(() => expect(popup).toHaveBeenCalled());
    expect(openLocalFile).not.toHaveBeenCalled();
    expect(revealItemInDirMock).not.toHaveBeenCalled();

    const items = menuNewMock.mock.calls[0][0].items;
    const openItem = items.find(
      (item: { text?: string }) =>
        item.text === I18N_STRINGS[language]["messages.fileLink.openDefault"],
    );
    const revealItem = items.find(
      (item: { text?: string }) =>
        item.text === I18N_STRINGS[language]["messages.fileLink.reveal"],
    );
    expect(openItem).toBeDefined();
    expect(revealItem).toBeDefined();

    await act(async () => {
      await openItem.action();
    });
    expect(openLocalFile).toHaveBeenCalledWith(path);
    expect(revealItemInDirMock).not.toHaveBeenCalled();

    await act(async () => {
      await revealItem.action();
    });
    expect(revealItemInDirMock).toHaveBeenCalledExactlyOnceWith(path);
  });

  it("keeps the selected editor command and line location when opening source files", async () => {
    const { result } = renderHook(() =>
      useFileLinkOpener(
        "D:\\Project\\ThreadFleet",
        [{
          id: "cursor",
          label: "Cursor",
          kind: "command",
          command: "cursor",
          args: ["--reuse-window"],
        }],
        "cursor",
      ),
    );

    await act(async () => {
      await result.current.openFileLink(fileTarget("src/App.tsx:33:7"));
    });

    expect(openWorkspaceIn).toHaveBeenCalledWith("D:\\Project\\ThreadFleet\\src\\App.tsx", {
      command: "cursor",
      args: ["--reuse-window"],
      line: 33,
      column: 7,
    });
    expect(openLocalFile).not.toHaveBeenCalled();
    expect(revealItemInDirMock).not.toHaveBeenCalled();
  });
});
