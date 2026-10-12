// Per-athlete grounding-data fetch (training load, recent activities, Hevy
// training log) shared by the personal generation path (generateProgram.ts)
// and a group member's Stage B layer generation (groupProgram.ts) — extracted
// so the two don't duplicate this fetch/format logic. Firestore-dependent;
// the formatting itself lives in lib/trainingLog.ts (pure, unit-tested).
//
// What goes to the model is what a coach would read: the raw recent log next
// to the plan it was meant to follow, real best sets over time, plain counts,
// and how fresh each data source is — not pre-computed verdicts.
import { Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";
import type { StrengthSession } from "../lib/hevyDerivedData";
import {
  formatRecentLog, formatBestSetsByMonth, weeklySessionCounts,
  buildExerciseVocabulary, formatExerciseVocabulary, formatPrescription, PrescriptionProgram,
  hrZoneLabel, formatHrZoneLegend,
} from "../lib/trainingLog";

export interface ActivityDoc {
  date?: string | null;
  type?: string;
  name?: string | null;
  distance_km?: number | null;
  pace?: string | null;
  duration_s?: number | null;
  avg_hr?: number | null;
  training_load?: number | null;
  hrZones?: number[] | null;
  intervalSummary?: string[] | null;
}

export interface GroundingData {
  wellness: { ctl?: number; atl?: number; tsb?: number; asOf?: string } | null;
  currentTargets: Record<string, unknown> | null;
  /** When each data source was last refreshed, so a missing upload isn't read as missed training. */
  freshnessBlock: string;
  activitySummary: string;
  /** Recent Hevy log + weekly counts + best sets over time. */
  trainingLogBlock: string;
  /** The plan the athlete was meant to be following over that period. */
  prescriptionBlock: string;
  /** Exercise names the athlete actually uses in Hevy, for the plan to reuse. */
  exerciseVocabulary: string;
  /** True when there's a Hevy log to ground loads in (so profile current_lifts can be skipped). */
  hasHevyLog: boolean;
}

const LOG_DAYS = 28;
const DAY_MS = 86400000;

function tsToDate(ts: unknown): string | null {
  const d = (ts as { toDate?: () => Date } | null)?.toDate?.();
  return d ? d.toISOString().slice(0, 10) : null;
}

function daysBetween(from: string, to: string): number {
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / DAY_MS);
}

function toStrengthSessions(docs: QueryDocumentSnapshot[]): StrengthSession[] {
  return docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      date: data.date as string,
      title: data.title ?? "",
      start_time: data.start_time ?? "",
      end_time: data.end_time ?? "",
      exercises: data.exercises ?? [],
      source: "hevy",
    };
  });
}

async function loadStrengthSessions(db: Firestore, uid: string): Promise<StrengthSession[]> {
  const snap = await db.collection(`users/${uid}/strengthSessions`).orderBy("date", "desc").limit(500).get().catch(() => null);
  return snap ? toStrengthSessions(snap.docs) : [];
}

/** Just the athlete's Hevy exercise names — used for each member when designing a group's shared sessions. */
export async function loadExerciseVocabulary(db: Firestore, uid: string, max = 40): Promise<string> {
  const sessions = await loadStrengthSessions(db, uid);
  return formatExerciseVocabulary(buildExerciseVocabulary(sessions, new Date().toISOString().slice(0, 10), 90, max));
}

/**
 * comparisonProgram is the plan the athlete was meant to be following — their
 * own active program on the personal path, or the group's current shared
 * sessions on the group Stage B path.
 */
