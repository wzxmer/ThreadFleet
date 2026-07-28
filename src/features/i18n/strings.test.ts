import { describe, expect, it } from "vitest";
import { I18N_STRINGS } from "./strings";

describe("I18N_STRINGS", () => {
  it("keeps locale keys in sync", () => {
    expect(Object.keys(I18N_STRINGS.en).sort()).toEqual(
      Object.keys(I18N_STRINGS.zh).sort(),
    );
  });
});
