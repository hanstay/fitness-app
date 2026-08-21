# Check-in Smart Regen Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the standalone "Sync now" button from the check-in page; fold intervals.icu syncing into the "Update my plan" click; gate that click on there being actual new data (profile change, new Hevy import, or a fresh intervals.icu sync) so it never fires a no-op regen.

**Architecture:** Pure frontend change to `public/checkin.html` / `public/js/checkin.js`. No new Cloud Functions — `syncIntervalsActivities` and `generateProgram` are called by name exactly as today, just sequenced differently and preceded by a client-side readiness check. The dashboard's "Regenerate" button is untouched and stays an unconditional override.

**Tech Stack:** Vanilla JS modules against the Firebase Web SDK (Firestore, Functions), matching the existing conventions in `checkin.js` (one-shot reads, `withButtonBusy`, dot-path status setters).

## Global Constraints

- No backend changes. `functions/src/generate/generateProgram.ts` and `functions/src/integrations/syncIntervalsActivities.ts` are unmodified — this plan only changes when/how the frontend calls them.
- The gate is advisory/client-side only, not a security boundary — `generateProgram` remains callable unconditionally (the dashboard's "Regenerate" depends on that staying true).
- `firestore.rules:15` already allows `allow read: if isOwner(uid)` on `users/{uid}/programs/{id}`, so reading the active program doc from `checkin.js` needs no rules change.
- Mirror (don't literally import — it's a Functions-only module) the field set `structuralChanged` in `functions/src/lib/programDecisions.ts:41-54` checks, so the frontend's "did the profile change" signal stays consistent with the backend's own full-vs-incremental decision: `goal`, `training_days_per_week`, `session_length_minutes`, `preferred_split`, `equipment` (as a set), `events` (as a set), `fixed_sessions` (as a set).

---

### Task 1: Remove the standalone "Sync now" button

**Files:**
- Modify: `public/checkin.html:73-75`
- Modify: `public/js/checkin.js:203-215`

**Interfaces:** none new — this only deletes.

- [ ] **Step 1: Remove the button markup in `checkin.html`**

Replace (lines 70-77):
```html
      <div id="icuConnected" style="display:none">
        <p><span class="conn-badge">✓ Connected</span> <span class="muted small" id="icuLastSync"></span></p>
        <div class="stats" id="icuWellness"></div>
        <div class="btn-row" style="margin-top:0">
          <button class="btn secondary" id="icuSyncBtn" type="button">Sync now</button>
        </div>
        <p class="status-line" id="icuStatus"></p>
      </div>
```
with:
```html
      <div id="icuConnected" style="display:none">
        <p><span class="conn-badge">✓ Connected</span> <span class="muted small" id="icuLastSync"></span></p>
        <div class="stats" id="icuWellness"></div>
        <p class="status-line" id="icuStatus"></p>
      </div>
```

- [ ] **Step 2: Delete the `icuSyncBtn` handler in `checkin.js`**

Delete lines 203-215:
```js
document.getElementById("icuSyncBtn").addEventListener("click", (e) => {
  clearMessages();
  setStatus("icuStatus", "Syncing…");
  withButtonBusy(e.currentTarget, "Syncing…", async () => {
    const result = await httpsCallable(functions, "syncIntervalsActivities")();
    setStatus("icuStatus", `Synced ${result.data.activitiesSynced ?? 0} activities.`);
    summary = await loadSummary();
    renderIcuState(summary);
  }).catch((err) => {
    setStatus("icuStatus", "");
    showError(`Sync failed: ${err.message || err}`);
  });
});
```

(Task 2 re-adds an equivalent sync call, just triggered from `regenBtn` instead of its own button — `icuStatus` stays in the markup so that path still has somewhere to report the result.)

- [ ] **Step 3: Manual browser check**

With the emulator suite running and a signed-in, intervals.icu-connected test user, open `checkin.html`, expand the intervals.icu section. Expected: connected state shows the badge, last-sync line, and wellness stats with no "Sync now" button; no console errors from the missing element (confirms nothing else in `checkin.js` references `icuSyncBtn`).

- [ ] **Step 4: Commit**

```bash
git add public/checkin.html public/js/checkin.js
git commit -m "refactor: remove standalone intervals.icu Sync now button from check-in"
```

---

### Task 2: Gate "Update my plan" on new data, folding in the sync

**Files:**
- Modify: `public/js/checkin.js` (imports; new `checkRegenReadiness` helper; rewrite the `regenBtn` handler, currently `checkin.js:248-265`)

**Interfaces:**
- Produces: `checkRegenReadiness({ summary, athlete, activeProgram, syncedThisClick }): { canRegen: boolean, reason: "profile-changed" | "new-hevy" | "fresh-sync" | "no-data-no-connect" | "no-data-sync-failed" | "no-data-stale" }` — pure function, no I/O, unit-testable in isolation even though this repo doesn't currently unit-test frontend JS (see Step 3).
- Consumes: `syncIntervalsActivities`, `generateProgram` callables (unchanged), `db`/`doc`/`getDoc` (already imported).

- [ ] **Step 1: Add the Firestore imports needed for the active-program/profile reads**

`checkin.js` already imports `doc, getDoc` from `firebase-firestore.js` (line 4) — no new import needed there. Add a `collection, query, where, limit, getDocs` import since the active-program lookup needs a query:

Change line 4 from:
```js
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js";
```
to:
```js
import { doc, getDoc, collection, query, where, limit, getDocs } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js";
```

- [ ] **Step 2: Add `loadAthleteAndActiveProgram` + `checkRegenReadiness` helpers**

Insert after the existing `loadSummary` function (near the bottom of the file, currently lines 269-272), before the final `let summary = await loadSummary();` init block:

```js
async function loadAthleteAndActiveProgram() {
  const userSnap = await getDoc(doc(db, "users", user.uid));
  const athlete = userSnap.exists() ? userSnap.data()?.athlete ?? null : null;

  const activeQ = query(collection(db, "users", user.uid, "programs"), where("status", "==", "active"), limit(1));
  const activeSnap = await getDocs(activeQ);
  const activeProgram = activeSnap.empty ? null : activeSnap.docs[0].data();

  return { athlete, activeProgram };
}

// Mirrors the field set functions/src/lib/programDecisions.ts's structuralChanged
// checks server-side, so "did the profile change" stays consistent with the
// backend's own full-vs-incremental decision. A UX gate only — the server
// remains the source of truth for what kind of regen actually runs.
function sameSet(a, b) {
  const sa = [...(a ?? [])].sort();
  const sb = [...(b ?? [])].sort();
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}
function profileStructurallyChanged(athlete, snapshot) {
  if (!snapshot) return true;
  if ((athlete?.goal ?? null) !== (snapshot.goal ?? null)) return true;
  if ((athlete?.training_days_per_week ?? null) !== (snapshot.training_days_per_week ?? null)) return true;
  if ((athlete?.session_length_minutes ?? null) !== (snapshot.session_length_minutes ?? null)) return true;
  if ((athlete?.preferred_split ?? null) !== (snapshot.preferred_split ?? null)) return true;
  if (!sameSet(athlete?.equipment, snapshot.equipment)) return true;
  if (!sameSet(
    (athlete?.events || []).map((e) => `${e.name}|${e.date ?? ""}`),
    (snapshot.events || []).map((e) => `${e.name}|${e.date ?? ""}`)
  )) return true;
  if (!sameSet(
    (athlete?.fixed_sessions || []).map((s) => `${s.day}|${s.activity}`),
    (snapshot.fixed_sessions || []).map((s) => `${s.day}|${s.activity}`)
  )) return true;
  return false;
}

// The three independent signals that make regenerating worthwhile — see
// docs/superpowers/specs/2026-08-21-checkin-smart-regen-gate.md.
function checkRegenReadiness({ summary, athlete, activeProgram, syncedThisClick, syncError }) {
  if (profileStructurallyChanged(athlete, activeProgram?.profileSnapshot)) {
    return { canRegen: true, reason: "profile-changed" };
  }

  const hevyParsedAt = summary?.integrationsStatus?.hevy?.parsedAt?.toMillis?.() ?? null;
  const activeCreatedAt = activeProgram?.createdAt?.toMillis?.() ?? null;
  if (hevyParsedAt != null && (activeCreatedAt == null || hevyParsedAt > activeCreatedAt)) {
    return { canRegen: true, reason: "new-hevy" };
  }

  if (syncedThisClick) {
    return { canRegen: true, reason: "fresh-sync" };
  }

  const hasHevyEver = Boolean(summary?.integrationsStatus?.hevy?.sessionsImported);
  const intervalsConnected = Boolean(summary?.integrationsStatus?.intervalsIcu?.connected);
  if (!intervalsConnected && !hasHevyEver) {
    return { canRegen: false, reason: "no-data-no-connect" };
  }
  if (intervalsConnected && syncError && !hasHevyEver) {
    return { canRegen: false, reason: "no-data-sync-failed" };
  }
  return { canRegen: false, reason: "no-data-stale" };
}
```

- [ ] **Step 3: Rewrite the `regenBtn` handler**

Replace (`checkin.js:248-265`):
```js
document.getElementById("regenBtn").addEventListener("click", (e) => {
  clearMessages();
  document.getElementById("planUpdatedContainer").innerHTML = "";
  setStatus("regenStatus", "Updating your program — this can take a couple of minutes…");
  withButtonBusy(e.currentTarget, "Updating…", async () => {
    const result = await httpsCallable(functions, "generateProgram", { timeout: 300000 })();
    setStatus("regenStatus", "");
    showSuccess("Your program is ready.");
    renderPlanUpdated(result.data);
  }).catch((err) => {
    const msg = String(err?.message || err);
    const isPrecondition = /first|required|Complete/i.test(msg);
    setStatus("regenStatus", "");
    showError(isPrecondition
      ? "Add your training details (days/week, session length) in your profile first."
      : `Couldn't update your program: ${msg}`);
  });
});
```
with:
```js
const REGEN_BLOCK_MESSAGE = {
  "no-data-no-connect": "Nothing new to update your plan with — connect intervals.icu or import a Hevy CSV below. (Or use Regenerate on your dashboard to force a fresh plan.)",
  "no-data-sync-failed": (err) => `Training load didn't sync (${err}) and there's no new Hevy data either — nothing new to base an update on. Fix the connection above, import fresh Hevy data, or use Regenerate on your dashboard.`,
  "no-data-stale": "No new data since your last update — log a session, sync intervals.icu, or use Regenerate on your dashboard to force a fresh plan anyway.",
};

