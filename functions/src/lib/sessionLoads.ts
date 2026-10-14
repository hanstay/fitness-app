// Merges a group member's personalized load_notes (sessionLoadsSchema) onto
// the group's shared session skeleton (load_note stripped/null there) — used
// server-side to shape the onCall response the same way a personal program
// looks, and mirrored client-side (public/js) for rendering program.html.
import { SessionOutput, SessionLoadsOutput } from "./schemas";
import { normalizeDay } from "./days";

// Matched per day by exercise name AND occurrence order: a session can hold
// the same name more than once (e.g. three "Running" segments — warm-up,
// tempo, cool-down), and matching by name alone gave every one of them the
// last segment's load_note. The Nth "Running" in the skeleton now gets the
// Nth "Running" load. The count runs across the whole day, so a day with two
// sessions (one loads entry each, or one for both) matches in order too.
// Days are compared as weekdays: a group program saved before day names
// were fixed can say "Mon" where its newer loads say "Monday".
export function applySessionLoads(sessions: SessionOutput[], sessionLoads: SessionLoadsOutput): SessionOutput[] {
  const dayKey = (day: string) => normalizeDay(day) ?? day;
  const loadsByDay = new Map<string, { byName: Map<string, Array<string | null>>; seen: Map<string, number> }>();
  for (const day of sessionLoads) {
    const loads = loadsByDay.get(dayKey(day.day)) ?? { byName: new Map(), seen: new Map() };
    for (const ex of day.exercises) loads.byName.set(ex.name, [...(loads.byName.get(ex.name) ?? []), ex.load_note]);
    loadsByDay.set(dayKey(day.day), loads);
  }
  return sessions.map((session) => {
    const loads = loadsByDay.get(dayKey(session.day));
    if (!loads) return session;
    return {
      ...session,
      exercises: session.exercises.map((ex) => {
        const n = loads.seen.get(ex.name) ?? 0;
        loads.seen.set(ex.name, n + 1);
        const notes = loads.byName.get(ex.name);
        return notes && n < notes.length ? { ...ex, load_note: notes[n] ?? null } : ex;
      }),
    };
  });
}
