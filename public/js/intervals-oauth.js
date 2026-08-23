// Popup-based OAuth connect for intervals.icu. Mirrors the signInWithPopup
// pattern already used for Google sign-in (see login.html) so a full-page
// redirect never destroys in-progress onboarding-wizard state (the wizard
// keeps step state in the DOM only, not persisted — see onboarding-wizard.js).
import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-functions.js";
import { functions } from "./firebase-init.js";

const AUTHORIZE_URL = "https://intervals.icu/oauth/authorize";
const CLIENT_ID = "723";
// Must match INTERVALS_ICU_REDIRECT_URI in functions/.env exactly, and must
// match what's registered with intervals.icu. Update both together.
const REDIRECT_URI = "https://fitness-app-47a06.web.app/oauth/intervals-callback";
const SCOPE = "ACTIVITY:READ,WELLNESS:READ";

/**
 * Opens the intervals.icu OAuth popup and resolves once the callback page
 * reports back via postMessage. Resolves { cancelled: true } if the user
 * closes the popup without completing. Rejects if the popup is blocked or
 * the callback page reports a failure.
 */
export function connectIntervalsIcuViaOAuth() {
  return new Promise((resolve, reject) => {
    const state = crypto.randomUUID();
    const url = `${AUTHORIZE_URL}?client_id=${encodeURIComponent(CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&scope=${encodeURIComponent(SCOPE)}` +
      `&state=${encodeURIComponent(state)}`;
    const popup = window.open(url, "intervals-icu-oauth", "width=480,height=720");
    if (!popup) {
      reject(new Error("Pop-up blocked. Allow pop-ups for this site and try again."));
      return;
    }

    let settled = false;

    function cleanup() {
      window.removeEventListener("message", onMessage);
      clearInterval(pollClosed);
    }

    function onMessage(event) {
      if (event.origin !== location.origin) return;
      const data = event.data;
      if (!data || data.type !== "intervals-oauth-result" || data.state !== state) return;
      settled = true;
      cleanup();
      if (data.error) reject(new Error(data.error));
      else resolve(data.result);
    }

    const pollClosed = setInterval(() => {
      if (popup.closed) {
        cleanup();
        if (!settled) resolve({ cancelled: true });
      }
    }, 500);

    window.addEventListener("message", onMessage);
  });
}

/** Used only by intervals-callback.html to exchange the code it received. */
export async function exchangeIntervalsIcuCode(code) {
  const fn = httpsCallable(functions, "connectIntervalsIcuOAuth");
  const result = await fn({ code });
  return result.data;
}