document.getElementById("regenBtn").addEventListener("click", (e) => {
  clearMessages();
  document.getElementById("planUpdatedContainer").innerHTML = "";
  withButtonBusy(e.currentTarget, "Updating…", async () => {
    // Step 1: best-effort sync, folded in from the old standalone "Sync now" button.
    let syncedThisClick = false;
    let syncError = null;
    if (summary?.integrationsStatus?.intervalsIcu?.connected) {
      setStatus("regenStatus", "Syncing training load…");
      try {
        const result = await httpsCallable(functions, "syncIntervalsActivities")();
        setStatus("icuStatus", `Synced ${result.data.activitiesSynced ?? 0} activities.`);
        syncedThisClick = true;
      } catch (err) {
        syncError = err.message || String(err);
        setStatus("icuStatus", "");
        // Non-blocking — recorded for the readiness message below, doesn't stop the flow.
      }
      summary = await loadSummary();
      renderIcuState(summary);
    }

    // Step 2: gate on whether there's actually anything new to react to.
    const { athlete, activeProgram } = await loadAthleteAndActiveProgram();
    const readiness = checkRegenReadiness({ summary, athlete, activeProgram, syncedThisClick, syncError });
    if (!readiness.canRegen) {
      setStatus("regenStatus", "");
      const msg = REGEN_BLOCK_MESSAGE[readiness.reason];
      showError(typeof msg === "function" ? msg(syncError) : msg);
      if (readiness.reason === "no-data-no-connect" || readiness.reason === "no-data-sync-failed") {
        expandSection("icuSection");
        document.getElementById("icuSection").scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
      return; // leaves the button re-enabled via withButtonBusy's catch path — but there's no throw here,
              // so do it explicitly:
    }

    // Step 3: proceed exactly as before.
    setStatus("regenStatus", "Updating your program — this can take a couple of minutes…");
    const result = await httpsCallable(functions, "generateProgram", { timeout: 300000 })();
    setStatus("regenStatus", "");
    showSuccess("Your program is ready.");
    renderPlanUpdated(result.data);
  }).catch((err) => {
    const msg = String(err?.message || err);
    const isPrecondition = /first|required|Complete/i.test(msg);
    setStatus("regenStatus", "");
    showError(isPrecondition
      ? "Add your training details (days/week, session length) in your profile first."
      : `Couldn't update your program: ${msg}`);
  });
});
```

Note the comment left in the gate-block branch above is a flag, not something to ship: `withButtonBusy` (`checkin.js:42-56`) only re-enables the button on a **thrown** error — a plain `return` leaves it disabled as if the call had succeeded. Since a blocked check-in is a normal, retriable outcome (fix the connection, try again), the button must stay clickable. Replace that `return` with `throw new Error("__regen_blocked__")` and special-case it in the outer `.catch`, OR (simpler) restructure so the blocking check short-circuits *before* `withButtonBusy` wraps anything:

```js
document.getElementById("regenBtn").addEventListener("click", async (e) => {
  clearMessages();
  document.getElementById("planUpdatedContainer").innerHTML = "";
  const btn = e.currentTarget;
  if (btn.disabled) return;

  // Preflight (sync + readiness check) runs outside withButtonBusy so a
  // "blocked, nothing changed" outcome leaves the button clickable again —
  // only an actual generateProgram call should latch it disabled on success.
  btn.disabled = true;
  const original = btn.innerHTML;
  btn.innerHTML = `<span class="spinner"></span> Checking…`;
  let syncedThisClick = false;
  let syncError = null;
  try {
    if (summary?.integrationsStatus?.intervalsIcu?.connected) {
      setStatus("regenStatus", "Syncing training load…");
      try {
        const result = await httpsCallable(functions, "syncIntervalsActivities")();
        setStatus("icuStatus", `Synced ${result.data.activitiesSynced ?? 0} activities.`);
        syncedThisClick = true;
      } catch (err) {
        syncError = err.message || String(err);
        setStatus("icuStatus", "");
      }
      summary = await loadSummary();
      renderIcuState(summary);
    }

    const { athlete, activeProgram } = await loadAthleteAndActiveProgram();
    const readiness = checkRegenReadiness({ summary, athlete, activeProgram, syncedThisClick, syncError });
    if (!readiness.canRegen) {
      setStatus("regenStatus", "");
      const msg = REGEN_BLOCK_MESSAGE[readiness.reason];
      showError(typeof msg === "function" ? msg(syncError) : msg);
      if (readiness.reason === "no-data-no-connect" || readiness.reason === "no-data-sync-failed") {
        expandSection("icuSection");
        document.getElementById("icuSection").scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
      btn.disabled = false;
      btn.innerHTML = original;
      return;
    }
  } catch (err) {
    setStatus("regenStatus", "");
    showError(`Couldn't check what's new: ${err.message || err}`);
    btn.disabled = false;
    btn.innerHTML = original;
    return;
  }

  btn.innerHTML = original;
  withButtonBusy(btn, "Updating…", async () => {
    setStatus("regenStatus", "Updating your program — this can take a couple of minutes…");
    const result = await httpsCallable(functions, "generateProgram", { timeout: 300000 })();
    setStatus("regenStatus", "");
    showSuccess("Your program is ready.");
    renderPlanUpdated(result.data);
  }).catch((err) => {
    const msg = String(err?.message || err);
    const isPrecondition = /first|required|Complete/i.test(msg);
    setStatus("regenStatus", "");
    showError(isPrecondition
      ? "Add your training details (days/week, session length) in your profile first."
      : `Couldn't update your program: ${msg}`);
  });
});
```

Use this second version — it keeps `withButtonBusy`'s disabled-on-success / re-enabled-on-failure contract intact for the actual `generateProgram` call, while the preflight (sync + gate) manages the button itself and always leaves it in a sane state.

- [ ] **Step 4: Manual browser check — all four paths**

With the emulator suite running:
1. **Blocked, not connected, no Hevy**: fresh test user, no intervals.icu, no Hevy import → click "Update my plan". Expected: error message (no-data-no-connect variant), `icuSection` expands and scrolls into view, button re-enabled, no `generateProgram` call (check Functions emulator logs).
2. **Blocked, connected but stale**: connect intervals.icu, sync once successfully, don't touch anything else, click again immediately. Expected: no-data-stale message (sync "succeeds" again but nothing new — still gated since `syncedThisClick` alone is treated as "fresh" per Step 2's helper, so actually re-verify this case: syncing again always returns `activitiesSynced` even with 0 new rows, meaning `syncedThisClick` is `true` again and the click WOULD proceed. Decide during implementation whether "fresh-sync" should require `activitiesSynced > 0` or a changed `wellness` value instead of merely "resolved without throwing" — adjust `checkRegenReadiness`'s `fresh-sync` branch accordingly if the plan's definition is too permissive in practice).
3. **Allowed via Hevy**: import a Hevy CSV, click "Update my plan" with intervals.icu not connected. Expected: proceeds straight to generation (no-data branch not hit).
4. **Allowed via profile change**: edit a profile field (e.g. training days/week) on `profile.html`, return to check-in, click "Update my plan" with no new Hevy/intervals data. Expected: proceeds (profile-changed branch).

- [ ] **Step 5: Commit**

```bash
git add public/js/checkin.js
git commit -m "feat: gate check-in plan updates on new data, fold intervals.icu sync into the click"
```
