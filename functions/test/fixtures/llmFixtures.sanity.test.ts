import { describe, it, expect } from "vitest";
import { validateFixtures } from "./llmFixtures";

describe("llmFixtures", () => {
  it("every fixture validates against its real schema", () => {
    expect(() => validateFixtures()).not.toThrow();
  });
});
