import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, Firestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { parseHevyCsvToCurrentLifts } from "../lib/hevyParser";
import { parseHevyCsvToSessions, StrengthSession } from "../lib/hevyAnalyzer";
import { identifyKeyLifts, computeLiftProgression, PROGRESSION_CONFIG } from "../lib/hevyDerivedData";

interface Input {
  storagePath: string;
}

/**
 * Build a client-facing progression summary from freshly-parsed sessions, using
 * the same hevyDerivedData functions generateProgram grounds its prompt in — so
 * the check-in view and the coach see identical numbers. Never throws: any
 * computation failure degrades to null so a successful import is never blocked.
 */
function buildProgressionSummary(sessions: StrengthSession[]) {
  try {
    if (sessions.length === 0) return null;
    const dates = sessions.map((s) => s.date).sort();
    const dateRange = { first: dates[0], last: dates[dates.length - 1] };

    const keyLifts = identifyKeyLifts(sessions, PROGRESSION_CONFIG)
      .map((exercise) => {
        try {
          const p = computeLiftProgression(exercise, sessions, PROGRESSION_CONFIG);
          return {
            exercise,
            currentE1RM: Math.round(p.e1RM.current),
            pr: p.e1RM.pr ? { weight_kg: Math.round(p.e1RM.pr.weight_kg), date: p.e1RM.pr.date } : null,
            trend: p.e1RM.trend_6w
              ? { direction: p.e1RM.trend_6w.direction, percent_change: p.e1RM.trend_6w.percent_change }
              : null,
            lastTrained: p.frequency.last_trained,
          };
        } catch {
          return null; // exercise with no scorable normal sets (e.g. bodyweight/cardio)
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const weeksSpanned = Math.max(1, Math.round((Date.now() - new Date(dateRange.first).getTime()) / (7 * 86400000)));
    const frequencyPerWeek = Math.round((sessions.length / weeksSpanned) * 10) / 10;

    return { dateRange, frequencyPerWeek, keyLifts };
  } catch {
    return null;
  }
}

// Normalize an exercise name for cross-source matching: lowercase and drop the
// equipment parenthetical, so the program's "Bench Press (Barbell)" matches
// Hevy's "Bench Press" (or vice versa).
function normalizeExercise(name: string): string {
  return name.toLowerCase().replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Compare the just-imported sessions against the athlete's ACTIVE program to
 * show plan adherence — which prescribed lifts were hit, missed, or swapped for
 * something else — over the current block (sessions logged since the program was
 * generated). Gives the import screen context about the user's current plan.
 * Never throws: returns null when there's no active program or no planned lifts.
 */
async function buildAdherenceSummary(db: Firestore, uid: string, sessions: StrengthSession[]) {
  try {
    // Compare against the program the app actually shows (summary.currentProgramId),
    // not just any active doc, so the adherence matches the user's current plan.
    const summarySnap = await db.doc(`users/${uid}/state/summary`).get();
    const currentProgramId = summarySnap.data()?.currentProgramId;
    if (!currentProgramId) return null;
    const progSnap = await db.doc(`users/${uid}/programs/${currentProgramId}`).get();
    if (!progSnap.exists) return null;
    const program = progSnap.data()!;

    // Classes / fixed sessions (e.g. a weekly Hyrox or CrossFit class) aren't
    // logged in Hevy, so they must not count as "planned" work — otherwise they
    // would always read as missed. Exclude any program session whose label
    // matches one of the athlete's fixed sessions (from the program's own
    // profile snapshot, so it reflects the classes at generation time).
    const fixedActivities = new Set(
      ((program.profileSnapshot?.fixed_sessions ?? []) as Array<{ activity?: string }>)
        .map((f) => normalizeExercise(f.activity || ""))
        .filter(Boolean)
    );

    // Planned exercises come from the program's detailed workout sessions only.
    const plannedDisplay = new Map<string, string>(); // normalized -> display name
    for (const s of program.sessions ?? []) {
      if (s?.label && fixedActivities.has(normalizeExercise(s.label))) continue; // skip class sessions
      for (const ex of s.exercises ?? []) {
        if (ex?.name) plannedDisplay.set(normalizeExercise(ex.name), ex.name);
      }
    }
    if (plannedDisplay.size === 0) return null;

    // Actual = the most recent training block: sessions within 14 days of the
    // latest logged session. Anchoring to the latest session (not "now" or the
    // program's creation date) keeps this populated for a weekly check-in even
    // when the plan was just generated or the export is a little stale.
    const latest = sessions.reduce((m, s) => (s.date > m ? s.date : m), sessions[0].date);
    const since = new Date(new Date(latest).getTime() - 14 * 86400000).toISOString().slice(0, 10);
    const windowSessions = sessions.filter((s) => s.date >= since);

    const actualDisplay = new Map<string, string>();
    for (const s of windowSessions) {
      for (const ex of s.exercises ?? []) {
        if (ex?.name) actualDisplay.set(normalizeExercise(ex.name), ex.name);
      }
    }

    const plannedKeys = [...plannedDisplay.keys()];
    const plannedSet = new Set(plannedKeys);
    const actualKeys = new Set(actualDisplay.keys());

    return {
      programTitle: (program.title as string) ?? null,
      since,
      sessionsLogged: windowSessions.length,
      hit: plannedKeys.filter((k) => actualKeys.has(k)).map((k) => plannedDisplay.get(k)!),
      missed: plannedKeys.filter((k) => !actualKeys.has(k)).map((k) => plannedDisplay.get(k)!),
      added: [...actualKeys].filter((k) => !plannedSet.has(k)).map((k) => actualDisplay.get(k)!),
    };
  } catch {
    return null;
  }
}

export const parseHevyCsv = onCall<Input>(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const { storagePath } = request.data;

  const expectedPrefix = `users/${uid}/hevy/`;
  if (!storagePath || !storagePath.startsWith(expectedPrefix)) {
    throw new HttpsError("invalid-argument", "storagePath must be the caller's own upload.");
  }

  const db = getFirestore();
  const bucket = getStorage().bucket();

  try {
    const [buffer] = await bucket.file(storagePath).download();
    const csvText = buffer.toString("utf8");

    // Parse into normalized sessions
    const sessions = parseHevyCsvToSessions(csvText, uid);
    if (sessions.length === 0) {
      throw new HttpsError("invalid-argument", "No sessions found in that CSV — check it's a Hevy export.");
    }

    // Derive current_lifts from latest sessions (backward compat)
    const lifts = parseHevyCsvToCurrentLifts(csvText);
    if (lifts.length === 0) {
      throw new HttpsError("invalid-argument", "No working sets found in that CSV — check it's a Hevy export.");
    }

    // Batch write sessions + update integrationsStatus atomically
    const batch = db.batch();

    for (const session of sessions) {
      const sessionRef = db.doc(`users/${uid}/strengthSessions/${session.id}`);
      batch.set(sessionRef, {
        date: session.date,
        createdAt: FieldValue.serverTimestamp(),
        title: session.title,
        start_time: session.start_time,
        end_time: session.end_time,
        exercises: session.exercises,
        source: session.source,
      }, { merge: false });
    }

    // Update current_lifts (overwrites, backward compat)
    batch.update(db.doc(`users/${uid}`), { "athlete.current_lifts": lifts });

    // Update integrationsStatus with session metrics
    const lastSessionDate = sessions.length > 0 ? sessions[0].date : null;
    batch.update(db.doc(`users/${uid}/state/summary`), {
      "integrationsStatus.hevy": {
        csvUploaded: true,
        storagePath,
        parsedAt: FieldValue.serverTimestamp(),
        sessionsImported: sessions.length,
        liftsImported: lifts.length,
        lastSessionDate,
        lastError: null,
      },
    });

    await batch.commit();

    const progression = buildProgressionSummary(sessions);
    const adherence = await buildAdherenceSummary(db, uid, sessions);
    return { sessionsImported: sessions.length, liftsImported: lifts.length, lifts, progression, adherence };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.doc(`users/${uid}/state/summary`).update({
      "integrationsStatus.hevy.lastError": message,
    }).catch(() => {});
    if (err instanceof HttpsError) throw err;
    throw new HttpsError("internal", `Couldn't parse that CSV: ${message}`);
  }
});
