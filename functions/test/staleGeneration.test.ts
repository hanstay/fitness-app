import { describe, it, expect } from "vitest";
import { isStaleGeneration, GENERATION_STALE_AFTER_MS } from "../src/lib/staleGeneration";

describe("isStaleGeneration", () => {
  const now = new Date("2026-08-18T12:00:00.000Z").getTime();

  it("returns false for a job that just started", () => {
    expect(isStaleGeneration(new Date(now), now)).toBe(false);
  });

  it("returns false for a job just under the threshold", () => {
    const createdAt = new Date(now - (GENERATION_STALE_AFTER_MS - 1000));
    expect(isStaleGeneration(createdAt, now)).toBe(false);
  });

  it("returns true for a job just over the threshold", () => {
    const createdAt = new Date(now - (GENERATION_STALE_AFTER_MS + 1000));
    expect(isStaleGeneration(createdAt, now)).toBe(true);
  });

  it("returns false when createdAt hasn't resolved yet (null)", () => {
    expect(isStaleGeneration(null, now)).toBe(false);
  });

  it("respects a custom threshold", () => {
    const createdAt = new Date(now - 61_000);
    expect(isStaleGeneration(createdAt, now, 60_000)).toBe(true);
    expect(isStaleGeneration(createdAt, now, 120_000)).toBe(false);
  });
});
