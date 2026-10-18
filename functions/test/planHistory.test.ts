import { describe, it, expect } from "vitest";
import { planHistoryEntry } from "../src/lib/planHistory";

describe("planHistoryEntry", () => {
  it("keeps the phase, the trainer's read, what changed and the answers to notes", () => {
    const response = { noteId: "n1", tags: ["pain" as const], exercise: "Squat", day: "Monday", text: "Knee", status: "changed" as const, response: "Swapped it." };
    expect(planHistoryEntry({
      source: "group", programId: "g1", mode: "advance", roadmap: [{ phase: "Base" }, { phase: " Build " }], phaseIndex: 1,
      currentState: { summary: " Ready. ", highlights: ["CTL up"] }, changeSummary: ["Base → Build"], feedbackResponses: [response],
    })).toEqual({
      source: "group", programId: "g1", mode: "advance", phase: "Build", summary: "Ready.", highlights: ["CTL up"],
      changeSummary: ["Base → Build"], feedbackResponses: [response],
    });
  });

  it("fills what an update didn't write with empty values", () => {
    expect(planHistoryEntry({ source: "personal", programId: "p1", mode: "incremental", currentState: null }))
      .toEqual({ source: "personal", programId: "p1", mode: "incremental", phase: null, summary: null, highlights: [], changeSummary: [], feedbackResponses: [] });
  });
});
