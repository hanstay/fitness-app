import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import * as crypto from "crypto";
import { z } from "zod";
import { countNewDocs } from "../lib/newDocs";

// The browser parses the Hevy CSV (src/web/hevyCheckin.ts) and sends the
// parsed sessions and current lifts here. strengthSessions is Functions-only in
// firestore.rules, so this is where the shape is checked before anything is
// stored and fed into program generation.

const num = z.number().finite().nullable();

const SetSchema = z.object({
  index: z.number().int().min(0).max(10000),
  type: z.string().max(40),
  weight_kg: num,
  reps: num,
  distance_km: num,
  duration_seconds: num,
  rpe: num,
});

const SessionSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  title: z.string().min(1).max(200),
  start_time: z.string().min(1).max(100),
  end_time: z.string().min(1).max(100),
  exercises: z.array(z.object({ name: z.string().min(1).max(200), sets: z.array(SetSchema).max(200) })).max(100),
  source: z.literal("hevy"),
});

const LiftSchema = z.object({
  exercise: z.string().min(1).max(200),
  weight_kg: num,
  reps: num,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const InputSchema = z.object({
  sessions: z.array(SessionSchema).min(1).max(5000),
  lifts: z.array(LiftSchema).min(1).max(40),
});

// Deterministic per user + session, so re-importing an overlapping export
// overwrites the same documents instead of duplicating them.
export function generateSessionId(uid: string, startTime: string, title: string): string {
  const input = `${uid}|${startTime}|${title}`;
  const hash = crypto.createHash("sha256").update(input).digest("hex");
  return hash.substring(0, 16);
}

// Firestore caps a batch at 500 writes.
const SESSIONS_PER_BATCH = 400;

export const saveHevySessions = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;

  const parsed = InputSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", "That import didn't look like a Hevy export. Try exporting it again.");
  }
  const { sessions, lifts } = parsed.data;

  const db = getFirestore();
  try {
    const refs = sessions.map((s) => db.doc(`users/${uid}/strengthSessions/${generateSessionId(uid, s.start_time, s.title)}`));
    const newSessions = await countNewDocs(db, refs);
    for (let i = 0; i < sessions.length; i += SESSIONS_PER_BATCH) {
      const batch = db.batch();
      for (const [j, session] of sessions.slice(i, i + SESSIONS_PER_BATCH).entries()) {
        batch.set(refs[i + j], {
          ...session,
          createdAt: FieldValue.serverTimestamp(),
        }, { merge: false });
      }
      await batch.commit();
    }

    // Written last, so integrationsStatus only reports an import once every
    // session is stored.
    const lastSessionDate = sessions.reduce((m, s) => (s.date > m ? s.date : m), sessions[0].date);
    const batch = db.batch();
    // Update current_lifts (overwrites, backward compat)
    batch.update(db.doc(`users/${uid}`), { "athlete.current_lifts": lifts });
    batch.update(db.doc(`users/${uid}/state/summary`), {
      "integrationsStatus.hevy.csvUploaded": true,
      "integrationsStatus.hevy.parsedAt": FieldValue.serverTimestamp(),
      "integrationsStatus.hevy.sessionsImported": sessions.length,
      "integrationsStatus.hevy.newSessions": newSessions,
      "integrationsStatus.hevy.liftsImported": lifts.length,
      "integrationsStatus.hevy.lastSessionDate": lastSessionDate,
      "integrationsStatus.hevy.lastError": null,
      // When the athlete last brought in workouts not stored before; the
      // check-in only offers a plan update for data newer than the plan.
      ...(newSessions > 0 ? { "integrationsStatus.hevy.lastNewDataAt": FieldValue.serverTimestamp() } : {}),
    });
    await batch.commit();

    return { sessionsImported: sessions.length, newSessions, liftsImported: lifts.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.doc(`users/${uid}/state/summary`).update({
      "integrationsStatus.hevy.lastError": message,
    }).catch(() => {});
    throw new HttpsError("internal", `Couldn't save that import: ${message}`);
  }
});
