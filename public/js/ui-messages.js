// Shared #errorBox / #successBox helpers — used by every page that shows
// inline form feedback (login, onboarding, profile, checkin). Centralizing
// this also gets every page aria-live announcements, a scroll-into-view so
// the message doesn't render off-screen from wherever the user is on a long
// page, and success messages that clear themselves instead of lingering.
export function bindMessages(errorId = "errorBox", successId = "successBox") {
  const errorBox = errorId ? document.getElementById(errorId) : null;
  const successBox = successId ? document.getElementById(successId) : null;
  if (errorBox) { errorBox.setAttribute("role", "alert"); errorBox.setAttribute("aria-live", "polite"); }
  if (successBox) { successBox.setAttribute("role", "status"); successBox.setAttribute("aria-live", "polite"); }

  let dismissTimer = null;

  function showError(message) {
    clearTimeout(dismissTimer);
    if (successBox) successBox.style.display = "none";
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.style.display = "block";
    errorBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function showSuccess(message, { autoDismissMs = 5000 } = {}) {
    clearTimeout(dismissTimer);
    if (errorBox) errorBox.style.display = "none";
    if (!successBox) return;
    successBox.textContent = message;
    successBox.style.display = "block";
    successBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
    if (autoDismissMs) dismissTimer = setTimeout(() => { successBox.style.display = "none"; }, autoDismissMs);
  }

  function clearMessages() {
    clearTimeout(dismissTimer);
    if (errorBox) errorBox.style.display = "none";
    if (successBox) successBox.style.display = "none";
  }

  return { showError, showSuccess, clearMessages };
}

// Brief bottom-of-screen confirmation for a background action whose outcome
// might otherwise only show up in a status line the user has scrolled away
// from (e.g. dashboard's "Regenerate" buttons). Creates its own element on
// first use, so no markup is required on the page.
let toastEl = null;
let toastTimer = null;
export function showToast(message, { type = "info", durationMs = 4000 } = {}) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "toast";
    toastEl.setAttribute("role", "status");
    toastEl.setAttribute("aria-live", "polite");
    document.body.appendChild(toastEl);
  }
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.classList.toggle("error", type === "error");
  toastEl.classList.add("show");
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), durationMs);
}
