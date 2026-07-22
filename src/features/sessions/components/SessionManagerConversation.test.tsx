// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManagerConversation } from "./SessionManagerConversation";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SessionManagerConversation", () => {
  it("loads one selected session in bounded visible batches", () => {
    const items = Array.from({ length: 45 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      text: `message ${index}`,
    }));

    const { container } = render(
      <SessionManagerConversation
        sessionKey="source:thread"
        items={items}
        loading={false}
        error={null}
        incomplete={false}
        fallback={null}
      />,
    );

    expect(container.querySelectorAll(".session-manager-preview-item")).toHaveLength(40);
    expect(screen.queryByText("message 0")).toBeNull();
    expect(screen.getByText("message 44")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "加载更早内容" }));

    expect(container.querySelectorAll(".session-manager-preview-item")).toHaveLength(45);
    expect(screen.getByText("message 0")).toBeTruthy();
  });

  it("scrolls to the conversation end after loaded content mounts", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(640);
    const item = { role: "assistant" as const, text: "latest result" };
    const { container, rerender } = render(
      <SessionManagerConversation
        sessionKey="source:thread"
        items={[item]}
        loading
        error={null}
        incomplete={false}
        fallback={null}
      />,
    );

    rerender(
      <SessionManagerConversation
        sessionKey="source:thread"
        items={[item]}
        loading={false}
        error={null}
        incomplete={false}
        fallback={null}
      />,
    );

    const conversation = container.querySelector<HTMLElement>(".session-manager-preview-items");
    expect(conversation?.scrollTop).toBe(640);
  });

  it("reanchors after delayed content growth while the user remains at the bottom", () => {
    let resizeCallback: ResizeObserverCallback | null = null;
    vi.stubGlobal("ResizeObserver", class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe() {}
      disconnect() {}
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    let scrollHeight = 640;
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => scrollHeight);
    const { container } = render(
      <SessionManagerConversation
        sessionKey="source:thread"
        items={[{ role: "assistant", text: "latest result" }]}
        loading={false}
        error={null}
        incomplete={false}
        fallback={null}
      />,
    );

    const conversation = container.querySelector<HTMLElement>(".session-manager-preview-items");
    expect(conversation?.scrollTop).toBe(640);
    scrollHeight = 920;
    (resizeCallback as ResizeObserverCallback | null)?.([], {} as ResizeObserver);
    expect(conversation?.scrollTop).toBe(920);
  });

  it("does not reanchor after the user scrolls up", () => {
    let resizeCallback: ResizeObserverCallback | null = null;
    vi.stubGlobal("ResizeObserver", class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe() {}
      disconnect() {}
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    let scrollHeight = 640;
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => scrollHeight);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(320);
    const { container } = render(
      <SessionManagerConversation
        sessionKey="source:thread"
        items={[{ role: "assistant", text: "latest result" }]}
        loading={false}
        error={null}
        incomplete={false}
        fallback={null}
      />,
    );

    const conversation = container.querySelector<HTMLElement>(".session-manager-preview-items");
    if (!conversation) throw new Error("conversation container missing");
    conversation.scrollTop = 100;
    fireEvent.scroll(conversation);
    scrollHeight = 920;
    (resizeCallback as ResizeObserverCallback | null)?.([], {} as ResizeObserver);
    expect(conversation.scrollTop).toBe(100);
  });
});
