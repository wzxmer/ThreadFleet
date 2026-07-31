import { describe, expect, it } from "vitest";
import { getLayoutModeForWidth } from "./useLayoutMode";

describe("getLayoutMode", () => {
  it("keeps desktop chrome through moderately narrow windows so content can clip instead of switching shells", () => {
    expect(getLayoutModeForWidth(900, false)).toBe("desktop");
    expect(getLayoutModeForWidth(721, false)).toBe("desktop");
  });

  it("keeps desktop windows on tablet chrome at the smallest widths and reserves phone for mobile runtime", () => {
    expect(getLayoutModeForWidth(720, false)).toBe("tablet");
    expect(getLayoutModeForWidth(521, false)).toBe("tablet");
    expect(getLayoutModeForWidth(320, false)).toBe("tablet");
    expect(getLayoutModeForWidth(1200, true)).toBe("phone");
  });
});
