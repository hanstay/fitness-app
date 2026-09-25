import { describe, it, expect } from "vitest";
import { computeWeeksOut, reconcileEvents } from "../src/lib/eventReconciliation";

describe("computeWeeksOut", () => {
  const today = new Date("2026-08-24T00:00:00Z");

  it("computes whole weeks between today and a future date", () => {
    // 2026-11-29 is ~97 days out — 14 weeks, not the "~42 weeks" a real
    // model produced without a today's-date anchor (the bug this fixes).
    expect(computeWeeksOut("2026-11-29", today)).toBe("~14 weeks");
  });

  it("floors negative day counts at zero for a same-day or past event", () => {
    expect(computeWeeksOut("2026-08-24", today)).toBe("~0 weeks");
    expect(computeWeeksOut("2026-01-01", today)).toBe("~0 weeks");
  });

  it("returns null for a missing date", () => {
    expect(computeWeeksOut(null, today)).toBeNull();
    expect(computeWeeksOut(undefined, today)).toBeNull();
  });

  it("returns null for an unparseable date", () => {
    expect(computeWeeksOut("not-a-date", today)).toBeNull();
  });
});

describe("reconcileEvents", () => {
  const today = new Date("2026-08-24T00:00:00Z");
  const llmEvents = [
    { name: "Hyrox Men's Doubles", date: "2026-11-29", weeksOut: "~42 weeks", goal: "Complete doubles race with strong running splits." },
    { name: "Vietnam Trail Marathon", date: "2027-01-16", weeksOut: "~48 weeks", goal: "Finish the half-marathon distance." },
    { name: "30km Birthday Run", date: "2026-12-30", weeksOut: "~44 weeks", goal: "Build aerobic base for 30km." },
  ];

  it("keeps only the group's stated events when the group has stated any", () => {
    const groupEvents = [{ name: "Hyrox Men's Doubles", date: "2026-11-29" }];
    const result = reconcileEvents(llmEvents, groupEvents, today);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Hyrox Men's Doubles");
  });

  it("recomputes weeksOut for the kept event instead of trusting the model's", () => {
    const groupEvents = [{ name: "Hyrox Men's Doubles", date: "2026-11-29" }];
    const result = reconcileEvents(llmEvents, groupEvents, today);
    expect(result[0].weeksOut).toBe("~14 weeks");
  });

  it("matches by name case-insensitively to reuse the model's goal text", () => {
    const groupEvents = [{ name: "hyrox men's doubles", date: "2026-11-29" }];
    const result = reconcileEvents(llmEvents, groupEvents, today);
    expect(result[0].goal).toBe("Complete doubles race with strong running splits.");
  });

  it("falls back to a generic goal when the model didn't propose a matching event", () => {
    const groupEvents = [{ name: "A New Race Nobody Mentioned", date: "2026-11-29" }];
    const result = reconcileEvents(llmEvents, groupEvents, today);
    expect(result[0].goal).toBe("Be ready for A New Race Nobody Mentioned.");
  });

  it("preserves the group's event order, not the model's", () => {
    const groupEvents = [
      { name: "30km Birthday Run", date: "2026-12-30" },
      { name: "Hyrox Men's Doubles", date: "2026-11-29" },
    ];
    const result = reconcileEvents(llmEvents, groupEvents, today);
    expect(result.map((e) => e.name)).toEqual(["30km Birthday Run", "Hyrox Men's Doubles"]);
  });

  it("when the group stated no events, keeps the model's own list but still recomputes weeksOut", () => {
    const result = reconcileEvents(llmEvents, [], today);
    expect(result).toHaveLength(3);
    expect(result.map((e) => e.name)).toEqual(llmEvents.map((e) => e.name));
    expect(result[0].weeksOut).toBe("~14 weeks");
    expect(result[0].goal).toBe(llmEvents[0].goal);
  });
});
