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
