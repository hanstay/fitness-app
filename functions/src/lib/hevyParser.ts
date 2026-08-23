// Deterministic Hevy CSV parser — ports tools/sync-hevy.ps1's logic to TypeScript.
// Pure functions, no Firebase/network dependencies, so they're independently unit-testable.
import { parse } from "csv-parse/sync";

export interface CurrentLift {
  exercise: string;
  weight_kg: number | null;
  reps: number | null;
  date: string; // YYYY-MM-DD
}

interface HevyRow {
  title: string;
  start_time: string;
  exercise_title: string;
  set_type?: string;
  reps?: string;
  weight_kg?: string;
  weight_lbs?: string;
  [key: string]: string | undefined;
}

function parseHevyDate(raw: string): Date | null {
  if (!raw) return null;
  // Try native parsing first (handles ISO and many common formats).
  const native = new Date(raw);
  if (!isNaN(native.getTime())) return native;

  // Fallback: "5 Jan 2026, 09:15" / "05 Jan 2026, 09:15"
  const m = raw.match(/^(\d{1,2})\s+(\w{3})\s+(\d{4}),?\s+(\d{1,2}):(\d{2})/);
  if (m) {
    const months: Record<string, number> = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
    const month = months[m[2].toLowerCase().slice(0, 3)];
    if (month !== undefined) {
      return new Date(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]));
    }
  }
  return null;
}

function toKg(row: HevyRow): number | null {
  if (row.weight_kg !== undefined && row.weight_kg !== "") return Number(row.weight_kg);
  if (row.weight_lbs !== undefined && row.weight_lbs !== "") return Number(row.weight_lbs) * 0.453592;
  return null;
}

/**
 * Parses a raw Hevy CSV export and returns a "current lifts" snapshot: the
 * most recent working set (set_type "normal") logged per unique exercise,
 * sorted newest-first. Mirrors the intent of sync-hevy.ps1's output but
 * flattened for the athlete.current_lifts profile field rather than the
 * full per-session strength log (that's a Phase 2 concern).
 *
 * Filters to a recency window (not a flat top-N) so exercises trained
 * weekly-or-so (e.g. a squat on a leg day) survive even when other
 * exercises are trained more frequently — a flat top-15-by-recency cut
 * was found to drop major compounds in testing against a real 148-exercise
 * history. `limit` remains a safety net for pathological exercise variety.
 */
export function parseHevyCsvToCurrentLifts(csvText: string, windowDays = 30, limit = 40): CurrentLift[] {
  // Some exports (observed from iOS) mix CRLF and bare-LF line endings within
  // the same file, which makes csv-parse lock onto the wrong record delimiter
  // and throw "Invalid Opening Quote" on the stray \n. Normalize to LF first.
  const rows: HevyRow[] = parse(csvText.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });

  const cutoff = Date.now() - windowDays * 86400000;
  const latestByExercise = new Map<string, { date: Date; lift: CurrentLift }>();

  for (const row of rows) {
    const setType = (row.set_type || "normal").toLowerCase();
    if (setType !== "normal") continue; // skip warmup/failure/drop sets for a "working" snapshot

    const exercise = row.exercise_title?.trim();
    if (!exercise) continue;

    const date = parseHevyDate(row.start_time);
    if (!date || date.getTime() < cutoff) continue;

    const existing = latestByExercise.get(exercise);
    // Keep the most recent session; within the same session (identical
    // start_time), prefer the LAST row encountered — Hevy exports rows in
    // performance order, so this is typically the heaviest/top working set,
    // not the first one after warmups.
    if (existing && existing.date > date) continue;

    const weight_kg = toKg(row);
    const reps = row.reps ? Number(row.reps) : null;

    latestByExercise.set(exercise, {
      date,
      lift: {
        exercise,
        weight_kg: weight_kg !== null ? Math.round(weight_kg * 10) / 10 : null,
        reps: Number.isFinite(reps) ? reps : null,
        date: date.toISOString().slice(0, 10),
      },
    });
  }

  return Array.from(latestByExercise.values())
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(0, limit)
    .map((v) => v.lift);
}
