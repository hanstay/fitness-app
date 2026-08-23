import { readFileSync } from "fs";
import { resolve } from "path";
import { beforeAll, afterAll, beforeEach, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from "firebase/firestore";

const PROJECT_ID = "hj-rules-test";
const OWNER_UID = "owner-uid";
const OTHER_UID = "other-uid";

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

/** Seed a document bypassing security rules, as Cloud Functions (Admin SDK) would. */
async function seedAsAdmin(path: string, data: Record<string, unknown>) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), path), data);
  });
}

describe("unauthenticated access", () => {
  it("cannot read another user's profile doc", async () => {
    await seedAsAdmin(`users/${OWNER_UID}`, { uid: OWNER_UID, email: "a@test.com" });
    const unauth = testEnv.unauthenticatedContext();
    await assertFails(getDoc(doc(unauth.firestore(), `users/${OWNER_UID}`)));
  });

  it("cannot write anywhere, including credentials", async () => {
    const unauth = testEnv.unauthenticatedContext();
    await assertFails(
      setDoc(doc(unauth.firestore(), `credentials/${OWNER_UID}`), { intervalsIcu: { apiKey: "x" } })
    );
  });
});

describe("cross-user isolation", () => {
  beforeEach(async () => {
    await seedAsAdmin(`users/${OWNER_UID}`, { uid: OWNER_UID, email: "owner@test.com" });
    await seedAsAdmin(`users/${OWNER_UID}/state/summary`, { currentTargets: null });
    await seedAsAdmin(`users/${OWNER_UID}/programs/p1`, { status: "active" });
  });

  it("owner can read their own profile doc", async () => {
    const owner = testEnv.authenticatedContext(OWNER_UID);
    await assertSucceeds(getDoc(doc(owner.firestore(), `users/${OWNER_UID}`)));
  });

  it("another authenticated user cannot read the owner's profile doc", async () => {
    const other = testEnv.authenticatedContext(OTHER_UID);
    await assertFails(getDoc(doc(other.firestore(), `users/${OWNER_UID}`)));
  });

  it("another authenticated user cannot write the owner's profile doc", async () => {
    const other = testEnv.authenticatedContext(OTHER_UID);
    await assertFails(
      updateDoc(doc(other.firestore(), `users/${OWNER_UID}`), { "athlete.bodyweight_kg": 999 })
    );
  });

  it("another authenticated user cannot read the owner's generated program", async () => {
    const other = testEnv.authenticatedContext(OTHER_UID);
    await assertFails(getDoc(doc(other.firestore(), `users/${OWNER_UID}/programs/p1`)));
  });

  it("another authenticated user cannot read the owner's state summary", async () => {
    const other = testEnv.authenticatedContext(OTHER_UID);
    await assertFails(getDoc(doc(other.firestore(), `users/${OWNER_UID}/state/summary`)));
  });
});

describe("users/{uid} profile doc", () => {
  it("owner cannot create their own top-level doc (onUserCreate only)", async () => {
    const owner = testEnv.authenticatedContext(OWNER_UID);
    await assertFails(
      setDoc(doc(owner.firestore(), `users/${OWNER_UID}`), { uid: OWNER_UID, email: "x@test.com" })
    );
  });

  it("owner can update their own profile fields once seeded", async () => {
    await seedAsAdmin(`users/${OWNER_UID}`, { uid: OWNER_UID, email: "owner@test.com" });
    const owner = testEnv.authenticatedContext(OWNER_UID);
    await assertSucceeds(
      updateDoc(doc(owner.firestore(), `users/${OWNER_UID}`), { "athlete.bodyweight_kg": 70.5 })
    );
  });

  it("owner cannot delete their own profile doc", async () => {
    await seedAsAdmin(`users/${OWNER_UID}`, { uid: OWNER_UID, email: "owner@test.com" });
    const owner = testEnv.authenticatedContext(OWNER_UID);
    await assertFails(deleteDoc(doc(owner.firestore(), `users/${OWNER_UID}`)));
  });
});

describe("Functions-only collections reject client writes, even for the owner", () => {
  it.each([
    ["state/summary", { currentTargets: null }],
    ["targetHistory/th1", { tdee: 2800 }],
    ["programs/p1", { status: "active" }],
    ["mealPlans/m1", { status: "active" }],
    ["activities/a1", { type: "Run" }],
    ["strengthSessions/s1", { date: "2026-08-10" }],
    ["checkins/c1", { summary: "..." }],
  ])("owner cannot write users/{uid}/%s", async (subpath) => {
    const owner = testEnv.authenticatedContext(OWNER_UID);
    await assertFails(setDoc(doc(owner.firestore(), `users/${OWNER_UID}/${subpath}`), { x: 1 }));
  });

  it.each([
    "state/summary",
    "targetHistory/th1",
    "programs/p1",
    "mealPlans/m1",
    "activities/a1",
    "strengthSessions/s1",
    "checkins/c1",
  ])("owner CAN read users/{uid}/%s once seeded", async (subpath) => {
    await seedAsAdmin(`users/${OWNER_UID}/${subpath}`, { x: 1 });
    const owner = testEnv.authenticatedContext(OWNER_UID);
    await assertSucceeds(getDoc(doc(owner.firestore(), `users/${OWNER_UID}/${subpath}`)));
  });
});

