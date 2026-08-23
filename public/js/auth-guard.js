// Auth/onboarding routing helpers shared by every protected page.
import {
  onAuthStateChanged,
  signOut as fbSignOut,
} from "https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js";
import { auth, db } from "./firebase-init.js";

/** Resolves with the current user (or null) once Firebase's initial auth check completes. */
export function waitForAuthState() {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

/** Redirects to login if signed out. Returns the user otherwise. Use on any protected page. */
export async function requireAuth({ redirectTo = "login.html" } = {}) {
  const user = await waitForAuthState();
  if (!user) {
    location.href = redirectTo;
    return null;
  }
  return user;
}

/**
 * Requires auth AND a completed onboarding flow. Returns {user, profile} or
 * null (having already redirected). Use on dashboard/program/meals/profile.
 */
export async function requireOnboarded({ onboardingUrl = "onboarding.html" } = {}) {
  const user = await requireAuth();
  if (!user) return null;
  const snap = await getDoc(doc(db, "users", user.uid));
  const profile = snap.exists() ? snap.data() : null;
  if (!profile?.onboarding?.completed) {
    location.href = onboardingUrl;
    return null;
  }
  return { user, profile };
}

/** Use on login.html: if already signed in, skip straight past the login form. */
export async function redirectIfSignedIn({ dashboardUrl = "dashboard.html", onboardingUrl = "onboarding.html" } = {}) {
  const user = await waitForAuthState();
  if (!user) return;
  const snap = await getDoc(doc(db, "users", user.uid));
  const profile = snap.exists() ? snap.data() : null;
  location.href = profile?.onboarding?.completed ? dashboardUrl : onboardingUrl;
}

export async function signOut({ redirectTo = "login.html" } = {}) {
  await fbSignOut(auth);
  location.href = redirectTo;
}
