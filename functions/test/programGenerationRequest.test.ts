import { describe, it, expect } from "vitest";
import { toProgramGenerationRequest } from "../src/lib/programGenerationRequest";

describe("toProgramGenerationRequest", () => {
  it("keeps force: true", () => {
    expect(toProgramGenerationRequest({ force: true })).toEqual({ force: true });
  });

  it("defaults force to false when there are no inputs (onboarding, dashboard, older placeholders)", () => {
    expect(toProgramGenerationRequest(undefined)).toEqual({ force: false });
    expect(toProgramGenerationRequest(null)).toEqual({ force: false });
    expect(toProgramGenerationRequest({})).toEqual({ force: false });
  });

  it("treats anything but the boolean true as false", () => {
    for (const force of ["true", 1, false, null, {}]) {
      expect(toProgramGenerationRequest({ force })).toEqual({ force: false });
    }
  });

  it("drops unknown fields", () => {
    expect(toProgramGenerationRequest({ force: true, extra: "x" })).toEqual({ force: true });
  });
});
