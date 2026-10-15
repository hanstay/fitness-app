import { describe, it, expect } from "vitest";
import { estimateCostUsd } from "../src/lib/pricing";

describe("estimateCostUsd", () => {
  it("computes cost for a known model", () => {
    // Sanity check against the manual calculation done for the groups
    // preview testing: 5570 output tokens at $15/MTok, no input tokens here
    // just to isolate the output-side math.
    expect(estimateCostUsd("claude-sonnet-4-5-20250929", 0, 5570)).toBeCloseTo(5570 * 15 / 1_000_000, 10);
  });

  it("combines input and output token cost", () => {
    expect(estimateCostUsd("claude-sonnet-4-5-20250929", 1000, 2000))
      .toBeCloseTo((1000 * 3 + 2000 * 15) / 1_000_000, 10);
  });

  it("prices the current model", () => {
    expect(estimateCostUsd("claude-sonnet-5-5", 1000, 2000)).toBeCloseTo((1000 * 2 + 2000 * 10) / 1_000_000, 10);
  });

  it("prices the fast model used for swap suggestions", () => {
    expect(estimateCostUsd("claude-haiku-5-5", 1000, 2000)).toBeCloseTo((1000 * 0.1 + 2000 * 0.5) / 1_000_000, 10);
  });

  it("returns null for an unrecognized model", () => {
    expect(estimateCostUsd("claude-opus-9000", 1000, 1000)).toBeNull();
  });

  it("returns null when input tokens are missing", () => {
    expect(estimateCostUsd("claude-sonnet-4-5-20250929", null, 1000)).toBeNull();
  });

  it("returns null when output tokens are missing", () => {
    expect(estimateCostUsd("claude-sonnet-4-5-20250929", 1000, null)).toBeNull();
  });
});
