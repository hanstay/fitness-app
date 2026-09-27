// Merges a group member's personalized load_notes (sessionLoadsSchema) onto
// the group's shared session skeleton (load_note stripped/null there) — used
// server-side to shape the onCall response the same way a personal program
// looks, and mirrored client-side (public/js) for rendering program.html.
import { SessionOutput, SessionLoadsOutput } from "./schemas";

// Matched per day by exercise name AND occurrence order: a session can hold
// the same name more than once (e.g. three "Running" segments — warm-up,
// tempo, cool-down), and matching by name alone gave every one of them the
// last segment's load_note. The Nth "Running" in the skeleton now gets the
// Nth "Running" load.
export function applySessionLoads(sessions: SessionOutput[], sessionLoads: SessionLoadsOutput): SessionOutput[] {
  const loadsByDay = new Map<string, Map<string, Array<string | null>>>();
  for (const day of sessionLoads) {
    const byName = new Map<string, Array<string | null>>();
    for (const ex of day.exercises) byName.set(ex.name, [...(byName.get(ex.name) ?? []), ex.load_note]);
    loadsByDay.set(day.day, byName);
  }
  return sessions.map((session) => {
    const byName = loadsByDay.get(session.day);
    if (!byName) return session;
    const seen = new Map<string, number>();
    return {
      ...session,
      exercises: session.exercises.map((ex) => {
        const n = seen.get(ex.name) ?? 0;
        seen.set(ex.name, n + 1);
        const loads = byName.get(ex.name);
        return loads && n < loads.length ? { ...ex, load_note: loads[n] ?? null } : ex;
      }),
    };
  });
}
