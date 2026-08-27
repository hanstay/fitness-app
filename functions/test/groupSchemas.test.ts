import { describe, it, expect } from "vitest";
import { programSchema, PROGRAM_SHARED_FIELDS, PROGRAM_INDIVIDUAL_FIELDS } from "../src/lib/schemas";

describe("PROGRAM_SHARED_FIELDS / PROGRAM_INDIVIDUAL_FIELDS", () => {
  it("together cover exactly programSchema's keys, with no overlap", () => {
    const fullKeys = new Set(Object.keys(programSchema.shape));
    const shared = new Set(PROGRAM_SHARED_FIELDS);
    const individual = new Set(PROGRAM_INDIVIDUAL_FIELDS);

    for (const key of shared) expect(individual.has(key)).toBe(false);

    const covered = new Set([...shared, ...individual]);
    expect(covered).toEqual(fullKeys);
  });
});
