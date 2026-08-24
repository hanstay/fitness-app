# LLM usage/cost logging

## Context

While estimating the cost of preview-testing the groups feature, I had to
manually pull `outputTokens` from Cloud Logging and guess at input tokens
(the wrapper never logs them) using pricing I looked up by hand. That should
be a standing log line instead of a one-off manual exercise. Every LLM call
in the app — `generateProgram`, `groupProgram` (Stage A/B), `generateMealPlan`,
`parseBodyScan` — already funnels through one function,
`extractStructuredJson` in `functions/src/lib/claude.ts`, which already logs
a structured line per call (`toolName`, `attempt`, `durationMs`, `maxTokens`,
`outputTokens`, `stopReason`) specifically so Cloud Logging queries can answer
questions like this without a synthetic benchmark. This extends that one log
line rather than adding new instrumentation scattered across call sites.

## Decisions

- Compute and log an estimated `costUsd` inline, not just raw tokens — a
  standing metric, not something computed after the fact from logs.
- No per-user (`uid`) attribution for now — `toolName` (already logged)
  identifies which feature drove the cost, which is enough for now. This
  keeps the change contained to `claude.ts` — no changes needed to
  `generateProgram.ts`, `groupProgram.ts`, `generateMealPlan.ts`, or
  `parseBodyScan.ts`, since none of them need to pass anything new through.

## Implementation

**New file `functions/src/lib/pricing.ts`**: a small model→price table and a
pure helper, so the cost math is unit-testable and isolated from the network
call:
```ts
export const MODEL_PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-5-20250929": { input: 3, output: 15 }, // update when Anthropic's pricing changes
};

/** Null if the model isn't in the table — never throws, so a future model bump can't break generation, just cost logging. */
export function estimateCostUsd(model: string, inputTokens: number | null, outputTokens: number | null): number | null {
  const pricing = MODEL_PRICING_PER_MTOK[model];
  if (!pricing || inputTokens == null || outputTokens == null) return null;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}
```

**`functions/src/lib/claude.ts`**: in the existing `logger.info("extractStructuredJson call completed", {...})` call (`:89-96`), add:
- `model: params.model ?? MODEL` (the same resolution already used for the actual API call, so the logged model always matches what was billed)
- `inputTokens: response.usage?.input_tokens ?? null`
- `costUsd: estimateCostUsd(params.model ?? MODEL, response.usage?.input_tokens ?? null, response.usage?.output_tokens ?? null)`

Nothing else in the function changes — this is additive to one log call, so it can't affect generation behavior, retries, or validation.

## Testing

- Unit: `functions/test/pricing.test.ts` — `estimateCostUsd` for a known model (correct math, matches the manual calculation done for the groups preview testing as a sanity check), an unknown model (returns `null`, doesn't throw), and `null` token inputs (returns `null`).
- Manual: none needed beyond the existing test suite — this only adds fields to a log line already exercised by every existing generation test/emulator run; no behavior change to verify.
