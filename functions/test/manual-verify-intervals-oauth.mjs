// One-off manual smoke test (not part of the automated test suite) for the
// intervals.icu OAuth Cloud Functions. Runs against the LOCAL EMULATOR only.
//
// The full authorization-code exchange can't be scripted here — intervals.icu
// requires an interactive login in a real browser. This only exercises the
// parts that are scriptable: unauthenticated calls get rejected, and
// syncIntervalsActivities refuses to run without a stored credential. See
// Task 6 in docs/superpowers/plans/2026-08-18-intervals-icu-oauth-connect.md
// for the real end-to-end browser test.
import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";

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

const email = "intervalsoauthtest@example.com";
const password = "testpassword123";

// 1. Unauthenticated calls must be rejected.
const connectFn = httpsCallable(functions, "connectIntervalsIcuOAuth");
try {
  await connectFn({ code: "whatever" });
  console.log("connectIntervalsIcuOAuth without auth: NO ERROR THROWN — SECURITY BUG");
} catch (err) {
  console.log("connectIntervalsIcuOAuth without auth: correctly rejected —", err.code);
}

// 2. Sign in, then missing-code and missing-credential precondition checks.
let cred;
try {
  cred = await signInWithEmailAndPassword(auth, email, password);
} catch {
  cred = await createUserWithEmailAndPassword(auth, email, password);
}
console.log("Signed in as", cred.user.uid);

try {
  await connectFn({});
  console.log("connectIntervalsIcuOAuth with no code: NO ERROR THROWN — BUG");
} catch (err) {
  console.log("connectIntervalsIcuOAuth with no code: correctly rejected —", err.code);
}

const syncFn = httpsCallable(functions, "syncIntervalsActivities");
try {
  await syncFn();
  console.log("syncIntervalsActivities with no stored credential: NO ERROR THROWN — BUG");
} catch (err) {
  console.log("syncIntervalsActivities with no stored credential: correctly rejected —", err.code);
}

await signOut(auth);
process.exit(0);
