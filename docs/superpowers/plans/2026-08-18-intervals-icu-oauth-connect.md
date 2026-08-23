# intervals.icu OAuth Connect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual athlete-ID/API-key entry for intervals.icu with a popup-based OAuth2 "Connect with intervals.icu" flow, in both onboarding and weekly check-in.

**Architecture:** A popup window carries the user through intervals.icu's OAuth authorize page and back to a static callback page on our own origin; the callback page hands the authorization code to a new Cloud Function (`connectIntervalsIcuOAuth`) that exchanges it server-side for an access token, stores it, and runs the initial sync; the popup then closes and messages the result back to the page that opened it. The existing manual-entry function and fields are deleted, not kept as a fallback.

**Tech Stack:** Firebase Cloud Functions v2 (`onCall`, TypeScript), Firebase Hosting (static files, `cleanUrls: true`), vanilla JS modules against the Firebase Web SDK, vitest for backend tests.

## Global Constraints

- intervals.icu OAuth issues **no refresh token** and access tokens can expire in hours with no documented refresh path (confirmed by intervals.icu's team on their developer forum). Any sync that gets a 401/403 must flip `integrationsStatus.intervalsIcu.connected` to `false` so the UI falls back to showing "Connect" again — never silently fail.
- `credentials/{uid}` stays Admin-SDK-only (`firestore.rules:34` already denies all client read/write on it — no rule changes needed).
- `functions/.env` already has `INTERVALS_ICU_CLIENT_ID`, `INTERVALS_ICU_CLIENT_SECRET`, `INTERVALS_ICU_REDIRECT_URI` populated by the user (gitignored, never commit it).
- The registered redirect URI is `https://fitness-app-47a06.web.app/oauth/intervals-callback` (Firebase's default hosting domain, `cleanUrls: true` serves it from `public/oauth/intervals-callback.html`). If the user registered something different with intervals.icu, both `functions/.env`'s `INTERVALS_ICU_REDIRECT_URI` and the `REDIRECT_URI` constant in `public/js/intervals-oauth.js` (Task 3) need updating together — flag this to the user if the live test in Task 6 fails with a redirect_uri mismatch.
- This repo tests external-API integration code via manual/smoke scripts under `functions/test/manual-*.mjs` run against the emulator (not full automated coverage) — follow that convention rather than inventing a mocking framework for intervals.icu's API.
- OAuth `scope` needed: `ACTIVITY:READ,WELLNESS:READ` (matches what's actually fetched — no write scopes).

---

### Task 1: Backend — OAuth token exchange, client rewrite, sync update

**Files:**
- Modify: `functions/src/lib/intervalsClient.ts` (full rewrite of the auth/signature parts; activity-mapping body unchanged)
- Create: `functions/src/integrations/connectIntervalsIcuOAuth.ts`
- Delete: `functions/src/integrations/saveIntervalsIcuCredentials.ts`
- Modify: `functions/src/integrations/syncIntervalsActivities.ts`
- Modify: `functions/src/index.ts:21` (swap the export)

**Interfaces:**
- Produces: `syncIntervalsActivitiesForUser(uid: string, accessToken: string, days = 42): Promise<{ activitiesSynced: number; wellness: { ctl: number; atl: number; tsb: number; asOf: string } | null }>` — same return shape as before, new second parameter (was `athleteId, apiKey`, now just `accessToken`).
- Produces: `connectIntervalsIcuOAuth` onCall function, request data `{ code: string }`, response `{ connected: true, activitiesSynced: number, wellness: {...} | null, syncError?: string }`.
- Consumes (Task 2): the same two exports above, for the smoke test.
- Consumes (Task 3+): frontend calls `connectIntervalsIcuOAuth` by name via `httpsCallable`.

- [ ] **Step 1: Rewrite `intervalsClient.ts` for Bearer-only auth**

Replace the entire file with:

```ts
// Deterministic intervals.icu API client — ports tools/sync-intervals.ps1.
// Uses OAuth2 Bearer tokens; athlete id "0" is intervals.icu's alias for
// "the athlete who authorized this token" (see connectIntervalsIcuOAuth.ts),
// so callers never need to pass or store a numeric athlete id to make calls.
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const BASE = "https://intervals.icu/api/v1";
const SELF = "0";

function authHeader(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
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
 * both connectIntervalsIcuOAuth (auto-sync on connect) and
 * syncIntervalsActivities (manual "Sync Now").
 */
export async function syncIntervalsActivitiesForUser(
  uid: string,
  accessToken: string,
  days = 42
): Promise<{ activitiesSynced: number; wellness: { ctl: number; atl: number; tsb: number; asOf: string } | null }> {
  const db = getFirestore();
  const newest = new Date().toISOString().slice(0, 10);
  const oldest = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const headers = authHeader(accessToken);

  const [activitiesRes, wellnessRes] = await Promise.all([
    fetch(`${BASE}/athlete/${SELF}/activities?oldest=${oldest}&newest=${newest}`, { headers }),
    fetch(`${BASE}/athlete/${SELF}/wellness?oldest=${oldest}&newest=${newest}`, { headers }),
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
```

(`verifyIntervalsCredentials` is gone — the token exchange in `connectIntervalsIcuOAuth` itself is the verification: if intervals.icu handed back an access token, it's valid.)

- [ ] **Step 2: Delete the manual-entry function**

```bash
rm functions/src/integrations/saveIntervalsIcuCredentials.ts
```

- [ ] **Step 3: Create `connectIntervalsIcuOAuth.ts`**

```ts
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { syncIntervalsActivitiesForUser } from "../lib/intervalsClient";

interface Input {
  code: string;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  athlete: { id: string; name?: string };
}

export const connectIntervalsIcuOAuth = onCall<Input>(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const { code } = request.data;
  if (!code) throw new HttpsError("invalid-argument", "code is required.");

  const clientId = process.env.INTERVALS_ICU_CLIENT_ID;
  const clientSecret = process.env.INTERVALS_ICU_CLIENT_SECRET;
  const redirectUri = process.env.INTERVALS_ICU_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new HttpsError("failed-precondition", "intervals.icu OAuth is not configured on the server.");
  }

  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri });
  const tokenRes = await fetch("https://intervals.icu/api/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => "");
    throw new HttpsError("invalid-argument", `intervals.icu rejected the authorization (${tokenRes.status}): ${text || "no details"}`);
  }
  const token = (await tokenRes.json()) as TokenResponse;

  const db = getFirestore();

  // Credential is valid — store it (Admin SDK only path; never readable by the client)
  // and record connection status before attempting the first sync.
  await db.doc(`credentials/${uid}`).set({
    intervalsIcu: {
      accessToken: token.access_token,
      athleteId: token.athlete?.id ?? null,
      connectedVia: "oauth",
      scope: token.scope ?? null,
      verifiedAt: FieldValue.serverTimestamp(),
      lastVerifyError: null,
    },
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  await db.doc(`users/${uid}/state/summary`).update({
    "integrationsStatus.intervalsIcu.connected": true,
    "integrationsStatus.intervalsIcu.athleteId": token.athlete?.id ?? null,
    "integrationsStatus.intervalsIcu.verifiedAt": FieldValue.serverTimestamp(),
    "integrationsStatus.intervalsIcu.lastError": null,
  });

  // Auto-sync immediately on connect — the initial data pull is part of
  // "connecting," not a separate step the user has to trigger.
  try {
    const { activitiesSynced, wellness } = await syncIntervalsActivitiesForUser(uid, token.access_token);
    return { connected: true, activitiesSynced, wellness };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.doc(`users/${uid}/state/summary`).update({
      "integrationsStatus.intervalsIcu.lastError": message,
    }).catch(() => {});
    // Credential is valid and saved even if the first sync failed — the user
    // can retry sync later without reconnecting.
    return { connected: true, activitiesSynced: 0, wellness: null, syncError: message };
  }
});
```

- [ ] **Step 4: Update `syncIntervalsActivities.ts` for the new credential shape + auth-error handling**

Replace the whole file with:

```ts
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { syncIntervalsActivitiesForUser } from "../lib/intervalsClient";

/** Manual "Sync Now" — re-pulls activities/wellness using the already-stored OAuth token. */
export const syncIntervalsActivities = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;

  const db = getFirestore();
  const credsDoc = await db.doc(`credentials/${uid}`).get();
  const creds = credsDoc.data()?.intervalsIcu;
  if (!creds?.accessToken) {
    throw new HttpsError("failed-precondition", "Connect intervals.icu first.");
  }

  try {
    return await syncIntervalsActivitiesForUser(uid, creds.accessToken);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // No refresh token exists for intervals.icu OAuth — a 401/403 means the
    // token has gone stale and the user must reconnect, not just retry.
    const isAuthError = message.includes("(401)") || message.includes("(403)");
    await db.doc(`users/${uid}/state/summary`).update({
      "integrationsStatus.intervalsIcu.lastError": message,
      ...(isAuthError ? { "integrationsStatus.intervalsIcu.connected": false } : {}),
    }).catch(() => {});
    throw new HttpsError("internal", `Sync failed: ${message}`);
  }
});
```

- [ ] **Step 5: Swap the export in `index.ts`**

In `functions/src/index.ts`, change line 21 from:
```ts
export { saveIntervalsIcuCredentials } from "./integrations/saveIntervalsIcuCredentials";
```
to:
```ts
export { connectIntervalsIcuOAuth } from "./integrations/connectIntervalsIcuOAuth";
```

- [ ] **Step 6: Build to verify no TypeScript errors**

Run: `cd functions && npm run build`
Expected: exits 0, no errors about missing `saveIntervalsIcuCredentials`, no errors about `verifyIntervalsCredentials` being undefined, no signature mismatches.

- [ ] **Step 7: Commit**

```bash
cd functions
git add src/lib/intervalsClient.ts src/integrations/connectIntervalsIcuOAuth.ts src/integrations/syncIntervalsActivities.ts src/index.ts
git rm src/integrations/saveIntervalsIcuCredentials.ts
git commit -m "feat: replace intervals.icu manual API key with OAuth2 token exchange"
```

---

### Task 2: Backend — smoke test for the OAuth functions

The full authorization-code exchange can't be scripted (it requires a real interactive login on intervals.icu's site), so this replaces the old `manual-verify-intervals.mjs` (which called the now-deleted `saveIntervalsIcuCredentials`) with a smoke test of what *is* scriptable against the emulator: auth guards and precondition errors.

**Files:**
- Delete: `functions/test/manual-verify-intervals.mjs`
- Create: `functions/test/manual-verify-intervals-oauth.mjs`

**Interfaces:**
- Consumes: `connectIntervalsIcuOAuth` and `syncIntervalsActivities` (Task 1), by name via `httpsCallable`.

- [ ] **Step 1: Delete the old script**

```bash
rm functions/test/manual-verify-intervals.mjs
```

- [ ] **Step 2: Write the new smoke-test script**

```js
// One-off manual smoke test (not part of the automated test suite) for the
// intervals.icu OAuth Cloud Functions. Runs against the LOCAL EMULATOR only.
//
// The full authorization-code exchange can't be scripted here — intervals.icu
// requires an interactive login in a real browser. This only exercises the
// parts that are scriptable: unauthenticated calls get rejected, and
// syncIntervalsActivities refuses to run without a stored credential. See
// Task 6 in docs/superpowers/plans/2026-08-18-intervals-icu-oauth-connect.md
// for the real end-to-end browser test.
import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";

const app = initializeApp({
  projectId: "hj-training-program-hj2t3of5",
  apiKey: "fake",
  authDomain: "localhost",
});
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const db = getFirestore(app);
connectFirestoreEmulator(db, "127.0.0.1", 8080);
const functions = getFunctions(app);
connectFunctionsEmulator(functions, "127.0.0.1", 5001);

const email = "intervalsoauthtest@example.com";
const password = "testpassword123";

// 1. Unauthenticated calls must be rejected.
const connectFn = httpsCallable(functions, "connectIntervalsIcuOAuth");
try {
  await connectFn({ code: "whatever" });
  console.log("connectIntervalsIcuOAuth without auth: NO ERROR THROWN — SECURITY BUG");
} catch (err) {
  console.log("connectIntervalsIcuOAuth without auth: correctly rejected —", err.code);
}

// 2. Sign in, then missing-code and missing-credential precondition checks.
let cred;
try {
  cred = await signInWithEmailAndPassword(auth, email, password);
} catch {
  cred = await createUserWithEmailAndPassword(auth, email, password);
}
console.log("Signed in as", cred.user.uid);

try {
  await connectFn({});
  console.log("connectIntervalsIcuOAuth with no code: NO ERROR THROWN — BUG");
} catch (err) {
  console.log("connectIntervalsIcuOAuth with no code: correctly rejected —", err.code);
}

const syncFn = httpsCallable(functions, "syncIntervalsActivities");
try {
  await syncFn();
  console.log("syncIntervalsActivities with no stored credential: NO ERROR THROWN — BUG");
} catch (err) {
  console.log("syncIntervalsActivities with no stored credential: correctly rejected —", err.code);
}

await signOut(auth);
process.exit(0);
```

- [ ] **Step 3: Run it against the emulator**

Run: `firebase emulators:start` (in one terminal), then in another: `node functions/test/manual-verify-intervals-oauth.mjs`
Expected output: all three checks print "correctly rejected", no "BUG" lines.

- [ ] **Step 4: Commit**

```bash
git add functions/test/manual-verify-intervals-oauth.mjs
git rm functions/test/manual-verify-intervals.mjs
git commit -m "test: replace intervals.icu manual-verify script with OAuth smoke test"
```

---

### Task 3: Frontend — OAuth popup helper + callback page

**Files:**
- Create: `public/js/intervals-oauth.js`
- Create: `public/oauth/intervals-callback.html`

**Interfaces:**
- Produces: `connectIntervalsIcuViaOAuth(): Promise<{ cancelled: true } | { connected: true, activitiesSynced: number, wellness: object|null, syncError?: string }>` — rejects with an `Error` on popup-blocked or a reported connect failure. Consumed by Task 4 and Task 5.
- Produces: `exchangeIntervalsIcuCode(code: string): Promise<object>` — thin wrapper around the `connectIntervalsIcuOAuth` callable, used only by the callback page.

- [ ] **Step 1: Write `public/js/intervals-oauth.js`**

```js
// Popup-based OAuth connect for intervals.icu. Mirrors the signInWithPopup
// pattern already used for Google sign-in (see login.html) so a full-page
// redirect never destroys in-progress onboarding-wizard state (the wizard
// keeps step state in the DOM only, not persisted — see onboarding-wizard.js).
import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-functions.js";
import { functions } from "./firebase-init.js";

const AUTHORIZE_URL = "https://intervals.icu/oauth/authorize";
const CLIENT_ID = "723";
// Must match INTERVALS_ICU_REDIRECT_URI in functions/.env exactly, and must
// match what's registered with intervals.icu. Update both together.
const REDIRECT_URI = "https://fitness-app-47a06.web.app/oauth/intervals-callback";
const SCOPE = "ACTIVITY:READ,WELLNESS:READ";

/**
 * Opens the intervals.icu OAuth popup and resolves once the callback page
 * reports back via postMessage. Resolves { cancelled: true } if the user
 * closes the popup without completing. Rejects if the popup is blocked or
 * the callback page reports a failure.
 */
export function connectIntervalsIcuViaOAuth() {
  return new Promise((resolve, reject) => {
    const state = crypto.randomUUID();
    const url = `${AUTHORIZE_URL}?client_id=${encodeURIComponent(CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&scope=${encodeURIComponent(SCOPE)}` +
      `&state=${encodeURIComponent(state)}`;
    const popup = window.open(url, "intervals-icu-oauth", "width=480,height=720");
    if (!popup) {
      reject(new Error("Pop-up blocked. Allow pop-ups for this site and try again."));
      return;
    }

    let settled = false;

    function cleanup() {
      window.removeEventListener("message", onMessage);
      clearInterval(pollClosed);
    }

    function onMessage(event) {
      if (event.origin !== location.origin) return;
      const data = event.data;
      if (!data || data.type !== "intervals-oauth-result" || data.state !== state) return;
      settled = true;
      cleanup();
      if (data.error) reject(new Error(data.error));
      else resolve(data.result);
    }

    const pollClosed = setInterval(() => {
      if (popup.closed) {
        cleanup();
        if (!settled) resolve({ cancelled: true });
      }
    }, 500);

    window.addEventListener("message", onMessage);
  });
}

/** Used only by intervals-callback.html to exchange the code it received. */
export async function exchangeIntervalsIcuCode(code) {
  const fn = httpsCallable(functions, "connectIntervalsIcuOAuth");
  const result = await fn({ code });
  return result.data;
}
```

- [ ] **Step 2: Write `public/oauth/intervals-callback.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="robots" content="noindex, nofollow">
<title>Connecting to intervals.icu…</title>
<link rel="stylesheet" href="../styles/theme.css">
</head>
<body>
<div class="wrap narrow" style="padding:60px 0; text-align:center">
  <p id="statusText">Connecting to intervals.icu…</p>
  <p id="closeHint" style="display:none"><a href="#" id="closeLink">Close this window</a></p>
</div>
<script type="module">
  import { exchangeIntervalsIcuCode } from "../js/intervals-oauth.js";
  import { waitForAuthState } from "../js/auth-guard.js";

  const statusText = document.getElementById("statusText");
  const closeHint = document.getElementById("closeHint");
  document.getElementById("closeLink").addEventListener("click", (e) => {
    e.preventDefault();
    window.close();
  });

  function finish(payload) {
    if (window.opener) {
      window.opener.postMessage({ type: "intervals-oauth-result", ...payload }, location.origin);
    }
    window.close();
    // window.close() only works because this window was script-opened (it
    // was — via window.open in intervals-oauth.js). If a popup blocker or
    // browser policy stops it, fall back to a manual close link.
    setTimeout(() => {
      statusText.textContent = payload.error ? "Something went wrong." : "Connected. You can close this window.";
      closeHint.style.display = "block";
    }, 300);
  }

  const params = new URLSearchParams(location.search);
  const state = params.get("state");
  const error = params.get("error");
  const code = params.get("code");

  if (error) {
    finish({ state, error: error === "access_denied" ? "You cancelled the connection." : `intervals.icu error: ${error}` });
  } else if (!code) {
    finish({ state, error: "No authorization code received." });
  } else {
    const user = await waitForAuthState();
    if (!user) {
      finish({ state, error: "You're not signed in." });
    } else {
      try {
        const result = await exchangeIntervalsIcuCode(code);
        finish({ state, result });
      } catch (err) {
        finish({ state, error: err.message || "Couldn't connect to intervals.icu." });
      }
    }
  }
</script>
</body>
</html>
```

- [ ] **Step 3: Verify the popup opens with a well-formed URL**

Start the emulator suite (`firebase emulators:start`) and open `http://127.0.0.1:5000/login.html` in a browser, sign in, navigate to onboarding step 2 (no button wired to this helper yet — this step is just confirming the two new files load without console errors). Open the browser console and run:
```js
import("/js/intervals-oauth.js").then(m => console.log(m.connectIntervalsIcuViaOAuth));
```
Expected: logs the function, no import/module errors in the console.

- [ ] **Step 4: Commit**

```bash
git add public/js/intervals-oauth.js public/oauth/intervals-callback.html
git commit -m "feat: add intervals.icu OAuth popup helper and callback page"
```

---

### Task 4: Frontend — wire onboarding

**Files:**
- Modify: `public/onboarding.html:77-87`
- Modify: `public/js/onboarding-wizard.js:89-108`

**Interfaces:**
- Consumes: `connectIntervalsIcuViaOAuth()` from Task 3.

- [ ] **Step 1: Simplify the "Connect your data" fieldset in `onboarding.html`**

Replace (lines 77-87):
```html
        <div class="field">
          <label for="icuAthleteId">intervals.icu athlete ID</label>
          <input class="input" type="text" id="icuAthleteId" placeholder="i123456">
        </div>
        <div class="field">
          <label for="icuApiKey">intervals.icu API key</label>
          <input class="input" type="password" id="icuApiKey">
          <p class="hint">intervals.icu → Settings → Developer Settings.</p>
        </div>
        <button class="btn secondary" id="icuConnectBtn" type="button">Connect &amp; sync</button>
        <p class="note" id="icuStatus"></p>
```
with:
```html
        <button class="btn secondary" id="icuConnectBtn" type="button">Connect with intervals.icu</button>
        <p class="note" id="icuStatus"></p>
```

- [ ] **Step 2: Replace the connect handler in `onboarding-wizard.js`**

Add to the imports at the top of the file:
```js
import { connectIntervalsIcuViaOAuth } from "./intervals-oauth.js";
```

Replace the `icuConnectBtn` handler (currently lines 89-108):
```js
document.getElementById("icuConnectBtn").addEventListener("click", async () => {
  const athleteId = document.getElementById("icuAthleteId").value.trim();
  const apiKey = document.getElementById("icuApiKey").value.trim();
  const status = document.getElementById("icuStatus");
  if (!athleteId || !apiKey) return showError("Enter both your athlete ID and API key.");
  clearMessages();
  status.textContent = "Verifying and syncing…";
  const btn = document.getElementById("icuConnectBtn");
  btn.disabled = true;
  try {
    const saveCreds = httpsCallable(functions, "saveIntervalsIcuCredentials");
    const result = await saveCreds({ athleteId, apiKey });
    status.textContent = `Connected — synced ${result.data.activitiesSynced ?? 0} recent activities.`;
  } catch (err) {
    status.textContent = "";
    showError(`Couldn't connect to intervals.icu: ${err.message || err}`);
  } finally {
    btn.disabled = false;
  }
});
```
with:
```js
document.getElementById("icuConnectBtn").addEventListener("click", async () => {
  clearMessages();
  const status = document.getElementById("icuStatus");
  const btn = document.getElementById("icuConnectBtn");
  status.textContent = "Connecting…";
  btn.disabled = true;
  try {
    const result = await connectIntervalsIcuViaOAuth();
    if (result.cancelled) {
      status.textContent = "";
    } else if (result.syncError) {
      status.textContent = `Connected, but the first sync failed: ${result.syncError}`;
    } else {
      status.textContent = `Connected — synced ${result.activitiesSynced ?? 0} recent activities.`;
    }
  } catch (err) {
    status.textContent = "";
    showError(`Couldn't connect to intervals.icu: ${err.message || err}`);
  } finally {
    btn.disabled = false;
  }
});
```

- [ ] **Step 3: Manual browser check**

With the emulator suite running, open `http://127.0.0.1:5000/onboarding.html`, get to step 2, click "Connect with intervals.icu". Expected: a popup opens pointed at `https://intervals.icu/oauth/authorize?client_id=723&redirect_uri=...`; closing the popup without logging in leaves the status line blank (no error shown) and re-enables the button.

- [ ] **Step 4: Commit**

```bash
git add public/onboarding.html public/js/onboarding-wizard.js
git commit -m "feat: wire onboarding intervals.icu connect to OAuth popup"
```

---

### Task 5: Frontend — wire check-in

**Files:**
- Modify: `public/checkin.html:66-95`
- Modify: `public/js/checkin.js` (imports, the `icuConnectBtn` handler at lines 182-199, delete the `icuUpdateKeysBtn` handler at lines 203-214)

**Interfaces:**
- Consumes: `connectIntervalsIcuViaOAuth()` from Task 3.

- [ ] **Step 1: Simplify the intervals.icu section in `checkin.html`**

Replace (lines 70-93):
```html
      <div id="icuConnected" style="display:none">
        <p><span class="conn-badge">✓ Connected</span> <span class="muted small" id="icuLastSync"></span></p>
        <div class="stats" id="icuWellness"></div>
        <div class="btn-row" style="margin-top:0">
          <button class="btn secondary" id="icuSyncBtn" type="button">Sync now</button>
          <button class="btn secondary" id="icuUpdateKeysBtn" type="button">Update keys</button>
        </div>
        <p class="status-line" id="icuStatus"></p>
      </div>
      <!-- Not-connected state (also reused to re-enter keys when connected) -->
      <div id="icuDisconnected" style="display:none">
        <p class="muted small">Connect intervals.icu to fold your training load (fitness, fatigue, form) and recent
          activities into your plan. You'll need your athlete ID and an API key from your intervals.icu settings.</p>
        <div class="field">
          <label for="icuAthleteId">Athlete ID</label>
          <input class="input" type="text" id="icuAthleteId" placeholder="i123456" autocomplete="off">
        </div>
        <div class="field">
          <label for="icuApiKey">API key</label>
          <input class="input" type="password" id="icuApiKey" placeholder="Your intervals.icu API key" autocomplete="off">
        </div>
        <button class="btn secondary" id="icuConnectBtn" type="button">Connect &amp; sync</button>
        <p class="status-line" id="icuConnectStatus"></p>
      </div>
```
with:
```html
      <div id="icuConnected" style="display:none">
        <p><span class="conn-badge">✓ Connected</span> <span class="muted small" id="icuLastSync"></span></p>
        <div class="stats" id="icuWellness"></div>
        <div class="btn-row" style="margin-top:0">
          <button class="btn secondary" id="icuSyncBtn" type="button">Sync now</button>
        </div>
        <p class="status-line" id="icuStatus"></p>
      </div>
      <!-- Not-connected state (also shown again if the token goes stale) -->
      <div id="icuDisconnected" style="display:none">
        <p class="muted small">Connect intervals.icu to fold your training load (fitness, fatigue, form) and recent
          activities into your plan.</p>
        <button class="btn secondary" id="icuConnectBtn" type="button">Connect with intervals.icu</button>
        <p class="status-line" id="icuConnectStatus"></p>
      </div>
```

- [ ] **Step 2: Replace the connect handler and delete the update-keys handler in `checkin.js`**

Add to the imports at the top of the file:
```js
import { connectIntervalsIcuViaOAuth } from "./intervals-oauth.js";
```

Replace the `icuConnectBtn` handler (currently lines 182-199):
```js
document.getElementById("icuConnectBtn").addEventListener("click", (e) => {
  const athleteId = document.getElementById("icuAthleteId").value.trim();
  const apiKey = document.getElementById("icuApiKey").value.trim();
  if (!athleteId || !apiKey) return showError("Enter both your athlete ID and API key.");
  clearMessages();
  setStatus("icuConnectStatus", "Verifying and syncing…");
  withButtonBusy(e.currentTarget, "Connecting…", async () => {
    const saveCreds = httpsCallable(functions, "saveIntervalsIcuCredentials");
    const result = await saveCreds({ athleteId, apiKey });
    setStatus("icuConnectStatus", "");
    showSuccess(`Connected — synced ${result.data.activitiesSynced ?? 0} recent activities.`);
    summary = await loadSummary();
    renderIcuState(summary);
  }).catch((err) => {
    setStatus("icuConnectStatus", "");
    showError(`Couldn't connect to intervals.icu: ${err.message || err}`);
  });
});
```
with:
```js
document.getElementById("icuConnectBtn").addEventListener("click", (e) => {
  clearMessages();
  setStatus("icuConnectStatus", "Connecting…");
  withButtonBusy(e.currentTarget, "Connecting…", async () => {
    const result = await connectIntervalsIcuViaOAuth();
    setStatus("icuConnectStatus", "");
    if (result.cancelled) return;
    if (result.syncError) {
      showError(`Connected, but the first sync failed: ${result.syncError}`);
    } else {
      showSuccess(`Connected — synced ${result.activitiesSynced ?? 0} recent activities.`);
    }
    summary = await loadSummary();
    renderIcuState(summary);
  }).catch((err) => {
    setStatus("icuConnectStatus", "");
    showError(`Couldn't connect to intervals.icu: ${err.message || err}`);
  });
});
```

Delete the `icuUpdateKeysBtn` handler entirely (currently lines 203-214):
```js
// Reveal the credential form from the connected state so keys can be replaced
// (expired/rotated key, or a stale connected flag with no stored credential).
document.getElementById("icuUpdateKeysBtn").addEventListener("click", () => {
  const icu = summary?.integrationsStatus?.intervalsIcu;
  const form = document.getElementById("icuDisconnected");
  form.style.display = "block";
  if (icu?.athleteId) document.getElementById("icuAthleteId").value = icu.athleteId;
  document.getElementById("icuApiKey").value = "";
  // Deliberately re-opening the form is a fresh "not sent yet" — clear any
  // disabled state left by an earlier successful connect so keys can be resent.
  document.getElementById("icuConnectBtn").disabled = false;
  document.getElementById("icuApiKey").focus();
  form.scrollIntoView({ behavior: "smooth", block: "nearest" });
});
```
(No replacement needed — `renderIcuState` already shows the `icuDisconnected` block, whose "Connect with intervals.icu" button now doubles as "reconnect," whenever `connected` is false. This is exactly what `syncIntervalsActivities.ts`'s Task 1 change now sets on a 401/403.)

- [ ] **Step 3: Manual browser check**

With the emulator suite running and a signed-in, onboarded test user, open `http://127.0.0.1:5000/checkin.html`, expand the intervals.icu section, click "Connect with intervals.icu". Expected: popup opens with the same authorize URL as Task 4's check; closing it without logging in leaves the status blank and the button re-enabled.

