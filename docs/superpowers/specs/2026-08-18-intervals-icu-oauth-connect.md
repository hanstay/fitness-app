# intervals.icu OAuth Connect

**Date**: 2026-08-18
**Status**: Approved, ready for implementation
**Scope**: Replace the manual "athlete ID + API key" entry for intervals.icu with an OAuth2 connect flow, in both the onboarding wizard and the weekly check-in page. No other integration (Hevy, Google sign-in) is touched.

## Motivation

Connecting intervals.icu currently requires the user to leave the app, find their athlete ID and API key under intervals.icu → Settings → Developer Settings, and paste both into the onboarding wizard or check-in page. This is friction during signup/onboarding. intervals.icu supports OAuth2 (confirmed via their [developer forum post](https://forum.intervals.icu/t/intervals-icu-oauth-support/2759)); replacing manual entry with a "Connect with intervals.icu" button removes that friction.

## Known constraint: no refresh tokens

intervals.icu's OAuth issues only an access token — no `refresh_token`, no documented `expires_in`. A developer on the forum reported tokens failing with 403s after a few hours, and re-authenticating on a new device invalidates the previous token. There is no way to silently refresh. This spec treats that as acceptable: OAuth is used for the initial connect, and any sync that fails with 401/403 flips the stored connection state back to "disconnected" so the UI naturally re-prompts for "Connect" rather than failing silently or requiring a manual-key fallback.

## Flow

Popup, not full-page redirect. The onboarding wizard keeps step state in the DOM only (not persisted until "Continue"), so navigating the whole tab away to intervals.icu and back would lose in-progress fields on step 2. Google sign-in in this app already uses `signInWithPopup` for the same reason — this follows that precedent.

1. User clicks "Connect with intervals.icu" (onboarding step 2, or check-in's intervals.icu section).
2. Client generates a random `state`, opens a popup to `https://intervals.icu/oauth/authorize?client_id=...&redirect_uri=...&scope=ACTIVITY:READ,WELLNESS:READ&state=...`.
3. User authorizes on intervals.icu's site. It redirects the popup to our own origin: `public/oauth/intervals-callback.html?code=...&state=...`.
4. The callback page calls a new Cloud Function, `connectIntervalsIcuOAuth({ code })`, which exchanges the code for an access token server-side (client_secret never reaches the browser), stores the credential, runs the initial sync, and returns `{ connected, activitiesSynced, wellness, syncError? }`.
5. The callback page `postMessage`s the result back to `window.opener` (origin-checked) and closes itself.
6. The opener's listener (matching the `state` it generated) resolves and updates the same status UI the manual flow used to update.

Popup blocked → inline error, same style as `friendlyError` in `login.html`. Popup closed without completing → treated as a silent cancel (poll `popup.closed`), not an error.

## Backend changes (`functions/src`)

- **New**: `integrations/connectIntervalsIcuOAuth.ts` — `onCall({ code })`. Requires `request.auth`. POSTs to `https://intervals.icu/api/oauth/token` with `client_id`, `client_secret`, `code` (form-encoded). Response gives `access_token` and `athlete.id`. Writes:
  ```
  credentials/{uid}.intervalsIcu = {
    accessToken, athleteId, connectedVia: "oauth", scope,
    verifiedAt: serverTimestamp(), lastVerifyError: null
  }
  users/{uid}/state/summary.integrationsStatus.intervalsIcu = {
    connected: true, athleteId, verifiedAt, lastError: null
  }
  ```
  Then runs the initial sync (same soft-fail pattern as today: credential is saved even if the first sync fails, returning `syncError` instead of throwing).
- **Removed**: `integrations/saveIntervalsIcuCredentials.ts` and its export in `index.ts` (manual entry is fully replaced, not kept as a fallback).
- **Changed**: `lib/intervalsClient.ts` — auth header switches from Basic (`apiKey`) to `Authorization: Bearer <accessToken>`. Athlete ID for API calls becomes the literal `"0"` (intervals.icu's alias for "the authenticated user" per their docs), so we no longer need to store or ask for a numeric athlete ID for API purposes — `athleteId` from the token response is kept only for display.
- **Changed**: `integrations/syncIntervalsActivities.ts` (manual "Sync Now") — reads `accessToken` instead of `apiKey`/`athleteId`. On a 401/403 from intervals.icu, sets `integrationsStatus.intervalsIcu.connected: false` (in addition to `lastError`) instead of just logging the error, so the frontend falls back to showing "Connect" again.
- **Config**: `functions/.env` gains `INTERVALS_ICU_CLIENT_ID`, `INTERVALS_ICU_CLIENT_SECRET`, `INTERVALS_ICU_REDIRECT_URI` (already populated locally by the user; follows the existing `ANTHROPIC_API_KEY`/`dotenv` convention in this repo rather than Firebase Secret Manager).

No `firestore.rules` change needed — `credentials/{uid}` is already admin-only (`allow read, write: if false`).

## Frontend changes (`public`)

- **New**: `public/oauth/intervals-callback.html` — minimal public page (no `auth-guard.js`, same posture as `login.html`), reads `code`/`state`/`error` from the query string, calls `connectIntervalsIcuOAuth`, posts the result to `window.opener`, closes itself. Shows a one-line "Connecting…" message and a manual "close this window" link as a fallback if the automatic close doesn't fire (e.g. popup blockers interfering with `window.close()`).
- **New**: `public/js/intervals-oauth.js` — exports `connectIntervalsIcuViaOAuth()`, returning a Promise that resolves with the same `{ connected, activitiesSynced, wellness, syncError? }` shape `saveIntervalsIcuCredentials` used to return (so call sites barely change), or rejects on popup-blocked/failure, or resolves `{ cancelled: true }` if the user closes the popup.
- **Changed**: `onboarding.html` (step 2 "Connect your data" fieldset) and `checkin.html` (intervals.icu section) — remove the `icuAthleteId`/`icuApiKey` inputs, replace with a single "Connect with intervals.icu" button. Existing status/connected-state elements (`icuStatus`, `icuConnected`, `icuDisconnected`, `icuConnectBtn`, wellness stats) are reused where possible to minimize markup churn.
- **Changed**: `onboarding-wizard.js` and `checkin.js` — `icuConnectBtn` handler calls `connectIntervalsIcuViaOAuth()` instead of the `saveIntervalsIcuCredentials` callable with manual fields. Same success/error rendering as today.
- **Removed**: the "update keys" re-entry flow in `checkin.js` (`icuUpdateKeysBtn`) tied to manual key editing — replaced by simply re-running the connect flow, since OAuth reconnect doesn't need a form to edit.

## Data model / breaking change

`credentials/{uid}.intervalsIcu` changes shape: drops `apiKey`, gains `accessToken` and `connectedVia`. Anyone previously connected via the manual flow will show as connected in `integrationsStatus` but the next sync will fail (missing `accessToken`) and flip `connected` to `false`, naturally prompting reconnect. Given this app is early-stage, this is treated as acceptable without a migration script.

## Testing

The real intervals.icu login/consent redirect can't be run against the Firebase emulator suite — it needs the live intervals.icu site and the credentials already placed in `functions/.env`. Plan:
- Emulator: verify the popup opens, the callback page loads, `postMessage` plumbing and `state` matching work, and the Cloud Function correctly rejects unauthenticated calls.
- Live: run the full connect flow against real intervals.icu with the user's registered app, using the Functions emulator (which makes real outbound `fetch` calls) or a deployed function — confirm `INTERVALS_ICU_REDIRECT_URI` matches what's registered, since a mismatch is intervals.icu's most likely rejection reason.
