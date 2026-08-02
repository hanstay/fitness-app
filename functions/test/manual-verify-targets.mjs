// One-off manual verification (not part of the automated suite): signs in,
// writes a real profile (Hans's actual stats from this session), calls the
// live calculateTargets Cloud Function, and checks the result against the
// known-correct numbers already verified in the unit tests.
import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword, createUserWithEmailAndPassword } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator, doc, updateDoc, getDoc } from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";

const app = initializeApp({ projectId: "hj-training-program-hj2t3of5", apiKey: "fake", authDomain: "localhost" });
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const db = getFirestore(app);
connectFirestoreEmulator(db, "127.0.0.1", 8080);
const functions = getFunctions(app);
connectFunctionsEmulator(functions, "127.0.0.1", 5001);

const email = "targetstest@example.com";
const password = "testpassword123";
let cred;
try {
  cred = await signInWithEmailAndPassword(auth, email, password);
} catch {
  cred = await createUserWithEmailAndPassword(auth, email, password);
}
const uid = cred.user.uid;
console.log("Signed in as", uid);

// onUserCreate is an async trigger — give it a moment to seed the profile
// doc before writing to it. (The real onboarding wizard never hits this
// race in practice: there's several seconds of human form-filling between
// signup and the first profile write. This script does it instantly.)
for (let i = 0; i < 20; i++) {
  const snap = await getDoc(doc(db, "users", uid));
  if (snap.exists()) break;
  await new Promise((r) => setTimeout(r, 250));
}

await updateDoc(doc(db, "users", uid), {
  athlete: {
    sex: "male", age: 30, height_cm: 174, bodyweight_kg: 70.5, activity_level: "very_active",
    equipment: [], events: [], current_lifts: [], injuries_constraints: "", goal: "",
    recovery: { sleep_hours: null, sleep_quality: null, stress_1_10: null },
  },
});
console.log("Wrote Hans's real profile stats");

const calc = httpsCallable(functions, "calculateTargets");
const result = await calc();
console.log("Function result:", JSON.stringify(result.data, null, 2));

const expected = { bmr: 1647.5, tdee: 2842, target_calories: 3090, protein_g: 141, carbs_g: 438, fat_g: 86 };
const actual = result.data;
const matches = Object.keys(expected).every((k) => expected[k] === actual[k]);
console.log(matches ? "✓ MATCHES the known-correct real fixture exactly" : "✗ MISMATCH from expected fixture");

const summarySnap = await getDoc(doc(db, "users", uid, "state", "summary"));
console.log("state/summary.currentTargets written:", !!summarySnap.data()?.currentTargets);

process.exit(matches ? 0 : 1);
