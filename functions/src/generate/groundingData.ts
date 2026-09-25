// Per-athlete grounding-data fetch (training load, recent activities, Hevy
// progression/adherence) shared by the personal generation path
// (generateProgram.ts) and a group member's Stage B layer generation
// (groupProgram.ts) — extracted so the two don't duplicate this fetch/format
// logic. Firestore-dependent (unlike programDecisions.ts's pure logic).
import { Firestore } from "firebase-admin/firestore";
import { identifyKeyLifts, computeLiftProgression, PROGRESSION_CONFIG } from "../lib/hevyDerivedData";

export interface ActivityDoc {
  date?: string | null;
  type?: string;
  distance_km?: number | null;
  pace?: string | null;
  duration_s?: number | null;
  training_load?: number | null;
}

export interface GroundingData {
  wellness: { ctl?: number; atl?: number; tsb?: number; asOf?: string } | null;
  currentTargets: Record<string, unknown> | null;
  activitySummary: string;
  progressionBlock: string;
  adherenceBlock: string;
}

/**
 * comparisonProgram is whatever "planned" program to diff recent Hevy
 * activity against for the adherence block — the athlete's own active
 * program on the personal path, or the group's current shared sessions on
 * the group Stage B path.
 */
export async function gatherGroundingData(
  db: Firestore,
  uid: string,
  comparisonProgram: { title?: string | null; sessions?: Array<{ exercises?: Array<{ name?: string }> }> } | null
): Promise<GroundingData> {
  const [summarySnap, activitiesSnap, sessionsSnap] = await Promise.all([
    db.doc(`users/${uid}/state/summary`).get(),
    db.collection(`users/${uid}/activities`).orderBy("date", "desc").limit(15).get().catch(() => null),
    db.collection(`users/${uid}/strengthSessions`).orderBy("date", "desc").limit(500).get().catch(() => null),
  ]);
  const summary = summarySnap.data();
  const wellness = summary?.wellness ?? null;
  const currentTargets = summary?.currentTargets ?? null;

  const activities: ActivityDoc[] = activitiesSnap ? activitiesSnap.docs.map((d) => d.data() as ActivityDoc) : [];
  const activitySummary = activities.length
    ? activities
        .map((a) => {
          const bits = [a.date, a.type];
          if (a.distance_km) bits.push(`${a.distance_km}km`);
          if (a.pace) bits.push(a.pace);
          if (a.training_load) bits.push(`load ${a.training_load}`);
          return `- ${bits.filter(Boolean).join(" · ")}`;
        })
        .join("\n")
    : "none synced";

  let progressionBlock = "";
  let adherenceBlock = "";

  try {
    const sessions = sessionsSnap
      ? sessionsSnap.docs.map((d) => ({
          id: d.id,
          date: d.data().date as string,
          title: d.data().title ?? "",
          start_time: d.data().start_time ?? "",
          end_time: d.data().end_time ?? "",
          exercises: d.data().exercises ?? [],
          source: "hevy",
        } as any))
      : [];

    if (sessions.length > 0) {
      const keyLifts = identifyKeyLifts(sessions, PROGRESSION_CONFIG);

      if (keyLifts.length > 0) {
        const progressionLines: string[] = ["Performance & progression (from Hevy):"];

        for (const exercise of keyLifts) {
          try {
            const prog = computeLiftProgression(exercise, sessions, PROGRESSION_CONFIG);
            const lines: string[] = [exercise];

            if (prog.e1RM.current) {
              lines.push(`Current ${Math.round(prog.e1RM.current)}kg e1RM`);
            }
            if (prog.e1RM.pr) {
              lines.push(`PR ${Math.round(prog.e1RM.pr.weight_kg)}kg (${prog.e1RM.pr.date})`);
            }
            if (prog.e1RM.trend_6w) {
              lines.push(`6w trend ${prog.e1RM.trend_6w.direction} ${prog.e1RM.trend_6w.percent_change > 0 ? '+' : ''}${prog.e1RM.trend_6w.percent_change}%`);
            }
            if (prog.frequency.last_trained) {
              lines.push(`last trained ${prog.frequency.last_trained}`);
            }

            progressionLines.push(`- ${lines.join(", ")}`);
          } catch {
            progressionLines.push(`- ${exercise} (incomplete data)`);
          }
        }

        const weeksInData = Math.max(1, Math.round((Date.now() - new Date(sessions[sessions.length - 1].date).getTime()) / (7 * 86400000)));
        const freqPerWeek = (sessions.length / Math.max(weeksInData, 1)).toFixed(1);
        progressionLines.push(`Frequency: ${freqPerWeek} sessions/week`);

        progressionBlock = progressionLines.join("\n");
      } else {
        progressionBlock = "Performance & progression: No key lifts identified yet.";
      }
    } else {
      progressionBlock = "Performance & progression: No Hevy data connected yet.";
    }

    if (comparisonProgram && sessions.length > 0) {
      const lastWeekDate = new Date();
      lastWeekDate.setDate(lastWeekDate.getDate() - 7);
      const lastWeekDateStr = lastWeekDate.toISOString().slice(0, 10);

      const recentSessions = sessions.filter((s) => s.date >= lastWeekDateStr);
      const plannedExercises = new Set<string>();
      if (comparisonProgram.sessions) {
        for (const session of comparisonProgram.sessions) {
          for (const ex of session.exercises || []) {
            plannedExercises.add(ex.name?.toLowerCase() || "");
          }
        }
      }

      const actualExercises = new Set<string>();
      for (const session of recentSessions) {
        for (const ex of session.exercises || []) {
          if (ex.name) actualExercises.add(ex.name.toLowerCase());
        }
      }

      const plannedStr = plannedExercises.size > 0
        ? Array.from(plannedExercises).slice(0, 5).join(", ")
        : "N/A";
      const actualStr = actualExercises.size > 0
        ? Array.from(actualExercises).slice(0, 5).join(", ")
        : "N/A";

      adherenceBlock = [
        "Adherence & deviations (vs last block):",
        `PLANNED: ${comparisonProgram.title || "last program"} — key exercises: ${plannedStr}`,
        `ACTUAL (last 7 days Hevy): ${recentSessions.length} sessions — exercises: ${actualStr}`,
        recentSessions.length >= 3
          ? "Status: Good adherence — keeping most planned exercises."
          : "Status: Below plan — fewer sessions, consider recovery or adjust load.",
      ].join("\n");
    } else {
      adherenceBlock = "Adherence & deviations: No previous program or Hevy data to compare against.";
    }
  } catch {
    progressionBlock = "Performance & progression: Unable to load Hevy data (continue without it).";
    adherenceBlock = "Adherence & deviations: Unable to load history (will generate fresh plan).";
  }

  return { wellness, currentTargets, activitySummary, progressionBlock, adherenceBlock };
}
