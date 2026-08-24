// Deterministic, LLM-free post-processing for a generated program's
// "events" list — fixes two bugs traced to trusting the model with things
// code can just compute:
//   1. weeksOut being wildly wrong (the model has no reliable anchor for
//      "today" unless told, and date arithmetic isn't guaranteed even then).
//   2. individual members' own stale/differing events leaking into a
//      group's roadmap even once the group has its own authoritative list.
// Pure — no Firebase dependency, unit-testable without any API call.
import type { EventOutput } from "./schemas";
import type { GroupEventInput } from "./schemas";

/** Whole-number weeks between today and the event date; null if the date is missing/unparseable. */
export function computeWeeksOut(date: string | null | undefined, today: Date = new Date()): string | null {
  if (!date) return null;
  const eventMs = new Date(date).getTime();
  if (!Number.isFinite(eventMs)) return null;
  const days = Math.round((eventMs - today.getTime()) / 86_400_000);
  return `~${Math.max(0, Math.round(days / 7))} weeks`;
}

/**
 * Reconciles the model's proposed events against the source of truth:
 * - No group-stated events: keep the model's own list, but recompute every
 *   weeksOut deterministically (the "infer from members' profiles" case).
 * - Group has stated events: use ONLY those (in the group's order), matching
 *   by name (case-insensitive) to reuse the model's "goal" description where
 *   it proposed one for that event, and always recomputing weeksOut.
 */
export function reconcileEvents(
  llmEvents: EventOutput[],
  groupEvents: GroupEventInput[],
  today: Date = new Date()
): EventOutput[] {
  if (groupEvents.length === 0) {
    return llmEvents.map((e) => ({ ...e, weeksOut: computeWeeksOut(e.date, today) }));
  }
  const byName = new Map(llmEvents.map((e) => [e.name.trim().toLowerCase(), e]));
  return groupEvents.map((ge) => {
    const match = byName.get(ge.name.trim().toLowerCase());
    return {
      name: ge.name,
      date: ge.date,
      weeksOut: computeWeeksOut(ge.date, today),
      goal: match?.goal ?? `Be ready for ${ge.name}.`,
    };
  });
}
