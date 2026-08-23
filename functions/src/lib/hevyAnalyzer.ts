// Parse Hevy CSV into normalized sessions for history analysis.
// Pure functions, no Firebase dependencies.
import { parse } from "csv-parse/sync";
import { Timestamp } from "firebase-admin/firestore";
import * as crypto from "crypto";

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

export interface StrengthSession {
  id: string;
  date: string;
  title: string;
  start_time: string;
  end_time: string;
  exercises: HevyExercise[];
  createdAt: Timestamp;
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

export function generateSessionId(uid: string, startTime: string, title: string): string {
  const input = `${uid}|${startTime}|${title}`;
  const hash = crypto.createHash("sha256").update(input).digest("hex");
  return hash.substring(0, 16);
}

export function rowsToStrengthSession(rows: HevyRow[], uid: string): StrengthSession | null {
  if (rows.length === 0) return null;
  const firstRow = rows[0];
  const title = firstRow.title?.trim();
  const startTimeStr = firstRow.start_time?.trim();
  const endTimeStr = firstRow.end_time?.trim();
  if (!title || !startTimeStr || !endTimeStr) return null;
  const startDate = parseHevyDate(startTimeStr);
  if (!startDate) return null;
  const dateStr = startDate.toISOString().slice(0, 10);
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
  const sessionId = generateSessionId(uid, startTimeStr, title);
  return {
    id: sessionId,
    date: dateStr,
    title,
    start_time: startTimeStr,
    end_time: endTimeStr,
    exercises,
    createdAt: Timestamp.fromDate(startDate),
    source: "hevy",
  };
}

export function parseHevyCsvToSessions(csvText: string, uid: string = ""): StrengthSession[] {
  // Some exports (observed from iOS) mix CRLF and bare-LF line endings within
  // the same file, which makes csv-parse lock onto the wrong record delimiter
  // and throw "Invalid Opening Quote" on the stray \n. Normalize to LF first.
  const rows: HevyRow[] = parse(csvText.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });
  const sessionGroups = groupRowsBySession(rows);
  const sessions: StrengthSession[] = [];
  for (const sessionRows of sessionGroups.values()) {
    const session = rowsToStrengthSession(sessionRows, uid);
    if (session) {
      sessions.push(session);
    }
  }
  return sessions;
}
