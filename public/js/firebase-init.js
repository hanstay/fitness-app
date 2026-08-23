// Firebase app initialization — shared by every page.
// Not a secret: Firebase web config identifies the project; access control
// is enforced by Auth + Firestore/Storage Security Rules, not by hiding this.
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-app.js";
import {
  getAuth,
  connectAuthEmulator,
  GoogleAuthProvider,
} from "https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js";
import {
  getFirestore,
  connectFirestoreEmulator,
} from "https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js";
import {
  getStorage,
  connectStorageEmulator,
} from "https://www.gstatic.com/firebasejs/11.1.0/firebase-storage.js";
import {
  getFunctions,
  connectFunctionsEmulator,
} from "https://www.gstatic.com/firebasejs/11.1.0/firebase-functions.js";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDt7Z2meE2FW-QQ7m7DOKeNkAtsvX2DPWE",
  authDomain: "fitness-app-47a06.firebaseapp.com",
  projectId: "fitness-app-47a06",
  storageBucket: "fitness-app-47a06.firebasestorage.app",
  messagingSenderId: "39106506907",
  appId: "1:39106506907:web:3f1484ebfec23fbae4d63e",
};

const app = initializeApp(FIREBASE_CONFIG);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
export const functions = getFunctions(app);
export const googleProvider = new GoogleAuthProvider();

// Local dev: connect to the Emulator Suite when served from localhost.
// Matches the ports declared in firebase.json.
const isLocalhost = ["localhost", "127.0.0.1"].includes(location.hostname);
if (isLocalhost) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectStorageEmulator(storage, "127.0.0.1", 9199);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  console.info("[firebase-init] connected to local emulator suite");
}
