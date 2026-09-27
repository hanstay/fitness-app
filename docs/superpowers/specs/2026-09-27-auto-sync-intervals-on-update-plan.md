# Auto-Sync intervals.icu on Check-In Page Load

**Date**: 2026-09-27
**Status**: Approved, ready for implementation
**Scope**: Trigger an intervals.icu activity sync automatically the moment the check-in page loads (client-side), rather than only on manual "Sync Now" or bundled into the "Update my plan" click. No other page or trigger point is touched.

**Revision note:** this replaces the original design (sync triggered server-side, bundled into the `generateProgram` onCall when "Update my plan" is clicked). The user pointed out that syncing on page-load instead lets the intervals.icu network round-trip run in parallel with the user's own Hevy CSV export/upload — which takes real wall-clock time on their end — rather than adding that latency later, at generation time.

## Motivation

`HANDOFF-check-in-and-plan-updates.md`'s open-work list (section 6) names this as priority 1: *"Auto-sync intervals.icu when 'Update my plan' is tapped. Today it only syncs on 'Sync now'."* A user who hasn't separately pressed "Sync Now" gets a plan update grounded on however-stale intervals.icu data. Firing the sync on page entry instead of on the update-plan click means: by the time the user has exported/uploaded their Hevy CSV and pressed "Update my plan," the intervals.icu sync has very likely already finished in the background — a free parallelism win, since the two are otherwise-independent slow operations happening on the same page visit.

## Where this hooks in

`public/js/checkin.js`'s init section already does, on every page load:

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

This is purely a client-side change. `functions/src/generate/generateProgram.ts` (and everything server-side) is untouched — this spec supersedes the prior one's server-side hook entirely, it doesn't add to it.

## Change

Immediately after the existing `try { summary = await loadSummary(); renderIcuState(summary); } catch {...}` block in `checkin.js`'s init section, add:

```javascript
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

This is fire-and-forget: it does not block page render or any other init-section work, and it is only attempted when the user has intervals.icu connected already (`summary.integrationsStatus.intervalsIcu.connected`) — no stored token means nothing to sync, so nothing is called.

On success, `renderIcuState` re-renders using the existing logic already used everywhere else in this file (the manual "Sync Now" button, the "Connect" button) — updating the last-synced timestamp and wellness (CTL/ATL/TSB) stats in place, silently, exactly as agreed. No loading indicator, no status text, no success/error message shown to the user for this specific call.

The existing manual "Sync Now" button (`icuSyncBtn`) is untouched and stays fully independent — a user can still press it any time, even while (or after) the background sync has run. `syncIntervalsActivitiesForUser` is idempotent (each sync does a full `batch.set` per activity), so two syncs racing or running back-to-back is harmless, just mildly redundant network/API usage — not worth guarding against for a page that's realistically visited a few times a week.

## Error handling

Silent per the agreed UX: on failure, `console.error` only — no `showError`, no change to the intervals.icu section's displayed state (it simply keeps showing whatever was last successfully synced). This is deliberately different from the manual "Sync Now" button's error handling (which does show an error, since that's a click the user is actively waiting on) — a background sync the user didn't ask for shouldn't surface an error they didn't cause and can't immediately act on. `integrationsStatus.intervalsIcu.lastError` still gets updated server-side by `syncIntervalsActivities`'s own existing error handling regardless of what the client does with it, so the failure isn't lost — it's just not surfaced on this particular page load.

## Testing

`checkin.js` has no unit test suite (this project's client-side JS is manually verified, consistent with every other change to this file this session). Verification is live: open the check-in page with intervals.icu connected, confirm (via Cloud Functions logs or the Firestore `integrationsStatus.intervalsIcu.lastSyncedAt` timestamp) that a sync fires immediately on load, and confirm the page's intervals.icu stats update in place once it completes, with no visible loading/error state either way.
