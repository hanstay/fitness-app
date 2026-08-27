// Model pricing for cost-estimate logging (see claude.ts's extractStructuredJson).
// Update this table when Anthropic's pricing changes — nothing else needs to.
export const MODEL_PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-5-20250929": { input: 3, output: 15 },
};

/**
 * Estimated USD cost for one call. Null if the model isn't in the table or
 * either token count is missing — never throws, so an unrecognized future
 * model can't break generation, only the cost figure in its log line.
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number | null,
  outputTokens: number | null
): number | null {
  const pricing = MODEL_PRICING_PER_MTOK[model];
  if (!pricing || inputTokens == null || outputTokens == null) return null;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}
