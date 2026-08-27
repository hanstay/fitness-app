// Shared setup for the emulator-backed *.integration.test.ts suites: a
// single Admin SDK connection to the Firestore emulator (never production —
// the Admin SDK talks to whatever FIRESTORE_EMULATOR_HOST points at, which
// only exists when run via `firebase emulators:exec` / a locally-started
// emulator, matching test/rules.test.ts's project-id convention), plus a
// clear-between-tests helper since Admin SDK has no built-in one (unlike
// @firebase/rules-unit-testing's testEnv.clearFirestore()).
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";

export const PROJECT_ID = "demo-ci";

export function getTestDb(): Firestore {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "FIRESTORE_EMULATOR_HOST is not set — run these tests via " +
      `firebase emulators:exec --only firestore --project ${PROJECT_ID} "npx vitest run <file>"`
    );
  }
  if (getApps().length === 0) {
    initializeApp({ projectId: PROJECT_ID });
  }
  return getFirestore();
}

export async function clearFirestoreEmulator(): Promise<void> {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  await fetch(`http://${host}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, {
    method: "DELETE",
  });
}
