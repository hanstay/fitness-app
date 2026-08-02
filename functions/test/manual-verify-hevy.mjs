// One-off manual verification script (not part of the automated test suite).
// Exercises the exact client SDK path the browser onboarding wizard uses:
// sign in -> upload to Storage -> call the parseHevyCsv callable -> inspect
// the Firestore result. Run against the local emulator suite only.
import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword, createUserWithEmailAndPassword } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator, doc, getDoc } from "firebase/firestore";
import { getStorage, connectStorageEmulator, ref, uploadBytes } from "firebase/storage";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";
import { readFileSync } from "fs";

const app = initializeApp({
  projectId: "hj-training-program-hj2t3of5",
  apiKey: "fake",
  authDomain: "localhost",
  storageBucket: "hj-training-program-hj2t3of5.firebasestorage.app",
});
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const db = getFirestore(app);
connectFirestoreEmulator(db, "127.0.0.1", 8080);
const storage = getStorage(app);
connectStorageEmulator(storage, "127.0.0.1", 9199);
const functions = getFunctions(app);
connectFunctionsEmulator(functions, "127.0.0.1", 5001);

const email = "hevytest@example.com";
const password = "testpassword123";
let cred;
try {
  cred = await signInWithEmailAndPassword(auth, email, password);
} catch {
  cred = await createUserWithEmailAndPassword(auth, email, password);
}
const uid = cred.user.uid;
console.log("Signed in as", uid);

const csvPath = "C:/Users/js301/OneDrive/Documents/code/fitnesss-app/personal-trainer/users/maoledies/imports/workouts.csv";
const csvBuffer = readFileSync(csvPath);
const storagePath = `users/${uid}/hevy/latest.csv`;
await uploadBytes(ref(storage, storagePath), csvBuffer);
console.log("Uploaded", csvBuffer.length, "bytes to", storagePath);

const parseHevyCsv = httpsCallable(functions, "parseHevyCsv");
const result = await parseHevyCsv({ storagePath });
console.log("Function result:", JSON.stringify(result.data, null, 2));

const summarySnap = await getDoc(doc(db, "users", uid, "state", "summary"));
console.log("state/summary.integrationsStatus.hevy:", JSON.stringify(summarySnap.data()?.integrationsStatus?.hevy, null, 2));

const userSnap = await getDoc(doc(db, "users", uid));
console.log("users/{uid}.athlete.current_lifts (first 5):", JSON.stringify(userSnap.data()?.athlete?.current_lifts?.slice(0, 5), null, 2));

process.exit(0);
