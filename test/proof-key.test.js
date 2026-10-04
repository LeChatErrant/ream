import { describe, it, expect } from "vitest";
import { textKey } from "../src/lib/proof-key.js";

describe("textKey", () => {
  it("is stable and ignores whitespace / invisible characters", () => {
    const a = textKey("He looked at Cassie.\u00a0 Then he sighed.");
    expect(textKey("He looked at Cassie. Then\nhe sighed.")).toBe(a);
    expect(textKey("He looked\u200b at Cassie. Then he sighed.\ufeff")).toBe(a);
  });

  it("tells different texts apart", () => {
    expect(textKey("moved ever quicker")).not.toBe(textKey("moved even quicker"));
    expect(textKey("")).not.toBe(textKey("a"));
  });

  it("handles empty input", () => {
    expect(textKey(null)).toBe(textKey(""));
  });
});
