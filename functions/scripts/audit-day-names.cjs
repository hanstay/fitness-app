// Read-only audit: how many active plans still name their days some other way
// than a full weekday name ("Mon", "Day 1") — plans saved before schemas.ts
// locked day names to weekdays. A plan whose days normalizeDay can map is
// normalised on its next weekly update; one with a day it can't map gets its
// week rebuilt instead (see decideRegen in src/lib/programDecisions.ts).
// Also lists weekdays a week names twice (in weeklyStructure, or as a double
// day in sessions — merged as one day since this change), and the day names
// in each group member's sessionLoads. It only reads (get/listDocuments) and
// never writes, so it's safe to run against production.
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
// "rebuild": at least one day normalizeDay can't map. `twice`: weekdays
// listed more than once in any one of `lists`.
function classify(lists) {
  const days = lists.flat().map((entry) => entry.day);
  const odd = [...new Set(days.filter((d) => !WEEKDAYS.includes(d)))];
  const twice = [...new Set(lists.flatMap((list) => {
    const mapped = list.map((entry) => normalizeDay(entry.day)).filter(Boolean);
    return mapped.filter((d, i) => mapped.indexOf(d) !== i);
  }))];
  const status = odd.length === 0 ? "ok" : odd.some((d) => normalizeDay(d) == null) ? "rebuild" : "normalise";
  return { status, odd, twice };
}

function report(label, results) {
  const count = (status) => results.filter((r) => r.status === status).length;
  console.log(`${label}: ${results.length} — ${count("ok")} use full weekday names, ` +
    `${count("normalise")} will be normalised on their next update, ${count("rebuild")} will have their week rebuilt, ` +
    `${results.filter((r) => r.twice.length).length} name a weekday twice`);
  for (const r of results) {
    const notes = [
      ...(r.status !== "ok" ? [`${r.status}: ${r.odd.map((d) => JSON.stringify(d)).join(", ")}`] : []),
      ...(r.twice.length ? [`twice: ${r.twice.join(", ")}`] : []),
    ];
    if (notes.length) console.log(`  ${r.path} — ${notes.join("; ")}`);
  }
}

// The active plan under each of `parents` (users or groups) — the same
// status == "active" query generateProgram uses to find it.
async function activePlans(parents) {
  const results = [];
  for (const parent of parents) {
    const snap = await parent.collection("programs").where("status", "==", "active").get();
    for (const doc of snap.docs) {
      const p = doc.data();
      results.push({ path: doc.ref.path, ...classify([p.weeklyStructure ?? [], p.sessions ?? []]) });
    }
  }
  return results;
}

async function memberLayers(groups) {
  const results = [];
  for (const group of groups) {
    for (const doc of (await group.collection("members").get()).docs) {
      results.push({ path: doc.ref.path, ...classify([doc.data().sessionLoads ?? []]) });
    }
  }
  return results;
}

async function main() {
  console.log(`Auditing ${process.env.FIRESTORE_EMULATOR_HOST ? "the Firestore emulator" : `project ${PROJECT_ID}`} (read-only)\n`);
  const groups = await db.collection("groups").listDocuments();
  report("Active personal plans", await activePlans(await db.collection("users").listDocuments()));
  report("Active group plans", await activePlans(groups));
  report("Group member layers (sessionLoads)", await memberLayers(groups));
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
