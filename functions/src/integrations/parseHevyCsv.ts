import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
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
    return { sessionsImported: sessions.length, liftsImported: lifts.length, lifts, progression };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.doc(`users/${uid}/state/summary`).update({
      "integrationsStatus.hevy.lastError": message,
    }).catch(() => {});
    if (err instanceof HttpsError) throw err;
    throw new HttpsError("internal", `Couldn't parse that CSV: ${message}`);
  }
});
