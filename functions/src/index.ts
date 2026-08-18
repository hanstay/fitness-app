// Cloud Functions entry point — Phase 1 (multi-user Firebase app).
// Individual functions are implemented and exported here as each is built out
// (see .claude/plans/2026-08-02-multiuser-firebase-phase1.md for the full list).

import dotenv from "dotenv";
import { initializeApp } from "firebase-admin/app";

dotenv.config();

// The Admin SDK's default bucket is `{projectId}.appspot.com`, but this project
// (and the web SDK config in public/js/firebase-init.js) uses the newer
// `.firebasestorage.app` bucket. Without setting this, getStorage().bucket()
// resolves to the wrong bucket and every storage read (Hevy CSV, body-scan PDF)
// 404s with "No such object". Keep this in sync with firebase-init.js.
initializeApp({
  storageBucket: "fitness-app-47a06.firebasestorage.app",
});

export { onUserCreate } from "./auth/onUserCreate";
export { parseHevyCsv } from "./integrations/parseHevyCsv";
export { saveIntervalsIcuCredentials } from "./integrations/saveIntervalsIcuCredentials";
export { syncIntervalsActivities } from "./integrations/syncIntervalsActivities";
export { parseBodyScan } from "./scans/parseBodyScan";
export { calculateTargets } from "./profile/calculateTargets";
export { generateProgram } from "./generate/generateProgram";
export { generateMealPlan } from "./generate/generateMealPlan";
export { queueProgramGeneration } from "./generate/queueProgramGeneration";
export { onProgramGenerationRequested } from "./generate/onProgramGenerationRequested";
export { queueMealPlanGeneration } from "./generate/queueMealPlanGeneration";
export { onMealPlanGenerationRequested } from "./generate/onMealPlanGenerationRequested";
