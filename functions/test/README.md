# Tests

Everything here runs in CI (`npm run build && npx vitest run --exclude "**/test/rules.test.ts"`, then the Firestore rules suite separately) except one file:

## `generationLatency.manual.test.ts`

**Motivation:** `generateProgram`/`generateMealPlan` run in a background Cloud Function with a 300s timeout (`onProgramGenerationRequested.ts`, `onMealPlanGenerationRequested.ts`), and the dashboard/sweep treat anything still `"generating"` past 6 minutes as stalled (`lib/staleGeneration.ts`). Those two numbers were picked by judgment, not measurement. This file answers "are they actually fair for the real Claude calls we make?" instead of guessing — it calls the four real generation paths (program overview/schedule/incremental update, meal plan) with their exact real system prompts and schemas against a representative fixture profile, times each one, and fails if any call exceeds 300s.

**Run it:**

```bash
cd functions
ANTHROPIC_API_KEY=sk-ant-... npx vitest run test/generationLatency.manual.test.ts
```

Needs your own Anthropic key — it makes real, billed API calls. Never commit a key or paste one into a session; export it in your shell for the one command.

It self-skips (`describe.skipIf(!process.env.ANTHROPIC_API_KEY)`) when no key is set, which is why it's safe to leave out of the CI `--exclude` list — CI has no key, so this file always contributes 0 executed tests there.

**Ongoing signal, not just one-off:** `lib/claude.ts`'s `extractStructuredJson` logs `durationMs`/`outputTokens`/`stopReason` per call (tagged by `toolName`) via `firebase-functions/logger` on every real invocation, in prod. Once there's real onboarding volume, querying Cloud Logging for `"extractStructuredJson call completed"` gives actual p50/p95 latency — more trustworthy than this fixture-based probe, which only tells you where things stand today with one representative profile.

**If a run finds a call is uncomfortably close to 300s:** the levers are `timeoutSeconds` on the two trigger functions, `GENERATION_STALE_AFTER_MS` in `lib/staleGeneration.ts` (keep the dashboard's hand-duplicated copy in `public/dashboard.html` in sync — it can't import server code), or trimming `maxTokens` on the offending call.
