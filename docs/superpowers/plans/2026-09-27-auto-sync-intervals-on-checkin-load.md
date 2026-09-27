# Auto-Sync intervals.icu on Check-In Page Load Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fire an intervals.icu activity sync automatically the moment the check-in page loads, so it runs in parallel with the user's own (slower, manual) Hevy CSV export/upload instead of adding latency later at "Update my plan" time.

**Architecture:** One client-side addition to `public/js/checkin.js`'s existing init section — a fire-and-forget call to the already-existing `syncIntervalsActivities` callable, gated on the user already being connected, that silently re-renders the existing intervals.icu status UI on completion using the file's existing `loadSummary()`/`renderIcuState()` functions.

**Tech Stack:** Vanilla JS (ES modules), Firebase client SDK (`httpsCallable`), Firebase Hosting.

## Global Constraints

- Client-side only — no changes to `functions/src` or any Cloud Function.
- Fire-and-forget: must not block page render or delay any other init-section work.
- Only attempted when `summary.integrationsStatus.intervalsIcu.connected` is true — no stored token means no call.
- Silent on both success and failure: no loading indicator, no status text, no `showError`/`showSuccess` call for this specific sync. On success, re-render the existing intervals.icu stats in place via the existing `renderIcuState()`. On failure, `console.error` only.
- The existing manual "Sync Now" button (`icuSyncBtn`) must stay fully untouched and independently clickable.

---

### Task 1: Fire the background sync on page load

**Files:**
- Modify: `public/js/checkin.js:261-268` (the init section's existing summary-load block)

**Interfaces:**
- Consumes: `loadSummary()` (defined at `checkin.js:256-259`, returns `Promise<object|null>` — the `users/{uid}/state/summary` doc), `renderIcuState(summary)` (defined at `checkin.js:156-167`, re-renders the intervals.icu section from a summary object), `httpsCallable` (already imported at the top of the file), `functions` (already imported at the top of the file).
- Produces: nothing new consumed elsewhere — this is a leaf, self-contained addition.

- [ ] **Step 1: Add the background sync block**

In `public/js/checkin.js`, find this existing block (currently the last thing in the file, lines 261-268):

```javascript
let summary = null;
try {
  summary = await loadSummary();
  renderIcuState(summary);
} catch (err) {
  console.error("[checkin] failed to load summary", err);
  showError("Couldn't load your intervals.icu status — Hevy import and program updates below still work.");
}
```

Replace it with (the only change is the new `if` block appended after the existing `try`/`catch`):

```javascript
let summary = null;
try {
  summary = await loadSummary();
  renderIcuState(summary);
} catch (err) {
  console.error("[checkin] failed to load summary", err);
  showError("Couldn't load your intervals.icu status — Hevy import and program updates below still work.");
}

// Fire-and-forget: runs in parallel with the user's own Hevy CSV export/
// upload instead of adding latency later, at "Update my plan" time.
if (summary?.integrationsStatus?.intervalsIcu?.connected) {
  httpsCallable(functions, "syncIntervalsActivities")()
    .then(async () => {
      summary = await loadSummary();
      renderIcuState(summary);
    })
    .catch((err) => {
      console.error("[checkin] background intervals.icu sync failed", err);
    });
}
```

- [ ] **Step 2: Verify the file has no syntax errors**

This file isn't run through a bundler/build step (it's served as a plain ES module — see the `<script type="module">` include in `checkin.html`), so there's no `tsc`/build command to run. Instead, verify it parses cleanly with Node's own syntax check:

Run (from the repo root): `node --check public/js/checkin.js`
Expected: no output, exit code 0. (This only checks JS syntax validity, not browser-specific APIs like `document`/`window` — that's expected and fine; it will not execute the module.)

- [ ] **Step 3: Commit**

```bash
git add public/js/checkin.js
git commit -m "Auto-sync intervals.icu in the background on check-in page load"
```

---

### Task 2: Deploy and verify against real data

**Files:** none (deploy + manual verification only)

**Interfaces:**
- Consumes: the deployed `syncIntervalsActivities` callable (unchanged — Task 1 calls it exactly as `checkin.js`'s existing "Sync Now" button already does).

- [ ] **Step 1: Deploy hosting**

Run (from repo root): `npx firebase-tools deploy --only hosting`

Expected: `Deploy complete!`, no errors. (Only `hosting` needs deploying — Task 1 touches no Cloud Function.)

- [ ] **Step 2: Load the check-in page and confirm the sync fires**

Note the current `lastSyncedAt` value first: open the Firebase console at `https://console.firebase.google.com/project/fitness-app-47a06/firestore/databases/-default-/data/~2Fusers~2F<uid>~2Fstate~2Fsummary` (substitute the real uid) and record `integrationsStatus.intervalsIcu.lastSyncedAt`.

Then, in a browser signed in as that user, navigate to `https://fitness-app-47a06.web.app/checkin.html`. Do not click "Sync Now" or "Update my plan" — just let the page load and sit for a few seconds.

- [ ] **Step 3: Confirm the sync actually ran**

Refresh the same Firestore document from Step 1. Expected: `integrationsStatus.intervalsIcu.lastSyncedAt` has advanced to a new, more recent timestamp than what was recorded in Step 1 — proving the background sync fired without any button click.

- [ ] **Step 4: Confirm the UI updated silently**

On the check-in page itself (no reload needed), confirm the intervals.icu section's "last synced" display (`#icuLastSync`, rendered by `renderIcuState`) reflects the new sync time, and that no loading spinner, status text, or error message appeared anywhere on the page during this — matching the "silent" requirement from Global Constraints.

No commit for this task (no code changes).