export async function gatherGroundingData(
  db: Firestore,
  uid: string,
  comparisonProgram: PrescriptionProgram | null
): Promise<GroundingData> {
  const today = new Date().toISOString().slice(0, 10);
  const [summarySnap, activitiesSnap, sessions] = await Promise.all([
    db.doc(`users/${uid}/state/summary`).get(),
    db.collection(`users/${uid}/activities`).orderBy("date", "desc").limit(40).get().catch(() => null),
    loadStrengthSessions(db, uid),
  ]);
  const summary = summarySnap.data();
  const wellness = summary?.wellness ?? null;
  const currentTargets = summary?.currentTargets ?? null;

  // ---- Freshness: facts only, so the model can tell "didn't train" from "didn't upload".
  const hevyStatus = summary?.integrationsStatus?.hevy;
  const icuStatus = summary?.integrationsStatus?.intervalsIcu;
  const latestSession = sessions.reduce<string | null>((m, s) => (!m || s.date > m ? s.date : m), null);
  const freshnessLines = [`Data freshness (today is ${today}):`];
  if (sessions.length === 0) {
    freshnessLines.push("- Hevy: no sessions imported.");
  } else {
    const importedOn = tsToDate(hevyStatus?.parsedAt);
    const gap = latestSession ? daysBetween(latestSession, today) : null;
    freshnessLines.push(
      `- Hevy: last export imported ${importedOn ?? "unknown date"}; latest logged session ${latestSession}` +
        (gap != null && gap > 7
          ? ` (${gap} days ago — this may be a stale upload rather than missed training; don't treat the gap as non-adherence unless other data agrees)`
          : "")
    );
  }
  if (icuStatus?.connected) {
    freshnessLines.push(
      `- intervals.icu: last synced ${tsToDate(icuStatus.lastSyncedAt) ?? "unknown"}; training load as of ${wellness?.asOf ?? "n/a"}`
    );
  } else {
    freshnessLines.push("- intervals.icu: not connected.");
  }
  const freshnessBlock = freshnessLines.join("\n");

  // ---- Activities (runs, rides, classes logged via intervals.icu).
  const logSince = new Date(Date.now() - LOG_DAYS * DAY_MS).toISOString().slice(0, 10);
  const activities: ActivityDoc[] = activitiesSnap
    ? activitiesSnap.docs.map((d) => d.data() as ActivityDoc).filter((a) => !a.date || a.date >= logSince)
    : [];
  const hrZoneLegend = activities.find((a) => a.hrZones && a.hrZones.length > 0)?.hrZones ?? null;
  const activityLines = activities.map((a) => {
    const bits = [a.date, a.type, a.name && a.name !== a.type ? `"${a.name}"` : null];
    if (a.duration_s) bits.push(`${Math.round(a.duration_s / 60)} min`);
    if (a.distance_km) bits.push(`${a.distance_km}km`);
    if (a.pace) bits.push(a.pace);
    if (a.avg_hr) {
      const zone = hrZoneLabel(a.avg_hr, a.hrZones);
      bits.push(`avg HR ${a.avg_hr}${zone ? ` (${zone})` : ""}`);
    }
    if (a.training_load) bits.push(`load ${a.training_load}`);
    if (a.intervalSummary?.length) bits.push(`intervals: ${a.intervalSummary.join(", ")}`);
    return `- ${bits.filter(Boolean).join(" · ")}`;
  });
  const activitySummary = activities.length
    ? [...(hrZoneLegend ? [formatHrZoneLegend(hrZoneLegend), ""] : []), ...activityLines].join("\n")
    : `none in the last ${LOG_DAYS} days`;

  // ---- Hevy training log.
  let trainingLogBlock: string;
  let exerciseVocabulary = "none logged yet";
  try {
    if (sessions.length === 0) {
      trainingLogBlock = "Training log (Hevy): no Hevy data imported yet.";
    } else {
      const counts = weeklySessionCounts(sessions, today, 4);
      const bestSets = formatBestSetsByMonth(sessions, today);
      trainingLogBlock = [
        `Training log (Hevy, last ${LOG_DAYS} days, oldest first; warm-up sets omitted):`,
        formatRecentLog(sessions, today, LOG_DAYS),
        ``,
        `Hevy sessions per week, most recent week first: ${counts.join(", ")}`,
        ...(bestSets ? [``, `Best set per month on main lifts (actual sets, not estimates):`, bestSets] : []),
      ].join("\n");
      exerciseVocabulary = formatExerciseVocabulary(buildExerciseVocabulary(sessions, today));
    }
  } catch {
    trainingLogBlock = "Training log (Hevy): couldn't be loaded — plan without it.";
  }

  const prescriptionBlock = [
    `Prescribed week the athlete was meant to follow (compare the log above against it):`,
    formatPrescription(comparisonProgram),
  ].join("\n");

  return {
    wellness, currentTargets, freshnessBlock, activitySummary, trainingLogBlock, prescriptionBlock, exerciseVocabulary,
    hasHevyLog: sessions.length > 0,
  };
}
