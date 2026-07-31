// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConversationExportDocument } from "./ConversationExportDocument";

describe("ConversationExportDocument", () => {
  it("marks failed images so the export placeholder is shown", () => {
    const { container } = render(
      <ConversationExportDocument
        messages={[{
          id: "message-with-broken-image",
          role: "user",
          label: "USER",
          text: "Keep the message body",
          images: ["data:image/png;base64,broken"],
          createdAt: null,
        }]}
        exportedAt={new Date("2026-07-29T00:00:00Z")}
        exportedAtLabel="Exported at"
        imageUnavailableLabel="Image unavailable"
      />,
    );

    const image = container.querySelector("img");
    expect(image).not.toBeNull();
    fireEvent.error(image!);

    expect(container.querySelector("[data-export-image]")?.getAttribute("data-image-error"))
      .toBe("true");
    expect(screen.getByText("Image unavailable")).toBeTruthy();
    expect(screen.getByText("Keep the message body")).toBeTruthy();
  });
});
