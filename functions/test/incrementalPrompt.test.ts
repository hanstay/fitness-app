import { describe, it, expect } from "vitest";
import { INCREMENTAL_SYSTEM_PROMPT } from "../src/generate/generateProgram";
import { programUpdateJsonSchema } from "../src/lib/schemas";

// The weekly merge replaces a day as a whole (mergeIncrementalSessions), so
// on a day with two sessions the model must resend the one it didn't change.
describe("the weekly update asks for whole days", () => {
  const WHOLE_DAY = "A day is replaced as a whole: if you change any session on a day, include every session scheduled that day, unchanged ones too";

  it("in the system prompt", () => {
    expect(INCREMENTAL_SYSTEM_PROMPT.replace(/\s+/g, " ")).toContain(WHOLE_DAY);
  });

  it("in the sessions field's description", () => {
    expect(programUpdateJsonSchema.properties.sessions.description).toContain(WHOLE_DAY);
  });
});

// mergeUpdatedWeek keeps a day the weeklyStructure leaves out, so the update
// is asked to mark rest days rather than omit them.
describe("the weekly update asks for all seven days", () => {
  const ALL_DAYS = "all 7 days, rest days included";

  it("in the weeklyStructure field's description", () => {
    expect(programUpdateJsonSchema.properties.weeklyStructure.description).toContain(ALL_DAYS);
  });

  it("in the system prompt", () => {
    expect(INCREMENTAL_SYSTEM_PROMPT.replace(/\s+/g, " ")).toContain("weeklyStructure lists all 7 days, rest days included");
  });
});
