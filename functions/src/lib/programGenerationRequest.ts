// The inputs of a queued program generation: read off the callable's
// request.data by queueProgramGeneration.ts, stored on the "generating"
// placeholder as `request`, and read back off it by
// onProgramGenerationRequested.ts. Normalized at both ends, so a placeholder
// queued without inputs (onboarding, the dashboard) runs with the defaults.

export interface ProgramGenerationRequest {
  // The check-in "Start my next phase now" checkbox (see decideRegen in
  // programDecisions.ts).
  force: boolean;
}

export function toProgramGenerationRequest(raw: unknown): ProgramGenerationRequest {
  const force = (raw as { force?: unknown } | null | undefined)?.force;
  return { force: force === true };
}
