// One-off manual verification script (not part of the automated test suite).
// Exercises saveIntervalsIcuCredentials + the auto-triggered sync against
// the REAL intervals.icu API (read-only GET calls) using the already-
// configured real credentials for this session's test user. Run against
// the local emulator suite only — the credential itself is never sent
// anywhere except intervals.icu's own API and the local emulator.
import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword, createUserWithEmailAndPassword } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator, doc, getDoc } from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";
import { readFileSync } from "fs";

const app = initializeApp({
  projectId: "hj-training-program-hj2t3of5",
  apiKey: "fake",
  authDomain: "localhost",
});
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const db = getFirestore(app);
connectFirestoreEmulator(db, "127.0.0.1", 8080);
const functions = getFunctions(app);
connectFunctionsEmulator(functions, "127.0.0.1", 5001);

const email = "intervalstest@example.com";
const password = "testpassword123";
let cred;
try {
  cred = await signInWithEmailAndPassword(auth, email, password);
} catch {
  cred = await createUserWithEmailAndPassword(auth, email, password);
}
const uid = cred.user.uid;
console.log("Signed in as", uid);

const credsPath = "C:/Users/js301/OneDrive/Documents/code/fitnesss-app/personal-trainer/users/maoledies/.credentials/intervals-icu.json";
const { athleteId, apiKey } = JSON.parse(readFileSync(credsPath, "utf8"));
console.log("Using real intervals.icu credentials for athlete", athleteId);

const saveCreds = httpsCallable(functions, "saveIntervalsIcuCredentials");
const result = await saveCreds({ athleteId, apiKey });
console.log("Function result:", JSON.stringify(result.data, null, 2));

const summarySnap = await getDoc(doc(db, "users", uid, "state", "summary"));
const summary = summarySnap.data();
console.log("state/summary.wellness:", JSON.stringify(summary?.wellness, null, 2));
console.log("state/summary.integrationsStatus.intervalsIcu:", JSON.stringify(summary?.integrationsStatus?.intervalsIcu, null, 2));

try {
  await getDoc(doc(db, "credentials", uid));
  console.log("credentials/{uid} readable from client? YES — SECURITY BUG");
} catch (err) {
  console.log("credentials/{uid} readable from client? no — blocked by rules (correct):", err.code);
}

process.exit(0);
