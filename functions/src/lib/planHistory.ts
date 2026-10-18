// The check-in history on the Trainer's advice page: one entry per plan
// update, kept at users/{uid}/planHistory/{id} so it outlives the plan it
// describes (a personal plan is archived, but a group member's layer is
// replaced). Written in the update's own commit (generateProgram.ts,
// groupProgram.ts) and read only by its owner. No Firebase imports.
import type { RegenMode } from "./programDecisions";
import type { StoredFeedbackResponse } from "./planFeedback";

export interface PlanHistoryEntry {
  source: "personal" | "group";
  /** The program the update wrote (a group member's: the shared program their layer is on). */
  programId: string;
  /** How the plan changed: a weekly update, a new phase, a new plan, or a rebuilt week. */
  mode: RegenMode;
  /** The roadmap phase the plan is in after the update. */
  phase: string | null;
  /** "Where you are now" at the time. */
  summary: string | null;
  highlights: string[];
  /** What changed and why ("What changed" on the Program page). */
  changeSummary: string[];
  /** How the update answered the athlete's notes and check-in answers. */
  feedbackResponses: StoredFeedbackResponse[];
}

interface EntryInput {
  source: PlanHistoryEntry["source"];
  programId: string;
  mode: RegenMode;
  roadmap?: Array<{ phase?: string }> | null;
  phaseIndex?: number | null;
  currentState?: { summary?: string; highlights?: string[] } | null;
  changeSummary?: string[] | null;
  feedbackResponses?: StoredFeedbackResponse[] | null;
}

export function planHistoryEntry(input: EntryInput): PlanHistoryEntry {
  const phase = input.roadmap?.[input.phaseIndex ?? 0]?.phase;
  return {
    source: input.source,
    programId: input.programId,
    mode: input.mode,
    phase: phase?.trim() || null,
    summary: input.currentState?.summary?.trim() || null,
    highlights: input.currentState?.highlights ?? [],
    changeSummary: input.changeSummary ?? [],
    feedbackResponses: input.feedbackResponses ?? [],
  };
}
