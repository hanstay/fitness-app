import type { DocumentReference, Firestore } from "firebase-admin/firestore";

// getAll reads every ref in one round trip; kept to a batch-sized chunk.
const REFS_PER_READ = 400;

/**
 * How many of `refs` don't exist yet. Imports call it before writing, so a
 * re-import of data already stored (and so already seen by a plan update)
 * isn't reported as new.
 */
export async function countNewDocs(db: Firestore, refs: DocumentReference[]): Promise<number> {
  // An import can name the same doc twice; it's one new doc, not two.
  const unique = [...new Map(refs.map((ref) => [ref.path, ref])).values()];
  let count = 0;
  for (let i = 0; i < unique.length; i += REFS_PER_READ) {
    const snaps = await db.getAll(...unique.slice(i, i + REFS_PER_READ));
    count += snaps.filter((snap) => !snap.exists).length;
  }
  return count;
}