describe("bodyScans — create is Functions-only, update is owner-writable", () => {
  it("owner cannot create a bodyScans doc directly", async () => {
    const owner = testEnv.authenticatedContext(OWNER_UID);
    await assertFails(
      setDoc(doc(owner.firestore(), `users/${OWNER_UID}/bodyScans/scan1`), {
        extracted: { weight_kg: 70 },
        confirmedByUser: false,
      })
    );
  });

  it("owner CAN update an existing bodyScans doc (correcting extracted values)", async () => {
    await seedAsAdmin(`users/${OWNER_UID}/bodyScans/scan1`, {
      extracted: { weight_kg: 70 },
      confirmedByUser: false,
    });
    const owner = testEnv.authenticatedContext(OWNER_UID);
    await assertSucceeds(
      updateDoc(doc(owner.firestore(), `users/${OWNER_UID}/bodyScans/scan1`), {
        "extracted.weight_kg": 70.5,
        confirmedByUser: true,
      })
    );
  });

  it("another user cannot update the owner's bodyScans doc", async () => {
    await seedAsAdmin(`users/${OWNER_UID}/bodyScans/scan1`, {
      extracted: { weight_kg: 70 },
      confirmedByUser: false,
    });
    const other = testEnv.authenticatedContext(OTHER_UID);
    await assertFails(
      updateDoc(doc(other.firestore(), `users/${OWNER_UID}/bodyScans/scan1`), { confirmedByUser: true })
    );
  });

  it("owner cannot delete a bodyScans doc", async () => {
    await seedAsAdmin(`users/${OWNER_UID}/bodyScans/scan1`, { extracted: {}, confirmedByUser: false });
    const owner = testEnv.authenticatedContext(OWNER_UID);
    await assertFails(deleteDoc(doc(owner.firestore(), `users/${OWNER_UID}/bodyScans/scan1`)));
  });
});

describe("Phase 2 seams — owner has full read/write, others do not", () => {
  it.each(["workouts/w1", "nutritionDays/2026-08-02"])(
    "owner can create/read/update/delete users/{uid}/%s",
    async (subpath) => {
      const owner = testEnv.authenticatedContext(OWNER_UID);
      const ref = doc(owner.firestore(), `users/${OWNER_UID}/${subpath}`);
      await assertSucceeds(setDoc(ref, { note: "test" }));
      await assertSucceeds(getDoc(ref));
      await assertSucceeds(updateDoc(ref, { note: "updated" }));
      await assertSucceeds(deleteDoc(ref));
    }
  );

  it.each(["workouts/w1", "nutritionDays/2026-08-02"])(
    "another user cannot touch users/{uid}/%s",
    async (subpath) => {
      await seedAsAdmin(`users/${OWNER_UID}/${subpath}`, { note: "test" });
      const other = testEnv.authenticatedContext(OTHER_UID);
      await assertFails(getDoc(doc(other.firestore(), `users/${OWNER_UID}/${subpath}`)));
    }
  );
});

describe("credentials/{uid} — Admin SDK only, never client-reachable", () => {
  it("owner (matching uid) cannot read their own credentials doc", async () => {
    await seedAsAdmin(`credentials/${OWNER_UID}`, { intervalsIcu: { apiKey: "secret" } });
    const owner = testEnv.authenticatedContext(OWNER_UID);
    await assertFails(getDoc(doc(owner.firestore(), `credentials/${OWNER_UID}`)));
  });

  it("owner (matching uid) cannot write their own credentials doc", async () => {
    const owner = testEnv.authenticatedContext(OWNER_UID);
    await assertFails(
      setDoc(doc(owner.firestore(), `credentials/${OWNER_UID}`), { intervalsIcu: { apiKey: "x" } })
    );
  });
});

describe("default-deny for anything else", () => {
  it("rejects reads on an undeclared top-level collection", async () => {
    const owner = testEnv.authenticatedContext(OWNER_UID);
    await assertFails(getDoc(doc(owner.firestore(), "somethingElse/doc1")));
  });
});
