// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pickAttachmentFiles } from "@services/tauri";
import { attachmentNameFromDataUrl } from "@utils/attachments";
import { I18N_STRINGS } from "@/features/i18n/strings";
import { I18nProvider } from "@/features/i18n/I18nProvider";
import type { RequestUserInputRequest } from "@/types";
import { RequestUserInputMessage } from "./RequestUserInputMessage";
import { UserInputForm } from "./UserInputForm";

const zh = I18N_STRINGS.zh;
vi.mock("@services/tauri", () => ({ pickAttachmentFiles: vi.fn().mockResolvedValue([]) }));
vi.mock("@services/dragDrop", () => ({ subscribeWindowDragDrop: vi.fn(() => () => {}) }));
beforeEach(() => { vi.mocked(pickAttachmentFiles).mockReset().mockResolvedValue([]); });
const choices = [{ id: "region", header: "", question: "ICP?", options: [
  { label: "香港", description: "无备案" }, { label: "大陆", description: "已有备案" },
] }];
afterEach(cleanup);

describe("UserInputForm", () => {
  it("submits attachments with the selected answer and retains both after failure", async () => {
    vi.mocked(pickAttachmentFiles).mockResolvedValue(["C:/files/screenshot.png", "C:/files/report.pdf"]);
    const submit = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const { container } = render(<UserInputForm draftKey={{}} title={zh["userInput.reply"]} questions={choices} attachmentsEnabled onSubmit={submit} />);
    fireEvent.click(screen.getByRole("radio", { name: "香港" }));
    fireEvent.change(screen.getByLabelText(zh["userInput.notes"]), { target: { value: "依旧不行" } });
    fireEvent.click(screen.getByRole("button", { name: zh["composer.addAttachment"] }));
    await screen.findByText("report.pdf");
    fireEvent.click(screen.getByRole("button", { name: zh["userInput.submit"] }));
    await screen.findByRole("alert");
    expect(submit).toHaveBeenLastCalledWith({ answers: { region: { answers: ["香港", "user_note: 依旧不行"] } } }, ["C:/files/screenshot.png", "C:/files/report.pdf"]);
    expect(container.querySelectorAll(".composer-attachment")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: zh["userInput.retry"] }));
    await screen.findByRole("status");
    expect(submit.mock.calls[0]).toEqual(submit.mock.calls[1]);
    expect(container.querySelectorAll(".composer-attachment")).toHaveLength(0);
  });

  it("keeps late file selections scoped to the original card and across remounts", async () => {
    let resolve!: (files: string[]) => void;
    vi.mocked(pickAttachmentFiles).mockReturnValue(new Promise((done) => { resolve = done; }));
    const key = {};
    const props = { draftKey: key, title: zh["userInput.reply"], questions: choices, attachmentsEnabled: true, onSubmit: vi.fn() };
    const { rerender, unmount } = render(<UserInputForm {...props} />);
    fireEvent.click(screen.getByRole("button", { name: zh["composer.addAttachment"] }));
    rerender(<UserInputForm {...props} draftKey={{}} />);
    await act(async () => resolve(["C:/files/original.pdf"]));
    expect(screen.queryByText("original.pdf")).toBeNull();
    unmount();
    render(<UserInputForm {...props} />);
    expect(screen.getByText("original.pdf")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `${zh["composer.remove"]} original.pdf` }));
    expect(screen.queryByText("original.pdf")).toBeNull();
  });

  it("blocks submission until file selection completes and accepts an attachment-only answer", async () => {
    let resolve!: (files: string[]) => void;
    vi.mocked(pickAttachmentFiles).mockReturnValue(new Promise((done) => { resolve = done; }));
    const submit = vi.fn();
    render(<UserInputForm draftKey={{}} title={zh["userInput.reply"]} questions={choices} attachmentsEnabled onSubmit={submit} />);
    fireEvent.click(screen.getByRole("button", { name: zh["composer.addAttachment"] }));
    fireEvent.submit(screen.getByRole("form"));
    expect(submit).not.toHaveBeenCalled();
    await act(async () => resolve(["C:/files/evidence.pdf"]));
    fireEvent.click(screen.getByRole("button", { name: zh["userInput.submit"] }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ answers: { region: { answers: [] } } }, ["C:/files/evidence.pdf"]));
  });

  it("pastes screenshots, drops arbitrary files and previews images", async () => {
    const submit = vi.fn();
    const { container } = render(<UserInputForm draftKey={{}} title={zh["userInput.reply"]} questions={choices} attachmentsEnabled onSubmit={submit} />);
    const image = new File(["pixels"], "clipboard.png", { type: "image/png" });
    fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { files: [image], items: [] } });
    await screen.findByText("clipboard.png");
    fireEvent.click(screen.getByRole("button", { name: `${zh["composer.openImage"]} clipboard.png` }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: zh["common.close"] }));
    const report = new File(["report"], "report.custom", { type: "application/octet-stream" });
    fireEvent.drop(container.querySelector(".request-user-input-body")!, { dataTransfer: { files: [report], items: [] } });
    await screen.findByText("report.custom");
    fireEvent.click(screen.getByRole("button", { name: zh["userInput.submit"] }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0][1].map(attachmentNameFromDataUrl)).toEqual(["clipboard.png", "report.custom"]);
  });

  it("reports picker errors and keeps existing answers available", async () => {
    vi.mocked(pickAttachmentFiles).mockRejectedValue(new Error("picker failed"));
    render(<UserInputForm draftKey={{}} title={zh["userInput.reply"]} questions={choices} attachmentsEnabled onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: "香港" }));
    fireEvent.click(screen.getByRole("button", { name: zh["composer.addAttachment"] }));
    expect((await screen.findByRole("alert")).textContent).toBe(zh["userInput.attachmentFailed"]);
    expect((screen.getByRole("button", { name: zh["userInput.submit"] }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("requires an explicit answer to every question and supports notes", async () => {
    const submit = vi.fn();
    render(<UserInputForm draftKey={{}} title={zh["userInput.title"]} questions={[...choices, { id: "domain", header: "", question: "Domain?" }]} onSubmit={submit} />);
    const button = screen.getByRole("button", { name: zh["userInput.submit"] }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect((screen.getAllByRole("radio")[0] as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("radio", { name: "香港" }));
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(zh["userInput.answer"]), { target: { value: "example.com" } });
    fireEvent.change(screen.getByLabelText(zh["userInput.notes"]), { target: { value: "先测试" } });
    fireEvent.click(button);
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ answers: {
      region: { answers: ["香港", "user_note: 先测试"] }, domain: { answers: ["example.com"] },
    } }));
  });

  it("accepts a custom answer without an option and lets users clear a choice", async () => {
    const submit = vi.fn();
    render(<UserInputForm draftKey={{}} title={zh["userInput.title"]} questions={choices} onSubmit={submit} />);
    fireEvent.click(screen.getAllByRole("radio")[0]);
    fireEvent.click(screen.getByRole("button", { name: zh["userInput.clearSelection"] }));
    fireEvent.change(screen.getByLabelText(zh["userInput.notes"]), { target: { value: "不确定" } });
    fireEvent.click(screen.getByRole("button", { name: zh["userInput.submit"] }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ answers: { region: { answers: ["不确定"] } } }));
  });

  it("keeps choices and a single submission across unmount/navigation", async () => {
    const key = {};
    let resolve!: () => void;
    const submit = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const props = { draftKey: key, title: zh["userInput.title"], questions: choices, onSubmit: submit };
    const first = render(<UserInputForm {...props} />);
    fireEvent.click(screen.getAllByRole("radio")[1]);
    first.unmount();
    const second = render(<UserInputForm {...props} />);
    expect((screen.getAllByRole("radio")[1] as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: zh["userInput.submit"] }));
    second.unmount();
    render(<UserInputForm {...props} />);
    const pending = screen.getByRole("button", { name: zh["userInput.submitting"] }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    fireEvent.click(pending);
    expect(submit).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(); });
    expect(screen.getByRole("status").textContent).toBe(zh["userInput.submitted"]);
  });

  it("retains answers on failure and retries", async () => {
    const submit = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    render(<UserInputForm draftKey={{}} title={zh["userInput.title"]} questions={choices} onSubmit={submit} />);
    fireEvent.click(screen.getAllByRole("radio")[0]);
    fireEvent.click(screen.getByRole("button", { name: zh["userInput.submit"] }));
    await screen.findByRole("alert");
    expect((screen.getAllByRole("radio")[0] as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: zh["userInput.retry"] }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[0]).toEqual(submit.mock.calls[1]);
  });

  it("masks sensitive answers and localizes the form", () => {
    const { container } = render(<I18nProvider preference="en"><UserInputForm draftKey={{}} title={I18N_STRINGS.en["userInput.title"]}
      questions={[{ id: "secret", header: "", question: "Credential?", isSecret: true }]} onSubmit={vi.fn()} /></I18nProvider>);
    expect(container.querySelector('input[type="password"]')).toBeTruthy();
    expect(screen.getByRole("button", { name: I18N_STRINGS.en["userInput.submit"] })).toBeTruthy();
  });

  it("scopes native requests to workspace/thread and removes resolved cards", () => {
    const a: RequestUserInputRequest = { workspace_id: "a", request_id: 1, params: { thread_id: "same", turn_id: "t", item_id: "i", questions: choices } };
    const b: RequestUserInputRequest = { ...a, workspace_id: "b", params: { ...a.params, questions: [{ id: "b", header: "", question: "Other workspace?" }] } };
    const { rerender } = render(<RequestUserInputMessage requests={[a, b]} activeWorkspaceId="a" activeThreadId="same" onSubmit={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("radio")[0]);
    rerender(<RequestUserInputMessage requests={[a, b]} activeWorkspaceId="b" activeThreadId="same" onSubmit={vi.fn()} />);
    expect(screen.queryByText("ICP?")).toBeNull();
    rerender(<RequestUserInputMessage requests={[a, b]} activeWorkspaceId="a" activeThreadId="same" onSubmit={vi.fn()} />);
    expect((screen.getAllByRole("radio")[0] as HTMLInputElement).checked).toBe(true);
    rerender(<RequestUserInputMessage requests={[b]} activeWorkspaceId="a" activeThreadId="same" onSubmit={vi.fn()} />);
    expect(screen.queryByRole("form")).toBeNull();
  });
});
