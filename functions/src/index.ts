// Cloud Functions entry point — Phase 1 (multi-user Firebase app).
// Individual functions are implemented and exported here as each is built out
// (see .claude/plans/2026-08-02-multiuser-firebase-phase1.md for the full list).

import dotenv from "dotenv";
import { initializeApp } from "firebase-admin/app";

dotenv.config();

initializeApp();

export { onUserCreate } from "./auth/onUserCreate";
export { parseHevyCsv } from "./integrations/parseHevyCsv";
export { saveIntervalsIcuCredentials } from "./integrations/saveIntervalsIcuCredentials";
export { syncIntervalsActivities } from "./integrations/syncIntervalsActivities";
export { parseBodyScan } from "./scans/parseBodyScan";
export { calculateTargets } from "./profile/calculateTargets";
export { generateProgram } from "./generate/generateProgram";
export { generateMealPlan } from "./generate/generateMealPlan";
