# Coaching data gaps

**Written:** 2026-09-27, at the end of the session that shipped `docs/superpowers/specs/2026-09-27-run-hr-zone-interval-context.md`
and `docs/superpowers/specs/2026-09-27-auto-sync-intervals-on-update-plan.md`.

That session closed the *cardio-intensity legibility* gap (the model went from seeing one raw average HR
number per activity to seeing HR-zone labels, a zone legend, and per-interval structure). This doc records
what's still missing between that and a genuinely elite virtual coach — evaluated against the real,
live Firestore data for `hanstay1234@gmail.com` (uid `a1WwEO2HUhM2P4ZsvA6d7y1IOdj2`), not speculation.

None of the items below were in scope for the session that produced this doc — they're open findings, not
unfinished work from that session's own spec.

## 1. Zero subjective data

Every synced intervals.icu activity inspected this session has `session_rpe: null`, `feel: null`,
`icu_rpe: null`, `perceived_exertion: null`. Neither the Hevy CSV import nor the intervals.icu sync
captures how a session actually felt to the athlete. A coach who only sees HR/pace and never "how did
that feel" is missing the signal that catches overreaching before HR/pace numbers show it.

**Possible fix:** a simple post-session RPE prompt (1-10) somewhere in the app, stored against the
session/activity doc, surfaced in `groundingData.ts` alongside the existing HR/pace data.

## 2. Recovery/readiness is entirely unfilled

The athlete profile's `recovery` map (`users/{uid}.athlete.recovery`) has `sleep_hours: null`,
`sleep_quality: null`, `stress_1_10: null` — present in the onboarding schema, never populated. Given the
model already flagged this athlete as highly fatigued (TSB −10.8) in a real generation this session,
coaching fatigue without any sleep/stress input is working from half the picture.

**Possible fix:** either prompt for these at check-in time (lightweight, manual), or pull them from a
wearable integration if one ever gets added — no such integration exists today.

## 3. No real pace zones / threshold pace

Deliberately investigated and deferred this session (see the run-hr-zone-interval-context spec's
Motivation section) — the athlete hasn't set a threshold pace in intervals.icu (Settings → Sport Settings
→ Run), which is a manual, unset-by-default field with no auto-calculate option there. Until set,
`pace_zone_times`/`pace_zones`/`threshold_pace` stay null on every synced activity regardless of OAuth
scope. Matters specifically for this athlete: the goal is Hyrox *race-pace running*, and pace-based
intensity judgment (independent of HR, which drifts with heat/fatigue) needs this.

**Possible fix:** none in-app — this is a value only the athlete can meaningfully set, informed by a real
time trial or race result. Once set, the deferred `SETTINGS:READ` scope + `sport-settings` fetch work
(originally proposed, then intentionally not built) becomes worth revisiting.

## 4. No per-lap granularity

The `interval_summary` field (shipped this session) is a coarse digest intervals.icu computes itself —
e.g. `"1x 7m16s 131bpm, 1x 6m41s 146bpm, 2x 9m6s 152bpm"` — rep count, rep duration, rep average HR.
It does **not** include: pace/speed per rep, HR drift within a rep (fading vs. holding steady), or
recovery-between-reps detail. That data exists on intervals.icu's separate
`GET /api/v1/activity/{id}/intervals` endpoint, which has never been fetched — this is priority 3 on
`HANDOFF-check-in-and-plan-updates.md`'s original open-work list and remains untouched.

**Possible fix:** exactly what the handoff already proposed — fetch `/activity/{id}/intervals` for runs
that were planned as workouts, at minimum for tempo/interval sessions, and feed per-rep pace + HR trend
into the prompt.

## 5. Hyrox stations aren't modeled as stations

Sled push, wall balls, farmer's carry, etc. are logged as generic Hevy strength sets (exercise name +
weight × reps) — see e.g. `athlete.current_lifts` entries for "Sled Push", "Wall Ball", "Farmers Walk" in
this athlete's own profile. There's no timed-station metric (time-to-complete a sled push, transition
time between stations), so the model can judge generic strength progress on these movements but not
actual race-simulation readiness.

**Possible fix:** would need either a dedicated Hyrox-station logging flow (out of scope for Hevy's
strength-training data model) or a race-simulation / brick-workout activity type with its own timing
capture — a larger feature, not a quick add.

## 6. No merged day-by-day view

Already known before this session (`HANDOFF-check-in-and-plan-updates.md` item 5, "Day-by-day 'planned vs
done' view with weekday labels"). The model sees two separate chronological lists — all Hevy sessions,
then all intervals.icu activities — and has to cross-reference dates itself to realize a run and a lift
happened on the same day. Not merged into one calendar-style view.

## 7. `injuries_constraints` is an empty string

This athlete's onboarding profile has `injuries_constraints: ""`. Whether that means "genuinely no
constraints" or "never filled in" isn't distinguishable from the data — worth a UX nudge at onboarding/
check-in time if it's the latter, since an elite coach adapts hard around injury status and this field is
the only place that's captured today.

## Priority read, if picking up this list

Highest-leverage next items, in the order they'd most change coaching quality for *this* athlete
specifically: **(1) subjective RPE** (cheap to add, directly catches overreaching), **(2) recovery/sleep
inputs** (cheap, directly relevant given the fatigue signal already seen), **(4) per-lap intervals** (the
Hyrox goal is pace-driven, so this is where the real coaching value is), then **(3) pace zones** (blocked
on the athlete's own action), then **(5) Hyrox-station modeling** and **(6) day-by-day view** (both real,
both bigger builds).
