// Parse Hevy CSV into normalized sessions for history analysis.
// Pure functions with no Firebase or Node dependencies: this module is also
// bundled into the check-in page (see src/web/hevyCheckin.ts), so the CSV is
// parsed in the browser. Session ids are added server-side when saving.
import { parse } from "csv-parse/sync";

// NOTE: Structure is intentionally nested (exercises > sets) to match spec
export interface HevySet {
  index: number;
  type: string;
  weight_kg: number | null;
  reps: number | null;
  distance_km: number | null;
  duration_seconds: number | null;
  rpe: number | null;
}

export interface HevyExercise {
  name: string;
  sets: HevySet[];
}

export interface ParsedHevySession {
  date: string;
  title: string;
  start_time: string;
  end_time: string;
  exercises: HevyExercise[];
  source: "hevy";
}

interface HevyRow {
  title: string;
  start_time: string;
  end_time: string;
  exercise_title: string;
  set_index?: string;
  set_type?: string;
  reps?: string;
  weight_kg?: string;
  weight_lbs?: string;
  distance_km?: string;
  duration_seconds?: string;
  rpe?: string;
  [key: string]: string | undefined;
}

function parseHevyDate(raw: string): Date | null {
  if (!raw) return null;
  const native = new Date(raw);
  if (!isNaN(native.getTime())) return native;
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

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const HAS_ZONE = /(?:z|[+-]\d{2}:?\d{2})$/i;

/**
 * The day a zoneless start time names, read straight off its fields:
 * "13 Oct 2026, 07:15", "Oct 13, 2026, 7:15 AM" or "2026-10-13 07:15".
 * Hevy writes start times on the athlete's wall clock, so this is their
 * day wherever the code runs. Null for anything else.
 */
function wallClockDate(raw: string): string | null {
  const pad = (n: number) => String(n).padStart(2, "0");
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = raw.match(/^(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{4})/i);
  if (dmy && MONTHS[dmy[2].toLowerCase()]) return `${dmy[3]}-${pad(MONTHS[dmy[2].toLowerCase()])}-${pad(Number(dmy[1]))}`;
  const mdy = raw.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i);
  if (mdy && MONTHS[mdy[1].toLowerCase()]) return `${mdy[3]}-${pad(MONTHS[mdy[1].toLowerCase()])}-${pad(Number(mdy[2]))}`;
  return null;
}

/** The calendar day a Date falls on in this runtime's own zone. */
export function localDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The athlete's day for a Hevy start time. toISOString would put a morning
 * workout east of UTC on the day before.
 */
export function hevyDate(raw: string, parsed: Date): string {
  return (!HAS_ZONE.test(raw.trim()) && wallClockDate(raw.trim())) || localDateString(parsed);
}

/**
 * A stored session's day, read again from its start time: sessions imported
 * before hevyDate can carry the UTC day. A start time with a zone keeps the
 * stored day, which the athlete's browser worked out.
 */
export function storedSessionDate(startTime: string | undefined, storedDate: string): string {
  const raw = startTime?.trim() ?? "";
  return (raw && !HAS_ZONE.test(raw) && wallClockDate(raw)) || storedDate;
}

function toKg(row: HevyRow): number | null {
  if (row.weight_kg !== undefined && row.weight_kg !== "") return Number(row.weight_kg);
  if (row.weight_lbs !== undefined && row.weight_lbs !== "") return Number(row.weight_lbs) * 0.453592;
  return null;
}

function toNumber(value: string | undefined): number | null {
  if (!value || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function groupRowsBySession(rows: HevyRow[]): Map<string, HevyRow[]> {
  const sessionMap = new Map<string, HevyRow[]>();
  for (const row of rows) {
    const title = row.title?.trim();
    const startTime = row.start_time?.trim();
    const endTime = row.end_time?.trim();
    if (!title || !startTime || !endTime) continue;
    const sessionKey = `${title}||${startTime}||${endTime}`;
    if (!sessionMap.has(sessionKey)) {
      sessionMap.set(sessionKey, []);
    }
    sessionMap.get(sessionKey)!.push(row);
  }
  return sessionMap;
}

export function rowsToStrengthSession(rows: HevyRow[]): ParsedHevySession | null {
  if (rows.length === 0) return null;
  const firstRow = rows[0];
  const title = firstRow.title?.trim();
  const startTimeStr = firstRow.start_time?.trim();
  const endTimeStr = firstRow.end_time?.trim();
  if (!title || !startTimeStr || !endTimeStr) return null;
  const startDate = parseHevyDate(startTimeStr);
  if (!startDate) return null;
  const dateStr = hevyDate(startTimeStr, startDate);
  const exerciseMap = new Map<string, HevyRow[]>();
  for (const row of rows) {
    const exerciseName = row.exercise_title?.trim();
    if (!exerciseName) continue;
    if (!exerciseMap.has(exerciseName)) {
      exerciseMap.set(exerciseName, []);
    }
    exerciseMap.get(exerciseName)!.push(row);
  }
  const exercises: HevyExercise[] = [];
  for (const [exerciseName, exerciseRows] of exerciseMap) {
    const sets: HevySet[] = exerciseRows
      .map((row) => {
        const index = row.set_index ? Number(row.set_index) : -1;
        if (index < 0) return null;
        return {
          index,
          type: (row.set_type || "normal").toLowerCase(),
          weight_kg: toKg(row),
          reps: toNumber(row.reps),
          distance_km: toNumber(row.distance_km),
          duration_seconds: toNumber(row.duration_seconds),
          rpe: toNumber(row.rpe),
        };
      })
      .filter((set): set is HevySet => set !== null);
    if (sets.length > 0) {
      exercises.push({ name: exerciseName, sets });
    }
  }
  return {
    date: dateStr,
    title,
    start_time: startTimeStr,
    end_time: endTimeStr,
    exercises,
    source: "hevy",
  };
}

export function parseHevyCsvToSessions(csvText: string): ParsedHevySession[] {
  // Some exports (observed from iOS) mix CRLF and bare-LF line endings within
  // the same file, which makes csv-parse lock onto the wrong record delimiter
  // and throw "Invalid Opening Quote" on the stray \n. Normalize to LF first.
  const rows: HevyRow[] = parse(csvText.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });
  const sessionGroups = groupRowsBySession(rows);
  const sessions: ParsedHevySession[] = [];
  for (const sessionRows of sessionGroups.values()) {
    const session = rowsToStrengthSession(sessionRows);
    if (session) {
      sessions.push(session);
    }
  }
  return sessions;
}