- [ ] **Step 4: Commit**

```bash
git add public/checkin.html public/js/checkin.js
git commit -m "feat: wire check-in intervals.icu connect to OAuth popup"
```

---

### Task 6: End-to-end verification with real intervals.icu credentials

This can't be scripted — it needs the user's real intervals.icu login. Do this together with the user watching, since it also confirms whether the registered redirect URI actually matches `https://fitness-app-47a06.web.app/oauth/intervals-callback`.

**Files:** none (verification only).

- [ ] **Step 1: Deploy or run against the real project**

Either deploy (`firebase deploy --only functions,hosting`) or run the Functions emulator against production Firestore/Auth if that's the team's usual local-test setup — confirm with the user which they want, since this spends real intervals.icu API calls.

- [ ] **Step 2: Walk the real flow**

Sign in to the app, go to onboarding step 2 (or check-in), click "Connect with intervals.icu", log in to intervals.icu for real, approve the requested scopes. Expected: popup closes itself automatically, the page shows "Connected — synced N recent activities," and `users/{uid}/state/summary.integrationsStatus.intervalsIcu.connected` is `true` in the Firestore console.

- [ ] **Step 3: If it fails with a redirect_uri mismatch**

intervals.icu will show its own error page (not our callback) if the URI doesn't match registration. Ask the user for the exact URI they registered, then update both `INTERVALS_ICU_REDIRECT_URI` in `functions/.env` and the `REDIRECT_URI` constant in `public/js/intervals-oauth.js` (Task 3, Step 1) to match, redeploy, and retry.

- [ ] **Step 4: Confirm the manual "Sync Now" still works post-connect**

Click "Sync now" on the check-in page. Expected: status updates to "Synced N activities," no errors.

- [ ] **Step 5: Final commit (if Step 3's fix was needed)**

```bash
git add public/js/intervals-oauth.js
git commit -m "fix: correct intervals.icu OAuth redirect URI"
```
(Skip this step if no fix was needed. `functions/.env` itself is gitignored and never committed — only tell the user the new value if `INTERVALS_ICU_REDIRECT_URI` needed changing there too.)
