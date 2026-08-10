// Deterministic intervals.icu API client + parser — ports tools/sync-intervals.ps1.
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const BASE = "https://intervals.icu/api/v1";

function authHeader(apiKey: string): Record<string, string> {
  const pair = `API_KEY:${apiKey}`;
  const b64 = Buffer.from(pair, "utf8").toString("base64");
  return { Authorization: `Basic ${b64}` };
}

/** Verifies a key by fetching the athlete profile. Throws if invalid. */
export async function verifyIntervalsCredentials(athleteId: string, apiKey: string): Promise<void> {
  const res = await fetch(`${BASE}/athlete/${encodeURIComponent(athleteId)}`, {
    headers: authHeader(apiKey),
  });
  if (!res.ok) {
    throw new Error(res.status === 401 ? "Invalid athlete ID or API key." : `intervals.icu returned ${res.status}`);
  }
}

interface IntervalsActivity {
  id: string | number;
  start_date_local: string;
  type: string;
  name: string;
  distance?: number;
  moving_time?: number;
  average_speed?: number;
  average_heartrate?: number;
  icu_training_load?: number;
}

interface IntervalsWellness {
  id: string;
  ctl?: number | null;
  atl?: number | null;
}

function formatPace(metersPerSec: number | undefined, type: string): string | null {
  if (!metersPerSec || metersPerSec <= 0) return null;
  if (!/run|walk|hike/i.test(type)) return null;
  const secPerKm = 1000 / metersPerSec;
  const m = Math.floor(secPerKm / 60);
  let s = Math.round(secPerKm % 60);
  let mm = m;
  if (s === 60) { mm++; s = 0; }
  return `${mm}:${String(s).padStart(2, "0")}/km`;
}

/**
 * Pulls recent activities + the latest wellness (CTL/ATL/TSB) snapshot from
 * intervals.icu and writes them into Firestore for the given user. Shared by
 * both saveIntervalsIcuCredentials (auto-sync on connect) and
 * syncIntervalsActivities (manual "Sync Now").
 */
export async function syncIntervalsActivitiesForUser(
  uid: string,
  athleteId: string,
  apiKey: string,
  days = 42
): Promise<{ activitiesSynced: number; wellness: { ctl: number; atl: number; tsb: number; asOf: string } | null }> {
  const db = getFirestore();
  const newest = new Date().toISOString().slice(0, 10);
  const oldest = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const headers = authHeader(apiKey);

  const [activitiesRes, wellnessRes] = await Promise.all([
    fetch(`${BASE}/athlete/${encodeURIComponent(athleteId)}/activities?oldest=${oldest}&newest=${newest}`, { headers }),
    fetch(`${BASE}/athlete/${encodeURIComponent(athleteId)}/wellness?oldest=${oldest}&newest=${newest}`, { headers }),
  ]);
  if (!activitiesRes.ok) throw new Error(`intervals.icu activities fetch failed (${activitiesRes.status})`);
  if (!wellnessRes.ok) throw new Error(`intervals.icu wellness fetch failed (${wellnessRes.status})`);

  const activities = (await activitiesRes.json()) as IntervalsActivity[];
  const wellnessRows = (await wellnessRes.json()) as IntervalsWellness[];

  const latestWellness = wellnessRows
    .filter((w) => w.ctl !== null && w.ctl !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id))
    .at(-1);

  let wellness: { ctl: number; atl: number; tsb: number; asOf: string } | null = null;
  if (latestWellness) {
    const ctl = Math.round((latestWellness.ctl ?? 0) * 10) / 10;
    const atl = Math.round((latestWellness.atl ?? 0) * 10) / 10;
    wellness = { ctl, atl, tsb: Math.round((ctl - atl) * 10) / 10, asOf: latestWellness.id };
  }

  const batch = db.batch();
  for (const a of activities) {
    const ref = db.doc(`users/${uid}/activities/${a.id}`);
    batch.set(ref, {
      date: a.start_date_local?.slice(0, 10) ?? null,
      type: a.type,
      name: a.name,
      distance_km: a.distance ? Math.round((a.distance / 1000) * 100) / 100 : null,
      duration_s: a.moving_time ?? null,
      pace: formatPace(a.average_speed, a.type),
      avg_hr: a.average_heartrate ? Math.round(a.average_heartrate) : null,
      training_load: a.icu_training_load ?? null,
      ctl: wellness?.ctl ?? null,
      atl: wellness?.atl ?? null,
      tsb: wellness?.tsb ?? null,
      syncedAt: FieldValue.serverTimestamp(),
      raw: a,
    });
  }

  batch.update(db.doc(`users/${uid}/state/summary`), {
    wellness,
    "integrationsStatus.intervalsIcu.lastSyncedAt": FieldValue.serverTimestamp(),
    "integrationsStatus.intervalsIcu.activitiesSynced": activities.length,
    "integrationsStatus.intervalsIcu.lastError": null,
  });

  await batch.commit();
  return { activitiesSynced: activities.length, wellness };
}
