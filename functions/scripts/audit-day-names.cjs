// Read-only audit: how many active plans still name their days some other way
// than a full weekday name ("Mon", "Day 1") — plans saved before schemas.ts
// locked day names to weekdays. A plan whose days normalizeDay can map is
// normalised on its next weekly update; one with a day it can't map gets its
// week rebuilt instead (see decideRegen in src/lib/programDecisions.ts).
// It only reads (get/listDocuments) and never writes, so it's safe to run
// against production.
//
// Usage, with application default credentials that can read the project
// (e.g. `gcloud auth application-default login`):
//   cd functions && npm run build && node scripts/audit-day-names.cjs

const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { WEEKDAYS, normalizeDay } = require("../lib/lib/days");

const PROJECT_ID = "fitness-app-47a06";
initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
const db = getFirestore();

// "ok": every day is a full weekday name; "normalise": all mappable;
// "rebuild": at least one day normalizeDay can't map.
function classify(program) {
  const days = [...(program.weeklyStructure ?? []), ...(program.sessions ?? [])].map((d) => d.day);
  const odd = [...new Set(days.filter((d) => !WEEKDAYS.includes(d)))];
  if (odd.length === 0) return { status: "ok", odd };
  return { status: odd.some((d) => normalizeDay(d) == null) ? "rebuild" : "normalise", odd };
}

// The active plan under each of `parents` (users or groups) — the same
// status == "active" query generateProgram uses to find it.
async function audit(label, parents) {
  const counts = { ok: 0, normalise: 0, rebuild: 0 };
  const flagged = [];
  for (const parent of parents) {
    const snap = await parent.collection("programs").where("status", "==", "active").get();
    for (const doc of snap.docs) {
      const { status, odd } = classify(doc.data());
      counts[status]++;
      if (status !== "ok") flagged.push(`  ${status.padEnd(9)} ${doc.ref.path}: ${odd.map((d) => JSON.stringify(d)).join(", ")}`);
    }
  }
  const total = counts.ok + counts.normalise + counts.rebuild;
  console.log(`${label}: ${total} active — ${counts.ok} use full weekday names, ` +
    `${counts.normalise} will be normalised on their next update, ${counts.rebuild} will have their week rebuilt`);
  for (const line of flagged) console.log(line);
}

async function main() {
  console.log(`Auditing ${process.env.FIRESTORE_EMULATOR_HOST ? "the Firestore emulator" : `project ${PROJECT_ID}`} (read-only)\n`);
  await audit("Personal plans", await db.collection("users").listDocuments());
  await audit("Group plans", await db.collection("groups").listDocuments());
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
