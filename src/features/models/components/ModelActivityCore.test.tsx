// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelActivityCore, type ModelActivityState } from "./ModelActivityCore";

const states: ModelActivityState[] = [
  "idle",
  "thinking",
  "executing",
  "waiting",
  "completed",
  "failed",
];

describe("ModelActivityCore", () => {
  it("renders stateful SVG cores without JavaScript animation frames", () => {
    const requestFrame = vi.spyOn(window, "requestAnimationFrame");
    const { container } = render(
      <>
        {Array.from({ length: 40 }, (_, index) => (
          <ModelActivityCore key={index} state={states[index % states.length]} />
        ))}
      </>,
    );

    const cores = container.querySelectorAll<SVGSVGElement>(
      ".model-activity-core",
    );
    expect(cores).toHaveLength(40);
    expect(cores[0]?.tagName).toBe("svg");
    expect(cores[0]?.classList.contains("model-activity-core--compact")).toBe(
      true,
    );
    expect(cores[0]?.querySelector(".model-activity-core__spark")).not.toBeNull();
    states.forEach((state) => {
      expect(
        container.querySelector(`.model-activity-core[data-state="${state}"]`),
      ).not.toBeNull();
    });
    expect(requestFrame).not.toHaveBeenCalled();
    requestFrame.mockRestore();
  });

  it("keeps larger preview cores out of compact amplification", () => {
    const { container } = render(<ModelActivityCore state="thinking" size={28} />);

    expect(
      container
        .querySelector(".model-activity-core")
        ?.classList.contains("model-activity-core--compact"),
    ).toBe(false);
  });
});
